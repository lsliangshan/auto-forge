import { randomUUID } from 'node:crypto'
import { fork as nodeFork, type ChildProcess, type ForkOptions } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import {
  approvalDecisionSchema,
  matchesHttpsUrlPattern,
  matchesHttpsUrlPatternOrigin,
  toSafeAppError,
  workerRequestSchema,
  workerResponseSchema,
  type AppError,
  type AppErrorCode,
  type ApprovalDecision,
  type Capability,
  type CapabilityScope,
  type ExecutionEvent,
  type WorkerCapabilityRequest,
  type WorkerRequest,
  type WorkerResponse,
  type WorkflowDetail,
} from '@autoforge/shared'
import type {
  AppRepositories,
  Execution,
  ExecutionLogInput,
  ExecutionStep,
} from '../database/repositories.js'
import { PolicyEngine, scopeHash } from '../permissions/policy-engine.js'
import { validateWorkflowOutput } from './output-validation.js'
import type { WorkflowExecutionSourceSelector } from './workflow-source-selector.js'

const MAX_LINE_BYTES = 1024 * 1024

type ExecutionRepository = Pick<AppRepositories['executions'], 'insert' | 'get' | 'update'>
type ExecutionLogRepository = Pick<AppRepositories['executionLogs'], 'insert'>
type ExecutionStepRepository = Pick<AppRepositories['executionSteps'], 'insert'>

export interface ExecutionRepositories {
  executions: ExecutionRepository
  executionLogs: ExecutionLogRepository
  executionSteps: ExecutionStepRepository
}

export interface WorkflowExecutionSource {
  workflow: WorkflowDetail
  rootPath: string
  entryPath: string
  integrity: WorkflowDetail['integrity']
}

export interface WorkflowExecutionSourceResolver {
  resolve(
    workflowId: string,
    version: string,
    selector: WorkflowExecutionSourceSelector,
  ): Promise<WorkflowExecutionSource | undefined>
}

export interface TemporaryDirectoryPort {
  create(): Promise<string>
  remove(path: string): Promise<void>
}

export interface CapabilityContext {
  executionId: string
  userId: string
  workflowId: string
  workflowVersion: string
}

export interface CapabilityPort {
  request(context: CapabilityContext, request: WorkerCapabilityRequest): Promise<unknown>
  closeExecution(executionId: string): Promise<void> | void
}

export interface WorkflowWorker {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  kill(signal?: NodeJS.Signals): boolean
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  on(event: 'error', listener: (error: Error) => void): this
}

export interface WorkflowWorkerSpecification {
  executionId: string
  nonce: string
  cwd: string
  env: NodeJS.ProcessEnv
}

export interface WorkflowWorkerFactory {
  spawn(specification: WorkflowWorkerSpecification): Promise<WorkflowWorker> | WorkflowWorker
}

type Fork = (
  modulePath: string,
  args?: readonly string[],
  options?: ForkOptions,
) => ChildProcess

export class NodeWorkerFactory implements WorkflowWorkerFactory {
  constructor(
    private readonly runnerPath: string,
    private readonly forkProcess: Fork = nodeFork,
  ) {}

  spawn(specification: WorkflowWorkerSpecification): WorkflowWorker {
    const child = this.forkProcess(this.runnerPath, [], {
      cwd: specification.cwd,
      env: specification.env,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      execArgv: ['--experimental-vm-modules'],
    })
    if (!child.stdin || !child.stdout || !child.stderr) {
      child.kill()
      throw failure('INTERNAL_ERROR')
    }
    return child as WorkflowWorker
  }
}

export interface ExecutionStartInput {
  userId: string
  workflowId: string
  workflowVersion: string
  input: unknown
  chatRunId?: string
  timeoutMs?: number
  sensitivePaths?: readonly string[]
  /** Main-process-only selector. The application resolver accepts only selectors its vault created. */
  sourceSelector: WorkflowExecutionSourceSelector
}

export interface StartedExecution {
  id: string
  finished: Promise<Execution>
}

export interface ExecutionReservation {
  readonly executionId: string
}

interface ReservationRecord {
  readonly handle: ExecutionReservation
  readonly executionId: string
  cancelled: boolean
  started: boolean
  cleaned: boolean
  starting?: Promise<StartedExecution>
}

