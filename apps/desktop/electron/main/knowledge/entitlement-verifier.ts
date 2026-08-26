import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { KnowledgeEntitlementState } from '@autoforge/shared'
import type { SafeStoragePort } from '../security/secret-store.js'
import { writeFileDurably } from './key-store.js'
import type { KnowledgeOwner } from './knowledge-types.js'

const OFFLINE_GRACE_MS = 72 * 60 * 60 * 1_000
const CLOCK_SKEW_MS = 5 * 60 * 1_000
const WINDOW_MS = 30 * 24 * 60 * 60 * 1_000

const canonicalTimestampSchema = z.string().datetime().refine(
  value => new Date(Date.parse(value)).toISOString() === value,
  { message: 'timestamp_not_canonical' },
)
const payloadSchema = z.object({
  userId: z.string().min(1).max(256).refine(value => value.trim() === value, 'user_id_not_canonical'),
  tier: z.enum(['free', 'member']),
  entitlements: z.array(z.enum(['knowledge_base_beta', 'knowledge_base_cloud'])).max(2)
    .refine(values => new Set(values).size === values.length, 'duplicate_entitlement')
    .refine(values => values.every((value, index) => index === 0 || values[index - 1]! < value), 'entitlements_not_canonical'),
  issuedAt: canonicalTimestampSchema,
  snapshotExpiresAt: canonicalTimestampSchema,
  membershipExpiresAt: canonicalTimestampSchema,
  membershipStatus: z.enum(['active', 'expired', 'revoked']),
  keyId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  killSwitchEnabled: z.boolean(),
}).strict().superRefine((payload, context) => {
  if (payload.tier === 'free' && (
    payload.entitlements.length > 0
    || payload.membershipStatus !== 'active'
    || payload.membershipExpiresAt !== payload.issuedAt
  )) {
    context.addIssue({ code: 'custom', path: ['tier'], message: 'free_entitlement_not_canonical' })
  }
})
const envelopeSchema = z.object({
  version: z.literal(1),
  payload: payloadSchema,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/).refine(value => {
    const decoded = Buffer.from(value, 'base64url')
    return decoded.length === 64 && decoded.toString('base64url') === value
  }, 'signature_not_canonical'),
}).strict()

export type KnowledgeEntitlementEnvelope = z.infer<typeof envelopeSchema>

export interface KnowledgeEntitlementCacheRecord {
  readonly envelope: KnowledgeEntitlementEnvelope
  readonly maxIssuedAt: string
  readonly maxObservedAt: string
}

export interface KnowledgeEntitlementEnvelopeCache {
  read(userId: string): Promise<KnowledgeEntitlementCacheRecord | undefined>
  write(userId: string, record: KnowledgeEntitlementCacheRecord): Promise<void>
}

