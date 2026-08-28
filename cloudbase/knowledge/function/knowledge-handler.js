/* global AbortController, Buffer, clearTimeout, fetch, module, require, setTimeout, TextDecoder, URL */

const { createHash } = require('node:crypto')

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
const fixedEmbeddingConfiguration = Object.freeze({
  model: 'kinfra-text-embedding-0.6b',
  dimensions: 1024,
  configurationVersion: 'autoforge-knowledge-embedding-v1',
  region: 'guangzhou',
})
const uploadHeaderNames = [
  'content-length', 'content-type', 'x-content-sha256', 'x-upload-ticket',
]
const actionKeys = {
  beginSync: ['action', 'requestId', 'knowledgeBaseId', 'name', 'revision', 'generationId'],
  beginGeneration: ['action', 'requestId', 'knowledgeBaseId', 'name', 'revision', 'generationId'],
  authorizeUpload: ['action', 'requestId', 'knowledgeBaseId', 'documentId', 'versionId', 'byteSize', 'sha256', 'mimeType'],
  completeUpload: ['action', 'uploadTicket'],
  pushMutation: ['action', 'mutationId', 'knowledgeBaseId', 'entityKind', 'entityId', 'operation', 'baseRevision', 'payload'],
  pullChanges: ['action', 'knowledgeBaseId', 'afterSequence', 'limit', 'maxBytes'],
  fullResync: ['action', 'knowledgeBaseId', 'snapshotId', 'afterOrdinal', 'limit', 'maxBytes'],
  listKnowledgeBases: ['action', 'snapshotId', 'afterOrdinal', 'limit', 'maxBytes'],
  publishGeneration: ['action', 'requestId', 'knowledgeBaseId', 'generationId', 'expectedPublishedGenerationId'],
  deleteKnowledgeBase: ['action', 'requestId', 'knowledgeBaseId', 'expectedPublishedGenerationId'],
  cancelJob: ['action', 'requestId', 'jobId'],
  cleanupOrphans: ['action', 'requestId', 'knowledgeBaseId', 'storageReferences'],
  getJob: ['action', 'jobId'],
  getEntitlement: ['action'],
  getEmbeddingConsent: ['action'],
  setEmbeddingConsent: ['action', 'requestId', 'enabled'],
  searchKnowledge: ['action', 'requestId', 'query', 'knowledgeBaseIds', 'limit'],
  beginEmbeddingDriftProbe: [
    'action', 'requestId', 'knowledgeBaseId', 'generationId',
    'expectedPublishedGenerationId',
  ],
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

function boundedSuccess(data) {
  const envelope = { ok: true, data }
  if (safeSerializedSize(envelope) > maximumResponseBytes) throw { code: 'INTERNAL_ERROR' }
  return envelope
}

async function readBoundedJson(response, allowEmpty = false, signal) {
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
    let abortListener
    const aborted = new Promise((_, reject) => {
      abortListener = () => reject({ code: 'TRANSIENT_FAILURE' })
      if (!signal) return
      if (signal.aborted) abortListener()
      else signal.addEventListener('abort', abortListener, { once: true })
    })
    try {
      while (true) {
        const chunk = await (signal ? Promise.race([reader.read(), aborted]) : reader.read())
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
      if (allowEmpty && (response.status === 204 || response.status === 205)
        && text.length === 0) return undefined
      return JSON.parse(text)
    } finally {
      if (signal && abortListener) signal.removeEventListener('abort', abortListener)
      if (!complete && typeof reader.cancel === 'function') {
        try { Promise.resolve(reader.cancel()).catch(() => undefined) } catch {
          /* best-effort transport cleanup */
        }
      }
      if (typeof reader.releaseLock === 'function') {
        try { reader.releaseLock() } catch { /* an already-closed reader is safe */ }
      }
    }
  }
  if (allowEmpty && (response?.status === 204 || response?.status === 205)
    && (!response?.body || typeof response.body.getReader !== 'function')) return undefined
  throw { code: 'INTERNAL_ERROR' }
}

function createNetworkDeadline(timeoutMs) {
  const controller = new AbortController()
  const effectiveTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10_000
  let timeoutId
  const promise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort()
      reject({ code: 'TRANSIENT_FAILURE' })
    }, effectiveTimeoutMs)
  })
  return {
    signal: controller.signal,
    race: operation => Promise.race([operation, promise]),
    dispose() {
      clearTimeout(timeoutId)
      controller.abort()
    },
  }
}

async function boundedPost({ url, headers, body, fetchImpl, timeoutMs, allowEmpty = false }) {
  const deadline = createNetworkDeadline(timeoutMs)
  try {
    let response
    try {
      response = await deadline.race(fetchImpl(url, {
        method: 'POST', headers, body: JSON.stringify(body), signal: deadline.signal,
      }))
    } catch {
      throw { code: 'TRANSIENT_FAILURE' }
    }
    const result = await deadline.race(readBoundedJson(response, allowEmpty, deadline.signal))
    return { response, result }
  } finally {
    deadline.dispose()
  }
}

function isIsoDate(value) {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
}

function validStorageReference(value) {
  return nonEmptyString(value, 512) && value.startsWith('knowledge/') && !value.includes('..')
}

function validStorageSegment(value) {
  return nonEmptyString(value) && /^[A-Za-z0-9_-]+$/.test(value)
}

function canonicalStorageReference(ownerId, knowledgeBaseId, objectId) {
  if (![ownerId, knowledgeBaseId, objectId].every(validStorageSegment)) return undefined
  return `knowledge/${ownerId}/${knowledgeBaseId}/${objectId}`
}

