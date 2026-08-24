/* global AbortController, Buffer, TextDecoder, URL, clearTimeout, fetch, module, setTimeout */

const stableErrorCodes = new Set([
  'AUTH_REQUIRED',
  'FORBIDDEN',
  'INVALID_INPUT',
  'SYNC_CONFLICT',
  'UPGRADE_REQUIRED',
  'IMPORT_CONFIRMATION_REQUIRED',
  'OUTBOX_LIMIT_EXCEEDED',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
])

const appErrorCodes = new Set([
  'INVALID_INPUT', 'UNTRUSTED_SENDER', 'INTERNAL_ERROR', 'AUTH_REQUIRED',
  'AUTH_INVALID_CREDENTIALS', 'AUTH_ACCOUNT_EXISTS', 'AUTH_INVALID_OTP',
  'AUTH_OTP_EXPIRED', 'AUTH_OTP_RATE_LIMITED', 'AUTH_ACCOUNT_NOT_FOUND', 'FORBIDDEN',
  'USER_NOT_FOUND', 'ROLE_CONFLICT', 'SELF_ROLE_CHANGE_FORBIDDEN', 'LAST_SUPER_ADMIN',
  'REQUEST_ID_CONFLICT', 'SERVICE_UNAVAILABLE', 'NOT_FOUND', 'CONFLICT', 'SYNC_CONFLICT',
  'SYNC_FAILED', 'UPGRADE_REQUIRED', 'IMPORT_CONFIRMATION_REQUIRED', 'OUTBOX_LIMIT_EXCEEDED',
  'CANCELLED', 'PATH_OUTSIDE_PROJECT', 'CAPABILITY_SCOPE_DENIED', 'PERMISSION_DENIED',
  'WORKFLOW_INTEGRITY_FAILED', 'WORKER_PROTOCOL_INVALID', 'WORKER_TIMEOUT',
  'CREDENTIAL_UNAVAILABLE', 'CREDENTIAL_INVALID', 'MODEL_PROVIDER_ACCESS_DENIED',
  'MODEL_PROVIDER_INVALID_REQUEST', 'MODEL_PROVIDER_PAYMENT_REQUIRED',
  'MODEL_PROVIDER_RATE_LIMITED', 'MODEL_PROVIDER_TIMEOUT', 'MODEL_PROVIDER_UNAVAILABLE',
  'OPENROUTER_REQUEST_FAILED', 'MODEL_PROVIDER_REQUEST_FAILED', 'CONTEXT_LIMIT_EXCEEDED',
  'MEDIA_TYPE_UNSUPPORTED', 'MEDIA_ATTACHMENT_LIMIT_EXCEEDED', 'MEDIA_SIZE_LIMIT_EXCEEDED',
  'MEDIA_MIME_MISMATCH', 'MEDIA_IMPORT_FAILED', 'MEDIA_ASSET_UNAVAILABLE',
  'MEDIA_STORAGE_FULL', 'MODEL_MODALITY_UNSUPPORTED', 'MEDIA_GENERATION_FAILED',
  'MEDIA_DOWNLOAD_FAILED', 'MEDIA_GENERATION_TIMEOUT', 'PROFILE_AVATAR_UPLOAD_FAILED',
  'NETWORK_PROXY_APPLY_FAILED', 'CITY_REQUIRED', 'CITY_NOT_SUPPORTED', 'WORKFLOW_CHANGED',
  'INVALID_TOOL_SEQUENCE', 'TOOL_CALL_LIMIT', 'INVALID_OUTPUT', 'RESULT_TOO_LARGE',
  'NO_BOUND_PAGE', 'PAGE_CLOSED', 'PAGE_BUSY', 'AUTH_STATE_UNKNOWN', 'TARGET_AMBIGUOUS',
  'DOMAIN_BLOCKED', 'MANUAL_ACTION_REQUIRED', 'MANUAL_INTERVENTION_REQUIRED', 'PAGE_CHANGED',
  'UNSUPPORTED_CONTROL', 'ACTION_LIMIT_EXCEEDED',
])

const allowedRpcNames = new Set([
  'autoforge_sync_push',
  'autoforge_sync_pull',
  'autoforge_list_conversations',
  'autoforge_list_messages',
  'autoforge_preview_legacy_import',
  'autoforge_import_legacy_batch',
  'autoforge_get_usage_snapshot',
  'autoforge_get_user_data_preferences',
  'autoforge_update_user_data_preferences',
])

const titleStates = new Set(['pending', 'generating', 'ai_named', 'user_named', 'failed'])
const consentPurposes = new Set(['cloud_sync', 'legacy_unowned_import'])
const providers = new Set(['deepseek', 'openrouter'])
const modalities = new Set(['text', 'image', 'audio', 'video'])
const capabilities = new Set([
  'browser.open', 'browser.fill', 'browser.click', 'browser.url', 'browser.close',
  'network.fetch', 'filesystem.read', 'filesystem.write', 'clipboard.read',
  'clipboard.write', 'notification.send', 'artifact.create',
])
const executionStatuses = new Set([
  'queued', 'awaiting_approval', 'running', 'completed', 'failed', 'cancelled', 'interrupted',
])
const maximumRequestBytes = 1_048_576
const maximumResponseBytes = 8 * 1024 * 1024
const maximumBatchItems = 100

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasStrictShape(value, requiredKeys, optionalKeys = []) {
  if (!isRecord(value)) return false
  const actualKeys = Object.keys(value)
  const allowedKeys = new Set([...requiredKeys, ...optionalKeys])
  return requiredKeys.every((key) => Object.hasOwn(value, key))
    && actualKeys.every((key) => allowedKeys.has(key))
}