const enrollmentWatermarkSchema = z.object({
  version: z.literal(1),
  ownerHash: z.string().regex(/^[a-f0-9]{64}$/),
  maxIssuedAt: canonicalTimestampSchema,
  maxObservedAt: canonicalTimestampSchema,
  acceptedEnvelopeHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
type KnowledgeEntitlementEnrollmentWatermark = z.infer<typeof enrollmentWatermarkSchema>

function parseEnrollmentWatermark(input: unknown): KnowledgeEntitlementEnrollmentWatermark {
  try { return enrollmentWatermarkSchema.parse(input) } catch (error) {
    throw new Error('Knowledge entitlement watermark is invalid', { cause: error })
  }
}

export interface KnowledgeEntitlementEnrollmentStore {
  read(ownerKey: string): Promise<unknown | undefined>
  write(ownerKey: string, watermark: KnowledgeEntitlementEnrollmentWatermark): Promise<void>
}

export class AppSettingsKnowledgeEntitlementEnrollmentStore implements KnowledgeEntitlementEnrollmentStore {
  constructor(private readonly settings: {
    get(key: string): { value: unknown } | undefined
    set(key: string, value: unknown): unknown
  }) {}

  async read(ownerKey: string): Promise<unknown | undefined> {
    return this.settings.get(this.key(ownerKey))?.value
  }

  async write(ownerKey: string, watermark: KnowledgeEntitlementEnrollmentWatermark): Promise<void> {
    const parsed = parseEnrollmentWatermark(watermark)
    if (parsed.ownerHash !== ownerKey) throw new Error('Knowledge entitlement watermark owner mismatch')
    this.settings.set(this.key(ownerKey), parsed)
  }

  private key(ownerKey: string): string {
    if (!/^[a-f0-9]{64}$/.test(ownerKey)) throw new Error('Knowledge entitlement enrollment owner is invalid')
    return `knowledge-entitlement-enrolled:v1:${ownerKey}`
  }
}

const cacheRecordSchema = z.object({
  version: z.literal(1),
  userId: z.string().min(1).max(256).refine(value => value.trim() === value, 'user_id_not_canonical'),
  record: z.object({
    envelope: envelopeSchema,
    maxIssuedAt: canonicalTimestampSchema,
    maxObservedAt: canonicalTimestampSchema,
  }).strict(),
}).strict()

export class SafeStorageKnowledgeEntitlementCache implements KnowledgeEntitlementEnvelopeCache {
  constructor(
    private readonly directory: string,
    private readonly safeStorage: SafeStoragePort,
    private readonly enrollment: KnowledgeEntitlementEnrollmentStore,
  ) {}

  async read(userId: string): Promise<KnowledgeEntitlementCacheRecord | undefined> {
    if (!userId || userId.trim() !== userId) throw new Error('Knowledge entitlement cache owner is invalid')
    if (!await this.safeStorage.isAvailable()) {
      throw new Error('Secure storage is unavailable for knowledge entitlement cache')
    }
    const ownerKey = this.ownerKey(userId)
    const storedWatermark = await this.enrollment.read(ownerKey)
    const enrolled = storedWatermark !== undefined
    let serialized: string
    try { serialized = await readFile(this.recordPath(userId), 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (!enrolled) return undefined
        throw new Error('Knowledge entitlement cache is missing for an enrolled owner', { cause: error })
      }
      throw error
    }
    const wrapped = z.object({ version: z.literal(1), ciphertext: z.string().min(1) }).strict()
      .parse(JSON.parse(serialized))
    const decrypted = await this.safeStorage.decrypt(Buffer.from(wrapped.ciphertext, 'base64'))
    const parsed = cacheRecordSchema.parse(JSON.parse(decrypted.value))
    if (parsed.userId !== userId) throw new Error('Knowledge entitlement cache owner mismatch')
    const watermark = this.watermark(ownerKey, parsed.record)
    if (storedWatermark === undefined || storedWatermark === true) {
      await this.enrollment.write(ownerKey, watermark)
    } else {
      const current = parseEnrollmentWatermark(storedWatermark)
      if (current.ownerHash !== ownerKey) throw new Error('Knowledge entitlement watermark owner mismatch')
      if (current.maxIssuedAt !== watermark.maxIssuedAt
        || current.maxObservedAt !== watermark.maxObservedAt
        || current.acceptedEnvelopeHash !== watermark.acceptedEnvelopeHash) {
        throw new Error('Knowledge entitlement cache rollback does not match independent watermark')
      }
    }
    if (decrypted.shouldReEncrypt) await this.write(userId, parsed.record)
    return parsed.record
  }

  async write(userId: string, record: KnowledgeEntitlementCacheRecord): Promise<void> {
    if (!userId || userId.trim() !== userId || !await this.safeStorage.isAvailable()) {
      throw new Error('Secure storage is unavailable for knowledge entitlement cache')
    }
    const parsed = cacheRecordSchema.parse({ version: 1, userId, record })
    const ownerKey = this.ownerKey(userId)
    const watermark = this.watermark(ownerKey, parsed.record)
    const storedWatermark = await this.enrollment.read(ownerKey)
    if (storedWatermark !== undefined && storedWatermark !== true) {
      const current = parseEnrollmentWatermark(storedWatermark)
      if (current.ownerHash !== ownerKey) throw new Error('Knowledge entitlement watermark owner mismatch')
      const nextIssuedAt = Date.parse(watermark.maxIssuedAt)
      const currentIssuedAt = Date.parse(current.maxIssuedAt)
      if (nextIssuedAt < currentIssuedAt
        || Date.parse(watermark.maxObservedAt) < Date.parse(current.maxObservedAt)) {
        throw new Error('Knowledge entitlement watermark rollback rejected')
      }
      if (nextIssuedAt === currentIssuedAt
        && watermark.acceptedEnvelopeHash !== current.acceptedEnvelopeHash) {
        throw new Error('Knowledge entitlement watermark equivocation rejected')
      }
    }
    await this.enrollment.write(ownerKey, watermark)
    const encrypted = await this.safeStorage.encrypt(JSON.stringify(parsed))
    await writeFileDurably(this.recordPath(userId), JSON.stringify({
      version: 1,
      ciphertext: encrypted.toString('base64'),
    }))
  }

  private recordPath(userId: string): string {
    return join(this.directory, `${this.ownerKey(userId)}.json`)
  }

  private watermark(
    ownerHash: string,
    record: KnowledgeEntitlementCacheRecord,
  ): KnowledgeEntitlementEnrollmentWatermark {
    const acceptedEnvelopeHash = createHash('sha256').update(JSON.stringify({
      version: record.envelope.version,
      payload: JSON.parse(canonicalPayloadBytes(record.envelope.payload).toString()),
      signature: record.envelope.signature,
    })).digest('hex')
    return parseEnrollmentWatermark({
      version: 1,
      ownerHash,
      maxIssuedAt: record.maxIssuedAt,
      maxObservedAt: record.maxObservedAt,
      acceptedEnvelopeHash,
    })
  }

  private ownerKey(userId: string): string {
    return createHash('sha256')
      .update('autoforge:knowledge-entitlement-owner:v1:')
      .update(userId)
      .digest('hex')
  }
}

export type VerifiedKnowledgeEntitlementState = KnowledgeEntitlementState & {
  readonly knowledgeToolEnabled: boolean
  readonly killSwitchEnabled: boolean
  readonly membershipExpiresAt?: string
  readonly lifecycle?: {
    readonly phase: 'active' | 'download_window' | 'recycle_window' | 'purge_eligible'
    readonly requiresSelection: boolean
    readonly downloadUntil: string
    readonly recycleUntil: string
  }
}

/** Production intentionally remains fail-closed until an audited deployment key is embedded. */
export const PRODUCTION_KNOWLEDGE_ENTITLEMENT_TRUSTED_KEYS: Readonly<Record<string, string>> = Object.freeze({})

function verificationFailure(reason: string): never {
  throw new Error(`KNOWLEDGE_ENTITLEMENT:${reason}`)
}

function canonicalPayloadBytes(payload: KnowledgeEntitlementEnvelope['payload']): Buffer {
  return Buffer.from(JSON.stringify({
    userId: payload.userId,
    tier: payload.tier,
    entitlements: payload.entitlements,
    issuedAt: payload.issuedAt,
    snapshotExpiresAt: payload.snapshotExpiresAt,
    membershipExpiresAt: payload.membershipExpiresAt,
    membershipStatus: payload.membershipStatus,
    keyId: payload.keyId,
    killSwitchEnabled: payload.killSwitchEnabled,
  }))
}

function failClosedEntitlement(): KnowledgeEntitlementState & {
  knowledgeToolEnabled: false
  killSwitchEnabled: true
} {
  return {
    tier: 'free', status: 'active', betaEnabled: false, cloudEnabled: false,
    knowledgeToolEnabled: false, killSwitchEnabled: true,
  }
}

export class KnowledgeEntitlementVerifier {
  constructor(private readonly options: {
    readonly trustedKeys: Readonly<Record<string, string>>
    readonly now?: () => number
  }) {}

  verify(userId: string, input: unknown): VerifiedKnowledgeEntitlementState {
    const parsed = envelopeSchema.safeParse(input)
    if (!parsed.success) verificationFailure('invalid_envelope')
    const envelope = parsed.data
    if (envelope.payload.userId !== userId) verificationFailure('wrong_user')
    const trustedKey = this.options.trustedKeys[envelope.payload.keyId]
    if (!trustedKey) verificationFailure('untrusted_key')
    let valid = false
    try {
      valid = verify(
        null,
        canonicalPayloadBytes(envelope.payload),
        createPublicKey(trustedKey),
        Buffer.from(envelope.signature, 'base64url'),
      )
    } catch {
      verificationFailure('invalid_key')
    }
    if (!valid) verificationFailure('invalid_signature')

    const now = this.options.now?.() ?? Date.now()
    const issuedAt = Date.parse(envelope.payload.issuedAt)
    const snapshotExpiresAt = Date.parse(envelope.payload.snapshotExpiresAt)
    const membershipExpiresAt = Date.parse(envelope.payload.membershipExpiresAt)
    const free = envelope.payload.tier === 'free'
    const terminal = envelope.payload.membershipStatus !== 'active'
    if (snapshotExpiresAt < issuedAt
      || (!free && !terminal && membershipExpiresAt <= issuedAt)
      || (!free && terminal && membershipExpiresAt > issuedAt)) {
      verificationFailure('invalid_time_order')
    }
    if (issuedAt - now > CLOCK_SKEW_MS) verificationFailure('issued_in_future')

    if (free) {
      if (now > snapshotExpiresAt + OFFLINE_GRACE_MS) verificationFailure('snapshot_expired')
      return {
        tier: 'free', status: 'active', betaEnabled: false, cloudEnabled: false,
        knowledgeToolEnabled: false, killSwitchEnabled: envelope.payload.killSwitchEnabled,
      }
    }

    const downloadUntil = membershipExpiresAt + WINDOW_MS
    const recycleUntil = downloadUntil + WINDOW_MS
    const membershipEnded = envelope.payload.membershipStatus !== 'active' || now >= membershipExpiresAt
    const killSwitchEnabled = envelope.payload.killSwitchEnabled
    let status: VerifiedKnowledgeEntitlementState['status']
    if (membershipEnded) status = 'expired'
    else if (now <= snapshotExpiresAt) status = 'active'
    else if (killSwitchEnabled) verificationFailure('snapshot_expired')
    else if (now <= snapshotExpiresAt + OFFLINE_GRACE_MS) status = 'offline_grace'
    else verificationFailure('snapshot_expired')

    const phase: NonNullable<VerifiedKnowledgeEntitlementState['lifecycle']>['phase'] = !membershipEnded
      ? 'active'
      : now < downloadUntil
        ? 'download_window'
        : now < recycleUntil
          ? 'recycle_window'
          : 'purge_eligible'
    const member = !membershipEnded
    const betaEnabled = member
      && !killSwitchEnabled
      && envelope.payload.entitlements.includes('knowledge_base_beta')
    const cloudEnabled = betaEnabled
      && envelope.payload.entitlements.includes('knowledge_base_cloud')
    return {
      tier: 'member',
      status,
      betaEnabled,
      cloudEnabled,
      knowledgeToolEnabled: betaEnabled,
      killSwitchEnabled,
      membershipExpiresAt: envelope.payload.membershipExpiresAt,
      lifecycle: {
        phase,
        requiresSelection: membershipEnded,
        downloadUntil: new Date(downloadUntil).toISOString(),
        recycleUntil: new Date(recycleUntil).toISOString(),
      },
    }
  }
}

export class KnowledgeEntitlementAuthority {
  private readonly verifier: KnowledgeEntitlementVerifier
  private readonly ownerTails = new Map<string, Promise<void>>()
  private readonly failedOwners = new Set<string>()
  private readonly ownerAuthorizations = new Map<string, {
    fingerprint: string
    revision: number
    entitlement: KnowledgeEntitlementState
  }>()

  constructor(private readonly options: {
    readonly trustedKeys: Readonly<Record<string, string>>
    readonly cache: KnowledgeEntitlementEnvelopeCache
    readonly fetchEnvelope?: (owner: KnowledgeOwner) => Promise<unknown>
    readonly now?: () => number
  }) {
    this.verifier = new KnowledgeEntitlementVerifier({
      trustedKeys: options.trustedKeys,
      now: options.now,
    })
  }

  async getEntitlement(owner: KnowledgeOwner): Promise<KnowledgeEntitlementState> {
    return (await this.getAuthorizationSnapshot(owner)).entitlement
  }

  async getAuthorizationSnapshot(owner: KnowledgeOwner): Promise<{
    entitlement: KnowledgeEntitlementState
    revision: number
  }> {
    if (!owner.userId || owner.userId.trim() !== owner.userId) {
      return { entitlement: failClosedEntitlement(), revision: 0 }
    }
    const previous = this.ownerTails.get(owner.userId) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(async () => {
      const decision = await this.getEntitlementSerialized(owner)
      const previousAuthorization = this.ownerAuthorizations.get(owner.userId)
      const revision = previousAuthorization === undefined
        ? 1
        : previousAuthorization.fingerprint === decision.fingerprint
          && isDeepStrictEqual(previousAuthorization.entitlement, decision.entitlement)
          ? previousAuthorization.revision
          : previousAuthorization.revision + 1
      const authorization = { ...decision, revision }
      this.ownerAuthorizations.set(owner.userId, authorization)
      return { entitlement: authorization.entitlement, revision: authorization.revision }
    })
    const tail = operation.then(() => undefined, () => undefined)
    this.ownerTails.set(owner.userId, tail)
    try {
      return await operation
    } finally {
      if (this.ownerTails.get(owner.userId) === tail) this.ownerTails.delete(owner.userId)
    }
  }

  async isAuthorizationSnapshotCurrent(
    owner: KnowledgeOwner,
    expected: { entitlement: KnowledgeEntitlementState; revision: number },
  ): Promise<boolean> {
    const current = await this.getAuthorizationSnapshot(owner)
    return current.revision === expected.revision
      && isDeepStrictEqual(current.entitlement, expected.entitlement)
  }

  isAuthorizationSnapshotCurrentNow(
    owner: KnowledgeOwner,
    expected: { entitlement: KnowledgeEntitlementState; revision: number },
  ): boolean {
    const current = this.ownerAuthorizations.get(owner.userId)
    return current?.revision === expected.revision
      && isDeepStrictEqual(current.entitlement, expected.entitlement)
  }

  private async getEntitlementSerialized(owner: KnowledgeOwner): Promise<{
    entitlement: KnowledgeEntitlementState
    fingerprint: string
  }> {
    const failed = () => ({ entitlement: failClosedEntitlement(), fingerprint: 'fail-closed' })
    if (this.failedOwners.has(owner.userId)) return failed()
    const now = this.options.now?.() ?? Date.now()
    let cached: KnowledgeEntitlementCacheRecord | undefined
    try {
      cached = await this.options.cache.read(owner.userId)
    } catch {
      this.failedOwners.add(owner.userId)
      return failed()
    }
    if (cached && now < Date.parse(cached.maxObservedAt)) {
      this.failedOwners.add(owner.userId)
      return failed()
    }

    let cachedState: VerifiedKnowledgeEntitlementState | undefined
    if (cached) {
      try {
        cachedState = this.verifier.verify(owner.userId, cached.envelope)
      } catch {
        this.failedOwners.add(owner.userId)
        return failed()
      }
    }

    let fetched: KnowledgeEntitlementEnvelope | undefined
    let fetchedState: VerifiedKnowledgeEntitlementState | undefined
    if (this.options.fetchEnvelope) {
      try {
        const candidate = envelopeSchema.parse(await this.options.fetchEnvelope(owner))
        fetchedState = this.verifier.verify(owner.userId, candidate)
        fetched = candidate
      } catch { /* Offline, malformed, or untrusted input may only fall back to verified cache. */ }
    }

    const fetchedIssuedAt = fetched === undefined ? undefined : Date.parse(fetched.payload.issuedAt)
    const maximumIssuedAt = cached === undefined ? Number.NEGATIVE_INFINITY : Date.parse(cached.maxIssuedAt)
    const fetchedMatchesCache = fetched !== undefined
      && cachedState !== undefined
      && fetched.signature === cached!.envelope.signature
      && canonicalPayloadBytes(fetched.payload).equals(canonicalPayloadBytes(cached!.envelope.payload))
    const fetchedMayStartOrContinue = fetchedState?.status !== 'offline_grace' || fetchedMatchesCache
    const fetchedIsMonotonic = fetchedIssuedAt !== undefined && (
      fetchedIssuedAt > maximumIssuedAt
      || (fetchedIssuedAt === maximumIssuedAt && fetchedMatchesCache)
    )
    const accepted = fetchedMayStartOrContinue && fetchedIsMonotonic
      ? fetched
      : cachedState === undefined ? undefined : cached!.envelope
    if (!accepted) return failed()

    let state: VerifiedKnowledgeEntitlementState
    try { state = this.verifier.verify(owner.userId, accepted) } catch { return failed() }
    const record: KnowledgeEntitlementCacheRecord = {
      envelope: accepted,
      maxIssuedAt: new Date(Math.max(maximumIssuedAt, Date.parse(accepted.payload.issuedAt))).toISOString(),
      maxObservedAt: new Date(Math.max(
        cached === undefined ? Number.NEGATIVE_INFINITY : Date.parse(cached.maxObservedAt), now,
      )).toISOString(),
    }
    try {
      await this.options.cache.write(owner.userId, record)
    } catch {
      this.failedOwners.add(owner.userId)
      return failed()
    }
    return { entitlement: state, fingerprint: accepted.signature }
  }
}
