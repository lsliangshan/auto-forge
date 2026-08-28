/* global Buffer, process, require */

const { createKnowledgeParser } = require('./knowledge-worker.js')

const MAX_INPUT_BYTES = 64 * 1024 * 1024
const MAX_HEADER_BYTES = 4 * 1024
const MAX_RESPONSE_BYTES = 786_432 + (64 * 1024)
const parserCodes = new Set([
  'INVALID_INPUT', 'PARSER_FAILED', 'PARSER_LIMIT_EXCEEDED',
  'PARSER_UNSUPPORTED_FORMAT', 'TRANSIENT_FAILURE',
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

function nonEmptyString(value, maximum) {
  return typeof value === 'string' && value.trim() === value
    && value.length > 0 && value.length <= maximum
}

function failure(code) {
  return { code }
}

function safeCode(error) {
  return isRecord(error) && parserCodes.has(error.code) ? error.code : 'PARSER_FAILED'
}

function assertScrubbedEnvironment() {
  if (process.env.AUTOFORGE_PARSER_CHILD !== '1') throw failure('PARSER_FAILED')
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'AUTOFORGE_PARSER_CHILD') continue
    if (key === 'ELECTRON_RUN_AS_NODE' && value === '1') continue
    if (key === '__CF_USER_TEXT_ENCODING'
      && typeof value === 'string' && /^0x[0-9A-F]+:0x[0-9A-F]+:0x[0-9A-F]+$/u.test(value)) continue
    if (value !== undefined) {
      throw failure('PARSER_FAILED')
    }
  }
}

function parseHeader(header) {
  let value
  try { value = JSON.parse(header.toString('utf8')) } catch { throw failure('INVALID_INPUT') }
  if (!exactKeys(value, ['byteLength', 'mimeType', 'versionId'])
    || !Number.isSafeInteger(value.byteLength)
    || value.byteLength < 1 || value.byteLength > MAX_INPUT_BYTES
    || !nonEmptyString(value.mimeType, 200) || !nonEmptyString(value.versionId, 128)) {
    throw failure('INVALID_INPUT')
  }
  return value
}

async function readRequest() {
  const prefix = Buffer.alloc(4)
  let prefixOffset = 0
  let header
  let headerOffset = 0
  let metadata
  let bytes
  let bytesOffset = 0
  try {
    for await (const raw of process.stdin) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      let cursor = 0
      while (cursor < chunk.byteLength) {
        if (prefixOffset < prefix.byteLength) {
          const length = Math.min(prefix.byteLength - prefixOffset, chunk.byteLength - cursor)
          chunk.copy(prefix, prefixOffset, cursor, cursor + length)
          prefixOffset += length
          cursor += length
          if (prefixOffset === prefix.byteLength) {
            const headerLength = prefix.readUInt32BE(0)
            if (headerLength < 2 || headerLength > MAX_HEADER_BYTES) {
              throw failure('INVALID_INPUT')
            }
            header = Buffer.alloc(headerLength)
          }
          continue
        }
        if (!header) throw failure('INVALID_INPUT')
        if (headerOffset < header.byteLength) {
          const length = Math.min(header.byteLength - headerOffset, chunk.byteLength - cursor)
          chunk.copy(header, headerOffset, cursor, cursor + length)
          headerOffset += length
          cursor += length
          if (headerOffset === header.byteLength) {
            metadata = parseHeader(header)
            bytes = Buffer.allocUnsafe(metadata.byteLength)
          }
          continue
        }
        if (!metadata || !bytes || bytesOffset >= bytes.byteLength) {
          throw failure('INVALID_INPUT')
        }
        const length = Math.min(bytes.byteLength - bytesOffset, chunk.byteLength - cursor)
        chunk.copy(bytes, bytesOffset, cursor, cursor + length)
        bytesOffset += length
        cursor += length
      }
    }
    if (!metadata || !bytes || bytesOffset !== bytes.byteLength) throw failure('INVALID_INPUT')
    return { ...metadata, bytes }
  } catch (error) {
    bytes?.fill(0)
    throw error
  }
}

function writeEnvelope(envelope) {
  const body = Buffer.from(JSON.stringify(envelope), 'utf8')
  if (body.byteLength > MAX_RESPONSE_BYTES) throw failure('PARSER_LIMIT_EXCEEDED')
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32BE(body.byteLength)
  return new Promise((resolvePromise, rejectPromise) => {
    process.stdout.once('error', rejectPromise)
    process.stdout.write(prefix)
    process.stdout.end(body, resolvePromise)
  })
}

async function main() {
  let request
  try {
    assertScrubbedEnvironment()
    request = await readRequest()
    const result = await createKnowledgeParser().parse(request)
    await writeEnvelope({ ok: true, result })
  } catch (error) {
    try {
      await writeEnvelope({ ok: false, error: { code: safeCode(error) } })
    } catch {
      process.exitCode = 1
    }
  } finally {
    request?.bytes.fill(0)
  }
}

void main()