function nonEmptyString(value, maximum = maximumRequestBytes) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximum
    && value.trim() === value
}

function identifier(value) {
  return nonEmptyString(value, 128)
}

function opaqueCursor(value) {
  return nonEmptyString(value, 2048) && value.length >= 16
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

function timestamp(value) {
  return typeof value === 'string'
    && value.length <= 64
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
    && Number.isFinite(Date.parse(value))
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

function withinRequestLimit(value) {
  try {
    const serialized = JSON.stringify(value)
    return typeof serialized === 'string' && Buffer.byteLength(serialized, 'utf8') <= maximumRequestBytes
  } catch {
    return false
  }
}

function cloneValidatedJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function sensitiveOpaqueKey(key) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  return normalized === 'authorization'
    || normalized === 'cookie'
    || normalized === 'uid'
    || normalized.endsWith('uid')
    || normalized.includes('userid')
    || normalized === 'path'
    || normalized.endsWith('path')
    || normalized.includes('owner')
    || normalized.includes('credential')
    || normalized.includes('token')
    || normalized.includes('password')
    || normalized.includes('secret')
    || normalized.includes('servicekey')
    || normalized.includes('apikey')
    || normalized.includes('prompt')
    || normalized.includes('responsebody')
    || normalized.includes('base64')
}

function sanitizeOpaqueJson(value) {
  if (Array.isArray(value)) return value.map(sanitizeOpaqueJson)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    sensitiveOpaqueKey(key) ? '[REDACTED]' : sanitizeOpaqueJson(child),
  ]))
}

function sanitizeChatBlock(block) {
  const cloned = cloneValidatedJson(block)
  if (cloned.type === 'workflow_proposal') cloned.args = sanitizeOpaqueJson(cloned.args)
  return cloned
}

function validateConsent(value, requiredPurpose) {
  return hasStrictShape(value, ['purpose', 'documentVersion', 'consentedAt', 'clientVersion'])
    && consentPurposes.has(value.purpose)
    && (requiredPurpose === undefined || value.purpose === requiredPurpose)
    && nonEmptyString(value.documentVersion, 128)
    && timestamp(value.consentedAt)
    && nonEmptyString(value.clientVersion, 64)
}

function validatePreferences(value) {
  return hasStrictShape(value, ['timezone', 'displayCurrency'])
    && nonEmptyString(value.timezone, 128)
    && ['CNY', 'USD'].includes(value.displayCurrency)
}

function httpsOrigin(value) {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
      && url.username === ''
      && url.password === ''
      && url.pathname === '/'
      && url.search === ''
      && url.hash === ''
      && url.origin === value
  } catch {
    return false
  }
}

// Standalone semantic copy of packages/shared/src/https-url-pattern.ts.
// Keep parity regression cases in tests/cloudbase/user-data-handler.test.ts.
const schemePattern = /^([A-Za-z][A-Za-z\d+.-]*):\/\//
const hostnameLabelPattern = /^[A-Za-z\d*](?:[A-Za-z\d*-]*[A-Za-z\d*])?$/

function normalizedGlob(value) {
  return value.replace(/\*+/g, '*')
}

function parseWildcardHttpsPattern(value, schemeLength) {
  const remainder = value.slice(schemeLength)
  const slashIndex = remainder.indexOf('/')
  const authority = slashIndex < 0 ? remainder : remainder.slice(0, slashIndex)
  const path = slashIndex < 0 ? undefined : remainder.slice(slashIndex)
  if (!authority || authority.includes('@') || authority.includes('[') || authority.includes(']')) {
    return undefined
  }
  const colonIndex = authority.lastIndexOf(':')
  if (colonIndex !== authority.indexOf(':')) return undefined
  const host = (colonIndex < 0 ? authority : authority.slice(0, colonIndex)).toLowerCase()
  const portText = colonIndex < 0 ? '' : authority.slice(colonIndex + 1)
  if (colonIndex >= 0 && !portText) return undefined
  if (!host || host.startsWith('.') || host.endsWith('.') || host.includes('..')) return undefined
  if (!host.split('.').every((label) => hostnameLabelPattern.test(label))) return undefined
  if (!/[A-Za-z\d]/.test(host) || /^[\d.*]+$/.test(host)) return undefined
  if (portText && !/^\d+$/.test(portText)) return undefined
  const port = portText ? Number(portText) : 443
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined
  if (path?.includes('\\')) return undefined
  return {
    host: normalizedGlob(host),
    hostHasWildcard: true,
    port: port === 443 ? '' : String(port),
    ...(path && path !== '/*' ? { path: normalizedGlob(path) } : {}),
  }
}

function parseExactHttpsPattern(value, schemeLength) {
  const remainder = value.slice(schemeLength)
  const slashIndex = remainder.indexOf('/')
  const authority = slashIndex < 0 ? remainder : remainder.slice(0, slashIndex)
  const hasPath = slashIndex >= 0
  if (!authority || authority.endsWith(':')) return undefined
  try {
    const url = new URL(schemeLength ? value : `https://${value}`)
    if (url.protocol !== 'https:'
      || url.username
      || url.password
      || !url.hostname
      || url.hostname.includes('..')) return undefined
    return {
      host: url.hostname.toLowerCase(),
      hostHasWildcard: false,
      port: url.port,
      ...(hasPath ? { path: url.pathname } : {}),
    }
  } catch {
    return undefined
  }
}

