import { createPrivateKey, sign } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KnowledgeEntitlementState } from '@autoforge/shared'
import {
  KnowledgeEntitlementAuthority,
  KnowledgeEntitlementVerifier,
  PRODUCTION_KNOWLEDGE_ENTITLEMENT_TRUSTED_KEYS,
  SafeStorageKnowledgeEntitlementCache,
  type KnowledgeEntitlementCacheRecord,
  type KnowledgeEntitlementEnvelope,
  type KnowledgeEntitlementEnvelopeCache,
} from './entitlement-verifier.js'
import type { SafeStoragePort } from '../security/secret-store.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA97YWmXI20+rOSQmtkgJIn0IbiaLrp6KZly2Enn0pyac=
-----END PUBLIC KEY-----
`
const WRONG_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAcUa+jiHotbRlYZBSAPrrljc8vKo9vnAGT4+1pi7feMU=
-----END PUBLIC KEY-----
`
const PRIVATE_KEY = createPrivateKey(`-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIPw1EZH4rU2rAWoikip2sgTamPoODfyfnO4IDFB68He9
-----END PRIVATE KEY-----
`)
const require = createRequire(import.meta.url)
const { createKnowledgeEntitlementSigner } = require('../../../../../cloudbase/knowledge/function/entitlement-envelope.js') as {
  createKnowledgeEntitlementSigner(deployment: Readonly<{
    keyId: string
    snapshotTtlMs: number
    now: () => number
    signCanonical: (bytes: Buffer) => Promise<Buffer>
  }>): (ownerId: string, databaseRecord: unknown) => Promise<unknown>
}

const ACTIVE_PAYLOAD: KnowledgeEntitlementEnvelope['payload'] = {
  userId: 'alice',
  tier: 'member',
  entitlements: ['knowledge_base_beta', 'knowledge_base_cloud'],
  issuedAt: '2026-08-26T00:00:00.000Z',
  snapshotExpiresAt: '2026-08-26T01:00:00.000Z',
  membershipExpiresAt: '2026-09-26T00:00:00.000Z',
  membershipStatus: 'active',
  keyId: 'test-key-1',
  killSwitchEnabled: false,
}
const ACTIVE_SIGNATURE = 'Gw5jNSjgeDk91712kEA0jBUDLTm9fNYFPsO77crz4rFcfW2S1qZosAKbJUy6q9WZyY0f6mrRoqjXcvTDPpWPDw'
const ACTIVE_ENVELOPE: KnowledgeEntitlementEnvelope = {
  version: 1,
  payload: ACTIVE_PAYLOAD,
  signature: ACTIVE_SIGNATURE,
}

function signedEnvelope(
  overrides: Partial<KnowledgeEntitlementEnvelope['payload']>,
): KnowledgeEntitlementEnvelope {
  const payload = { ...ACTIVE_PAYLOAD, ...overrides }
  return {
    version: 1,
    payload,
    signature: sign(null, Buffer.from(JSON.stringify(payload)), PRIVATE_KEY).toString('base64url'),
  }
}

function verifier(now: string, keys: Readonly<Record<string, string>> = { 'test-key-1': PUBLIC_KEY }) {
  return new KnowledgeEntitlementVerifier({ trustedKeys: keys, now: () => Date.parse(now) })
}

function enrollmentStore() {
  const enrolled = new Set<string>()
  const watermarks = new Map<string, unknown>()
  return {
    enrolled,
    watermarks,
    isEnrolled: async (ownerKey: string) => enrolled.has(ownerKey),
    enroll: async (ownerKey: string) => { enrolled.add(ownerKey) },
    read: async (ownerKey: string) => watermarks.has(ownerKey)
      ? watermarks.get(ownerKey)
      : enrolled.has(ownerKey) ? true : undefined,
    write: async (ownerKey: string, watermark: unknown) => {
      enrolled.add(ownerKey)
      watermarks.set(ownerKey, watermark)
    },
  }
}

function safeStorageCache(
  directory: string,
  storage: SafeStoragePort,
  enrollment: ReturnType<typeof enrollmentStore>,
): SafeStorageKnowledgeEntitlementCache {
  const Cache = SafeStorageKnowledgeEntitlementCache as unknown as new (
    directory: string,
    safeStorage: SafeStoragePort,
    enrollment: ReturnType<typeof enrollmentStore>,
  ) => SafeStorageKnowledgeEntitlementCache
  return new Cache(directory, storage, enrollment)
}

