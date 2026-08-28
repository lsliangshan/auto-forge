/* global AbortSignal, Buffer, __dirname, clearTimeout, module, process, require, setTimeout */

const { spawn } = require('node:child_process')
const { existsSync, realpathSync, statSync } = require('node:fs')
const { isAbsolute, resolve } = require('node:path')

const MAX_INPUT_BYTES = 2 * 1024
const MAX_RESPONSE_BYTES = 256
const MAX_STDERR_BYTES = 4 * 1024
const DEFAULT_ATTEMPT_TIMEOUT_MS = 1_000
const RETRY_DELAY_MS = 50
const TERMINATION_GRACE_MS = 50
const settlementChildDefault = resolve(__dirname, 'settlement-child.js')

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

function signalLike(value) {
  return value instanceof AbortSignal
    || (isRecord(value) && typeof value.aborted === 'boolean'
      && typeof value.addEventListener === 'function'
      && typeof value.removeEventListener === 'function')
}

function validBoundary(value) {
  return value === undefined || (isRecord(value) && signalLike(value.signal)
    && typeof value.remainingMs === 'function')
}

function executableFile(path) {
  try {
    return isAbsolute(path) && existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

function environmentForSettlement(source) {
  const environment = { AUTOFORGE_KNOWLEDGE_SETTLEMENT_CHILD: '1' }
  for (const name of [
    'AUTOFORGE_PG_RPC_BASE_URL', 'AUTOFORGE_PG_SERVICE_KEY', 'NODE_EXTRA_CA_CERTS',
  ]) {
    if (typeof source?.[name] === 'string' && source[name].length > 0) {
      environment[name] = source[name]
    }
  }
  if (process.versions.electron) environment.ELECTRON_RUN_AS_NODE = '1'
  return environment
}

function processGroupExists(groupId) {
  try {
    process.kill(-groupId, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

function signalProcessGroup(groupId, signal) {
  try {
    process.kill(-groupId, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

async function waitForProcessGroupExit(groupId) {
  while (processGroupExists(groupId)) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
  }
}

function encodeFrame(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  if (body.byteLength > MAX_INPUT_BYTES) throw { code: 'INVALID_INPUT' }
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32BE(body.byteLength)
  return Buffer.concat([prefix, body])
}

function decodeFrame(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 4) throw { code: 'INTERNAL_ERROR' }
  const length = bytes.readUInt32BE(0)
  if (length < 2 || length > MAX_RESPONSE_BYTES || bytes.byteLength !== length + 4) {
    throw { code: 'INTERNAL_ERROR' }
  }
  let envelope
  try { envelope = JSON.parse(bytes.subarray(4).toString('utf8')) } catch {
    throw { code: 'INTERNAL_ERROR' }
  }
  if (exactKeys(envelope, ['ok', 'result']) && envelope.ok === true
    && exactKeys(envelope.result, ['confirmed']) && envelope.result.confirmed === true) {
    return envelope.result
  }
  if (exactKeys(envelope, ['ok', 'error']) && envelope.ok === false
    && exactKeys(envelope.error, ['code'])
    && ['CONFLICT', 'INTERNAL_ERROR', 'INVALID_INPUT', 'TRANSIENT_FAILURE']
      .includes(envelope.error.code)) throw { code: envelope.error.code }
  throw { code: 'INTERNAL_ERROR' }
}

function createKnowledgeSettlementProcess({
  childEntry = settlementChildDefault,
  spawnImpl = spawn,
  environment = process.env,
  attemptTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
} = {}) {
  if (!nonEmptyString(childEntry, 4_096) || !isAbsolute(childEntry)
    || typeof spawnImpl !== 'function' || !executableFile(process.execPath)
    || !Number.isSafeInteger(attemptTimeoutMs) || attemptTimeoutMs < 1
    || attemptTimeoutMs > 10_000) {
    throw new Error('Knowledge settlement process is not configured')
  }
  let canonicalChildEntry
  try { canonicalChildEntry = realpathSync(childEntry) } catch {
    throw new Error('Knowledge settlement process is not configured')
  }

  async function runAttempt(input, boundary) {
    if (boundary?.signal.aborted) throw { code: 'TRANSIENT_FAILURE' }
    const remaining = boundary ? Math.floor(boundary.remainingMs()) : attemptTimeoutMs
    if (remaining <= 0) throw { code: 'TRANSIENT_FAILURE' }
    const timeoutMs = Math.max(1, Math.min(attemptTimeoutMs, remaining))
    const frame = encodeFrame(input)
    return await new Promise((resolvePromise, rejectPromise) => {
      let child
      try {
        child = spawnImpl(process.execPath, [
          '--no-addons', '--max-old-space-size=64', canonicalChildEntry,
        ], {
          cwd: __dirname,
          env: environmentForSettlement(environment),
          stdio: ['pipe', 'pipe', 'pipe'], detached: true, windowsHide: true,
        })
      } catch {
        rejectPromise({ code: 'TRANSIENT_FAILURE' })
        return
      }
      const groupId = child.pid
      if (!Number.isSafeInteger(groupId) || groupId <= 0) {
        try { child.kill('SIGKILL') } catch { /* spawn failed before PID assignment */ }
        rejectPromise({ code: 'TRANSIENT_FAILURE' })
        return
      }
      let settled = false
      let stopping
      let responseLength = 0
      let stderrLength = 0
      const responseChunks = []
      let killId
      const cleanup = () => {
        clearTimeout(timeoutId)
        clearTimeout(killId)
        boundary?.signal.removeEventListener('abort', onAbort)
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
      const stop = () => {
        if (stopping) return
        stopping = { code: 'TRANSIENT_FAILURE' }
        try { signalProcessGroup(groupId, 'SIGTERM') } catch { /* SIGKILL fallback follows */ }
        killId = setTimeout(() => {
          try { signalProcessGroup(groupId, 'SIGKILL') } catch { /* close path remains authoritative */ }
        }, TERMINATION_GRACE_MS)
      }
      const onAbort = () => stop()
      const timeoutId = setTimeout(stop, timeoutMs)
      boundary?.signal.addEventListener('abort', onAbort, { once: true })
      child.once('error', stop)
      child.stdout?.on('data', (chunk) => {
        if (stopping) return
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        responseLength += part.byteLength
        if (responseLength > MAX_RESPONSE_BYTES + 4) stop()
        else responseChunks.push(part)
      })
      child.stderr?.on('data', (chunk) => {
        if (stopping) return
        stderrLength += Buffer.byteLength(chunk)
        if (stderrLength > MAX_STDERR_BYTES) stop()
      })
      child.stdin?.on('error', stop)
      child.once('close', (code, closeSignal) => {
        void (async () => {
          if (processGroupExists(groupId)) {
            try { signalProcessGroup(groupId, 'SIGKILL') } catch { /* wait below */ }
            await waitForProcessGroupExit(groupId)
          }
          if (stopping || code !== 0 || closeSignal !== null) {
            settle({ code: 'TRANSIENT_FAILURE' })
            return
          }
          try {
            settle(undefined, decodeFrame(Buffer.concat(responseChunks, responseLength)))
          } catch (error) {
            settle(isRecord(error) ? error : { code: 'INTERNAL_ERROR' })
          }
        })()
      })
      if (!child.stdin || !child.stdout || !child.stderr) {
        stop()
        return
      }
      child.stdin.end(frame)
    })
  }

  return Object.freeze({
    async confirm(input, boundary) {
      if (!validInput(input) || !validBoundary(boundary)) throw { code: 'INVALID_INPUT' }
      while (!boundary?.signal.aborted) {
        try {
          return await runAttempt(input, boundary)
        } catch (error) {
          const failure = isRecord(error) ? error : { code: 'INTERNAL_ERROR' }
          if (!['INTERNAL_ERROR', 'TRANSIENT_FAILURE'].includes(failure.code)) throw failure
        }
        await new Promise(resolvePromise => setTimeout(resolvePromise, RETRY_DELAY_MS))
      }
      throw { code: 'TRANSIENT_FAILURE' }
    },
  })
}

module.exports = { createKnowledgeSettlementProcess }
