/* global Buffer, require */

const assert = require('node:assert/strict')
const { test } = require('node:test')
const {
  canonicalKnowledgeEntitlementPayload,
  createKnowledgeEntitlementSigner,
} = require('./entitlement-envelope.js')

const activeRecord = Object.freeze({
  tier: 'member',
  status: 'active',
  betaEnabled: true,
  cloudEnabled: true,
  killSwitchEnabled: false,
  version: 7,
  validUntil: '2026-09-26T00:00:00.000Z',
})

function deployment(overrides = {}) {
  return Object.freeze({
    keyId: 'kms-key-2026-08',
    snapshotTtlMs: 60 * 60 * 1000,
    now: () => Date.parse('2026-08-26T00:00:00.000Z'),
    signCanonical: async () => Buffer.alloc(64, 0x5a),
    ...overrides,
  })
}

test('derives the canonical envelope only from trusted owner, strict DB state, and frozen deployment config', async () => {
  let signedBytes
  const signer = createKnowledgeEntitlementSigner(deployment({
    signCanonical: async bytes => {
      signedBytes = Buffer.from(bytes)
      return Buffer.alloc(64, 0x5a)
    },
  }))
  const envelope = await signer('alice', activeRecord)

  assert.deepEqual(envelope, {
    version: 1,
    payload: {
      userId: 'alice',
      tier: 'member',
      entitlements: ['knowledge_base_beta', 'knowledge_base_cloud'],
      issuedAt: '2026-08-26T00:00:00.000Z',
      snapshotExpiresAt: '2026-08-26T01:00:00.000Z',
      membershipExpiresAt: '2026-09-26T00:00:00.000Z',
      membershipStatus: 'active',
      keyId: 'kms-key-2026-08',
      killSwitchEnabled: false,
    },
    signature: Buffer.alloc(64, 0x5a).toString('base64url'),
  })
  assert.equal(signedBytes.toString(),
    '{"userId":"alice","tier":"member","entitlements":["knowledge_base_beta","knowledge_base_cloud"],"issuedAt":"2026-08-26T00:00:00.000Z","snapshotExpiresAt":"2026-08-26T01:00:00.000Z","membershipExpiresAt":"2026-09-26T00:00:00.000Z","membershipStatus":"active","keyId":"kms-key-2026-08","killSwitchEnabled":false}')
  assert.deepEqual(signedBytes, canonicalKnowledgeEntitlementPayload(envelope.payload))
})

test('rejects caller-shaped owner, key, time, and entitlement fields instead of signing them', async () => {
  const signer = createKnowledgeEntitlementSigner(deployment())
  for (const record of [
    { ...activeRecord, userId: 'attacker' },
    { ...activeRecord, keyId: 'attacker-key' },
    { ...activeRecord, issuedAt: '2099-01-01T00:00:00.000Z' },
    { ...activeRecord, entitlements: [] },
    { ...activeRecord, membershipExpiresAt: '2099-01-01T00:00:00.000Z' },
    { ...activeRecord, cloudEnabled: true, betaEnabled: false },
  ]) {
    await assert.rejects(createKnowledgeEntitlementSigner(deployment())('alice', record),
      /invalid entitlement database record/)
  }
  await assert.rejects(signer(' alice ', activeRecord), /invalid entitlement owner/)
})

test('requires a frozen deploy config and injected KMS signer', () => {
  assert.throws(() => createKnowledgeEntitlementSigner({
    keyId: 'kms-key-2026-08', snapshotTtlMs: 1000,
    now: () => 0, signCanonical: async () => Buffer.alloc(64),
  }), /frozen deployment configuration/)
  assert.throws(() => createKnowledgeEntitlementSigner(Object.freeze({
    keyId: 'kms-key-2026-08', snapshotTtlMs: 1000, now: () => 0,
  })), /private KMS signer is required/)
})

