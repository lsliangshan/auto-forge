import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
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
  entitlements: z.array(z.enum(['knowledge_base_beta', 'knowledge_base_cloud'])).max(2)
    .refine(values => new Set(values).size === values.length, 'duplicate_entitlement')
    .refine(values => values.every((value, index) => index === 0 || values[index - 1]! < value), 'entitlements_not_canonical'),
  issuedAt: canonicalTimestampSchema,
  snapshotExpiresAt: canonicalTimestampSchema,
  membershipExpiresAt: canonicalTimestampSchema,
  membershipStatus: z.enum(['active', 'expired', 'revoked']),
  keyId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  killSwitchEnabled: z.boolean(),
}).strict()
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
  ) {}

  async read(userId: string): Promise<KnowledgeEntitlementCacheRecord | undefined> {
    if (!userId || userId.trim() !== userId) throw new Error('Knowledge entitlement cache owner is invalid')
    if (!await this.safeStorage.isAvailable()) {
      throw new Error('Secure storage is unavailable for knowledge entitlement cache')
    }
    let serialized: string
    try { serialized = await readFile(this.recordPath(userId), 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        try {
          await readFile(this.enrollmentPath(userId), 'utf8')
        } catch (enrollmentError) {
          if ((enrollmentError as NodeJS.ErrnoException).code === 'ENOENT') return undefined
          throw enrollmentError
        }
        throw new Error('Knowledge entitlement cache is missing for an enrolled owner', { cause: error })
      }
      throw error
    }
    const wrapped = z.object({ version: z.literal(1), ciphertext: z.string().min(1) }).strict()
      .parse(JSON.parse(serialized))
    const decrypted = await this.safeStorage.decrypt(Buffer.from(wrapped.ciphertext, 'base64'))
    const parsed = cacheRecordSchema.parse(JSON.parse(decrypted.value))
    if (parsed.userId !== userId) throw new Error('Knowledge entitlement cache owner mismatch')
    if (decrypted.shouldReEncrypt) await this.write(userId, parsed.record)
    return parsed.record
  }

  async write(userId: string, record: KnowledgeEntitlementCacheRecord): Promise<void> {
    if (!userId || userId.trim() !== userId || !await this.safeStorage.isAvailable()) {
      throw new Error('Secure storage is unavailable for knowledge entitlement cache')
    }
    const parsed = cacheRecordSchema.parse({ version: 1, userId, record })
    try {
      await readFile(this.enrollmentPath(userId), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await writeFileDurably(this.enrollmentPath(userId), JSON.stringify({ version: 1 }))
    }
    const encrypted = await this.safeStorage.encrypt(JSON.stringify(parsed))
    await writeFileDurably(this.recordPath(userId), JSON.stringify({
      version: 1,
      ciphertext: encrypted.toString('base64'),
    }))
  }

  private recordPath(userId: string): string {
    const owner = createHash('sha256')
      .update('autoforge:knowledge-entitlement-owner:v1:')
      .update(userId)
      .digest('hex')
    return join(this.directory, `${owner}.json`)
  }

  private enrollmentPath(userId: string): string {
    const owner = createHash('sha256')
      .update('autoforge:knowledge-entitlement-owner:v1:')
      .update(userId)
      .digest('hex')
    return join(this.directory, `${owner}.enrolled`)
  }
}

export type VerifiedKnowledgeEntitlementState = KnowledgeEntitlementState & {
  readonly knowledgeToolEnabled: boolean
  readonly killSwitchEnabled: boolean
  readonly membershipExpiresAt: string
  readonly lifecycle: {
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
    const terminal = envelope.payload.membershipStatus !== 'active'
    if (snapshotExpiresAt < issuedAt
      || (!terminal && membershipExpiresAt <= issuedAt)
      || (terminal && membershipExpiresAt > issuedAt)) {
      verificationFailure('invalid_time_order')
    }
    if (issuedAt - now > CLOCK_SKEW_MS) verificationFailure('issued_in_future')

    const downloadUntil = membershipExpiresAt + WINDOW_MS
    const recycleUntil = downloadUntil + WINDOW_MS
    const membershipEnded = envelope.payload.membershipStatus !== 'active' || now >= membershipExpiresAt
    const killSwitchEnabled = envelope.payload.killSwitchEnabled
    let status: VerifiedKnowledgeEntitlementState['status']
    if (membershipEnded) status = 'expired'
    else if (now <= snapshotExpiresAt || killSwitchEnabled) status = 'active'
    else if (now <= snapshotExpiresAt + OFFLINE_GRACE_MS) status = 'offline_grace'
    else verificationFailure('snapshot_expired')

    const phase: VerifiedKnowledgeEntitlementState['lifecycle']['phase'] = !membershipEnded
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
      tier: member ? 'member' : 'free',
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
    if (!owner.userId || owner.userId.trim() !== owner.userId) return failClosedEntitlement()
    const previous = this.ownerTails.get(owner.userId) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(() => this.getEntitlementSerialized(owner))
    const tail = operation.then(() => undefined, () => undefined)
    this.ownerTails.set(owner.userId, tail)
    try {
      return await operation
    } finally {
      if (this.ownerTails.get(owner.userId) === tail) this.ownerTails.delete(owner.userId)
    }
  }

  private async getEntitlementSerialized(owner: KnowledgeOwner): Promise<KnowledgeEntitlementState> {
    if (this.failedOwners.has(owner.userId)) return failClosedEntitlement()
    const now = this.options.now?.() ?? Date.now()
    let cached: KnowledgeEntitlementCacheRecord | undefined
    try {
      cached = await this.options.cache.read(owner.userId)
    } catch {
      this.failedOwners.add(owner.userId)
      return failClosedEntitlement()
    }
    if (cached && now < Date.parse(cached.maxObservedAt)) {
      this.failedOwners.add(owner.userId)
      return failClosedEntitlement()
    }

    let cachedState: VerifiedKnowledgeEntitlementState | undefined
    if (cached) {
      try {
        cachedState = this.verifier.verify(owner.userId, cached.envelope)
      } catch {
        this.failedOwners.add(owner.userId)
        return failClosedEntitlement()
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
    if (!accepted) return failClosedEntitlement()

    let state: VerifiedKnowledgeEntitlementState
    try { state = this.verifier.verify(owner.userId, accepted) } catch { return failClosedEntitlement() }
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
      return failClosedEntitlement()
    }
    return state
  }
}
