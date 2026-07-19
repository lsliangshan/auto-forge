import { randomUUID } from 'node:crypto'
import { fork as nodeFork, type ChildProcess, type ForkOptions } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import {
  approvalDecisionSchema,
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
  InstalledWorkflow,
} from '../database/repositories.js'
import { PolicyEngine, scopeHash } from '../permissions/policy-engine.js'

const MAX_LINE_BYTES = 1024 * 1024

type ExecutionRepository = Pick<AppRepositories['executions'], 'insert' | 'get' | 'update'>
type ExecutionLogRepository = Pick<AppRepositories['executionLogs'], 'insert'>
type ExecutionStepRepository = Pick<AppRepositories['executionSteps'], 'insert'>
type InstalledWorkflowRepository = Pick<AppRepositories['installedWorkflows'], 'get'>

export interface ExecutionRepositories {
  executions: ExecutionRepository
  executionLogs: ExecutionLogRepository
  executionSteps: ExecutionStepRepository
  installedWorkflows: InstalledWorkflowRepository
}

export interface WorkflowRegistryPort {
  get(workflowId: string, version: string): Promise<WorkflowDetail | undefined>
}

export interface CapabilityContext {
  executionId: string
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
  workflowId: string
  workflowVersion: string
  input: unknown
  entryPath?: string
  chatRunId?: string
  timeoutMs?: number
  sensitivePaths?: readonly string[]
}

export interface StartedExecution {
  id: string
  finished: Promise<Execution>
}

interface PendingCapability {
  requestId: string
  request: WorkerCapabilityRequest
  requiresApproval: boolean
}

interface ActiveExecution {
  id: string
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
  finishing?: Promise<void>
}

export interface ExecutionServiceDependencies {
  repositories: ExecutionRepositories
  registry: WorkflowRegistryPort
  policy: PolicyEngine
  workers: WorkflowWorkerFactory
  capability: CapabilityPort
  emit: (event: ExecutionEvent) => void
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

function manifestEntry(installed: InstalledWorkflow): string | undefined {
  if (!installed.manifest || typeof installed.manifest !== 'object') return undefined
  const entryPath = (installed.manifest as { entryPath?: unknown }).entryPath
  return typeof entryPath === 'string' && entryPath.trim() ? entryPath : undefined
}

function samePermission(
  left: { capability: Capability; scope: CapabilityScope },
  right: { capability: Capability; scope: CapabilityScope },
): boolean {
  return left.capability === right.capability && scopeHash(left.scope) === scopeHash(right.scope)
}

export class ExecutionService {
  private readonly active = new Map<string, ActiveExecution>()

  constructor(private readonly dependencies: ExecutionServiceDependencies) {}

