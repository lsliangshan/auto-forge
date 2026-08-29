import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AUTOFORGE_KNOWLEDGE_ENTITLEMENT_PUBLIC_KEYS,
  canonicalizeEntitlementPayload,
  canonicalizeMembershipEntitlementPayload,
  createKnowledgeEntitlementVerificationCallback,
  KnowledgeEntitlementVerifier,
  type SignedKnowledgeEntitlement,
} from './entitlement-verifier.js'

const NOW = Date.parse('2026-08-28T00:00:00.000Z')

function fixture() {
  const key = generateKeyPairSync('ed25519')
  const other = generateKeyPairSync('ed25519')
  const payload = {
    userId: 'alice',
    entitlements: ['knowledge_base_beta', 'knowledge_base_cloud'] as const,
    issuedAt: '2026-08-27T00:00:00.000Z',
    expiresAt: '2026-08-29T00:00:00.000Z',
    keyId: 'primary',
  }
  const envelope = (value = payload, privateKey = key.privateKey): SignedKnowledgeEntitlement => {
    const canonical = canonicalizeEntitlementPayload(value)
    return {
      payload: Buffer.from(canonical, 'utf8').toString('base64url'),
      signature: sign(null, Buffer.from(canonical), privateKey).toString('base64url'),
    }
  }
  const verifier = (now = NOW) => new KnowledgeEntitlementVerifier({
    publicKeys: {
      primary: { publicKey: key.publicKey, generation: 1, status: 'active' },
    },
    now: () => now,
  })
  return { key, other, payload, envelope, verifier }
}

