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
  membershipExpiresAt: '2026-09-26T00:00:00.000Z',
  killSwitchEnabled: false,
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
    '{"userId":"alice","entitlements":["knowledge_base_beta","knowledge_base_cloud"],"issuedAt":"2026-08-26T00:00:00.000Z","snapshotExpiresAt":"2026-08-26T01:00:00.000Z","membershipExpiresAt":"2026-09-26T00:00:00.000Z","membershipStatus":"active","keyId":"kms-key-2026-08","killSwitchEnabled":false}')
  assert.deepEqual(signedBytes, canonicalKnowledgeEntitlementPayload(envelope.payload))
})

test('rejects caller-shaped owner, key, time, and entitlement fields instead of signing them', async () => {
  const signer = createKnowledgeEntitlementSigner(deployment())
  for (const record of [
    { ...activeRecord, userId: 'attacker' },
    { ...activeRecord, keyId: 'attacker-key' },
    { ...activeRecord, issuedAt: '2099-01-01T00:00:00.000Z' },
    { ...activeRecord, entitlements: [] },
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

test('enforces active and terminal membership time order from the strict DB record', async () => {
  const signer = createKnowledgeEntitlementSigner(deployment())
  await assert.rejects(signer('alice', {
    ...activeRecord,
    membershipExpiresAt: '2026-08-26T00:00:00.000Z',
  }), /invalid entitlement database record/)
  const revoked = await signer('alice', {
    ...activeRecord,
    tier: 'free', status: 'revoked', betaEnabled: false, cloudEnabled: false,
    membershipExpiresAt: '2026-08-25T12:00:00.000Z',
  })
  assert.equal(revoked.payload.membershipStatus, 'revoked')
  assert.equal(revoked.payload.membershipExpiresAt, '2026-08-25T12:00:00.000Z')
})
