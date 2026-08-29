/* global Buffer, fetch, module, require */

const { createPrivateKey, sign } = require('node:crypto')

const stableErrorCodes = new Set([
  'AUTH_REQUIRED', 'FORBIDDEN', 'USER_NOT_FOUND', 'INVALID_INPUT',
  'MEMBERSHIP_CONFLICT', 'SELF_MEMBERSHIP_CHANGE_FORBIDDEN',
  'REQUEST_ID_CONFLICT', 'SERVICE_UNAVAILABLE', 'INTERNAL_ERROR',
])
const membershipActions = new Set(['grant', 'extend', 'set_expiry', 'revoke', 'correct'])
const grantKinds = new Set(['manual_trial', 'manual_grant', 'future_paid'])
const reasonCodes = new Set([
  'manual_payment_confirmed', 'internal_grant', 'customer_compensation', 'trial',
  'renewal', 'refund_revocation', 'risk_revocation', 'operator_correction',
])

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value, maximum = 512) {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= maximum
}

function canonicalTimestamp(value) {
  if (!nonEmptyString(value, 64)) return false
  const parsed = Date.parse(value)
  return Number.isSafeInteger(parsed) && new Date(parsed).toISOString() === value
}

function callerUid(context) {
  if (!isRecord(context)) return undefined
  if (isRecord(context.auth) && nonEmptyString(context.auth.uid, 64)) return context.auth.uid
  if (isRecord(context.userInfo) && nonEmptyString(context.userInfo.uid, 64)) return context.userInfo.uid
  if (nonEmptyString(context.UID, 64)) return context.UID
  if (typeof context.environment === 'string') {
    try {
      const environment = JSON.parse(context.environment)
      if (isRecord(environment) && nonEmptyString(environment.TCB_UUID, 64)) return environment.TCB_UUID
    } catch { return undefined }
  }
  return undefined
}

function membershipSummary(value) {
  if (!isRecord(value)) return undefined
  const limits = value.limits
  if (!nonEmptyString(value.userId, 64)
    || !['free', 'pro'].includes(value.planId)
    || !Number.isInteger(value.planVersion) || value.planVersion <= 0
    || !['active', 'revoked'].includes(value.state)
    || !['active', 'offline_grace', 'expired', 'revoked', 'unavailable'].includes(value.effectiveStatus)
    || !(value.grantKind === null || grantKinds.has(value.grantKind))
    || !Number.isInteger(value.version) || value.version < 0
    || !(value.termEndsAt === null || canonicalTimestamp(value.termEndsAt))
    || !isRecord(limits)
    || !Number.isInteger(limits.knowledgeBases) || limits.knowledgeBases <= 0
    || !Number.isInteger(limits.knowledgeDocuments) || limits.knowledgeDocuments <= 0
    || !Number.isInteger(limits.knowledgeFileBytes) || limits.knowledgeFileBytes <= 0
    || typeof value.cloudEligible !== 'boolean'
    || !canonicalTimestamp(value.updatedAt)) return undefined
  return {
    userId: value.userId, planId: value.planId, planVersion: value.planVersion,
    state: value.state, effectiveStatus: value.effectiveStatus,
    grantKind: value.grantKind, version: value.version, termEndsAt: value.termEndsAt,
    limits: {
      knowledgeBases: limits.knowledgeBases,
      knowledgeDocuments: limits.knowledgeDocuments,
      knowledgeFileBytes: limits.knowledgeFileBytes,
    },
    cloudEligible: value.cloudEligible, updatedAt: value.updatedAt,
  }
}

function canonicalizeMembershipPayload(value) {
  return JSON.stringify({
    schemaVersion: value.schemaVersion,
    userId: value.userId,
    membershipVersion: value.membershipVersion,
    planId: value.planId,
    planVersion: value.planVersion,
    state: value.state,
    effectiveStatus: value.effectiveStatus,
    grantKind: value.grantKind,
    termEndsAt: value.termEndsAt,
    issuedAt: value.issuedAt,
    refreshAfter: value.refreshAfter,
    offlineGraceEndsAt: value.offlineGraceEndsAt,
    limits: {
      knowledgeBases: value.limits.knowledgeBases,
      knowledgeDocuments: value.limits.knowledgeDocuments,
      knowledgeFileBytes: value.limits.knowledgeFileBytes,
    },
    cloudEligible: value.cloudEligible,
    keyId: value.keyId,
  })
}

