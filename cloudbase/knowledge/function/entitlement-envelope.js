/* global Buffer, module */

const PAYLOAD_KEYS = Object.freeze([
  'userId',
  'entitlements',
  'issuedAt',
  'snapshotExpiresAt',
  'membershipExpiresAt',
  'membershipStatus',
  'keyId',
  'killSwitchEnabled',
])
const ENTITLEMENTS = new Set(['knowledge_base_beta', 'knowledge_base_cloud'])
const MEMBERSHIP_STATUSES = new Set(['active', 'expired', 'revoked'])

function canonicalTimestamp(value) {
  return typeof value === 'string'
    && !Number.isNaN(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value
}

function parsePayload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid entitlement payload')
  const keys = Object.keys(input)
  if (keys.length !== PAYLOAD_KEYS.length || keys.some(key => !PAYLOAD_KEYS.includes(key))) {
    throw new Error('invalid entitlement payload')
  }
  if (typeof input.userId !== 'string' || input.userId.trim() !== input.userId
    || input.userId.length < 1 || input.userId.length > 256) throw new Error('invalid entitlement payload')
  if (!Array.isArray(input.entitlements) || input.entitlements.length > 2
    || input.entitlements.some(value => !ENTITLEMENTS.has(value))
    || input.entitlements.some((value, index) => index > 0 && input.entitlements[index - 1] >= value)) {
    throw new Error('invalid entitlement payload')
  }
  if (!canonicalTimestamp(input.issuedAt)
    || !canonicalTimestamp(input.snapshotExpiresAt)
    || !canonicalTimestamp(input.membershipExpiresAt)
    || Date.parse(input.snapshotExpiresAt) < Date.parse(input.issuedAt)
    || Date.parse(input.membershipExpiresAt) < Date.parse(input.issuedAt)) {
    throw new Error('invalid entitlement payload')
  }
  if (!MEMBERSHIP_STATUSES.has(input.membershipStatus)
    || typeof input.keyId !== 'string'
    || !/^[A-Za-z0-9._-]{1,128}$/.test(input.keyId)
    || typeof input.killSwitchEnabled !== 'boolean') throw new Error('invalid entitlement payload')
  return Object.freeze(Object.fromEntries(PAYLOAD_KEYS.map(key => [
    key,
    key === 'entitlements' ? Object.freeze([...input.entitlements]) : input[key],
  ])))
}

function canonicalKnowledgeEntitlementPayload(input) {
  const payload = parsePayload(input)
  return Buffer.from(JSON.stringify(payload))
}

async function createSignedKnowledgeEntitlementEnvelope(input, signCanonical) {
  if (typeof signCanonical !== 'function') throw new Error('private KMS signer is required')
  const payload = parsePayload(input)
  const signature = Buffer.from(await signCanonical(
    canonicalKnowledgeEntitlementPayload(payload),
    payload.keyId,
  ))
  if (signature.length !== 64) throw new Error('KMS signer must return a raw Ed25519 signature')
  return Object.freeze({ version: 1, payload, signature: signature.toString('base64url') })
}

module.exports = {
  canonicalKnowledgeEntitlementPayload,
  createSignedKnowledgeEntitlementEnvelope,
}
