/* global AbortController, Buffer, clearTimeout, fetch, module, require, setTimeout, TextDecoder, URL */

const { createHash, randomUUID } = require('node:crypto')
const { createInflateRaw } = require('node:zlib')

const MAX_JOBS_PER_RUN = 8
const LEASE_SECONDS = 600
const DEFAULT_PARSER_TIMEOUT_MS = 120_000
const MAX_PARSER_TIMEOUT_MS = 120_000
const DEFAULT_JOB_TIMEOUT_MS = 120_000
const MAX_JOB_TIMEOUT_MS = 120_000
const DEFAULT_SETTLEMENT_RESERVE_MS = 5_000
const MAX_OBJECT_BYTES = 64 * 1024 * 1024
const MAX_INDEX_BYTES = 786_432
const MAX_ITEMS = 10_000
const MAX_DOCX_EXPANDED_BYTES = 16 * 1024 * 1024
const MAX_DOCX_COMPRESSION_RATIO = 100
const MAX_PDF_PAGES = 1_000
const MAX_PDF_TEXT_ITEMS = 100_000
const MAX_TEXT_BYTES = 16 * 1024 * 1024
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

async function loadTextOnlyPdfjs() {
  if (!globalThis.DOMMatrix) {
    globalThis.DOMMatrix = class TextOnlyDOMMatrix {
      constructor(value) {
        if (value !== undefined) throw new Error('PDF rendering is disabled')
        this.a = this.d = 1
        this.b = this.c = this.e = this.f = 0
        this.is2D = true
      }
    }
  }
  return await import('pdfjs-dist/legacy/build/pdf.mjs')
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

function createJobBoundary(timeoutMs, settlementReserveMs) {
  const finalDeadline = Date.now() + timeoutMs
  const workDeadline = finalDeadline - settlementReserveMs
  const controller = new AbortController()

  async function race(deadlineAt, operation, abortOnTimeout) {
    const remaining = deadlineAt - Date.now()
    if (remaining <= 0) {
      if (abortOnTimeout) controller.abort()
      throw { code: 'TRANSIENT_FAILURE' }
    }
    let timeoutId
    const expired = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        if (abortOnTimeout) controller.abort()
        reject({ code: 'TRANSIENT_FAILURE' })
      }, remaining)
    })
    try {
      return await Promise.race([Promise.resolve().then(operation), expired])
    } finally {
      clearTimeout(timeoutId)
    }
  }

  return {
    signal: controller.signal,
    work: operation => race(workDeadline, operation, true),
    settle: operation => race(finalDeadline, operation, false),
    dispose() { controller.abort() },
  }
}