function httpsUrlPattern(value) {
  if (!value || value !== value.trim() || value.includes('?') || value.includes('#') || value.includes('\\')) {
    return false
  }
  const scheme = value.match(schemePattern)
  if (scheme && scheme[1]?.toLowerCase() !== 'https') return false
  const schemeLength = scheme?.[0].length ?? 0
  if (!scheme && value.includes('://')) return false
  return value.includes('*')
    ? parseWildcardHttpsPattern(value, schemeLength) !== undefined
    : parseExactHttpsPattern(value, schemeLength) !== undefined
}

function validateScope(capability, scope) {
  if (!isRecord(scope)) return false
  if (capability.startsWith('browser.') || capability === 'network.fetch') {
    return hasStrictShape(scope, ['origins'])
      && Array.isArray(scope.origins)
      && scope.origins.length > 0
      && scope.origins.every(httpsUrlPattern)
  }
  if (capability.startsWith('filesystem.')) {
    return hasStrictShape(scope, ['paths'])
      && Array.isArray(scope.paths)
      && scope.paths.length > 0
      && scope.paths.every((path) => nonEmptyString(path))
  }
  return hasStrictShape(scope, [])
}

function validateWorkflowContext(value) {
  if (!hasStrictShape(
    value,
    ['workflowId', 'workflowName', 'workflowVersion', 'source'],
    ['buildHash', 'city'],
  )) return false
  if (!identifier(value.workflowId)
    || !nonEmptyString(value.workflowName)
    || !nonEmptyString(value.workflowVersion)
    || !['installed', 'development'].includes(value.source)
    || (value.city !== undefined && !nonEmptyString(value.city))) return false
  if (value.source === 'development') return /^[a-f0-9]{64}$/.test(value.buildHash)
  return value.buildHash === undefined
}

function validateChatBlock(block) {
  if (!isRecord(block) || typeof block.type !== 'string') return false
  switch (block.type) {
    case 'text':
      return hasStrictShape(block, ['type', 'text']) && typeof block.text === 'string'
    case 'reasoning_status':
      return hasStrictShape(block, ['type', 'label']) && nonEmptyString(block.label)
    case 'workflow_proposal':
      return hasStrictShape(block, ['type', 'workflowId', 'workflowName', 'args'])
        && identifier(block.workflowId) && nonEmptyString(block.workflowName)
    case 'approval': {
      if (!hasStrictShape(
        block,
        [
          'type', 'blockId', 'state', 'executionId', 'workflowId', 'workflowName',
          'workflowVersion', 'source', 'actionSummary', 'permissionIndex', 'capability',
          'scope', 'scopeHash',
        ],
        ['buildHash', 'city'],
      )) return false
      const workflowContext = {
        workflowId: block.workflowId,
        workflowName: block.workflowName,
        workflowVersion: block.workflowVersion,
        source: block.source,
        ...(block.buildHash === undefined ? {} : { buildHash: block.buildHash }),
        ...(block.city === undefined ? {} : { city: block.city }),
      }
      return identifier(block.blockId)
        && ['pending', 'approved', 'denied', 'expired', 'cancelled', 'invalidated'].includes(block.state)
        && identifier(block.executionId)
        && validateWorkflowContext(workflowContext)
        && nonEmptyString(block.actionSummary, 500)
        && nonnegativeInteger(block.permissionIndex)
        && capabilities.has(block.capability)
        && validateScope(block.capability, block.scope)
        && typeof block.scopeHash === 'string'
        && /^[a-f0-9]{64}$/.test(block.scopeHash)
    }
    case 'workflow_status': {
      if (!hasStrictShape(
        block,
        [
          'type', 'blockId', 'executionId', 'status', 'executionAvailable', 'executionIndex',
          'executionLimit', 'workflowId', 'workflowName', 'workflowVersion', 'source',
        ],
        ['buildHash', 'city', 'errorCode', 'errorSummary'],
      )) return false
      const workflowContext = {
        workflowId: block.workflowId,
        workflowName: block.workflowName,
        workflowVersion: block.workflowVersion,
        source: block.source,
        ...(block.buildHash === undefined ? {} : { buildHash: block.buildHash }),
        ...(block.city === undefined ? {} : { city: block.city }),
      }
      const hasError = block.errorCode !== undefined || block.errorSummary !== undefined
      if ((block.errorCode === undefined) !== (block.errorSummary === undefined)) return false
      if (hasError && (!appErrorCodes.has(block.errorCode) || !nonEmptyString(block.errorSummary, 500))) {
        return false
      }
      if (['queued', 'awaiting_approval'].includes(block.status) && block.executionAvailable) return false
      if (['running', 'completed', 'interrupted'].includes(block.status) && !block.executionAvailable) return false
      if (hasError && ['queued', 'awaiting_approval', 'running'].includes(block.status)) return false
      if (block.errorCode === 'RESULT_TOO_LARGE' && block.status !== 'completed') return false
      if (block.status === 'completed' && hasError && block.errorCode !== 'RESULT_TOO_LARGE') return false
      return identifier(block.blockId)
        && identifier(block.executionId)
        && executionStatuses.has(block.status)
        && typeof block.executionAvailable === 'boolean'
        && positiveInteger(block.executionIndex)
        && positiveInteger(block.executionLimit)
        && block.executionLimit <= 5
        && block.executionIndex <= block.executionLimit
        && validateWorkflowContext(workflowContext)
    }
    case 'workflow_provenance':
      return hasStrictShape(block, ['type', 'blockId', 'entries'])
        && identifier(block.blockId)
        && Array.isArray(block.entries)
        && block.entries.length > 0
        && block.entries.every((entry) => hasStrictShape(
          entry,
          ['workflowId', 'workflowName', 'workflowVersion', 'source', 'executionId', 'status'],
          ['buildHash', 'city'],
        ) && identifier(entry.executionId) && executionStatuses.has(entry.status) && validateWorkflowContext({
          workflowId: entry.workflowId,
          workflowName: entry.workflowName,
          workflowVersion: entry.workflowVersion,
          source: entry.source,
          ...(entry.buildHash === undefined ? {} : { buildHash: entry.buildHash }),
          ...(entry.city === undefined ? {} : { city: entry.city }),
        }))
    case 'workflow_execution':
      return hasStrictShape(block, ['type', 'executionId']) && identifier(block.executionId)
    case 'execution_result':
      return hasStrictShape(block, ['type', 'executionId', 'summary'])
        && identifier(block.executionId) && typeof block.summary === 'string'
    case 'error':
      return hasStrictShape(block, ['type', 'code', 'message'])
        && nonEmptyString(block.code) && nonEmptyString(block.message)
    case 'browser_status':
      return hasStrictShape(
        block,
        ['type', 'blockId', 'requestId', 'bindingId', 'siteLabel', 'origin', 'state'],
        ['actionSummary', 'errorCode'],
      )
        && identifier(block.blockId)
        && identifier(block.requestId)
        && identifier(block.bindingId)
        && nonEmptyString(block.siteLabel, 500)
        && httpsOrigin(block.origin)
        && ['inspecting', 'acting', 'awaiting_user', 'completed', 'failed', 'cancelled'].includes(block.state)
        && (block.actionSummary === undefined || nonEmptyString(block.actionSummary, 500))
        && (block.errorCode === undefined || appErrorCodes.has(block.errorCode))
    case 'media':
      return hasStrictShape(
        block,
        ['type', 'blockId', 'assetId', 'kind', 'purpose', 'name', 'mimeType', 'byteSize'],
        ['width', 'height', 'durationMs'],
      )
        && identifier(block.blockId)
        && identifier(block.assetId)
        && ['image', 'audio', 'video'].includes(block.kind)
        && ['input', 'output'].includes(block.purpose)
        && nonEmptyString(block.name)
        && nonEmptyString(block.mimeType)
        && nonnegativeInteger(block.byteSize)
        && (block.width === undefined || positiveInteger(block.width))
        && (block.height === undefined || positiveInteger(block.height))
        && (block.durationMs === undefined || nonnegativeInteger(block.durationMs))
    case 'media_generation':
      return hasStrictShape(
        block,
        ['type', 'blockId', 'jobId', 'kind', 'status'],
        ['errorCode'],
      )
        && identifier(block.blockId)
        && identifier(block.jobId)
        && ['image', 'audio', 'video'].includes(block.kind)
        && ['pending', 'in_progress', 'downloading', 'paused', 'failed'].includes(block.status)
        && (block.errorCode === undefined || appErrorCodes.has(block.errorCode))
    default:
      return false
  }
}