function expectedUploadObjectId(requestId, versionId) {
  return `object_${createHash('md5').update(`${requestId}:${versionId}`).digest('hex')}`
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
    case 'beginGeneration':
      return exactKeys(value, ['knowledgeBaseId', 'generationId', 'status'])
        && nonEmptyString(value.knowledgeBaseId) && nonEmptyString(value.generationId)
        && value.status === 'staging'
    case 'authorizeUpload':
      return exactKeys(value, ['uploadTicket', 'storageReference', 'objectId', 'jobId', 'mimeType', 'expiresAt'])
        && nonEmptyString(value.uploadTicket) && validStorageReference(value.storageReference)
        && nonEmptyString(value.objectId) && nonEmptyString(value.jobId)
        && nonEmptyString(value.mimeType, 200) && isIsoDate(value.expiresAt)
    case 'getUpload':
      return exactKeys(value, [
        'ownerId', 'knowledgeBaseId', 'uploadTicket', 'objectId', 'storageReference',
        'expectedByteSize', 'expectedSha256', 'expectedMimeType',
      ]) && nonEmptyString(value.ownerId, 64) && nonEmptyString(value.knowledgeBaseId)
        && nonEmptyString(value.uploadTicket) && nonEmptyString(value.objectId)
        && validStorageReference(value.storageReference)
        && Number.isSafeInteger(value.expectedByteSize) && value.expectedByteSize > 0
        && typeof value.expectedSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.expectedSha256)
        && nonEmptyString(value.expectedMimeType, 200)
    case 'completeUpload':
      return exactKeys(value, [
        'ownerId', 'knowledgeBaseId', 'uploadTicket', 'objectId', 'storageReference',
        'byteSize', 'sha256', 'mimeType', 'verified',
      ]) && nonEmptyString(value.ownerId, 64) && nonEmptyString(value.knowledgeBaseId)
        && nonEmptyString(value.uploadTicket) && nonEmptyString(value.objectId)
        && validStorageReference(value.storageReference)
        && Number.isSafeInteger(value.byteSize) && value.byteSize > 0
        && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)
        && nonEmptyString(value.mimeType, 200)
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
    case 'listKnowledgeBases': {
      if (!exactKeys(value, [
        'kind', 'snapshotId', 'totalCount', 'nextOrdinal', 'hasMore',
        'knowledgeBaseIds',
      ]) || value.kind !== 'catalog_page' || !nonEmptyString(value.snapshotId)
        || !Number.isSafeInteger(value.totalCount) || value.totalCount < 0
        || value.totalCount > 10000
        || !Number.isSafeInteger(value.nextOrdinal) || value.nextOrdinal < 0
        || value.nextOrdinal > value.totalCount || typeof value.hasMore !== 'boolean'
        || !Array.isArray(value.knowledgeBaseIds) || value.knowledgeBaseIds.length > pageLimit
        || value.knowledgeBaseIds.some(id => !validStorageSegment(id))) return false
      return new Set(value.knowledgeBaseIds).size === value.knowledgeBaseIds.length
    }
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
    case 'getEmbeddingConsent':
      return exactKeys(value, ['state', 'consentEpoch', 'rebuildRequired'])
        && ['granted', 'revoking', 'revoked'].includes(value.state)
        && Number.isSafeInteger(value.consentEpoch) && value.consentEpoch >= 0
        && typeof value.rebuildRequired === 'boolean'
    case 'setEmbeddingConsent':
      return exactKeys(value, ['state', 'consentEpoch', 'vectorsDeleted', 'rebuildRequired'])
        && ['granted', 'revoking', 'revoked'].includes(value.state)
        && Number.isSafeInteger(value.consentEpoch) && value.consentEpoch >= 0
        && Number.isSafeInteger(value.vectorsDeleted) && value.vectorsDeleted >= 0
        && typeof value.rebuildRequired === 'boolean'
    case 'beginEmbeddingDriftProbe':
      return exactKeys(value, [
        'generationId', 'previousGenerationId', 'jobId', 'status',
      ]) && nonEmptyString(value.generationId)
        && nonEmptyString(value.previousGenerationId)
        && nonEmptyString(value.jobId) && value.status === 'staging'
    default:
      return false
  }
}

function validEmbeddingConfiguration(value) {
  return exactKeys(value, ['model', 'dimensions', 'configurationVersion', 'region'])
    && value.model === fixedEmbeddingConfiguration.model
    && value.dimensions === fixedEmbeddingConfiguration.dimensions
    && value.configurationVersion === fixedEmbeddingConfiguration.configurationVersion
    && value.region === fixedEmbeddingConfiguration.region
}

function validCloudCandidate(value, generationByBase) {
  return exactKeys(value, [
    'id', 'knowledgeBaseId', 'documentId', 'versionId', 'generationId',
    'rank', 'body', 'coordinates',
  ]) && nonEmptyString(value.id) && nonEmptyString(value.knowledgeBaseId)
    && nonEmptyString(value.documentId) && nonEmptyString(value.versionId)
    && value.generationId === generationByBase.get(value.knowledgeBaseId)
    && Number.isSafeInteger(value.rank) && value.rank > 0
    && typeof value.body === 'string' && Buffer.byteLength(value.body, 'utf8') <= 64 * 1024
    && isRecord(value.coordinates) && safeSerializedSize(value.coordinates) <= 8 * 1024
}

function validDispatchPermit(value, purpose, requestId, attemptId, consentEpoch) {
  return exactKeys(value, [
    'issued', 'permitId', 'purpose', 'requestId', 'attemptId',
    'consentEpoch', 'expiresAt', 'providerRequestKey', 'embedding',
  ]) && value.issued === true && nonEmptyString(value.permitId)
    && value.purpose === purpose && value.requestId === requestId
    && value.attemptId === attemptId
    && value.consentEpoch === consentEpoch
    && nonEmptyString(value.providerRequestKey)
    && isIsoDate(value.expiresAt) && Date.parse(value.expiresAt) > Date.now()
    && validEmbeddingConfiguration(value.embedding)
}

function validDispatchRecovery(value, purpose, requestId, attemptId, consentEpoch) {
  return exactKeys(value, [
    'state', 'permitId', 'purpose', 'requestId', 'attemptId', 'consentEpoch',
    'providerRequestKey', 'outcome', 'responseHash', 'retryable', 'embedding',
  ]) && ['started', 'settlement_pending', 'completed', 'failed'].includes(value.state)
    && nonEmptyString(value.permitId) && value.purpose === purpose
    && value.requestId === requestId && value.attemptId === attemptId
    && value.consentEpoch === consentEpoch && nonEmptyString(value.providerRequestKey)
    && (value.outcome === null || ['completed', 'failed'].includes(value.outcome))
    && (value.responseHash === null
      || (typeof value.responseHash === 'string' && /^[a-f0-9]{64}$/.test(value.responseHash)))
    && typeof value.retryable === 'boolean'
    && validEmbeddingConfiguration(value.embedding)
}

