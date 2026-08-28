import { randomUUID } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import * as vm from 'node:vm'
import {
  toSafeAppError,
  workerRequestSchema,
  workerResponseSchema,
  workerCapabilityRequestSchema,
  type AppError,
  type WorkerCapabilityRequest,
  type WorkerRequest,
  type WorkerResponse,
} from '@autoforge/shared'

const MAX_LINE_BYTES = 1024 * 1024
const SDK_SPECIFIER = '@autoforge/workflow-sdk'

interface WorkflowDefinition {
  invoke(inputJson: string): Promise<string> | string
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: AppError): void
}

interface RunnerState {
  executionId?: string
  started: boolean
  terminal: boolean
  pending: Map<string, PendingRequest>
  pendingWaiters: Set<() => void>
}

function protocolError(): AppError {
  return toSafeAppError({ code: 'WORKER_PROTOCOL_INVALID' })
}

function cancelledError(): AppError {
  return toSafeAppError({ code: 'CANCELLED' })
}

function write(message: WorkerResponse): void {
  const parsed = workerResponseSchema.parse(message)
  const line = `${JSON.stringify(parsed)}\n`
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw protocolError()
  process.stdout.write(line)
}

function rejectImport(specifier: string): never {
  throw Object.assign(new Error(`Import is not allowed: ${specifier}`), { code: 'WORKER_PROTOCOL_INVALID' })
}

function isolateHostFunction<T extends (...arguments_: never[]) => unknown>(callback: T): T {
  Object.setPrototypeOf(callback, null)
  return Object.freeze(callback)
}

function errorEnvelope(error: unknown): string {
  try {
    const safe = toSafeAppError(error)
    return JSON.stringify({ ok: false, error: { code: safe.code, message: safe.message } })
  } catch {
    return '{"ok":false,"error":{"code":"INTERNAL_ERROR","message":"Unexpected application error"}}'
  }
}

function successEnvelope(value: unknown = null): string {
  try {
    return JSON.stringify({ ok: true, value: value ?? null })
  } catch (error) {
    return errorEnvelope(error)
  }
}

async function sdkModule(context: vm.Context): Promise<vm.SourceTextModule> {
  const module = new vm.SourceTextModule(
    'export function defineWorkflow(definition) { return Object.freeze(definition) }',
    { context, identifier: SDK_SPECIFIER },
  )
  await module.link((specifier) => rejectImport(specifier))
  await module.evaluate()
  return module
}

