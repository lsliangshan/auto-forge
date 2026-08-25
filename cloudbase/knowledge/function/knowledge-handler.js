/* global Buffer, fetch, module */

const stableErrorCodes = new Set([
  'AUTH_REQUIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'INVALID_INPUT',
  'CONFLICT',
  'CURSOR_STALE',
  'GENERATION_NOT_READY',
  'ENTITLEMENT_REQUIRED',
  'KILL_SWITCH_ENABLED',
  'TRANSIENT_FAILURE',
  'INTERNAL_ERROR',
])
const entityKinds = new Set(['knowledge_base', 'document', 'metadata'])
const operations = new Set(['upsert', 'delete'])

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value, maximum = 128) {
  return typeof value === 'string'
    && value.trim() === value
    && value.length > 0
    && value.length <= maximum
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

function boundedPayload(value) {
  if (!isRecord(value)) return false
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8') <= 64 * 1024 } catch { return false }
}

function safeErrorCode(error) {
  if (!isRecord(error)) return 'INTERNAL_ERROR'
  if (stableErrorCodes.has(error.code)) return error.code
  if (stableErrorCodes.has(error.message)) return error.message
  return 'INTERNAL_ERROR'
}

function parseAction(event, uid) {
  const common = { p_caller_user_id: uid }
  switch (event.action) {
    case 'beginSync':
      if (!nonEmptyString(event.requestId)
        || !nonEmptyString(event.knowledgeBaseId)
        || !nonEmptyString(event.name, 200)
        || !nonEmptyString(event.revision)
        || !nonEmptyString(event.generationId)) return undefined
      return ['autoforge_knowledge_begin_sync', {
        ...common, p_request_id: event.requestId, p_knowledge_base_id: event.knowledgeBaseId,
        p_name: event.name, p_revision: event.revision, p_generation_id: event.generationId,
      }]
    case 'authorizeUpload':
      if (!nonEmptyString(event.requestId)
        || !nonEmptyString(event.knowledgeBaseId)
        || !nonEmptyString(event.documentId)
        || !nonEmptyString(event.versionId)
        || !Number.isSafeInteger(event.byteSize) || event.byteSize <= 0 || event.byteSize > 512 * 1024 * 1024
        || typeof event.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(event.sha256)) return undefined
      return ['autoforge_knowledge_authorize_upload', {
        ...common, p_request_id: event.requestId, p_knowledge_base_id: event.knowledgeBaseId,
        p_document_id: event.documentId, p_version_id: event.versionId,
        p_byte_size: event.byteSize, p_sha256: event.sha256,
      }]
    case 'completeUpload':
      if (!nonEmptyString(event.uploadTicket)) return undefined
      return ['autoforge_knowledge_get_upload', {
        ...common, p_upload_ticket: event.uploadTicket,
      }]
    case 'pushMutation':
      if (!nonEmptyString(event.mutationId)
        || !nonEmptyString(event.knowledgeBaseId)
        || !entityKinds.has(event.entityKind)
        || !nonEmptyString(event.entityId)
        || !operations.has(event.operation)
        || !(event.baseRevision === null || nonEmptyString(event.baseRevision))
        || !boundedPayload(event.payload)) return undefined
      return ['autoforge_knowledge_push_mutation', {
        ...common, p_mutation_id: event.mutationId, p_knowledge_base_id: event.knowledgeBaseId,
        p_entity_kind: event.entityKind, p_entity_id: event.entityId,
        p_operation: event.operation, p_base_revision: event.baseRevision, p_payload: event.payload,
      }]
    case 'pullChanges':
      if (!nonEmptyString(event.knowledgeBaseId)
        || !Number.isSafeInteger(event.afterSequence) || event.afterSequence < 0
        || !Number.isSafeInteger(event.limit) || event.limit < 1 || event.limit > 1000) return undefined
      return ['autoforge_knowledge_pull_changes', {
        ...common, p_knowledge_base_id: event.knowledgeBaseId,
        p_after_sequence: event.afterSequence, p_limit: event.limit,
      }]
    case 'fullResync':
      if (!nonEmptyString(event.knowledgeBaseId)) return undefined
      return ['autoforge_knowledge_full_resync', { ...common, p_knowledge_base_id: event.knowledgeBaseId }]
    case 'publishGeneration':
      if (!nonEmptyString(event.requestId)
        || !nonEmptyString(event.knowledgeBaseId)
        || !nonEmptyString(event.generationId)
        || !(event.expectedPublishedGenerationId === null
          || nonEmptyString(event.expectedPublishedGenerationId))) return undefined
      return ['autoforge_knowledge_publish_generation', {
        ...common, p_request_id: event.requestId, p_knowledge_base_id: event.knowledgeBaseId,
        p_generation_id: event.generationId,
        p_expected_published_generation_id: event.expectedPublishedGenerationId,
      }]
    case 'deleteKnowledgeBase':
      if (!nonEmptyString(event.requestId)
        || !nonEmptyString(event.knowledgeBaseId)
        || !(event.expectedPublishedGenerationId === null
          || nonEmptyString(event.expectedPublishedGenerationId))) return undefined
      return ['autoforge_knowledge_delete_base', {
        ...common, p_request_id: event.requestId, p_knowledge_base_id: event.knowledgeBaseId,
        p_expected_published_generation_id: event.expectedPublishedGenerationId,
      }]
    case 'cancelJob':
      if (!nonEmptyString(event.requestId) || !nonEmptyString(event.jobId)) return undefined
      return ['autoforge_knowledge_cancel_job', {
        ...common, p_request_id: event.requestId, p_job_id: event.jobId,
      }]
    case 'cleanupOrphans':
      if (!nonEmptyString(event.requestId)
        || !nonEmptyString(event.knowledgeBaseId)
        || !Array.isArray(event.storageReferences)
        || event.storageReferences.length < 1 || event.storageReferences.length > 100
        || event.storageReferences.some(reference => !nonEmptyString(reference, 512))) return undefined
      return ['autoforge_knowledge_prepare_orphan_cleanup', {
        ...common, p_request_id: event.requestId, p_knowledge_base_id: event.knowledgeBaseId,
        p_storage_references: event.storageReferences,
      }]
    case 'getJob':
      if (!nonEmptyString(event.jobId)) return undefined
      return ['autoforge_knowledge_get_job', { ...common, p_job_id: event.jobId }]
    case 'getEntitlement':
      return ['autoforge_knowledge_get_entitlement', common]
    default:
      return undefined
  }
}

function createKnowledgeHandler({ rpc, storage }) {
  return async (rawEvent, context) => {
    const uid = callerUid(context)
    if (!uid) return { ok: false, error: { code: 'AUTH_REQUIRED' } }
    const event = isRecord(rawEvent) ? rawEvent : {}
    const parsed = parseAction(event, uid)
    if (!parsed) return { ok: false, error: { code: 'INVALID_INPUT' } }
    try {
      const data = await rpc(parsed[0], parsed[1])
      if (event.action === 'authorizeUpload') {
        if (!storage) throw { code: 'INTERNAL_ERROR' }
        const uploadAuthorization = await storage.createUploadAuthorization({
          uploadTicket: data.uploadTicket,
          storageReference: data.storageReference,
          byteSize: event.byteSize,
          sha256: event.sha256,
          expiresAt: data.expiresAt,
        })
        return { ok: true, data: { ...data, uploadAuthorization } }
      }
      if (event.action === 'completeUpload') {
        if (!storage) throw { code: 'INTERNAL_ERROR' }
        const observed = await storage.statObject(data.storageReference)
        return { ok: true, data: await rpc('autoforge_knowledge_verify_upload', {
          p_caller_user_id: uid, p_upload_ticket: event.uploadTicket,
          p_actual_byte_size: observed.byteSize, p_actual_sha256: observed.sha256,
        }) }
      }
      if (event.action === 'cleanupOrphans') {
        if (!storage) throw { code: 'INTERNAL_ERROR' }
        await storage.deleteObjects(data.storageReferences)
        return { ok: true, data: await rpc('autoforge_knowledge_complete_orphan_cleanup', {
          p_caller_user_id: uid, p_request_id: event.requestId,
          p_knowledge_base_id: event.knowledgeBaseId,
          p_storage_references: data.storageReferences,
        }) }
      }
      return { ok: true, data }
    } catch (error) {
      return { ok: false, error: { code: safeErrorCode(error) } }
    }
  }
}

function createPostgresStorageClient({ baseUrl, serviceKey, fetchImpl = fetch }) {
  if (!baseUrl || !serviceKey) throw new Error('CloudBase PostgreSQL Storage is not configured')
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '')
  async function request(path, body, allowEmpty = false) {
    let response
    try {
      response = await fetchImpl(`${normalizedBaseUrl}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch {
      throw { code: 'TRANSIENT_FAILURE' }
    }
    const result = await response.json().catch(() => undefined)
    if (response.ok && (isRecord(result) || allowEmpty)) return result
    throw { code: response.status >= 500 ? 'TRANSIENT_FAILURE' : 'INTERNAL_ERROR' }
  }
  return {
    createUploadAuthorization(input) {
      return request('/upload-authorizations', input)
    },
    statObject(storageReference) {
      return request('/objects/stat', { storageReference })
    },
    async deleteObjects(storageReferences) {
      await request('/objects/delete', { storageReferences }, true)
    },
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
        headers: { authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(parameters),
      })
    } catch {
      throw { code: 'TRANSIENT_FAILURE' }
    }
    const body = await response.json().catch(() => undefined)
    if (response.ok) return body
    const code = safeErrorCode(body)
    if (code !== 'INTERNAL_ERROR') throw { code }
    throw { code: response.status >= 500 ? 'TRANSIENT_FAILURE' : 'INTERNAL_ERROR' }
  }
}

module.exports = { createKnowledgeHandler, createPostgresRpcClient, createPostgresStorageClient }