interface PendingCapability {
  requestId: string
  request: WorkerCapabilityRequest
  permissionIndex: number
  requiresApproval: boolean
}

interface ActiveExecution {
  id: string
  userId: string
  workflow: WorkflowDetail
  worker: WorkflowWorker
  directory: string
  sensitivePaths: readonly string[]
  buffer: Buffer
  messageQueue: Promise<void>
  pending?: PendingCapability
  timer: ReturnType<typeof setTimeout>
  terminal: boolean
  exited: boolean
  logSequence: number
  stepSequence: number
  finished: Promise<Execution>
  resolveFinished: (execution: Execution) => void
  rejectFinished: (error: AppError) => void
  finishing?: Promise<void>
}

export interface ExecutionServiceDependencies {
  repositories: ExecutionRepositories
  sourceResolver: WorkflowExecutionSourceResolver
  policy: PolicyEngine
  workers: WorkflowWorkerFactory
  capability: CapabilityPort
  emit: (event: ExecutionEvent) => void
  temporaryDirectories?: TemporaryDirectoryPort
}

function failure(code: AppErrorCode): AppError {
  return toSafeAppError({ code })
}

function statusEvent(executionId: string, status: Execution['status'], error?: AppError): ExecutionEvent {
  return {
    type: 'status',
    executionId,
    status: status as Extract<ExecutionEvent, { type: 'status' }>['status'],
    occurredAt: new Date().toISOString(),
    ...(error ? { error } : {}),
  }
}

function workerEnvironment(nonce: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { AUTOFORGE_EXECUTION_NONCE: nonce }
  for (const name of ['LANG', 'LC_ALL', 'TZ'] as const) {
    if (process.env[name]) environment[name] = process.env[name]
  }
  if (process.platform === 'win32' && process.env.SystemRoot) {
    environment.SystemRoot = process.env.SystemRoot
  }
  if (process.versions.electron) environment.ELECTRON_RUN_AS_NODE = '1'
  return environment
}

function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`)
}

function sameExactPermission(
  left: { capability: Capability; scope: CapabilityScope },
  right: { capability: Capability; scope: CapabilityScope },
): boolean {
  return left.capability === right.capability && scopeHash(left.scope) === scopeHash(right.scope)
}

function permissionCoversRequest(
  declared: { capability: Capability; scope: CapabilityScope },
  request: WorkerCapabilityRequest,
): boolean {
  if (declared.capability !== request.capability
    || !('origins' in declared.scope)
    || request.scope.origins.length !== 1) {
    return false
  }

  const requestOrigin = request.scope.origins[0]!
  if (request.capability === 'browser.open') {
    try {
      if (new URL(request.arguments.url).origin !== requestOrigin) return false
    } catch {
      return false
    }
    return declared.scope.origins.some((pattern) => matchesHttpsUrlPattern(pattern, request.arguments.url))
  }

  return declared.scope.origins.some((pattern) => matchesHttpsUrlPatternOrigin(pattern, requestOrigin))
}

function exactHostOrigin(pattern: string): string | undefined {
  if (pattern.includes('*')) return undefined
  const authority = pattern.replace(/^https:\/\//i, '')
  if (!authority || authority.includes('/')) return undefined
  try {
    const url = new URL(/^https:\/\//i.test(pattern) ? pattern : `https://${pattern}`)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined
    return url.origin
  } catch {
    return undefined
  }
}

function effectiveCapabilityRequest(
  declared: { capability: Capability; scope: CapabilityScope },
  request: WorkerCapabilityRequest,
): WorkerCapabilityRequest {
  if (request.capability !== 'browser.open' || !('origins' in declared.scope)) return request
  const origins = [...request.scope.origins]
  for (const pattern of declared.scope.origins) {
    const origin = exactHostOrigin(pattern)
    if (origin && !origins.includes(origin)) origins.push(origin)
  }
  return { ...request, scope: { origins } }
}

export class ExecutionService {
  private readonly active = new Map<string, ActiveExecution>()
  private readonly reservationHandles = new WeakMap<ExecutionReservation, ReservationRecord>()
  private readonly reservationsById = new Map<string, ReservationRecord>()
  private readonly temporaryDirectories: TemporaryDirectoryPort
  private stopped = false
  private shutdownPromise?: Promise<void>