async function contextModule(
  context: vm.Context,
  requestCapability: (request: WorkerCapabilityRequest) => Promise<unknown>,
): Promise<vm.SourceTextModule> {
  const guest = { settle: undefined as ((envelopeJson: string) => unknown) | undefined }
  const settle = (envelopeJson: string) => {
    try { guest.settle?.(envelopeJson) } catch { /* Guest settlement is observational to the host bridge. */ }
  }
  const bridge = isolateHostFunction((((requestJson: unknown): string => {
    try {
      if (typeof requestJson !== 'string') return errorEnvelope(protocolError())
      const parsed = JSON.parse(requestJson) as unknown
      if (!parsed || typeof parsed !== 'object') return errorEnvelope(protocolError())
      const id = Reflect.get(parsed, 'id')
      const capability = Reflect.get(parsed, 'request')
      if (typeof id !== 'string' || id.length === 0) return errorEnvelope(protocolError())
      const result = workerCapabilityRequestSchema.safeParse(capability)
      if (!result.success) return errorEnvelope(protocolError())
      void requestCapability(result.data).then(
        (value) => settle(JSON.stringify({ id, envelope: successEnvelope(value) })),
        (error) => settle(JSON.stringify({ id, envelope: errorEnvelope(error) })),
      )
      return successEnvelope()
    } catch (error) {
      return errorEnvelope(error)
    }
  })) as (...arguments_: never[]) => unknown)
  const originOf = isolateHostFunction((((valueJson: unknown): string => {
    try {
      if (typeof valueJson !== 'string') return errorEnvelope(protocolError())
      const value = JSON.parse(valueJson) as unknown
      if (typeof value !== 'string') return errorEnvelope(protocolError())
      return successEnvelope(new URL(value).origin)
    } catch (error) {
      return errorEnvelope(error)
    }
  })) as (...arguments_: never[]) => unknown)
  const log = isolateHostFunction((((requestJson: unknown): string => {
    try {
      if (typeof requestJson !== 'string') return errorEnvelope(protocolError())
      const parsed = JSON.parse(requestJson) as unknown
      if (!parsed || typeof parsed !== 'object') return errorEnvelope(protocolError())
      const level = Reflect.get(parsed, 'level')
      const message = Reflect.get(parsed, 'message')
      if (typeof level !== 'string' || !['debug', 'info', 'warn', 'error'].includes(level) || typeof message !== 'string') return errorEnvelope(protocolError())
      write({ type: 'log', level: level as 'debug' | 'info' | 'warn' | 'error', message })
      return successEnvelope()
    } catch (error) {
      return errorEnvelope(error)
    }
  })) as (...arguments_: never[]) => unknown)
  const global = context as Record<string, unknown>
  global.__autoforgeCapabilityBridge = bridge
  global.__autoforgeOriginOf = originOf
  global.__autoforgeLogBridge = log
  const module = new vm.SourceTextModule(`
    const bridge = globalThis.__autoforgeCapabilityBridge
    const originOf = globalThis.__autoforgeOriginOf
    const logBridge = globalThis.__autoforgeLogBridge
    delete globalThis.__autoforgeCapabilityBridge
    delete globalThis.__autoforgeOriginOf
    delete globalThis.__autoforgeLogBridge
    const pending = new Map()
    let requestSequence = 0
    function guestError(value) {
      const error = new Error(value && typeof value.message === 'string' ? value.message : 'The worker protocol message is invalid.')
      error.code = value && typeof value.code === 'string' ? value.code : 'WORKER_PROTOCOL_INVALID'
      return error
    }
    function decode(envelopeJson) {
      let envelope
      try { envelope = JSON.parse(envelopeJson) } catch { throw guestError(null) }
      if (!envelope || typeof envelope !== 'object' || typeof envelope.ok !== 'boolean') throw guestError(null)
      if (!envelope.ok) throw guestError(envelope.error)
      return envelope.value
    }
    export function settle(settlementJson) {
      let settlement
      try { settlement = JSON.parse(settlementJson) } catch { return }
      if (!settlement || typeof settlement.id !== 'string' || typeof settlement.envelope !== 'string') return
      const waiter = pending.get(settlement.id)
      if (!waiter) return
      pending.delete(settlement.id)
      try { waiter.resolve(decode(settlement.envelope)) } catch (error) { waiter.reject(error) }
    }
    function request(capability, scope, args) {
      let requestJson
      try { requestJson = JSON.stringify({ id: String(++requestSequence), request: { capability, scope, arguments: args } }) }
      catch (error) { return Promise.reject(error) }
      return new Promise((resolve, reject) => {
        const id = String(requestSequence)
        pending.set(id, { resolve, reject })
        try { decode(bridge(requestJson)) }
        catch (error) { pending.delete(id); reject(error) }
      })
    }
    function origin(value) { return decode(originOf(JSON.stringify(value))) }
    function emitLog(level, message) { decode(logBridge(JSON.stringify({ level, message }))) }
    let currentOrigin
    const browser = Object.freeze({
      async open(url) {
        const nextOrigin = origin(url)
        await request('browser.open', { origins: [nextOrigin] }, { url })
        currentOrigin = nextOrigin
      },
      fill(locator, value) {
        if (!currentOrigin) throw new Error('A page must be opened first')
        return request('browser.fill', { origins: [currentOrigin] }, { locator, value })
      },
      click(locator) {
        if (!currentOrigin) throw new Error('A page must be opened first')
        return request('browser.click', { origins: [currentOrigin] }, { locator })
      },
      url() {
        if (!currentOrigin) throw new Error('A page must be opened first')
        return request('browser.url', { origins: [currentOrigin] }, {})
      },
      async close() {
        if (!currentOrigin) return
        const origin = currentOrigin
        await request('browser.close', { origins: [origin] }, {})
        currentOrigin = undefined
      },
    })
    const converter = Object.freeze({
      submit(input) {
        const targetFormat = input && input.targetFormat
        return request('file.convert', { formats: [targetFormat] }, input)
      },
    })
    const logger = Object.freeze({
      debug(message) { emitLog('debug', message) },
      info(message) { emitLog('info', message) },
      warn(message) { emitLog('warn', message) },
      error(message) { emitLog('error', message) },
    })
    export default Object.freeze({ browser, converter, logger })
  `, { context, identifier: 'autoforge:workflow-context' })
  await module.link((specifier) => rejectImport(specifier))
  await module.evaluate()
  guest.settle = Reflect.get(module.namespace, 'settle') as (envelopeJson: string) => unknown
  return module
}