describe('KnowledgeEntitlementVerifier', () => {
  it('accepts the literal canonical Ed25519 fixture for its exact user and entitlements', () => {
    expect(verifier('2026-08-26T00:30:00.000Z').verify('alice', ACTIVE_ENVELOPE)).toEqual({
      tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: true,
      knowledgeToolEnabled: true, killSwitchEnabled: false,
      membershipExpiresAt: '2026-09-26T00:00:00.000Z',
      lifecycle: {
        phase: 'active', requiresSelection: false,
        downloadUntil: '2026-10-26T00:00:00.000Z',
        recycleUntil: '2026-11-25T00:00:00.000Z',
      },
    })
  })

  it('verifies the real default server row as active free local-only authority without membership lifecycle', async () => {
    const signer = createKnowledgeEntitlementSigner(Object.freeze({
      keyId: 'test-key-1',
      snapshotTtlMs: 60 * 60 * 1_000,
      now: () => Date.parse('2026-08-26T00:00:00.000Z'),
      signCanonical: async (bytes: Buffer) => sign(null, bytes, PRIVATE_KEY),
    }))
    const envelope = await signer('alice', {
      tier: 'free', status: 'active', betaEnabled: false, cloudEnabled: false,
      killSwitchEnabled: true, version: 0, validUntil: null,
    })

    expect(envelope).toMatchObject({ payload: {
      userId: 'alice', tier: 'free', entitlements: [], membershipStatus: 'active',
      killSwitchEnabled: true,
    } })
    expect(verifier('2026-08-26T00:30:00.000Z').verify('alice', envelope)).toEqual({
      tier: 'free', status: 'active', betaEnabled: false, cloudEnabled: false,
      knowledgeToolEnabled: false, killSwitchEnabled: true,
    })
  })

  it.each([
    ['wrong user', 'bob', ACTIVE_ENVELOPE, { 'test-key-1': PUBLIC_KEY }, 'wrong_user'],
    ['wrong key id', 'alice', { ...ACTIVE_ENVELOPE, payload: { ...ACTIVE_PAYLOAD, keyId: 'missing-key' } }, { 'test-key-1': PUBLIC_KEY }, 'untrusted_key'],
    ['wrong trusted key', 'alice', ACTIVE_ENVELOPE, { 'test-key-1': WRONG_PUBLIC_KEY }, 'invalid_signature'],
    ['tampered entitlement', 'alice', { ...ACTIVE_ENVELOPE, payload: { ...ACTIVE_PAYLOAD, entitlements: ['knowledge_base_beta'] } }, { 'test-key-1': PUBLIC_KEY }, 'invalid_signature'],
  ] as const)('rejects the literal %s fixture', (_label, userId, envelope, keys, reason) => {
    expect(() => verifier('2026-08-26T00:30:00.000Z', keys).verify(userId, envelope))
      .toThrow(reason)
  })

  it('applies offline grace at exact clock boundaries only to a previously active snapshot', () => {
    expect(verifier('2026-08-26T01:00:00.000Z').verify('alice', ACTIVE_ENVELOPE).status).toBe('active')
    expect(verifier('2026-08-26T01:00:00.001Z').verify('alice', ACTIVE_ENVELOPE).status).toBe('offline_grace')
    expect(verifier('2026-08-29T01:00:00.000Z').verify('alice', ACTIVE_ENVELOPE).status).toBe('offline_grace')
    expect(() => verifier('2026-08-29T01:00:00.001Z').verify('alice', ACTIVE_ENVELOPE))
      .toThrow('snapshot_expired')
  })

  it('never grants grace to signed expired, revoked, or membership-expired state', () => {
    const now = '2026-08-26T02:00:00.000Z'
    for (const [envelope, expectedStatus] of [
      [signedEnvelope({ membershipStatus: 'expired', membershipExpiresAt: ACTIVE_PAYLOAD.issuedAt }), 'expired'],
      [signedEnvelope({ membershipStatus: 'revoked', membershipExpiresAt: ACTIVE_PAYLOAD.issuedAt }), 'expired'],
      [signedEnvelope({ membershipExpiresAt: '2026-08-26T02:00:00.000Z' }), 'expired'],
    ] as const) {
      const state = verifier(now).verify('alice', envelope)
      expect(state.tier).toBe('member')
      expect(state.status).toBe(expectedStatus)
      expect(state.knowledgeToolEnabled).toBe(false)
      expect(state.cloudEnabled).toBe(false)
    }
  })

  it('does not let a stale signed kill snapshot preserve member local access', () => {
    const killed = signedEnvelope({ killSwitchEnabled: true })

    expect(verifier('2026-08-26T01:00:00.000Z').verify('alice', killed)).toMatchObject({
      status: 'active',
      killSwitchEnabled: true,
      knowledgeToolEnabled: false,
    })
    expect(() => verifier('2026-08-26T01:00:00.001Z').verify('alice', killed))
      .toThrow('snapshot_expired')
  })

  it('fails closed for future-issued snapshots beyond skew and accepts the exact skew boundary', () => {
    const future = signedEnvelope({ issuedAt: '2026-08-26T00:05:00.000Z' })
    expect(verifier('2026-08-26T00:00:00.000Z').verify('alice', future).status).toBe('active')
    expect(() => verifier('2026-08-25T23:59:59.999Z').verify('alice', future))
      .toThrow('issued_in_future')
  })

  it('rejects surrounding user whitespace and a non-canonical base64url signature encoding', () => {
    const whitespace = signedEnvelope({ userId: ' alice ' })
    expect(() => verifier('2026-08-26T00:30:00.000Z').verify('alice', whitespace))
      .toThrow('invalid_envelope')

    const nonCanonicalSignature = `${ACTIVE_SIGNATURE.slice(0, -1)}x`
    expect(Buffer.from(nonCanonicalSignature, 'base64url')).toEqual(Buffer.from(ACTIVE_SIGNATURE, 'base64url'))
    expect(() => verifier('2026-08-26T00:30:00.000Z').verify('alice', {
      ...ACTIVE_ENVELOPE,
      signature: nonCanonicalSignature,
    })).toThrow('invalid_envelope')
  })

  it('requires active membership to end after issuance and terminal membership to end no later than issuance', () => {
    expect(() => verifier('2026-08-26T00:30:00.000Z').verify('alice', signedEnvelope({
      membershipStatus: 'active',
      membershipExpiresAt: ACTIVE_PAYLOAD.issuedAt,
    }))).toThrow('invalid_time_order')
    expect(() => verifier('2026-08-26T00:30:00.000Z').verify('alice', signedEnvelope({
      membershipStatus: 'expired',
      membershipExpiresAt: '2026-08-27T00:00:00.000Z',
    }))).toThrow('invalid_time_order')
  })

  it('anchors early revocation windows to its signed terminal timestamp', () => {
    const revoked = signedEnvelope({
      issuedAt: '2026-08-26T00:00:00.000Z',
      snapshotExpiresAt: '2026-08-27T00:00:00.000Z',
      membershipExpiresAt: '2026-08-25T12:00:00.000Z',
      membershipStatus: 'revoked',
    })
    expect(verifier('2026-09-24T11:59:59.999Z').verify('alice', revoked).lifecycle!.phase)
      .toBe('download_window')
    expect(verifier('2026-09-24T12:00:00.000Z').verify('alice', revoked).lifecycle!.phase)
      .toBe('recycle_window')
  })

  it.each([
    ['2026-09-24T23:59:59.999Z', 'download_window'],
    ['2026-09-25T00:00:00.000Z', 'recycle_window'],
    ['2026-10-24T23:59:59.999Z', 'recycle_window'],
    ['2026-10-25T00:00:00.000Z', 'purge_eligible'],
  ] as const)('uses exact 30-day download and recycle boundaries at %s', (now, phase) => {
    const expired = signedEnvelope({
      snapshotExpiresAt: '2026-08-26T00:00:00.000Z',
      membershipExpiresAt: '2026-08-26T00:00:00.000Z',
      membershipStatus: 'expired',
    })
    expect(verifier(now).verify('alice', expired).lifecycle!.phase).toBe(phase)
  })

  it('ships with no production trusted key until deployment supplies an approved public key', () => {
    expect(PRODUCTION_KNOWLEDGE_ENTITLEMENT_TRUSTED_KEYS).toEqual({})
    expect(Object.isFrozen(PRODUCTION_KNOWLEDGE_ENTITLEMENT_TRUSTED_KEYS)).toBe(true)
  })

  it('exposes only verify on the exported verifier surface', () => {
    const instance = verifier('2026-08-26T00:30:00.000Z')
    const typedSurface: Record<keyof KnowledgeEntitlementVerifier, true> = { verify: true }
    expect(Object.getOwnPropertyNames(KnowledgeEntitlementVerifier.prototype).sort()).toEqual([
      'constructor', 'verify',
    ])
    expect(typedSurface).toEqual({ verify: true })
    expect((instance as unknown as { authenticate?: unknown }).authenticate).toBeUndefined()
    expect((instance as unknown as { evaluate?: unknown }).evaluate).toBeUndefined()
  })
})