  constructor(private readonly dependencies: ExecutionServiceDependencies) {
    this.temporaryDirectories = dependencies.temporaryDirectories ?? {
      create: () => mkdtemp(join(tmpdir(), 'autoforge-execution-')),
      remove: (path) => rm(path, { recursive: true, force: true }),
    }
  }

  hasActiveExecutions(): boolean {
    return this.active.size > 0 || this.reservationsById.size > 0
  }

  reserve(): ExecutionReservation {
    if (this.stopped) throw failure('CONFLICT')
    const handle = Object.freeze({ executionId: randomUUID() })
    const record: ReservationRecord = {
      handle,
      executionId: handle.executionId,
      cancelled: false,
      started: false,
      cleaned: false,
    }
    this.reservationHandles.set(handle, record)
    this.reservationsById.set(record.executionId, record)
    return handle
  }

  discardReservation(reservation: ExecutionReservation): boolean {
    const record = this.reservationHandles.get(reservation)
    if (!record || record.handle !== reservation || record.started) return false
    record.cancelled = true
    this.reservationHandles.delete(reservation)
    this.reservationsById.delete(record.executionId)
    return true
  }

  async start(input: ExecutionStartInput, signal?: AbortSignal): Promise<StartedExecution> {
    return this.startReserved(this.reserve(), input, signal)
  }

