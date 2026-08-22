import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import {
  workerRequestSchema,
  type ExecutionEvent,
  type WorkerRequest,
  type WorkflowDetail,
} from '@autoforge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentOrchestrator, createAgentPersistence } from '../../electron/main/agent/agent-orchestrator.js'
import { OpenRouterProvider } from '../../electron/main/chat/openrouter-provider.js'
import { openAppDatabase } from '../../electron/main/database/client.js'
import { PolicyEngine, scopeHash } from '../../electron/main/permissions/policy-engine.js'
import { SecretStore } from '../../electron/main/security/secret-store.js'
import {
  ExecutionService,
  type WorkflowExecutionSourceResolver,
  type WorkflowWorker,
  type WorkflowWorkerFactory,
} from '../../electron/main/workflows/execution-service.js'
import { createWorkflowSourceSelectorVault } from '../../electron/main/workflows/workflow-source-selector.js'
import { WorkflowRegistry } from '../../electron/main/workflows/registry.js'
import { retrieveWorkflows } from '../../electron/main/workflows/retriever.js'

const directories: string[] = []
const closeDatabases: Array<() => void> = []

afterEach(async () => {
  for (const close of closeDatabases.splice(0)) close()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const permission = { capability: 'browser.open' as const, scope: { origins: ['https://www.baidu.com'] } }

function detail(codeSha256: string): WorkflowDetail & { entryPath: string; codeSha256: string } {
  return {
    id: 'browser.search.baidu', version: '1.0.0', name: '百度搜索', description: '使用百度搜索网页',
    author: 'AutoForge', category: 'search', enabled: true, source: 'installed', integrity: 'valid',
    updatedAt: new Date(0).toISOString(), timeoutMs: 30_000, permissions: [permission], cities: [],
    runtimeIdentity: { id: 'browser.search.baidu', version: '1.0.0', source: 'installed' },
    activationExamples: ['使用百度搜索今日天气'], activationNegativeExamples: [],
    inputSchema: { type: 'object', required: ['keyword'], properties: { keyword: { type: 'string' } }, additionalProperties: false },
    outputSchema: { type: 'object' }, entryPath: 'workflow.mjs', codeSha256,
  }
}

function response(events: unknown[]): Response {
  const text = events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('')
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } })
}

class IntegrationWorker extends EventEmitter implements WorkflowWorker {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly requests: WorkerRequest[] = []
  private buffer = ''

  constructor() {
    super()
    this.stdin.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8')
      const lines = this.buffer.split('\n')
      this.buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line) continue
        const request = workerRequestSchema.parse(JSON.parse(line))
        this.requests.push(request)
        if (request.type === 'start') {
          queueMicrotask(() => {
            this.stdout.write(`${JSON.stringify({ type: 'ready', executionId: request.executionId })}\n`)
            this.stdout.write(`${JSON.stringify({
              type: 'capability_request', requestId: 'capability_1',
              request: { ...permission, arguments: { url: 'https://www.baidu.com' } },
            })}\n`)
          })
        }
        if (request.type === 'capability_result') {
          this.stdout.write(`${JSON.stringify({ type: 'result', output: { title: '今日天气' } })}\n`)
        }
      }
    })
  }

  kill(): boolean {
    queueMicrotask(() => this.emit('exit', null, 'SIGTERM'))
    return true
  }
}

class IntegrationWorkerFactory implements WorkflowWorkerFactory {
  readonly workers: IntegrationWorker[] = []
  async spawn(): Promise<WorkflowWorker> {
    const worker = new IntegrationWorker()
    this.workers.push(worker)
    return worker
  }
}