function createKnowledgeWorker({
  rpc, storage, parser, embeddingWorker, workerId, id = randomUUID,
  maxJobs = MAX_JOBS_PER_RUN, parserTimeoutMs = DEFAULT_PARSER_TIMEOUT_MS,
  jobTimeoutMs = DEFAULT_JOB_TIMEOUT_MS,
  settlementReserveMs = DEFAULT_SETTLEMENT_RESERVE_MS,
}) {
  if (typeof rpc !== 'function' || !storage || typeof storage.readObject !== 'function'
    || typeof storage.deleteObjects !== 'function' || !parser || typeof parser.parse !== 'function'
    || !nonEmptyString(workerId) || !Number.isSafeInteger(maxJobs)
    || maxJobs < 1 || maxJobs > MAX_JOBS_PER_RUN
    || !Number.isSafeInteger(parserTimeoutMs)
    || parserTimeoutMs < 1 || parserTimeoutMs > MAX_PARSER_TIMEOUT_MS
    || !Number.isSafeInteger(jobTimeoutMs)
    || jobTimeoutMs < 2 || jobTimeoutMs > MAX_JOB_TIMEOUT_MS
    || !Number.isSafeInteger(settlementReserveMs)
    || settlementReserveMs < 1 || settlementReserveMs >= jobTimeoutMs) {
    throw new Error('Knowledge worker is not configured')
  }

  async function parseUpload(input, boundary) {
    const controller = new AbortController()
    const abortParser = () => controller.abort()
    boundary.signal.addEventListener('abort', abortParser, { once: true })
    let timeoutId
    const timedOut = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort()
        reject({ code: 'TRANSIENT_FAILURE' })
      }, parserTimeoutMs)
    })
    try {
      return await boundary.work(() => Promise.race([
        Promise.resolve().then(() => parser.parse({ ...input, signal: controller.signal })),
        timedOut,
      ]))
    } finally {
      clearTimeout(timeoutId)
      controller.abort()
      boundary.signal.removeEventListener('abort', abortParser)
    }
  }

  async function processUpload(job, boundary) {
    const work = await boundary.work(() => rpc('autoforge_knowledge_get_upload_work', {
      p_worker_id: workerId, p_job_id: job.id, p_lease_token: job.leaseToken,
    }))
    if (!validUploadWork(work)) throw { code: 'INTERNAL_ERROR' }
    const read = Promise.resolve().then(() => storage.readObject({
      storageReference: work.storageReference, byteSize: work.byteSize,
      sha256: work.sha256, mimeType: work.mimeType,
    }))
    let bytes
    try {
      bytes = await boundary.work(() => read)
    } catch (error) {
      void read.then((lateBytes) => {
        if (Buffer.isBuffer(lateBytes)) lateBytes.fill(0)
      }, () => undefined)
      throw error
    }
    if (!Buffer.isBuffer(bytes) || bytes.byteLength !== work.byteSize
      || createHash('sha256').update(bytes).digest('hex') !== work.sha256) {
      if (Buffer.isBuffer(bytes)) bytes.fill(0)
      throw { code: 'INTERNAL_ERROR' }
    }
    let parsed
    try {
      parsed = await parseUpload({
        bytes, mimeType: work.mimeType, versionId: work.versionId,
      }, boundary)
    } finally {
      bytes.fill(0)
    }
    if (!validParseResult(parsed)) throw { code: 'PARSER_LIMIT_EXCEEDED' }
    const completed = await boundary.work(() => rpc('autoforge_knowledge_complete_upload_index', {
      p_worker_id: workerId, p_job_id: job.id, p_lease_token: job.leaseToken,
      p_owner_id: work.ownerId, p_knowledge_base_id: work.knowledgeBaseId,
      p_document_id: work.documentId, p_version_id: work.versionId,
      p_generation_id: work.generationId, p_object_id: work.objectId,
      p_name: work.name, p_mime_type: work.mimeType,
      p_version_number: work.versionNumber, p_content_hash: work.sha256,
      p_parser_version: parsed.parserVersion,
      p_blocks: parsed.blocks, p_chunks: parsed.chunks,
    }))
    if (!exactKeys(completed, ['completed', 'generationId', 'embeddingJobId'])
      || completed.completed !== true || completed.generationId !== work.generationId
      || !(completed.embeddingJobId === null || nonEmptyString(completed.embeddingJobId))) {
      throw { code: 'INTERNAL_ERROR' }
    }
  }

  async function processPurge(job, boundary) {
    const prepared = await boundary.work(() => rpc('autoforge_knowledge_prepare_base_purge', {
      p_worker_id: workerId, p_job_id: job.id, p_lease_token: job.leaseToken,
    }))
    if (!exactKeys(prepared, ['jobId', 'storageReferences']) || prepared.jobId !== job.id
      || !Array.isArray(prepared.storageReferences)
      || prepared.storageReferences.length > MAX_ITEMS
      || prepared.storageReferences.some(reference => !validStorageReference(reference))) {
      throw { code: 'INTERNAL_ERROR' }
    }
    await boundary.work(() => storage.deleteObjects(prepared.storageReferences))
    const completed = await boundary.work(() => rpc('autoforge_knowledge_complete_base_purge', {
      p_worker_id: workerId, p_job_id: job.id, p_lease_token: job.leaseToken,
      p_deleted_storage_references: prepared.storageReferences,
    }))
    if (!exactKeys(completed, ['jobId', 'completed'])
      || completed.jobId !== job.id || completed.completed !== true) {
      throw { code: 'INTERNAL_ERROR' }
    }
  }

  async function processEmbedding(job, boundary) {
    if (!embeddingWorker || typeof embeddingWorker.run !== 'function') {
      throw { code: 'TRANSIENT_FAILURE' }
    }
    const result = await boundary.work(() => embeddingWorker.run({
      workerId, jobId: job.id, leaseToken: job.leaseToken,
    }))
    if (!exactKeys(result, ['state', 'embedded'])
      || !['completed', 'partial', 'revoked'].includes(result.state)
      || !Number.isSafeInteger(result.embedded) || result.embedded < 0) {
      throw { code: 'INTERNAL_ERROR' }
    }
    if (result.state === 'revoked') throw { code: 'FORBIDDEN' }
    if (result.state === 'partial') {
      const yielded = await boundary.work(() => rpc('autoforge_knowledge_yield_job', {
        p_worker_id: workerId, p_job_id: job.id, p_lease_token: job.leaseToken,
      }))
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
        const boundary = createJobBoundary(jobTimeoutMs, settlementReserveMs)
        claimed += 1
        let stopAfterJob = false
        try {
          if (job.kind === 'upload') await processUpload(job, boundary)
          else if (job.kind === 'purge') await processPurge(job, boundary)
          else stopAfterJob = await processEmbedding(job, boundary)
          completed += 1
        } catch (error) {
          const code = safeCode(error)
          try {
            await boundary.settle(() => rpc('autoforge_knowledge_complete_job', {
              p_worker_id: workerId, p_job_id: job.id, p_lease_token: job.leaseToken,
              p_state: 'failed', p_error_code: code,
            }))
          } catch {
            // A lost/expired lease must never be settled under a different identity.
          }
          failed += 1
          stopAfterJob = code === 'TRANSIENT_FAILURE'
        } finally {
          boundary.dispose()
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
  const units = []
  const separator = /\n\s*\n/gu
  let start = 0
  while (start <= text.length) {
    const match = separator.exec(text)
    const body = text.slice(start, match?.index ?? text.length).trim()
    if (body) {
      if (units.length >= MAX_ITEMS) throw { code: 'PARSER_LIMIT_EXCEEDED' }
      const index = units.length
      units.push({
        body,
        coordinates: mimeType === 'text/html'
          ? { kind: 'html', path: ['body', `p:nth-of-type(${index + 1})`] }
          : { kind: 'txt', lineStart: index + 1, lineEnd: index + 1, charStart: 0,
              charEnd: Array.from(body).length },
      })
    }
    if (!match) break
    start = separator.lastIndex
  }
  return units
}

function stripHtml(value) {
  return value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<\/(?:p|div|section|article|h[1-6]|li|br)>/giu, '\n\n')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;/giu, ' ').replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<').replace(/&gt;/giu, '>')
}

