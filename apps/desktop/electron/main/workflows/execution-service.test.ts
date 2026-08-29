import { EventEmitter } from 'node:events'
import { execFileSync, fork as forkProcess, type ForkOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, constants, openSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type {
  ApprovalDecision,
  ConversionTargetFormat,
  ExecutionEvent,
  WorkerCapabilityRequest,
  WorkerRequest,
  WorkerResponse,
  WorkflowDetail,
} from '@autoforge/shared'
import { workerRequestSchema } from '@autoforge/shared'
import { describe, expect, it, vi } from 'vitest'
import type { Execution, ExecutionLog, ExecutionStep, PermissionGrant } from '../database/repositories.js'
import { PolicyEngine, scopeHash } from '../permissions/policy-engine.js'
import {
  ExecutionService,
  NodeWorkerFactory,
  type CapabilityPort,
  type CapabilityContext,
  type ExecutionAttachmentBinding,
  type ExecutionRepositories,
  type FileConversionPort,
  type WorkflowExecutionSourceResolver,
  type WorkflowWorker,
  type WorkflowWorkerFactory,
} from './execution-service.js'
import { createWorkflowExecutionSourceResolver } from '../application.js'
import { browserPermissionMatrix, workflowSecurityFingerprint } from './workflow-security-fingerprint.js'
import { createWorkflowSourceSelectorVault } from './workflow-source-selector.js'

class FakeWorker extends EventEmitter implements WorkflowWorker {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killed = false
  readonly requests: WorkerRequest[] = []
  loadedEntry?: Buffer
  private input = ''

  constructor() {
    super()
    this.stdin.on('data', (chunk: Buffer) => {
      this.input += chunk.toString('utf8')
      const lines = this.input.split('\n')
      this.input = lines.pop() ?? ''
      for (const line of lines) {
        if (!line) continue
        const request = workerRequestSchema.parse(JSON.parse(line))
        this.requests.push(request)
        if (request.type === 'start') this.loadedEntry = readFileSync(request.entryPath)
      }
    })
  }

  kill(): boolean {
    this.killed = true
    queueMicrotask(() => this.emit('exit', null, 'SIGTERM'))
    return true
  }

  respond(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`)
  }
}

class FakeWorkerFactory implements WorkflowWorkerFactory {
  readonly workers = new Map<string, FakeWorker>()
  readonly specifications: Array<{ executionId: string; cwd: string; env: NodeJS.ProcessEnv }> = []

  constructor(
    private readonly beforeSpawn: (
      specification: Parameters<WorkflowWorkerFactory['spawn']>[0],
    ) => Promise<void> | void = () => undefined,
  ) {}

  async spawn(specification: Parameters<WorkflowWorkerFactory['spawn']>[0]): Promise<WorkflowWorker> {
    await this.beforeSpawn(specification)
    const worker = new FakeWorker()
    this.workers.set(specification.executionId, worker)
    this.specifications.push({ executionId: specification.executionId, cwd: specification.cwd, env: specification.env })
    return worker
  }
}

function createRepositories(): ExecutionRepositories & { records: Map<string, Execution> } {
  const records = new Map<string, Execution>()
  const logs: ExecutionLog[] = []
  const steps: ExecutionStep[] = []
  return {
    records,
    executions: {
      insert(value) {
        const record = { input: {}, createdAt: Date.now(), ...value } as Execution
        records.set(record.id, record)
        return record
      },
      get: (id) => records.get(id),
      update(id, value) {
        const current = records.get(id)
        if (!current) return undefined
        const updated = { ...current, ...value }
        records.set(id, updated)
        return updated
      },
    },
    executionLogs: {
      insert(value) {
        const log = { ...value } as ExecutionLog
        logs.push(log)
        return log
      },
    },
    executionSteps: {
      insert(value) {
        steps.push(value)
        return value
      },
    },
  }
}

function createPermissionRepository() {
  return {
    upsert: vi.fn((value: PermissionGrant) => value),
    get: vi.fn(() => undefined),
    delete: vi.fn(() => undefined),
  }
}

const workflow: WorkflowDetail = {
  id: 'browser.search.baidu',
  version: '1.0.0',
  name: 'Baidu Search',
  description: 'Searches Baidu',
  author: 'AutoForge',
  category: 'browser',
  enabled: true,
  source: 'installed',
  integrity: 'valid',
  updatedAt: new Date(0).toISOString(),
  codeSha256: createHash('sha256')
    .update(readFileSync(fileURLToPath(new URL('../../workers/workflow-runner.ts', import.meta.url))))
    .digest('hex'),
  cities: [],
  runtimeIdentity: { id: 'browser.search.baidu', version: '1.0.0', source: 'installed' },
  permissions: [{ capability: 'browser.open', scope: { origins: ['https://www.baidu.com'] } }],
  activationExamples: ['search'],
  activationNegativeExamples: [],
  timeoutMs: 5_000,
  inputSchema: {},
  outputSchema: {},
}

const capabilityRequest: WorkerCapabilityRequest = {
  capability: 'browser.open',
  scope: { origins: ['https://www.baidu.com'] },
  arguments: { url: 'https://www.baidu.com' },
}

const conversionWorkflow: WorkflowDetail = {
  ...workflow,
  id: 'file.convert.test',
  name: 'File converter',
  category: 'files',
  runtimeIdentity: { id: 'file.convert.test', version: workflow.version, source: 'installed' },
  permissions: [{ capability: 'file.convert', scope: { formats: ['png'] } }],
}

const conversionRequest = (patch: {
  attachmentIndex?: number
  targetFormat?: ConversionTargetFormat
  formats?: ConversionTargetFormat[]
  background?: boolean
} = {}): WorkerCapabilityRequest => ({
  capability: 'file.convert',
  scope: { formats: patch.formats ?? [patch.targetFormat ?? 'png'] },
  arguments: {
    attachmentIndex: patch.attachmentIndex ?? 0,
    targetFormat: patch.targetFormat ?? 'png',
    ...(patch.background === undefined ? {} : { background: patch.background }),
  },
})

function attachmentBinding(
  patch: Partial<Omit<ExecutionAttachmentBinding, 'source'>> & {
    source?: ExecutionAttachmentBinding['source']
  } = {},
): ExecutionAttachmentBinding {
  return {
    attachmentIndex: 0,
    ownerUserId: 'user_1',
    conversationId: 'conversation_1',
    displayName: 'source.png',
    mimeType: 'image/png',
    byteSize: 128,
    sourceFingerprint: 'f'.repeat(64),
    source: { kind: 'media', mediaAssetId: 'asset_1' },
    ...patch,
  }
}

function createFileConversionPort(options: {
  inspect?: (binding: ExecutionAttachmentBinding) => Promise<ExecutionAttachmentBinding>
  terminal?: Awaited<ReturnType<FileConversionPort['waitForTerminal']>>
  waitForTerminal?: FileConversionPort['waitForTerminal']
} = {}) {
  const inspectAttachment = vi.fn(options.inspect ?? (async (binding) => structuredClone(binding)))
  const submit = vi.fn<FileConversionPort['submit']>(() => ({
    accepted: true,
    jobId: 'job_1',
    epoch: 0,
    status: 'queued',
  }))
  const waitForTerminal = vi.fn<FileConversionPort['waitForTerminal']>(options.waitForTerminal ?? (async () => (
    options.terminal ?? {
      status: 'completed',
      outputs: [{ displayName: 'result.png', detectedFormat: 'png', byteSize: 64 }],
    }
  )))
  const cancel = vi.fn<FileConversionPort['cancel']>(async () => true)
  return { inspectAttachment, submit, waitForTerminal, cancel }
}

const trustedRootPath = fileURLToPath(new URL('../../', import.meta.url))

function createHarness(options: {
  timeoutMs?: number
  capability?: CapabilityPort
  conversion?: FileConversionPort
  source?: {
    workflow: WorkflowDetail
    rootPath: string
    entryPath: string
    integrity: 'valid' | 'failed'
  }
  sourceResolver?: WorkflowExecutionSourceResolver
  emit?: (event: ExecutionEvent) => void
  temporaryDirectories?: {
    create(): Promise<string>
    remove(path: string): Promise<void>
  }
  workerFactory?: FakeWorkerFactory
} = {}) {
  const repositories = createRepositories()
  const workerFactory = options.workerFactory ?? new FakeWorkerFactory()
  const permissionRepository = createPermissionRepository()
  const policy = new PolicyEngine(permissionRepository)
  const events: ExecutionEvent[] = []
  const capability = options.capability ?? {
    request: async () => ({ ok: true }),
    closeExecution: async () => undefined,
  }
  const source = options.source ?? {
    workflow,
    rootPath: trustedRootPath,
    entryPath: 'workers/workflow-runner.ts',
    integrity: 'valid' as const,
  }
  const sourceSelector = createWorkflowSourceSelectorVault().create(workflow)
  const dependencies = {
    repositories,
    sourceResolver: options.sourceResolver ?? { resolve: async () => source },
    policy,
    workers: workerFactory,
    capability,
    conversion: options.conversion,
    temporaryDirectories: options.temporaryDirectories,
    emit: options.emit ?? ((event: ExecutionEvent) => {
      expect(repositories.records.get(event.executionId)?.status).toBe(
        event.type === 'status' ? event.status : repositories.records.get(event.executionId)?.status,
      )
      events.push(event)
    }),
  }
  const service = new ExecutionService(dependencies)
  const start = () => service.start({
    userId: 'user_1',
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    input: { query: 'weather' },
    timeoutMs: options.timeoutMs,
    sourceSelector,
  })
  return { repositories, workerFactory, permissionRepository, policy, events, capability, sourceSelector, service, start }
}

function agentStartInput(
  selectedWorkflow: WorkflowDetail,
  sourceSelector: ReturnType<ReturnType<typeof createWorkflowSourceSelectorVault>['create']>,
) {
  return {
    userId: 'user_1',
    conversationId: 'conversation_1',
    chatRunId: 'chat_run_1',
    workflowId: selectedWorkflow.id,
    workflowVersion: selectedWorkflow.version,
    input: { query: 'weather' },
    sourceSelector,
    agentAuthorization: {
      workflowFingerprint: workflowSecurityFingerprint(selectedWorkflow),
      permissions: selectedWorkflow.permissions.map((permission, permissionIndex) => ({
        permissionIndex,
        capability: permission.capability,
        scope: permission.scope,
        scopeHash: scopeHash(permission.scope),
      })),
    },
  } as unknown as Parameters<ExecutionService['startReserved']>[1]
}

function conversionStartInput(
  executionId: string,
  sourceSelector: ReturnType<ReturnType<typeof createWorkflowSourceSelectorVault>['create']>,
  bindings: readonly ExecutionAttachmentBinding[] = [attachmentBinding()],
  options: {
    authorize?: boolean
    formats?: readonly ConversionTargetFormat[]
    authorizationFingerprint?: string
  } = {},
): Parameters<ExecutionService['startReserved']>[1] {
  return {
    userId: 'user_1',
    conversationId: 'conversation_1',
    workflowId: conversionWorkflow.id,
    workflowVersion: conversionWorkflow.version,
    input: { files: [0], targetFormat: 'png' },
    sourceSelector,
    attachmentBindings: bindings,
    ...(options.authorize === false ? {} : {
      fileConvertAuthorization: {
        executionId,
        capability: 'file.convert',
        decision: 'once',
        attachments: bindings.map((binding) => ({
          index: binding.attachmentIndex,
          sourceFingerprint: options.authorizationFingerprint ?? binding.sourceFingerprint,
        })),
        formats: options.formats ?? ['png'],
      },
    }),
  }
}

async function turn(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

interface ActualWorkerOptions {
  writeInput?: (worker: ReturnType<typeof forkProcess>, startLine: string) => Promise<void> | void
  onMessage?: (
    message: WorkerResponse,
    worker: ReturnType<typeof forkProcess>,
    messages: readonly WorkerResponse[],
  ) => void
}

async function runActualWorker(source: string, options: ActualWorkerOptions = {}): Promise<WorkerResponse[]> {
  const directory = await mkdtemp(join(tmpdir(), 'autoforge-runner-test-'))
  const entryPath = join(directory, 'workflow.mjs')
  await writeFile(entryPath, source, 'utf8')
  const runnerPath = fileURLToPath(new URL('../../workers/workflow-runner.ts', import.meta.url))
  const worker = forkProcess(runnerPath, [], {
    cwd: directory,
    env: { AUTOFORGE_EXECUTION_NONCE: 'test_nonce' },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    execArgv: ['--experimental-vm-modules'],
  })
  const messages: WorkerResponse[] = []
  let buffer = ''
  try {
    return await new Promise<WorkerResponse[]>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error('Actual workflow runner timed out')), 5_000)
      worker.on('error', reject)
      worker.on('exit', (code) => {
        if (!messages.some((message) => message.type === 'result' || message.type === 'error')) {
          reject(new Error(`Actual workflow runner exited before a terminal message: ${String(code)}`))
        }
      })
      worker.stdout!.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line) continue
          const message = JSON.parse(line) as WorkerResponse
          messages.push(message)
          try {
            options.onMessage?.(message, worker, messages)
          } catch (error) {
            clearTimeout(timer)
            reject(error)
            return
          }
          if (message.type === 'result' || message.type === 'error') {
            clearTimeout(timer)
            resolvePromise(messages)
          }
        }
      })
      const startLine = `${JSON.stringify({
        type: 'start',
        executionId: 'exec_runner',
        workflowId: 'runner.test',
        workflowVersion: '1.0.0',
        entryPath,
        input: { ok: true },
      })}\n`
      const write = options.writeInput
        ? options.writeInput(worker, startLine)
        : worker.stdin!.write(startLine)
      void Promise.resolve(write).catch(reject)
    })
  } finally {
    worker.kill('SIGTERM')
    await rm(directory, { recursive: true, force: true })
  }
}

describe('ExecutionService', () => {
  it.each(['installed', 'development'] as const)('does not spawn after a selected %s source changes', async (source) => {
    const selected = source === 'installed' ? workflow : {
      ...workflow,
      source: 'development' as const,
      runtimeIdentity: {
        id: workflow.id,
        version: workflow.version,
        source: 'development' as const,
        buildHash: 'b'.repeat(64),
      },
    }
    const vault = createWorkflowSourceSelectorVault()
    const selector = vault.create(selected)
    const project = {
      id: 'project_development', name: 'Development', rootPath: trustedRootPath, status: 'ready',
      buildHash: 'b'.repeat(64),
      manifest: { id: workflow.id, version: workflow.version, entryPath: 'workers/workflow-runner.ts', codeSha256: workflow.codeSha256 },
      createdAt: 0, updatedAt: 0,
    }
    const installed = {
      workflowId: workflow.id,
      version: workflow.version,
      installPath: trustedRootPath,
      manifest: { id: workflow.id, version: workflow.version, entryPath: 'workers/workflow-runner.ts', codeSha256: workflow.codeSha256 },
    }
    const resolver = createWorkflowExecutionSourceResolver(vault, {
      repositories: {
        workflowProjects: { list: () => source === 'development' ? [project] : [] },
        installedWorkflows: { get: () => source === 'installed' ? installed : undefined },
      },
      registry: {
        getDevelopmentProject: async () => selected.source === 'development' ? selected : undefined,
        get: async () => selected.source === 'installed' ? selected : undefined,
        verifyIntegrity: async () => ({ valid: true, disabled: false }),
      },
    } as never)
    const harness = createHarness({ sourceResolver: resolver })

    if (source === 'installed') installed.manifest.codeSha256 = 'c'.repeat(64)
    else project.buildHash = 'd'.repeat(64)
    const execution = await harness.service.start({
      userId: 'user_1', workflowId: workflow.id, workflowVersion: workflow.version,
      input: {}, sourceSelector: selector,
    })

    await expect(execution.finished).resolves.toMatchObject({ status: 'failed', errorCode: 'NOT_FOUND' })
    expect(harness.workerFactory.specifications).toEqual([])
  })

  it('rejects an installed detail with a different identity before exposing its schema or spawning', async () => {
    const vault = createWorkflowSourceSelectorVault()
    const selector = vault.create(workflow)
    const wrongDetail = {
      ...workflow,
      id: 'browser.search.other',
      runtimeIdentity: { id: 'browser.search.other', version: workflow.version, source: 'installed' as const },
      outputSchema: { selected: 'wrong-installed-detail' },
    }
    const installed = {
      workflowId: workflow.id,
      version: workflow.version,
      installPath: trustedRootPath,
      manifest: { id: workflow.id, version: workflow.version, entryPath: 'workers/workflow-runner.ts', codeSha256: workflow.codeSha256 },
    }
    const resolver = createWorkflowExecutionSourceResolver(vault, {
      repositories: {
        workflowProjects: { list: () => [] },
        installedWorkflows: { get: () => installed },
      },
      registry: {
        getDevelopmentProject: async () => undefined,
        get: async () => wrongDetail,
        verifyIntegrity: async () => ({ valid: true, disabled: false }),
      },
    } as never)
    const harness = createHarness({ sourceResolver: resolver })

    await expect(resolver.resolve(workflow.id, workflow.version, selector)).resolves.toBeUndefined()
    const execution = await harness.service.start({
      userId: 'user_1', workflowId: workflow.id, workflowVersion: workflow.version,
      input: {}, sourceSelector: selector,
    })

    await expect(execution.finished).resolves.toMatchObject({ status: 'failed', errorCode: 'NOT_FOUND' })
    expect(harness.workerFactory.specifications).toEqual([])
  })

  it('uses an unforgeable reservation so pre-start approval remains bound to the worker', async () => {
    const harness = createHarness()
    const reservation = harness.service.reserve()
    expect(harness.service.hasActiveExecutions()).toBe(true)
    const execution = await harness.service.startReserved(reservation, {
      userId: 'user_1',
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      input: { query: 'weather' },
      sourceSelector: harness.sourceSelector,
    })

    expect(execution.id).toBe(reservation.executionId)
    expect(harness.workerFactory.specifications[0]?.executionId).toBe(reservation.executionId)
    await harness.service.cancel(execution.id)
    expect(harness.service.hasActiveExecutions()).toBe(false)

    await expect(harness.service.startReserved({ executionId: 'forged' } as never, {
      userId: 'user_1', workflowId: workflow.id, workflowVersion: workflow.version, input: {}, sourceSelector: harness.sourceSelector,
    })).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('discards only an unstarted authentic reservation and makes discard idempotent', async () => {
    const harness = createHarness()
    const reservation = harness.service.reserve()
    expect(harness.service.hasActiveExecutions()).toBe(true)

    expect(harness.service.discardReservation(reservation)).toBe(true)
    expect(harness.service.hasActiveExecutions()).toBe(false)
    expect(harness.service.discardReservation(reservation)).toBe(false)
    expect(harness.service.discardReservation({ executionId: reservation.executionId } as never)).toBe(false)
    await expect(harness.service.startReserved(reservation, {
      userId: 'user_1', workflowId: workflow.id, workflowVersion: workflow.version, input: {}, sourceSelector: harness.sourceSelector,
    })).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('automatically discards a reservation when start is already aborted', async () => {
    const harness = createHarness()
    const reservation = harness.service.reserve()
    const controller = new AbortController()
    controller.abort()

    await expect(harness.service.startReserved(reservation, {
      userId: 'user_1', workflowId: workflow.id, workflowVersion: workflow.version, input: {}, sourceSelector: harness.sourceSelector,
    }, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(harness.service.discardReservation(reservation)).toBe(false)
    await expect(harness.service.startReserved(reservation, {
      userId: 'user_1', workflowId: workflow.id, workflowVersion: workflow.version, input: {}, sourceSelector: harness.sourceSelector,
    })).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('owns and releases a pre-aborted reserved start exactly once without persistence or Worker leakage', async () => {
    const harness = createHarness()
    const reservation = harness.service.reserve()
    harness.policy.record({
      executionId: reservation.executionId,
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      capability: workflow.permissions[0]!.capability,
      scope: workflow.permissions[0]!.scope,
      decision: 'once',
    })
    const releaseExecution = vi.spyOn(harness.policy, 'releaseExecution')
    const controller = new AbortController()
    controller.abort()

    await expect(harness.service.startReserved(reservation, {
      userId: 'user_1', workflowId: workflow.id, workflowVersion: workflow.version,
      input: {}, sourceSelector: harness.sourceSelector,
    }, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' })

    expect(harness.service.hasActiveExecutions()).toBe(false)
    expect(harness.repositories.records.size).toBe(0)
    expect(harness.workerFactory.workers.size).toBe(0)
    expect(releaseExecution).toHaveBeenCalledTimes(1)
    expect(releaseExecution).toHaveBeenCalledWith(reservation.executionId)
  })

  it('owns and releases a reserved start when execution insertion throws', async () => {
    const harness = createHarness()
    const reservation = harness.service.reserve()
    harness.policy.record({
      executionId: reservation.executionId,
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      capability: workflow.permissions[0]!.capability,
      scope: workflow.permissions[0]!.scope,
      decision: 'once',
    })
    const releaseExecution = vi.spyOn(harness.policy, 'releaseExecution')
    harness.repositories.executions.insert = () => { throw new Error('insert unavailable') }

    await expect(harness.service.startReserved(reservation, {
      userId: 'user_1', workflowId: workflow.id, workflowVersion: workflow.version,
      input: {}, sourceSelector: harness.sourceSelector,
    })).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })

    expect(harness.service.hasActiveExecutions()).toBe(false)
    expect(harness.repositories.records.size).toBe(0)
    expect(harness.workerFactory.workers.size).toBe(0)
    expect(releaseExecution).toHaveBeenCalledTimes(1)
    expect(releaseExecution).toHaveBeenCalledWith(reservation.executionId)
  })

  it('cancels and removes an unstarted reservation during shutdown', async () => {
    const harness = createHarness()
    const reservation = harness.service.reserve()

    await harness.service.shutdown()

    expect(harness.service.hasActiveExecutions()).toBe(false)
    await expect(harness.service.startReserved(reservation, {
      userId: 'user_1',
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      input: {},
      sourceSelector: harness.sourceSelector,
    })).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('waits for a suspended starting reservation to cancel and settle', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const source = {
      workflow, rootPath: trustedRootPath, entryPath: 'workers/workflow-runner.ts', integrity: 'valid' as const,
    }
    const harness = createHarness({
      sourceResolver: { resolve: async () => { await gate; return source } },
    })
    const reservation = harness.service.reserve()
    const starting = harness.service.startReserved(reservation, {
      userId: 'user_1',
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      input: {},
      sourceSelector: harness.sourceSelector,
    })
    await turn()
    let stopped = false
    const shutdown = harness.service.shutdown().then(() => { stopped = true })
    await turn()
    expect(stopped).toBe(false)

    release()
    const started = await starting
    await shutdown

    await expect(started.finished).resolves.toMatchObject({
      status: 'cancelled',
      errorCode: 'CANCELLED',
    })
    expect(harness.service.hasActiveExecutions()).toBe(false)
    expect(harness.workerFactory.workers.size).toBe(0)
  })

  it('permanently rejects every execution start API as soon as shutdown begins', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const source = {
      workflow, rootPath: trustedRootPath, entryPath: 'workers/workflow-runner.ts', integrity: 'valid' as const,
    }
    const harness = createHarness({
      sourceResolver: { resolve: async () => { await gate; return source } },
    })
    const existing = harness.service.reserve()
    const starting = harness.service.startReserved(existing, {
      userId: 'user_1',
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      input: {},
      sourceSelector: harness.sourceSelector,
    })
    await turn()
    const shutdown = harness.service.shutdown()

    expect(() => harness.service.reserve())
      .toThrow(expect.objectContaining({ code: 'CONFLICT' }))
    await expect(harness.service.start({
      userId: 'user_1',
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      input: {},
      sourceSelector: harness.sourceSelector,
    })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(harness.service.startReserved(existing, {
      userId: 'user_1',
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      input: {},
      sourceSelector: harness.sourceSelector,
    })).rejects.toMatchObject({ code: 'CONFLICT' })

    release()
    await starting
    await shutdown
    await expect(harness.service.start({
      userId: 'user_1',
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      input: {},
      sourceSelector: harness.sourceSelector,
    })).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('cancels and settles a reserved start blocked before active registration without spawning', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolvePromise) => { release = resolvePromise })
    const source = {
      workflow, rootPath: trustedRootPath, entryPath: 'workers/workflow-runner.ts', integrity: 'valid' as const,
    }
    const harness = createHarness({
      sourceResolver: { resolve: async () => { await gate; return source } },
    })
    const reservation = harness.service.reserve()
    const starting = harness.service.startReserved(reservation, {
      userId: 'user_1', workflowId: workflow.id, workflowVersion: workflow.version, input: {}, sourceSelector: harness.sourceSelector,
    })
    await turn()
    let cancelSettled = false
    const cancelling = harness.service.cancel(reservation.executionId).then(() => { cancelSettled = true })
    await turn()
    expect(cancelSettled).toBe(false)

    release()
    const started = await starting
    await cancelling

    await expect(started.finished).resolves.toMatchObject({ status: 'cancelled', errorCode: 'CANCELLED' })
    expect(harness.workerFactory.workers.size).toBe(0)
    expect(harness.repositories.records.get(reservation.executionId)?.status).toBe('cancelled')
  })

  it('prepares Main-only attachment bindings after persistence and before worker spawn', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolvePromise) => { release = resolvePromise })
    const harness = createHarness()
    const reservation = harness.service.reserve()
    const prepareAttachmentBindings = vi.fn(async (executionId: string) => {
      expect(harness.repositories.records.get(executionId)?.status).toBe('queued')
      await gate
    })
    const starting = harness.service.startReserved(reservation, {
      userId: 'user_1', workflowId: workflow.id, workflowVersion: workflow.version,
      input: {}, sourceSelector: harness.sourceSelector,
      attachmentBindings: [attachmentBinding()],
      prepareAttachmentBindings,
    })
    await turn()

    expect(prepareAttachmentBindings).toHaveBeenCalledWith(
      reservation.executionId,
      [expect.objectContaining({ attachmentIndex: 0 })],
    )
    expect(harness.workerFactory.workers.size).toBe(0)
    release()
    const started = await starting
    expect(harness.workerFactory.workers.has(started.id)).toBe(true)
    await harness.service.cancel(started.id)
  })

  it('kills a timed-out worker and stores a terminal failure', async () => {
    const harness = createHarness({ timeoutMs: 20 })
    const execution = await harness.start()

    await execution.finished

    expect(harness.repositories.records.get(execution.id)?.status).toBe('failed')
    expect(harness.repositories.records.get(execution.id)?.errorCode).toBe('WORKER_TIMEOUT')
    expect(harness.workerFactory.workers.get(execution.id)?.killed).toBe(true)
    const specification = harness.workerFactory.specifications[0]
    expect(specification.env.AUTOFORGE_EXECUTION_NONCE).toBeTruthy()
    expect(Object.keys(specification.env).every((name) => [
      'AUTOFORGE_EXECUTION_NONCE', 'LANG', 'LC_ALL', 'TZ', 'SystemRoot', 'ELECTRON_RUN_AS_NODE',
    ].includes(name))).toBe(true)
  })

  it('pauses a capability request until a once decision resumes it', async () => {
    const harness = createHarness()
    const execution = await harness.start()
    const worker = harness.workerFactory.workers.get(execution.id)!
    worker.respond({ type: 'ready', executionId: execution.id })
    worker.respond({ type: 'capability_request', requestId: 'request_1', request: capabilityRequest })
    await turn()

    expect(harness.repositories.records.get(execution.id)?.status).toBe('awaiting_approval')
    expect(worker.requests.some((message) => message.type === 'capability_result')).toBe(false)
    const approval = harness.events.find((event) => event.type === 'approval_required')
    expect(approval).toMatchObject({
      type: 'approval_required', executionId: execution.id, permissionIndex: 0,
      capability: capabilityRequest.capability, scope: capabilityRequest.scope,
      scopeHash: scopeHash(capabilityRequest.scope),
    })
    expect(harness.events.findIndex((event) => event.type === 'status' && event.status === 'awaiting_approval'))
      .toBeLessThan(harness.events.findIndex((event) => event.type === 'approval_required'))

    await harness.service.decide({
      executionId: execution.id,
      permissionIndex: 0,
      scopeHash: scopeHash(capabilityRequest.scope),
      decision: 'once',
    })
    await turn()

    expect(harness.repositories.records.get(execution.id)?.status).toBe('running')
    expect(worker.requests).toContainEqual({ type: 'capability_result', requestId: 'request_1', result: { ok: true } })

    worker.respond({ type: 'result', output: { title: 'weather' } })
    await execution.finished
    expect(harness.repositories.records.get(execution.id)).toMatchObject({ status: 'completed', result: { title: 'weather' } })
  })

  it('uses an Agent-authorized wildcard browser.open scope without a legacy approval', async () => {
    const agentWorkflow: WorkflowDetail = {
      ...workflow,
      permissions: [{
        capability: 'browser.open',
        scope: { origins: ['*.baidu.com/api/*', 'https://accounts.baidu.com'] },
      }],
    }
    const harness = createHarness({
      source: {
        workflow: agentWorkflow,
        rootPath: trustedRootPath,
        entryPath: 'workers/workflow-runner.ts',
        integrity: 'valid',
      },
    })
    const reservation = harness.service.reserve()
    const execution = await harness.service.startReserved(
      reservation,
      agentStartInput(agentWorkflow, harness.sourceSelector),
    )
    const worker = harness.workerFactory.workers.get(execution.id)!
    worker.respond({ type: 'ready', executionId: execution.id })
    worker.respond({
      type: 'capability_request',
      requestId: 'agent_open',
      request: {
        capability: 'browser.open',
        scope: { origins: ['https://news.baidu.com'] },
        arguments: { url: 'https://news.baidu.com/api/weather' },
      },
    })
    await turn()

    expect(harness.events.some((event) => event.type === 'approval_required')).toBe(false)
    expect(worker.requests).toContainEqual({
      type: 'capability_result', requestId: 'agent_open', result: { ok: true },
    })
    expect(harness.permissionRepository.upsert).not.toHaveBeenCalled()

    worker.respond({ type: 'result', output: { title: 'weather' } })
    await expect(execution.finished).resolves.toMatchObject({ status: 'completed' })
  })

  it('keeps exact continuation identity in Main capability context and out of Worker requests', async () => {
    const agentWorkflow: WorkflowDetail = {
      ...workflow,
      permissions: [
        { capability: 'browser.open', scope: { origins: ['https://www.baidu.com/*'] } },
        { capability: 'browser.click', scope: { origins: ['https://actions.baidu.com/*'] } },
      ],
      browserContinuation: {
        auth: { loggedIn: ['role=button[name="账户"]'] },
        readableRegions: ['css=main'],
      },
    }
    const request = vi.fn(async (
      capabilityContext: CapabilityContext,
      workerRequest: WorkerCapabilityRequest,
    ) => {
      void capabilityContext
      void workerRequest
      return { ok: true }
    })
    const harness = createHarness({
      capability: { request, closeExecution: vi.fn(async () => undefined) },
      source: {
        workflow: agentWorkflow,
        rootPath: trustedRootPath,
        entryPath: 'workers/workflow-runner.ts',
        integrity: 'valid',
      },
    })
    const execution = await harness.service.startReserved(
      harness.service.reserve(),
      agentStartInput(agentWorkflow, harness.sourceSelector),
    )
    const worker = harness.workerFactory.workers.get(execution.id)!
    worker.respond({ type: 'ready', executionId: execution.id })
    worker.respond({
      type: 'capability_request',
      requestId: 'agent_open_context',
      request: {
        capability: 'browser.open',
        scope: { origins: ['https://www.baidu.com'] },
        arguments: { url: 'https://www.baidu.com/start' },
      },
    })
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())

    const capabilityContext = request.mock.calls[0]![0]
    expect(capabilityContext).toEqual({
      executionId: execution.id,
      userId: 'user_1',
      conversationId: 'conversation_1',
      chatRunId: 'chat_run_1',
      workflowId: agentWorkflow.id,
      workflowVersion: agentWorkflow.version,
      source: 'installed',
      securityFingerprint: workflowSecurityFingerprint(agentWorkflow),
      permissionMatrix: browserPermissionMatrix(agentWorkflow),
      browserContinuation: agentWorkflow.browserContinuation,
    })
    expect(Object.isFrozen(capabilityContext.permissionMatrix)).toBe(true)
    expect(Object.isFrozen(capabilityContext.permissionMatrix['browser.open'])).toBe(true)
    expect(Object.isFrozen(capabilityContext.browserContinuation?.auth?.loggedIn)).toBe(true)
    const workerStart = worker.requests.find((message) => message.type === 'start')!
    expect(workerStart).not.toHaveProperty('conversationId')
    expect(workerStart).not.toHaveProperty('chatRunId')
    expect(workerStart).not.toHaveProperty('securityFingerprint')
    expect(workerStart).not.toHaveProperty('permissionMatrix')
    expect(workerStart).not.toHaveProperty('browserContinuation')

    await harness.service.cancel(execution.id)
  })

  it.each(['browser.fill', 'browser.click'] as const)(
    'converts an Agent-approved declared %s scope into an exact execution-only grant',
    async (capability) => {
      const declared = {
        capability,
        scope: { origins: ['*.baidu.com/*', 'https://accounts.baidu.com'] },
      }
      const agentWorkflow: WorkflowDetail = { ...workflow, permissions: [declared] }
      const harness = createHarness({
        source: {
          workflow: agentWorkflow,
          rootPath: trustedRootPath,
          entryPath: 'workers/workflow-runner.ts',
          integrity: 'valid',
        },
      })
      const record = vi.spyOn(harness.policy, 'record')
      const reservation = harness.service.reserve()
      const execution = await harness.service.startReserved(
        reservation,
        agentStartInput(agentWorkflow, harness.sourceSelector),
      )
      const worker = harness.workerFactory.workers.get(execution.id)!
      worker.respond({ type: 'ready', executionId: execution.id })
      worker.respond({
        type: 'capability_request',
        requestId: `agent_${capability}`,
        request: capability === 'browser.fill'
          ? { capability, scope: { origins: ['https://news.baidu.com'] }, arguments: { locator: '#query', value: 'weather' } }
          : { capability, scope: { origins: ['https://news.baidu.com'] }, arguments: { locator: '#submit' } },
      })
      await turn()

      expect(harness.events.some((event) => event.type === 'approval_required')).toBe(false)
      expect(record).toHaveBeenCalledWith({
        executionId: execution.id,
        workflowId: agentWorkflow.id,
        workflowVersion: agentWorkflow.version,
        capability,
        scope: { origins: ['https://news.baidu.com'] },
        decision: 'once',
      })
      expect(record.mock.calls.some(([permission]) => permission.decision === 'always')).toBe(false)
      expect(harness.permissionRepository.upsert).not.toHaveBeenCalled()
      expect(worker.requests).toContainEqual({
        type: 'capability_result', requestId: `agent_${capability}`, result: { ok: true },
      })
      await harness.service.cancel(execution.id)
    },
  )

  it.each([
    {
      name: 'an origin outside the declared scope',
      request: {
        capability: 'browser.open' as const,
        scope: { origins: ['https://attacker.example'] },
        arguments: { url: 'https://attacker.example/path' },
      },
    },
    {
      name: 'a capability absent from the Agent binding',
      request: {
        capability: 'browser.fill' as const,
        scope: { origins: ['https://news.baidu.com'] },
        arguments: { locator: '#query', value: 'secret' },
      },
    },
  ])('fails an Agent-owned request for $name without a legacy approval', async ({ request }) => {
    const agentWorkflow: WorkflowDetail = {
      ...workflow,
      permissions: [{ capability: 'browser.open', scope: { origins: ['*.baidu.com/*'] } }],
    }
    const harness = createHarness({
      source: {
        workflow: agentWorkflow,
        rootPath: trustedRootPath,
        entryPath: 'workers/workflow-runner.ts',
        integrity: 'valid',
      },
    })
    const reservation = harness.service.reserve()
    const execution = await harness.service.startReserved(
      reservation,
      agentStartInput(agentWorkflow, harness.sourceSelector),
    )
    const worker = harness.workerFactory.workers.get(execution.id)!
    worker.respond({ type: 'ready', executionId: execution.id })
    worker.respond({ type: 'capability_request', requestId: 'agent_denied', request })

    await expect(execution.finished).resolves.toMatchObject({
      status: 'failed', errorCode: 'CAPABILITY_SCOPE_DENIED',
    })
    expect(harness.events.some((event) => event.type === 'approval_required')).toBe(false)
  })

  it('dispatches a foreground conversion from an immutable attachment vault and returns only safe output metadata', async () => {
    const binding = attachmentBinding()
    const conversion = createFileConversionPort({
      terminal: {
        status: 'completed',
        outputs: [{
          displayName: 'result.png', detectedFormat: 'png', byteSize: 64,
          artifactId: 'artifact_secret', sourceId: 'asset_1', sha256: 'a'.repeat(64),
          path: '/Users/alice/result.png', relativePath: 'results/secret.png',
        } as never],
      },
    })
    const browserCapability = {
      request: vi.fn(async () => ({ browser: true })),
      closeExecution: vi.fn(async () => undefined),
    }
    const harness = createHarness({
      conversion,
      capability: browserCapability,
      source: {
        workflow: conversionWorkflow,
        rootPath: trustedRootPath,
        entryPath: 'workers/workflow-runner.ts',
        integrity: 'valid',
      },
    })
    const reservation = harness.service.reserve()
    const execution = await harness.service.startReserved(
      reservation,
      conversionStartInput(reservation.executionId, harness.sourceSelector, [binding]),
    )
    binding.displayName = 'mutated.png'
    binding.sourceFingerprint = '0'.repeat(64)
    const worker = harness.workerFactory.workers.get(execution.id)!
    worker.respond({ type: 'ready', executionId: execution.id })
    worker.respond({
      type: 'capability_request', requestId: 'convert_foreground',
      request: conversionRequest({ background: false }),
    })
    await vi.waitFor(() => expect(conversion.waitForTerminal).toHaveBeenCalledOnce())

    expect(conversion.inspectAttachment).toHaveBeenCalledWith(expect.objectContaining({
      attachmentIndex: 0,
      displayName: 'source.png',
      sourceFingerprint: 'f'.repeat(64),
    }))
    expect(Object.isFrozen(conversion.inspectAttachment.mock.calls[0]![0])).toBe(true)
    expect(Object.isFrozen(conversion.inspectAttachment.mock.calls[0]![0].source)).toBe(true)
    expect(conversion.submit).toHaveBeenCalledWith({
      executionId: execution.id,
      sourceKind: 'media',
      sourceId: 'asset_1',
      targetFormat: 'png',
    })
    expect(worker.requests).toContainEqual({
      type: 'capability_result',
      requestId: 'convert_foreground',
      result: {
        accepted: true,
        status: 'completed',
        outputs: [{ name: 'converted-1-1.png', format: 'png', byteSize: 64 }],
      },
    })
    const serialized = JSON.stringify(worker.requests)
    expect(serialized).not.toMatch(/job_1|artifact_secret|asset_1|mediaAssetId|sourceId|ownerUserId|sha256|sourceFingerprint|attachmentBindings|fileConvertAuthorization|conversationId|Users|relativePath/)
    expect(browserCapability.request).not.toHaveBeenCalled()
    expect(harness.permissionRepository.upsert).not.toHaveBeenCalled()

    worker.respond({ type: 'result', output: { converted: true } })
    await expect(execution.finished).resolves.toMatchObject({ status: 'completed' })
  })

  it.each([undefined, true])(
    'returns a queued receipt without waiting when background is %s',
    async (background) => {
      const conversion = createFileConversionPort()
      const harness = createHarness({
        conversion,
        source: {
          workflow: conversionWorkflow,
          rootPath: trustedRootPath,
          entryPath: 'workers/workflow-runner.ts',
          integrity: 'valid',
        },
      })
      const reservation = harness.service.reserve()
      const execution = await harness.service.startReserved(
        reservation,
        conversionStartInput(reservation.executionId, harness.sourceSelector),
      )
      const worker = harness.workerFactory.workers.get(execution.id)!
      worker.respond({ type: 'ready', executionId: execution.id })
      worker.respond({
        type: 'capability_request', requestId: 'convert_background',
        request: conversionRequest({ ...(background === undefined ? {} : { background }) }),
      })
      await vi.waitFor(() => expect(conversion.submit).toHaveBeenCalledOnce())

      expect(conversion.waitForTerminal).not.toHaveBeenCalled()
      expect(worker.requests).toContainEqual({
        type: 'capability_result', requestId: 'convert_background',
        result: { accepted: true, status: 'queued', outputs: [] },
      })
      await harness.service.cancel(execution.id)
    },
  )

  it.each([
    {
      name: 'an out-of-range index',
      request: conversionRequest({ attachmentIndex: 1 }),
    },
    {
      name: 'a missing one-run authorization',
      startOptions: { authorize: false },
      request: conversionRequest(),
    },
    {
      name: 'a target absent from the one-run authorization',
      startOptions: { formats: ['jpeg'] as const },
      request: conversionRequest(),
    },
    {
      name: 'a conversation-mismatched binding',
      bindings: [attachmentBinding({ conversationId: 'conversation_other' })],
      request: conversionRequest(),
    },
    {
      name: 'a cross-owner source snapshot',
      inspect: async (binding: ExecutionAttachmentBinding) => ({ ...binding, ownerUserId: 'user_other' }),
      request: conversionRequest(),
    },
    {
      name: 'a changed source fingerprint',
      inspect: async (binding: ExecutionAttachmentBinding) => ({ ...binding, sourceFingerprint: 'a'.repeat(64) }),
      request: conversionRequest(),
    },
  ])('rejects $name before durable submission', async ({ bindings, inspect, request, startOptions }) => {
    const conversion = createFileConversionPort({ ...(inspect ? { inspect } : {}) })
    const harness = createHarness({
      conversion,
      source: {
        workflow: conversionWorkflow,
        rootPath: trustedRootPath,
        entryPath: 'workers/workflow-runner.ts',
        integrity: 'valid',
      },
    })
    const reservation = harness.service.reserve()
    const execution = await harness.service.startReserved(
      reservation,
      conversionStartInput(
        reservation.executionId,
        harness.sourceSelector,
        bindings ?? [attachmentBinding()],
        startOptions,
      ),
    )
    const worker = harness.workerFactory.workers.get(execution.id)!
    worker.respond({ type: 'ready', executionId: execution.id })
    worker.respond({ type: 'capability_request', requestId: 'convert_denied', request })
    await vi.waitFor(() => expect(worker.requests.some((message) => (
      message.type === 'capability_error' && message.requestId === 'convert_denied'
    ))).toBe(true))

    expect(conversion.submit).not.toHaveBeenCalled()
    expect(harness.events.some((event) => event.type === 'approval_required')).toBe(false)
    await harness.service.cancel(execution.id)
  })

  it.each([
    {
      name: 'a target not declared by the installed manifest',
      workflow: conversionWorkflow,
      request: conversionRequest({ targetFormat: 'jpeg' }),
    },
    {
      name: 'a forged multi-format request scope',
      workflow: {
        ...conversionWorkflow,
        permissions: [{ capability: 'file.convert' as const, scope: { formats: ['png', 'jpeg'] as ConversionTargetFormat[] } }],
      },
      request: conversionRequest({ formats: ['png', 'jpeg'] }),
    },
  ])('rejects $name before durable submission', async ({ workflow: selectedWorkflow, request }) => {
    const conversion = createFileConversionPort()
    const harness = createHarness({
      conversion,
      source: {
        workflow: selectedWorkflow,
        rootPath: trustedRootPath,
        entryPath: 'workers/workflow-runner.ts',
        integrity: 'valid',
      },
    })
    const reservation = harness.service.reserve()
    const execution = await harness.service.startReserved(
      reservation,
      conversionStartInput(reservation.executionId, harness.sourceSelector),
    )
    const worker = harness.workerFactory.workers.get(execution.id)!
    worker.respond({ type: 'ready', executionId: execution.id })
    worker.respond({ type: 'capability_request', requestId: 'convert_forged_scope', request })

    await expect(execution.finished).resolves.toMatchObject({
      status: 'failed', errorCode: 'CAPABILITY_SCOPE_DENIED',
    })
    expect(conversion.submit).not.toHaveBeenCalled()
  })

  it('rejects a one-run conversion authorization bound to another execution', async () => {
    const conversion = createFileConversionPort()
    const harness = createHarness({
      conversion,
      source: {
        workflow: conversionWorkflow,
        rootPath: trustedRootPath,
        entryPath: 'workers/workflow-runner.ts',
        integrity: 'valid',
      },
    })
    const reservation = harness.service.reserve()

    await expect(harness.service.startReserved(
      reservation,
      conversionStartInput('execution_other', harness.sourceSelector),
    )).rejects.toMatchObject({ code: 'INVALID_INPUT' })

    expect(harness.workerFactory.workers.size).toBe(0)
    expect(conversion.submit).not.toHaveBeenCalled()
  })

  it('consumes an attachment-format authorization on the first submit attempt', async () => {
    const conversion = createFileConversionPort()
    const harness = createHarness({
      conversion,
      source: {
        workflow: conversionWorkflow,
        rootPath: trustedRootPath,
        entryPath: 'workers/workflow-runner.ts',
        integrity: 'valid',
      },
    })
    const reservation = harness.service.reserve()
    const execution = await harness.service.startReserved(
      reservation,
      conversionStartInput(reservation.executionId, harness.sourceSelector),
    )
    const worker = harness.workerFactory.workers.get(execution.id)!
    worker.respond({ type: 'ready', executionId: execution.id })
    worker.respond({ type: 'capability_request', requestId: 'convert_first', request: conversionRequest() })
    await vi.waitFor(() => expect(conversion.submit).toHaveBeenCalledOnce())
    worker.respond({ type: 'capability_request', requestId: 'convert_duplicate', request: conversionRequest() })
    await vi.waitFor(() => expect(worker.requests).toContainEqual(expect.objectContaining({
      type: 'capability_error', requestId: 'convert_duplicate',
    })))

    expect(conversion.submit).toHaveBeenCalledTimes(1)
    await harness.service.cancel(execution.id)
  })

  it('returns an engine terminal failure as data so the workflow can continue', async () => {
    const conversion = createFileConversionPort({
      terminal: {
        status: 'failed',
        errorCode: 'CONVERSION_COMPONENT_UNAVAILABLE',
        outputs: [],
      },
    })
    const harness = createHarness({
      conversion,
      source: {
        workflow: conversionWorkflow,
        rootPath: trustedRootPath,
        entryPath: 'workers/workflow-runner.ts',
        integrity: 'valid',
      },
    })
    const reservation = harness.service.reserve()
    const execution = await harness.service.startReserved(
      reservation,
      conversionStartInput(reservation.executionId, harness.sourceSelector),
    )
    const worker = harness.workerFactory.workers.get(execution.id)!
    worker.respond({ type: 'ready', executionId: execution.id })
    worker.respond({
      type: 'capability_request', requestId: 'convert_failed',
      request: conversionRequest({ background: false }),
    })
    await vi.waitFor(() => expect(worker.requests).toContainEqual({
      type: 'capability_result',
      requestId: 'convert_failed',
      result: {
        accepted: false,
        status: 'failed',
        error: {
          code: 'CONVERSION_COMPONENT_UNAVAILABLE',
          message: 'The required conversion component is unavailable.',
        },
      },
    }))

    expect(harness.repositories.records.get(execution.id)?.status).toBe('running')
    expect(worker.killed).toBe(false)
    await harness.service.cancel(execution.id)
  })

  it('generates provider-safe output names without reusing untrusted port names', async () => {
    const untrustedNames = [
      'job_1',
      'result-source_asset_1-user_user_1.png',
      `fingerprint-${'f'.repeat(64)}-sha-${'a'.repeat(64)}.png`,
      'line\nbreak\tname.png',
      'https://attacker.example/job_1.png?owner=user_1',
      '/Users/alice/conversion/results/artifact_secret.png',
      'C:\\Users\\alice\\conversion\\artifact_secret.png',
      '\\Users\\alice\\conversion\\artifact_secret.png',
      '\\\\server\\share\\artifact_secret.png',
    ]
    const conversion = createFileConversionPort({
      terminal: {
        status: 'completed',
        outputs: untrustedNames.map((displayName, index) => ({
          displayName,
          detectedFormat: 'png',
          byteSize: index + 1,
        })),
      },
    })
    const harness = createHarness({
      conversion,
      source: {
        workflow: conversionWorkflow,
        rootPath: trustedRootPath,
        entryPath: 'workers/workflow-runner.ts',
        integrity: 'valid',
      },
    })
    const reservation = harness.service.reserve()
    const execution = await harness.service.startReserved(
      reservation,
      conversionStartInput(reservation.executionId, harness.sourceSelector),
    )
    const worker = harness.workerFactory.workers.get(execution.id)!
    worker.respond({ type: 'ready', executionId: execution.id })
    worker.respond({
      type: 'capability_request', requestId: 'convert_untrusted_names',
      request: conversionRequest({ background: false }),
    })
    await vi.waitFor(() => expect(worker.requests).toContainEqual({
      type: 'capability_result',
      requestId: 'convert_untrusted_names',
      result: {
        accepted: true,
        status: 'completed',
        outputs: [
          { name: 'converted-1-1.png', format: 'png', byteSize: 1 },
          { name: 'converted-1-2.png', format: 'png', byteSize: 2 },
          { name: 'converted-1-3.png', format: 'png', byteSize: 3 },
          { name: 'converted-1-4.png', format: 'png', byteSize: 4 },
          { name: 'converted-1-5.png', format: 'png', byteSize: 5 },
          { name: 'converted-1-6.png', format: 'png', byteSize: 6 },
          { name: 'converted-1-7.png', format: 'png', byteSize: 7 },
          { name: 'converted-1-8.png', format: 'png', byteSize: 8 },
          { name: 'converted-1-9.png', format: 'png', byteSize: 9 },
        ],
      },
    }))

    const serialized = JSON.stringify(worker.requests)
    for (const untrustedName of untrustedNames) {
      expect(serialized).not.toContain(JSON.stringify(untrustedName).slice(1, -1))
    }
    expect(serialized).not.toMatch(/job_1|asset_1|user_1|artifact_secret|fingerprint|sha|https?:|Users|server|share/)
    await harness.service.cancel(execution.id)
  })

  it('cancels and drains a submitted foreground conversion before execution cancellation settles', async () => {
    let rejectWait!: (error: unknown) => void
    let waitSignal: AbortSignal | undefined
    const wait = new Promise<never>((_resolve, reject) => { rejectWait = reject })
    const conversion = createFileConversionPort({
      waitForTerminal: async (_jobId, _ownerUserId, signal) => {
        waitSignal = signal
        return wait
      },
    })
    const harness = createHarness({
      conversion,
      source: {
        workflow: conversionWorkflow,
        rootPath: trustedRootPath,
        entryPath: 'workers/workflow-runner.ts',
        integrity: 'valid',
      },
    })
    const reservation = harness.service.reserve()
    const execution = await harness.service.startReserved(
      reservation,
      conversionStartInput(reservation.executionId, harness.sourceSelector),
    )
    const worker = harness.workerFactory.workers.get(execution.id)!
    worker.respond({ type: 'ready', executionId: execution.id })
    worker.respond({
      type: 'capability_request', requestId: 'convert_cancelled',
      request: conversionRequest({ background: false }),
    })
    await vi.waitFor(() => expect(conversion.waitForTerminal).toHaveBeenCalledOnce())

    let settled = false
    const cancelling = harness.service.cancel(execution.id).then(() => { settled = true })
    await vi.waitFor(() => expect(conversion.cancel).toHaveBeenCalledWith('job_1'))
    expect(waitSignal?.aborted).toBe(true)
    expect(settled).toBe(false)

    rejectWait({ code: 'CONVERSION_CANCELLED' })
    await cancelling
    await expect(execution.finished).resolves.toMatchObject({ status: 'cancelled', errorCode: 'CANCELLED' })
    expect(worker.requests.some((message) => message.type === 'capability_result')).toBe(false)
  })

  it('cancels and drains a submitted foreground conversion before execution timeout settles', async () => {
    let rejectWait!: (error: unknown) => void
    let waitSignal: AbortSignal | undefined
    const wait = new Promise<never>((_resolve, reject) => { rejectWait = reject })
    const conversion = createFileConversionPort({
      waitForTerminal: async (_jobId, _ownerUserId, signal) => {
        waitSignal = signal
        return wait
      },
    })
    const harness = createHarness({
      conversion,
      source: {
        workflow: conversionWorkflow,
        rootPath: trustedRootPath,
        entryPath: 'workers/workflow-runner.ts',
        integrity: 'valid',
      },
    })
    const reservation = harness.service.reserve()
    const execution = await harness.service.startReserved(
      reservation,
      { ...conversionStartInput(reservation.executionId, harness.sourceSelector), timeoutMs: 20 },
    )
    const worker = harness.workerFactory.workers.get(execution.id)!
    worker.respond({ type: 'ready', executionId: execution.id })
    worker.respond({
      type: 'capability_request', requestId: 'convert_timed_out',
      request: conversionRequest({ background: false }),
    })
    await vi.waitFor(() => expect(conversion.cancel).toHaveBeenCalledWith('job_1'))
    expect(waitSignal?.aborted).toBe(true)
    let settled = false
    void execution.finished.then(() => { settled = true })
    await turn()
    expect(settled).toBe(false)

    rejectWait({ code: 'CONVERSION_CANCELLED' })
    await expect(execution.finished).resolves.toMatchObject({ status: 'failed', errorCode: 'WORKER_TIMEOUT' })
    expect(worker.requests.some((message) => message.type === 'capability_result')).toBe(false)
  })

  it('persists invalid Worker output as failed without a completed terminal event', async () => {
    const harness = createHarness({
      source: {
        workflow: {
          ...workflow,
          outputSchema: {
            type: 'object',
            required: ['title'],
            properties: { title: { type: 'string' } },
          },
        },
        rootPath: trustedRootPath,
        entryPath: 'workers/workflow-runner.ts',
        integrity: 'valid',
      },
    })
    const execution = await harness.start()
    const worker = harness.workerFactory.workers.get(execution.id)!
    worker.respond({ type: 'ready', executionId: execution.id })
    worker.respond({ type: 'result', output: { title: 42 } })

    await expect(execution.finished).resolves.toMatchObject({
      status: 'failed', errorCode: 'INVALID_OUTPUT', result: { title: 42 },
    })
    expect(harness.repositories.records.get(execution.id)).toMatchObject({
      status: 'failed', errorCode: 'INVALID_OUTPUT', result: { title: 42 },
    })
    expect(harness.events.filter((event) => event.type === 'status' && [
      'completed', 'failed', 'cancelled',
    ].includes(event.status))).toMatchObject([{ status: 'failed', error: { code: 'INVALID_OUTPUT' } }])
    expect(harness.events.some((event) => event.type === 'result')).toBe(false)
    expect(worker.killed).toBe(true)
  })

  it('emits exact identity for a later manifest permission and rejects an out-of-order decision', async () => {
    const fillPermission = { capability: 'browser.fill' as const, scope: capabilityRequest.scope }
    const twoPermissionWorkflow = { ...workflow, permissions: [workflow.permissions[0]!, fillPermission] }
    const harness = createHarness({
      source: {
        workflow: twoPermissionWorkflow,
        rootPath: trustedRootPath,
        entryPath: 'workers/workflow-runner.ts',
        integrity: 'valid',
      },
    })
    const execution = await harness.start()
    const worker = harness.workerFactory.workers.get(execution.id)!
    worker.respond({ type: 'ready', executionId: execution.id })
    worker.respond({
      type: 'capability_request', requestId: 'request_fill',
      request: { ...fillPermission, arguments: { locator: '#query', value: 'weather' } },
    })
    await turn()

    expect(harness.events).toContainEqual(expect.objectContaining({
      type: 'approval_required', executionId: execution.id, permissionIndex: 1,
      capability: 'browser.fill', scopeHash: scopeHash(fillPermission.scope),
    }))
    await expect(harness.service.decide({
      executionId: execution.id, permissionIndex: 0, scopeHash: scopeHash(fillPermission.scope), decision: 'once',
    })).rejects.toMatchObject({ code: 'CONFLICT' })
    await harness.service.decide({
      executionId: execution.id, permissionIndex: 1, scopeHash: scopeHash(fillPermission.scope), decision: 'once',
    })
    await turn()
    expect(worker.requests).toContainEqual({ type: 'capability_result', requestId: 'request_fill', result: { ok: true } })
    await harness.service.cancel(execution.id)
  })

  it('requires an always decision to exactly match the paused request', async () => {
    const harness = createHarness()
    const execution = await harness.start()
    const worker = harness.workerFactory.workers.get(execution.id)!
    worker.respond({ type: 'ready', executionId: execution.id })
    worker.respond({ type: 'capability_request', requestId: 'request_1', request: capabilityRequest })
    await turn()
    const decision: ApprovalDecision = {
      executionId: execution.id,
      permissionIndex: 0,
      scopeHash: scopeHash(capabilityRequest.scope),
      decision: 'always',
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      capability: 'browser.open',
      scope: { origins: ['https://example.com'] },
    }

    await expect(harness.service.decide(decision)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(harness.repositories.records.get(execution.id)?.status).toBe('awaiting_approval')
  })

  it('retains legacy always approval for a manual execution without Agent authorization', async () => {
    const harness = createHarness()
    const execution = await harness.start()
    const worker = harness.workerFactory.workers.get(execution.id)!
    worker.respond({ type: 'ready', executionId: execution.id })
    worker.respond({ type: 'capability_request', requestId: 'manual_request', request: capabilityRequest })
    await turn()

    await harness.service.decide({
      executionId: execution.id,
      permissionIndex: 0,
      scopeHash: scopeHash(capabilityRequest.scope),
      decision: 'always',
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      capability: capabilityRequest.capability,
      scope: capabilityRequest.scope,
    })
    await turn()

    expect(harness.permissionRepository.upsert).toHaveBeenCalledTimes(1)
    expect(worker.requests).toContainEqual({
      type: 'capability_result', requestId: 'manual_request', result: { ok: true },
    })
    await harness.service.cancel(execution.id)
  })

  it('rejects undeclared capability scopes before asking for approval', async () => {
    const harness = createHarness()
    const execution = await harness.start()
    const worker = harness.workerFactory.workers.get(execution.id)!
    worker.respond({ type: 'ready', executionId: execution.id })
    worker.respond({
      type: 'capability_request',
      requestId: 'request_1',
      request: { ...capabilityRequest, scope: { origins: ['https://example.com'] }, arguments: { url: 'https://example.com' } },
    })

    await execution.finished
    expect(harness.repositories.records.get(execution.id)).toMatchObject({ status: 'failed', errorCode: 'CAPABILITY_SCOPE_DENIED' })
    expect(worker.killed).toBe(true)
  })

  it('matches a browser.open declaration against the complete requested URL', async () => {
    const patternWorkflow: WorkflowDetail = {
      ...workflow,
      permissions: [{ capability: 'browser.open', scope: { origins: ['*.baidu.com/api/*'] } }],
    }
    const harness = createHarness({
      source: {
        workflow: patternWorkflow,
        rootPath: trustedRootPath,
        entryPath: 'workers/workflow-runner.ts',
        integrity: 'valid',
      },
    })
    const execution = await harness.start()
    const worker = harness.workerFactory.workers.get(execution.id)!
    const request: WorkerCapabilityRequest = {
      capability: 'browser.open',
      scope: { origins: ['https://a.b.baidu.com'] },
      arguments: { url: 'https://a.b.baidu.com/api/a/b?query=1#result' },
    }
    worker.respond({ type: 'ready', executionId: execution.id })
    worker.respond({ type: 'capability_request', requestId: 'request_pattern', request })
    await turn()

    expect(harness.events).toContainEqual(expect.objectContaining({
      type: 'approval_required',
      permissionIndex: 0,
      scope: { origins: ['https://a.b.baidu.com'] },
      scopeHash: scopeHash(request.scope),
    }))

    await harness.service.decide({
      executionId: execution.id,
      permissionIndex: 0,
      scopeHash: scopeHash(request.scope),
      decision: 'once',
    })
    await turn()
    expect(worker.requests).toContainEqual({
      type: 'capability_result', requestId: 'request_pattern', result: { ok: true },
    })
    await harness.service.cancel(execution.id)
  })

  it('adds only explicitly declared exact hosts to a browser.open approval', async () => {
    const requestCapability = vi.fn(async () => ({ ok: true }))
    const redirectWorkflow: WorkflowDetail = {
      ...workflow,
      permissions: [{
        capability: 'browser.open',
        scope: { origins: [
          'https://fw.bjrcgz.gov.cn',
          'https://bjt.beijing.gov.cn',
          '*.example.com',
          'https://path.example.com/login/*',
        ] },
      }, {
        capability: 'browser.open',
        scope: { origins: ['https://other.example/*'] },
      }],
    }
    const harness = createHarness({
      capability: { request: requestCapability, closeExecution: async () => undefined },
      source: {
        workflow: redirectWorkflow,
        rootPath: trustedRootPath,
        entryPath: 'workers/workflow-runner.ts',
        integrity: 'valid',
      },
    })
    const execution = await harness.start()
    const worker = harness.workerFactory.workers.get(execution.id)!
    worker.respond({ type: 'ready', executionId: execution.id })
    worker.respond({
      type: 'capability_request',
      requestId: 'request_redirect',
      request: {
        capability: 'browser.open',
        scope: { origins: ['https://fw.bjrcgz.gov.cn'] },
        arguments: { url: 'https://fw.bjrcgz.gov.cn/person-platform/' },
      },
    })
    await turn()

    const effectiveScope = {
      origins: ['https://fw.bjrcgz.gov.cn', 'https://bjt.beijing.gov.cn'],
    }
    expect(harness.events).toContainEqual(expect.objectContaining({
      type: 'approval_required', permissionIndex: 0,
      capability: 'browser.open', scope: effectiveScope, scopeHash: scopeHash(effectiveScope),
    }))

    await harness.service.decide({
      executionId: execution.id,
      permissionIndex: 0,
      scopeHash: scopeHash(effectiveScope),
      decision: 'once',
    })
    await turn()
    expect(requestCapability).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ capability: 'browser.open', scope: effectiveScope }),
      { origins: ['*.example.com', 'https://path.example.com/login/*'] },
    )
    await harness.service.cancel(execution.id)
  })

  it.each([
    ['a path outside the declaration', 'https://demo.baidu.com', 'https://demo.baidu.com/admin'],
    ['the apex host', 'https://baidu.com', 'https://baidu.com/api/a'],
    ['a different port', 'https://demo.baidu.com:8443', 'https://demo.baidu.com:8443/api/a'],
  ])('rejects browser.open for %s', async (_case, origin, url) => {
    const patternWorkflow: WorkflowDetail = {
      ...workflow,
      permissions: [{ capability: 'browser.open', scope: { origins: ['*.baidu.com/api/*'] } }],
    }
    const harness = createHarness({
      source: {
        workflow: patternWorkflow,
        rootPath: trustedRootPath,
        entryPath: 'workers/workflow-runner.ts',
        integrity: 'valid',
      },
    })
    const execution = await harness.start()
    const worker = harness.workerFactory.workers.get(execution.id)!
    worker.respond({ type: 'ready', executionId: execution.id })
    worker.respond({
      type: 'capability_request',
      requestId: 'request_pattern',
      request: { capability: 'browser.open', scope: { origins: [origin] }, arguments: { url } },
    })

    await execution.finished
    expect(harness.repositories.records.get(execution.id)).toMatchObject({
      status: 'failed', errorCode: 'CAPABILITY_SCOPE_DENIED',
    })
  })

  it('ignores a declared path after opening when a browser action stays on the same host', async () => {
    const patternWorkflow: WorkflowDetail = {
      ...workflow,
      permissions: [{ capability: 'browser.click', scope: { origins: ['*.baidu.com/api/*'] } }],
    }
    const harness = createHarness({
      source: {
        workflow: patternWorkflow,
        rootPath: trustedRootPath,
        entryPath: 'workers/workflow-runner.ts',
        integrity: 'valid',
      },
    })
    const execution = await harness.start()
    const worker = harness.workerFactory.workers.get(execution.id)!
    worker.respond({ type: 'ready', executionId: execution.id })
    worker.respond({
      type: 'capability_request',
      requestId: 'request_click',
      request: {
        capability: 'browser.click',
        scope: { origins: ['https://demo.baidu.com'] },
        arguments: { locator: '#next-page' },
      },
    })
    await turn()

    expect(harness.events).toContainEqual(expect.objectContaining({
      type: 'approval_required', permissionIndex: 0, scope: { origins: ['https://demo.baidu.com'] },
    }))
    await harness.service.cancel(execution.id)
  })

  it('cancels an active worker and closes its capabilities', async () => {
    let closedExecution = ''
    const harness = createHarness({
      capability: {
        request: async () => undefined,
        closeExecution: async (executionId) => { closedExecution = executionId },
      },
    })
    const execution = await harness.start()
    const worker = harness.workerFactory.workers.get(execution.id)!
    worker.respond({ type: 'ready', executionId: execution.id })
    await turn()

    await harness.service.cancel(execution.id)
    await execution.finished

    expect(harness.repositories.records.get(execution.id)).toMatchObject({ status: 'cancelled', errorCode: 'CANCELLED' })
    expect(worker.requests).toContainEqual({ type: 'cancel', executionId: execution.id })
    expect(worker.killed).toBe(true)
    expect(closedExecution).toBe(execution.id)
  })

  it('parses JSON Lines across chunk boundaries', async () => {
    const harness = createHarness()
    const execution = await harness.start()
    const worker = harness.workerFactory.workers.get(execution.id)!
    worker.stdout.write('{"type":"ready",')
    worker.stdout.write(`"executionId":"${execution.id}"}\n`)
    worker.stdout.write('{"type":"result","output":{"ok":')
    worker.stdout.write('true}}\n')

    await execution.finished
    expect(harness.repositories.records.get(execution.id)).toMatchObject({ status: 'completed', result: { ok: true } })
  })

  it.each([
    ['invalid JSON', (worker: FakeWorker) => worker.stdout.write('{not-json}\n')],
    ['an oversized line', (worker: FakeWorker) => {
      worker.stdout.write(Buffer.alloc(700_000, 97))
      worker.stdout.write(Buffer.alloc(400_000, 97))
    }],
  ])('terminates on %s', async (_label, writeInvalid) => {
    const harness = createHarness()
    const execution = await harness.start()
    const worker = harness.workerFactory.workers.get(execution.id)!
    writeInvalid(worker)

    await execution.finished
    expect(harness.repositories.records.get(execution.id)).toMatchObject({ status: 'failed', errorCode: 'WORKER_PROTOCOL_INVALID' })
    expect(worker.killed).toBe(true)
  })

  it('stores a crash as failure and cleans up capabilities', async () => {
    let closed = false
    const harness = createHarness({
      capability: {
        request: async () => undefined,
        closeExecution: async () => { closed = true },
      },
    })
    const execution = await harness.start()
    const worker = harness.workerFactory.workers.get(execution.id)!
    worker.emit('exit', 1, null)

    await execution.finished
    expect(harness.repositories.records.get(execution.id)).toMatchObject({ status: 'failed', errorCode: 'INTERNAL_ERROR' })
    expect(closed).toBe(true)
  })

  it('stores a validated loader error emitted before ready', async () => {
    const harness = createHarness()
    const execution = await harness.start()
    const worker = harness.workerFactory.workers.get(execution.id)!
    worker.respond({
      type: 'error',
      error: { code: 'WORKFLOW_INTEGRITY_FAILED', message: 'The workflow integrity check failed.' },
    })

    await execution.finished
    expect(harness.repositories.records.get(execution.id)).toMatchObject({
      status: 'failed',
      errorCode: 'WORKFLOW_INTEGRITY_FAILED',
    })
  })

  it('passes authenticated user attribution only to the main-process capability context', async () => {
    const request = vi.fn(async () => ({ ok: true }))
    const harness = createHarness({ capability: { request, closeExecution: async () => undefined } })
    const execution = await harness.service.start({
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      input: { query: 'weather' },
      userId: 'user_1',
      sourceSelector: harness.sourceSelector,
    } as Parameters<typeof harness.service.start>[0])
    const worker = harness.workerFactory.workers.get(execution.id)!
    worker.respond({ type: 'ready', executionId: execution.id })
    harness.policy.record({
      executionId: execution.id,
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      capability: capabilityRequest.capability,
      scope: capabilityRequest.scope,
      decision: 'once',
    })
    worker.respond({ type: 'capability_request', requestId: 'request_user', request: capabilityRequest })
    await turn()

    expect(request).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user_1' }), capabilityRequest)
    expect(worker.requests.find((message) => message.type === 'start')).not.toHaveProperty('userId')
    worker.respond({ type: 'result', output: { ok: true } })
    await execution.finished
  })

  it('uses only the trusted resolver entry when callers supply an arbitrary external path', async () => {
    const harness = createHarness()
    const execution = await harness.service.start({
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      input: {},
      entryPath: '/tmp/untrusted-workflow.mjs',
      sourceSelector: harness.sourceSelector,
    } as never)
    const worker = harness.workerFactory.workers.get(execution.id)!

    const stagedPath = join(harness.workerFactory.specifications[0]!.cwd, 'workflow-entry.mjs')
    expect(worker.requests.find((request) => request.type === 'start')).toMatchObject({ entryPath: stagedPath })
    expect(await readFile(stagedPath)).toEqual(
      await readFile(join(trustedRootPath, 'workers/workflow-runner.ts')),
    )
    await harness.service.cancel(execution.id)
  })

  it('terminalizes an integrity-failed resolved source without starting a worker', async () => {
    const harness = createHarness({
      timeoutMs: 10,
      source: {
        workflow: { ...workflow, integrity: 'failed' },
        rootPath: trustedRootPath,
        entryPath: 'workers/workflow-runner.ts',
        integrity: 'failed',
      },
    })
    const execution = await harness.start()

    await execution.finished
    expect(harness.repositories.records.get(execution.id)).toMatchObject({
      status: 'failed',
      errorCode: 'WORKFLOW_INTEGRITY_FAILED',
    })
    expect(harness.workerFactory.workers.size).toBe(0)
  })

  it.each([
    ['installed', 'WORKFLOW_INTEGRITY_FAILED'],
    ['development', 'WORKFLOW_CHANGED'],
  ] as const)('fails a changed %s artifact before a Worker becomes active', async (source, errorCode) => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-artifact-digest-race-'))
    const entryPath = 'dist/index.mjs'
    const original = 'export default { async run() { return "original" } }'
    const changed = 'export default { async run() { return "changed" } }'
    await mkdir(join(root, 'dist'))
    await writeFile(join(root, entryPath), original)
    const selected: WorkflowDetail = {
      ...workflow,
      source,
      codeSha256: createHash('sha256').update(original).digest('hex'),
      runtimeIdentity: source === 'installed'
        ? { id: workflow.id, version: workflow.version, source }
        : { id: workflow.id, version: workflow.version, source, buildHash: 'b'.repeat(64) },
    }
    const harness = createHarness({
      timeoutMs: 10,
      sourceResolver: {
        resolve: async () => {
          await writeFile(join(root, entryPath), changed)
          return { workflow: selected, rootPath: root, entryPath, integrity: 'valid' }
        },
      },
    })
    const releaseExecution = vi.spyOn(harness.policy, 'releaseExecution')

    try {
      const execution = await harness.start()
      await expect(execution.finished).resolves.toMatchObject({ status: 'failed', errorCode })
      expect(harness.workerFactory.workers.size).toBe(0)
      expect(harness.service.hasActiveExecutions()).toBe(false)
      expect(releaseExecution).toHaveBeenCalledTimes(1)
      expect(releaseExecution).toHaveBeenCalledWith(execution.id)
      expect(JSON.stringify(harness.events)).not.toContain(root)
      expect(JSON.stringify(harness.events)).not.toContain(changed)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['installed', 'WORKFLOW_INTEGRITY_FAILED'],
    ['development', 'WORKFLOW_INTEGRITY_FAILED'],
  ] as const)('rejects a final-component symlink swap before reading a %s artifact', async (source, errorCode) => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-artifact-preread-symlink-'))
    const project = join(root, 'project')
    const entryPath = 'dist/index.mjs'
    const entry = join(project, entryPath)
    const outside = join(root, 'outside.mjs')
    const original = 'export default { async run() { return "verified" } }'
    await mkdir(join(project, 'dist'), { recursive: true })
    await writeFile(entry, original)
    await writeFile(outside, original)
    const selected: WorkflowDetail = {
      ...workflow,
      source,
      codeSha256: createHash('sha256').update(original).digest('hex'),
      runtimeIdentity: source === 'installed'
        ? { id: workflow.id, version: workflow.version, source }
        : { id: workflow.id, version: workflow.version, source, buildHash: 'b'.repeat(64) },
    }
    const harness = createHarness({
      sourceResolver: {
        resolve: async () => {
          await unlink(entry)
          await symlink(outside, entry)
          return { workflow: selected, rootPath: project, entryPath, integrity: 'valid' }
        },
      },
    })

    try {
      const execution = await harness.start()
      await expect(execution.finished).resolves.toMatchObject({ status: 'failed', errorCode })
      expect(harness.workerFactory.workers.size).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['a directory', async (root: string, entry: string) => mkdir(entry), '0'.repeat(64)],
    ['an oversized file', async (_root: string, entry: string) => writeFile(entry, Buffer.alloc(8 * 1024 * 1024 + 1)), createHash('sha256').update(Buffer.alloc(8 * 1024 * 1024 + 1)).digest('hex')],
  ] as const)('rejects %s before spawning the Worker', async (_case, createEntry, codeSha256) => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-artifact-invalid-entry-'))
    const entryPath = 'entry.mjs'
    await createEntry(root, join(root, entryPath))
    const harness = createHarness({
      source: {
        workflow: { ...workflow, codeSha256 },
        rootPath: root,
        entryPath,
        integrity: 'valid',
      },
    })

    try {
      const execution = await harness.start()
      await expect(execution.finished).resolves.toMatchObject({
        status: 'failed', errorCode: 'WORKFLOW_INTEGRITY_FAILED',
      })
      expect(harness.workerFactory.workers.size).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('promptly rejects a FIFO artifact before spawning the Worker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-artifact-fifo-'))
    const entryPath = 'entry.mjs'
    const entry = join(root, entryPath)
    execFileSync('mkfifo', [entry])
    const harness = createHarness({
      source: {
        workflow: { ...workflow, codeSha256: createHash('sha256').update('').digest('hex') },
        rootPath: root,
        entryPath,
        integrity: 'valid',
      },
    })
    const starting = harness.start()
    const outcome = await Promise.race([
      starting.then((execution) => ({ type: 'resolved' as const, execution })),
      new Promise<{ type: 'timed-out' }>((resolvePromise) => {
        setTimeout(() => resolvePromise({ type: 'timed-out' }), 100)
      }),
    ])

    try {
      if (outcome.type === 'timed-out') {
        const writer = openSync(entry, constants.O_WRONLY | constants.O_NONBLOCK)
        closeSync(writer)
        const execution = await starting
        await execution.finished
      }
      expect(outcome.type).toBe('resolved')
      if (outcome.type === 'resolved') {
        await expect(outcome.execution.finished).resolves.toMatchObject({
          status: 'failed', errorCode: 'WORKFLOW_INTEGRITY_FAILED',
        })
      }
      expect(harness.workerFactory.workers.size).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['installed', 'development'] as const)(
    'executes verified staged %s bytes when the original becomes an outside symlink after path resolution',
    async (source) => {
      const root = await mkdtemp(join(tmpdir(), 'autoforge-artifact-symlink-race-'))
      const project = join(root, 'project')
      const executionDirectory = join(root, 'execution')
      const entryPath = 'dist/index.mjs'
      const entry = join(project, entryPath)
      const outside = join(root, 'outside.mjs')
      const original = 'export default { async run() { return "verified" } }'
      const replacement = 'export default { async run() { return "outside" } }'
      await mkdir(join(project, 'dist'), { recursive: true })
      await mkdir(executionDirectory)
      await writeFile(entry, original)
      await writeFile(outside, replacement)
      const selected: WorkflowDetail = {
        ...workflow,
        source,
        codeSha256: createHash('sha256').update(original).digest('hex'),
        runtimeIdentity: source === 'installed'
          ? { id: workflow.id, version: workflow.version, source }
          : { id: workflow.id, version: workflow.version, source, buildHash: 'b'.repeat(64) },
      }
      const harness = createHarness({
        source: { workflow: selected, rootPath: project, entryPath, integrity: 'valid' },
        temporaryDirectories: {
          create: async () => {
            await unlink(entry)
            await symlink(outside, entry)
            return executionDirectory
          },
          remove: (path) => rm(path, { recursive: true, force: true }),
        },
      })

      try {
        const execution = await harness.start()
        const worker = harness.workerFactory.workers.get(execution.id)!
        const start = worker.requests.find((request) => request.type === 'start')
        if (!start || start.type !== 'start') throw new Error('Expected Worker start')
        expect(start.entryPath.startsWith(`${executionDirectory}${sep}`)).toBe(true)
        expect(worker.loadedEntry?.toString('utf8')).toBe(original)
        expect(harness.repositories.records.get(execution.id)).toMatchObject({
          workflowId: selected.id,
          workflowVersion: selected.version,
        })
        worker.respond({ type: 'ready', executionId: execution.id })
        worker.respond({ type: 'result', output: { source } })
        await expect(execution.finished).resolves.toMatchObject({ status: 'completed' })
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it.each(['installed', 'development'] as const)(
    'keeps staged %s bytes immutable when the original changes before Worker input',
    async (source) => {
      const root = await mkdtemp(join(tmpdir(), 'autoforge-artifact-stage-race-'))
      const entryPath = 'dist/index.mjs'
      const entry = join(root, entryPath)
      const original = 'export default { async run() { return "staged" } }'
      const replacement = 'export default { async run() { return "mutated" } }'
      await mkdir(join(root, 'dist'))
      await writeFile(entry, original)
      const selected: WorkflowDetail = {
        ...workflow,
        source,
        codeSha256: createHash('sha256').update(original).digest('hex'),
        runtimeIdentity: source === 'installed'
          ? { id: workflow.id, version: workflow.version, source }
          : { id: workflow.id, version: workflow.version, source, buildHash: 'b'.repeat(64) },
      }
      const workerFactory = new FakeWorkerFactory(async () => { await writeFile(entry, replacement) })
      const harness = createHarness({
        source: { workflow: selected, rootPath: root, entryPath, integrity: 'valid' },
        workerFactory,
      })

      try {
        const execution = await harness.start()
        const worker = workerFactory.workers.get(execution.id)!
        const start = worker.requests.find((request) => request.type === 'start')
        if (!start || start.type !== 'start') throw new Error('Expected Worker start')
        const cwd = workerFactory.specifications[0]!.cwd
        expect(start.entryPath.startsWith(`${cwd}${sep}`)).toBe(true)
        expect(worker.loadedEntry?.toString('utf8')).toBe(original)
        expect(await readFile(entry, 'utf8')).toBe(replacement)
        worker.respond({ type: 'ready', executionId: execution.id })
        worker.respond({ type: 'result', output: { source } })
        await expect(execution.finished).resolves.toMatchObject({ status: 'completed' })
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it('cleans an execution directory once and never spawns when exclusive staging fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-artifact-stage-failure-'))
    const entryPath = 'dist/index.mjs'
    const entry = join(root, entryPath)
    const executionDirectory = join(root, 'execution')
    const original = 'export default { async run() { return "verified" } }'
    await mkdir(join(root, 'dist'))
    await mkdir(executionDirectory)
    await writeFile(entry, original)
    await writeFile(join(executionDirectory, 'workflow-entry.mjs'), 'occupied')
    const remove = vi.fn((path: string) => rm(path, { recursive: true, force: true }))
    const harness = createHarness({
      timeoutMs: 10,
      source: {
        workflow: {
          ...workflow,
          codeSha256: createHash('sha256').update(original).digest('hex'),
        },
        rootPath: root,
        entryPath,
        integrity: 'valid',
      },
      temporaryDirectories: { create: async () => executionDirectory, remove },
    })

    try {
      const execution = await harness.start()
      await expect(execution.finished).resolves.toMatchObject({
        status: 'failed',
        errorCode: 'WORKFLOW_INTEGRITY_FAILED',
      })
      expect(harness.workerFactory.workers.size).toBe(0)
      expect(remove).toHaveBeenCalledTimes(1)
      expect(remove).toHaveBeenCalledWith(executionDirectory)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('cleans the staged execution directory once when cancellation wins before staging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-artifact-stage-cancel-'))
    const executionDirectory = join(root, 'execution')
    await mkdir(executionDirectory)
    let entered!: () => void
    const creating = new Promise<void>((resolvePromise) => { entered = resolvePromise })
    let releaseCreate!: () => void
    const createGate = new Promise<void>((resolvePromise) => { releaseCreate = resolvePromise })
    const remove = vi.fn((path: string) => rm(path, { recursive: true, force: true }))
    const harness = createHarness({
      temporaryDirectories: {
        create: async () => {
          entered()
          await createGate
          return executionDirectory
        },
        remove,
      },
    })
    const reservation = harness.service.reserve()
    const starting = harness.service.startReserved(reservation, {
      userId: 'user_1', workflowId: workflow.id, workflowVersion: workflow.version,
      input: {}, sourceSelector: harness.sourceSelector,
    })

    try {
      await creating
      const cancelling = harness.service.cancel(reservation.executionId)
      releaseCreate()
      const execution = await starting
      await cancelling
      await expect(execution.finished).resolves.toMatchObject({
        status: 'cancelled', errorCode: 'CANCELLED',
      })
      expect(harness.workerFactory.workers.size).toBe(0)
      expect(remove).toHaveBeenCalledTimes(1)
      expect(remove).toHaveBeenCalledWith(executionDirectory)
    } finally {
      releaseCreate()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['installed', 'development'] as const)('runs a valid %s source resolved inside its root', async (source) => {
    const harness = createHarness({
      source: {
        workflow: { ...workflow, source },
        rootPath: trustedRootPath,
        entryPath: 'workers/workflow-runner.ts',
        integrity: 'valid',
      },
    })
    const execution = await harness.start()
    const worker = harness.workerFactory.workers.get(execution.id)!

    expect(worker.requests.find((request) => request.type === 'start')).toMatchObject({
      entryPath: join(harness.workerFactory.specifications[0]!.cwd, 'workflow-entry.mjs'),
    })
    await harness.service.cancel(execution.id)
  })

  it('terminalizes a temporary-directory creation failure and runs pre-active cleanup', async () => {
    let closedExecution = ''
    const harness = createHarness({
      timeoutMs: 10,
      capability: {
        request: async () => undefined,
        closeExecution: async (executionId) => { closedExecution = executionId },
      },
      temporaryDirectories: {
        create: async () => { throw new Error('temp unavailable') },
        remove: async () => undefined,
      },
    })
    const release = vi.spyOn(harness.policy, 'releaseExecution')
    const execution = await harness.start()

    const terminal = await execution.finished
    expect(terminal).toMatchObject({ status: 'failed', errorCode: 'INTERNAL_ERROR' })
    expect(harness.repositories.records.get(execution.id)?.status).toBe('failed')
    expect(harness.workerFactory.workers.size).toBe(0)
    expect(release).toHaveBeenCalledWith(execution.id)
    expect(closedExecution).toBe(execution.id)
  })

  it.each([
    ['throws', 'INTERNAL_ERROR', true],
    ['returns empty', 'NOT_FOUND', false],
  ] as const)('removes the staged directory once when pre-active terminal persistence %s', async (_case, code, throws) => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-pre-active-persistence-'))
    const executionDirectory = join(root, 'execution')
    await mkdir(executionDirectory)
    const remove = vi.fn((path: string) => rm(path, { recursive: true, force: true }))
    const closeExecution = vi.fn(async () => undefined)
    const workerFactory = new FakeWorkerFactory(() => { throw new Error('spawn unavailable') })
    const harness = createHarness({
      workerFactory,
      capability: { request: async () => undefined, closeExecution },
      temporaryDirectories: { create: async () => executionDirectory, remove },
    })
    const releaseExecution = vi.spyOn(harness.policy, 'releaseExecution')
    const update = harness.repositories.executions.update
    harness.repositories.executions.update = (id, value) => {
      if (value.status === 'failed') {
        if (throws) throw new Error('database unavailable')
        return undefined
      }
      return update(id, value)
    }

    try {
      await expect(harness.start()).rejects.toMatchObject({ code })
      expect(remove).toHaveBeenCalledTimes(1)
      expect(remove).toHaveBeenCalledWith(executionDirectory)
      expect(workerFactory.workers.size).toBe(0)
      expect(releaseExecution).toHaveBeenCalledTimes(1)
      expect(closeExecution).toHaveBeenCalledTimes(1)
      expect(harness.service.hasActiveExecutions()).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('finishes cleanup when a terminal event listener throws', async () => {
    let closed = false
    let removed = ''
    const directory = await mkdtemp(join(tmpdir(), 'autoforge-event-test-'))
    const harness = createHarness({
      capability: {
        request: async () => undefined,
        closeExecution: async () => { closed = true },
      },
      temporaryDirectories: {
        create: async () => directory,
        remove: async (path) => { removed = path; await rm(path, { recursive: true, force: true }) },
      },
      emit: (event) => {
        if (event.type === 'status' && event.status === 'completed') throw new Error('renderer listener failed')
      },
    })
    const release = vi.spyOn(harness.policy, 'releaseExecution')
    const execution = await harness.start()
    const worker = harness.workerFactory.workers.get(execution.id)!
    worker.respond({ type: 'ready', executionId: execution.id })
    worker.respond({ type: 'result', output: { ok: true } })

    const terminal = await Promise.race([
      execution.finished,
      new Promise<'timed-out'>((resolvePromise) => setTimeout(() => resolvePromise('timed-out'), 100)),
    ])
    expect(terminal).not.toBe('timed-out')
    expect(terminal).toMatchObject({ status: 'completed' })
    expect(harness.repositories.records.get(execution.id)?.status).toBe('completed')
    expect(release).toHaveBeenCalledWith(execution.id)
    expect(closed).toBe(true)
    expect(worker.killed).toBe(true)
    expect(removed).toBe(directory)
  })

  it.each([
    ['throws', 'INTERNAL_ERROR', true],
    ['returns empty', 'NOT_FOUND', false],
  ] as const)('rejects finished and completes cleanup when terminal persistence %s', async (_case, code, throws) => {
    let closed = false
    let removed = false
    const directory = await mkdtemp(join(tmpdir(), 'autoforge-persistence-test-'))
    const harness = createHarness({
      capability: {
        request: async () => undefined,
        closeExecution: async () => { closed = true },
      },
      temporaryDirectories: {
        create: async () => directory,
        remove: async (path) => { removed = true; await rm(path, { recursive: true, force: true }) },
      },
    })
    const update = harness.repositories.executions.update
    harness.repositories.executions.update = (id, value) => {
      if (value.status === 'completed') {
        if (throws) throw new Error('database unavailable')
        return undefined
      }
      return update(id, value)
    }
    const execution = await harness.start()
    const worker = harness.workerFactory.workers.get(execution.id)!
    worker.respond({ type: 'ready', executionId: execution.id })
    worker.respond({ type: 'result', output: { ok: true } })

    const settlement = await Promise.race([
      execution.finished.then(
        (value) => ({ type: 'resolved' as const, value }),
        (error: unknown) => ({ type: 'rejected' as const, error }),
      ),
      new Promise<{ type: 'timed-out' }>((resolvePromise) => {
        setTimeout(() => resolvePromise({ type: 'timed-out' }), 100)
      }),
    ])

    expect(settlement).toMatchObject({ type: 'rejected', error: { code } })
    expect(closed).toBe(true)
    expect(removed).toBe(true)
    expect(worker.killed).toBe(true)
  })
})

describe('NodeWorkerFactory', () => {
  it('forks with an explicit allowlisted environment and piped JSONL streams', async () => {
    let receivedOptions: Record<string, unknown> | undefined
    const child = new FakeWorker()
    const factory = new NodeWorkerFactory('/app/workers/workflow-runner.cjs', ((_modulePath: string, _args?: readonly string[], options?: ForkOptions) => {
      receivedOptions = options as unknown as Record<string, unknown>
      return child as never
    }) as never)

    await factory.spawn({
      executionId: 'exec_1',
      nonce: 'nonce_1',
      cwd: '/tmp/autoforge-exec-1',
      env: { LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8', AUTOFORGE_EXECUTION_NONCE: 'nonce_1' },
    })

    expect(receivedOptions).toMatchObject({
      cwd: '/tmp/autoforge-exec-1',
      env: { LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8', AUTOFORGE_EXECUTION_NONCE: 'nonce_1' },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      execArgv: ['--experimental-vm-modules'],
    })
    expect((receivedOptions?.env as NodeJS.ProcessEnv).PATH).toBeUndefined()
    expect((receivedOptions?.env as NodeJS.ProcessEnv).HOME).toBeUndefined()
    expect((receivedOptions?.env as NodeJS.ProcessEnv).OPENROUTER_API_KEY).toBeUndefined()
  })

  it('runs only SDK-linked modules without Node globals or generated code', async () => {
    const messages = await runActualWorker(`
      import { defineWorkflow } from '@autoforge/workflow-sdk'
      export default defineWorkflow({
        async run(_context, input) {
          let generatedCode = false
          try { Function('return 1')() } catch { generatedCode = true }
          return {
            input,
            generatedCode,
            processType: typeof process,
            requireType: typeof require,
            globalProcessType: typeof globalThis.process,
          }
        },
      })
    `)

    expect(messages[0]).toEqual({ type: 'ready', executionId: 'exec_runner' })
    expect(messages[1]).toEqual({
      type: 'result',
      output: {
        input: { ok: true },
        generatedCode: true,
        processType: 'undefined',
        requireType: 'undefined',
        globalProcessType: 'undefined',
      },
    })
  })

  it('exposes a log-only logger capability to workflows', async () => {
    const messages = await runActualWorker(`
      import { defineWorkflow } from '@autoforge/workflow-sdk'
      export default defineWorkflow({
        async run(context) {
          context.logger.info('safe workflow progress')
          return { logged: true }
        },
      })
    `)

    expect(messages).toEqual([
      { type: 'ready', executionId: 'exec_runner' },
      { type: 'log', level: 'info', message: 'safe workflow progress' },
      { type: 'result', output: { logged: true } },
    ])
  })

  it('keeps logger validation errors inside the guest realm without exposing host constructors', async () => {
    const messages = await runActualWorker(`
      import { defineWorkflow } from '@autoforge/workflow-sdk'
      export default defineWorkflow({
        async run(context) {
          const observations = []
          for (const message of [
            { get toJSON() { throw new Error('guest getter') } },
            'x'.repeat(1024 * 1024),
          ]) {
            try { context.logger.info(message) }
            catch (error) {
              let escaped = false
              try { escaped = Boolean(error.constructor.constructor('return process')()) } catch {}
              observations.push({ code: typeof error.code === 'string' ? error.code : null, escaped })
            }
          }
          return { observations, processType: typeof process }
        },
      })
    `)

    expect(messages.at(-1)).toEqual({
      type: 'result',
      output: {
        observations: [{ code: null, escaped: false }, { code: 'WORKER_PROTOCOL_INVALID', escaped: false }],
        processType: 'undefined',
      },
    })
  })

  it('returns capability denials as guest errors that cannot reach host constructors', async () => {
    const messages = await runActualWorker(`
      import { defineWorkflow } from '@autoforge/workflow-sdk'
      export default defineWorkflow({
        async run(context) {
          try { await context.browser.open('https://www.baidu.com') }
          catch (error) {
            let escaped = false
            try { escaped = Boolean(error.constructor.constructor('return process')()) } catch {}
            let imported = false
            try { await import('node:fs'); imported = true } catch {}
            return { code: error.code, message: error.message, escaped, imported, processType: typeof process }
          }
          return { unexpected: true }
        },
      })
    `, {
      onMessage: (message, worker) => {
        if (message.type === 'capability_request') {
          worker.stdin!.write(`${JSON.stringify({
            type: 'capability_error', requestId: message.requestId,
            error: { code: 'PERMISSION_DENIED', message: 'The operation is not permitted.' },
          })}\n`)
        }
      },
    })

    expect(messages.at(-1)).toEqual({
      type: 'result',
      output: {
        code: 'PERMISSION_DENIED', message: 'The requested permission was denied.',
        escaped: false, imported: false, processType: 'undefined',
      },
    })
  })

  it.each([
    ['static', "import fs from 'node:fs'\nvoid fs"],
    ['dynamic', "await import('node:fs')"],
  ])('rejects %s imports outside the workflow SDK', async (_kind, importSource) => {
    const messages = await runActualWorker(`
      import { defineWorkflow } from '@autoforge/workflow-sdk'
      ${importSource.startsWith('import ') ? importSource : ''}
      export default defineWorkflow({
        async run() {
          ${importSource.startsWith('import ') ? '' : importSource}
          return null
        },
      })
    `)

    expect(messages.at(-1)).toEqual({
      type: 'error',
      error: { code: 'WORKER_PROTOCOL_INVALID', message: 'The worker protocol message is invalid.' },
    })
  })

  it('parses a start request fragmented across stdin chunks', async () => {
    const messages = await runActualWorker(`
      import { defineWorkflow } from '@autoforge/workflow-sdk'
      export default defineWorkflow({ async run() { return { fragmented: true } } })
    `, {
      writeInput: async (worker, line) => {
        const cuts = [1, 17, Math.floor(line.length / 2), line.length]
        let offset = 0
        for (const cut of cuts) {
          worker.stdin!.write(line.slice(offset, cut))
          offset = cut
          await turn()
        }
      },
    })

    expect(messages).toEqual([
      { type: 'ready', executionId: 'exec_runner' },
      { type: 'result', output: { fragmented: true } },
    ])
  })

  it('rejects an stdin line larger than one MiB before parsing', async () => {
    const messages = await runActualWorker('export default { async run() { return null } }', {
      writeInput: (worker) => {
        worker.stdin!.write(Buffer.alloc(700_000, 97))
        worker.stdin!.write(Buffer.alloc(400_000, 97))
      },
    })

    expect(messages).toEqual([{
      type: 'error',
      error: { code: 'WORKER_PROTOCOL_INVALID', message: 'The worker protocol message is invalid.' },
    }])
  })

  it('cancels a workflow paused on a capability request', async () => {
    const messages = await runActualWorker(`
      import { defineWorkflow } from '@autoforge/workflow-sdk'
      export default defineWorkflow({
        async run(context) {
          await context.browser.open('https://www.baidu.com')
          return { shouldNotComplete: true }
        },
      })
    `, {
      onMessage: (message, worker) => {
        if (message.type === 'capability_request') {
          worker.stdin!.write(`${JSON.stringify({ type: 'cancel', executionId: 'exec_runner' })}\n`)
        }
      },
    })

    expect(messages.map((message) => message.type)).toEqual(['ready', 'capability_request', 'error'])
    expect(messages.at(-1)).toEqual({
      type: 'error',
      error: { code: 'CANCELLED', message: 'The operation was cancelled.' },
    })
  })

  it('does not complete until a matching capability result arrives', async () => {
    const messages = await runActualWorker(`
      import { defineWorkflow } from '@autoforge/workflow-sdk'
      export default defineWorkflow({
        async run(context) {
          await context.browser.open('https://www.baidu.com')
          return { resumed: true }
        },
      })
    `, {
      onMessage: (message, worker, observed) => {
        if (message.type === 'capability_request') {
          expect(observed.some((candidate) => candidate.type === 'result')).toBe(false)
          worker.stdin!.write(`${JSON.stringify({
            type: 'capability_result',
            requestId: message.requestId,
            result: null,
          })}\n`)
        }
      },
    })

    expect(messages.map((message) => message.type)).toEqual(['ready', 'capability_request', 'result'])
    expect(messages.at(-1)).toEqual({ type: 'result', output: { resumed: true } })
  })

  it('waits for an unawaited capability call before completing', async () => {
    let answered = false
    let responseTimer: ReturnType<typeof setTimeout> | undefined
    try {
      const messages = await runActualWorker(`
        import { defineWorkflow } from '@autoforge/workflow-sdk'
        export default defineWorkflow({
          async run(context) {
            context.browser.open('https://www.baidu.com')
            return { returnedBeforeCapability: true }
          },
        })
      `, {
        onMessage: (message, worker) => {
          if (message.type === 'capability_request') {
            responseTimer = setTimeout(() => {
              if (worker.killed) return
              answered = true
              worker.stdin!.write(`${JSON.stringify({
                type: 'capability_result',
                requestId: message.requestId,
                result: null,
              })}\n`)
            }, 20)
          }
          if (message.type === 'result') expect(answered).toBe(true)
        },
      })

      expect(messages.map((message) => message.type)).toEqual(['ready', 'capability_request', 'result'])
    } finally {
      if (responseTimer) clearTimeout(responseTimer)
    }
  })

  it('exposes only the strict converter submit shim inside the isolated Worker', async () => {
    const messages = await runActualWorker(`
      import { defineWorkflow } from '@autoforge/workflow-sdk'
      export default defineWorkflow({
        async run(context) {
          const result = await context.converter.submit({
            attachmentIndex: 2,
            targetFormat: 'ico',
            preset: 'favicon',
            background: false,
          })
          return {
            result,
            converterKeys: Object.keys(context.converter),
            contextKeys: Object.keys(context),
            processType: typeof process,
          }
        },
      })
    `, {
      onMessage: (message, worker) => {
        if (message.type !== 'capability_request') return
        expect(message.request).toEqual({
          capability: 'file.convert',
          scope: { formats: ['ico'] },
          arguments: {
            attachmentIndex: 2,
            targetFormat: 'ico',
            preset: 'favicon',
            background: false,
          },
        })
        worker.stdin!.write(`${JSON.stringify({
          type: 'capability_result',
          requestId: message.requestId,
          result: { accepted: true, status: 'queued', outputs: [] },
        })}\n`)
      },
    })

    expect(messages.at(-1)).toEqual({
      type: 'result',
      output: {
        result: { accepted: true, status: 'queued', outputs: [] },
        converterKeys: ['submit'],
        contextKeys: ['browser', 'converter', 'logger'],
        processType: 'undefined',
      },
    })
  })

  it('rejects converter paths and source identifiers before they cross the Worker bridge', async () => {
    const messages = await runActualWorker(`
      import { defineWorkflow } from '@autoforge/workflow-sdk'
      export default defineWorkflow({
        async run(context) {
          try {
            await context.converter.submit({
              attachmentIndex: 0,
              targetFormat: 'png',
              sourceId: 'asset_secret',
              path: '/Users/alice/private.png',
            })
          } catch (error) {
            return { code: error.code, processType: typeof process }
          }
          return { unexpected: true }
        },
      })
    `)

    expect(messages.map((message) => message.type)).toEqual(['ready', 'result'])
    expect(messages.at(-1)).toEqual({
      type: 'result',
      output: { code: 'WORKER_PROTOCOL_INVALID', processType: 'undefined' },
    })
  })
})