async function loadWorkflow(
  entryPath: string,
  requestCapability: (request: WorkerCapabilityRequest) => Promise<unknown>,
): Promise<WorkflowDefinition> {
  if (typeof vm.SourceTextModule !== 'function') throw protocolError()
  const canonicalEntry = await realpath(entryPath)
  const source = await readFile(canonicalEntry, 'utf8')
  const context = vm.createContext(Object.create(null), {
    name: 'autoforge-workflow',
    codeGeneration: { strings: false, wasm: false },
  })
  const sdk = await sdkModule(context)
  const capabilities = await contextModule(context, requestCapability)
  const entry = new vm.SourceTextModule(source, {
    context,
    identifier: canonicalEntry,
    importModuleDynamically: async (specifier) => {
      if (specifier !== SDK_SPECIFIER) return rejectImport(specifier)
      return sdk
    },
  })
  await entry.link(async (specifier) => {
    if (specifier !== SDK_SPECIFIER) return rejectImport(specifier)
    return sdk
  })
  await entry.evaluate()
  const wrapper = new vm.SourceTextModule(`
    import definition from 'autoforge:workflow-entry'
    import workflowContext from 'autoforge:workflow-context'
    function serializeError(error) {
      let code = 'INTERNAL_ERROR'
      let message = 'Unexpected application error'
      try { if (error && typeof error.code === 'string') code = error.code } catch {}
      try { if (error && typeof error.message === 'string') message = error.message } catch {}
      try { return JSON.stringify({ ok: false, error: { code, message } }) }
      catch { return '{"ok":false,"error":{"code":"INTERNAL_ERROR","message":"Unexpected application error"}}' }
    }
    export async function invoke(inputJson) {
      try {
        if (!definition || typeof definition !== 'object' || typeof definition.run !== 'function') {
          const error = new Error('The worker protocol message is invalid.')
          error.code = 'WORKER_PROTOCOL_INVALID'
          throw error
        }
        const input = JSON.parse(inputJson)
        const output = await definition.run(workflowContext, input)
        return JSON.stringify({ ok: true, value: output === undefined ? null : output })
      } catch (error) { return serializeError(error) }
    }
  `, { context, identifier: 'autoforge:workflow-invoker' })
  await wrapper.link(async (specifier) => {
    if (specifier === 'autoforge:workflow-entry') return entry
    if (specifier === 'autoforge:workflow-context') return capabilities
    return rejectImport(specifier)
  })
  await wrapper.evaluate()
  const invoke = Reflect.get(wrapper.namespace, 'invoke') as unknown
  if (typeof invoke !== 'function') throw protocolError()
  return { invoke: invoke as WorkflowDefinition['invoke'] }
}

function requestCapability(state: RunnerState, request: WorkerCapabilityRequest): Promise<unknown> {
  if (state.terminal) return Promise.reject(cancelledError())
  const requestId = randomUUID()
  const result = new Promise((resolve, reject) => {
    state.pending.set(requestId, { resolve, reject })
    write({ type: 'capability_request', requestId, request })
  })
  void result.catch(() => undefined)
  return result
}

function notifyPendingDrained(state: RunnerState): void {
  if (state.pending.size !== 0) return
  for (const resolvePending of state.pendingWaiters) resolvePending()
  state.pendingWaiters.clear()
}