function validateMessage(value, legacy = false) {
  const optionalKeys = legacy ? ['executionId', 'sourceUnowned'] : ['executionId']
  return hasStrictShape(value, ['id', 'conversationId', 'role', 'blocks', 'createdAt'], optionalKeys)
    && identifier(value.id)
    && identifier(value.conversationId)
    && ['user', 'assistant'].includes(value.role)
    && Array.isArray(value.blocks)
    && value.blocks.every(validateChatBlock)
    && timestamp(value.createdAt)
    && (value.executionId === undefined || identifier(value.executionId))
    && (!legacy || value.sourceUnowned === undefined || typeof value.sourceUnowned === 'boolean')
}

function validateLegacyConfirm(value) {
  if (!hasStrictShape(
    value,
    ['batchId', 'includeUnowned', 'cloudSyncConsent'],
    ['unownedImportConsent'],
  ) || !identifier(value.batchId)
    || typeof value.includeUnowned !== 'boolean'
    || !validateConsent(value.cloudSyncConsent, 'cloud_sync')) return false
  if (value.includeUnowned) {
    return validateConsent(value.unownedImportConsent, 'legacy_unowned_import')
  }
  return value.unownedImportConsent === undefined
}

function validateStoredLegacyReceipt(value) {
  return hasStrictShape(value, ['batchId', 'includeUnowned'])
    && identifier(value.batchId)
    && typeof value.includeUnowned === 'boolean'
}

function validateUsage(value) {
  const commonRequired = [
    'id', 'operationId', 'purpose', 'credentialOwner', 'billable', 'provider', 'model',
    'modality', 'costStatus', 'occurredAt',
  ]
  const tokenKeys = ['inputTokens', 'outputTokens']
  const isEstimated = value?.costStatus === 'estimated'
  if (!hasStrictShape(
    value,
    isEstimated ? [...commonRequired, 'estimatedCostUsd'] : commonRequired,
    tokenKeys,
  )) return false
  return identifier(value.id)
    && identifier(value.operationId)
    && nonEmptyString(value.purpose, 64)
    && value.credentialOwner === 'user'
    && value.billable === false
    && providers.has(value.provider)
    && nonEmptyString(value.model)
    && modalities.has(value.modality)
    && ['estimated', 'unavailable'].includes(value.costStatus)
    && (value.inputTokens === undefined || nonnegativeInteger(value.inputTokens))
    && (value.outputTokens === undefined || nonnegativeInteger(value.outputTokens))
    && (!isEstimated || (typeof value.estimatedCostUsd === 'string'
      && /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/.test(value.estimatedCostUsd)))
    && timestamp(value.occurredAt)
}

