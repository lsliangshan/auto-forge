/* global Buffer, module, process, require */

const { createPostgresRpcClient } = require('../function/knowledge-handler.js')

const MAX_INPUT_BYTES = 2 * 1024
const MAX_RESPONSE_BYTES = 256
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

function validInput(value) {
  if (!isRecord(value) || !['abandon', 'complete'].includes(value.kind)
    || !nonEmptyString(value.workerId) || !nonEmptyString(value.jobId)
    || !nonEmptyString(value.leaseToken) || !nonEmptyString(value.mutationPermit)) return false
  if (value.kind === 'abandon') {
    return exactKeys(value, [
      'kind', 'workerId', 'jobId', 'leaseToken', 'mutationPermit',
    ])
  }
  return exactKeys(value, [
    'kind', 'workerId', 'jobId', 'leaseToken', 'mutationPermit', 'state', 'errorCode',
  ]) && ['completed', 'failed'].includes(value.state)
    && (value.errorCode === null || nonEmptyString(value.errorCode, 64))
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

function safeCode(error) {
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : ''
  return ['CONFLICT', 'INVALID_INPUT', 'TRANSIENT_FAILURE'].includes(code)
    ? code : 'INTERNAL_ERROR'
}

async function execute(input) {
  const rpc = createPostgresRpcClient({
    baseUrl: process.env.AUTOFORGE_PG_RPC_BASE_URL,
    serviceKey: process.env.AUTOFORGE_PG_SERVICE_KEY,
  })
  const common = {
    p_worker_id: input.workerId,
    p_job_id: input.jobId,
    p_lease_token: input.leaseToken,
    p_mutation_permit: input.mutationPermit,
  }
  const result = input.kind === 'abandon'
    ? await rpc('autoforge_knowledge_abandon_claimed_job', common)
    : await rpc('autoforge_knowledge_complete_job', {
        ...common, p_state: input.state, p_error_code: input.errorCode,
      })
  const expectedKey = input.kind === 'abandon' ? 'abandoned' : 'completed'
  if (!exactKeys(result, [expectedKey]) || result[expectedKey] !== true) {
    throw { code: 'INTERNAL_ERROR' }
  }
  return { confirmed: true }
}

async function main() {
  let envelope
  try {
    if (process.env.AUTOFORGE_KNOWLEDGE_SETTLEMENT_CHILD !== '1') {
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
