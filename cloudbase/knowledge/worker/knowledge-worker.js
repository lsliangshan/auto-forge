/* global AbortController, Buffer, clearTimeout, fetch, module, require, setTimeout, TextDecoder, URL */

const { createHash, randomUUID } = require('node:crypto')

const MAX_JOBS_PER_RUN = 8
const LEASE_SECONDS = 600
const MAX_OBJECT_BYTES = 64 * 1024 * 1024
const MAX_INDEX_BYTES = 786_432
const MAX_ITEMS = 10_000
const PARSER_VERSION = 'autoforge-cloud-parser-v1'
const terminalCodes = new Set([
  'FORBIDDEN', 'INVALID_EMBEDDING_RESPONSE', 'INVALID_INPUT', 'PARSER_FAILED',
  'PARSER_LIMIT_EXCEEDED', 'PARSER_UNSUPPORTED_FORMAT',
])

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value, keys) {
  if (!isRecord(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index])
}

function nonEmptyString(value, maximum = 128) {
  return typeof value === 'string' && value.trim() === value
    && value.length > 0 && value.length <= maximum
}

function serializedBytes(value) {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8') } catch { return Infinity }
}

function safeCode(error) {
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : ''
  if (code === 'TRANSIENT_FAILURE' || terminalCodes.has(code)) return code
  return 'INTERNAL_ERROR'
}

function validStorageReference(value) {
  return nonEmptyString(value, 512) && value.startsWith('knowledge/') && !value.includes('..')
}

function validClaim(value, expectedLeaseToken) {
  if (!exactKeys(value, ['job'])) return false
  if (value.job === null) return true
  return exactKeys(value.job, ['id', 'kind', 'entityId', 'leaseToken', 'attempt'])
    && nonEmptyString(value.job.id) && ['upload', 'embedding', 'purge'].includes(value.job.kind)
    && nonEmptyString(value.job.entityId) && value.job.leaseToken === expectedLeaseToken
    && Number.isSafeInteger(value.job.attempt) && value.job.attempt >= 1 && value.job.attempt <= 3
}

function validUploadWork(value) {
  return exactKeys(value, [
    'ownerId', 'knowledgeBaseId', 'documentId', 'versionId', 'generationId',
    'objectId', 'storageReference', 'byteSize', 'sha256', 'mimeType', 'name',
    'versionNumber',
  ]) && nonEmptyString(value.ownerId, 64) && nonEmptyString(value.knowledgeBaseId)
    && nonEmptyString(value.documentId) && nonEmptyString(value.versionId)
    && nonEmptyString(value.generationId) && nonEmptyString(value.objectId)
    && validStorageReference(value.storageReference)
    && Number.isSafeInteger(value.byteSize) && value.byteSize > 0
    && value.byteSize <= MAX_OBJECT_BYTES
    && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(value.sha256)
    && nonEmptyString(value.mimeType, 200) && nonEmptyString(value.name, 500)
    && Number.isSafeInteger(value.versionNumber) && value.versionNumber > 0
}

function validCoordinates(value) {
  return isRecord(value) && serializedBytes(value) <= 8 * 1024
}

function validParseResult(value) {
  if (!exactKeys(value, ['parserVersion', 'blocks', 'chunks'])
    || !nonEmptyString(value.parserVersion)
    || !Array.isArray(value.blocks) || value.blocks.length > MAX_ITEMS
    || !Array.isArray(value.chunks) || value.chunks.length > MAX_ITEMS
    || serializedBytes({ blocks: value.blocks, chunks: value.chunks }) > MAX_INDEX_BYTES) return false
  const blockIds = new Set()
  for (const block of value.blocks) {
    if (!exactKeys(block, ['id', 'ordinal', 'kind', 'body', 'coordinates'])
      || !nonEmptyString(block.id) || blockIds.has(block.id)
      || !Number.isSafeInteger(block.ordinal) || block.ordinal < 0
      || !nonEmptyString(block.kind, 64) || !nonEmptyString(block.body, 64 * 1024)
      || !validCoordinates(block.coordinates)) return false
    blockIds.add(block.id)
  }
  const chunkIds = new Set()
  for (const chunk of value.chunks) {
    if (!exactKeys(chunk, ['id', 'blockId', 'ordinal', 'body', 'coordinates'])
      || !nonEmptyString(chunk.id) || chunkIds.has(chunk.id) || !blockIds.has(chunk.blockId)
      || !Number.isSafeInteger(chunk.ordinal) || chunk.ordinal < 0
      || !nonEmptyString(chunk.body, 64 * 1024) || !validCoordinates(chunk.coordinates)) return false
    chunkIds.add(chunk.id)
  }
  return true
}

