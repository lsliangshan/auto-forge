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
const DATABASE_STATUSES = new Set(['active', 'offline_grace', 'expired', 'unavailable'])
const DATABASE_RECORD_KEYS = Object.freeze([
  'tier', 'status', 'betaEnabled', 'cloudEnabled', 'killSwitchEnabled', 'version', 'validUntil',
])

function canonicalTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
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
  const issuedAt = Date.parse(input.issuedAt)
  const membershipExpiresAt = Date.parse(input.membershipExpiresAt)
  if (!canonicalTimestamp(input.issuedAt)
    || !canonicalTimestamp(input.snapshotExpiresAt)
    || !canonicalTimestamp(input.membershipExpiresAt)
    || Date.parse(input.snapshotExpiresAt) < issuedAt
    || (input.membershipStatus === 'active' && membershipExpiresAt <= issuedAt)
    || (input.membershipStatus !== 'active' && membershipExpiresAt > issuedAt)) {
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

function parseDatabaseRecord(input, issuedAt) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('invalid entitlement database record')
  }
  const keys = Object.keys(input)
  if (keys.length !== DATABASE_RECORD_KEYS.length
    || keys.some(key => !DATABASE_RECORD_KEYS.includes(key))
    || !['member', 'free'].includes(input.tier)
    || !DATABASE_STATUSES.has(input.status)
    || typeof input.betaEnabled !== 'boolean'
    || typeof input.cloudEnabled !== 'boolean'
    || (input.cloudEnabled && !input.betaEnabled)
    || typeof input.killSwitchEnabled !== 'boolean'
    || !Number.isSafeInteger(input.version)
    || input.version < 0
    || !(input.validUntil === null || canonicalTimestamp(input.validUntil))) {
    throw new Error('invalid entitlement database record')
  }
  const activeMembership = input.tier === 'member'
    && (input.status === 'active' || input.status === 'offline_grace')
  if (activeMembership) {
    if (input.validUntil === null || Date.parse(input.validUntil) <= issuedAt) {
      throw new Error('invalid entitlement database record')
    }
    return {
      ...input,
      membershipStatus: 'active',
      membershipExpiresAt: input.validUntil,
    }
  }
  if (input.status === 'offline_grace'
    || (input.tier === 'free' && (input.betaEnabled || input.cloudEnabled))
    || (input.tier === 'member' && input.status === 'expired' && input.validUntil === null)
    || (input.validUntil !== null && Date.parse(input.validUntil) > issuedAt)) {
    throw new Error('invalid entitlement database record')
  }
  return {
    ...input,
    membershipStatus: input.status === 'unavailable' ? 'revoked' : 'expired',
    membershipExpiresAt: input.validUntil ?? new Date(issuedAt).toISOString(),
  }
}

function createKnowledgeEntitlementSigner(deployment) {
  if (!deployment || typeof deployment !== 'object' || !Object.isFrozen(deployment)) {
    throw new Error('frozen deployment configuration is required')
  }
  if (typeof deployment.signCanonical !== 'function') throw new Error('private KMS signer is required')
  if (typeof deployment.keyId !== 'string'
    || !/^[A-Za-z0-9._-]{1,128}$/.test(deployment.keyId)
    || !Number.isSafeInteger(deployment.snapshotTtlMs)
    || deployment.snapshotTtlMs < 1
    || deployment.snapshotTtlMs > 72 * 60 * 60 * 1000
    || typeof deployment.now !== 'function') throw new Error('invalid deployment configuration')
  const keyId = deployment.keyId
  const snapshotTtlMs = deployment.snapshotTtlMs
  const now = deployment.now
  const signCanonical = deployment.signCanonical
  return async (ownerId, databaseRecord) => {
    if (typeof ownerId !== 'string' || ownerId.trim() !== ownerId
      || ownerId.length < 1 || ownerId.length > 256) throw new Error('invalid entitlement owner')
    const issuedAtMs = now()
    if (!Number.isSafeInteger(issuedAtMs)) throw new Error('invalid deployment clock')
    let issuedAt
    let snapshotExpiresAt
    try {
      issuedAt = new Date(issuedAtMs).toISOString()
      snapshotExpiresAt = new Date(issuedAtMs + snapshotTtlMs).toISOString()
    } catch {
      throw new Error('invalid deployment clock')
    }
    if (!canonicalTimestamp(issuedAt) || !canonicalTimestamp(snapshotExpiresAt)) {
      throw new Error('invalid deployment clock')
    }
    const record = parseDatabaseRecord(databaseRecord, issuedAtMs)
    const entitlements = []
    if (record.betaEnabled) entitlements.push('knowledge_base_beta')
    if (record.cloudEnabled) entitlements.push('knowledge_base_cloud')
    return createSignedKnowledgeEntitlementEnvelope({
      userId: ownerId,
      entitlements,
      issuedAt,
      snapshotExpiresAt,
      membershipExpiresAt: record.membershipExpiresAt,
      membershipStatus: record.membershipStatus,
      keyId,
      killSwitchEnabled: record.killSwitchEnabled,
    }, signCanonical)
  }
}

module.exports = {
  canonicalKnowledgeEntitlementPayload,
  createKnowledgeEntitlementSigner,
}