function assertTextLimit(value) {
  if (Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES) {
    throw { code: 'PARSER_LIMIT_EXCEEDED' }
  }
}

function findZipEnd(bytes) {
  const minimum = Math.max(0, bytes.byteLength - 22 - 65_535)
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) !== 0x06054b50) continue
    const commentLength = bytes.readUInt16LE(offset + 20)
    if (offset + 22 + commentLength === bytes.byteLength) return offset
  }
  throw { code: 'PARSER_FAILED' }
}

function docxArchiveEntries(bytes) {
  const endOffset = findZipEnd(bytes)
  const disk = bytes.readUInt16LE(endOffset + 4)
  const centralDisk = bytes.readUInt16LE(endOffset + 6)
  const diskEntries = bytes.readUInt16LE(endOffset + 8)
  const entryCount = bytes.readUInt16LE(endOffset + 10)
  const centralLength = bytes.readUInt32LE(endOffset + 12)
  const centralOffset = bytes.readUInt32LE(endOffset + 16)
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount
    || entryCount === 0 || entryCount === 0xffff
    || centralLength === 0xffffffff || centralOffset === 0xffffffff
    || entryCount > MAX_ITEMS || centralOffset + centralLength !== endOffset) {
    throw { code: 'PARSER_FAILED' }
  }

  const entries = []
  let expandedBytes = 0
  let cursor = centralOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > endOffset || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw { code: 'PARSER_FAILED' }
    }
    const flags = bytes.readUInt16LE(cursor + 8)
    const method = bytes.readUInt16LE(cursor + 10)
    const compressed = bytes.readUInt32LE(cursor + 20)
    const expanded = bytes.readUInt32LE(cursor + 24)
    const nameLength = bytes.readUInt16LE(cursor + 28)
    const extraLength = bytes.readUInt16LE(cursor + 30)
    const commentLength = bytes.readUInt16LE(cursor + 32)
    const startDisk = bytes.readUInt16LE(cursor + 34)
    const localOffset = bytes.readUInt32LE(cursor + 42)
    const next = cursor + 46 + nameLength + extraLength + commentLength
    if (next > endOffset || startDisk !== 0 || localOffset === 0xffffffff
      || compressed === 0xffffffff || expanded === 0xffffffff
      || (flags & 0x2041) !== 0 || ![0, 8].includes(method)) {
      throw { code: 'PARSER_FAILED' }
    }
    expandedBytes += expanded
    if (expandedBytes > MAX_DOCX_EXPANDED_BYTES
      || (expanded > 0 && (compressed === 0
        || expanded > compressed * MAX_DOCX_COMPRESSION_RATIO))) {
      throw { code: 'PARSER_LIMIT_EXCEEDED' }
    }
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength)
    let decodedName
    try { decodedName = new TextDecoder('utf-8', { fatal: true }).decode(name) } catch {
      throw { code: 'PARSER_FAILED' }
    }
    if (!decodedName || decodedName.includes('\0') || decodedName.includes('\\')
      || decodedName.startsWith('/') || decodedName.split('/').includes('..')) {
      throw { code: 'PARSER_FAILED' }
    }
    entries.push({
      compressed, expanded, flags, localOffset, method, name, decodedName,
    })
    cursor = next
  }
  if (cursor !== endOffset) throw { code: 'PARSER_FAILED' }
  return { centralOffset, entries }
}