function validateMutationPayload(kind, payload) {
  switch (kind) {
    case 'conversation.create':
      return hasStrictShape(
        payload,
        ['title', 'titleState', 'createdAt', 'lastActivityAt', 'metadataUpdatedAt'],
      )
        && nonEmptyString(payload.title)
        && titleStates.has(payload.titleState)
        && timestamp(payload.createdAt)
        && timestamp(payload.lastActivityAt)
        && timestamp(payload.metadataUpdatedAt)
    case 'conversation.rename':
      return hasStrictShape(payload, ['title', 'titleState', 'metadataUpdatedAt'])
        && nonEmptyString(payload.title)
        && titleStates.has(payload.titleState)
        && timestamp(payload.metadataUpdatedAt)
    case 'conversation.delete':
    case 'conversation.restore':
      return hasStrictShape(payload, [])
    case 'message.append':
      return validateMessage(payload)
    case 'legacy.import':
      return validateLegacyConfirm(payload)
    case 'privacy.consent':
      return validateConsent(payload)
    case 'preferences.update':
      return validatePreferences(payload)
    case 'usage.record':
      return validateUsage(payload)
    default:
      return false
  }
}

function mutationEntityMatches(kind, entityId, payload) {
  if (['message.append', 'usage.record'].includes(kind)) return entityId === payload.id
  if (kind === 'legacy.import') return entityId === payload.batchId
  if (kind === 'privacy.consent') return entityId === payload.documentVersion
  return true
}

function validateMutation(value) {
  if (!hasStrictShape(
    value,
    ['id', 'entityId', 'baseRevision', 'occurredAt', 'kind', 'payload'],
  ) || !identifier(value.id)
    || !identifier(value.entityId)
    || !nonnegativeInteger(value.baseRevision)
    || !timestamp(value.occurredAt)
    || !validateMutationPayload(value.kind, value.payload)) return false
  return mutationEntityMatches(value.kind, value.entityId, value.payload)
}

function validateLegacyConversation(value) {
  return hasStrictShape(
    value,
    ['id', 'title', 'titleState', 'createdAt', 'lastActivityAt', 'metadataUpdatedAt'],
    ['sourceUnowned'],
  )
    && identifier(value.id)
    && nonEmptyString(value.title)
    && titleStates.has(value.titleState)
    && timestamp(value.createdAt)
    && timestamp(value.lastActivityAt)
    && timestamp(value.metadataUpdatedAt)
    && (value.sourceUnowned === undefined || typeof value.sourceUnowned === 'boolean')
}

function parseMutationResult(value) {
  if (!hasStrictShape(value, ['id', 'status'], ['revision', 'errorCode'])
    || !identifier(value.id)
    || !['applied', 'duplicate', 'conflict', 'rejected'].includes(value.status)
    || (value.revision !== undefined && !nonnegativeInteger(value.revision))
    || (value.errorCode !== undefined && !appErrorCodes.has(value.errorCode))) return undefined
  return {
    id: value.id,
    status: value.status,
    ...(value.revision === undefined ? {} : { revision: value.revision }),
    ...(value.errorCode === undefined ? {} : { errorCode: value.errorCode }),
  }
}

function parseSyncPushResponse(value) {
  if (!hasStrictShape(value, ['results'], ['cursor'])
    || !Array.isArray(value.results)
    || value.results.length > maximumBatchItems
    || (value.cursor !== undefined && !opaqueCursor(value.cursor))) return undefined
  const results = value.results.map(parseMutationResult)
  if (results.some((result) => result === undefined)) return undefined
  return {
    results,
    ...(value.cursor === undefined ? {} : { cursor: value.cursor }),
  }
}

function parsePulledMutation(value) {
  const payloadIsValid = value?.kind === 'legacy.import'
    ? validateStoredLegacyReceipt(value.payload)
    : validateMutationPayload(value?.kind, value?.payload)
  if (!hasStrictShape(
    value,
    ['id', 'kind', 'entityId', 'baseRevision', 'resultRevision', 'payload', 'receivedAt'],
  )
    || !identifier(value.id)
    || !identifier(value.entityId)
    || !nonnegativeInteger(value.baseRevision)
    || (value.resultRevision !== null && !nonnegativeInteger(value.resultRevision))
    || !payloadIsValid
    || !mutationEntityMatches(value.kind, value.entityId, value.payload)
    || !timestamp(value.receivedAt)) return undefined
  return {
    id: value.id,
    kind: value.kind,
    entityId: value.entityId,
    baseRevision: value.baseRevision,
    resultRevision: value.resultRevision,
    payload: value.kind === 'message.append'
      ? {
          ...cloneValidatedJson(value.payload),
          blocks: value.payload.blocks.map(sanitizeChatBlock),
        }
      : cloneValidatedJson(value.payload),
    receivedAt: value.receivedAt,
  }
}

function parseSyncPullResponse(value) {
  if (!hasStrictShape(value, ['mutations', 'cursor'])
    || !Array.isArray(value.mutations)
    || value.mutations.length > maximumBatchItems
    || (value.cursor !== null && !opaqueCursor(value.cursor))) return undefined
  const mutations = value.mutations.map(parsePulledMutation)
  if (mutations.some((mutation) => mutation === undefined)) return undefined
  return { mutations, cursor: value.cursor }
}

function parseConversationSummary(value) {
  if (!hasStrictShape(value, [
    'id', 'title', 'titleState', 'revision', 'syncState', 'createdAt',
    'lastActivityAt', 'metadataUpdatedAt',
  ])
    || !identifier(value.id)
    || !nonEmptyString(value.title)
    || !titleStates.has(value.titleState)
    || !nonnegativeInteger(value.revision)
    || !['synced', 'pending', 'syncing', 'failed'].includes(value.syncState)
    || !timestamp(value.createdAt)
    || !timestamp(value.lastActivityAt)
    || !timestamp(value.metadataUpdatedAt)) return undefined
  return {
    id: value.id,
    title: value.title,
    titleState: value.titleState,
    revision: value.revision,
    syncState: value.syncState,
    createdAt: value.createdAt,
    lastActivityAt: value.lastActivityAt,
    metadataUpdatedAt: value.metadataUpdatedAt,
  }
}