describe('KnowledgeEntitlementVerifier', () => {
  it('constructs the production verifier with one active signing generation', () => {
    expect(() => new KnowledgeEntitlementVerifier({
      publicKeys: AUTOFORGE_KNOWLEDGE_ENTITLEMENT_PUBLIC_KEYS,
    })).not.toThrow()
  })

  it('accepts a canonical valid Ed25519 snapshot for the authenticated owner', () => {
    const { envelope, verifier } = fixture()
    expect(verifier().verify('alice', envelope())).toMatchObject({
      tier: 'member', status: 'active', localEnabled: true, betaEnabled: true, cloudEnabled: true,
      keyGeneration: 1,
    })
  })

  it('uses the service clock floor in the production verification callback', () => {
    const { envelope, payload } = fixture()
    const key = generateKeyPairSync('ed25519')
    const verifier = new KnowledgeEntitlementVerifier({
      publicKeys: {
        primary: { publicKey: key.publicKey, generation: 1, status: 'active' },
      },
      now: () => Date.parse('2026-08-27T00:00:00.000Z'),
    })
    const canonical = canonicalizeEntitlementPayload({
      ...payload,
      issuedAt: '2026-08-28T00:00:00.000Z',
    })
    const snapshot = {
      ...envelope(),
      payload: Buffer.from(canonical).toString('base64url'),
      signature: sign(null, Buffer.from(canonical), key.privateKey).toString('base64url'),
    }
    const verifyEntitlement = createKnowledgeEntitlementVerificationCallback(verifier)

    expect(verifyEntitlement(
      'alice', snapshot, Date.parse('2026-08-29T00:00:00.000Z'),
    )).toMatchObject({ tier: 'member', keyGeneration: 1 })
  })

  it('enforces active-to-retired key transitions and returns the monotonic key generation', () => {
    const oldKey = generateKeyPairSync('ed25519')
    const newKey = generateKeyPairSync('ed25519')
    const verifier = new KnowledgeEntitlementVerifier({
      publicKeys: {
        old: {
          publicKey: oldKey.publicKey,
          generation: 1,
          status: 'retired',
          retiredAt: '2026-08-27T12:00:00.000Z',
        },
        current: { publicKey: newKey.publicKey, generation: 2, status: 'active' },
      },
      now: () => NOW,
    })
    const signed = (
      keyId: 'old' | 'current',
      issuedAt: string,
      privateKey: typeof oldKey.privateKey,
    ) => {
      const canonical = canonicalizeEntitlementPayload({
        userId: 'alice',
        entitlements: ['knowledge_base_beta', 'knowledge_base_cloud'],
        issuedAt,
        expiresAt: '2026-08-29T00:00:00.000Z',
        keyId,
      })
      return {
        payload: Buffer.from(canonical).toString('base64url'),
        signature: sign(null, Buffer.from(canonical), privateKey).toString('base64url'),
      }
    }

    expect(verifier.verify('alice', signed(
      'old', '2026-08-27T12:00:00.000Z', oldKey.privateKey,
    ))).toMatchObject({ keyId: 'old', keyGeneration: 1 })
    expect(() => verifier.verify('alice', signed(
      'old', '2026-08-27T12:00:00.001Z', oldKey.privateKey,
    ))).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(verifier.verify('alice', signed(
      'current', '2026-08-28T00:00:00.000Z', newKey.privateKey,
    ))).toMatchObject({ keyId: 'current', keyGeneration: 2 })
  })

  it('rejects tampering, wrong owners, unknown keys, and future issuance', () => {
    const { envelope, payload, other, verifier } = fixture()
    const signed = envelope()
    const decoded = JSON.parse(Buffer.from(signed.payload, 'base64url').toString('utf8'))
    decoded.entitlements = ['knowledge_base_beta']
    const tampered = { ...signed, payload: Buffer.from(JSON.stringify(decoded)).toString('base64url') }
    expect(() => verifier().verify('alice', tampered)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => verifier().verify('bob', signed)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => verifier().verify('alice', envelope({ ...payload, keyId: 'retired' })))
      .toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => verifier().verify('alice', envelope(payload, other.privateKey)))
      .toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => verifier().verify('alice', envelope({
      ...payload, issuedAt: '2026-08-28T00:00:00.001Z', expiresAt: '2026-08-29T00:00:00.000Z',
    }))).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
  })

  it('rejects non-canonical payload bytes even when their signature is valid', () => {
    const { key, payload, verifier } = fixture()
    const nonCanonical = JSON.stringify({
      keyId: payload.keyId,
      userId: payload.userId,
      entitlements: payload.entitlements,
      issuedAt: payload.issuedAt,
      expiresAt: payload.expiresAt,
    })
    const snapshot = {
      payload: Buffer.from(nonCanonical).toString('base64url'),
      signature: sign(null, Buffer.from(nonCanonical), key.privateKey).toString('base64url'),
    }
    expect(() => verifier().verify('alice', snapshot))
      .toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
  })

  it('admits offline grace through exactly 72 hours and expires one millisecond later', () => {
    const { envelope, payload, verifier } = fixture()
    const expiresAt = '2026-08-25T00:00:00.000Z'
    const snapshot = envelope({ ...payload, issuedAt: '2026-08-24T00:00:00.000Z', expiresAt })
    expect(verifier(Date.parse(expiresAt) + (72 * 60 * 60 * 1_000)).verify('alice', snapshot))
      .toMatchObject({ status: 'offline_grace', tier: 'member' })
    expect(verifier(Date.parse(expiresAt) + (72 * 60 * 60 * 1_000) + 1).verify('alice', snapshot))
      .toMatchObject({ status: 'expired', tier: 'free', cloudEnabled: false })
  })

  it('verifies versioned membership limits and treats online revoke as immediately free', () => {
    const key = generateKeyPairSync('ed25519')
    const verifier = new KnowledgeEntitlementVerifier({
      publicKeys: {
        membership: { publicKey: key.publicKey, generation: 2, status: 'active' },
      },
      now: () => NOW,
    })
    const signed = (effectiveStatus: 'active' | 'revoked') => {
      const canonical = canonicalizeMembershipEntitlementPayload({
        schemaVersion: 2, userId: 'alice', membershipVersion: effectiveStatus === 'active' ? 3 : 4,
        planId: 'pro', planVersion: 1, state: effectiveStatus === 'active' ? 'active' : 'revoked',
        effectiveStatus, grantKind: 'manual_grant', termEndsAt: '2026-08-29T00:00:00.000Z',
        issuedAt: '2026-08-28T00:00:00.000Z', refreshAfter: '2026-08-28T00:05:00.000Z',
        offlineGraceEndsAt: '2026-09-01T00:00:00.000Z',
        limits: {
          knowledgeBases: effectiveStatus === 'active' ? 20 : 1,
          knowledgeDocuments: effectiveStatus === 'active' ? 500 : 1,
          knowledgeFileBytes: 67_108_864,
        },
        cloudEligible: effectiveStatus === 'active', keyId: 'membership',
      })
      return {
        payload: Buffer.from(canonical).toString('base64url'),
        signature: sign(null, Buffer.from(canonical), key.privateKey).toString('base64url'),
      }
    }

    expect(verifier.verify('alice', signed('active'))).toMatchObject({
      tier: 'member', status: 'active', planId: 'pro', membershipVersion: 3,
      limits: { knowledgeBases: 20, knowledgeDocuments: 500 },
    })
    expect(verifier.verify('alice', signed('revoked'))).toMatchObject({
      tier: 'free', status: 'expired', planId: 'pro', membershipVersion: 4,
      cloudEnabled: false, limits: { knowledgeBases: 1, knowledgeDocuments: 1 },
    })
  })

  it('fails closed for a snapshot whose expiry precedes issuance', () => {
    const { key, payload, verifier } = fixture()
    const invalid = JSON.stringify({
      ...payload, issuedAt: '2026-08-27T00:00:00.000Z', expiresAt: '2026-08-26T00:00:00.000Z',
    })
    expect(() => verifier().verify('alice', {
      payload: Buffer.from(invalid).toString('base64url'),
      signature: sign(null, Buffer.from(invalid), key.privateKey).toString('base64url'),
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
  })

  it('rejects non-canonical base64url, non-64-byte signatures, and non-Ed25519 keys', () => {
    const { envelope, verifier } = fixture()
    const signed = envelope()
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    const last = signed.signature.at(-1)!
    const nonCanonicalLast = alphabet[(alphabet.indexOf(last) ^ 1)]!
    expect(() => verifier().verify('alice', {
      ...signed,
      signature: `${signed.signature.slice(0, -1)}${nonCanonicalLast}`,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    expect(() => verifier().verify('alice', {
      ...signed,
      signature: Buffer.alloc(63).toString('base64url'),
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))

    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
    expect(() => new KnowledgeEntitlementVerifier({
      publicKeys: {
        primary: { publicKey: rsa.publicKey, generation: 1, status: 'active' },
      },
    }))
      .toThrowError()
  })
})
