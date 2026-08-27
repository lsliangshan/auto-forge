/* global Buffer, fetch, module, TextDecoder, URL */

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
const maximumResponseBytes = 1024 * 1024
const maximumPageBytes = 786432
const pageLimit = 512
const uploadHeaderNames = [
  'content-length', 'content-type', 'x-content-sha256', 'x-upload-ticket',
]
const actionKeys = {
  beginSync: ['action', 'requestId', 'knowledgeBaseId', 'name', 'revision', 'generationId'],
  authorizeUpload: ['action', 'requestId', 'knowledgeBaseId', 'documentId', 'versionId', 'byteSize', 'sha256', 'mimeType'],
  completeUpload: ['action', 'uploadTicket'],
  pushMutation: ['action', 'mutationId', 'knowledgeBaseId', 'entityKind', 'entityId', 'operation', 'baseRevision', 'payload'],
  pullChanges: ['action', 'knowledgeBaseId', 'afterSequence', 'limit', 'maxBytes'],
  fullResync: ['action', 'knowledgeBaseId', 'snapshotId', 'afterOrdinal', 'limit', 'maxBytes'],
  publishGeneration: ['action', 'requestId', 'knowledgeBaseId', 'generationId', 'expectedPublishedGenerationId'],
  deleteKnowledgeBase: ['action', 'requestId', 'knowledgeBaseId', 'expectedPublishedGenerationId'],
  cancelJob: ['action', 'requestId', 'jobId'],
  cleanupOrphans: ['action', 'requestId', 'knowledgeBaseId', 'storageReferences'],
  getJob: ['action', 'jobId'],
  getEntitlement: ['action'],
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value, maximum = 128) {
  return typeof value === 'string'
    && value.trim() === value
    && value.length > 0
    && value.length <= maximum
}