function createKnowledgeWorker({
  rpc, storage, parser, embeddingWorker, workerId, id = randomUUID,
  maxJobs = MAX_JOBS_PER_RUN,
}) {
  if (typeof rpc !== 'function' || !storage || typeof storage.readObject !== 'function'
    || typeof storage.deleteObjects !== 'function' || !parser || typeof parser.parse !== 'function'
    || !nonEmptyString(workerId) || !Number.isSafeInteger(maxJobs)
    || maxJobs < 1 || maxJobs > MAX_JOBS_PER_RUN) {
    throw new Error('Knowledge worker is not configured')
  }

  async function processUpload(job) {
    const work = await rpc('autoforge_knowledge_get_upload_work', {
      p_worker_id: workerId, p_job_id: job.id, p_lease_token: job.leaseToken,
    })
    if (!validUploadWork(work)) throw { code: 'INTERNAL_ERROR' }
    const bytes = await storage.readObject({
      storageReference: work.storageReference, byteSize: work.byteSize,
      sha256: work.sha256, mimeType: work.mimeType,
    })
    if (!Buffer.isBuffer(bytes) || bytes.byteLength !== work.byteSize
      || createHash('sha256').update(bytes).digest('hex') !== work.sha256) {
      if (Buffer.isBuffer(bytes)) bytes.fill(0)
      throw { code: 'INTERNAL_ERROR' }
    }
    let parsed
    try {
      parsed = await parser.parse({
        bytes, mimeType: work.mimeType, versionId: work.versionId,
      })
    } finally {
      bytes.fill(0)
    }
    if (!validParseResult(parsed)) throw { code: 'PARSER_LIMIT_EXCEEDED' }
    const completed = await rpc('autoforge_knowledge_complete_upload_index', {
      p_worker_id: workerId, p_job_id: job.id, p_lease_token: job.leaseToken,
      p_owner_id: work.ownerId, p_knowledge_base_id: work.knowledgeBaseId,
      p_document_id: work.documentId, p_version_id: work.versionId,
      p_generation_id: work.generationId, p_object_id: work.objectId,
      p_name: work.name, p_mime_type: work.mimeType,
      p_version_number: work.versionNumber, p_content_hash: work.sha256,
      p_parser_version: parsed.parserVersion,
      p_blocks: parsed.blocks, p_chunks: parsed.chunks,
    })
    if (!exactKeys(completed, ['completed', 'generationId', 'embeddingJobId'])
      || completed.completed !== true || completed.generationId !== work.generationId
      || !(completed.embeddingJobId === null || nonEmptyString(completed.embeddingJobId))) {
      throw { code: 'INTERNAL_ERROR' }
    }
  }

  async function processPurge(job) {
    const prepared = await rpc('autoforge_knowledge_prepare_base_purge', {
      p_worker_id: workerId, p_job_id: job.id, p_lease_token: job.leaseToken,
    })
    if (!exactKeys(prepared, ['jobId', 'storageReferences']) || prepared.jobId !== job.id
      || !Array.isArray(prepared.storageReferences)
      || prepared.storageReferences.length > MAX_ITEMS
      || prepared.storageReferences.some(reference => !validStorageReference(reference))) {
      throw { code: 'INTERNAL_ERROR' }
    }
    await storage.deleteObjects(prepared.storageReferences)
    const completed = await rpc('autoforge_knowledge_complete_base_purge', {
      p_worker_id: workerId, p_job_id: job.id, p_lease_token: job.leaseToken,
      p_deleted_storage_references: prepared.storageReferences,
    })
    if (!exactKeys(completed, ['jobId', 'completed'])
      || completed.jobId !== job.id || completed.completed !== true) {
      throw { code: 'INTERNAL_ERROR' }
    }
  }

  async function processEmbedding(job) {
    if (!embeddingWorker || typeof embeddingWorker.run !== 'function') {
      throw { code: 'TRANSIENT_FAILURE' }
    }
    const result = await embeddingWorker.run({
      workerId, jobId: job.id, leaseToken: job.leaseToken,
    })
    if (!exactKeys(result, ['state', 'embedded'])
      || !['completed', 'partial', 'revoked'].includes(result.state)
      || !Number.isSafeInteger(result.embedded) || result.embedded < 0) {
      throw { code: 'INTERNAL_ERROR' }
    }
    if (result.state === 'revoked') throw { code: 'FORBIDDEN' }
    if (result.state === 'partial') {
      const yielded = await rpc('autoforge_knowledge_yield_job', {
        p_worker_id: workerId, p_job_id: job.id, p_lease_token: job.leaseToken,
      })
      if (!exactKeys(yielded, ['yielded']) || yielded.yielded !== true) {
        throw { code: 'INTERNAL_ERROR' }
      }
      return true
    }
    return false
  }

  return {
    async runOnce() {
      let claimed = 0
      let completed = 0
      let failed = 0
      for (let index = 0; index < maxJobs; index += 1) {
        const leaseToken = id()
        if (!nonEmptyString(leaseToken)) throw new Error('Invalid worker lease token')
        const result = await rpc('autoforge_knowledge_claim_job', {
          p_worker_id: workerId, p_lease_token: leaseToken,
          p_lease_seconds: LEASE_SECONDS,
        })
        if (!validClaim(result, leaseToken)) throw { code: 'INTERNAL_ERROR' }
        if (result.job === null) break
        const job = result.job
        claimed += 1
        let stopAfterJob = false
        try {
          if (job.kind === 'upload') await processUpload(job)
          else if (job.kind === 'purge') await processPurge(job)
          else stopAfterJob = await processEmbedding(job)
          completed += 1
        } catch (error) {
          const code = safeCode(error)
          try {
            await rpc('autoforge_knowledge_complete_job', {
              p_worker_id: workerId, p_job_id: job.id, p_lease_token: job.leaseToken,
              p_state: 'failed', p_error_code: code,
            })
          } catch {
            // A lost/expired lease must never be settled under a different identity.
          }
          failed += 1
          stopAfterJob = code === 'TRANSIENT_FAILURE'
        }
        if (stopAfterJob) break
      }
      const cleanup = await rpc('autoforge_knowledge_cleanup_retention', {
        p_worker_id: workerId, p_limit: 1000, p_snapshot_limit: 100,
      })
      const cleanupKeys = [
        'prunedChanges', 'prunedTombstones', 'prunedSnapshots',
        'prunedGenerations', 'prunedDispatchPermits',
      ]
      if (!exactKeys(cleanup, cleanupKeys)
        || cleanupKeys.some(key => !Number.isSafeInteger(cleanup[key]) || cleanup[key] < 0)) {
        throw { code: 'INTERNAL_ERROR' }
      }
      return { claimed, completed, failed }
    },
  }
}

