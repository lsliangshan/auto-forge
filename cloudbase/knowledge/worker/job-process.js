/* global AbortSignal, Buffer, __dirname, clearTimeout, module, process, require, setTimeout */

const { spawn } = require('node:child_process')
const { existsSync, realpathSync, statSync } = require('node:fs')
const { isAbsolute, resolve } = require('node:path')

const MAX_INPUT_BYTES = 8 * 1024
const MAX_RESPONSE_BYTES = 1024
const MAX_STDERR_BYTES = 8 * 1024
const TERMINATION_GRACE_MS = 100
const jobChildDefault = resolve(__dirname, 'job-child.js')
const jobKinds = new Set(['upload', 'embedding', 'purge'])
const resultCodes = new Set([
  'FORBIDDEN', 'INTERNAL_ERROR', 'INVALID_EMBEDDING_RESPONSE', 'INVALID_INPUT',
  'PARSER_FAILED', 'PARSER_LIMIT_EXCEEDED', 'PARSER_UNSUPPORTED_FORMAT',
  'TRANSIENT_FAILURE',
])
const childEnvironmentNames = [
  'AUTOFORGE_PG_RPC_BASE_URL',
  'AUTOFORGE_PG_STORAGE_BASE_URL',
  'AUTOFORGE_PG_SERVICE_KEY',
  'AUTOFORGE_TOKENHUB_EMBEDDING_URL',
  'AUTOFORGE_TOKENHUB_API_KEY',
  'AUTOFORGE_KNOWLEDGE_MUTATION_PERMIT_PORT_VERSION',
  'NODE_EXTRA_CA_CERTS',
]

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
  ]) && nonEmptyString(value.id) && jobKinds.has(value.kind)
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

function signalLike(value) {
  return value instanceof AbortSignal
    || (isRecord(value) && typeof value.aborted === 'boolean'
      && typeof value.addEventListener === 'function'
      && typeof value.removeEventListener === 'function')
}

function identityKey(value) {
  if (!exactKeys(value, ['workerId', 'jobId', 'leaseToken'])
    || !nonEmptyString(value.workerId) || !nonEmptyString(value.jobId)
    || !nonEmptyString(value.leaseToken)) return undefined
  return JSON.stringify([value.workerId, value.jobId, value.leaseToken])
}