function parseConversationPage(value) {
  if (!hasStrictShape(value, ['items'], ['nextCursor'])
    || !Array.isArray(value.items)
    || value.items.length > 50
    || (value.nextCursor !== undefined && !opaqueCursor(value.nextCursor))) return undefined
  const items = value.items.map(parseConversationSummary)
  if (items.some((item) => item === undefined)) return undefined
  return { items, ...(value.nextCursor === undefined ? {} : { nextCursor: value.nextCursor }) }
}

function parseMessage(value) {
  if (!validateMessage(value)) return undefined
  return {
    id: value.id,
    conversationId: value.conversationId,
    role: value.role,
    blocks: value.blocks.map(sanitizeChatBlock),
    ...(value.executionId === undefined ? {} : { executionId: value.executionId }),
    createdAt: value.createdAt,
  }
}

function parseMessagePage(value) {
  if (!hasStrictShape(value, ['items'], ['previousCursor'])
    || !Array.isArray(value.items)
    || value.items.length > maximumBatchItems
    || (value.previousCursor !== undefined && !opaqueCursor(value.previousCursor))) return undefined
  const items = value.items.map(parseMessage)
  if (items.some((item) => item === undefined)) return undefined
  return { items, ...(value.previousCursor === undefined ? {} : { previousCursor: value.previousCursor }) }
}

function parseLegacyPreview(value) {
  if (!hasStrictShape(value, ['ownedCount', 'unownedCount', 'requiresUnownedConfirmation'])
    || !nonnegativeInteger(value.ownedCount)
    || !nonnegativeInteger(value.unownedCount)
    || value.requiresUnownedConfirmation !== (value.unownedCount > 0)) return undefined
  return {
    ownedCount: value.ownedCount,
    unownedCount: value.unownedCount,
    requiresUnownedConfirmation: value.requiresUnownedConfirmation,
  }
}

function parseLegacyImportResult(value) {
  if (!isRecord(value) || !identifier(value.batchId)) return undefined
  if (value.status === 'duplicate' && hasStrictShape(value, ['batchId', 'status'])) {
    return { batchId: value.batchId, status: value.status }
  }
  if (value.status === 'rejected'
    && hasStrictShape(value, ['batchId', 'status', 'errorCode'])
    && appErrorCodes.has(value.errorCode)) {
    return { batchId: value.batchId, status: value.status, errorCode: value.errorCode }
  }
  if (value.status === 'applied'
    && hasStrictShape(value, ['batchId', 'status', 'importedConversations', 'importedMessages'])
    && nonnegativeInteger(value.importedConversations)
    && nonnegativeInteger(value.importedMessages)) {
    return {
      batchId: value.batchId,
      status: value.status,
      importedConversations: value.importedConversations,
      importedMessages: value.importedMessages,
    }
  }
  return undefined
}

function parseUsageSnapshot(value) {
  if (!hasStrictShape(value, [
    'startedAt', 'endedAt', 'inputTokens', 'outputTokens', 'estimatedCostUsd',
    'estimatedCount', 'unavailableCount',
  ])
    || !timestamp(value.startedAt)
    || !timestamp(value.endedAt)
    || Date.parse(value.startedAt) >= Date.parse(value.endedAt)
    || !nonnegativeInteger(value.inputTokens)
    || !nonnegativeInteger(value.outputTokens)
    || typeof value.estimatedCostUsd !== 'string'
    || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.estimatedCostUsd)
    || !nonnegativeInteger(value.estimatedCount)
    || !nonnegativeInteger(value.unavailableCount)) return undefined
  return {
    startedAt: value.startedAt,
    endedAt: value.endedAt,
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    estimatedCostUsd: value.estimatedCostUsd,
    estimatedCount: value.estimatedCount,
    unavailableCount: value.unavailableCount,
  }
}

function parsePreferences(value, includeUpdatedAt) {
  const required = ['timezone', 'displayCurrency', 'revision']
  if (includeUpdatedAt) required.push('updatedAt')
  if (!hasStrictShape(value, required)
    || !validatePreferences({ timezone: value.timezone, displayCurrency: value.displayCurrency })
    || !nonnegativeInteger(value.revision)
    || (includeUpdatedAt && !timestamp(value.updatedAt))) return undefined
  return {
    timezone: value.timezone,
    displayCurrency: value.displayCurrency,
    revision: value.revision,
    ...(includeUpdatedAt ? { updatedAt: value.updatedAt } : {}),
  }
}

function parseRpcResponse(name, value) {
  switch (name) {
    case 'autoforge_sync_push': return parseSyncPushResponse(value)
    case 'autoforge_sync_pull': return parseSyncPullResponse(value)
    case 'autoforge_list_conversations': return parseConversationPage(value)
    case 'autoforge_list_messages': return parseMessagePage(value)
    case 'autoforge_preview_legacy_import': return parseLegacyPreview(value)
    case 'autoforge_import_legacy_batch': return parseLegacyImportResult(value)
    case 'autoforge_get_usage_snapshot': return parseUsageSnapshot(value)
    case 'autoforge_get_user_data_preferences': return parsePreferences(value, true)
    case 'autoforge_update_user_data_preferences': return parsePreferences(value, false)
    default: return undefined
  }
}