function exactKeys(value, keys) {
  if (!isRecord(value) || !Array.isArray(keys)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function safeSerializedSize(value) {
  try {
    const encoded = JSON.stringify(value)
    return typeof encoded === 'string' ? Buffer.byteLength(encoded, 'utf8') : Infinity
  } catch {
    return Infinity
  }
}

async function readBoundedJson(response, allowEmpty = false) {
  const contentLength = response?.headers?.get?.('content-length')
  if (contentLength !== undefined && contentLength !== null) {
    if (!/^\d+$/.test(contentLength) || Number(contentLength) > maximumResponseBytes) {
      throw { code: 'INTERNAL_ERROR' }
    }
  }
  if (response?.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let bytes = 0
    let text = ''
    let complete = false
    try {
      while (true) {
        const chunk = await reader.read()
        if (!isRecord(chunk) || typeof chunk.done !== 'boolean') {
          throw { code: 'INTERNAL_ERROR' }
        }
        if (chunk.done) {
          complete = true
          text += decoder.decode()
          break
        }
        if (!(chunk.value instanceof Uint8Array)) throw { code: 'INTERNAL_ERROR' }
        bytes += chunk.value.byteLength
        if (bytes > maximumResponseBytes) throw { code: 'INTERNAL_ERROR' }
        text += decoder.decode(chunk.value, { stream: true })
      }
      if (allowEmpty && text.length === 0) return undefined
      return JSON.parse(text)
    } finally {
      if (!complete && typeof reader.cancel === 'function') {
        try { await reader.cancel() } catch { /* best-effort transport cleanup */ }
      }
      if (typeof reader.releaseLock === 'function') {
        try { reader.releaseLock() } catch { /* an already-closed reader is safe */ }
      }
    }
  }
  throw { code: 'INTERNAL_ERROR' }
}

function isIsoDate(value) {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
}

function validStorageReference(value) {
  return nonEmptyString(value, 512) && value.startsWith('knowledge/') && !value.includes('..')
}

function validUploadAuthorization(value, expected, uploadUrlPrefix) {
  if (!exactKeys(value, ['url', 'method', 'headers', 'expiresAt'])
    || value.method !== 'PUT' || !isRecord(value.headers)
    || !nonEmptyString(uploadUrlPrefix, 2048)) return false
  let expectedUrl
  try {
    const prefix = new URL(uploadUrlPrefix)
    if (prefix.protocol !== 'https:' || prefix.username || prefix.password
      || !prefix.pathname.endsWith('/')) return false
    expectedUrl = new URL(encodeURIComponent(expected.uploadTicket), prefix).href
  } catch {
    return false
  }
  const names = Object.keys(value.headers).map(name => name.toLowerCase()).sort()
  if (value.url !== expectedUrl
    || names.length !== uploadHeaderNames.length
    || names.some((name, index) => name !== uploadHeaderNames[index])
    || value.headers['content-type'] !== expected.mimeType
    || value.headers['content-length'] !== String(expected.byteSize)
    || value.headers['x-content-sha256'] !== expected.sha256
    || value.headers['x-upload-ticket'] !== expected.uploadTicket
    || value.expiresAt !== expected.expiresAt
    || !isIsoDate(value.expiresAt) || Date.parse(value.expiresAt) <= Date.now()) return false
  return true
}

function validChange(value) {
  return exactKeys(value, ['sequence', 'entityKind', 'entityId', 'operation', 'revision', 'payload'])
    && Number.isSafeInteger(value.sequence) && value.sequence >= 0
    && entityKinds.has(value.entityKind) && nonEmptyString(value.entityId)
    && operations.has(value.operation) && nonEmptyString(value.revision)
    && boundedPayload(value.payload)
}

function validSnapshotChanges(changes, nextSequence) {
  if (!Array.isArray(changes) || changes.length > 10000) return false
  const identities = new Set()
  for (const change of changes) {
    const identity = isRecord(change) ? `${change.entityKind}:${change.entityId}` : ''
    if (!validChange(change) || change.sequence !== nextSequence || identities.has(identity)) {
      return false
    }
    identities.add(identity)
  }
  return true
}

function validResponse(action, value) {
  if (safeSerializedSize(value) > maximumResponseBytes || !isRecord(value)) return false
  switch (action) {
    case 'beginSync':
      return exactKeys(value, ['knowledgeBaseId', 'generationId', 'status'])
        && nonEmptyString(value.knowledgeBaseId) && nonEmptyString(value.generationId)
        && value.status === 'staging'
    case 'authorizeUpload':
      return exactKeys(value, ['uploadTicket', 'storageReference', 'objectId', 'jobId', 'mimeType', 'expiresAt'])
        && nonEmptyString(value.uploadTicket) && validStorageReference(value.storageReference)
        && nonEmptyString(value.objectId) && nonEmptyString(value.jobId)
        && nonEmptyString(value.mimeType, 200) && isIsoDate(value.expiresAt)
    case 'getUpload':
      return exactKeys(value, ['objectId', 'storageReference', 'expectedByteSize', 'expectedSha256', 'expectedMimeType'])
        && nonEmptyString(value.objectId) && validStorageReference(value.storageReference)
        && Number.isSafeInteger(value.expectedByteSize) && value.expectedByteSize > 0
        && typeof value.expectedSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.expectedSha256)
        && nonEmptyString(value.expectedMimeType, 200)
    case 'completeUpload':
      return exactKeys(value, ['objectId', 'storageReference', 'verified'])
        && nonEmptyString(value.objectId) && validStorageReference(value.storageReference)
        && value.verified === true
    case 'pushMutation':
      if (!nonEmptyString(value.mutationId) || !Number.isSafeInteger(value.sequence)
        || value.sequence < 0) return false
      if (value.status === 'applied' || value.status === 'duplicate') {
        return exactKeys(value, ['mutationId', 'status', 'sequence', 'revision'])
          && nonEmptyString(value.revision)
      }
      return value.status === 'conflict'
        && exactKeys(value, ['mutationId', 'status', 'conflictKind', 'localRevision', 'remoteRevision', 'sequence'])
        && ['content', 'delete_vs_update'].includes(value.conflictKind)
        && nonEmptyString(value.localRevision) && nonEmptyString(value.remoteRevision)
    case 'pullChanges':
      if (value.kind === 'cursor_stale') return exactKeys(value, ['kind'])
      return exactKeys(value, ['kind', 'nextSequence', 'hasMore', 'changes'])
        && value.kind === 'incremental' && Number.isSafeInteger(value.nextSequence)
        && value.nextSequence >= 0 && typeof value.hasMore === 'boolean'
        && Array.isArray(value.changes) && value.changes.length <= 1000
        && value.changes.every(validChange)
    case 'fullResync':
      return exactKeys(value, [
        'kind', 'snapshotId', 'snapshotSequence', 'nextOrdinal', 'hasMore', 'changes',
      ]) && value.kind === 'snapshot_page' && nonEmptyString(value.snapshotId)
        && Number.isSafeInteger(value.snapshotSequence) && value.snapshotSequence >= 0
        && Number.isSafeInteger(value.nextOrdinal) && value.nextOrdinal >= 0
        && typeof value.hasMore === 'boolean'
        && validSnapshotChanges(value.changes, value.snapshotSequence)
    case 'publishGeneration':
      return exactKeys(value, ['generationId', 'previousGenerationId', 'sequence'])
        && nonEmptyString(value.generationId)
        && (value.previousGenerationId === null || nonEmptyString(value.previousGenerationId))
        && Number.isSafeInteger(value.sequence) && value.sequence >= 0
    case 'deleteKnowledgeBase':
      return exactKeys(value, ['deletionJobId']) && nonEmptyString(value.deletionJobId)
    case 'cancelJob':
      return exactKeys(value, ['cancelled']) && typeof value.cancelled === 'boolean'
    case 'prepareCleanup':
      return (exactKeys(value, ['storageReferences'])
          || exactKeys(value, ['storageReferences', 'removed']))
        && Array.isArray(value.storageReferences)
        && value.storageReferences.length <= 100 && value.storageReferences.every(validStorageReference)
        && (!Object.hasOwn(value, 'removed')
          || (Number.isSafeInteger(value.removed) && value.removed >= 0))
    case 'cleanupOrphans':
      return exactKeys(value, ['removed']) && Number.isSafeInteger(value.removed) && value.removed >= 0
    case 'getJob':
      return exactKeys(value, ['jobId', 'state', 'errorCode']) && nonEmptyString(value.jobId)
        && ['queued', 'running', 'paused', 'completed', 'failed', 'cancelled'].includes(value.state)
        && (value.errorCode === null || nonEmptyString(value.errorCode, 64))
    case 'getEntitlement':
      return exactKeys(value, ['tier', 'status', 'betaEnabled', 'cloudEnabled', 'killSwitchEnabled', 'version', 'validUntil'])
        && ['free', 'member'].includes(value.tier)
        && ['active', 'offline_grace', 'expired', 'unavailable'].includes(value.status)
        && typeof value.betaEnabled === 'boolean' && typeof value.cloudEnabled === 'boolean'
        && typeof value.killSwitchEnabled === 'boolean'
        && Number.isSafeInteger(value.version) && value.version >= 0
        && (value.validUntil === null || isIsoDate(value.validUntil))
    default:
      return false
  }
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
  if (typeof event.action !== 'string' || !Object.hasOwn(actionKeys, event.action)) return undefined
  const keys = actionKeys[event.action]
  if (!keys || !exactKeys(event, keys)) return undefined
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
        || typeof event.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(event.sha256)
        || !nonEmptyString(event.mimeType, 200)) return undefined
      return ['autoforge_knowledge_authorize_upload', {
        ...common, p_request_id: event.requestId, p_knowledge_base_id: event.knowledgeBaseId,
        p_document_id: event.documentId, p_version_id: event.versionId,
        p_byte_size: event.byteSize, p_sha256: event.sha256, p_mime_type: event.mimeType,
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
        || !Number.isSafeInteger(event.limit) || event.limit < 1 || event.limit > pageLimit
        || !Number.isSafeInteger(event.maxBytes)
        || event.maxBytes < 65536 || event.maxBytes > maximumPageBytes) return undefined
      return ['autoforge_knowledge_pull_changes', {
        ...common, p_knowledge_base_id: event.knowledgeBaseId,
        p_after_sequence: event.afterSequence, p_limit: event.limit,
        p_max_bytes: event.maxBytes,
      }]
    case 'fullResync':
      if (!nonEmptyString(event.knowledgeBaseId)
        || !(event.snapshotId === null || nonEmptyString(event.snapshotId))
        || !Number.isSafeInteger(event.afterOrdinal) || event.afterOrdinal < 0
        || !Number.isSafeInteger(event.limit) || event.limit < 1 || event.limit > pageLimit
        || !Number.isSafeInteger(event.maxBytes)
        || event.maxBytes < 65536 || event.maxBytes > maximumPageBytes) return undefined
      return ['autoforge_knowledge_full_resync', {
        ...common, p_knowledge_base_id: event.knowledgeBaseId,
        p_snapshot_id: event.snapshotId, p_after_ordinal: event.afterOrdinal,
        p_limit: event.limit, p_max_bytes: event.maxBytes,
      }]
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

function createKnowledgeHandler({ rpc, storage, uploadUrlPrefix }) {
  return async (rawEvent, context) => {
    const uid = callerUid(context)
    if (!uid) return { ok: false, error: { code: 'AUTH_REQUIRED' } }
    const event = isRecord(rawEvent) ? rawEvent : {}
    let parsed
    try { parsed = parseAction(event, uid) } catch { parsed = undefined }
    if (!parsed) return { ok: false, error: { code: 'INVALID_INPUT' } }
    try {
      const data = await rpc(parsed[0], parsed[1])
      if (event.action === 'authorizeUpload') {
        if (!storage) throw { code: 'INTERNAL_ERROR' }
        if (!validResponse('authorizeUpload', data)) throw { code: 'INTERNAL_ERROR' }
        if (data.mimeType !== event.mimeType || Date.parse(data.expiresAt) <= Date.now()) {
          throw { code: 'INTERNAL_ERROR' }
        }
        const uploadAuthorization = await storage.createUploadAuthorization({
          uploadTicket: data.uploadTicket,
          storageReference: data.storageReference,
          byteSize: event.byteSize,
          sha256: event.sha256,
          mimeType: event.mimeType,
          expiresAt: data.expiresAt,
        })
        if (!validUploadAuthorization(uploadAuthorization, {
          uploadTicket: data.uploadTicket,
          byteSize: event.byteSize,
          sha256: event.sha256,
          mimeType: event.mimeType,
          expiresAt: data.expiresAt,
        }, uploadUrlPrefix)) {
          throw { code: 'INTERNAL_ERROR' }
        }
        return { ok: true, data: { ...data, uploadAuthorization } }
      }
      if (event.action === 'completeUpload') {
        if (!storage) throw { code: 'INTERNAL_ERROR' }
        if (!validResponse('getUpload', data)) throw { code: 'INTERNAL_ERROR' }
        const observed = await storage.statObject(data.storageReference)
        if (!exactKeys(observed, ['byteSize', 'sha256', 'mimeType'])
          || !Number.isSafeInteger(observed.byteSize) || observed.byteSize <= 0
          || typeof observed.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(observed.sha256)
          || !nonEmptyString(observed.mimeType, 200)) throw { code: 'INTERNAL_ERROR' }
        const verified = await rpc('autoforge_knowledge_verify_upload', {
          p_caller_user_id: uid, p_upload_ticket: event.uploadTicket,
          p_actual_byte_size: observed.byteSize, p_actual_sha256: observed.sha256,
          p_actual_mime_type: observed.mimeType,
        })
        if (!validResponse('completeUpload', verified)) throw { code: 'INTERNAL_ERROR' }
        return { ok: true, data: verified }
      }
      if (event.action === 'cleanupOrphans') {
        if (!storage) throw { code: 'INTERNAL_ERROR' }
        if (!validResponse('prepareCleanup', data)) throw { code: 'INTERNAL_ERROR' }
        if (Object.hasOwn(data, 'removed')) {
          return { ok: true, data: { removed: data.removed } }
        }
        await storage.deleteObjects(data.storageReferences)
        const completed = await rpc('autoforge_knowledge_complete_orphan_cleanup', {
          p_caller_user_id: uid, p_request_id: event.requestId,
          p_knowledge_base_id: event.knowledgeBaseId,
          p_storage_references: data.storageReferences,
        })
        if (!validResponse('cleanupOrphans', completed)) throw { code: 'INTERNAL_ERROR' }
        return { ok: true, data: completed }
      }
      if (!validResponse(event.action, data)) throw { code: 'INTERNAL_ERROR' }
      if ((event.action === 'pushMutation' && data.mutationId !== event.mutationId)
        || (event.action === 'beginSync'
          && (data.knowledgeBaseId !== event.knowledgeBaseId
            || data.generationId !== event.generationId))
        || (event.action === 'publishGeneration' && data.generationId !== event.generationId)
        || (event.action === 'getJob' && data.jobId !== event.jobId)) {
        throw { code: 'INTERNAL_ERROR' }
      }
      return { ok: true, data }
    } catch (error) {
      return { ok: false, error: { code: safeErrorCode(error) } }
    }
  }
}

function createPostgresStorageClient({
  baseUrl, serviceKey, uploadUrlPrefix, fetchImpl = fetch,
}) {
  if (!baseUrl || !serviceKey || !uploadUrlPrefix) {
    throw new Error('CloudBase PostgreSQL Storage is not configured')
  }
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
    const result = await readBoundedJson(response, allowEmpty)
    if (response.ok && (isRecord(result) || allowEmpty)) return result
    throw { code: response.status >= 500 ? 'TRANSIENT_FAILURE' : 'INTERNAL_ERROR' }
  }
  return {
    async createUploadAuthorization(input) {
      const result = await request('/upload-authorizations', input)
      if (!validUploadAuthorization(result, input, uploadUrlPrefix)) {
        throw { code: 'INTERNAL_ERROR' }
      }
      return result
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
    const body = await readBoundedJson(response)
    if (response.ok && isRecord(body)) return body
    const code = safeErrorCode(body)
    if (code !== 'INTERNAL_ERROR') throw { code }
    throw { code: response.status >= 500 ? 'TRANSIENT_FAILURE' : 'INTERNAL_ERROR' }
  }
}

module.exports = { createKnowledgeHandler, createPostgresRpcClient, createPostgresStorageClient }