function executableFile(path) {
  try {
    return isAbsolute(path) && existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

function environmentForJob(source) {
  const environment = { AUTOFORGE_KNOWLEDGE_JOB_CHILD: '1' }
  for (const name of childEnvironmentNames) {
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
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
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
    && exactKeys(envelope.result, ['stopAfterJob'])
    && typeof envelope.result.stopAfterJob === 'boolean') return envelope.result
  if (exactKeys(envelope, ['ok', 'error']) && envelope.ok === false
    && exactKeys(envelope.error, ['code']) && resultCodes.has(envelope.error.code)) {
    throw { code: envelope.error.code }
  }
  throw { code: 'INTERNAL_ERROR' }
}

function createKnowledgeJobProcess({
  childEntry = jobChildDefault,
  spawnImpl = spawn,
  environment = process.env,
} = {}) {
  if (!nonEmptyString(childEntry, 4_096) || !isAbsolute(childEntry)
    || typeof spawnImpl !== 'function' || !executableFile(process.execPath)) {
    throw new Error('Knowledge job process is not configured')
  }
  let canonicalChildEntry
  try { canonicalChildEntry = realpathSync(childEntry) } catch {
    throw new Error('Knowledge job process is not configured')
  }
  const active = new Map()

  return Object.freeze({
    async run(input, boundary) {
      if (!validInput(input) || !isRecord(boundary) || !signalLike(boundary.signal)) {
        throw { code: 'INVALID_INPUT' }
      }
      if (boundary.signal.aborted) throw { code: 'TRANSIENT_FAILURE' }
      const identity = {
        workerId: input.workerId, jobId: input.job.id, leaseToken: input.job.leaseToken,
      }
      const key = identityKey(identity)
      if (!key || active.has(key)) throw { code: 'CONFLICT' }
      const frame = encodeFrame(input)

      return await new Promise((resolvePromise, rejectPromise) => {
        let child
        let onChildError = () => undefined
        try {
          child = spawnImpl(process.execPath, [
            '--no-addons', '--max-old-space-size=256', canonicalChildEntry,
          ], {
            cwd: __dirname,
            env: environmentForJob(environment),
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: true,
            windowsHide: true,
          })
          child.once('error', error => onChildError(error))
        } catch {
          rejectPromise({ code: 'TRANSIENT_FAILURE' })
          return
        }

        let settled = false
        let stopping
        let responseLength = 0
        let stderrLength = 0
        const responseChunks = []
        const groupId = child.pid
        if (!Number.isSafeInteger(groupId) || groupId <= 0) {
          const closePipes = () => {
            child.stdin?.destroy()
            child.stdout?.destroy()
            child.stderr?.destroy()
          }
          child.stdin?.on('error', () => undefined)
          onChildError = closePipes
          child.once('close', () => {
            closePipes()
            rejectPromise({ code: 'TRANSIENT_FAILURE' })
          })
          closePipes()
          return
        }
        let acknowledgeClose
        const closed = new Promise(resolveClose => { acknowledgeClose = resolveClose })
        const state = {
          child, groupId, closed, setStopping: error => { stopping ??= error },
        }
        active.set(key, state)

        const cleanup = () => {
          boundary.signal.removeEventListener('abort', onAbort)
          child.stdin?.destroy()
          child.stdout?.destroy()
          child.stderr?.destroy()
          active.delete(key)
        }
        const settle = (error, value) => {
          if (settled) return
          settled = true
          cleanup()
          if (error) rejectPromise(error)
          else resolvePromise(value)
        }
        const stop = (error, signal) => {
          state.setStopping(error)
          try { signalProcessGroup(groupId, signal) } catch {
            state.setStopping({ code: 'TRANSIENT_FAILURE' })
          }
        }
        const onAbort = () => stop({ code: 'TRANSIENT_FAILURE' }, 'SIGTERM')
        boundary.signal.addEventListener('abort', onAbort, { once: true })

        onChildError = () => stop({ code: 'TRANSIENT_FAILURE' }, 'SIGKILL')
        child.stdout?.on('data', (chunk) => {
          if (stopping) return
          const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          responseLength += part.byteLength
          if (responseLength > MAX_RESPONSE_BYTES + 4) {
            stop({ code: 'INTERNAL_ERROR' }, 'SIGKILL')
            return
          }
          responseChunks.push(part)
        })
        child.stderr?.on('data', (chunk) => {
          if (stopping) return
          stderrLength += Buffer.byteLength(chunk)
          if (stderrLength > MAX_STDERR_BYTES) {
            stop({ code: 'INTERNAL_ERROR' }, 'SIGKILL')
          }
        })
        child.stdin?.on('error', () => stop({ code: 'TRANSIENT_FAILURE' }, 'SIGKILL'))
        child.once('close', (code, closeSignal) => {
          void (async () => {
            if (processGroupExists(groupId)) {
              state.setStopping(stopping ?? { code: 'TRANSIENT_FAILURE' })
              try { signalProcessGroup(groupId, 'SIGKILL') } catch {
                state.setStopping({ code: 'TRANSIENT_FAILURE' })
              }
              await waitForProcessGroupExit(groupId)
            }
            acknowledgeClose()
            if (stopping) {
              settle(stopping)
              return
            }
            if (code !== 0 || closeSignal !== null) {
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
          stop({ code: 'TRANSIENT_FAILURE' }, 'SIGKILL')
          return
        }
        child.stdin.end(frame)
      })
    },

    async terminate(identity) {
      const key = identityKey(identity)
      if (!key) throw { code: 'INVALID_INPUT' }
      const state = active.get(key)
      if (!state) return
      state.setStopping({ code: 'TRANSIENT_FAILURE' })
      let graceId
      try { signalProcessGroup(state.groupId, 'SIGTERM') } catch {
        state.setStopping({ code: 'TRANSIENT_FAILURE' })
      }
      await Promise.race([
        state.closed,
        new Promise(resolvePromise => { graceId = setTimeout(resolvePromise, TERMINATION_GRACE_MS) }),
      ])
      clearTimeout(graceId)
      if (processGroupExists(state.groupId)) {
        try { signalProcessGroup(state.groupId, 'SIGKILL') } catch {
          state.setStopping({ code: 'TRANSIENT_FAILURE' })
        }
      }
      await state.closed
    },
  })
}

module.exports = { createKnowledgeJobProcess }