  async startReserved(
    reservation: ExecutionReservation,
    input: ExecutionStartInput,
    signal?: AbortSignal,
  ): Promise<StartedExecution> {
    const record = this.reservationHandles.get(reservation)
    if (!record || record.handle !== reservation || record.started) throw failure('CONFLICT')
    // A valid reservation transfers to ExecutionService at invocation. Every rejection
    // after this point is service-owned and must release its reservation and once grants.
    record.started = true
    if (this.stopped) return this.rejectOwnedReservation(record, failure('CONFLICT'))
    if (record.cancelled || signal?.aborted) {
      record.cancelled = true
      return this.rejectOwnedReservation(record, failure('CANCELLED'))
    }
    const onAbort = () => { record.cancelled = true }
    signal?.addEventListener('abort', onAbort, { once: true })
    record.starting = this.startReservation(record, input)
    try {
      return await record.starting
    } catch (error) {
      return this.rejectOwnedReservation(record, toSafeAppError(error))
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  private async startReservation(record: ReservationRecord, input: ExecutionStartInput): Promise<StartedExecution> {
    const id = record.executionId
    const inserted = this.dependencies.repositories.executions.insert({
      id,
      workflowId: input.workflowId,
      workflowVersion: input.workflowVersion,
      status: 'queued',
      input: input.input,
      ...(input.chatRunId ? { chatRunId: input.chatRunId } : {}),
    })
    this.emit(statusEvent(id, inserted.status))

    const checkCancelled = () => {
      if (record.cancelled) throw failure('CANCELLED')
    }
    let directory: string | undefined
    let entryPath: string
    let worker: WorkflowWorker | undefined
    let workflow: WorkflowDetail
    try {
      checkCancelled()
      const source = await this.dependencies.sourceResolver.resolve(
        input.workflowId,
        input.workflowVersion,
        input.sourceSelector,
      )
      checkCancelled()
      if (!source) throw failure('NOT_FOUND')
      workflow = source.workflow
      entryPath = await this.resolveEntryPath(input, source, checkCancelled)
      checkCancelled()
      directory = await this.temporaryDirectories.create()
      checkCancelled()
      const nonce = randomUUID()
      worker = await this.dependencies.workers.spawn({
        executionId: id,
        nonce,
        cwd: directory,
        env: workerEnvironment(nonce),
      })
      checkCancelled()
    } catch (error) {
      if (worker) {
        try { worker.kill('SIGTERM') } catch { /* A cancelled pre-active worker may already have exited. */ }
      }
      const safe = record.cancelled ? failure('CANCELLED') : toSafeAppError(error)
      return this.failBeforeActive(id, safe, directory)
    }

    let resolveFinished: (execution: Execution) => void = () => undefined
    let rejectFinished: (error: AppError) => void = () => undefined
    const finished = new Promise<Execution>((resolvePromise, rejectPromise) => {
      resolveFinished = resolvePromise
      rejectFinished = rejectPromise
    })
    void finished.catch(() => undefined)
    const active: ActiveExecution = {
      id,
      userId: input.userId,
      workflow,
      worker,
      directory,
      sensitivePaths: input.sensitivePaths ?? [],
      buffer: Buffer.alloc(0),
      messageQueue: Promise.resolve(),
      timer: setTimeout(() => { void this.finish(id, 'failed', failure('WORKER_TIMEOUT')) }, input.timeoutMs ?? workflow.timeoutMs),
      terminal: false,
      exited: false,
      logSequence: 0,
      stepSequence: 0,
      finished,
      resolveFinished,
      rejectFinished,
    }
    this.active.set(id, active)
    this.reservationHandles.delete(record.handle)
    this.reservationsById.delete(id)
    this.attach(active)

    try {
      this.write(active, {
        type: 'start',
        executionId: id,
        workflowId: input.workflowId,
        workflowVersion: input.workflowVersion,
        entryPath,
        input: input.input,
      })
    } catch {
      await this.finish(id, 'failed', failure('WORKER_PROTOCOL_INVALID'))
    }
    return { id, finished }
  }

  async decide(value: ApprovalDecision): Promise<void> {
    const parsed = approvalDecisionSchema.safeParse(value)
    if (!parsed.success) throw failure('INVALID_INPUT')
    const active = this.active.get(parsed.data.executionId)
    if (!active || active.terminal || !active.pending?.requiresApproval) throw failure('CONFLICT')
    const pending = active.pending
    if (parsed.data.permissionIndex !== pending.permissionIndex
      || parsed.data.scopeHash !== scopeHash(pending.request.scope)) {
      throw failure('CONFLICT')
    }

    if (parsed.data.decision === 'deny') {
      await this.finish(active.id, 'failed', failure('PERMISSION_DENIED'))
      return
    }
    if (parsed.data.decision === 'always' && (
      parsed.data.workflowId !== active.workflow.id
      || parsed.data.workflowVersion !== active.workflow.version
      || !sameExactPermission(parsed.data, pending.request)
    )) {
      throw failure('INVALID_INPUT')
    }

    this.dependencies.policy.record({
      executionId: active.id,
      workflowId: active.workflow.id,
      workflowVersion: active.workflow.version,
      capability: pending.request.capability,
      scope: pending.request.scope,
      decision: parsed.data.decision,
    })
    pending.requiresApproval = false
    this.transition(active, 'running')
    await this.dispatchCapability(active, pending)
  }

  async cancel(executionId: string): Promise<void> {
    const reservation = this.reservationsById.get(executionId)
    if (reservation) {
      reservation.cancelled = true
      if (!reservation.starting) {
        this.discardReservation(reservation.handle)
        return
      }
      let started: StartedExecution
      try { started = await reservation.starting } catch { return }
      const activeAfterStart = this.active.get(executionId)
      if (!activeAfterStart) {
        await started.finished.catch(() => undefined)
        return
      }
    }
    const active = this.active.get(executionId)
    if (!active || active.terminal) return
    try {
      this.write(active, { type: 'cancel', executionId })
    } catch {
      // Termination below is authoritative even if the worker input is already closed.
    }
    await this.finish(executionId, 'cancelled', failure('CANCELLED'))
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.stopped = true
    this.shutdownPromise = this.drainShutdown()
    return this.shutdownPromise
  }

  private async drainShutdown(): Promise<void> {
    const executionIds = new Set([
      ...this.reservationsById.keys(),
      ...this.active.keys(),
    ])
    await Promise.allSettled([...executionIds].map(async (executionId) => {
      await this.cancel(executionId)
      const active = this.active.get(executionId)
      if (active?.finishing) await active.finishing
      else if (active) await active.finished.catch(() => undefined)
    }))
    await Promise.allSettled([...this.active.values()].map((active) => (
      active.finishing ?? active.finished.then(() => undefined, () => undefined)
    )))
  }

  private async resolveEntryPath(
    input: ExecutionStartInput,
    source: WorkflowExecutionSource,
    checkCancelled: () => void = () => undefined,
  ): Promise<string> {
    if (source.workflow.id !== input.workflowId
      || source.workflow.version !== input.workflowVersion
      || !source.workflow.enabled
      || source.workflow.integrity !== 'valid'
      || source.integrity !== 'valid'
      || !source.entryPath.trim()
      || isAbsolute(source.entryPath)) {
      throw failure('WORKFLOW_INTEGRITY_FAILED')
    }
    try {
      const root = await realpath(source.rootPath)
      checkCancelled()
      const entry = await realpath(resolve(root, source.entryPath))
      checkCancelled()
      if (!inside(root, entry)) throw failure('WORKFLOW_INTEGRITY_FAILED')
      return entry
    } catch {
      throw failure('WORKFLOW_INTEGRITY_FAILED')
    }
  }

  private async failBeforeActive(
    executionId: string,
    error: AppError,
    directory?: string,
  ): Promise<StartedExecution> {
    const status = error.code === 'CANCELLED' ? 'cancelled' : 'failed'
    const terminal = this.dependencies.repositories.executions.update(executionId, {
      status,
      errorCode: error.code,
      endedAt: Date.now(),
    })
    if (!terminal) throw failure('NOT_FOUND')
    this.emit(statusEvent(executionId, status, error))
    try {
      this.dependencies.policy.releaseExecution(executionId)
    } catch {
      // Cleanup continues even if a policy implementation rejects release.
    }
    try {
      await this.dependencies.capability.closeExecution(executionId)
    } catch {
      // Pre-active capability cleanup is best effort after the terminal state is durable.
    }
    if (directory) await this.removeTemporaryDirectory(directory)
    const reservation = this.reservationsById.get(executionId)
    if (reservation) this.reservationHandles.delete(reservation.handle)
    this.reservationsById.delete(executionId)
    return { id: executionId, finished: Promise.resolve(terminal) }
  }

  private async rejectOwnedReservation(record: ReservationRecord, error: AppError): Promise<never> {
    if (!record.cleaned) {
      record.cleaned = true
      this.reservationHandles.delete(record.handle)
      this.reservationsById.delete(record.executionId)
      try {
        this.dependencies.policy.releaseExecution(record.executionId)
      } catch {
        // Ownership cleanup continues even if policy cleanup rejects.
      }
      try {
        await this.dependencies.capability.closeExecution(record.executionId)
      } catch {
        // No Worker can start after this terminal reservation cleanup.
      }
    }
    throw error
  }

  private attach(active: ActiveExecution): void {
    active.worker.stderr.resume()
    active.worker.stdout.on('data', (chunk: Buffer | string) => this.consume(active, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    active.worker.stdout.on('error', () => { void this.finish(active.id, 'failed', failure('WORKER_PROTOCOL_INVALID')) })
    active.worker.stdin.on('error', () => { void this.finish(active.id, 'failed', failure('WORKER_PROTOCOL_INVALID')) })
    active.worker.on('error', () => { void this.finish(active.id, 'failed', failure('INTERNAL_ERROR')) })
    active.worker.on('exit', () => {
      active.exited = true
      if (!active.terminal) void this.finish(active.id, 'failed', failure('INTERNAL_ERROR'))
    })
  }

  private consume(active: ActiveExecution, chunk: Buffer): void {
    if (active.terminal) return
    let offset = 0
    while (offset < chunk.length && !active.terminal) {
      const newline = chunk.indexOf(10, offset)
      const end = newline === -1 ? chunk.length : newline
      const segment = chunk.subarray(offset, end)
      if (active.buffer.length + segment.length > MAX_LINE_BYTES) {
        void this.finish(active.id, 'failed', failure('WORKER_PROTOCOL_INVALID'))
        return
      }
      if (newline === -1) {
        active.buffer = active.buffer.length === 0 ? Buffer.from(segment) : Buffer.concat([active.buffer, segment])
        return
      }

      let line = active.buffer.length === 0 ? Buffer.from(segment) : Buffer.concat([active.buffer, segment])
      active.buffer = Buffer.alloc(0)
      if (line.at(-1) === 13) line = line.subarray(0, -1)
      this.enqueue(active, line)
      offset = newline + 1
    }
  }

  private enqueue(active: ActiveExecution, line: Buffer): void {
    active.messageQueue = active.messageQueue.then(async () => {
      if (active.terminal) return
      let value: unknown
      try {
        value = JSON.parse(line.toString('utf8'))
      } catch {
        await this.finish(active.id, 'failed', failure('WORKER_PROTOCOL_INVALID'))
        return
      }
      const parsed = workerResponseSchema.safeParse(value)
      if (!parsed.success) {
        await this.finish(active.id, 'failed', failure('WORKER_PROTOCOL_INVALID'))
        return
      }
      await this.handleMessage(active, parsed.data)
    }).catch(() => this.finish(active.id, 'failed', failure('INTERNAL_ERROR')))
  }

  private async handleMessage(active: ActiveExecution, message: WorkerResponse): Promise<void> {
    const status = this.dependencies.repositories.executions.get(active.id)?.status
    if (message.type === 'ready') {
      if (message.executionId !== active.id || status !== 'queued') {
        await this.finish(active.id, 'failed', failure('WORKER_PROTOCOL_INVALID'))
        return
      }
      this.transition(active, 'running', { startedAt: Date.now() })
      return
    }
    if (message.type === 'error' && (status === 'queued' || status === 'running')) {
      await this.finish(active.id, 'failed', message.error)
      return
    }
    if (status !== 'running') {
      await this.finish(active.id, 'failed', failure('WORKER_PROTOCOL_INVALID'))
      return
    }

    switch (message.type) {
      case 'log':
        this.persistLog(active, message)
        return
      case 'progress':
        this.persistStep(active, message)
        return
      case 'capability_request':
        await this.handleCapabilityRequest(active, message.requestId, message.request)
        return
      case 'result':
        if (!validateWorkflowOutput(active.workflow.outputSchema, message.output).valid) {
          await this.finish(active.id, 'failed', failure('INVALID_OUTPUT'), message.output)
          return
        }
        await this.finish(active.id, 'completed', undefined, message.output)
        return
      case 'error':
        return
    }
  }

  private async handleCapabilityRequest(
    active: ActiveExecution,
    requestId: string,
    request: WorkerCapabilityRequest,
  ): Promise<void> {
    if (active.pending) {
      await this.finish(active.id, 'failed', failure('WORKER_PROTOCOL_INVALID'))
      return
    }
    const permissionIndex = active.workflow.permissions.findIndex((declared) => permissionCoversRequest(declared, request))
    if (permissionIndex < 0) {
      await this.finish(active.id, 'failed', failure('CAPABILITY_SCOPE_DENIED'))
      return
    }
    const effectiveRequest = effectiveCapabilityRequest(active.workflow.permissions[permissionIndex]!, request)

    const evaluation = this.dependencies.policy.evaluate({
      executionId: active.id,
      workflowId: active.workflow.id,
      workflowVersion: active.workflow.version,
      capability: effectiveRequest.capability,
      scope: effectiveRequest.scope,
    })
    const pending: PendingCapability = {
      requestId,
      request: effectiveRequest,
      permissionIndex,
      requiresApproval: evaluation.requiresApproval,
    }
    active.pending = pending
    if (evaluation.requiresApproval) {
      this.transition(active, 'awaiting_approval')
      this.emit({
        type: 'approval_required',
        executionId: active.id,
        permissionIndex,
        capability: effectiveRequest.capability,
        scope: effectiveRequest.scope,
        scopeHash: scopeHash(effectiveRequest.scope),
        occurredAt: new Date().toISOString(),
      })
      return
    }
    await this.dispatchCapability(active, pending)
  }

  private async dispatchCapability(active: ActiveExecution, pending: PendingCapability): Promise<void> {
    try {
      const result = await this.dependencies.capability.request({
        executionId: active.id,
        userId: active.userId,
        workflowId: active.workflow.id,
        workflowVersion: active.workflow.version,
      }, pending.request)
      if (active.terminal) return
      this.write(active, { type: 'capability_result', requestId: pending.requestId, result: result ?? null })
    } catch (error) {
      if (active.terminal) return
      this.write(active, { type: 'capability_error', requestId: pending.requestId, error: toSafeAppError(error) })
    } finally {
      if (active.pending === pending) active.pending = undefined
    }
  }

  private persistLog(active: ActiveExecution, message: Extract<WorkerResponse, { type: 'log' }>): void {
    const createdAt = Date.now()
    const log: ExecutionLogInput = {
      id: randomUUID(),
      executionId: active.id,
      sequence: active.logSequence++,
      level: message.level,
      message: message.message,
      createdAt,
      sensitivePaths: active.sensitivePaths,
    }
    const stored = this.dependencies.repositories.executionLogs.insert(log)
    this.emit({
      type: 'log',
      executionId: active.id,
      level: stored.level as Extract<ExecutionEvent, { type: 'log' }>['level'],
      message: stored.message,
      occurredAt: new Date(createdAt).toISOString(),
    })
  }

  private persistStep(active: ActiveExecution, message: Extract<WorkerResponse, { type: 'progress' }>): void {
    const createdAt = Date.now()
    const step: ExecutionStep = {
      id: randomUUID(),
      executionId: active.id,
      sequence: active.stepSequence++,
      name: message.label,
      status: 'running',
      ...(message.percent === undefined ? {} : { percent: message.percent }),
      startedAt: createdAt,
    }
    this.dependencies.repositories.executionSteps.insert(step)
    this.emit({
      type: 'step',
      executionId: active.id,
      stepId: step.id,
      label: step.name,
      status: 'running',
      occurredAt: new Date(createdAt).toISOString(),
    })
  }

  private transition(active: ActiveExecution, status: Execution['status'], values: Partial<Execution> = {}): Execution {
    const updated = this.dependencies.repositories.executions.update(active.id, { ...values, status })
    if (!updated) throw failure('NOT_FOUND')
    this.emit(statusEvent(active.id, status))
    return updated
  }

  private async finish(
    executionId: string,
    status: 'completed' | 'failed' | 'cancelled',
    error?: AppError,
    result?: unknown,
  ): Promise<void> {
    const active = this.active.get(executionId)
    if (!active) return
    if (active.finishing) return active.finishing
    active.terminal = true
    active.finishing = (async () => {
      clearTimeout(active.timer)
      let updated: Execution | undefined
      let persistenceError: AppError | undefined
      try {
        updated = this.dependencies.repositories.executions.update(executionId, {
          status,
          ...(result === undefined ? {} : { result }),
          ...(error ? { errorCode: error.code } : {}),
          endedAt: Date.now(),
        })
        if (!updated) throw failure('NOT_FOUND')
        this.emit(statusEvent(executionId, status, error))
        if (status === 'completed') {
          this.emit({
            type: 'result',
            executionId,
            summary: 'Workflow completed.',
            occurredAt: new Date().toISOString(),
          })
        }
      } catch (error) {
        persistenceError = toSafeAppError(error)
      } finally {
        try {
          this.dependencies.policy.releaseExecution(executionId)
        } catch {
          // Cleanup continues even if a policy implementation rejects release.
        }
        try {
          await this.dependencies.capability.closeExecution(executionId)
        } catch {
          // Capability cleanup must not prevent remaining terminal cleanup.
        }
        if (!active.exited) {
          try {
            active.worker.kill('SIGTERM')
          } catch {
            // The worker may have exited between the state update and termination.
          }
        }
        await this.removeTemporaryDirectory(active.directory)
        this.active.delete(executionId)
        if (updated) active.resolveFinished(updated)
        else active.rejectFinished(persistenceError ?? failure('INTERNAL_ERROR'))
      }
    })()
    return active.finishing
  }

  private emit(event: ExecutionEvent): void {
    try {
      this.dependencies.emit(event)
    } catch {
      // Renderer listeners cannot participate in execution transactions or cleanup.
    }
  }

  private async removeTemporaryDirectory(path: string): Promise<void> {
    try {
      await this.temporaryDirectories.remove(path)
    } catch {
      // Terminal persistence and worker termination remain authoritative if temp cleanup fails.
    }
  }

  private write(active: ActiveExecution, request: WorkerRequest): void {
    const parsed = workerRequestSchema.parse(request)
    const line = `${JSON.stringify(parsed)}\n`
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw failure('WORKER_PROTOCOL_INVALID')
    active.worker.stdin.write(line)
  }
}