test('maps the literal RPC active, offline-grace, expired, unavailable, and free rows', async () => {
  const signer = createKnowledgeEntitlementSigner(deployment())
  await assert.rejects(signer('alice', {
    ...activeRecord,
    validUntil: '2026-08-26T00:00:00.000Z',
  }), /invalid entitlement database record/)
  const offlineGrace = await signer('alice', { ...activeRecord, status: 'offline_grace' })
  assert.equal(offlineGrace.payload.membershipStatus, 'active')
  assert.equal(offlineGrace.payload.membershipExpiresAt, '2026-09-26T00:00:00.000Z')

  const expired = await signer('alice', {
    tier: 'member', status: 'expired', betaEnabled: true, cloudEnabled: true,
    killSwitchEnabled: true, version: 8, validUntil: '2026-08-25T12:00:00.000Z',
  })
  assert.equal(expired.payload.membershipStatus, 'expired')
  assert.equal(expired.payload.membershipExpiresAt, '2026-08-25T12:00:00.000Z')

  const expiredMember = await signer('alice', {
    ...activeRecord,
    status: 'expired',
    validUntil: '2026-08-25T12:00:00.000Z',
  })
  assert.equal(expiredMember.payload.membershipStatus, 'expired')
  assert.equal(expiredMember.payload.tier, 'member')
  assert.equal(expiredMember.payload.membershipExpiresAt, '2026-08-25T12:00:00.000Z')
  assert.deepEqual(expiredMember.payload.entitlements,
    ['knowledge_base_beta', 'knowledge_base_cloud'])

  const unavailable = await signer('alice', {
    tier: 'member', status: 'unavailable', betaEnabled: true, cloudEnabled: true,
    killSwitchEnabled: true, version: 9, validUntil: null,
  })
  assert.equal(unavailable.payload.membershipStatus, 'revoked')
  assert.equal(unavailable.payload.membershipExpiresAt, '2026-08-26T00:00:00.000Z')

  const unavailableMember = await signer('alice', {
    ...activeRecord,
    status: 'unavailable',
    validUntil: null,
  })
  assert.equal(unavailableMember.payload.membershipStatus, 'revoked')
  assert.equal(unavailableMember.payload.tier, 'member')
  assert.equal(unavailableMember.payload.membershipExpiresAt, '2026-08-26T00:00:00.000Z')
  assert.deepEqual(unavailableMember.payload.entitlements,
    ['knowledge_base_beta', 'knowledge_base_cloud'])

  const neverMember = await signer('alice', {
    tier: 'free', status: 'active', betaEnabled: false, cloudEnabled: false,
    killSwitchEnabled: true, version: 0, validUntil: null,
  })
  assert.equal(neverMember.payload.tier, 'free')
  assert.equal(neverMember.payload.membershipStatus, 'active')
  assert.equal(neverMember.payload.membershipExpiresAt, '2026-08-26T00:00:00.000Z')
})

test('rejects inconsistent literal RPC rows instead of repairing trusted database state', async () => {
  const signer = createKnowledgeEntitlementSigner(deployment())
  for (const record of [
    { ...activeRecord, status: 'expired', validUntil: null },
    { ...activeRecord, tier: 'free', status: 'offline_grace', betaEnabled: false, cloudEnabled: false },
    { ...activeRecord, tier: 'free', status: 'expired', betaEnabled: false, cloudEnabled: false,
      validUntil: '2026-08-25T12:00:00.000Z' },
    { ...activeRecord, tier: 'free', status: 'unavailable', betaEnabled: false, cloudEnabled: false,
      validUntil: null },
    { ...activeRecord, validUntil: null },
    { ...activeRecord, tier: 'free', status: 'active', validUntil: null },
    { ...activeRecord, tier: 'free', status: 'expired', betaEnabled: false, cloudEnabled: false,
      validUntil: '2026-09-26T00:00:00.000Z' },
    { ...activeRecord, version: -1 },
  ]) {
    await assert.rejects(signer('alice', record), /invalid entitlement database record/)
  }
})

test('never signs an extended-year timestamp that the Main four-digit grammar rejects', async () => {
  const signer = createKnowledgeEntitlementSigner(deployment({
    now: () => Date.parse('+010000-01-01T00:00:00.000Z'),
  }))
  await assert.rejects(signer('alice', {
    tier: 'free', status: 'unavailable', betaEnabled: false, cloudEnabled: false,
    killSwitchEnabled: true, version: 1, validUntil: null,
  }), /invalid deployment clock|invalid entitlement payload/)
})