function dispatchResultHash(result) {
  return createHash('sha256').update(JSON.stringify(result)).digest('hex')
}

async function persistDispatchSettlement({ rpc, parameters, permit, result }) {
  const outcome = result.state
  const responseHash = dispatchResultHash(result)
  const retryable = outcome === 'failed' && result.retryable
  const recorded = await rpc('autoforge_knowledge_record_embedding_dispatch_settlement_intent', {
    ...parameters, p_permit_id: permit.permitId, p_outcome: outcome,
    p_provider_response_hash: responseHash, p_retryable: retryable,
  })
  if (!exactKeys(recorded, ['recorded']) || recorded.recorded !== true) {
    throw { code: 'INTERNAL_ERROR' }
  }
  const settled = await rpc('autoforge_knowledge_settle_embedding_dispatch_attempt', {
    ...parameters, p_permit_id: permit.permitId, p_outcome: outcome,
  })
  if (!exactKeys(settled, ['settled']) || settled.settled !== true) {
    throw { code: 'INTERNAL_ERROR' }
  }
  return { outcome, responseHash, retryable }
}

async function reconcileRevocationAttempt({ rpc, tokenHub, attempt }) {
  if (!exactKeys(attempt, [
    'ownerId', 'state', 'permitId', 'purpose', 'requestId', 'attemptId', 'consentEpoch',
    'providerRequestKey', 'outcome', 'responseHash', 'retryable',
    'knowledgeBaseId', 'generationId', 'chunkId', 'embedding',
  ]) || !nonEmptyString(attempt.ownerId, 64)
    || !['started', 'settlement_pending'].includes(attempt.state)
    || !nonEmptyString(attempt.permitId) || !['query', 'chunk'].includes(attempt.purpose)
    || !nonEmptyString(attempt.requestId)
    || !Number.isSafeInteger(attempt.attemptId) || attempt.attemptId < 1 || attempt.attemptId > 3
    || !Number.isSafeInteger(attempt.consentEpoch) || attempt.consentEpoch < 0
    || !nonEmptyString(attempt.providerRequestKey)
    || (attempt.outcome !== null && !['completed', 'failed'].includes(attempt.outcome))
    || (attempt.responseHash !== null
      && (typeof attempt.responseHash !== 'string' || !/^[a-f0-9]{64}$/.test(attempt.responseHash)))
    || typeof attempt.retryable !== 'boolean'
    || !validEmbeddingConfiguration(attempt.embedding)
    || (attempt.purpose === 'query' && (attempt.knowledgeBaseId !== null
      || attempt.generationId !== null || attempt.chunkId !== null))
    || (attempt.purpose === 'chunk' && (![attempt.knowledgeBaseId,
      attempt.generationId, attempt.chunkId].every(value => nonEmptyString(value))))) {
    throw { code: 'INTERNAL_ERROR' }
  }
  if (!tokenHub || typeof tokenHub.recoverAttempt !== 'function') {
    throw { code: 'TRANSIENT_FAILURE' }
  }
  const recovered = await tokenHub.recoverAttempt({
    model: fixedEmbeddingConfiguration.model,
    dimensions: fixedEmbeddingConfiguration.dimensions,
    configurationVersion: fixedEmbeddingConfiguration.configurationVersion,
    region: fixedEmbeddingConfiguration.region,
    idempotencyKey: attempt.providerRequestKey,
  })
  if (!isRecord(recovered) || !['pending', 'completed', 'failed'].includes(recovered.state)
    || (recovered.state === 'completed' && (!Array.isArray(recovered.vector)
      || recovered.vector.length !== fixedEmbeddingConfiguration.dimensions
      || recovered.vector.some(value => !Number.isFinite(value))))
    || (recovered.state === 'failed' && typeof recovered.retryable !== 'boolean')) {
    throw { code: 'INTERNAL_ERROR' }
  }
  if (recovered.state === 'pending') return false
  const result = recovered.state === 'completed'
    ? { state: 'completed', vector: recovered.vector }
    : { state: 'failed', retryable: recovered.retryable }
  const responseHash = dispatchResultHash(result)
  if ((attempt.outcome !== null && attempt.outcome !== result.state)
    || (attempt.responseHash !== null && attempt.responseHash !== responseHash)
    || (attempt.outcome === 'failed' && attempt.retryable !== result.retryable)) {
    throw { code: 'INTERNAL_ERROR' }
  }
  await persistDispatchSettlement({
    rpc,
    parameters: {
      p_owner_id: attempt.ownerId,
      p_purpose: attempt.purpose,
      p_request_id: attempt.requestId,
      p_attempt_id: attempt.attemptId,
      p_consent_epoch: attempt.consentEpoch,
      p_knowledge_base_id: attempt.knowledgeBaseId,
      p_generation_id: attempt.generationId,
      p_chunk_id: attempt.chunkId,
      p_model: fixedEmbeddingConfiguration.model,
      p_dimensions: fixedEmbeddingConfiguration.dimensions,
      p_configuration_version: fixedEmbeddingConfiguration.configurationVersion,
    },
    permit: attempt,
    result,
  })
  return true
}