  async start(input: ExecutionStartInput): Promise<StartedExecution> {
    const workflow = await this.dependencies.registry.get(input.workflowId, input.workflowVersion)
    if (!workflow) throw failure('NOT_FOUND')
    if (!workflow.enabled || workflow.integrity !== 'valid') throw failure('WORKFLOW_INTEGRITY_FAILED')
    const entryPath = await this.resolveEntryPath(input)
    const id = randomUUID()
    const inserted = this.dependencies.repositories.executions.insert({
      id,
      workflowId: input.workflowId,
      workflowVersion: input.workflowVersion,
      status: 'queued',
      input: input.input,
      ...(input.chatRunId ? { chatRunId: input.chatRunId } : {}),
    })
    this.dependencies.emit(statusEvent(id, inserted.status))

    const directory = await mkdtemp(join(tmpdir(), 'autoforge-execution-'))
    const nonce = randomUUID()
    let worker: WorkflowWorker
    try {
      worker = await this.dependencies.workers.spawn({
        executionId: id,
        nonce,
        cwd: directory,
        env: workerEnvironment(nonce),
      })
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      const appError = toSafeAppError(error)
      const terminal = this.dependencies.repositories.executions.update(id, {
        status: 'failed',
        errorCode: appError.code,
        endedAt: Date.now(),
      }) ?? inserted
      this.dependencies.emit(statusEvent(id, 'failed', appError))
      return { id, finished: Promise.resolve(terminal) }
    }

    let resolveFinished: (execution: Execution) => void = () => undefined
    const finished = new Promise<Execution>((resolvePromise) => { resolveFinished = resolvePromise })
    const active: ActiveExecution = {
      id,
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
    }
    this.active.set(id, active)
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

    if (parsed.data.decision === 'deny') {
      await this.finish(active.id, 'failed', failure('PERMISSION_DENIED'))
      return
    }
    if (parsed.data.decision === 'always' && (
      parsed.data.workflowId !== active.workflow.id
      || parsed.data.workflowVersion !== active.workflow.version
      || !samePermission(parsed.data, pending.request)
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
    const active = this.active.get(executionId)
    if (!active || active.terminal) return
    try {
      this.write(active, { type: 'cancel', executionId })
    } catch {
      // Termination below is authoritative even if the worker input is already closed.
    }
    await this.finish(executionId, 'cancelled', failure('CANCELLED'))
  }

  private async resolveEntryPath(input: ExecutionStartInput): Promise<string> {
    if (input.entryPath) return resolve(input.entryPath)
    const installed = this.dependencies.repositories.installedWorkflows.get(input.workflowId, input.workflowVersion)
    const relativeEntry = installed && manifestEntry(installed)
    if (!installed || !relativeEntry) throw failure('NOT_FOUND')
    const root = await realpath(installed.installPath)
    const entry = await realpath(resolve(root, relativeEntry))
    if (!inside(root, entry)) throw failure('WORKFLOW_INTEGRITY_FAILED')
    return entry
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
    if (!active.workflow.permissions.some((declared) => samePermission(declared, request))) {
      await this.finish(active.id, 'failed', failure('CAPABILITY_SCOPE_DENIED'))
      return
    }

    const evaluation = this.dependencies.policy.evaluate({
      executionId: active.id,
      workflowId: active.workflow.id,
      workflowVersion: active.workflow.version,
      capability: request.capability,
      scope: request.scope,
    })
    const pending: PendingCapability = { requestId, request, requiresApproval: evaluation.requiresApproval }
    active.pending = pending
    if (evaluation.requiresApproval) {
      this.transition(active, 'awaiting_approval')
      return
    }
    await this.dispatchCapability(active, pending)
  }

  private async dispatchCapability(active: ActiveExecution, pending: PendingCapability): Promise<void> {
    try {
      const result = await this.dependencies.capability.request({
        executionId: active.id,
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
    this.dependencies.emit({
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
    this.dependencies.emit({
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
    this.dependencies.emit(statusEvent(active.id, status))
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
      const updated = this.dependencies.repositories.executions.update(executionId, {
        status,
        ...(result === undefined ? {} : { result }),
        ...(error ? { errorCode: error.code } : {}),
        endedAt: Date.now(),
      })
      if (!updated) throw failure('NOT_FOUND')
      this.dependencies.emit(statusEvent(executionId, status, error))
      if (status === 'completed') {
        this.dependencies.emit({
          type: 'result',
          executionId,
          summary: 'Workflow completed.',
          occurredAt: new Date().toISOString(),
        })
      }
      this.dependencies.policy.releaseExecution(executionId)
      try {
        await this.dependencies.capability.closeExecution(executionId)
      } catch {
        // Capability cleanup must not prevent the execution from becoming terminal.
      }
      if (!active.exited) {
        try {
          active.worker.kill('SIGTERM')
        } catch {
          // The worker may have exited between the state update and termination.
        }
      }
      try {
        await rm(active.directory, { recursive: true, force: true })
      } catch {
        // Terminal persistence and worker termination remain authoritative if temp cleanup fails.
      }
      this.active.delete(executionId)
      active.resolveFinished(updated)
    })()
    return active.finishing
  }

  private write(active: ActiveExecution, request: WorkerRequest): void {
    const parsed = workerRequestSchema.parse(request)
    const line = `${JSON.stringify(parsed)}\n`
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw failure('WORKER_PROTOCOL_INVALID')
    active.worker.stdin.write(line)
  }
}