async function waitForPending(state: RunnerState): Promise<void> {
  while (state.pending.size !== 0) {
    await new Promise<void>((resolvePending) => state.pendingWaiters.add(resolvePending))
  }
}

function terminate(state: RunnerState, error: AppError): void {
  if (state.terminal) return
  state.terminal = true
  for (const pending of state.pending.values()) pending.reject(error)
  state.pending.clear()
  notifyPendingDrained(state)
  write({ type: 'error', error })
  process.stdin.pause()
}

async function runWorkflow(state: RunnerState, message: Extract<WorkerRequest, { type: 'start' }>): Promise<void> {
  try {
    const loaded = await loadWorkflow(message.entryPath, (request) => requestCapability(state, request))
    if (state.terminal) return
    write({ type: 'ready', executionId: message.executionId })
    const inputJson = JSON.stringify(message.input ?? null)
    const outputJson = await loaded.invoke(inputJson)
    if (typeof outputJson !== 'string') throw protocolError()
    const envelope = JSON.parse(outputJson) as unknown
    if (!envelope || typeof envelope !== 'object' || typeof Reflect.get(envelope, 'ok') !== 'boolean') throw protocolError()
    if (!Reflect.get(envelope, 'ok')) throw Reflect.get(envelope, 'error')
    const output = Reflect.get(envelope, 'value')
    await waitForPending(state)
    if (!state.terminal) {
      state.terminal = true
      write({ type: 'result', output: output ?? null })
      process.stdin.pause()
    }
  } catch (error) {
    terminate(state, toSafeAppError(error))
  }
}

async function handle(state: RunnerState, message: WorkerRequest): Promise<void> {
  if (message.type === 'start') {
    if (state.started) return terminate(state, protocolError())
    state.started = true
    state.executionId = message.executionId
    void runWorkflow(state, message)
    return
  }
  if (!state.started || state.terminal) return terminate(state, protocolError())

  if (message.type === 'cancel') {
    if (message.executionId !== state.executionId) return terminate(state, protocolError())
    terminate(state, cancelledError())
    return
  }
  const pending = state.pending.get(message.requestId)
  if (!pending) return terminate(state, protocolError())
  state.pending.delete(message.requestId)
  if (message.type === 'capability_result') pending.resolve(message.result)
  else pending.reject(message.error)
  notifyPendingDrained(state)
}

function consumeJsonLines(onLine: (line: Buffer) => void, onViolation: () => void): (chunk: Buffer | string) => void {
  let buffer = Buffer.alloc(0)
  return (value) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset)
      const end = newline === -1 ? chunk.length : newline
      const segment = chunk.subarray(offset, end)
      if (buffer.length + segment.length > MAX_LINE_BYTES) {
        buffer = Buffer.alloc(0)
        onViolation()
        return
      }
      if (newline === -1) {
        buffer = buffer.length === 0 ? Buffer.from(segment) : Buffer.concat([buffer, segment])
        return
      }
      let line = buffer.length === 0 ? Buffer.from(segment) : Buffer.concat([buffer, segment])
      buffer = Buffer.alloc(0)
      if (line.at(-1) === 13) line = line.subarray(0, -1)
      onLine(line)
      offset = newline + 1
    }
  }
}

function startRunner(): void {
  const state: RunnerState = {
    started: false,
    terminal: false,
    pending: new Map(),
    pendingWaiters: new Set(),
  }
  let queue = Promise.resolve()
  const violate = () => terminate(state, protocolError())
  process.stdin.on('data', consumeJsonLines((line) => {
    queue = queue.then(async () => {
      if (state.terminal) return
      let value: unknown
      try {
        value = JSON.parse(line.toString('utf8'))
      } catch {
        violate()
        return
      }
      const parsed = workerRequestSchema.safeParse(value)
      if (!parsed.success) {
        violate()
        return
      }
      await handle(state, parsed.data)
    }).catch(violate)
  }, violate))
  process.stdin.on('error', violate)
}

if (process.env.AUTOFORGE_EXECUTION_NONCE) startRunner()