async function runtime(options: { sourceResolver?: WorkflowExecutionSourceResolver; fetch: typeof fetch }) {
  const createdDirectory = await mkdtemp(join(tmpdir(), 'autoforge-agent-integration-'))
  directories.push(createdDirectory)
  const directory = await realpath(createdDirectory)
  const entry = Buffer.from('export default {}')
  await writeFile(join(directory, 'workflow.mjs'), entry)
  const workflow = detail(createHash('sha256').update(entry).digest('hex'))
  const manifest = {
    id: workflow.id,
    version: workflow.version,
    name: workflow.name,
    description: workflow.description,
    author: workflow.author,
    category: workflow.category,
    entryPath: workflow.entryPath,
    codeSha256: workflow.codeSha256,
    permissions: workflow.permissions,
    activationExamples: workflow.activationExamples,
    activationNegativeExamples: workflow.activationNegativeExamples,
    timeoutMs: workflow.timeoutMs,
    inputSchema: workflow.inputSchema,
    outputSchema: workflow.outputSchema,
  }
  const database = openAppDatabase(join(directory, 'app.sqlite'))
  closeDatabases.push(database.close)
  database.localAuth.createUserAndSession({
    id: 'user_1', account: 'Alice', accountNormalized: 'alice',
    passwordDigest: 'digest', createdAt: 1, updatedAt: 1,
  }, 1)
  database.conversations.insert({ id: 'conversation_1', title: '集成测试' })
  database.installedWorkflows.insert({
    workflowId: workflow.id, version: workflow.version, name: workflow.name, description: workflow.description,
    author: workflow.author, category: workflow.category, manifest, installPath: directory,
    enabled: true, integrityStatus: 'valid', source: 'installed', installedAt: 1, updatedAt: 1,
  }, [{ workflowId: workflow.id, workflowVersion: workflow.version, path: 'workflow.mjs', sha256: workflow.codeSha256 }])
  const secretStore = new SecretStore(database.encryptedSecrets, {
    isAvailable: async () => true,
    encrypt: async (value) => Buffer.from(value),
    decrypt: async (value) => ({ value: value.toString('utf8'), shouldReEncrypt: false }),
  })
  await secretStore.set('openrouter_api_key', 'sk-integration')
  const provider = new OpenRouterProvider({ credential: secretStore, fetch: options.fetch })
  const providerSnapshot = await provider.acquireSnapshot()
  const policy = new PolicyEngine(database.permissionGrants)
  const workers = new IntegrationWorkerFactory()
  const executionEvents: ExecutionEvent[] = []
  const executionService = new ExecutionService({
    repositories: database,
    sourceResolver: options.sourceResolver ?? { resolve: async () => ({ workflow, rootPath: directory, entryPath: 'workflow.mjs', integrity: 'valid' }) },
    policy,
    workers,
    capability: { request: async () => ({ opened: true }), closeExecution: async () => undefined },
    emit: (event) => { executionEvents.push(event) },
  })
  const registry = new WorkflowRegistry(database, {} as never)
  const sourceSelectorVault = createWorkflowSourceSelectorVault()
  const orchestrator = new AgentOrchestrator({
    workflows: registry,
    persistence: createAgentPersistence(database),
    history: { prepare: async () => [] },
    policy,
    executions: executionService,
    createSourceSelector: sourceSelectorVault.create,
    providerUsage: database.providerUsage,
    emit: () => undefined,
  })
  return { directory, workflow, database, workers, executionEvents, orchestrator, registry, providerSnapshot }
}