describe('KnowledgeEntitlementAuthority', () => {
  function cache(): KnowledgeEntitlementEnvelopeCache & { values: Map<string, KnowledgeEntitlementCacheRecord> } {
    const values = new Map<string, KnowledgeEntitlementCacheRecord>()
    return {
      values,
      read: async userId => values.get(userId),
      write: async (userId, record) => { values.set(userId, record) },
    }
  }

  it('caches only a verified envelope per user and verifies it again for offline/restart use', async () => {
    const stored = cache()
    const fetchEnvelope = vi.fn().mockResolvedValueOnce(ACTIVE_ENVELOPE).mockRejectedValueOnce(new Error('offline'))
    let now = Date.parse('2026-08-26T00:30:00.000Z')
    const authority = new KnowledgeEntitlementAuthority({
      trustedKeys: { 'test-key-1': PUBLIC_KEY }, cache: stored, fetchEnvelope, now: () => now,
    })
    await expect(authority.getEntitlement({ userId: 'alice' })).resolves.toMatchObject({ status: 'active' })
    expect(stored.values.get('alice')).toEqual({
      envelope: ACTIVE_ENVELOPE,
      maxIssuedAt: '2026-08-26T00:00:00.000Z',
      maxObservedAt: '2026-08-26T00:30:00.000Z',
    })

    now = Date.parse('2026-08-26T02:00:00.000Z')
    await expect(authority.getEntitlement({ userId: 'alice' })).resolves.toMatchObject({ status: 'offline_grace' })
    stored.values.set('alice', {
      envelope: { ...ACTIVE_ENVELOPE, payload: { ...ACTIVE_PAYLOAD, userId: 'bob' } },
      maxIssuedAt: '2026-08-26T00:00:00.000Z', maxObservedAt: '2026-08-26T00:30:00.000Z',
    })
    await expect(authority.getEntitlement({ userId: 'alice' })).resolves.toEqual({
      tier: 'free', status: 'active', betaEnabled: false, cloudEnabled: false,
      knowledgeToolEnabled: false, killSwitchEnabled: true,
    })
  })

  it('never starts offline grace from a stale envelope that was not previously verified active', async () => {
    const authority = new KnowledgeEntitlementAuthority({
      trustedKeys: { 'test-key-1': PUBLIC_KEY }, cache: cache(),
      fetchEnvelope: async () => ACTIVE_ENVELOPE,
      now: () => Date.parse('2026-08-26T02:00:00.000Z'),
    })

    await expect(authority.getEntitlement({ userId: 'alice' })).resolves.toEqual({
      tier: 'free', status: 'active', betaEnabled: false, cloudEnabled: false,
      knowledgeToolEnabled: false, killSwitchEnabled: true,
    })
  })

  it.each([
    ['revoked', signedEnvelope({
      membershipStatus: 'revoked',
      membershipExpiresAt: ACTIVE_PAYLOAD.issuedAt,
    })],
    ['kill switch', signedEnvelope({ killSwitchEnabled: true })],
    ['free tier', signedEnvelope({
      tier: 'free',
      entitlements: [],
      membershipStatus: 'active',
      membershipExpiresAt: ACTIVE_PAYLOAD.issuedAt,
    })],
    ['different membership horizon', signedEnvelope({
      membershipExpiresAt: '2026-10-26T00:00:00.000Z',
    })],
  ] as const)('sticks fail closed after same-issued signed %s equivocation', async (_label, equivocated) => {
    const owner = { userId: 'alice' }
    const stored = cache()
    stored.values.set(owner.userId, {
      envelope: ACTIVE_ENVELOPE,
      maxIssuedAt: ACTIVE_PAYLOAD.issuedAt,
      maxObservedAt: '2026-08-26T00:00:00.000Z',
    })
    const write = vi.spyOn(stored, 'write')
    let fetched = ACTIVE_ENVELOPE
    let fetches = 0
    const authority = new KnowledgeEntitlementAuthority({
      trustedKeys: { 'test-key-1': PUBLIC_KEY }, cache: stored,
      fetchEnvelope: async () => { fetches += 1; return fetched },
      now: () => Date.parse('2026-08-26T00:30:00.000Z'),
    })
    const active = await authority.getAuthorizationSnapshot(owner)

    fetched = equivocated
    const failed = await authority.getAuthorizationSnapshot(owner)
    expect(failed.entitlement).toEqual({
      tier: 'free', status: 'active', betaEnabled: false, cloudEnabled: false,
      knowledgeToolEnabled: false, killSwitchEnabled: true,
    })
    expect(failed.revision).toBeGreaterThan(active.revision)
    expect(authority.isAuthorizationSnapshotCurrentNow(owner, active)).toBe(false)

    fetched = ACTIVE_ENVELOPE
    await expect(authority.getEntitlement(owner)).resolves.toEqual(failed.entitlement)
    fetched = signedEnvelope({
      issuedAt: '2026-08-26T00:10:00.000Z',
      snapshotExpiresAt: '2026-08-26T01:10:00.000Z',
    })
    await expect(authority.getEntitlement(owner)).resolves.toEqual(failed.entitlement)
    fetched = signedEnvelope({ issuedAt: '2026-08-25T23:59:59.000Z' })
    await expect(authority.getEntitlement(owner)).resolves.toEqual(failed.entitlement)
    expect(fetches).toBe(2)
    expect(write).toHaveBeenCalledTimes(1)
    expect(stored.values.get(owner.userId)?.envelope).toEqual(ACTIVE_ENVELOPE)
  })

  it.each([
    ['kill snapshot one millisecond stale', '2026-08-26T01:00:00.001Z', signedEnvelope({
      killSwitchEnabled: true,
    })],
    ['free snapshot beyond its grace while cached member remains in grace', '2026-08-29T00:00:00.001Z', signedEnvelope({
      tier: 'free',
      entitlements: [],
      snapshotExpiresAt: ACTIVE_PAYLOAD.issuedAt,
      membershipExpiresAt: ACTIVE_PAYLOAD.issuedAt,
      membershipStatus: 'active',
    })],
  ] as const)('authenticates same-issued signed %s before current-time denial', async (_label, deniedAt, equivocated) => {
    const owner = { userId: 'alice' }
    const stored = cache()
    let now = Date.parse('2026-08-26T00:30:00.000Z')
    let fetched = ACTIVE_ENVELOPE
    let fetches = 0
    const write = vi.spyOn(stored, 'write')
    const authority = new KnowledgeEntitlementAuthority({
      trustedKeys: { 'test-key-1': PUBLIC_KEY }, cache: stored,
      fetchEnvelope: async () => { fetches += 1; return fetched },
      now: () => now,
    })
    const active = await authority.getAuthorizationSnapshot(owner)

    now = Date.parse(deniedAt)
    fetched = equivocated
    const failed = await authority.getAuthorizationSnapshot(owner)
    expect(failed.entitlement).toEqual({
      tier: 'free', status: 'active', betaEnabled: false, cloudEnabled: false,
      knowledgeToolEnabled: false, killSwitchEnabled: true,
    })
    expect(failed.revision).toBeGreaterThan(active.revision)
    expect(authority.isAuthorizationSnapshotCurrentNow(owner, active)).toBe(false)

    fetched = ACTIVE_ENVELOPE
    await expect(authority.getEntitlement(owner)).resolves.toEqual(failed.entitlement)
    fetched = signedEnvelope({ issuedAt: '2026-08-25T23:59:59.000Z' })
    await expect(authority.getEntitlement(owner)).resolves.toEqual(failed.entitlement)
    fetched = signedEnvelope({
      issuedAt: '2026-08-26T00:10:00.000Z',
      snapshotExpiresAt: '2026-08-29T01:10:00.000Z',
    })
    await expect(authority.getEntitlement(owner)).resolves.toEqual(failed.entitlement)
    expect(fetches).toBe(2)
    expect(write).toHaveBeenCalledTimes(1)
    expect(stored.values.get(owner.userId)?.envelope).toEqual(ACTIVE_ENVELOPE)
  })

  it('does not poison an owner for invalid-signature same-issued input after the snapshot boundary', async () => {
    const owner = { userId: 'alice' }
    const stored = cache()
    let now = Date.parse('2026-08-26T00:30:00.000Z')
    let fetched = ACTIVE_ENVELOPE
    const authority = new KnowledgeEntitlementAuthority({
      trustedKeys: { 'test-key-1': PUBLIC_KEY }, cache: stored,
      fetchEnvelope: async () => fetched,
      now: () => now,
    })
    const active = await authority.getAuthorizationSnapshot(owner)

    now = Date.parse('2026-08-26T01:00:00.001Z')
    fetched = { ...signedEnvelope({ killSwitchEnabled: true }), signature: ACTIVE_SIGNATURE }
    const ignored = await authority.getAuthorizationSnapshot(owner)
    expect(ignored.revision).toBeGreaterThan(active.revision)
    expect(ignored.entitlement).toMatchObject({
      tier: 'member', status: 'offline_grace', killSwitchEnabled: false,
    })

    fetched = ACTIVE_ENVELOPE
    const replayed = await authority.getAuthorizationSnapshot(owner)
    expect(replayed).toEqual(ignored)
  })

  it.each([
    ['stale kill', ACTIVE_ENVELOPE, '2026-08-26T01:10:00.001Z', signedEnvelope({
      issuedAt: '2026-08-26T00:10:00.000Z',
      snapshotExpiresAt: '2026-08-26T01:10:00.000Z',
      killSwitchEnabled: true,
    })],
    ['future-issued active', ACTIVE_ENVELOPE, '2026-08-26T00:30:00.000Z', signedEnvelope({
      issuedAt: '2026-08-26T00:40:00.000Z',
      snapshotExpiresAt: '2026-08-26T01:40:00.000Z',
    })],
    ['grace-expired active', signedEnvelope({
      snapshotExpiresAt: '2026-08-30T00:00:00.000Z',
    }), '2026-08-29T00:10:00.001Z', signedEnvelope({
      issuedAt: '2026-08-26T00:10:00.000Z',
      snapshotExpiresAt: '2026-08-26T00:10:00.000Z',
    })],
  ] as const)('sticks fail closed instead of falling back for newer authenticated %s denial', async (
    _label,
    cachedEnvelope,
    deniedAt,
    denied,
  ) => {
    const owner = { userId: 'alice' }
    const stored = cache()
    let now = Date.parse('2026-08-26T00:20:00.000Z')
    let fetched = cachedEnvelope
    let fetches = 0
    const write = vi.spyOn(stored, 'write')
    const authority = new KnowledgeEntitlementAuthority({
      trustedKeys: { 'test-key-1': PUBLIC_KEY }, cache: stored,
      fetchEnvelope: async () => { fetches += 1; return fetched },
      now: () => now,
    })
    const active = await authority.getAuthorizationSnapshot(owner)

    now = Date.parse(deniedAt)
    fetched = denied
    const failed = await authority.getAuthorizationSnapshot(owner)
    expect(failed.entitlement).toEqual({
      tier: 'free', status: 'active', betaEnabled: false, cloudEnabled: false,
      knowledgeToolEnabled: false, killSwitchEnabled: true,
    })
    expect(failed.revision).toBeGreaterThan(active.revision)
    expect(authority.isAuthorizationSnapshotCurrentNow(owner, active)).toBe(false)

    fetched = ACTIVE_ENVELOPE
    await expect(authority.getEntitlement(owner)).resolves.toEqual(failed.entitlement)
    fetched = signedEnvelope({ issuedAt: '2026-08-25T23:59:59.000Z' })
    await expect(authority.getEntitlement(owner)).resolves.toEqual(failed.entitlement)
    fetched = signedEnvelope({
      issuedAt: '2026-08-26T00:50:00.000Z',
      snapshotExpiresAt: '2026-08-30T00:50:00.000Z',
    })
    await expect(authority.getEntitlement(owner)).resolves.toEqual(failed.entitlement)
    expect(fetches).toBe(2)
    expect(write).toHaveBeenCalledTimes(1)
    expect(stored.values.get(owner.userId)?.envelope).toEqual(cachedEnvelope)
  })

  it('keeps normal cache fallback for an invalid-signature newer envelope', async () => {
    const owner = { userId: 'alice' }
    const stored = cache()
    let now = Date.parse('2026-08-26T00:20:00.000Z')
    let fetched = ACTIVE_ENVELOPE
    const authority = new KnowledgeEntitlementAuthority({
      trustedKeys: { 'test-key-1': PUBLIC_KEY }, cache: stored,
      fetchEnvelope: async () => fetched,
      now: () => now,
    })
    await authority.getAuthorizationSnapshot(owner)

    now = Date.parse('2026-08-26T01:10:00.001Z')
    fetched = {
      ...signedEnvelope({
        issuedAt: '2026-08-26T00:10:00.000Z',
        snapshotExpiresAt: '2026-08-26T01:10:00.000Z',
        killSwitchEnabled: true,
      }),
      signature: ACTIVE_SIGNATURE,
    }
    const ignored = await authority.getAuthorizationSnapshot(owner)
    expect(ignored.entitlement).toMatchObject({
      tier: 'member', status: 'offline_grace', killSwitchEnabled: false,
    })

    fetched = ACTIVE_ENVELOPE
    await expect(authority.getAuthorizationSnapshot(owner)).resolves.toEqual(ignored)
  })

  it('authenticates an identical temporally expired signed replay without treating it as equivocation', async () => {
    const owner = { userId: 'alice' }
    const stored = cache()
    let now = Date.parse('2026-08-26T00:30:00.000Z')
    const killed = signedEnvelope({ killSwitchEnabled: true })
    let fetches = 0
    const write = vi.spyOn(stored, 'write')
    const authority = new KnowledgeEntitlementAuthority({
      trustedKeys: { 'test-key-1': PUBLIC_KEY }, cache: stored,
      fetchEnvelope: async () => { fetches += 1; return killed },
      now: () => now,
    })
    await expect(authority.getEntitlement(owner)).resolves.toMatchObject({
      tier: 'member', status: 'active', killSwitchEnabled: true,
    })

    now = Date.parse('2026-08-26T01:00:00.001Z')
    await expect(authority.getEntitlement(owner)).resolves.toEqual({
      tier: 'free', status: 'active', betaEnabled: false, cloudEnabled: false,
      knowledgeToolEnabled: false, killSwitchEnabled: true,
    })
    expect(fetches).toBe(2)
    expect(write).toHaveBeenCalledTimes(1)
    expect(stored.values.get(owner.userId)?.envelope).toEqual(killed)
  })

  it('keeps an identical same-issued signed replay idempotent', async () => {
    const owner = { userId: 'alice' }
    const stored = cache()
    stored.values.set(owner.userId, {
      envelope: ACTIVE_ENVELOPE,
      maxIssuedAt: ACTIVE_PAYLOAD.issuedAt,
      maxObservedAt: '2026-08-26T00:00:00.000Z',
    })
    const authority = new KnowledgeEntitlementAuthority({
      trustedKeys: { 'test-key-1': PUBLIC_KEY }, cache: stored,
      fetchEnvelope: async () => ACTIVE_ENVELOPE,
      now: () => Date.parse('2026-08-26T00:30:00.000Z'),
    })

    const first = await authority.getAuthorizationSnapshot(owner)
    const second = await authority.getAuthorizationSnapshot(owner)
    expect(second).toEqual(first)
    expect(second.entitlement).toMatchObject({ tier: 'member', status: 'active' })
  })

  it('isolates same-issued equivocation failure to its owner', async () => {
    const stored = cache()
    stored.values.set('alice', {
      envelope: ACTIVE_ENVELOPE,
      maxIssuedAt: ACTIVE_PAYLOAD.issuedAt,
      maxObservedAt: '2026-08-26T00:00:00.000Z',
    })
    const bobEnvelope = signedEnvelope({ userId: 'bob' })
    let aliceFetch = ACTIVE_ENVELOPE
    const authority = new KnowledgeEntitlementAuthority({
      trustedKeys: { 'test-key-1': PUBLIC_KEY }, cache: stored,
      fetchEnvelope: owner => Promise.resolve(owner.userId === 'alice' ? aliceFetch : bobEnvelope),
      now: () => Date.parse('2026-08-26T00:30:00.000Z'),
    })
    await expect(authority.getEntitlement({ userId: 'alice' })).resolves.toMatchObject({ tier: 'member' })

    aliceFetch = signedEnvelope({ killSwitchEnabled: true })
    await expect(authority.getEntitlement({ userId: 'alice' })).resolves.toEqual({
      tier: 'free', status: 'active', betaEnabled: false, cloudEnabled: false,
      knowledgeToolEnabled: false, killSwitchEnabled: true,
    })
    await expect(authority.getEntitlement({ userId: 'bob' })).resolves.toMatchObject({
      tier: 'member', status: 'active', killSwitchEnabled: false,
    })
  })

  it('does not replace a cached active envelope with tampered, older-key-rotation, or rollback input', async () => {
    const stored = cache()
    stored.values.set('alice', {
      envelope: ACTIVE_ENVELOPE,
      maxIssuedAt: '2026-08-26T00:00:00.000Z', maxObservedAt: '2026-08-26T00:00:00.000Z',
    })
    let now = Date.parse('2026-08-26T00:30:00.000Z')
    const older = signedEnvelope({ issuedAt: '2026-08-25T23:59:59.000Z' })
    const authority = new KnowledgeEntitlementAuthority({
      trustedKeys: { 'test-key-1': PUBLIC_KEY }, cache: stored,
      fetchEnvelope: async () => older, now: () => now,
    })
    await expect(authority.getEntitlement({ userId: 'alice' })).resolves.toMatchObject({ status: 'active' })
    expect(stored.values.get('alice')?.envelope).toEqual(ACTIVE_ENVELOPE)

    now -= 1
    await expect(authority.getEntitlement({ userId: 'alice' })).resolves.toMatchObject({
      knowledgeToolEnabled: false, killSwitchEnabled: true,
    })
    now += 2
    await expect(authority.getEntitlement({ userId: 'alice' })).resolves.toMatchObject({
      knowledgeToolEnabled: false, killSwitchEnabled: true,
    })
  })

  it('serializes refresh and commit per user so a slow older grant cannot overwrite a newer kill switch', async () => {
    const stored = cache()
    let releaseOlder!: (value: KnowledgeEntitlementEnvelope) => void
    const older = new Promise<KnowledgeEntitlementEnvelope>(resolve => { releaseOlder = resolve })
    const kill = signedEnvelope({
      issuedAt: '2026-08-26T00:10:00.000Z',
      snapshotExpiresAt: '2026-08-27T00:10:00.000Z',
      killSwitchEnabled: true,
    })
    let calls = 0
    const authority = new KnowledgeEntitlementAuthority({
      trustedKeys: { 'test-key-1': PUBLIC_KEY }, cache: stored,
      fetchEnvelope: async () => (++calls === 1 ? older : kill),
      now: () => Date.parse('2026-08-26T00:30:00.000Z'),
    })

    const slowGrant = authority.getEntitlement({ userId: 'alice' })
    await vi.waitFor(() => expect(calls).toBe(1))
    const revoke = authority.getEntitlement({ userId: 'alice' })
    await new Promise(resolve => setImmediate(resolve))
    releaseOlder(ACTIVE_ENVELOPE)

    await expect(slowGrant).resolves.toMatchObject({ killSwitchEnabled: false })
    await expect(revoke).resolves.toMatchObject({ killSwitchEnabled: true })
    expect(stored.values.get('alice')?.envelope).toEqual(kill)
  })

  it('does not let one owner refresh block another owner', async () => {
    const stored = cache()
    let releaseAlice!: (value: KnowledgeEntitlementEnvelope) => void
    const alice = new Promise<KnowledgeEntitlementEnvelope>(resolve => { releaseAlice = resolve })
    const bobEnvelope = signedEnvelope({ userId: 'bob' })
    const authority = new KnowledgeEntitlementAuthority({
      trustedKeys: { 'test-key-1': PUBLIC_KEY }, cache: stored,
      fetchEnvelope: owner => owner.userId === 'alice' ? alice : Promise.resolve(bobEnvelope),
      now: () => Date.parse('2026-08-26T00:30:00.000Z'),
    })

    const pendingAlice = authority.getEntitlement({ userId: 'alice' })
    await expect(authority.getEntitlement({ userId: 'bob' })).resolves.toMatchObject({ tier: 'member' })
    releaseAlice(ACTIVE_ENVELOPE)
    await expect(pendingAlice).resolves.toMatchObject({ tier: 'member' })
  })

  it('keeps an owner fail-closed after a newer kill switch cannot be committed', async () => {
    const stored = cache()
    stored.values.set('alice', {
      envelope: ACTIVE_ENVELOPE,
      maxIssuedAt: ACTIVE_PAYLOAD.issuedAt,
      maxObservedAt: '2026-08-26T00:00:00.000Z',
    })
    const kill = signedEnvelope({
      issuedAt: '2026-08-26T00:10:00.000Z',
      snapshotExpiresAt: '2026-08-27T00:10:00.000Z',
      killSwitchEnabled: true,
    })
    let writes = 0
    stored.write = async (userId, record) => {
      writes += 1
      if (writes === 1) throw new Error('disk unavailable')
      stored.values.set(userId, record)
    }
    const fetchEnvelope = vi.fn().mockResolvedValueOnce(kill).mockResolvedValue(ACTIVE_ENVELOPE)
    const authority = new KnowledgeEntitlementAuthority({
      trustedKeys: { 'test-key-1': PUBLIC_KEY }, cache: stored, fetchEnvelope,
      now: () => Date.parse('2026-08-26T00:30:00.000Z'),
    })

    await expect(authority.getEntitlement({ userId: 'alice' })).resolves.toMatchObject({
      knowledgeToolEnabled: false, killSwitchEnabled: true,
    })
    await expect(authority.getEntitlement({ userId: 'alice' })).resolves.toMatchObject({
      knowledgeToolEnabled: false, killSwitchEnabled: true,
    })
    expect(fetchEnvelope).toHaveBeenCalledTimes(1)
  })

  it('exposes a monotonic per-owner authorization token that invalidates an older grant', async () => {
    const stored = cache()
    let current = ACTIVE_ENVELOPE
    const authority = new KnowledgeEntitlementAuthority({
      trustedKeys: { 'test-key-1': PUBLIC_KEY }, cache: stored,
      fetchEnvelope: async () => current,
      now: () => Date.parse('2026-08-26T00:30:00.000Z'),
    }) as unknown as KnowledgeEntitlementAuthority & {
      getAuthorizationSnapshot(owner: { userId: string }): Promise<{
        entitlement: KnowledgeEntitlementState
        revision: number
      }>
      isAuthorizationSnapshotCurrent(owner: { userId: string }, snapshot: {
        entitlement: KnowledgeEntitlementState
        revision: number
      }): Promise<boolean>
    }

    expect(typeof authority.getAuthorizationSnapshot).toBe('function')
    const active = await authority.getAuthorizationSnapshot({ userId: 'alice' })
    current = signedEnvelope({
      issuedAt: '2026-08-26T00:10:00.000Z',
      snapshotExpiresAt: '2026-08-27T00:10:00.000Z',
      killSwitchEnabled: true,
    })
    await expect(authority.isAuthorizationSnapshotCurrent({ userId: 'alice' }, active))
      .resolves.toBe(false)
    const killed = await authority.getAuthorizationSnapshot({ userId: 'alice' })
    expect(killed.revision).toBeGreaterThan(active.revision)
    expect(killed.entitlement).toMatchObject({ killSwitchEnabled: true, knowledgeToolEnabled: false })
  })
})