async function dispatchEmbedding({
  rpc, tokenHub, input, ownerId, purpose, requestId, consentEpoch,
  knowledgeBaseId = null, generationId = null, chunkId = null,
}) {
  for (let attemptId = 1; attemptId <= 3; attemptId += 1) {
    const parameters = {
      p_owner_id: ownerId,
      p_purpose: purpose,
      p_request_id: requestId,
      p_attempt_id: attemptId,
      p_consent_epoch: consentEpoch,
      p_knowledge_base_id: knowledgeBaseId,
      p_generation_id: generationId,
      p_chunk_id: chunkId,
      p_model: fixedEmbeddingConfiguration.model,
      p_dimensions: fixedEmbeddingConfiguration.dimensions,
      p_configuration_version: fixedEmbeddingConfiguration.configurationVersion,
    }
    const permit = await rpc('autoforge_knowledge_issue_embedding_dispatch_permit', parameters)
    if (exactKeys(permit, ['issued']) && permit.issued === false) continue
    if (exactKeys(permit, ['issued', 'recovery']) && permit.issued === false) {
      const recovery = permit.recovery
      if (!validDispatchRecovery(recovery, purpose, requestId, attemptId, consentEpoch)
        || !tokenHub || typeof tokenHub.recoverAttempt !== 'function') {
        throw { code: 'INTERNAL_ERROR' }
      }
      const recovered = await tokenHub.recoverAttempt({
        model: fixedEmbeddingConfiguration.model,
        dimensions: fixedEmbeddingConfiguration.dimensions,
        configurationVersion: fixedEmbeddingConfiguration.configurationVersion,
        region: fixedEmbeddingConfiguration.region,
        idempotencyKey: recovery.providerRequestKey,
      })
      if (!isRecord(recovered) || !['pending', 'completed', 'failed'].includes(recovered.state)
        || (recovered.state === 'completed' && (!Array.isArray(recovered.vector)
          || recovered.vector.length !== fixedEmbeddingConfiguration.dimensions
          || recovered.vector.some(value => !Number.isFinite(value))))
        || (recovered.state === 'failed' && typeof recovered.retryable !== 'boolean')) {
        throw { code: 'INTERNAL_ERROR' }
      }
      if (recovered.state === 'pending') return { kind: 'provider_failure' }
      const recoveredResult = recovered.state === 'completed'
        ? { state: 'completed', vector: recovered.vector }
        : { state: 'failed', retryable: recovered.retryable }
      const recoveredHash = dispatchResultHash(recoveredResult)
      if ((recovery.outcome !== null && recovery.outcome !== recoveredResult.state)
        || (recovery.responseHash !== null && recovery.responseHash !== recoveredHash)
        || (recovery.outcome === 'failed' && recovery.retryable !== recoveredResult.retryable)) {
        throw { code: 'INTERNAL_ERROR' }
      }
      await persistDispatchSettlement({
        rpc, parameters, permit: recovery, result: recoveredResult,
      })
      if (recoveredResult.state === 'completed') {
        return { kind: 'sent', vector: recoveredResult.vector }
      }
      if (!recoveredResult.retryable) return { kind: 'provider_failure' }
      continue
    }
    if (!validDispatchPermit(permit, purpose, requestId, attemptId, consentEpoch)) {
      throw { code: 'INTERNAL_ERROR' }
    }
    const reservation = await rpc('autoforge_knowledge_reserve_embedding_dispatch_attempt', {
      ...parameters, p_permit_id: permit.permitId,
    })
    if (!exactKeys(reservation, ['reserved']) || typeof reservation.reserved !== 'boolean') {
      throw { code: 'INTERNAL_ERROR' }
    }
    if (!reservation.reserved) continue
    const start = await rpc('autoforge_knowledge_mark_embedding_dispatch_started', {
      ...parameters, p_permit_id: permit.permitId,
    })
    if (!exactKeys(start, ['started']) || typeof start.started !== 'boolean') {
      throw { code: 'INTERNAL_ERROR' }
    }
    if (!start.started) return { kind: 'denied' }
    let vector
    let providerError
    try {
      vector = await tokenHub.embed({
        input,
        model: fixedEmbeddingConfiguration.model,
        dimensions: fixedEmbeddingConfiguration.dimensions,
        configurationVersion: fixedEmbeddingConfiguration.configurationVersion,
        region: fixedEmbeddingConfiguration.region,
        dispatchPermit: permit.permitId,
        idempotencyKey: permit.providerRequestKey,
      })
    } catch (error) {
      providerError = error
    }
    const result = providerError
      ? { state: 'failed', retryable: isRecord(providerError)
        && providerError.code === 'TRANSIENT_FAILURE' }
      : { state: 'completed', vector }
    await persistDispatchSettlement({
      rpc, parameters, permit, result,
    })
    if (!providerError) return { kind: 'sent', vector }
    if (!result.retryable) {
      return { kind: 'provider_failure' }
    }
  }
  return { kind: 'provider_failure' }
}

