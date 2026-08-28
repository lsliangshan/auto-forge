/* global AbortSignal, Buffer, __dirname, clearTimeout, module, process, require, setTimeout */

const { spawn } = require('node:child_process')
const { isAbsolute, resolve } = require('node:path')

const MAX_INPUT_BYTES = 64 * 1024 * 1024
const MAX_HEADER_BYTES = 4 * 1024
const MAX_RESPONSE_BYTES = 786_432 + (64 * 1024)
const MAX_STDERR_BYTES = 8 * 1024
const DEFAULT_TIMEOUT_MS = 110_000
const MAX_TIMEOUT_MS = 119_000
const MAX_OLD_SPACE_MB = 128
const MAX_RSS_BYTES = 192 * 1024 * 1024
const childEntryDefault = resolve(__dirname, 'parser-child.js')
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

function signalLike(value) {
  return value === undefined || value instanceof AbortSignal
    || (isRecord(value) && typeof value.aborted === 'boolean'
      && typeof value.addEventListener === 'function'
      && typeof value.removeEventListener === 'function')
}

function decodeResponse(bytes, maximumResponseBytes) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 4) throw failure('PARSER_FAILED')
  const frameLength = bytes.readUInt32BE(0)
  if (frameLength > maximumResponseBytes) throw failure('PARSER_LIMIT_EXCEEDED')
  if (frameLength < 2 || bytes.byteLength !== frameLength + 4) {
    throw failure('PARSER_FAILED')
  }
  let envelope
  try {
    envelope = JSON.parse(bytes.subarray(4).toString('utf8'))
  } catch {
    throw failure('PARSER_FAILED')
  }
  if (exactKeys(envelope, ['ok', 'result']) && envelope.ok === true
    && isRecord(envelope.result)) return envelope.result
  if (exactKeys(envelope, ['ok', 'error']) && envelope.ok === false
    && exactKeys(envelope.error, ['code']) && parserCodes.has(envelope.error.code)) {
    throw failure(envelope.error.code)
  }
  throw failure('PARSER_FAILED')
}

