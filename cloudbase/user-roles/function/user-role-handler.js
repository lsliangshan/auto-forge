/* global fetch, module */

const stableErrorCodes = new Set([
  'AUTH_REQUIRED',
  'FORBIDDEN',
  'USER_NOT_FOUND',
  'INVALID_INPUT',
  'ROLE_CONFLICT',
  'SELF_ROLE_CHANGE_FORBIDDEN',
  'LAST_SUPER_ADMIN',
  'REQUEST_ID_CONFLICT',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
])

const filterFields = new Set(['username', 'displayName', 'userId', 'email', 'phone'])
const assignableRoles = new Set(['user', 'super_admin'])

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value, keys) {
  if (!isRecord(value)) return false
  const actual = Object.keys(value).sort()
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
}

function nonEmptyString(value, maximum = 254) {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= maximum
}

function callerUid(context) {
  if (!isRecord(context)) return undefined
  if (isRecord(context.auth) && nonEmptyString(context.auth.uid, 64)) return context.auth.uid
  if (isRecord(context.userInfo) && nonEmptyString(context.userInfo.uid, 64)) return context.userInfo.uid
  if (nonEmptyString(context.UID, 64)) return context.UID
  if (typeof context.environment === 'string') {
    try {
      const environment = JSON.parse(context.environment)
      if (isRecord(environment) && nonEmptyString(environment.TCB_UUID, 64)) {
        return environment.TCB_UUID
      }
    } catch {
      return undefined
    }
  }
  return undefined
}

function parseList(event) {
  const keys = event.filter === undefined
    ? ['action', 'page', 'pageSize']
    : ['action', 'filter', 'page', 'pageSize']
  if (!hasExactKeys(event, keys)
    || !Number.isInteger(event.page) || event.page < 1
    || ![20, 50, 100].includes(event.pageSize)) return undefined
  if (event.filter === undefined) return { page: event.page, pageSize: event.pageSize }
  if (!hasExactKeys(event.filter, ['field', 'value'])
    || !filterFields.has(event.filter.field)
    || !nonEmptyString(event.filter.value)) return undefined
  return { page: event.page, pageSize: event.pageSize, filter: event.filter }
}

function parseUpdate(event) {
  if (!hasExactKeys(event, ['action', 'expectedVersion', 'newRole', 'requestId', 'targetUserId'])
    || !nonEmptyString(event.requestId, 128)
    || !nonEmptyString(event.targetUserId, 64)
    || !assignableRoles.has(event.newRole)
    || !Number.isInteger(event.expectedVersion)
    || event.expectedVersion < 0) return undefined
  return {
    requestId: event.requestId,
    targetUserId: event.targetUserId,
    newRole: event.newRole,
    expectedVersion: event.expectedVersion,
  }
}

function safeErrorCode(error) {
  if (!isRecord(error)) return 'INTERNAL_ERROR'
  if (stableErrorCodes.has(error.code)) return error.code
  if (stableErrorCodes.has(error.message)) return error.message
  return 'INTERNAL_ERROR'
}

function createUserRoleHandler({ rpc }) {
  return async (rawEvent, context) => {
    const uid = callerUid(context)
    if (!uid) return { ok: false, error: { code: 'AUTH_REQUIRED' } }
    const event = isRecord(rawEvent) ? rawEvent : {}
    try {
      if (hasExactKeys(event, ['action']) && event.action === 'ensureMyRole') {
        return {
          ok: true,
          data: await rpc('autoforge_ensure_my_role', { p_caller_user_id: uid }),
        }
      }
      if (event.action === 'listUsers') {
        const input = parseList(event)
        if (!input) return { ok: false, error: { code: 'INVALID_INPUT' } }
        return {
          ok: true,
          data: await rpc('autoforge_list_users', {
            p_caller_user_id: uid,
            p_page: input.page,
            p_page_size: input.pageSize,
            p_filter_field: input.filter?.field ?? null,
            p_filter_value: input.filter?.value ?? null,
          }),
        }
      }
      if (event.action === 'updateUserRole') {
        const input = parseUpdate(event)
        if (!input) return { ok: false, error: { code: 'INVALID_INPUT' } }
        return {
          ok: true,
          data: await rpc('autoforge_update_user_role', {
            p_caller_user_id: uid,
            p_request_id: input.requestId,
            p_target_user_id: input.targetUserId,
            p_new_role: input.newRole,
            p_expected_version: input.expectedVersion,
          }),
        }
      }
      return { ok: false, error: { code: 'INVALID_INPUT' } }
    } catch (error) {
      return { ok: false, error: { code: safeErrorCode(error) } }
    }
  }
}

function createPostgresRpcClient({ baseUrl, serviceKey, fetchImpl = fetch }) {
  if (!baseUrl || !serviceKey) throw new Error('CloudBase PostgreSQL RPC is not configured')
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '')
  return async (name, parameters) => {
    let response
    try {
      response = await fetchImpl(`${normalizedBaseUrl}/rpc/${name}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${serviceKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(parameters),
      })
    } catch {
      throw { code: 'SERVICE_UNAVAILABLE' }
    }
    const body = await response.json().catch(() => undefined)
    if (response.ok) return body
    const code = safeErrorCode(body)
    if (code !== 'INTERNAL_ERROR') throw { code }
    throw { code: response.status >= 500 ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_ERROR' }
  }
}

module.exports = {
  createPostgresRpcClient,
  createUserRoleHandler,
}