function validKeywordSearch(value) {
  return safeSerializedSize(value) <= maximumResponseBytes && exactKeys(value, [
    'generations', 'embedding',
    'driftProbeRequired', 'keywordCandidates',
  ]) && Array.isArray(value.generations) && value.generations.length >= 1
    && value.generations.length <= 8
    && value.generations.every(generation => exactKeys(generation, [
      'knowledgeBaseId', 'generationId', 'previousGenerationId',
    ]) && nonEmptyString(generation.knowledgeBaseId)
      && nonEmptyString(generation.generationId)
      && (generation.previousGenerationId === null
        || nonEmptyString(generation.previousGenerationId)))
    && exactKeys(value.embedding, ['model', 'dimensions', 'configurationVersion', 'region'])
    && typeof value.embedding.model === 'string'
    && Number.isSafeInteger(value.embedding.dimensions)
    && typeof value.embedding.configurationVersion === 'string'
    && typeof value.embedding.region === 'string'
    && typeof value.driftProbeRequired === 'boolean'
    && Array.isArray(value.keywordCandidates) && value.keywordCandidates.length <= 24
    && value.keywordCandidates.every(candidate => validCloudCandidate(
      candidate, new Map(value.generations.map(generation => [
        generation.knowledgeBaseId, generation.generationId,
      ])),
    ))
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
    case 'beginGeneration':
      if (!nonEmptyString(event.requestId)
        || !validStorageSegment(event.knowledgeBaseId)
        || !nonEmptyString(event.name, 200)
        || !nonEmptyString(event.revision)
        || !nonEmptyString(event.generationId)) return undefined
      return [event.action === 'beginSync'
        ? 'autoforge_knowledge_begin_sync'
        : 'autoforge_knowledge_begin_generation', {
        ...common, p_request_id: event.requestId, p_knowledge_base_id: event.knowledgeBaseId,
        p_name: event.name, p_revision: event.revision, p_generation_id: event.generationId,
      }]
    case 'authorizeUpload':
      if (!nonEmptyString(event.requestId)
        || !validStorageSegment(event.knowledgeBaseId)
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
    case 'listKnowledgeBases':
      if (!(event.snapshotId === null || nonEmptyString(event.snapshotId))
        || !Number.isSafeInteger(event.afterOrdinal) || event.afterOrdinal < 0
        || !Number.isSafeInteger(event.limit) || event.limit < 1 || event.limit > pageLimit
        || !Number.isSafeInteger(event.maxBytes)
        || event.maxBytes < 65536 || event.maxBytes > maximumPageBytes
        || (event.snapshotId === null && event.afterOrdinal !== 0)) return undefined
      return ['autoforge_knowledge_list_bases', {
        ...common, p_snapshot_id: event.snapshotId,
        p_after_ordinal: event.afterOrdinal, p_limit: event.limit,
        p_max_bytes: event.maxBytes,
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
    case 'getEmbeddingConsent':
      return ['autoforge_knowledge_get_embedding_consent', common]
    case 'setEmbeddingConsent':
      if (!nonEmptyString(event.requestId) || typeof event.enabled !== 'boolean') return undefined
      return ['autoforge_knowledge_set_embedding_consent', {
        ...common, p_request_id: event.requestId, p_enabled: event.enabled,
      }]
    case 'searchKnowledge':
      if (!nonEmptyString(event.requestId) || !nonEmptyString(event.query, 2000)
        || !Array.isArray(event.knowledgeBaseIds)
        || event.knowledgeBaseIds.length < 1 || event.knowledgeBaseIds.length > 8
        || event.knowledgeBaseIds.some(id => !nonEmptyString(id))
        || new Set(event.knowledgeBaseIds).size !== event.knowledgeBaseIds.length
        || !Number.isSafeInteger(event.limit) || event.limit < 1 || event.limit > 24) return undefined
      return ['autoforge_knowledge_get_embedding_consent', common]
    case 'beginEmbeddingDriftProbe':
      if (!nonEmptyString(event.requestId) || !nonEmptyString(event.knowledgeBaseId)
        || !nonEmptyString(event.generationId)
        || !nonEmptyString(event.expectedPublishedGenerationId)) return undefined
      return ['autoforge_knowledge_begin_embedding_drift_probe', {
        ...common, p_request_id: event.requestId,
        p_knowledge_base_id: event.knowledgeBaseId,
        p_generation_id: event.generationId,
        p_expected_published_generation_id: event.expectedPublishedGenerationId,
      }]
    default:
      return undefined
  }
}

function createKnowledgeHandler({ rpc, storage, uploadUrlPrefix, tokenHub }) {
  return async (rawEvent, context) => {
    const uid = callerUid(context)
    if (!uid) return { ok: false, error: { code: 'AUTH_REQUIRED' } }
    const event = isRecord(rawEvent) ? rawEvent : {}
    let parsed
    try { parsed = parseAction(event, uid) } catch { parsed = undefined }
    if (!parsed) return { ok: false, error: { code: 'INVALID_INPUT' } }
    try {
      const data = await rpc(parsed[0], parsed[1])
      if (event.action === 'setEmbeddingConsent' && event.enabled === false
        && isRecord(data) && data.state === 'revoking') {
        if (!validResponse('setEmbeddingConsent', data)) throw { code: 'INTERNAL_ERROR' }
        for (let poll = 0; poll < 3; poll += 1) {
          const recovery = await rpc('autoforge_knowledge_get_embedding_revocation_attempt', {
            p_caller_user_id: uid, p_request_id: event.requestId,
          })
          if (!exactKeys(recovery, ['attempt'])
            || !(recovery.attempt === null || isRecord(recovery.attempt))) {
            throw { code: 'INTERNAL_ERROR' }
          }
          if (recovery.attempt !== null) {
            await reconcileRevocationAttempt({
              rpc, tokenHub, attempt: { ...recovery.attempt, ownerId: uid },
            })
          }
          const finalized = await rpc('autoforge_knowledge_finalize_embedding_revocation', {
            p_caller_user_id: uid, p_request_id: event.requestId,
          })
          if (!validResponse('setEmbeddingConsent', finalized)) {
            throw { code: 'INTERNAL_ERROR' }
          }
          if (finalized.state === 'revoked') return boundedSuccess(finalized)
          if (poll < 2) await new Promise(resolve => setTimeout(resolve, 10))
        }
        throw { code: 'TRANSIENT_FAILURE' }
      }
      if (event.action === 'searchKnowledge') {
        if (!validResponse('getEmbeddingConsent', data)) throw { code: 'INTERNAL_ERROR' }
        const keyword = await rpc('autoforge_knowledge_search_keywords', {
          p_caller_user_id: uid, p_knowledge_base_ids: event.knowledgeBaseIds,
          p_query: event.query, p_limit: event.limit,
        })
        if (!validKeywordSearch(keyword)) throw { code: 'INTERNAL_ERROR' }
        const generationByBase = new Map(keyword.generations.map(generation => [
          generation.knowledgeBaseId, generation.generationId,
        ]))
        if (generationByBase.size !== event.knowledgeBaseIds.length
          || event.knowledgeBaseIds.some(id => !generationByBase.has(id))) {
          throw { code: 'INTERNAL_ERROR' }
        }
        const base = {
          generationState: 'published',
          generations: keyword.generations,
          embedding: keyword.embedding,
          keywordCandidates: keyword.keywordCandidates,
          vectorCandidates: [],
          driftProbeRequired: keyword.driftProbeRequired,
        }
        if (data.state !== 'granted') {
          return boundedSuccess({ ...base, strategy: 'keyword_only_consent' })
        }
        if (data.rebuildRequired || keyword.driftProbeRequired) {
          return boundedSuccess({
            ...base, strategy: 'keyword_only_rebuild', driftProbeRequired: true,
          })
        }
        if (!validEmbeddingConfiguration(keyword.embedding)) {
          return boundedSuccess({
            ...base, strategy: 'keyword_only_rebuild', driftProbeRequired: true,
          })
        }
        if (!tokenHub || typeof tokenHub.embed !== 'function') {
          return boundedSuccess({ ...base, strategy: 'keyword_only_provider' })
        }
        const dispatch = await dispatchEmbedding({
          rpc, tokenHub, input: event.query,
          ownerId: uid, purpose: 'query', requestId: event.requestId,
          consentEpoch: data.consentEpoch,
        })
        if (dispatch.kind === 'denied') {
          return boundedSuccess({ ...base, strategy: 'keyword_only_consent' })
        }
        if (dispatch.kind !== 'sent') {
          return boundedSuccess({ ...base, strategy: 'keyword_only_provider' })
        }
        const vector = dispatch.vector
        if (!Array.isArray(vector) || vector.length !== fixedEmbeddingConfiguration.dimensions
          || vector.some(value => !Number.isFinite(value))) {
          return boundedSuccess({ ...base, strategy: 'keyword_only_provider' })
        }
        const currentConsent = await rpc('autoforge_knowledge_get_embedding_consent', {
          p_caller_user_id: uid,
        })
        if (!validResponse('getEmbeddingConsent', currentConsent)
          || currentConsent.state !== 'granted'
          || currentConsent.consentEpoch !== data.consentEpoch) {
          return boundedSuccess({ ...base, strategy: 'keyword_only_consent' })
        }
        const vectorResult = await rpc('autoforge_knowledge_search_vectors', {
          p_caller_user_id: uid, p_knowledge_base_ids: event.knowledgeBaseIds,
          p_vector: vector,
          p_model: fixedEmbeddingConfiguration.model,
          p_dimensions: fixedEmbeddingConfiguration.dimensions,
          p_configuration_version: fixedEmbeddingConfiguration.configurationVersion,
          p_limit: event.limit,
        })
        if (safeSerializedSize(vectorResult) > maximumResponseBytes
          || !exactKeys(vectorResult, ['vectorCandidates'])
          || !Array.isArray(vectorResult.vectorCandidates)
          || vectorResult.vectorCandidates.length > event.limit
          || vectorResult.vectorCandidates.some(candidate => (
            !validCloudCandidate(candidate, generationByBase)
          ))) throw { code: 'INTERNAL_ERROR' }
        return boundedSuccess({
          ...base, strategy: 'hybrid', vectorCandidates: vectorResult.vectorCandidates,
        })
      }
      if (event.action === 'authorizeUpload') {
        if (!storage) throw { code: 'INTERNAL_ERROR' }
        if (!validResponse('authorizeUpload', data)) throw { code: 'INTERNAL_ERROR' }
        const expectedObjectId = expectedUploadObjectId(event.requestId, event.versionId)
        const expectedReference = canonicalStorageReference(uid, event.knowledgeBaseId, expectedObjectId)
        if (!expectedReference || data.objectId !== expectedObjectId
          || data.storageReference !== expectedReference
          || data.mimeType !== event.mimeType || Date.parse(data.expiresAt) <= Date.now()) {
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
        return boundedSuccess({ ...data, uploadAuthorization })
      }
      if (event.action === 'completeUpload') {
        if (!storage) throw { code: 'INTERNAL_ERROR' }
        if (!validResponse('getUpload', data)) throw { code: 'INTERNAL_ERROR' }
        const expectedReference = canonicalStorageReference(
          data.ownerId, data.knowledgeBaseId, data.objectId,
        )
        if (data.ownerId !== uid || data.uploadTicket !== event.uploadTicket
          || !expectedReference || data.storageReference !== expectedReference) {
          throw { code: 'INTERNAL_ERROR' }
        }
        const observed = await storage.statObject(data.storageReference)
        if (!exactKeys(observed, ['byteSize', 'sha256', 'mimeType'])
          || !Number.isSafeInteger(observed.byteSize) || observed.byteSize <= 0
          || typeof observed.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(observed.sha256)
          || !nonEmptyString(observed.mimeType, 200)
          || observed.byteSize !== data.expectedByteSize
          || observed.sha256 !== data.expectedSha256
          || observed.mimeType !== data.expectedMimeType) throw { code: 'INTERNAL_ERROR' }
        const verified = await rpc('autoforge_knowledge_verify_upload', {
          p_caller_user_id: uid, p_upload_ticket: event.uploadTicket,
          p_knowledge_base_id: data.knowledgeBaseId, p_object_id: data.objectId,
          p_storage_reference: data.storageReference,
          p_expected_byte_size: data.expectedByteSize,
          p_expected_sha256: data.expectedSha256,
          p_expected_mime_type: data.expectedMimeType,
          p_actual_byte_size: observed.byteSize, p_actual_sha256: observed.sha256,
          p_actual_mime_type: observed.mimeType,
        })
        if (!validResponse('completeUpload', verified)
          || verified.ownerId !== uid
          || verified.knowledgeBaseId !== data.knowledgeBaseId
          || verified.uploadTicket !== event.uploadTicket
          || verified.objectId !== data.objectId
          || verified.storageReference !== data.storageReference
          || verified.byteSize !== data.expectedByteSize
          || verified.sha256 !== data.expectedSha256
          || verified.mimeType !== data.expectedMimeType) throw { code: 'INTERNAL_ERROR' }
        return boundedSuccess({
          objectId: verified.objectId,
          storageReference: verified.storageReference,
          verified: true,
        })
      }
      if (event.action === 'cleanupOrphans') {
        if (!storage) throw { code: 'INTERNAL_ERROR' }
        if (!validResponse('prepareCleanup', data)) throw { code: 'INTERNAL_ERROR' }
        if (Object.hasOwn(data, 'removed')) {
          return boundedSuccess({ removed: data.removed })
        }
        await storage.deleteObjects(data.storageReferences)
        const completed = await rpc('autoforge_knowledge_complete_orphan_cleanup', {
          p_caller_user_id: uid, p_request_id: event.requestId,
          p_knowledge_base_id: event.knowledgeBaseId,
          p_storage_references: data.storageReferences,
        })
        if (!validResponse('cleanupOrphans', completed)) throw { code: 'INTERNAL_ERROR' }
        return boundedSuccess(completed)
      }
      if (!validResponse(event.action, data)) throw { code: 'INTERNAL_ERROR' }
      if (event.action === 'listKnowledgeBases'
        && ((event.snapshotId !== null && data.snapshotId !== event.snapshotId)
          || data.nextOrdinal !== event.afterOrdinal + data.knowledgeBaseIds.length
          || data.hasMore !== (data.nextOrdinal < data.totalCount)
          || (data.hasMore && data.knowledgeBaseIds.length === 0))) {
        throw { code: 'INTERNAL_ERROR' }
      }
      if ((event.action === 'pushMutation' && data.mutationId !== event.mutationId)
        || ((event.action === 'beginSync' || event.action === 'beginGeneration')
          && (data.knowledgeBaseId !== event.knowledgeBaseId
            || data.generationId !== event.generationId))
        || (event.action === 'publishGeneration' && data.generationId !== event.generationId)
        || (event.action === 'beginEmbeddingDriftProbe'
          && (data.generationId !== event.generationId
            || data.previousGenerationId !== event.expectedPublishedGenerationId))
        || (event.action === 'getJob' && data.jobId !== event.jobId)) {
        throw { code: 'INTERNAL_ERROR' }
      }
      return boundedSuccess(data)
    } catch (error) {
      return { ok: false, error: { code: safeErrorCode(error) } }
    }
  }
}

function createEmbeddingGenerationWorker({ rpc, tokenHub, maximumChunksPerRun = 24 }) {
  if (!rpc || !tokenHub || typeof tokenHub.embed !== 'function') {
    throw new Error('Embedding worker is not configured')
  }
  if (!Number.isSafeInteger(maximumChunksPerRun)
    || maximumChunksPerRun < 1 || maximumChunksPerRun > 24) {
    throw new Error('Embedding worker batch limit is invalid')
  }
  return {
    async run({ workerId, jobId, leaseToken }) {
      if (![workerId, jobId, leaseToken].every(value => nonEmptyString(value))) {
        throw { code: 'INVALID_INPUT' }
      }
      const batch = await rpc('autoforge_knowledge_claim_embedding_batch', {
        p_worker_id: workerId, p_job_id: jobId, p_lease_token: leaseToken,
        p_limit: maximumChunksPerRun,
      })
      if (safeSerializedSize(batch) > maximumResponseBytes || !exactKeys(batch, [
        'ownerId', 'knowledgeBaseId', 'generationId', 'consentEpoch', 'chunks',
      ]) || !nonEmptyString(batch.ownerId, 64) || !nonEmptyString(batch.knowledgeBaseId)
        || !nonEmptyString(batch.generationId)
        || !Number.isSafeInteger(batch.consentEpoch) || batch.consentEpoch < 0
        || !Array.isArray(batch.chunks) || batch.chunks.length > maximumChunksPerRun
        || batch.chunks.some(chunk => !exactKeys(chunk, ['id', 'versionId', 'body'])
          || !nonEmptyString(chunk.id) || !nonEmptyString(chunk.versionId)
          || typeof chunk.body !== 'string'
          || Buffer.byteLength(chunk.body, 'utf8') > 64 * 1024)) {
        throw { code: 'INTERNAL_ERROR' }
      }
      let embedded = 0
      let currentBatch = batch
      const seenChunkIds = new Set()
      while (true) {
        if (currentBatch.chunks.length === 0) {
          const completed = await rpc('autoforge_knowledge_complete_embedding_generation', {
            p_worker_id: workerId, p_job_id: jobId, p_lease_token: leaseToken,
            p_owner_id: currentBatch.ownerId,
            p_knowledge_base_id: currentBatch.knowledgeBaseId,
            p_generation_id: currentBatch.generationId,
            p_consent_epoch: currentBatch.consentEpoch,
          })
          if (!exactKeys(completed, ['ready']) || completed.ready !== true) {
            throw { code: 'INTERNAL_ERROR' }
          }
          return { state: 'completed', embedded }
        }
        for (const chunk of currentBatch.chunks) {
          const chunkIdentity = `${chunk.versionId.length}:${chunk.versionId}${chunk.id}`
          if (seenChunkIds.has(chunkIdentity)) throw { code: 'INTERNAL_ERROR' }
          seenChunkIds.add(chunkIdentity)
          const dispatch = await dispatchEmbedding({
            rpc, tokenHub, input: chunk.body,
            ownerId: batch.ownerId, purpose: 'chunk',
            requestId: `${jobId}:${chunk.id}`, consentEpoch: batch.consentEpoch,
            knowledgeBaseId: batch.knowledgeBaseId,
            generationId: batch.generationId, chunkId: chunk.id,
          })
          if (dispatch.kind === 'denied') return { state: 'revoked', embedded }
          if (dispatch.kind !== 'sent') throw { code: 'TRANSIENT_FAILURE' }
          const vector = dispatch.vector
          if (!Array.isArray(vector)
            || vector.length !== fixedEmbeddingConfiguration.dimensions
            || vector.some(value => !Number.isFinite(value))) {
            throw { code: 'INVALID_EMBEDDING_RESPONSE' }
          }
          const after = await rpc('autoforge_knowledge_assert_embedding_consent', {
            p_owner_id: batch.ownerId, p_consent_epoch: batch.consentEpoch,
          })
          if (!exactKeys(after, ['enabled', 'consentEpoch'])
            || typeof after.enabled !== 'boolean'
            || !Number.isSafeInteger(after.consentEpoch)
            || !after.enabled || after.consentEpoch !== batch.consentEpoch) {
            return { state: 'revoked', embedded }
          }
          const stored = await rpc('autoforge_knowledge_store_embedding', {
            p_owner_id: batch.ownerId, p_knowledge_base_id: batch.knowledgeBaseId,
            p_generation_id: batch.generationId, p_chunk_id: chunk.id,
            p_version_id: chunk.versionId,
            p_consent_epoch: batch.consentEpoch,
            p_model: fixedEmbeddingConfiguration.model,
            p_dimensions: fixedEmbeddingConfiguration.dimensions,
            p_configuration_version: fixedEmbeddingConfiguration.configurationVersion,
            p_vector: vector,
          })
          if (!exactKeys(stored, ['stored']) || stored.stored !== true) {
            throw { code: 'INTERNAL_ERROR' }
          }
          embedded += 1
        }
        currentBatch = await rpc('autoforge_knowledge_claim_embedding_batch', {
          p_worker_id: workerId, p_job_id: jobId, p_lease_token: leaseToken,
          p_limit: maximumChunksPerRun,
        })
        if (safeSerializedSize(currentBatch) > maximumResponseBytes || !exactKeys(currentBatch, [
          'ownerId', 'knowledgeBaseId', 'generationId', 'consentEpoch', 'chunks',
        ]) || currentBatch.ownerId !== batch.ownerId
          || currentBatch.knowledgeBaseId !== batch.knowledgeBaseId
          || currentBatch.generationId !== batch.generationId
          || currentBatch.consentEpoch !== batch.consentEpoch
          || !Array.isArray(currentBatch.chunks)
          || currentBatch.chunks.length > maximumChunksPerRun
          || currentBatch.chunks.some(chunk => !exactKeys(chunk, ['id', 'versionId', 'body'])
            || !nonEmptyString(chunk.id) || !nonEmptyString(chunk.versionId)
            || typeof chunk.body !== 'string'
            || Buffer.byteLength(chunk.body, 'utf8') > 64 * 1024)) {
          throw { code: 'INTERNAL_ERROR' }
        }
        if (currentBatch.chunks.length > 0) return { state: 'partial', embedded }
      }
    },
  }
}

function createPostgresStorageClient({
  baseUrl, serviceKey, uploadUrlPrefix, fetchImpl = fetch, timeoutMs = 10_000,
}) {
  if (!baseUrl || !serviceKey || !uploadUrlPrefix) {
    throw new Error('CloudBase PostgreSQL Storage is not configured')
  }
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '')
  async function request(path, body, allowEmpty = false) {
    const { response, result } = await boundedPost({
      url: `${normalizedBaseUrl}${path}`,
      headers: { authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' },
      body, fetchImpl, timeoutMs, allowEmpty,
    })
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

function createPostgresRpcClient({ baseUrl, serviceKey, fetchImpl = fetch, timeoutMs = 10_000 }) {
  if (!baseUrl || !serviceKey) throw new Error('CloudBase PostgreSQL RPC is not configured')
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '')
  return async (name, parameters) => {
    const { response, result: body } = await boundedPost({
      url: `${normalizedBaseUrl}/rpc/${name}`,
      headers: { authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' },
      body: parameters, fetchImpl, timeoutMs,
    })
    if (response.ok && isRecord(body)) return body
    const code = safeErrorCode(body)
    if (code !== 'INTERNAL_ERROR') throw { code }
    throw { code: response.status >= 500 ? 'TRANSIENT_FAILURE' : 'INTERNAL_ERROR' }
  }
}

function createTokenHubClient({ endpoint, apiKey, fetchImpl = fetch, timeoutMs = 10_000 }) {
  let parsed
  try { parsed = new URL(endpoint) } catch { parsed = undefined }
  if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password
    || parsed.search || parsed.hash || !apiKey) {
    throw new Error('TokenHub is not configured')
  }
  const statusUrl = new URL(parsed.href)
  statusUrl.pathname = `${statusUrl.pathname.replace(/\/$/, '')}/status`
  function validAttemptIdentity(input) {
    return isRecord(input) && nonEmptyString(input.idempotencyKey)
      && input.model === fixedEmbeddingConfiguration.model
      && input.dimensions === fixedEmbeddingConfiguration.dimensions
      && input.configurationVersion === fixedEmbeddingConfiguration.configurationVersion
      && input.region === fixedEmbeddingConfiguration.region
  }
  return {
    async embed(input) {
      if (!exactKeys(input, [
        'input', 'model', 'dimensions', 'configurationVersion', 'region', 'dispatchPermit',
        'idempotencyKey',
      ])
        || !nonEmptyString(input.input, 64 * 1024)
        || !nonEmptyString(input.dispatchPermit)
        || !validAttemptIdentity(input)) {
        throw { code: 'INVALID_INPUT' }
      }
      const { response, result: body } = await boundedPost({
        url: parsed.href,
        headers: {
          authorization: `Bearer ${apiKey}`, 'content-type': 'application/json',
          'idempotency-key': input.idempotencyKey,
        },
        body: input, fetchImpl, timeoutMs,
      })
      if (!response.ok || !exactKeys(body, ['model', 'dimensions', 'embedding'])
        || body.model !== fixedEmbeddingConfiguration.model
        || body.dimensions !== fixedEmbeddingConfiguration.dimensions
        || !Array.isArray(body.embedding)
        || body.embedding.length !== fixedEmbeddingConfiguration.dimensions
        || body.embedding.some(value => !Number.isFinite(value))) {
        throw { code: response.status >= 500 ? 'TRANSIENT_FAILURE' : 'INTERNAL_ERROR' }
      }
      return body.embedding
    },
    async recoverAttempt(input) {
      if (!exactKeys(input, [
        'model', 'dimensions', 'configurationVersion', 'region', 'idempotencyKey',
      ]) || !validAttemptIdentity(input)) throw { code: 'INVALID_INPUT' }
      const { response, result: body } = await boundedPost({
        url: statusUrl.href,
        headers: {
          authorization: `Bearer ${apiKey}`, 'content-type': 'application/json',
          'idempotency-key': input.idempotencyKey,
        },
        body: input, fetchImpl, timeoutMs,
      })
      if (!response.ok || !isRecord(body)) {
        throw { code: response.status >= 500 ? 'TRANSIENT_FAILURE' : 'INTERNAL_ERROR' }
      }
      if (exactKeys(body, ['status']) && body.status === 'pending') {
        return { state: 'pending' }
      }
      if (exactKeys(body, ['status', 'retryable']) && body.status === 'failed'
        && typeof body.retryable === 'boolean') {
        return { state: 'failed', retryable: body.retryable }
      }
      if (!exactKeys(body, ['status', 'model', 'dimensions', 'embedding'])
        || body.status !== 'completed'
        || body.model !== fixedEmbeddingConfiguration.model
        || body.dimensions !== fixedEmbeddingConfiguration.dimensions
        || !Array.isArray(body.embedding)
        || body.embedding.length !== fixedEmbeddingConfiguration.dimensions
        || body.embedding.some(value => !Number.isFinite(value))) {
        throw { code: 'INTERNAL_ERROR' }
      }
      return { state: 'completed', vector: body.embedding }
    },
  }
}

module.exports = {
  createEmbeddingGenerationWorker,
  createKnowledgeHandler,
  createPostgresRpcClient,
  createPostgresStorageClient,
  createTokenHubClient,
}