function identifier(prefix, versionId, ordinal) {
  return `${prefix}_${createHash('sha256')
    .update(`${versionId}\u0000${ordinal}`).digest('hex').slice(0, 40)}`
}

function textUnits(text, mimeType) {
  const paragraphs = text.split(/\n\s*\n/u).map(value => value.trim()).filter(Boolean)
  return paragraphs.map((body, index) => ({
    body,
    coordinates: mimeType === 'text/html'
      ? { kind: 'html', path: ['body', `p:nth-of-type(${index + 1})`] }
      : { kind: 'txt', lineStart: index + 1, lineEnd: index + 1, charStart: 0,
          charEnd: Array.from(body).length },
  }))
}

function stripHtml(value) {
  return value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<\/(?:p|div|section|article|h[1-6]|li|br)>/giu, '\n\n')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;/giu, ' ').replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<').replace(/&gt;/giu, '>')
}

async function extractedUnits(bytes, mimeType) {
  if (mimeType === 'text/plain' || mimeType === 'text/markdown') {
    return textUnits(new TextDecoder('utf-8', { fatal: true }).decode(bytes), mimeType)
  }
  if (mimeType === 'text/html') {
    const html = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return textUnits(stripHtml(html), mimeType)
  }
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const mammoth = require('mammoth')
    const result = await mammoth.extractRawText({ buffer: bytes })
    return textUnits(result.value, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      .map((unit, index) => ({
        ...unit, coordinates: { kind: 'docx', headingPath: [], paragraphId: `p-${index + 1}` },
      }))
  }
  if (mimeType === 'application/pdf') {
    const pdfjs = require('pdfjs-dist/legacy/build/pdf.js')
    const document = await pdfjs.getDocument({ data: Uint8Array.from(bytes) }).promise
    const units = []
    try {
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber)
        const content = await page.getTextContent()
        const body = content.items.map(item => typeof item.str === 'string' ? item.str : '')
          .join(' ').trim()
        if (body) units.push({
          body, coordinates: {
            kind: 'pdf', page: pageNumber, itemStart: 0, itemEnd: content.items.length,
          },
        })
      }
    } finally {
      await document.destroy()
    }
    return units
  }
  throw { code: 'PARSER_UNSUPPORTED_FORMAT' }
}