function createKnowledgeParserProcess({
  childEntry = childEntryDefault,
  spawnImpl = spawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maximumInputBytes = MAX_INPUT_BYTES,
  maximumResponseBytes = MAX_RESPONSE_BYTES,
} = {}) {
  if (!nonEmptyString(childEntry, 4_096) || !isAbsolute(childEntry)
    || typeof spawnImpl !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS
    || !Number.isSafeInteger(maximumInputBytes)
    || maximumInputBytes < 1 || maximumInputBytes > MAX_INPUT_BYTES
    || !Number.isSafeInteger(maximumResponseBytes)
    || maximumResponseBytes < 32 || maximumResponseBytes > MAX_RESPONSE_BYTES) {
    throw new Error('Knowledge parser process is not configured')
  }

  return {
    async parse(input) {
      const inputKeys = isRecord(input) ? Object.keys(input).sort() : []
      const validKeys = inputKeys.length === 3
        ? ['bytes', 'mimeType', 'versionId']
        : ['bytes', 'mimeType', 'signal', 'versionId']
      const bytes = isRecord(input) ? input.bytes : undefined
      const signal = isRecord(input) ? input.signal : undefined
      if (!exactKeys(input, validKeys) || !Buffer.isBuffer(bytes)
        || bytes.byteLength < 1 || bytes.byteLength > maximumInputBytes
        || !nonEmptyString(input.mimeType, 200) || !nonEmptyString(input.versionId, 128)
        || !signalLike(signal)) {
        if (Buffer.isBuffer(bytes)) bytes.fill(0)
        throw failure(Buffer.isBuffer(bytes) && bytes.byteLength > maximumInputBytes
          ? 'PARSER_LIMIT_EXCEEDED' : 'INVALID_INPUT')
      }
      if (signal?.aborted) {
        bytes.fill(0)
        throw failure('TRANSIENT_FAILURE')
      }
      const header = Buffer.from(JSON.stringify({
        mimeType: input.mimeType,
        versionId: input.versionId,
        byteLength: bytes.byteLength,
      }), 'utf8')
      if (header.byteLength > MAX_HEADER_BYTES) {
        bytes.fill(0)
        throw failure('INVALID_INPUT')
      }
      const prefix = Buffer.alloc(4)
      prefix.writeUInt32BE(header.byteLength)

      return await new Promise((resolvePromise, rejectPromise) => {
        let child
        try {
          const environment = { AUTOFORGE_PARSER_CHILD: '1' }
          if (process.versions.electron) environment.ELECTRON_RUN_AS_NODE = '1'
          child = spawnImpl(process.execPath, [
            `--max-old-space-size=${MAX_OLD_SPACE_MB}`,
            childEntry,
            `--max-rss-bytes=${MAX_RSS_BYTES}`,
          ], {
            env: environment,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          })
        } catch {
          bytes.fill(0)
          rejectPromise(failure('PARSER_FAILED'))
          return
        }

        let settled = false
        let stopping
        let timeoutId
        let responseLength = 0
        let stderrLength = 0
        const responseChunks = []

        const cleanup = () => {
          clearTimeout(timeoutId)
          signal?.removeEventListener('abort', onAbort)
          bytes.fill(0)
          child.stdin?.destroy()
          child.stdout?.destroy()
          child.stderr?.destroy()
        }
        const settle = (error, value) => {
          if (settled) return
          settled = true
          cleanup()
          if (error) rejectPromise(error)
          else resolvePromise(value)
        }
        const stop = (error) => {
          if (stopping) return
          stopping = error
          bytes.fill(0)
          child.stdin?.destroy()
          child.stdout?.destroy()
          child.stderr?.destroy()
          try { child.kill('SIGKILL') } catch { /* process already closed */ }
        }
        const onAbort = () => stop(failure('TRANSIENT_FAILURE'))

        signal?.addEventListener('abort', onAbort, { once: true })
        timeoutId = setTimeout(() => stop(failure('TRANSIENT_FAILURE')), timeoutMs)
        if (typeof timeoutId.unref === 'function') timeoutId.unref()

        child.once('error', () => {
          if (!stopping) stopping = failure('PARSER_FAILED')
          bytes.fill(0)
          child.stdin?.destroy()
          child.stdout?.destroy()
          child.stderr?.destroy()
        })
        child.stdout?.on('data', (chunk) => {
          if (stopping) return
          const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          responseLength += part.byteLength
          if (responseLength > maximumResponseBytes + 4) {
            stop(failure('PARSER_LIMIT_EXCEEDED'))
            return
          }
          responseChunks.push(part)
        })
        child.stderr?.on('data', (chunk) => {
          if (stopping) return
          stderrLength += Buffer.byteLength(chunk)
          if (stderrLength > MAX_STDERR_BYTES) stop(failure('PARSER_FAILED'))
        })
        child.stdin?.on('error', () => {
          if (!stopping) stop(failure('PARSER_FAILED'))
        })
        child.once('close', (code, closeSignal) => {
          if (stopping) {
            settle(stopping)
            return
          }
          if (code !== 0 || closeSignal !== null) {
            settle(failure('PARSER_FAILED'))
            return
          }
          try {
            settle(undefined, decodeResponse(
              Buffer.concat(responseChunks, responseLength),
              maximumResponseBytes,
            ))
          } catch (error) {
            settle(isRecord(error) ? error : failure('PARSER_FAILED'))
          }
        })

        if (!child.stdin || !child.stdout || !child.stderr) {
          stop(failure('PARSER_FAILED'))
          return
        }
        child.stdin.write(prefix)
        child.stdin.write(header)
        child.stdin.end(bytes)
      })
    },
  }
}

module.exports = { createKnowledgeParserProcess }
