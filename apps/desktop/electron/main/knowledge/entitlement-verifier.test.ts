import { createPrivateKey, sign } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

const ACTIVE_PAYLOAD: KnowledgeEntitlementEnvelope['payload'] = {
  userId: 'alice',
  entitlements: ['knowledge_base_beta', 'knowledge_base_cloud'],
  issuedAt: '2026-08-26T00:00:00.000Z',
  snapshotExpiresAt: '2026-08-26T01:00:00.000Z',
  membershipExpiresAt: '2026-09-26T00:00:00.000Z',
  membershipStatus: 'active',
  keyId: 'test-key-1',
  killSwitchEnabled: false,
}
const ACTIVE_SIGNATURE = 'pS-5z6-4NKgBNCyKPPPoMEpgKqzXyXaYu0Ww-ngWX40xRoGo_zogU399TJn46YSxZGZOzs7qRLk72vmEhmeHBw'
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

  it('never grants grace to signed expired, revoked, kill-switched, or membership-expired state', () => {
    const now = '2026-08-26T02:00:00.000Z'
    for (const [envelope, expectedStatus] of [
      [signedEnvelope({ membershipStatus: 'expired' }), 'expired'],
      [signedEnvelope({ membershipStatus: 'revoked' }), 'expired'],
      [signedEnvelope({ killSwitchEnabled: true }), 'active'],
      [signedEnvelope({ membershipExpiresAt: '2026-08-26T02:00:00.000Z' }), 'expired'],
    ] as const) {
      const state = verifier(now).verify('alice', envelope)
      expect(state.status).toBe(expectedStatus)
      expect(state.knowledgeToolEnabled).toBe(false)
      expect(state.cloudEnabled).toBe(false)
    }
  })

  it('fails closed for future-issued snapshots beyond skew and accepts the exact skew boundary', () => {
    const future = signedEnvelope({ issuedAt: '2026-08-26T00:05:00.000Z' })
    expect(verifier('2026-08-26T00:00:00.000Z').verify('alice', future).status).toBe('active')
    expect(() => verifier('2026-08-25T23:59:59.999Z').verify('alice', future))
      .toThrow('issued_in_future')
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
    expect(verifier(now).verify('alice', expired).lifecycle.phase).toBe(phase)
  })

  it('ships with no production trusted key until deployment supplies an approved public key', () => {
    expect(PRODUCTION_KNOWLEDGE_ENTITLEMENT_TRUSTED_KEYS).toEqual({})
    expect(Object.isFrozen(PRODUCTION_KNOWLEDGE_ENTITLEMENT_TRUSTED_KEYS)).toBe(true)
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

  it('rejects a different valid envelope replayed at the same issuedAt instead of extending membership', async () => {
    const stored = cache()
    stored.values.set('alice', {
      envelope: ACTIVE_ENVELOPE,
      maxIssuedAt: ACTIVE_PAYLOAD.issuedAt,
      maxObservedAt: '2026-08-26T00:00:00.000Z',
    })
    const equivocated = signedEnvelope({ membershipExpiresAt: '2026-10-26T00:00:00.000Z' })
    const authority = new KnowledgeEntitlementAuthority({
      trustedKeys: { 'test-key-1': PUBLIC_KEY }, cache: stored,
      fetchEnvelope: async () => equivocated,
      now: () => Date.parse('2026-08-26T00:30:00.000Z'),
    })

    await expect(authority.getEntitlement({ userId: 'alice' })).resolves.toMatchObject({
      membershipExpiresAt: ACTIVE_PAYLOAD.membershipExpiresAt,
    })
    expect(stored.values.get('alice')?.envelope).toEqual(ACTIVE_ENVELOPE)
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
  })
})

describe('SafeStorageKnowledgeEntitlementCache', () => {
  it('persists one encrypted owner-scoped record and reloads it after restart without cross-user bleed', async () => {
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
    const first = new SafeStorageKnowledgeEntitlementCache(directory, storage)
    await first.write('alice', record)
    const files = await import('node:fs/promises').then(({ readdir }) => readdir(directory))
    expect(files).toHaveLength(1)
    const disk = await readFile(join(directory, files[0]!), 'utf8')
    expect(disk).not.toContain('alice')
    expect(disk).not.toContain(ACTIVE_PAYLOAD.membershipExpiresAt)

    const restarted = new SafeStorageKnowledgeEntitlementCache(directory, storage)
    await expect(restarted.read('alice')).resolves.toEqual(record)
    await expect(restarted.read('bob')).resolves.toBeUndefined()
  })
})