function assertNoXmlEntityDeclarations(scanner, chunk) {
  const value = `${scanner.tail}${chunk.toString('latin1')}`.toUpperCase()
  if (value.includes('<!DOCTYPE') || value.includes('<!ENTITY')) {
    throw { code: 'PARSER_FAILED' }
  }
  scanner.tail = value.slice(-32)
}

async function assertDocxArchiveLimits(bytes) {
  const { centralOffset, entries } = docxArchiveEntries(bytes)
  let actualExpandedBytes = 0
  for (const entry of entries) {
    if (entry.localOffset + 30 > centralOffset
      || bytes.readUInt32LE(entry.localOffset) !== 0x04034b50) {
      throw { code: 'PARSER_FAILED' }
    }
    const localFlags = bytes.readUInt16LE(entry.localOffset + 6)
    const localMethod = bytes.readUInt16LE(entry.localOffset + 8)
    const nameLength = bytes.readUInt16LE(entry.localOffset + 26)
    const extraLength = bytes.readUInt16LE(entry.localOffset + 28)
    const nameStart = entry.localOffset + 30
    const dataStart = nameStart + nameLength + extraLength
    const dataEnd = dataStart + entry.compressed
    if (localFlags !== entry.flags || localMethod !== entry.method
      || dataEnd > centralOffset
      || !bytes.subarray(nameStart, nameStart + nameLength).equals(entry.name)) {
      throw { code: 'PARSER_FAILED' }
    }
    const scanner = { tail: '' }
    const inspectChunk = (raw) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      actualExpandedBytes += chunk.byteLength
      if (actualExpandedBytes > MAX_DOCX_EXPANDED_BYTES) {
        throw { code: 'PARSER_LIMIT_EXCEEDED' }
      }
      const normalizedName = entry.decodedName.toLowerCase()
      if (normalizedName.endsWith('.xml') || normalizedName.endsWith('.rels')) {
        assertNoXmlEntityDeclarations(scanner, chunk)
      }
    }
    let entryExpandedBytes = 0
    if (entry.method === 0) {
      if (entry.compressed !== entry.expanded) throw { code: 'PARSER_FAILED' }
      for (let offset = dataStart; offset < dataEnd; offset += 64 * 1024) {
        const chunk = bytes.subarray(offset, Math.min(offset + (64 * 1024), dataEnd))
        entryExpandedBytes += chunk.byteLength
        inspectChunk(chunk)
      }
    } else {
      const inflater = createInflateRaw()
      try {
        inflater.end(bytes.subarray(dataStart, dataEnd))
        for await (const raw of inflater) {
          const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
          entryExpandedBytes += chunk.byteLength
          try {
            if (entryExpandedBytes > entry.expanded) throw { code: 'PARSER_LIMIT_EXCEEDED' }
            inspectChunk(chunk)
          } finally { chunk.fill(0) }
        }
      } catch (error) {
        inflater.destroy()
        if (safeCode(error) === 'PARSER_LIMIT_EXCEEDED') throw error
        throw { code: 'PARSER_FAILED' }
      }
    }
    if (entryExpandedBytes !== entry.expanded) throw { code: 'PARSER_FAILED' }
  }
}

