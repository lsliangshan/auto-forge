/* global Buffer, require */

const assert = require('node:assert/strict')
const { test } = require('node:test')
const {
  canonicalKnowledgeEntitlementPayload,
  createSignedKnowledgeEntitlementEnvelope,
} = require('./entitlement-envelope.js')

const payload = Object.freeze({
  userId: 'alice',
  entitlements: ['knowledge_base_beta', 'knowledge_base_cloud'],
  issuedAt: '2026-08-26T00:00:00.000Z',
  snapshotExpiresAt: '2026-08-27T00:00:00.000Z',
  membershipExpiresAt: '2026-09-26T00:00:00.000Z',
  membershipStatus: 'active',
  keyId: 'kms-key-2026-08',
  killSwitchEnabled: false,
})

test('serializes the exact Main-verifier payload contract before KMS signing', () => {
  assert.equal(canonicalKnowledgeEntitlementPayload(payload).toString(),
    '{"userId":"alice","entitlements":["knowledge_base_beta","knowledge_base_cloud"],"issuedAt":"2026-08-26T00:00:00.000Z","snapshotExpiresAt":"2026-08-27T00:00:00.000Z","membershipExpiresAt":"2026-09-26T00:00:00.000Z","membershipStatus":"active","keyId":"kms-key-2026-08","killSwitchEnabled":false}')
})

test('creates a detached Ed25519 envelope through an injected private KMS signer', async () => {
  let signedBytes
  const envelope = await createSignedKnowledgeEntitlementEnvelope(payload, async (bytes, keyId) => {
    signedBytes = Buffer.from(bytes)
    assert.equal(keyId, 'kms-key-2026-08')
    return Buffer.alloc(64, 0x5a)
  })

  assert.deepEqual(envelope, {
    version: 1,
    payload,
    signature: Buffer.alloc(64, 0x5a).toString('base64url'),
  })
  assert.deepEqual(signedBytes, canonicalKnowledgeEntitlementPayload(payload))
})

test('rejects non-canonical entitlements and unexpected payload fields before signing', async () => {
  await assert.rejects(
    createSignedKnowledgeEntitlementEnvelope({
      ...payload,
      entitlements: ['knowledge_base_cloud', 'knowledge_base_beta'],
    }, async () => Buffer.alloc(64)),
    /invalid entitlement payload/,
  )
  await assert.rejects(
    createSignedKnowledgeEntitlementEnvelope({ ...payload, privateKey: 'must-not-enter-envelope' }, async () => Buffer.alloc(64)),
    /invalid entitlement payload/,
  )
})
