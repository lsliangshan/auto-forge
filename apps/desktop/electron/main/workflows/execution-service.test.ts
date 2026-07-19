import { EventEmitter } from 'node:events'
import { fork as forkProcess, type ForkOptions } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type { ApprovalDecision, ExecutionEvent, WorkerCapabilityRequest, WorkerRequest, WorkerResponse, WorkflowDetail } from '@autoforge/shared'
import { workerRequestSchema } from '@autoforge/shared'
import { describe, expect, it } from 'vitest'
import type { Execution, ExecutionLog, ExecutionStep } from '../database/repositories.js'
import { PolicyEngine } from '../permissions/policy-engine.js'
import {
  ExecutionService,
  NodeWorkerFactory,
  type CapabilityPort,
  type ExecutionRepositories,
  type WorkflowWorker,
  type WorkflowWorkerFactory,
} from './execution-service.js'

class FakeWorker extends EventEmitter implements WorkflowWorker {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killed = false
  readonly requests: WorkerRequest[] = []
  private input = ''

  constructor() {
    super()
    this.stdin.on('data', (chunk: Buffer) => {
      this.input += chunk.toString('utf8')
      const lines = this.input.split('\n')
      this.input = lines.pop() ?? ''
      for (const line of lines) {
        if (line) this.requests.push(workerRequestSchema.parse(JSON.parse(line)))
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

  async spawn(specification: Parameters<WorkflowWorkerFactory['spawn']>[0]): Promise<WorkflowWorker> {
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
    installedWorkflows: {
      get: () => undefined,
    },
  }
}

function createPermissionRepository() {
  return {
    upsert: <T>(value: T) => value,
    get: () => undefined,
    delete: () => undefined,
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

function createHarness(options: { timeoutMs?: number; capability?: CapabilityPort } = {}) {
  const repositories = createRepositories()
  const workerFactory = new FakeWorkerFactory()
  const policy = new PolicyEngine(createPermissionRepository())
  const events: ExecutionEvent[] = []
  const capability = options.capability ?? {
    request: async () => ({ ok: true }),
    closeExecution: async () => undefined,
  }
  const service = new ExecutionService({
    repositories,
    registry: { get: async () => workflow },
    policy,
    workers: workerFactory,
    capability,
    emit: (event) => {
      expect(repositories.records.get(event.executionId)?.status).toBe(
        event.type === 'status' ? event.status : repositories.records.get(event.executionId)?.status,
      )
      events.push(event)
    },
  })
  const start = () => service.start({
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    entryPath: '/fixtures/workflow.js',
    input: { query: 'weather' },
    timeoutMs: options.timeoutMs,
  })
  return { repositories, workerFactory, policy, events, capability, service, start }
}

async function turn(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function runActualWorker(source: string): Promise<WorkerResponse[]> {
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
          if (message.type === 'result' || message.type === 'error') {
            clearTimeout(timer)
            resolvePromise(messages)
          }
        }
      })
      worker.stdin!.write(`${JSON.stringify({
        type: 'start',
        executionId: 'exec_runner',
        workflowId: 'runner.test',
        workflowVersion: '1.0.0',
        entryPath,
        input: { ok: true },
      })}\n`)
    })
  } finally {
    worker.kill('SIGTERM')
    await rm(directory, { recursive: true, force: true })
  }
}

describe('ExecutionService', () => {
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

    await harness.service.decide({ executionId: execution.id, decision: 'once' })
    await turn()

    expect(harness.repositories.records.get(execution.id)?.status).toBe('running')
    expect(worker.requests).toContainEqual({ type: 'capability_result', requestId: 'request_1', result: { ok: true } })

    worker.respond({ type: 'result', output: { title: 'weather' } })
    await execution.finished
    expect(harness.repositories.records.get(execution.id)).toMatchObject({ status: 'completed', result: { title: 'weather' } })
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
      decision: 'always',
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      capability: 'browser.open',
      scope: { origins: ['https://example.com'] },
    }

    await expect(harness.service.decide(decision)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(harness.repositories.records.get(execution.id)?.status).toBe('awaiting_approval')
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
})
