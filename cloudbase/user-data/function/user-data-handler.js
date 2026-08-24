/* global Buffer, fetch, module */

const stableErrorCodes = new Set([
  'AUTH_REQUIRED',
  'FORBIDDEN',
  'INVALID_INPUT',
  'SYNC_CONFLICT',
  'UPGRADE_REQUIRED',
  'OUTBOX_LIMIT_EXCEEDED',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
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

function nonEmptyString(value, maximum = 128) {
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

function validateConsent(value, requiredPurpose) {
  return hasStrictShape(value, ['purpose', 'documentVersion', 'consentedAt', 'clientVersion'])
    && consentPurposes.has(value.purpose)
    && (requiredPurpose === undefined || value.purpose === requiredPurpose)
    && nonEmptyString(value.documentVersion)
    && timestamp(value.consentedAt)
    && nonEmptyString(value.clientVersion, 64)
}

function validatePreferences(value) {
  return hasStrictShape(value, ['timezone', 'displayCurrency'])
    && nonEmptyString(value.timezone)
    && ['CNY', 'USD'].includes(value.displayCurrency)
}

function validateScope(capability, scope) {
  if (!isRecord(scope)) return false
  if (capability.startsWith('browser.') || capability === 'network.fetch') {
    return hasStrictShape(scope, ['origins'])
      && Array.isArray(scope.origins)
      && scope.origins.length > 0
      && scope.origins.every((origin) => nonEmptyString(origin, 2048))
  }
  if (capability.startsWith('filesystem.')) {
    return hasStrictShape(scope, ['paths'])
      && Array.isArray(scope.paths)
      && scope.paths.length > 0
      && scope.paths.every((path) => nonEmptyString(path, 2048))
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
      return hasStrictShape(block, ['type', 'label']) && nonEmptyString(block.label, 500)
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
      return identifier(block.blockId)
        && identifier(block.executionId)
        && executionStatuses.has(block.status)
        && typeof block.executionAvailable === 'boolean'
        && positiveInteger(block.executionIndex)
        && positiveInteger(block.executionLimit)
        && block.executionLimit <= 5
        && block.executionIndex <= block.executionLimit
        && validateWorkflowContext(workflowContext)
        && ((block.errorCode === undefined && block.errorSummary === undefined)
          || (nonEmptyString(block.errorCode, 128) && nonEmptyString(block.errorSummary, 500)))
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
        && nonEmptyString(block.code, 128) && nonEmptyString(block.message, 1000)
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
        && nonEmptyString(block.origin, 2048)
        && ['inspecting', 'acting', 'awaiting_user', 'completed', 'failed', 'cancelled'].includes(block.state)
        && (block.actionSummary === undefined || nonEmptyString(block.actionSummary, 500))
        && (block.errorCode === undefined || nonEmptyString(block.errorCode, 128))
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
        && (block.errorCode === undefined || nonEmptyString(block.errorCode, 128))
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
    && nonEmptyString(value.model, 254)
    && modalities.has(value.modality)
    && ['estimated', 'unavailable'].includes(value.costStatus)
    && (value.inputTokens === undefined || nonnegativeInteger(value.inputTokens))
    && (value.outputTokens === undefined || nonnegativeInteger(value.outputTokens))
    && (!isEstimated || (typeof value.estimatedCostUsd === 'string'
      && /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value.estimatedCostUsd)))
    && timestamp(value.occurredAt)
}

function validateMutationPayload(kind, payload) {
  switch (kind) {
    case 'conversation.create':
      return hasStrictShape(
        payload,
        ['title', 'titleState', 'createdAt', 'lastActivityAt', 'metadataUpdatedAt'],
      )
        && nonEmptyString(payload.title, 500)
        && titleStates.has(payload.titleState)
        && timestamp(payload.createdAt)
        && timestamp(payload.lastActivityAt)
        && timestamp(payload.metadataUpdatedAt)
    case 'conversation.rename':
      return hasStrictShape(payload, ['title', 'titleState', 'metadataUpdatedAt'])
        && nonEmptyString(payload.title, 500)
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

function validateMutation(value) {
  if (!hasStrictShape(
    value,
    ['id', 'entityId', 'baseRevision', 'occurredAt', 'kind', 'payload'],
  ) || !identifier(value.id)
    || !identifier(value.entityId)
    || !nonnegativeInteger(value.baseRevision)
    || !timestamp(value.occurredAt)
    || !validateMutationPayload(value.kind, value.payload)) return false
  if (['message.append', 'usage.record'].includes(value.kind)) return value.entityId === value.payload.id
  if (value.kind === 'legacy.import') return value.entityId === value.payload.batchId
  if (value.kind === 'privacy.consent') return value.entityId === value.payload.documentVersion
  return true
}

function validateLegacyConversation(value) {
  return hasStrictShape(
    value,
    ['id', 'title', 'titleState', 'createdAt', 'lastActivityAt', 'metadataUpdatedAt'],
    ['sourceUnowned'],
  )
    && identifier(value.id)
    && nonEmptyString(value.title, 500)
    && titleStates.has(value.titleState)
    && timestamp(value.createdAt)
    && timestamp(value.lastActivityAt)
    && timestamp(value.metadataUpdatedAt)
    && (value.sourceUnowned === undefined || typeof value.sourceUnowned === 'boolean')
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

function createPostgresRpcClient({ baseUrl, serviceKey, fetchImpl = fetch }) {
  if (!baseUrl || !serviceKey) throw new Error('CloudBase PostgreSQL RPC is not configured')
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '')
  return async (name, parameters) => {
    if (!allowedRpcNames.has(name)) throw { code: 'INTERNAL_ERROR' }
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
  createUserDataHandler,
}