async function extractedUnits(bytes, mimeType, { loadMammoth, loadPdfjs }) {
  if (mimeType === 'text/plain' || mimeType === 'text/markdown') {
    if (bytes.byteLength > MAX_TEXT_BYTES) throw { code: 'PARSER_LIMIT_EXCEEDED' }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    assertTextLimit(text)
    return textUnits(text, mimeType)
  }
  if (mimeType === 'text/html') {
    if (bytes.byteLength > MAX_TEXT_BYTES) throw { code: 'PARSER_LIMIT_EXCEEDED' }
    const html = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const text = stripHtml(html)
    assertTextLimit(text)
    return textUnits(text, mimeType)
  }
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    await assertDocxArchiveLimits(bytes)
    const mammoth = loadMammoth()
    if (!isRecord(mammoth) || typeof mammoth.extractRawText !== 'function') {
      throw { code: 'PARSER_FAILED' }
    }
    const result = await mammoth.extractRawText(
      { buffer: bytes },
      { externalFileAccess: false },
    )
    if (!isRecord(result) || typeof result.value !== 'string') throw { code: 'PARSER_FAILED' }
    assertTextLimit(result.value)
    return textUnits(result.value, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      .map((unit, index) => ({
        ...unit, coordinates: { kind: 'docx', headingPath: [], paragraphId: `p-${index + 1}` },
      }))
  }
  if (mimeType === 'application/pdf') {
    const pdfjs = await loadPdfjs()
    if (!isRecord(pdfjs) || typeof pdfjs.getDocument !== 'function') {
      throw { code: 'PARSER_FAILED' }
    }
    const pdfBytes = Uint8Array.from(bytes)
    const loadingTask = pdfjs.getDocument({
      data: pdfBytes,
      maxDecodedStreamBytes: MAX_OBJECT_BYTES,
      stopAtErrors: true,
      maxImageSize: 0,
      canvasMaxAreaInBytes: 0,
      isEvalSupported: false,
      disableFontFace: true,
      enableXfa: false,
      useWasm: false,
      useWorkerFetch: false,
      disableAutoFetch: true,
      disableStream: true,
      disableRange: true,
      useSystemFonts: false,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
      verbosity: 0,
    })
    if (!isRecord(loadingTask) || !loadingTask.promise
      || typeof loadingTask.promise.then !== 'function') throw { code: 'PARSER_FAILED' }
    let document
    const units = []
    let textBytes = 0
    let textItems = 0
    let parseError
    try {
      document = await loadingTask.promise
      if (!isRecord(document) || !Number.isSafeInteger(document.numPages)
        || document.numPages < 1 || typeof document.getPage !== 'function') {
        throw { code: 'PARSER_FAILED' }
      }
      if (document.numPages > MAX_PDF_PAGES) throw { code: 'PARSER_LIMIT_EXCEEDED' }
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber)
        try {
          if (!isRecord(page) || typeof page.streamTextContent !== 'function') {
            throw { code: 'PARSER_FAILED' }
          }
          const stream = page.streamTextContent({
            includeMarkedContent: false,
            disableNormalization: false,
          })
          if (!isRecord(stream) || typeof stream.getReader !== 'function') {
            throw { code: 'PARSER_FAILED' }
          }
          const reader = stream.getReader()
          if (!isRecord(reader) || typeof reader.read !== 'function') {
            throw { code: 'PARSER_FAILED' }
          }
          const parts = []
          let complete = false
          let pageItems = 0
          try {
            while (true) {
              const chunk = await reader.read()
              if (!isRecord(chunk) || typeof chunk.done !== 'boolean') {
                throw { code: 'PARSER_FAILED' }
              }
              if (chunk.done) { complete = true; break }
              if (!isRecord(chunk.value) || !Array.isArray(chunk.value.items)) {
                throw { code: 'PARSER_FAILED' }
              }
              for (const item of chunk.value.items) {
                textItems += 1
                pageItems += 1
                if (textItems > MAX_PDF_TEXT_ITEMS) throw { code: 'PARSER_LIMIT_EXCEEDED' }
                const value = isRecord(item) && typeof item.str === 'string' ? item.str : ''
                if (!value) continue
                const nextTextBytes = textBytes + (textBytes > 0 ? 1 : 0)
                  + Buffer.byteLength(value, 'utf8')
                if (nextTextBytes > MAX_TEXT_BYTES) throw { code: 'PARSER_LIMIT_EXCEEDED' }
                textBytes = nextTextBytes
                parts.push(value)
              }
            }
          } finally {
            if (!complete && typeof reader.cancel === 'function') {
              try { await reader.cancel() } catch { /* best effort */ }
            }
            if (typeof reader.releaseLock === 'function') {
              try { reader.releaseLock() } catch { /* already released */ }
            }
          }
          const body = parts.join(' ').trim()
          if (body) {
            if (units.length >= MAX_ITEMS) throw { code: 'PARSER_LIMIT_EXCEEDED' }
            units.push({
              body, coordinates: {
                kind: 'pdf', page: pageNumber, itemStart: 0, itemEnd: pageItems,
              },
            })
          }
        } finally {
          if (isRecord(page) && typeof page.cleanup === 'function') {
            try { await page.cleanup() } catch { /* document destruction remains authoritative */ }
          }
        }
      }
    } catch (error) {
      parseError = isRecord(error) && error.message === 'PDF decoded stream limit exceeded'
        ? { code: 'PARSER_LIMIT_EXCEEDED' }
        : error
    }
    try { pdfBytes.fill(0) } catch { /* PDF.js may transfer and detach its private copy */ }
    try {
      if (document && typeof document.destroy === 'function') await document.destroy()
      else if (typeof loadingTask.destroy === 'function') await loadingTask.destroy()
    } catch {
      if (!parseError) parseError = { code: 'PARSER_FAILED' }
    }
    if (parseError) throw parseError
    return units
  }
  throw { code: 'PARSER_UNSUPPORTED_FORMAT' }
}