function createKnowledgeParser() {
  return {
    async parse({ bytes, mimeType, versionId }) {
      if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0 || bytes.byteLength > MAX_OBJECT_BYTES
        || !nonEmptyString(mimeType, 200) || !nonEmptyString(versionId)) {
        throw { code: 'INVALID_INPUT' }
      }
      let units
      try {
        units = await extractedUnits(bytes, mimeType)
      } catch (error) {
        if (safeCode(error) === 'PARSER_UNSUPPORTED_FORMAT') throw error
        throw { code: 'PARSER_FAILED' }
      }
      const blocks = []
      const chunks = []
      for (const [blockOrdinal, unit] of units.entries()) {
        const body = unit.body.normalize('NFC').trim()
        if (!body) continue
        const blockId = identifier('block', versionId, blockOrdinal)
        blocks.push({
          id: blockId, ordinal: blockOrdinal, kind: 'paragraph', body,
          coordinates: unit.coordinates,
        })
        const characters = Array.from(body)
        for (let start = 0; start < characters.length; start += 4000) {
          const ordinal = chunks.length
          chunks.push({
            id: identifier('chunk', versionId, ordinal), blockId, ordinal,
            body: characters.slice(start, start + 4000).join(''),
            coordinates: unit.coordinates,
          })
        }
        if (blocks.length > MAX_ITEMS || chunks.length > MAX_ITEMS
          || serializedBytes({ blocks, chunks }) > MAX_INDEX_BYTES) {
          throw { code: 'PARSER_LIMIT_EXCEEDED' }
        }
      }
      if (blocks.length === 0 || chunks.length === 0) throw { code: 'PARSER_FAILED' }
      return { parserVersion: PARSER_VERSION, blocks, chunks }
    },
  }
}

function deadline(timeoutMs) {
  const controller = new AbortController()
  const effective = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10_000
  let timeoutId
  const expired = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort()
      reject({ code: 'TRANSIENT_FAILURE' })
    }, effective)
  })
  return {
    signal: controller.signal,
    race: operation => Promise.race([operation, expired]),
    dispose() { clearTimeout(timeoutId); controller.abort() },
  }
}