function parseMutation(event) {
  if (!isRecord(event) || event.action !== 'mutate'
    || !membershipActions.has(event.operation)
    || !nonEmptyString(event.requestId, 128)
    || !nonEmptyString(event.targetUserId, 64)
    || !Number.isInteger(event.expectedVersion) || event.expectedVersion < 0
    || !reasonCodes.has(event.reasonCode)
    || !(event.note === undefined || (typeof event.note === 'string'
      && event.note.trim() === event.note && event.note.length <= 500))) return undefined
  const needsTerm = ['grant', 'extend', 'set_expiry'].includes(event.operation)
  if (needsTerm && !canonicalTimestamp(event.termEndsAt)) return undefined
  if (event.operation === 'grant' && !grantKinds.has(event.grantKind)) return undefined
  if (event.operation === 'correct') {
    const validFree = event.planId === 'free' && ['active', 'revoked'].includes(event.state)
      && event.grantKind === null && event.termEndsAt === null
    const validPro = event.planId === 'pro' && ['active', 'revoked'].includes(event.state)
      && grantKinds.has(event.grantKind) && canonicalTimestamp(event.termEndsAt)
    if (!validFree && !validPro) return undefined
  }
  const parsed = {
    p_request_id: event.requestId,
    p_target_user_id: event.targetUserId,
    p_expected_version: event.expectedVersion,
    p_action: event.operation,
    p_grant_kind: event.operation === 'grant' ? event.grantKind : null,
    p_term_ends_at: needsTerm ? event.termEndsAt : null,
    p_reason_code: event.reasonCode,
    p_note: event.note ?? null,
  }
  return event.operation === 'correct'
    ? { ...parsed, p_plan_id: event.planId, p_state: event.state }
    : parsed
}

function auditList(value) {
  if (!isRecord(value) || !Array.isArray(value.items)
    || !Number.isInteger(value.page) || value.page < 1
    || ![20, 50].includes(value.pageSize)
    || !Number.isInteger(value.total) || value.total < 0) return undefined
  const items = value.items.map((entry) => {
    if (!isRecord(entry) || !nonEmptyString(entry.id, 128)
      || !nonEmptyString(entry.targetUserId, 64) || !nonEmptyString(entry.actorUserId, 64)
      || !membershipActions.has(entry.action) || !reasonCodes.has(entry.reasonCode)
      || !Number.isInteger(entry.previousVersion) || entry.previousVersion < 0
      || !Number.isInteger(entry.resultingVersion) || entry.resultingVersion <= 0
      || !canonicalTimestamp(entry.createdAt)) return undefined
    return {
      id: entry.id, targetUserId: entry.targetUserId, actorUserId: entry.actorUserId,
      action: entry.action, reasonCode: entry.reasonCode,
      previousVersion: entry.previousVersion, resultingVersion: entry.resultingVersion,
      createdAt: entry.createdAt,
    }
  })
  if (items.some(item => item === undefined)) return undefined
  return { items, page: value.page, pageSize: value.pageSize, total: value.total }
}

