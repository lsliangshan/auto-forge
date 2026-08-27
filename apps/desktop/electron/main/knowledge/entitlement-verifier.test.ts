import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  canonicalizeEntitlementPayload,
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
    publicKeys: { primary: key.publicKey },
    now: () => now,
  })
  return { key, other, payload, envelope, verifier }
}

describe('KnowledgeEntitlementVerifier', () => {
  it('accepts a canonical valid Ed25519 snapshot for the authenticated owner', () => {
    const { envelope, verifier } = fixture()
    expect(verifier().verify('alice', envelope())).toMatchObject({
      tier: 'member', status: 'active', localEnabled: true, betaEnabled: true, cloudEnabled: true,
    })
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
})