async function readResponseBytes(response, maximum, signal) {
  const contentLength = response?.headers?.get?.('content-length')
  if (contentLength !== null && contentLength !== undefined
    && (!/^\d+$/u.test(contentLength) || Number(contentLength) > maximum)) {
    throw { code: 'INTERNAL_ERROR' }
  }
  if (!response?.body || typeof response.body.getReader !== 'function') {
    throw { code: 'INTERNAL_ERROR' }
  }
  const reader = response.body.getReader()
  const chunks = []
  let length = 0
  let complete = false
  let rejectAbort
  const onAbort = () => rejectAbort?.({ code: 'TRANSIENT_FAILURE' })
  const aborted = new Promise((_, reject) => {
    rejectAbort = reject
    if (signal.aborted) reject({ code: 'TRANSIENT_FAILURE' })
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), aborted])
      if (!isRecord(chunk) || typeof chunk.done !== 'boolean') throw { code: 'INTERNAL_ERROR' }
      if (chunk.done) { complete = true; break }
      if (!(chunk.value instanceof Uint8Array)) throw { code: 'INTERNAL_ERROR' }
      length += chunk.value.byteLength
      if (length > maximum) throw { code: 'INTERNAL_ERROR' }
      chunks.push(Buffer.from(chunk.value))
    }
    return Buffer.concat(chunks, length)
  } finally {
    signal.removeEventListener('abort', onAbort)
    if (!complete && typeof reader.cancel === 'function') {
      try { Promise.resolve(reader.cancel()).catch(() => undefined) } catch { /* best effort */ }
    }
    if (typeof reader.releaseLock === 'function') {
      try { reader.releaseLock() } catch { /* already released */ }
    }
  }
}

function createWorkerStorageClient({
  baseUrl, serviceKey, fetchImpl = fetch, timeoutMs = 10_000,
}) {
  let parsed
  try { parsed = new URL(baseUrl) } catch { parsed = undefined }
  if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password
    || parsed.search || parsed.hash || !serviceKey) {
    throw new Error('Worker Storage is not configured')
  }
  const normalizedBaseUrl = parsed.href.replace(/\/$/u, '')

  async function request(path, body, allowBytes) {
    const boundary = deadline(timeoutMs)
    try {
      let response
      try {
        response = await boundary.race(fetchImpl(`${normalizedBaseUrl}${path}`, {
          method: 'POST', headers: {
            authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json',
          }, body: JSON.stringify(body), signal: boundary.signal,
        }))
      } catch {
        throw { code: 'TRANSIENT_FAILURE' }
      }
      if (!response?.ok) throw { code: response?.status >= 500 ? 'TRANSIENT_FAILURE' : 'INTERNAL_ERROR' }
      if (!allowBytes) {
        if (![204, 205].includes(response.status)) throw { code: 'INTERNAL_ERROR' }
        return undefined
      }
      return await boundary.race(readResponseBytes(response, body.byteSize, boundary.signal))
    } finally {
      boundary.dispose()
    }
  }

  return {
    async readObject(input) {
      if (!exactKeys(input, ['storageReference', 'byteSize', 'sha256', 'mimeType'])
        || !validStorageReference(input.storageReference)
        || !Number.isSafeInteger(input.byteSize) || input.byteSize < 1
        || input.byteSize > MAX_OBJECT_BYTES
        || typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(input.sha256)
        || !nonEmptyString(input.mimeType, 200)) throw { code: 'INVALID_INPUT' }
      const bytes = await request('/objects/read', input, true)
      if (!Buffer.isBuffer(bytes) || bytes.byteLength !== input.byteSize
        || createHash('sha256').update(bytes).digest('hex') !== input.sha256) {
        if (Buffer.isBuffer(bytes)) bytes.fill(0)
        throw { code: 'INTERNAL_ERROR' }
      }
      return bytes
    },
    async deleteObjects(storageReferences) {
      if (!Array.isArray(storageReferences) || storageReferences.length > MAX_ITEMS
        || storageReferences.some(reference => !validStorageReference(reference))) {
        throw { code: 'INVALID_INPUT' }
      }
      await request('/objects/delete', { storageReferences }, false)
    },
  }
}

module.exports = {
  createKnowledgeParser,
  createKnowledgeWorker,
  createWorkerStorageClient,
}