async function readBoundedJsonResponse(response, signal) {
  if (!response?.headers || typeof response.headers.get !== 'function') {
    throw { code: 'SERVICE_UNAVAILABLE' }
  }
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) throw { code: 'SERVICE_UNAVAILABLE' }
    const declaredBytes = Number(contentLength)
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maximumResponseBytes) {
      throw { code: 'SERVICE_UNAVAILABLE' }
    }
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw { code: 'SERVICE_UNAVAILABLE' }
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let byteCount = 0
  let text = ''
  let complete = false
  let abortListener
  const aborted = new Promise((_, reject) => {
    abortListener = () => reject({ code: 'SERVICE_UNAVAILABLE' })
    if (signal.aborted) abortListener()
    else signal.addEventListener('abort', abortListener, { once: true })
  })

  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), aborted])
      if (!isRecord(chunk) || typeof chunk.done !== 'boolean') {
        throw { code: 'SERVICE_UNAVAILABLE' }
      }
      if (chunk.done) {
        complete = true
        text += decoder.decode()
        break
      }
      if (!(chunk.value instanceof Uint8Array)) throw { code: 'SERVICE_UNAVAILABLE' }
      byteCount += chunk.value.byteLength
      if (byteCount > maximumResponseBytes) throw { code: 'SERVICE_UNAVAILABLE' }
      text += decoder.decode(chunk.value, { stream: true })
    }
    return JSON.parse(text)
  } finally {
    signal.removeEventListener('abort', abortListener)
    if (!complete && typeof reader.cancel === 'function') {
      try {
        Promise.resolve(reader.cancel()).catch(() => undefined)
      } catch {
        // Cancellation is best effort; the caller still returns only a stable error.
      }
    }
    if (typeof reader.releaseLock === 'function') {
      try {
        reader.releaseLock()
      } catch {
        // Releasing an already-closed reader must not change the safe error envelope.
      }
    }
  }
}

function safeErrorCode(error) {
  if (!isRecord(error)) return 'INTERNAL_ERROR'
  if (stableErrorCodes.has(error.code)) return error.code
  if (stableErrorCodes.has(error.message)) return error.message
  return 'INTERNAL_ERROR'
}

function invalid() {
  return { ok: false, error: { code: 'INVALID_INPUT' } }
}

function upgradeRequired() {
  return { ok: false, error: { code: 'UPGRADE_REQUIRED' } }
}

function protocolIsCurrent(event) {
  return event.protocolVersion === 1
}