function createKnowledgeParser({
  loadMammoth = () => require('mammoth'),
  loadPdfjs = loadTextOnlyPdfjs,
} = {}) {
  if (typeof loadMammoth !== 'function' || typeof loadPdfjs !== 'function') {
    throw new Error('Knowledge parser is not configured')
  }
  return {
    async parse({ bytes, mimeType, versionId }) {
      if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0 || bytes.byteLength > MAX_OBJECT_BYTES
        || !nonEmptyString(mimeType, 200) || !nonEmptyString(versionId)) {
        throw { code: 'INVALID_INPUT' }
      }
      let units
      try {
        units = await extractedUnits(bytes, mimeType, { loadMammoth, loadPdfjs })
      } catch (error) {
        if (['PARSER_LIMIT_EXCEEDED', 'PARSER_UNSUPPORTED_FORMAT'].includes(safeCode(error))) {
          throw error
        }
        throw { code: 'PARSER_FAILED' }
      }
      const blocks = []
      const chunks = []
      for (const [blockOrdinal, unit] of units.entries()) {
        const body = unit.body.normalize('NFC').trim()
        if (!body) continue
        if (blocks.length >= MAX_ITEMS) throw { code: 'PARSER_LIMIT_EXCEEDED' }
        const blockId = identifier('block', versionId, blockOrdinal)
        blocks.push({
          id: blockId, ordinal: blockOrdinal, kind: 'paragraph', body,
          coordinates: unit.coordinates,
        })
        if (serializedBytes({ blocks, chunks }) > MAX_INDEX_BYTES) {
          throw { code: 'PARSER_LIMIT_EXCEEDED' }
        }
        const characters = Array.from(body)
        for (let start = 0; start < characters.length; start += 4000) {
          if (chunks.length >= MAX_ITEMS) throw { code: 'PARSER_LIMIT_EXCEEDED' }
          const ordinal = chunks.length
          chunks.push({
            id: identifier('chunk', versionId, ordinal), blockId, ordinal,
            body: characters.slice(start, start + 4000).join(''),
            coordinates: unit.coordinates,
          })
          if (serializedBytes({ blocks, chunks }) > MAX_INDEX_BYTES) {
            throw { code: 'PARSER_LIMIT_EXCEEDED' }
          }
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
