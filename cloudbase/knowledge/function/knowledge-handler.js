/* global AbortController, Buffer, clearTimeout, fetch, module, require, setTimeout */

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
  'EMBEDDING_CONSENT_REQUIRED',
  'EMBEDDING_MODEL_INVALID',
  'TRANSIENT_FAILURE',
  'INTERNAL_ERROR',
])
const entityKinds = new Set(['knowledge_base', 'document', 'metadata'])
const operations = new Set(['upsert', 'delete'])
const embeddingConsentStatuses = new Set(['granted', 'denied', 'revoked'])
const { createHash } = require('node:crypto')
const {
  EMBEDDING_CONFIGURATION,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_DRIFT_PROBE,
  EMBEDDING_MODEL,
  EXACT_COSINE_MAX_CHUNKS,
  embeddingFingerprint,
  exactCosineRank,
  reciprocalRankFusion,
  validEmbedding,
} = require('./hybrid-retrieval.js')

const EMBEDDING_SEND_TIMEOUT_MS = 20_000
const EMBEDDING_RELEASE_TIMEOUT_MS = 2_000
const EMBEDDING_RELEASE_ATTEMPTS = 2

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

function internalRequestId(namespace, value) {
  return `${namespace}_${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

function uniqueIdentifiers(value, maximum = 32) {
  return Array.isArray(value)
    && value.length >= 1
    && value.length <= maximum
    && value.every(item => nonEmptyString(item))
    && new Set(value).size === value.length
}

function generationSnapshot(value) {
  return Array.isArray(value)
    && value.length >= 1
    && value.length <= 32
    && value.every(item => isRecord(item)
      && nonEmptyString(item.knowledgeBaseId)
      && nonEmptyString(item.generationId))
    && new Set(value.map(item => item.knowledgeBaseId)).size === value.length
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
    case 'getEmbeddingConsent':
      return ['autoforge_knowledge_get_embedding_consent', common]
    case 'setEmbeddingConsent':
      if (!nonEmptyString(event.requestId)
        || !embeddingConsentStatuses.has(event.status)) return undefined
      return ['autoforge_knowledge_set_embedding_consent', {
        ...common, p_request_id: event.requestId, p_status: event.status,
      }]
    case 'capturePublishedSnapshot':
      if (!uniqueIdentifiers(event.knowledgeBaseIds)) return undefined
      return ['autoforge_knowledge_capture_published_snapshot', {
        ...common, p_knowledge_base_ids: event.knowledgeBaseIds,
      }]
    case 'searchPublished':
      if (!nonEmptyString(event.query, 1000)
        || !generationSnapshot(event.generationSnapshot)
        || !Number.isSafeInteger(event.topK) || event.topK < 1 || event.topK > 8) return undefined
      return ['autoforge_knowledge_search_published', {
        ...common, p_query: event.query, p_snapshot: event.generationSnapshot,
        p_keyword_limit: 32, p_exact_cosine_max_chunks: EXACT_COSINE_MAX_CHUNKS,
      }]
    case 'buildEmbeddingGeneration':
      if (!nonEmptyString(event.requestId)
        || !nonEmptyString(event.knowledgeBaseId)
        || !nonEmptyString(event.generationId)
        || !(event.expectedPublishedGenerationId === null
          || nonEmptyString(event.expectedPublishedGenerationId))) return undefined
      return ['autoforge_knowledge_prepare_embedding_generation', {
        ...common, p_request_id: event.requestId,
        p_knowledge_base_id: event.knowledgeBaseId,
        p_generation_id: event.generationId,
        p_expected_published_generation_id: event.expectedPublishedGenerationId,
        p_model: EMBEDDING_MODEL, p_configuration: EMBEDDING_CONFIGURATION,
      }]
    case 'probeEmbeddingDrift':
      if (!nonEmptyString(event.requestId)
        || !nonEmptyString(event.knowledgeBaseId)
        || !nonEmptyString(event.generationId)
        || !(event.expectedPublishedGenerationId === null
          || nonEmptyString(event.expectedPublishedGenerationId))) return undefined
      return ['autoforge_knowledge_get_embedding_consent', common]
    default:
      return undefined
  }
}

function safeCandidate(candidate, allowedGenerations) {
  if (!isRecord(candidate)
    || !nonEmptyString(candidate.chunkId)
    || !nonEmptyString(candidate.generationId)
    || !allowedGenerations.has(candidate.generationId)
    || !isRecord(candidate.evidence)
    || !nonEmptyString(candidate.evidence.knowledgeBaseId)) return undefined
  const expectedBase = allowedGenerations.get(candidate.generationId)
  return candidate.evidence.knowledgeBaseId === expectedBase ? candidate : undefined
}

function safeCandidates(value, allowedGenerations) {
  if (!Array.isArray(value) || value.length > EXACT_COSINE_MAX_CHUNKS) return []
  return value.map(candidate => safeCandidate(candidate, allowedGenerations)).filter(Boolean)
}

function safeVectorRows(value, allowedGenerations) {
  if (!Array.isArray(value) || value.length > EXACT_COSINE_MAX_CHUNKS) return []
  return value.map((row) => {
    if (!isRecord(row) || !validEmbedding(row.embedding)) return undefined
    const candidate = safeCandidate(row.candidate, allowedGenerations)
    return candidate ? { candidate, embedding: row.embedding } : undefined
  }).filter(Boolean)
}

function embeddingResponse(value, expectedCount) {
  if (!isRecord(value)
    || value.model !== EMBEDDING_MODEL
    || value.dimensions !== EMBEDDING_DIMENSIONS
    || !Array.isArray(value.vectors)
    || value.vectors.length !== expectedCount
    || value.vectors.some(vector => !validEmbedding(vector))) return undefined
  return value.vectors
}

function safeLog(logger, event, fields) {
  try { logger?.info(event, fields) } catch { /* Diagnostics cannot affect retrieval. */ }
}

function degradationFor(error) {
  if (isRecord(error) && error.code === 'EMBEDDING_CONSENT_REQUIRED') {
    return 'consent_unavailable'
  }
  return isRecord(error) && error.code === 'MODEL_DEPRECATED'
    ? 'model_deprecated'
    : 'provider_unavailable'
}

async function withTimeout(promise, timeoutMs, onTimeout) {
  let timeout
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          try { onTimeout?.() } catch { /* Timeout remains authoritative. */ }
          reject({ code: 'TRANSIENT_FAILURE' })
        }, timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

async function releaseEmbeddingSend({ uid, rpc, authorization, releaseTimeoutMs }) {
  for (let attempt = 0; attempt < EMBEDDING_RELEASE_ATTEMPTS; attempt += 1) {
    try {
      const completed = await withTimeout(
        rpc('autoforge_knowledge_complete_embedding_send', {
          p_caller_user_id: uid,
          p_lease_token: authorization.leaseToken,
          p_consent_epoch: authorization.consentEpoch,
        }),
        releaseTimeoutMs,
      )
      if (isRecord(completed)
        && completed.released === true
        && completed.state === 'released') return true
    } catch { /* Retry once; the SQL transition is idempotent. */ }
  }
  return false
}

async function withEmbeddingSendAuthorization({
  uid, rpc, purpose, send, now, embeddingTimeoutMs, releaseTimeoutMs,
}) {
  const authorization = await rpc('autoforge_knowledge_begin_embedding_send', {
    p_caller_user_id: uid,
    p_purpose: purpose,
  })
  if (!isRecord(authorization)
    || !nonEmptyString(authorization.leaseToken)
    || !Number.isSafeInteger(authorization.consentEpoch)
    || authorization.consentEpoch < 0) throw { code: 'INTERNAL_ERROR' }
  const started = await rpc('autoforge_knowledge_start_embedding_send', {
    p_caller_user_id: uid,
    p_lease_token: authorization.leaseToken,
    p_consent_epoch: authorization.consentEpoch,
  })
  if (isRecord(started) && started.started === false) {
    throw { code: 'EMBEDDING_CONSENT_REQUIRED' }
  }
  if (!isRecord(started)
    || started.started !== true
    || started.state !== 'sending'
    || !Number.isSafeInteger(started.sendDeadlineMs)
    || started.sendDeadlineMs <= now()) throw { code: 'INTERNAL_ERROR' }
  const controller = new AbortController()
  const timeoutMs = Math.min(embeddingTimeoutMs, started.sendDeadlineMs - now())
  let response
  let sendError
  try {
    response = await withTimeout(
      Promise.resolve().then(() => {
        if (started.sendDeadlineMs <= now()) throw { code: 'EMBEDDING_CONSENT_REQUIRED' }
        return send(controller.signal, started.sendDeadlineMs)
      }),
      timeoutMs,
      () => controller.abort(),
    )
  } catch (error) {
    sendError = error
  }
  const released = await releaseEmbeddingSend({
    uid, rpc, authorization, releaseTimeoutMs,
  })
  if (sendError) throw sendError
  if (!released) throw { code: 'TRANSIENT_FAILURE' }
  return response
}

async function searchPublished({
  event, data, uid, rpc, embeddings, logger, now, embeddingTimeoutMs, releaseTimeoutMs,
}) {
  const allowedGenerations = new Map(
    event.generationSnapshot.map(item => [item.generationId, item.knowledgeBaseId]),
  )
  const keywordCandidates = safeCandidates(data?.keywordCandidates, allowedGenerations)
  const consent = data?.embeddingConsentStatus
  if (consent !== 'granted') {
    const results = reciprocalRankFusion(keywordCandidates, [], event.topK)
    safeLog(logger, 'knowledge_cloud_retrieval_completed', {
      mode: 'keyword_only', degradationReason: 'consent_unavailable',
      generationCount: allowedGenerations.size, resultCount: results.length,
    })
    return { mode: 'keyword_only', degradationReason: 'consent_unavailable', results }
  }
  if (data.vectorEligible === false) {
    const results = reciprocalRankFusion(keywordCandidates, [], event.topK)
    safeLog(logger, 'knowledge_cloud_retrieval_completed', {
      mode: 'keyword_only', degradationReason: 'small_index_limit',
      generationCount: allowedGenerations.size, resultCount: results.length,
    })
    return { mode: 'keyword_only', degradationReason: 'small_index_limit', results }
  }
  try {
    if (!embeddings) throw { code: 'TRANSIENT_FAILURE' }
    const response = await withEmbeddingSendAuthorization({
      uid, rpc, purpose: 'query',
      now, embeddingTimeoutMs, releaseTimeoutMs,
      send: (signal, sendDeadlineMs) => embeddings.embed({
        model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS, inputs: [event.query],
        signal, sendDeadlineMs,
      }),
    })
    const vectors = embeddingResponse(response, 1)
    if (!vectors) throw { code: 'EMBEDDING_MODEL_INVALID' }
    const vectorRows = safeVectorRows(data?.vectorRows, allowedGenerations)
    const vectorCandidates = exactCosineRank(vectors[0], vectorRows, 32)
      .map(({ candidate }) => candidate)
    const results = reciprocalRankFusion(keywordCandidates, vectorCandidates, event.topK)
    safeLog(logger, 'knowledge_cloud_retrieval_completed', {
      mode: 'hybrid', degradationReason: null,
      generationCount: allowedGenerations.size, resultCount: results.length,
    })
    return { mode: 'hybrid', degradationReason: null, results }
  } catch (error) {
    const degradationReason = degradationFor(error)
    const results = reciprocalRankFusion(keywordCandidates, [], event.topK)
    safeLog(logger, 'knowledge_cloud_retrieval_completed', {
      mode: 'keyword_only', degradationReason,
      generationCount: allowedGenerations.size, resultCount: results.length,
    })
    return { mode: 'keyword_only', degradationReason, results }
  }
}

async function buildEmbeddingGeneration({
  event, data, uid, rpc, embeddings, logger, now, embeddingTimeoutMs, releaseTimeoutMs,
}) {
  if (!isRecord(data) || data.consentStatus !== 'granted'
    || data.generationId !== event.generationId
    || !Array.isArray(data.chunks)
    || data.chunks.length > EXACT_COSINE_MAX_CHUNKS
    || data.chunks.some(chunk => !isRecord(chunk)
      || !nonEmptyString(chunk.chunkId)
      || !nonEmptyString(chunk.body, 8000))) {
    throw { code: data?.consentStatus === 'denied' || data?.consentStatus === 'revoked'
      ? 'EMBEDDING_CONSENT_REQUIRED' : 'INTERNAL_ERROR' }
  }
  let failureCode = 'TRANSIENT_FAILURE'
  let ready = false
  try {
    if (!embeddings) throw { code: 'TRANSIENT_FAILURE' }
    const suppliedProbe = validEmbedding(data.probeVector) ? data.probeVector : undefined
    const inputs = suppliedProbe
      ? data.chunks.map(chunk => chunk.body)
      : [EMBEDDING_DRIFT_PROBE, ...data.chunks.map(chunk => chunk.body)]
    let vectors = []
    if (inputs.length > 0) {
      const response = await withEmbeddingSendAuthorization({
        uid, rpc, purpose: 'index',
        now, embeddingTimeoutMs, releaseTimeoutMs,
        send: (signal, sendDeadlineMs) => embeddings.embed({
          model: EMBEDDING_MODEL,
          dimensions: EMBEDDING_DIMENSIONS,
          inputs,
          signal,
          sendDeadlineMs,
        }),
      })
      vectors = embeddingResponse(response, inputs.length)
    }
    if (!vectors) {
      failureCode = 'EMBEDDING_MODEL_INVALID'
      throw { code: failureCode }
    }
    const probeVector = suppliedProbe ?? vectors[0]
    const chunkVectors = suppliedProbe ? vectors : vectors.slice(1)
    const completed = await rpc('autoforge_knowledge_complete_embedding_generation', {
      p_caller_user_id: uid,
      p_request_id: event.requestId,
      p_knowledge_base_id: event.knowledgeBaseId,
      p_generation_id: event.generationId,
      p_model: EMBEDDING_MODEL,
      p_configuration: EMBEDDING_CONFIGURATION,
      p_probe_fingerprint: embeddingFingerprint(probeVector),
      p_embeddings: data.chunks.map((chunk, index) => ({
        chunkId: chunk.chunkId, embedding: chunkVectors[index],
      })),
    })
    if (!isRecord(completed)
      || completed.generationId !== event.generationId
      || completed.status !== 'ready') {
      failureCode = 'EMBEDDING_MODEL_INVALID'
      throw { code: failureCode }
    }
    ready = true
    const published = await rpc('autoforge_knowledge_publish_generation', {
      p_caller_user_id: uid,
      p_request_id: internalRequestId('embedding_publish', event.requestId),
      p_knowledge_base_id: event.knowledgeBaseId,
      p_generation_id: event.generationId,
      p_expected_published_generation_id: event.expectedPublishedGenerationId,
    })
    if (!isRecord(published)
      || published.generationId !== event.generationId
      || !Number.isSafeInteger(published.sequence)) throw { code: 'INTERNAL_ERROR' }
    safeLog(logger, 'knowledge_embedding_generation_published', {
      generationId: event.generationId,
      chunkCount: data.chunks.length,
      model: EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
    })
    return published
  } catch (error) {
    if (ready) throw { code: safeErrorCode(error) }
    if (isRecord(error) && error.code === 'EMBEDDING_MODEL_INVALID') {
      failureCode = 'EMBEDDING_MODEL_INVALID'
    } else if (isRecord(error) && error.code === 'EMBEDDING_CONSENT_REQUIRED') {
      failureCode = 'EMBEDDING_CONSENT_REQUIRED'
    }
    try {
      await rpc('autoforge_knowledge_fail_embedding_generation', {
        p_caller_user_id: uid,
        p_knowledge_base_id: event.knowledgeBaseId,
        p_generation_id: event.generationId,
        p_error_code: failureCode,
      })
    } catch { /* The original safe error remains authoritative. */ }
    throw { code: failureCode }
  }
}

async function probeEmbeddingDrift({
  event, data, uid, rpc, embeddings, logger, now, embeddingTimeoutMs, releaseTimeoutMs,
}) {
  if (!isRecord(data) || data.status !== 'granted') {
    throw { code: 'EMBEDDING_CONSENT_REQUIRED' }
  }
  if (!embeddings) throw { code: 'TRANSIENT_FAILURE' }
  const response = await withEmbeddingSendAuthorization({
    uid, rpc, purpose: 'drift',
    now, embeddingTimeoutMs, releaseTimeoutMs,
    send: (signal, sendDeadlineMs) => embeddings.embed({
      model: EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      inputs: [EMBEDDING_DRIFT_PROBE],
      signal,
      sendDeadlineMs,
    }),
  })
  const vectors = embeddingResponse(response, 1)
  if (!vectors) throw { code: 'EMBEDDING_MODEL_INVALID' }
  const prepared = await rpc('autoforge_knowledge_prepare_drift_generation', {
    p_caller_user_id: uid,
    p_request_id: event.requestId,
    p_knowledge_base_id: event.knowledgeBaseId,
    p_generation_id: event.generationId,
    p_expected_published_generation_id: event.expectedPublishedGenerationId,
    p_model: EMBEDDING_MODEL,
    p_configuration: EMBEDDING_CONFIGURATION,
    p_probe_fingerprint: embeddingFingerprint(vectors[0]),
  })
  if (!isRecord(prepared)) throw { code: 'INTERNAL_ERROR' }
  if (prepared.drifted === false) return prepared
  if (prepared.drifted !== true) throw { code: 'INTERNAL_ERROR' }
  const published = await buildEmbeddingGeneration({
    event,
    data: { ...prepared, consentStatus: 'granted', probeVector: vectors[0] },
    uid, rpc, embeddings, logger, now, embeddingTimeoutMs, releaseTimeoutMs,
  })
  return { drifted: true, ...published }
}

function createKnowledgeHandler({
  rpc, storage, embeddings, logger, now = Date.now,
  embeddingTimeoutMs = EMBEDDING_SEND_TIMEOUT_MS,
  releaseTimeoutMs = EMBEDDING_RELEASE_TIMEOUT_MS,
}) {
  const boundedEmbeddingTimeoutMs = Math.min(
    Number.isFinite(embeddingTimeoutMs) && embeddingTimeoutMs > 0
      ? embeddingTimeoutMs : EMBEDDING_SEND_TIMEOUT_MS,
    EMBEDDING_SEND_TIMEOUT_MS,
  )
  const boundedReleaseTimeoutMs = Math.min(
    Number.isFinite(releaseTimeoutMs) && releaseTimeoutMs > 0
      ? releaseTimeoutMs : EMBEDDING_RELEASE_TIMEOUT_MS,
    EMBEDDING_RELEASE_TIMEOUT_MS,
  )
  return async (rawEvent, context) => {
    const uid = callerUid(context)
    if (!uid) return { ok: false, error: { code: 'AUTH_REQUIRED' } }
    const event = isRecord(rawEvent) ? rawEvent : {}
    const parsed = parseAction(event, uid)
    if (!parsed) return { ok: false, error: { code: 'INVALID_INPUT' } }
    try {
      const data = await rpc(parsed[0], parsed[1])
      if (event.action === 'searchPublished') {
        return { ok: true, data: await searchPublished({
          event, data, uid, rpc, embeddings, logger, now,
          embeddingTimeoutMs: boundedEmbeddingTimeoutMs,
          releaseTimeoutMs: boundedReleaseTimeoutMs,
        }) }
      }
      if (event.action === 'buildEmbeddingGeneration') {
        return { ok: true, data: await buildEmbeddingGeneration({
          event, data, uid, rpc, embeddings, logger, now,
          embeddingTimeoutMs: boundedEmbeddingTimeoutMs,
          releaseTimeoutMs: boundedReleaseTimeoutMs,
        }) }
      }
      if (event.action === 'probeEmbeddingDrift') {
        return { ok: true, data: await probeEmbeddingDrift({
          event, data, uid, rpc, embeddings, logger, now,
          embeddingTimeoutMs: boundedEmbeddingTimeoutMs,
          releaseTimeoutMs: boundedReleaseTimeoutMs,
        }) }
      }
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

function createTokenHubEmbeddingClient({ baseUrl, apiKey, fetchImpl = fetch }) {
  const normalizedBaseUrl = typeof baseUrl === 'string' ? baseUrl.replace(/\/$/, '') : ''
  return {
    async embed({ model, dimensions, inputs, signal, sendDeadlineMs }) {
      if (!normalizedBaseUrl || !apiKey
        || model !== EMBEDDING_MODEL
        || dimensions !== EMBEDDING_DIMENSIONS
        || !Array.isArray(inputs) || inputs.length < 1) throw { code: 'TRANSIENT_FAILURE' }
      if (!Number.isSafeInteger(sendDeadlineMs) || sendDeadlineMs <= Date.now()) {
        throw { code: 'EMBEDDING_CONSENT_REQUIRED' }
      }
      if (!signal || signal.aborted) throw { code: 'TRANSIENT_FAILURE' }
      let response
      try {
        if (sendDeadlineMs <= Date.now()) throw { code: 'EMBEDDING_CONSENT_REQUIRED' }
        response = await fetchImpl(`${normalizedBaseUrl}/v1/embeddings`, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: EMBEDDING_MODEL, input: inputs }),
          signal,
        })
      } catch (error) {
        if (isRecord(error) && error.code === 'EMBEDDING_CONSENT_REQUIRED') throw error
        throw { code: 'TRANSIENT_FAILURE' }
      }
      const body = await response.json().catch(() => undefined)
      if (!response.ok) {
        throw { code: response.status === 404 || response.status === 410
          ? 'MODEL_DEPRECATED' : 'TRANSIENT_FAILURE' }
      }
      if (!isRecord(body)
        || (body.model !== undefined && body.model !== EMBEDDING_MODEL)
        || !Array.isArray(body.data)
        || body.data.length !== inputs.length) throw { code: 'EMBEDDING_MODEL_INVALID' }
      const vectors = Array(inputs.length)
      for (const item of body.data) {
        if (!isRecord(item) || !Number.isSafeInteger(item.index)
          || item.index < 0 || item.index >= inputs.length
          || vectors[item.index] !== undefined) throw { code: 'EMBEDDING_MODEL_INVALID' }
        vectors[item.index] = item.embedding
      }
      if (vectors.some(vector => !validEmbedding(vector))) throw { code: 'EMBEDDING_MODEL_INVALID' }
      return { model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS, vectors }
    },
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

module.exports = {
  createKnowledgeHandler,
  createPostgresRpcClient,
  createPostgresStorageClient,
  createTokenHubEmbeddingClient,
}