function createMembershipHandler({ rpc, privateKey, keyId, now = Date.now }) {
  if (typeof rpc !== 'function' || !nonEmptyString(keyId, 64)) {
    throw new TypeError('MEMBERSHIP_SIGNING_UNAVAILABLE')
  }
  let signingKey
  try {
    signingKey = typeof privateKey === 'string' || Buffer.isBuffer(privateKey)
      ? createPrivateKey(privateKey)
      : privateKey
  } catch { throw new TypeError('MEMBERSHIP_SIGNING_UNAVAILABLE') }
  if (!signingKey || signingKey.type !== 'private' || signingKey.asymmetricKeyType !== 'ed25519') {
    throw new TypeError('MEMBERSHIP_SIGNING_UNAVAILABLE')
  }

  const signSummary = (summary) => {
    const issuedAtMs = now()
    if (!Number.isSafeInteger(issuedAtMs)) throw new Error('invalid clock')
    const issuedAt = new Date(issuedAtMs).toISOString()
    const refreshAfter = new Date(issuedAtMs + 5 * 60 * 1_000).toISOString()
    const maximumGrace = issuedAtMs + 72 * 60 * 60 * 1_000
    const termGrace = summary.termEndsAt === null
      ? maximumGrace
      : Date.parse(summary.termEndsAt) + 72 * 60 * 60 * 1_000
    const offlineGraceEndsAt = new Date(
      summary.effectiveStatus === 'active' ? Math.min(maximumGrace, termGrace) : maximumGrace,
    ).toISOString()
    const payload = canonicalizeMembershipPayload({
      schemaVersion: 2, userId: summary.userId, membershipVersion: summary.version,
      planId: summary.planId, planVersion: summary.planVersion, state: summary.state,
      effectiveStatus: summary.effectiveStatus, grantKind: summary.grantKind,
      termEndsAt: summary.termEndsAt,
      issuedAt, refreshAfter, offlineGraceEndsAt, limits: summary.limits,
      cloudEligible: summary.cloudEligible, keyId,
    })
    return {
      payload: Buffer.from(payload, 'utf8').toString('base64url'),
      signature: sign(null, Buffer.from(payload, 'utf8'), signingKey).toString('base64url'),
    }
  }

  return async (event, context) => {
    const caller = callerUid(context)
    if (!caller) return { ok: false, error: { code: 'AUTH_REQUIRED' } }
    try {
      if (isRecord(event) && event.action === 'getCurrent') {
        const current = membershipSummary(await rpc('autoforge_membership_get_current', {
          p_caller_user_id: caller,
        }))
        if (!current) throw new Error('invalid membership response')
        return { ok: true, data: { membership: current, entitlement: signSummary(current) } }
      }
      if (isRecord(event) && event.action === 'getTarget'
        && nonEmptyString(event.targetUserId, 64)) {
        const current = membershipSummary(await rpc('autoforge_membership_get_target', {
          p_caller_user_id: caller, p_target_user_id: event.targetUserId,
        }))
        if (!current) throw new Error('invalid membership response')
        return { ok: true, data: { membership: current } }
      }
      if (isRecord(event) && event.action === 'listAudit'
        && nonEmptyString(event.targetUserId, 64)
        && Number.isInteger(event.page) && event.page > 0 && [20, 50].includes(event.pageSize)) {
        const page = auditList(await rpc('autoforge_membership_list_audit', {
          p_caller_user_id: caller, p_target_user_id: event.targetUserId,
          p_page: event.page, p_page_size: event.pageSize,
        }))
        if (!page) throw new Error('invalid membership audit response')
        return { ok: true, data: page }
      }
      if (isRecord(event) && event.action === 'mutate') {
        const mutation = parseMutation(event)
        if (!mutation) return { ok: false, error: { code: 'INVALID_INPUT' } }
        const raw = await rpc('autoforge_membership_mutate', {
          p_caller_user_id: caller,
          ...mutation,
        })
        const status = isRecord(raw) && ['applied', 'duplicate'].includes(raw.status)
          ? raw.status
          : 'applied'
        const current = membershipSummary(isRecord(raw) && raw.membership ? raw.membership : raw)
        if (!current) throw new Error('invalid membership mutation response')
        return { ok: true, data: { status, membership: current } }
      }
      return { ok: false, error: { code: 'INVALID_INPUT' } }
    } catch (error) {
      const code = isRecord(error) && stableErrorCodes.has(error.code) ? error.code : 'INTERNAL_ERROR'
      return { ok: false, error: { code } }
    }
  }
}

function createPostgresRpcClient({ baseUrl, serviceKey, fetchImpl = fetch }) {
  if (!nonEmptyString(baseUrl, 2048) || !nonEmptyString(serviceKey, 8192)) {
    throw new TypeError('MEMBERSHIP_SIGNING_UNAVAILABLE')
  }
  const root = baseUrl.replace(/\/+$/, '')
  return async (name, input) => {
    const response = await fetchImpl(`${root}/rpc/${name}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${serviceKey}`, apikey: serviceKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      const candidate = isRecord(body) && typeof body.message === 'string' ? body.message : ''
      throw { code: stableErrorCodes.has(candidate) ? candidate : 'SERVICE_UNAVAILABLE' }
    }
    return body
  }
}

module.exports = {
  canonicalizeMembershipPayload,
  createMembershipHandler,
  createPostgresRpcClient,
}
