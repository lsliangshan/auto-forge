import { randomUUID } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import * as vm from 'node:vm'
import {
  toSafeAppError,
  workerRequestSchema,
  workerResponseSchema,
  type AppError,
  type WorkerCapabilityRequest,
  type WorkerRequest,
  type WorkerResponse,
} from '@autoforge/shared'

const MAX_LINE_BYTES = 1024 * 1024
const SDK_SPECIFIER = '@autoforge/workflow-sdk'

interface WorkflowDefinition {
  run(context: unknown, input: unknown): Promise<unknown> | unknown
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
  const bridge = isolateHostFunction(((
    request: WorkerCapabilityRequest,
    resolvePromise: (value: unknown) => void,
    rejectPromise: (error: AppError) => void,
  ) => {
    void requestCapability(request).then(resolvePromise, (error) => rejectPromise(toSafeAppError(error)))
  }) as (...arguments_: never[]) => unknown)
  const originOf = isolateHostFunction(((value: string) => new URL(value).origin) as (...arguments_: never[]) => unknown)
  const log = isolateHostFunction((((level: unknown, message: unknown) => {
    if (!['debug', 'info', 'warn', 'error'].includes(String(level)) || typeof message !== 'string') throw protocolError()
    write({ type: 'log', level: level as 'debug' | 'info' | 'warn' | 'error', message })
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
    let currentOrigin
    function request(capability, scope, args) {
      return new Promise((resolve, reject) => bridge({ capability, scope, arguments: args }, resolve, reject))
    }
    const browser = Object.freeze({
      async open(url) {
        const origin = originOf(url)
        await request('browser.open', { origins: [origin] }, { url })
        currentOrigin = origin
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
    const logger = Object.freeze({
      debug(message) { logBridge('debug', message) },
      info(message) { logBridge('info', message) },
      warn(message) { logBridge('warn', message) },
      error(message) { logBridge('error', message) },
    })
    export default Object.freeze({ browser, logger })
  `, { context, identifier: 'autoforge:workflow-context' })
  await module.link((specifier) => rejectImport(specifier))
  await module.evaluate()
  return module
}

async function loadWorkflow(
  entryPath: string,
  requestCapability: (request: WorkerCapabilityRequest) => Promise<unknown>,
): Promise<{ definition: WorkflowDefinition; context: unknown }> {
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
  const definition = Reflect.get(entry.namespace, 'default') as unknown
  if (!definition || typeof definition !== 'object' || typeof (definition as WorkflowDefinition).run !== 'function') {
    throw protocolError()
  }
  return { definition: definition as WorkflowDefinition, context: Reflect.get(capabilities.namespace, 'default') }
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
    const output = await loaded.definition.run(loaded.context, message.input)
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
