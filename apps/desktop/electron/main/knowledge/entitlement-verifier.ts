import { createPublicKey, KeyObject, verify, type KeyLike } from 'node:crypto'
import { z } from 'zod'
import { toSafeAppError } from '@autoforge/shared'

const GRACE_MS = 72 * 60 * 60 * 1_000
const base64url = /^[A-Za-z0-9_-]+$/

/** Public verification material only; the signing key remains outside the desktop bundle. */
export const AUTOFORGE_KNOWLEDGE_ENTITLEMENT_PUBLIC_KEYS = Object.freeze({
  'knowledge-2026-01': Object.freeze({
    publicKey: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEALldb4naB63qosvMo+P8W6Jyh7fia+uzNRFjSr2OlG9E=
-----END PUBLIC KEY-----`,
    generation: 1,
    status: 'active' as const,
  }),
})

export const knowledgeEntitlementNames = [
  'knowledge_base_beta',
  'knowledge_base_cloud',
] as const

const payloadSchema = z.object({
  userId: z.string().trim().min(1).max(128),
  entitlements: z.array(z.enum(knowledgeEntitlementNames)).max(2),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  keyId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
}).strict().superRefine((value, context) => {
  if (new Set(value.entitlements).size !== value.entitlements.length
    || value.entitlements.some((entry, index) => index > 0 && value.entitlements[index - 1]! > entry)) {
    context.addIssue({ code: 'custom', path: ['entitlements'], message: 'Entitlements must be unique and sorted' })
  }
  if (Date.parse(value.expiresAt) < Date.parse(value.issuedAt)) {
    context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'Expiry must not precede issuance' })
  }
  for (const field of ['issuedAt', 'expiresAt'] as const) {
    if (new Date(value[field]).toISOString() !== value[field]) {
      context.addIssue({ code: 'custom', path: [field], message: 'Timestamp must be canonical UTC milliseconds' })
    }
  }
})

export type KnowledgeEntitlementPayload = z.infer<typeof payloadSchema>

export interface SignedKnowledgeEntitlement {
  readonly payload: string
  readonly signature: string
}

export interface VerifiedKnowledgeEntitlement {
  readonly tier: 'free' | 'member'
  readonly status: 'active' | 'offline_grace' | 'expired'
  readonly localEnabled: true
  readonly betaEnabled: boolean
  readonly cloudEnabled: boolean
  readonly issuedAt: string
  readonly expiresAt: string
  readonly graceEndsAt: string
  readonly keyId: string
  readonly keyGeneration: number
}

export type KnowledgeEntitlementVerificationKey = Readonly<{
  publicKey: KeyLike
  generation: number
  status: 'active'
  retiredAt?: never
} | {
  publicKey: KeyLike
  generation: number
  status: 'retired'
  retiredAt: string
}>

export function canonicalizeEntitlementPayload(input: {
  readonly userId: string
  readonly entitlements: readonly (typeof knowledgeEntitlementNames[number])[]
  readonly issuedAt: string
  readonly expiresAt: string
  readonly keyId: string
}): string {
  const parsed = payloadSchema.parse({ ...input, entitlements: [...input.entitlements] })
  return JSON.stringify({
    userId: parsed.userId,
    entitlements: parsed.entitlements,
    issuedAt: parsed.issuedAt,
    expiresAt: parsed.expiresAt,
    keyId: parsed.keyId,
  })
}

function fail(code: 'INVALID_INPUT' | 'FORBIDDEN'): never {
  throw toSafeAppError({ code })
}

export class KnowledgeEntitlementVerifier {
  private readonly publicKeys: ReadonlyMap<string, {
    publicKey: KeyObject
    generation: number
    retiredAt?: number
  }>
  private readonly now: () => number

  constructor(input: {
    publicKeys: Readonly<Record<string, KnowledgeEntitlementVerificationKey>>
    now?: () => number
  }) {
    const configured = Object.entries(input.publicKeys)
    const active = configured.filter(([, key]) => key.status === 'active')
    if (active.length !== 1) {
      throw new TypeError('Knowledge entitlement verification requires exactly one active key')
    }
    const activeGeneration = active[0]![1].generation
    this.publicKeys = new Map(configured.map(([keyId, key]) => {
      if (!Number.isSafeInteger(key.generation) || key.generation <= 0) {
        throw new TypeError('Knowledge entitlement verification key generations must be positive integers')
      }
      if (key.status === 'retired' && key.generation >= activeGeneration) {
        throw new TypeError('Retired knowledge entitlement keys must precede the active generation')
      }
      let retiredAt: number | undefined
      if (key.status === 'retired') {
        retiredAt = Date.parse(key.retiredAt)
        if (!Number.isSafeInteger(retiredAt)
          || new Date(retiredAt).toISOString() !== key.retiredAt) {
          throw new TypeError('Retired knowledge entitlement keys require a canonical transition boundary')
        }
      }
      const publicKey = key.publicKey instanceof KeyObject
        ? key.publicKey
        : createPublicKey(key.publicKey)
      if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') {
        throw new TypeError('Knowledge entitlement verification keys must be Ed25519 public keys')
      }
      return [keyId, { publicKey, generation: key.generation, retiredAt }]
    }))
    this.now = input.now ?? Date.now
  }

  verify(
    ownerId: string,
    snapshot: SignedKnowledgeEntitlement,
    observedAt = this.now(),
  ): VerifiedKnowledgeEntitlement {
    if (!base64url.test(snapshot.payload) || snapshot.payload.length > 8_192
      || !base64url.test(snapshot.signature) || snapshot.signature.length > 256) fail('INVALID_INPUT')
    const payloadBytes = Buffer.from(snapshot.payload, 'base64url')
    const signature = Buffer.from(snapshot.signature, 'base64url')
    if (payloadBytes.toString('base64url') !== snapshot.payload
      || signature.toString('base64url') !== snapshot.signature
      || signature.length !== 64) fail('INVALID_INPUT')
    let value: unknown
    try {
      value = JSON.parse(payloadBytes.toString('utf8'))
    } catch {
      fail('INVALID_INPUT')
    }
    const parsed = payloadSchema.safeParse(value)
    if (!parsed.success) fail('INVALID_INPUT')
    const canonical = canonicalizeEntitlementPayload(parsed.data)
    if (!payloadBytes.equals(Buffer.from(canonical, 'utf8'))) fail('INVALID_INPUT')
    const configuredKey = this.publicKeys.get(parsed.data.keyId)
    if (!configuredKey
      || !verify(null, payloadBytes, configuredKey.publicKey, signature)) fail('FORBIDDEN')
    if (parsed.data.userId !== ownerId) fail('FORBIDDEN')
    const now = observedAt
    const issuedAt = Date.parse(parsed.data.issuedAt)
    if (issuedAt > now) fail('FORBIDDEN')
    if (configuredKey.retiredAt !== undefined && issuedAt > configuredKey.retiredAt) fail('FORBIDDEN')
    const expiresAt = Date.parse(parsed.data.expiresAt)
    const graceEndsAt = expiresAt + GRACE_MS
    const status = now <= expiresAt ? 'active' : now <= graceEndsAt ? 'offline_grace' : 'expired'
    const member = status !== 'expired'
    const entitlements = new Set(parsed.data.entitlements)
    return Object.freeze({
      tier: member ? 'member' : 'free',
      status,
      localEnabled: true,
      betaEnabled: member && entitlements.has('knowledge_base_beta'),
      cloudEnabled: member
        && entitlements.has('knowledge_base_beta')
        && entitlements.has('knowledge_base_cloud'),
      issuedAt: parsed.data.issuedAt,
      expiresAt: parsed.data.expiresAt,
      graceEndsAt: new Date(graceEndsAt).toISOString(),
      keyId: parsed.data.keyId,
      keyGeneration: configuredKey.generation,
    })
  }
}