describe('agent workflow integration', () => {
  it('uses real provider, SQLite, policy, execution service, and retrieval through final persistence', async () => {
    const requests: RequestInit[] = []
    let turn = 0
    const app = await runtime({
      fetch: async (_input, init) => {
        requests.push(init ?? {})
        turn += 1
        if (turn === 1) return response([
          { id: 'generation_tool', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'tool_original', function: { name: 'browser.search.baidu', arguments: '{"keyword":"今日天气"}' } }] }, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ])
        return response([
          { id: 'generation_final', choices: [{ index: 0, delta: { content: '真实执行完成' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, cost: 0.01 } },
          '[DONE]',
        ])
      },
    })

    expect(app.database.workflowFiles.list(app.workflow.id, app.workflow.version)).toHaveLength(1)
    expect(createHash('sha256').update(await readFile(join(app.directory, 'workflow.mjs'))).digest('hex')).toBe(app.workflow.codeSha256)
    const listed = await app.registry.list()
    expect(listed.map((item) => item.id)).toEqual([app.workflow.id])
    expect(listed[0]).toMatchObject({ enabled: true, integrity: 'valid', activationExamples: ['使用百度搜索今日天气'] })
    expect(retrieveWorkflows('使用百度搜索今日天气', listed, 8).map((item) => item.id)).toEqual([app.workflow.id])
    const pending = await app.orchestrator.run({
      conversationId: 'conversation_1', content: '使用百度搜索今日天气', provider: 'openrouter',
      userId: 'user_1',
      userBlocks: [{ type: 'text', text: '使用百度搜索今日天气' }],
      modelContent: '使用百度搜索今日天气', assetIds: [], currentMedia: [], allowTools: true,
      model: 'local-test-model', requestId: 'request_1', providerSnapshot: app.providerSnapshot,
    })
    expect(app.database.messages.listForConversation('conversation_1').find((message) => message.role === 'assistant')?.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'workflow_proposal' }),
    ]))
    expect(pending.error).toBeUndefined()
    expect(pending).toMatchObject({ status: 'awaiting_approval' })
    const result = await app.orchestrator.resumeApproval({
      executionId: pending.executionId!, permissionIndex: 0, scopeHash: scopeHash(permission.scope), decision: 'always',
      workflowId: app.workflow.id, workflowVersion: app.workflow.version,
      capability: permission.capability, scope: permission.scope,
    })

    expect(app.database.executions.get(pending.executionId!)).toMatchObject({ status: 'completed' })
    expect(result.error).toBeUndefined()
    expect(result).toMatchObject({ status: 'completed' })
    expect(JSON.parse(String(requests[1]!.body))).toMatchObject({
      messages: expect.arrayContaining([expect.objectContaining({ role: 'tool', tool_call_id: 'tool_original' })]),
    })
    expect(app.workers.workers).toHaveLength(1)
    expect(app.workers.workers[0]!.requests).toContainEqual({ type: 'capability_result', requestId: 'capability_1', result: { opened: true } })
    expect(app.executionEvents.some((event) => event.type === 'status' && event.status === 'awaiting_approval')).toBe(false)
    const messages = app.database.messages.listForConversation('conversation_1')
    expect(messages).toHaveLength(2)
    expect(JSON.stringify(messages.find((message) => message.role === 'assistant')!.blocks)).toContain('真实执行完成')
    const executionId = pending.executionId!
    const execution = app.database.executions.get(executionId)
    expect(execution).toMatchObject({ status: 'completed', result: { title: '今日天气' } })
    expect(app.database.chatRuns.get(execution!.chatRunId!)).toMatchObject({
      status: 'completed', generationId: 'generation_final', inputTokens: 4, outputTokens: 2, costUsd: '0.01',
    })
    expect(app.database.providerUsage.summarize({
      userId: 'user_1', yesterdayStartedAt: 0, todayStartedAt: 0,
      weekStartedAt: 0, monthStartedAt: 0, endedAt: Number.MAX_SAFE_INTEGER,
    }).allTime).toMatchObject({
      openRouterCostUsd: '0.01', openRouterKnownCostCount: 1, openRouterUnknownCostCount: 1,
    })
    expect(app.database.providerUsage.listReconcilable(Number.MAX_SAFE_INTEGER)).toEqual([
      expect.objectContaining({
        operationKey: 'agent:request_1:turn:0',
        generationId: 'generation_tool',
        apiKeyFingerprint: app.providerSnapshot.apiKeyFingerprint,
      }),
    ])
    expect(app.database.permissionGrants.get(app.workflow.id, app.workflow.version, permission.capability, scopeHash(permission.scope))).toMatchObject({
      workflowId: app.workflow.id,
      workflowVersion: app.workflow.version,
      capability: permission.capability,
      scope: permission.scope,
    })
  })

  it('cancels a real execution service start blocked before active registration', async () => {
    let release!: () => void
    let resolverEntered!: () => void
    const entered = new Promise<void>((resolvePromise) => { resolverEntered = resolvePromise })
    const gate = new Promise<void>((resolvePromise) => { release = resolvePromise })
    let appDirectory = ''
    const app = await runtime({
      sourceResolver: {
        resolve: async () => {
          resolverEntered()
          await gate
          const entry = Buffer.from('export default {}')
          const workflow = detail(createHash('sha256').update(entry).digest('hex'))
          return { workflow, rootPath: appDirectory, entryPath: 'workflow.mjs', integrity: 'valid' }
        },
      },
      fetch: async () => response([
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'cancel_tool', function: { name: 'browser.search.baidu', arguments: '{"keyword":"今日天气"}' } }] }, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]),
    })
    appDirectory = app.directory
    const pending = await app.orchestrator.run({
      conversationId: 'conversation_1', content: '使用百度搜索今日天气', provider: 'openrouter',
      userId: 'user_1',
      userBlocks: [{ type: 'text', text: '使用百度搜索今日天气' }],
      modelContent: '使用百度搜索今日天气', assetIds: [], currentMedia: [], allowTools: true,
      model: 'local-test-model', requestId: 'cancel_request', providerSnapshot: app.providerSnapshot,
    })
    const resuming = app.orchestrator.resumeApproval({
      executionId: pending.executionId!, permissionIndex: 0, scopeHash: scopeHash(permission.scope), decision: 'once',
    })
    await entered
    let cancelSettled = false
    const cancelling = app.orchestrator.cancel('cancel_request').then(() => { cancelSettled = true })
    await Promise.resolve()
    expect(cancelSettled).toBe(false)

    release()
    await cancelling
    await expect(resuming).resolves.toMatchObject({ status: 'cancelled' })
    expect(app.workers.workers).toHaveLength(0)
    expect(app.database.executions.get(pending.executionId!)).toMatchObject({ status: 'cancelled', errorCode: 'CANCELLED' })
    expect(JSON.stringify(app.database.messages.listForConversation('conversation_1').find((message) => message.role === 'assistant')!.blocks)).not.toContain('真实执行完成')
  })
})