function createUserDataHandler({ rpc }) {
  return async (rawEvent, context) => {
    const uid = callerUid(context)
    if (!uid) return { ok: false, error: { code: 'AUTH_REQUIRED' } }
    if (!isRecord(rawEvent) || !withinRequestLimit(rawEvent)) return invalid()
    const event = rawEvent

    try {
      if (event.action === 'syncPush') {
        if (!hasStrictShape(event, ['action', 'protocolVersion', 'deviceId', 'mutations'])) return invalid()
        if (!protocolIsCurrent(event)) return upgradeRequired()
        if (!identifier(event.deviceId) || !Array.isArray(event.mutations)) return invalid()
        if (event.mutations.length > maximumBatchItems) {
          return { ok: false, error: { code: 'OUTBOX_LIMIT_EXCEEDED' } }
        }
        if (!event.mutations.every(validateMutation)) return invalid()
        return { ok: true, data: await rpc('autoforge_sync_push', {
          p_caller_user_id: uid,
          p_protocol_version: event.protocolVersion,
          p_device_id: event.deviceId,
          p_mutations: event.mutations,
        }) }
      }

      if (event.action === 'syncPull') {
        if (!hasStrictShape(
          event,
          ['action', 'protocolVersion', 'deviceId'],
          ['cursor', 'limit'],
        )) return invalid()
        if (!protocolIsCurrent(event)) return upgradeRequired()
        const limit = event.limit ?? 100
        if (!identifier(event.deviceId)
          || (event.cursor !== undefined && !opaqueCursor(event.cursor))
          || !positiveInteger(limit)
          || limit > maximumBatchItems) return invalid()
        return { ok: true, data: await rpc('autoforge_sync_pull', {
          p_caller_user_id: uid,
          p_protocol_version: event.protocolVersion,
          p_device_id: event.deviceId,
          p_cursor: event.cursor ?? null,
          p_limit: limit,
        }) }
      }

      if (event.action === 'listConversations') {
        if (!hasStrictShape(event, ['action', 'limit'], ['cursor'])
          || event.limit !== 50
          || (event.cursor !== undefined && !opaqueCursor(event.cursor))) return invalid()
        return { ok: true, data: await rpc('autoforge_list_conversations', {
          p_caller_user_id: uid,
          p_limit: event.limit,
          p_cursor: event.cursor ?? null,
          p_include_deleted: false,
        }) }
      }

      if (event.action === 'listMessages') {
        if (!hasStrictShape(event, ['action', 'conversationId', 'limit'], ['cursor'])
          || !identifier(event.conversationId)
          || event.limit !== 100
          || (event.cursor !== undefined && !opaqueCursor(event.cursor))) return invalid()
        return { ok: true, data: await rpc('autoforge_list_messages', {
          p_caller_user_id: uid,
          p_conversation_id: event.conversationId,
          p_limit: event.limit,
          p_cursor: event.cursor ?? null,
        }) }
      }

      if (event.action === 'previewLegacyImport') {
        if (!hasStrictShape(event, ['action', 'ownedCount', 'unownedCount'])
          || !nonnegativeInteger(event.ownedCount)
          || !nonnegativeInteger(event.unownedCount)) return invalid()
        return { ok: true, data: await rpc('autoforge_preview_legacy_import', {
          p_caller_user_id: uid,
          p_owned_count: event.ownedCount,
          p_unowned_count: event.unownedCount,
        }) }
      }

      if (event.action === 'importLegacyBatch') {
        if (!hasStrictShape(
          event,
          [
            'action', 'protocolVersion', 'deviceId', 'batchId', 'includeUnowned',
            'conversations', 'messages', 'cloudSyncConsent',
          ],
          ['unownedImportConsent'],
        )) return invalid()
        if (!protocolIsCurrent(event)) return upgradeRequired()
        if (!identifier(event.deviceId)
          || !identifier(event.batchId)
          || typeof event.includeUnowned !== 'boolean'
          || !Array.isArray(event.conversations)
          || !Array.isArray(event.messages)
          || event.conversations.length + event.messages.length > maximumBatchItems
          || !event.conversations.every(validateLegacyConversation)
          || !event.messages.every((message) => validateMessage(message, true))
          || !validateConsent(event.cloudSyncConsent, 'cloud_sync')
          || (event.includeUnowned
            ? !validateConsent(event.unownedImportConsent, 'legacy_unowned_import')
            : event.unownedImportConsent !== undefined)
          || (!event.includeUnowned && [
            ...event.conversations, ...event.messages,
          ].some((item) => item.sourceUnowned === true))) return invalid()
        return { ok: true, data: await rpc('autoforge_import_legacy_batch', {
          p_caller_user_id: uid,
          p_protocol_version: event.protocolVersion,
          p_device_id: event.deviceId,
          p_batch_id: event.batchId,
          p_include_unowned: event.includeUnowned,
          p_conversations: event.conversations,
          p_messages: event.messages,
          p_cloud_sync_consent: event.cloudSyncConsent,
          p_unowned_import_consent: event.unownedImportConsent ?? null,
        }) }
      }

      if (event.action === 'recordConsent') {
        if (!hasStrictShape(event, ['action', 'protocolVersion', 'deviceId', 'mutation'])) return invalid()
        if (!protocolIsCurrent(event)) return upgradeRequired()
        if (!identifier(event.deviceId)
          || !validateMutation(event.mutation)
          || event.mutation.kind !== 'privacy.consent') return invalid()
        return { ok: true, data: await rpc('autoforge_sync_push', {
          p_caller_user_id: uid,
          p_protocol_version: event.protocolVersion,
          p_device_id: event.deviceId,
          p_mutations: [event.mutation],
        }) }
      }

      if (event.action === 'getUserDataPreferences') {
        if (!hasStrictShape(event, ['action'])) return invalid()
        return { ok: true, data: await rpc('autoforge_get_user_data_preferences', {
          p_caller_user_id: uid,
        }) }
      }

      if (event.action === 'updateUserDataPreferences') {
        if (!hasStrictShape(
          event,
          ['action', 'timezone', 'displayCurrency', 'expectedRevision'],
        ) || !validatePreferences({
          timezone: event.timezone,
          displayCurrency: event.displayCurrency,
        }) || !nonnegativeInteger(event.expectedRevision)) return invalid()
        return { ok: true, data: await rpc('autoforge_update_user_data_preferences', {
          p_caller_user_id: uid,
          p_timezone: event.timezone,
          p_display_currency: event.displayCurrency,
          p_expected_revision: event.expectedRevision,
        }) }
      }

      if (event.action === 'getUsageSnapshot') {
        if (!hasStrictShape(event, ['action', 'startedAt', 'endedAt'])
          || !timestamp(event.startedAt)
          || !timestamp(event.endedAt)
          || Date.parse(event.startedAt) >= Date.parse(event.endedAt)) return invalid()
        return { ok: true, data: await rpc('autoforge_get_usage_snapshot', {
          p_caller_user_id: uid,
          p_started_at: event.startedAt,
          p_ended_at: event.endedAt,
        }) }
      }

      return invalid()
    } catch (error) {
      return { ok: false, error: { code: safeErrorCode(error) } }
    }
  }
}

function createPostgresRpcClient({ baseUrl, serviceKey, fetchImpl = fetch, timeoutMs = 10_000 }) {
  if (!baseUrl || !serviceKey) throw new Error('CloudBase PostgreSQL RPC is not configured')
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '')
  return async (name, parameters) => {
    if (!allowedRpcNames.has(name)) throw { code: 'INTERNAL_ERROR' }
    const controller = new AbortController()
    const effectiveTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10_000
    let timeoutId
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort()
        reject({ code: 'SERVICE_UNAVAILABLE' })
      }, effectiveTimeoutMs)
    })
    try {
      let response
      try {
        response = await Promise.race([
          fetchImpl(`${normalizedBaseUrl}/rpc/${name}`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${serviceKey}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(parameters),
            signal: controller.signal,
          }),
          timeout,
        ])
      } catch {
        throw { code: 'SERVICE_UNAVAILABLE' }
      }
      let body
      try {
        body = await Promise.race([readBoundedJsonResponse(response, controller.signal), timeout])
      } catch {
        throw { code: 'SERVICE_UNAVAILABLE' }
      }
      if (response.ok) {
        const parsed = parseRpcResponse(name, body)
        if (parsed === undefined) throw { code: 'SERVICE_UNAVAILABLE' }
        return parsed
      }
      const code = safeErrorCode(body)
      if (code !== 'INTERNAL_ERROR') throw { code }
      throw { code: response.status >= 500 ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_ERROR' }
    } finally {
      clearTimeout(timeoutId)
      controller.abort()
    }
  }
}

module.exports = {
  createPostgresRpcClient,
  createUserDataHandler,
}
