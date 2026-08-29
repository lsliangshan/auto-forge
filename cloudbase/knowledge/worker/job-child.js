/* global Buffer, module, performance, process, require */

const {
  createEmbeddingGenerationWorker,
  createPostgresRpcClient,
  createTokenHubClient,
} = require('../function/knowledge-handler.js')
const {
  createJobBoundary,
  createKnowledgeWorker,
  createWorkerStorageClient,
} = require('./knowledge-worker.js')
const { createKnowledgeParserProcess } = require('./parser-process.js')

const MAX_INPUT_BYTES = 8 * 1024
const MAX_RESPONSE_BYTES = 1024
const inputChunks = []
let inputLength = 0

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

function validJob(value) {
  return exactKeys(value, [
    'id', 'kind', 'entityId', 'leaseToken', 'attempt',
    'mutationPermit', 'mutationBudgetMs',
  ]) && nonEmptyString(value.id) && ['upload', 'embedding', 'purge'].includes(value.kind)
    && nonEmptyString(value.entityId) && nonEmptyString(value.leaseToken)
    && Number.isSafeInteger(value.attempt) && value.attempt >= 1 && value.attempt <= 3
    && nonEmptyString(value.mutationPermit)
    && Number.isSafeInteger(value.mutationBudgetMs)
    && value.mutationBudgetMs >= 1 && value.mutationBudgetMs <= 120_000
}

function validInput(value) {
  return exactKeys(value, [
    'workerId', 'job', 'timeoutMs', 'settlementReserveMs', 'parserTimeoutMs',
  ]) && nonEmptyString(value.workerId) && validJob(value.job)
    && Number.isSafeInteger(value.timeoutMs) && value.timeoutMs >= 2
    && value.timeoutMs <= 120_000
    && Number.isSafeInteger(value.settlementReserveMs)
    && value.settlementReserveMs >= 1
    && value.settlementReserveMs < value.timeoutMs
    && Number.isSafeInteger(value.parserTimeoutMs)
    && value.parserTimeoutMs >= 1 && value.parserTimeoutMs <= 120_000
}

function safeCode(error) {
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : ''
  return [
    'FORBIDDEN', 'INVALID_EMBEDDING_RESPONSE', 'INVALID_INPUT', 'PARSER_FAILED',
    'PARSER_LIMIT_EXCEEDED', 'PARSER_UNSUPPORTED_FORMAT', 'TRANSIENT_FAILURE',
  ].includes(code) ? code : 'INTERNAL_ERROR'
}

function decodeInput(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 4) throw { code: 'INVALID_INPUT' }
  const length = bytes.readUInt32BE(0)
  if (length < 2 || length > MAX_INPUT_BYTES || bytes.byteLength !== length + 4) {
    throw { code: 'INVALID_INPUT' }
  }
  let input
  try { input = JSON.parse(bytes.subarray(4).toString('utf8')) } catch {
    throw { code: 'INVALID_INPUT' }
  }
  if (!validInput(input)) throw { code: 'INVALID_INPUT' }
  return input
}

function encodeOutput(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  if (body.byteLength > MAX_RESPONSE_BYTES) {
    return encodeOutput({ ok: false, error: { code: 'INTERNAL_ERROR' } })
  }
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32BE(body.byteLength)
  return Buffer.concat([prefix, body])
}

function terminateJobProcess() {
  process.abort()
  return new Promise(() => undefined)
}

async function execute(input) {
  const serviceKey = process.env.AUTOFORGE_PG_SERVICE_KEY
  const mutationPermitPortVersion = process.env.AUTOFORGE_KNOWLEDGE_MUTATION_PERMIT_PORT_VERSION
  const rpc = createPostgresRpcClient({
    baseUrl: process.env.AUTOFORGE_PG_RPC_BASE_URL,
    serviceKey,
  })
  const storage = createWorkerStorageClient({
    baseUrl: process.env.AUTOFORGE_PG_STORAGE_BASE_URL,
    serviceKey,
    mutationPermitPortVersion,
  })
  const tokenHubEndpoint = process.env.AUTOFORGE_TOKENHUB_EMBEDDING_URL
  const tokenHubApiKey = process.env.AUTOFORGE_TOKENHUB_API_KEY
  const embeddingWorker = tokenHubEndpoint && tokenHubApiKey
    ? createEmbeddingGenerationWorker({
        rpc,
        tokenHub: createTokenHubClient({
          endpoint: tokenHubEndpoint, apiKey: tokenHubApiKey,
          requireMutationPermitPort: true, mutationPermitPortVersion,
        }),
        maximumChunksPerRun: 2,
      })
    : undefined
  const worker = createKnowledgeWorker({
    rpc, storage,
    parser: createKnowledgeParserProcess({
      timeoutMs: Math.min(input.parserTimeoutMs, 119_000),
    }),
    embeddingWorker, workerId: input.workerId,
    parserTimeoutMs: input.parserTimeoutMs,
  })
  const mutationAuthorization = Object.freeze({
    capability: input.job.mutationPermit,
    workerId: input.workerId,
    jobId: input.job.id,
    leaseToken: input.job.leaseToken,
  })
  const boundary = createJobBoundary(
    input.timeoutMs, input.settlementReserveMs,
    {
      workerId: input.workerId,
      jobId: input.job.id,
      leaseToken: input.job.leaseToken,
    },
    mutationAuthorization, terminateJobProcess, () => performance.now(),
  )
  try {
    return await worker.runClaimedJob(input.job, boundary)
  } finally {
    await boundary.dispose()
  }
}

async function main() {
  let envelope
  try {
    if (process.env.AUTOFORGE_KNOWLEDGE_JOB_CHILD !== '1') {
      throw { code: 'INVALID_INPUT' }
    }
    const input = decodeInput(Buffer.concat(inputChunks, inputLength))
    envelope = { ok: true, result: await execute(input) }
  } catch (error) {
    envelope = { ok: false, error: { code: safeCode(error) } }
  }
  process.stdout.end(encodeOutput(envelope))
}

process.stdin.on('data', (chunk) => {
  const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
  inputLength += part.byteLength
  if (inputLength > MAX_INPUT_BYTES + 4) {
    inputChunks.length = 0
    inputLength = MAX_INPUT_BYTES + 5
    process.stdin.destroy()
    return
  }
  inputChunks.push(part)
})
process.stdin.on('end', () => void main())

module.exports = {}