describe('SafeStorageKnowledgeEntitlementCache', () => {
  it('commits independent Main enrollment before the first encrypted record so a failed first write cannot re-bootstrap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'autoforge-entitlement-cache-order-'))
    directories.push(directory)
    const storage: SafeStoragePort = {
      isAvailable: async () => true,
      encrypt: async () => { throw new Error('injected encryption failure') },
      decrypt: async () => { throw new Error('not reached') },
    }
    const enrollment = enrollmentStore()
    const cache = safeStorageCache(directory, storage, enrollment)
    await expect(cache.write('alice', {
      envelope: ACTIVE_ENVELOPE,
      maxIssuedAt: ACTIVE_PAYLOAD.issuedAt,
      maxObservedAt: '2026-08-26T00:30:00.000Z',
    })).rejects.toThrow('injected encryption failure')
    expect(enrollment.enrolled).toHaveLength(1)
    expect([...enrollment.enrolled][0]).not.toContain('alice')
    expect(enrollment.watermarks).toHaveLength(1)
    const watermark = [...enrollment.watermarks.values()][0]
    expect(watermark).toMatchObject({
      version: 1,
      maxIssuedAt: ACTIVE_PAYLOAD.issuedAt,
      maxObservedAt: '2026-08-26T00:30:00.000Z',
      acceptedEnvelopeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(JSON.stringify(watermark)).not.toContain('alice')
    expect(JSON.stringify(watermark)).not.toContain(ACTIVE_PAYLOAD.membershipExpiresAt)
    expect(await readdir(directory)).toEqual([])

    const restarted = new KnowledgeEntitlementAuthority({
      trustedKeys: { 'test-key-1': PUBLIC_KEY }, cache,
      fetchEnvelope: async () => ACTIVE_ENVELOPE,
      now: () => Date.parse('2026-08-26T00:31:00.000Z'),
    })
    await expect(restarted.getEntitlement({ userId: 'alice' })).resolves.toMatchObject({
      knowledgeToolEnabled: false, killSwitchEnabled: true,
    })
  })

  it('persists one encrypted owner-scoped record and reloads it with independent owner enrollment', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'autoforge-entitlement-cache-'))
    directories.push(directory)
    const storage: SafeStoragePort = {
      isAvailable: async () => true,
      encrypt: async value => Buffer.from(`wrapped:${value}`),
      decrypt: async value => ({ value: value.toString().slice('wrapped:'.length), shouldReEncrypt: false }),
    }
    const record: KnowledgeEntitlementCacheRecord = {
      envelope: ACTIVE_ENVELOPE,
      maxIssuedAt: ACTIVE_PAYLOAD.issuedAt,
      maxObservedAt: '2026-08-26T00:30:00.000Z',
    }
    const enrollment = enrollmentStore()
    const first = safeStorageCache(directory, storage, enrollment)
    await first.write('alice', record)
    const files = await readdir(directory)
    expect(files).toHaveLength(1)
    expect(files.some(file => file.endsWith('.enrolled'))).toBe(false)
    const recordFile = files.find(file => file.endsWith('.json'))!
    const disk = await readFile(join(directory, recordFile), 'utf8')
    expect(disk).not.toContain('alice')
    expect(disk).not.toContain(ACTIVE_PAYLOAD.membershipExpiresAt)

    const restarted = safeStorageCache(directory, storage, enrollment)
    await expect(restarted.read('alice')).resolves.toEqual(record)
    await expect(restarted.read('bob')).resolves.toBeUndefined()
    expect(enrollment.watermarks).toHaveLength(1)
  })

  it.each(['deleted', 'corrupt'] as const)(
    'fails closed after an enrolled owner cache is %s and does not accept a replayed old grant',
    async damage => {
      const directory = await mkdtemp(join(tmpdir(), 'autoforge-entitlement-cache-damage-'))
      directories.push(directory)
      const storage: SafeStoragePort = {
        isAvailable: async () => true,
        encrypt: async value => Buffer.from(`wrapped:${value}`),
        decrypt: async value => ({ value: value.toString().slice('wrapped:'.length), shouldReEncrypt: false }),
      }
      const enrollment = enrollmentStore()
      const cache = safeStorageCache(directory, storage, enrollment)
      await cache.write('alice', {
        envelope: ACTIVE_ENVELOPE,
        maxIssuedAt: ACTIVE_PAYLOAD.issuedAt,
        maxObservedAt: '2026-08-26T00:30:00.000Z',
      })
      const recordFile = (await readdir(directory)).find(file => file.endsWith('.json'))!
      if (damage === 'deleted') await unlink(join(directory, recordFile))
      else await writeFile(join(directory, recordFile), '{not-json')

      const restarted = new KnowledgeEntitlementAuthority({
        trustedKeys: { 'test-key-1': PUBLIC_KEY }, cache,
        fetchEnvelope: async () => ACTIVE_ENVELOPE,
        now: () => Date.parse('2026-08-26T00:31:00.000Z'),
      })
      await expect(restarted.getEntitlement({ userId: 'alice' })).resolves.toEqual({
        tier: 'free', status: 'active', betaEnabled: false, cloudEnabled: false,
        knowledgeToolEnabled: false, killSwitchEnabled: true,
      })
    },
  )

  it('isolates enrollment watermarks so a new owner can bootstrap when another owner cache is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'autoforge-entitlement-cache-owners-'))
    directories.push(directory)
    const storage: SafeStoragePort = {
      isAvailable: async () => true,
      encrypt: async value => Buffer.from(`wrapped:${value}`),
      decrypt: async value => ({ value: value.toString().slice('wrapped:'.length), shouldReEncrypt: false }),
    }
    const enrollment = enrollmentStore()
    const cache = safeStorageCache(directory, storage, enrollment)
    await cache.write('alice', {
      envelope: ACTIVE_ENVELOPE,
      maxIssuedAt: ACTIVE_PAYLOAD.issuedAt,
      maxObservedAt: '2026-08-26T00:30:00.000Z',
    })
    const recordFile = (await readdir(directory)).find(file => file.endsWith('.json'))!
    await unlink(join(directory, recordFile))
    const bobEnvelope = signedEnvelope({ userId: 'bob' })
    const authority = new KnowledgeEntitlementAuthority({
      trustedKeys: { 'test-key-1': PUBLIC_KEY }, cache,
      fetchEnvelope: owner => Promise.resolve(owner.userId === 'bob' ? bobEnvelope : ACTIVE_ENVELOPE),
      now: () => Date.parse('2026-08-26T00:31:00.000Z'),
    })

    await expect(authority.getEntitlement({ userId: 'alice' })).resolves.toMatchObject({
      knowledgeToolEnabled: false, killSwitchEnabled: true,
    })
    await expect(authority.getEntitlement({ userId: 'bob' })).resolves.toMatchObject({
      tier: 'member', killSwitchEnabled: false,
    })
    expect(enrollment.enrolled).toHaveLength(2)
  })

  it('denies replay after both legacy cache-directory files are deleted while independent enrollment remains', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'autoforge-entitlement-cache-independent-'))
    directories.push(directory)
    const storage: SafeStoragePort = {
      isAvailable: async () => true,
      encrypt: async value => Buffer.from(`wrapped:${value}`),
      decrypt: async value => ({ value: value.toString().slice('wrapped:'.length), shouldReEncrypt: false }),
    }
    const enrollment = enrollmentStore()
    const cache = safeStorageCache(directory, storage, enrollment)
    await cache.write('alice', {
      envelope: ACTIVE_ENVELOPE,
      maxIssuedAt: ACTIVE_PAYLOAD.issuedAt,
      maxObservedAt: '2026-08-26T00:30:00.000Z',
    })
    await writeFile(join(directory, 'legacy.enrolled'), '{"version":1}')
    await Promise.all((await readdir(directory)).map(file => unlink(join(directory, file))))
    expect(enrollment.enrolled).toHaveLength(1)

    const restarted = new KnowledgeEntitlementAuthority({
      trustedKeys: { 'test-key-1': PUBLIC_KEY },
      cache: safeStorageCache(directory, storage, enrollment),
      fetchEnvelope: async () => ACTIVE_ENVELOPE,
      now: () => Date.parse('2026-08-26T00:31:00.000Z'),
    })
    await expect(restarted.getEntitlement({ userId: 'alice' })).resolves.toMatchObject({
      knowledgeToolEnabled: false, killSwitchEnabled: true,
    })
  })

  it('restores a missing independent marker only from a valid record without resetting max history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'autoforge-entitlement-cache-marker-restore-'))
    directories.push(directory)
    const storage: SafeStoragePort = {
      isAvailable: async () => true,
      encrypt: async value => Buffer.from(`wrapped:${value}`),
      decrypt: async value => ({ value: value.toString().slice('wrapped:'.length), shouldReEncrypt: false }),
    }
    const enrollment = enrollmentStore()
    const cache = safeStorageCache(directory, storage, enrollment)
    const newer = signedEnvelope({
      issuedAt: '2026-08-26T00:10:00.000Z',
      snapshotExpiresAt: '2026-08-27T00:10:00.000Z',
    })
    await cache.write('alice', {
      envelope: newer,
      maxIssuedAt: newer.payload.issuedAt,
      maxObservedAt: '2026-08-26T00:30:00.000Z',
    })
    enrollment.enrolled.clear()
    enrollment.watermarks.clear()

    await expect(cache.read('alice')).resolves.toMatchObject({ maxIssuedAt: newer.payload.issuedAt })
    expect(enrollment.enrolled).toHaveLength(1)
    expect([...enrollment.watermarks.values()][0]).toMatchObject({
      maxIssuedAt: newer.payload.issuedAt,
      maxObservedAt: '2026-08-26T00:30:00.000Z',
    })
  })

  it('rejects a whole old valid ciphertext restored after a newer kill-switch watermark committed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'autoforge-entitlement-cache-replay-'))
    directories.push(directory)
    const storage: SafeStoragePort = {
      isAvailable: async () => true,
      encrypt: async value => Buffer.from(`wrapped:${value}`),
      decrypt: async value => ({ value: value.toString().slice('wrapped:'.length), shouldReEncrypt: false }),
    }
    const enrollment = enrollmentStore()
    const cache = safeStorageCache(directory, storage, enrollment)
    await cache.write('alice', {
      envelope: ACTIVE_ENVELOPE,
      maxIssuedAt: ACTIVE_PAYLOAD.issuedAt,
      maxObservedAt: '2026-08-26T00:30:00.000Z',
    })
    const recordPath = join(directory, (await readdir(directory)).find(file => file.endsWith('.json'))!)
    const oldCiphertext = await readFile(recordPath)
    const killed = signedEnvelope({
      issuedAt: '2026-08-26T00:10:00.000Z',
      snapshotExpiresAt: '2026-08-27T00:10:00.000Z',
      killSwitchEnabled: true,
    })
    await cache.write('alice', {
      envelope: killed,
      maxIssuedAt: killed.payload.issuedAt,
      maxObservedAt: '2026-08-26T00:40:00.000Z',
    })
    await writeFile(recordPath, oldCiphertext)

    await expect(safeStorageCache(directory, storage, enrollment).read('alice'))
      .rejects.toThrow(/rollback|watermark/i)
  })

  it('rejects same-issued envelope equivocation before replacing the independent watermark', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'autoforge-entitlement-cache-equivocation-'))
    directories.push(directory)
    const storage: SafeStoragePort = {
      isAvailable: async () => true,
      encrypt: async value => Buffer.from(`wrapped:${value}`),
      decrypt: async value => ({ value: value.toString().slice('wrapped:'.length), shouldReEncrypt: false }),
    }
    const enrollment = enrollmentStore()
    const cache = safeStorageCache(directory, storage, enrollment)
    const activeRecord = {
      envelope: ACTIVE_ENVELOPE,
      maxIssuedAt: ACTIVE_PAYLOAD.issuedAt,
      maxObservedAt: '2026-08-26T00:30:00.000Z',
    }
    await cache.write('alice', activeRecord)
    const originalWatermark = [...enrollment.watermarks.values()][0]
    const equivocated = signedEnvelope({ membershipExpiresAt: '2026-10-26T00:00:00.000Z' })

    await expect(cache.write('alice', { ...activeRecord, envelope: equivocated }))
      .rejects.toThrow(/equivocation|watermark/i)
    expect([...enrollment.watermarks.values()][0]).toEqual(originalWatermark)
  })

  it('fails closed on a corrupt independent watermark without using the encrypted record', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'autoforge-entitlement-cache-watermark-corrupt-'))
    directories.push(directory)
    const storage: SafeStoragePort = {
      isAvailable: async () => true,
      encrypt: async value => Buffer.from(`wrapped:${value}`),
      decrypt: async value => ({ value: value.toString().slice('wrapped:'.length), shouldReEncrypt: false }),
    }
    const enrollment = enrollmentStore()
    const cache = safeStorageCache(directory, storage, enrollment)
    await cache.write('alice', {
      envelope: ACTIVE_ENVELOPE,
      maxIssuedAt: ACTIVE_PAYLOAD.issuedAt,
      maxObservedAt: '2026-08-26T00:30:00.000Z',
    })
    const [ownerKey] = enrollment.enrolled
    enrollment.watermarks.set(ownerKey!, { version: 1, ownerHash: 'tampered' })

    await expect(cache.read('alice')).rejects.toThrow(/watermark/i)
  })
})
