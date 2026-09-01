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
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentOrchestrator, createAgentPersistence } from '../../electron/main/agent/agent-orchestrator.js'
import { createWorkflowExecutionSourceResolver } from '../../electron/main/application.js'
import { OpenRouterProvider } from '../../electron/main/chat/openrouter-provider.js'
import { openTestUserDataDatabase } from '../../electron/test-support/user-data-database.js'
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

const directories: string[] = []
const closeDatabases: Array<() => void> = []

afterEach(async () => {
  for (const close of closeDatabases.splice(0)) close()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const permission = {
  capability: 'browser.fill' as const,
  scope: { origins: ['*.baidu.com/*', 'https://accounts.baidu.com'] },
}
const runtimePermission = {
  capability: permission.capability,
  scope: { origins: ['https://www.baidu.com'] },
}

type IntegrationWorkflow = WorkflowDetail & { entryPath: string; codeSha256: string }

function detail(
  codeSha256: string,
  overrides: Partial<IntegrationWorkflow> = {},
): IntegrationWorkflow {
  const workflow: IntegrationWorkflow = {
    id: 'local.beijing.residence-permit', version: '1.0.0', name: '北京工作居住证',
    description: '查询并办理北京工作居住证材料',
    author: 'AutoForge', category: 'search', enabled: true, source: 'installed', integrity: 'valid',
    updatedAt: new Date(0).toISOString(), timeoutMs: 30_000, permissions: [permission], cities: ['北京'],
    runtimeIdentity: { id: 'local.beijing.residence-permit', version: '1.0.0', source: 'installed' },
    activationExamples: ['查询人才引进材料清单'], activationNegativeExamples: ['普通聊天'],
    inputSchema: { type: 'object', required: ['keyword'], properties: { keyword: { type: 'string' } }, additionalProperties: false },
    outputSchema: { type: 'object' }, entryPath: 'workflow.mjs', codeSha256,
  }
  const merged = { ...workflow, ...overrides }
  return {
    ...merged,
    runtimeIdentity: overrides.runtimeIdentity ?? {
      id: merged.id,
      version: merged.version,
      source: 'installed',
    },
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

  constructor(
    private readonly behavior: 'approval' | 'complete',
    private readonly output: (request: Extract<WorkerRequest, { type: 'start' }>) => unknown,
  ) {
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
            if (this.behavior === 'approval') {
              this.stdout.write(`${JSON.stringify({
                type: 'capability_request', requestId: 'capability_1',
                request: { ...runtimePermission, arguments: { locator: '#query', value: '北京工作居住证' } },
              })}\n`)
            } else {
              this.stdout.write(`${JSON.stringify({ type: 'result', output: this.output(request) })}\n`)
            }
          })
        }
        if (request.type === 'capability_result') {
          const start = this.requests.find((candidate): candidate is Extract<WorkerRequest, { type: 'start' }> => (
            candidate.type === 'start'
          ))!
          this.stdout.write(`${JSON.stringify({ type: 'result', output: this.output(start) })}\n`)
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
  constructor(
    private readonly behavior: 'approval' | 'complete',
    private readonly output: (request: Extract<WorkerRequest, { type: 'start' }>) => unknown,
  ) {}
  async spawn(): Promise<WorkflowWorker> {
    const worker = new IntegrationWorker(this.behavior, this.output)
    this.workers.push(worker)
    return worker
  }
}

async function runtime(options: {
  sourceResolver?: WorkflowExecutionSourceResolver
  fetch: typeof fetch
  workerBehavior?: 'approval' | 'complete'
  workerOutput?: (request: Extract<WorkerRequest, { type: 'start' }>) => unknown
  workflowOverrides?: Partial<IntegrationWorkflow>
  manifestCities?: 'workflow' | 'omitted'
}) {
  const createdDirectory = await mkdtemp(join(tmpdir(), 'autoforge-agent-integration-'))
  directories.push(createdDirectory)
  const directory = await realpath(createdDirectory)
  const entry = Buffer.from('export default {}')
  await writeFile(join(directory, 'workflow.mjs'), entry)
  const workflow = detail(createHash('sha256').update(entry).digest('hex'), options.workflowOverrides)
  const manifest = {
    id: workflow.id,
    version: workflow.version,
    name: workflow.name,
    description: workflow.description,
    author: workflow.author,
    category: workflow.category,
    ...(options.manifestCities === 'omitted' ? {} : { cities: workflow.cities }),
    entryPath: workflow.entryPath,
    codeSha256: workflow.codeSha256,
    permissions: workflow.permissions,
    activationExamples: workflow.activationExamples,
    activationNegativeExamples: workflow.activationNegativeExamples,
    timeoutMs: workflow.timeoutMs,
    inputSchema: workflow.inputSchema,
    outputSchema: workflow.outputSchema,
  }
  const database = openTestUserDataDatabase(directory, 'user_1')
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
  const workers = new IntegrationWorkerFactory(
    options.workerBehavior ?? 'approval',
    options.workerOutput ?? (() => ({ title: '北京工作居住证' })),
  )
  const executionEvents: ExecutionEvent[] = []
  const registry = new WorkflowRegistry(database, {} as never)
  const sourceSelectorVault = createWorkflowSourceSelectorVault()
  const liveSourceResolver = createWorkflowExecutionSourceResolver(sourceSelectorVault, {
    repositories: database,
    registry,
  })
  const executionService = new ExecutionService({
    repositories: database,
    sourceResolver: options.sourceResolver ?? liveSourceResolver,
    policy,
    workers,
    capability: { request: async () => ({ opened: true }), closeExecution: async () => undefined },
    emit: (event) => { executionEvents.push(event) },
  })
  const orchestrator = new AgentOrchestrator({
    workflows: registry,
    persistence: createAgentPersistence(database),
    history: { prepare: async () => [] },
    policy,
    executions: executionService,
    createSourceSelector: sourceSelectorVault.create,
    inspectSource: sourceSelectorVault.inspect,
    resolveCurrentWorkflow: async (selector, id, version) => (
      (await liveSourceResolver.resolve(id, version, selector))?.workflow
    ),
    inspectWorkflowConfig: async () => ({ implemented: false }),
    checkRemainingBudgets: () => undefined,
    providerUsage: database.providerUsage,
    emit: () => undefined,
  })
  const installWorkflow = async (installed: IntegrationWorkflow): Promise<IntegrationWorkflow> => {
    const bytes = Buffer.from(`export default ${JSON.stringify(installed.id)}`)
    await writeFile(join(directory, installed.entryPath), bytes)
    const withHash = { ...installed, codeSha256: createHash('sha256').update(bytes).digest('hex') }
    database.installedWorkflows.insert({
      workflowId: withHash.id,
      version: withHash.version,
      name: withHash.name,
      description: withHash.description,
      author: withHash.author,
      category: withHash.category,
      manifest: {
        id: withHash.id,
        version: withHash.version,
        name: withHash.name,
        description: withHash.description,
        author: withHash.author,
        category: withHash.category,
        cities: withHash.cities,
        entryPath: withHash.entryPath,
        codeSha256: withHash.codeSha256,
        permissions: withHash.permissions,
        activationExamples: withHash.activationExamples,
        activationNegativeExamples: withHash.activationNegativeExamples,
        timeoutMs: withHash.timeoutMs,
        inputSchema: withHash.inputSchema,
        outputSchema: withHash.outputSchema,
      },
      installPath: directory,
      enabled: true,
      integrityStatus: 'valid',
      source: 'installed',
      installedAt: 2,
      updatedAt: 2,
    }, [{
      workflowId: withHash.id,
      workflowVersion: withHash.version,
      path: withHash.entryPath,
      sha256: withHash.codeSha256,
    }])
    return withHash
  }
  return {
    directory, workflow, database, workers, executionEvents, orchestrator, registry, policy,
    providerSnapshot, installWorkflow, executionService,
  }
}

describe('agent workflow integration', () => {
  it.each([
    ['disabled', async (app: Awaited<ReturnType<typeof runtime>>) => {
      const installed = app.database.installedWorkflows.get(app.workflow.id, app.workflow.version)!
      app.database.installedWorkflows.upsert({ ...installed, enabled: false })
    }],
    ['failed integrity', async (app: Awaited<ReturnType<typeof runtime>>) => {
      await writeFile(join(app.directory, 'workflow.mjs'), 'tampered')
    }],
    ['unchecked integrity', async (app: Awaited<ReturnType<typeof runtime>>) => {
      vi.spyOn(app.registry, 'list').mockResolvedValue([{ ...app.workflow, integrity: 'unchecked' }])
    }],
  ] as const)('does not advertise or reserve an installed workflow with %s', async (_case, makeIneligible) => {
    const providerRequests: Array<{ tools?: unknown[] }> = []
    const app = await runtime({
      workerBehavior: 'complete',
      fetch: async (_input, init) => {
        providerRequests.push(JSON.parse(String(init?.body)) as { tools?: unknown[] })
        return response([
          { id: 'generation_direct', choices: [{ index: 0, delta: { content: '未调用工作流' }, finish_reason: 'stop' }] },
          '[DONE]',
        ])
      },
    })
    await makeIneligible(app)
    const reserve = vi.spyOn(app.executionService, 'reserve')

    const result = await app.orchestrator.run({
      conversationId: 'conversation_1', content: '请运行这个工作流', provider: 'openrouter', userId: 'user_1',
      userBlocks: [{ type: 'text', text: '请运行这个工作流' }], modelContent: '请运行这个工作流',
      assetIds: [], currentMedia: [], allowTools: true,
      model: 'local-test-model', requestId: `request_ineligible_${_case.replaceAll(' ', '_')}`,
      providerSnapshot: app.providerSnapshot,
    })

    expect(result).toMatchObject({ status: 'completed' })
    expect(providerRequests).toHaveLength(1)
    expect(providerRequests[0]?.tools ?? []).toEqual([])
    expect(reserve).not.toHaveBeenCalled()
    expect(app.database.executions.list()).toEqual([])
    expect(app.workers.workers).toEqual([])
  })

  it('semantically selects a restricted workflow by its opaque provider tool name and persists terminal status', async () => {
    const requests: RequestInit[] = []
    let turn = 0
    const app = await runtime({
      fetch: async (_input, init) => {
        requests.push(init ?? {})
        turn += 1
        if (turn === 1) {
          const firstBody = JSON.parse(String(init?.body)) as {
            tools: Array<{ function: { name: string } }>
          }
          const selectedToolName = firstBody.tools[0]!.function.name
          return response([
            {
              id: 'generation_tool',
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: 'tool_original',
                    function: {
                      name: selectedToolName,
                      arguments: JSON.stringify({
                        resolvedCity: '北京',
                        input: { keyword: '北京工作居住证' },
                      }),
                    },
                  }],
                },
                finish_reason: 'tool_calls',
              }],
            },
            '[DONE]',
          ])
        }
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
    expect(listed[0]).toMatchObject({
      enabled: true,
      integrity: 'valid',
      cities: ['北京'],
      activationExamples: ['查询人才引进材料清单'],
    })
    const pending = await app.orchestrator.run({
      conversationId: 'conversation_1', content: '我想办理北京工作居住证', provider: 'openrouter',
      userId: 'user_1',
      userBlocks: [{ type: 'text', text: '我想办理北京工作居住证' }],
      modelContent: '我想办理北京工作居住证', assetIds: [], currentMedia: [], allowTools: true,
      model: 'local-test-model', requestId: 'request_1', providerSnapshot: app.providerSnapshot,
    })
    expect(app.database.messages.listForConversation('conversation_1').find((message) => message.role === 'assistant')?.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'workflow_status', workflowId: app.workflow.id, status: 'awaiting_approval',
      }),
    ]))
    expect(pending.error).toBeUndefined()
    expect(pending).toMatchObject({ status: 'awaiting_approval' })
    const releaseExecution = vi.spyOn(app.policy, 'releaseExecution')
    const result = await app.orchestrator.resumeApproval({
      executionId: pending.executionId!, permissionIndex: 0,
      scopeHash: scopeHash(permission.scope), decision: 'once',
    })

    expect(app.database.executions.get(pending.executionId!)).toMatchObject({ status: 'completed' })
    expect(result.error).toBeUndefined()
    expect(result).toMatchObject({ status: 'completed' })
    expect(JSON.parse(String(requests[1]!.body))).toMatchObject({
      messages: expect.arrayContaining([expect.objectContaining({
        role: 'tool',
        tool_call_id: 'tool_original',
        content: expect.stringContaining('北京工作居住证'),
      })]),
    })
    expect(app.workers.workers).toHaveLength(1)
    expect(app.workers.workers[0]!.requests).toContainEqual({ type: 'capability_result', requestId: 'capability_1', result: { opened: true } })
    expect(app.executionEvents.some((event) => event.type === 'status' && event.status === 'awaiting_approval')).toBe(false)
    const messages = app.database.messages.listForConversation('conversation_1')
    expect(messages).toHaveLength(2)
    expect(JSON.stringify(messages.find((message) => message.role === 'assistant')!.blocks)).toContain('真实执行完成')
    const executionId = pending.executionId!
    const execution = app.database.executions.get(executionId)
    expect(execution).toMatchObject({
      workflowId: app.workflow.id,
      workflowVersion: app.workflow.version,
      status: 'completed',
      input: { keyword: '北京工作居住证' },
      result: { title: '北京工作居住证' },
      startedAt: expect.any(Number),
      endedAt: expect.any(Number),
    })
    expect(execution!.endedAt!).toBeGreaterThanOrEqual(execution!.startedAt!)
    const assistant = messages.find((message) => message.role === 'assistant')!
    expect(assistant.blocks).toContainEqual(expect.objectContaining({
      type: 'text',
      text: expect.any(String),
    }))
    expect(assistant.blocks).toContainEqual(expect.objectContaining({
      type: 'workflow_status',
      executionId,
      workflowId: app.workflow.id,
      workflowName: app.workflow.name,
      workflowVersion: app.workflow.version,
      source: 'installed',
      city: '北京',
      status: 'completed',
    }))
    expect(assistant.blocks).not.toContainEqual(expect.objectContaining({
      type: 'workflow_provenance',
    }))
    expect(assistant.blocks.findIndex((block) => (
      block.type === 'workflow_status' && block.status === 'completed'
    ))).toBeLessThan(assistant.blocks.findIndex((block) => (
      block.type === 'text' && block.text === '真实执行完成'
    )))
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
    expect(app.database.permissionGrants.get(
      app.workflow.id, app.workflow.version, permission.capability, scopeHash(permission.scope),
    )).toBeUndefined()
    expect(releaseExecution).toHaveBeenCalledTimes(1)
  })

  it('runs two real Worker starts sequentially and waits for both verified results before final text', async () => {
    const appRef: { current?: Awaited<ReturnType<typeof runtime>> } = {}
    let firstBody!: {
      messages: unknown[]
      tools: Array<{ function: { name: string; description: string } }>
    }
    const requestBodies: Array<{ messages: unknown[] }> = []
    let turn = 0
    const app = await runtime({
      workerBehavior: 'complete',
      workflowOverrides: { permissions: [] },
      workerOutput: (request) => ({ workflowId: request.workflowId, keyword: (request.input as { keyword: string }).keyword }),
      fetch: async (_input, init) => {
        const liveApp = appRef.current!
        const body = JSON.parse(String(init?.body)) as typeof firstBody
        requestBodies.push(body)
        turn += 1
        if (turn === 1) {
          firstBody = body
          const selectedToolName = body.tools.find(({ function: definition }) => (
            definition.description.includes('北京工作居住证')
          ))!.function.name
          return response([
            { id: 'generation_first', choices: [{ index: 0, delta: { tool_calls: [{
              index: 0,
              id: 'tool_first',
              function: {
                name: selectedToolName,
                arguments: JSON.stringify({ resolvedCity: '北京', input: { keyword: '北京办理' } }),
              },
            }] }, finish_reason: 'tool_calls' }] },
            '[DONE]',
          ])
        }
        if (turn === 2) {
          expect(liveApp.database.executions.list()).toHaveLength(1)
          expect(liveApp.database.executions.list()[0]).toMatchObject({
            workflowId: liveApp.workflow.id,
            status: 'completed',
            result: { workflowId: liveApp.workflow.id, keyword: '北京办理' },
          })
          expect(body.messages).toEqual(expect.arrayContaining([
            expect.objectContaining({ role: 'assistant', tool_calls: [expect.objectContaining({ id: 'tool_first' })] }),
            expect.objectContaining({
              role: 'tool',
              tool_call_id: 'tool_first',
              content: expect.stringContaining(liveApp.workflow.id),
            }),
          ]))
          const selectedToolName = firstBody.tools.find(({ function: definition }) => (
            definition.description.includes('全国政策查询')
          ))!.function.name
          return response([
            { id: 'generation_second', choices: [{ index: 0, delta: { tool_calls: [{
              index: 0,
              id: 'tool_second',
              function: {
                name: selectedToolName,
                arguments: JSON.stringify({ input: { keyword: '全国材料' } }),
              },
            }] }, finish_reason: 'tool_calls' }] },
            '[DONE]',
          ])
        }
        expect(liveApp.database.executions.list()).toHaveLength(2)
        expect(liveApp.database.executions.list().every(({ status }) => status === 'completed')).toBe(true)
        expect(body.messages).toEqual(expect.arrayContaining([
          expect.objectContaining({ role: 'tool', tool_call_id: 'tool_first', content: expect.stringContaining(liveApp.workflow.id) }),
          expect.objectContaining({ role: 'tool', tool_call_id: 'tool_second', content: expect.stringContaining('local.national.policy') }),
        ]))
        const assistantBeforeFinal = liveApp.database.messages.listForConversation('conversation_1')
          .find((message) => message.role === 'assistant')
        expect(JSON.stringify(assistantBeforeFinal?.blocks)).not.toContain('两个工作流均已完成')
        return response([
          { id: 'generation_final', choices: [{ index: 0, delta: { content: '两个工作流均已完成' }, finish_reason: 'stop' }] },
          '[DONE]',
        ])
      },
    })
    appRef.current = app
    const second = detail('0'.repeat(64), {
      id: 'local.national.policy',
      name: '全国政策查询',
      description: '查询全国通用政策材料',
      cities: [],
      permissions: [],
      entryPath: 'workflow-national.mjs',
      activationExamples: ['查询全国通用材料'],
    })
    await app.installWorkflow(second)

    const result = await app.orchestrator.run({
      conversationId: 'conversation_1',
      content: '请先办理北京工作居住证，再查全国通用政策',
      provider: 'openrouter',
      userId: 'user_1',
      userBlocks: [{ type: 'text', text: '请先办理北京工作居住证，再查全国通用政策' }],
      modelContent: '请先办理北京工作居住证，再查全国通用政策',
      assetIds: [], currentMedia: [], allowTools: true,
      model: 'local-test-model', requestId: 'request_sequential', providerSnapshot: app.providerSnapshot,
    })

    expect(result).toMatchObject({ status: 'completed' })
    expect(requestBodies).toHaveLength(3)
    expect(app.workers.workers).toHaveLength(2)
    expect(app.workers.workers.map((worker) => (
      worker.requests.find((request) => request.type === 'start')
    ))).toEqual([
      expect.objectContaining({ type: 'start', workflowId: app.workflow.id, input: { keyword: '北京办理' } }),
      expect.objectContaining({ type: 'start', workflowId: second.id, input: { keyword: '全国材料' } }),
    ])
    const assistant = app.database.messages.listForConversation('conversation_1')
      .find((message) => message.role === 'assistant')!
    expect(assistant.blocks).toContainEqual(expect.objectContaining({ type: 'text', text: '两个工作流均已完成' }))
    const persistedExecutions = app.database.executions.list()
    expect(persistedExecutions).toHaveLength(2)
    const firstExecution = persistedExecutions.find(({ workflowId }) => workflowId === app.workflow.id)
    const secondExecution = persistedExecutions.find(({ workflowId }) => workflowId === second.id)
    expect(firstExecution).toBeDefined()
    expect(secondExecution).toBeDefined()
    expect(firstExecution!.status).toBe('completed')
    expect(secondExecution!.status).toBe('completed')
    expect(firstExecution!.endedAt).toBeLessThanOrEqual(secondExecution!.startedAt!)
    expect(persistedExecutions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: firstExecution!.id,
        workflowId: app.workflow.id,
        workflowVersion: app.workflow.version,
        status: 'completed',
      }),
      expect.objectContaining({
        id: secondExecution!.id,
        workflowId: second.id,
        workflowVersion: second.version,
        status: 'completed',
      }),
    ]))
    expect(firstExecution!.id).not.toBe(secondExecution!.id)
    expect(assistant.blocks).toContainEqual(expect.objectContaining({
      type: 'text',
      text: expect.any(String),
    }))
    expect(assistant.blocks).toContainEqual(expect.objectContaining({
      type: 'workflow_status',
      status: 'completed',
    }))
    expect(assistant.blocks).not.toContainEqual(expect.objectContaining({
      type: 'workflow_provenance',
    }))
    expect(assistant.blocks.every((block, index) => (
      block.type !== 'workflow_status'
        || block.status !== 'completed'
        || index < assistant.blocks.findIndex((candidate) => (
          candidate.type === 'text' && candidate.text === '两个工作流均已完成'
        ))
    ))).toBe(true)
  })

  it('runs one exact multi-attachment conversion while the Provider sees canonical fields only', async () => {
    const prompt = '把这两个附件转换为 PDF'
    const providerBodies: Array<{
      messages: unknown[]
      tools: Array<{ function: { name: string } }>
    }> = []
    const appRef: { current?: Awaited<ReturnType<typeof runtime>> } = {}
    let turn = 0
    const app = await runtime({
      workerBehavior: 'complete',
      workflowOverrides: {
        id: 'file.convert.universal',
        name: '万象转换',
        description: '把当前附件转换为明确的目标格式',
        category: 'files',
        cities: [],
        permissions: [{ capability: 'file.convert', scope: { formats: ['ico', 'pdf'] } }],
        activationExamples: [prompt],
        activationNegativeExamples: [],
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['files', 'targetFormat'],
          properties: {
            files: {
              type: 'array', items: { type: 'integer', minimum: 0 },
              minItems: 1, maxItems: 5, uniqueItems: true,
            },
            targetFormat: { type: 'string', enum: ['ico', 'pdf'] },
            preset: { type: 'string', enum: ['default', 'favicon', 'app-icon'] },
          },
        },
      },
      workerOutput: (request) => ({
        workflow: '万象转换',
        results: (request.input as { files: number[] }).files.map((attachmentIndex) => ({
          accepted: true,
          status: 'completed',
          outputs: [{
            name: `converted-${attachmentIndex + 1}-1.pdf`,
            format: 'pdf',
            byteSize: attachmentIndex === 0 ? 67 : 4_096,
          }],
        })),
      }),
      fetch: async (_input, init) => {
        const liveApp = appRef.current!
        const body = JSON.parse(String(init?.body)) as typeof providerBodies[number]
        providerBodies.push(body)
        turn += 1
        if (turn === 1) {
          return response([
            { id: 'generation_convert_pdf', choices: [{ index: 0, delta: { tool_calls: [{
              index: 0,
              id: 'tool_convert_pdf',
              function: {
                name: body.tools[0]!.function.name,
                arguments: JSON.stringify({ input: { files: [0, 1], targetFormat: 'pdf' } }),
              },
            }] }, finish_reason: 'tool_calls' }] },
            '[DONE]',
          ])
        }
        const executions = liveApp.database.executions.list()
        expect(executions).toEqual([
          expect.objectContaining({
            workflowId: 'file.convert.universal',
            status: 'completed',
            input: { files: [0, 1], targetFormat: 'pdf' },
          }),
        ])
        expect(body.messages).toEqual(expect.arrayContaining([
          expect.objectContaining({
            role: 'tool',
            tool_call_id: 'tool_convert_pdf',
            content: expect.stringContaining('"status":"completed"'),
          }),
        ]))
        expect(JSON.stringify(body.messages)).toContain('converted-1-1.pdf')
        expect(JSON.stringify(body.messages)).toContain('converted-2-1.pdf')
        expect(JSON.stringify(body.messages)).not.toContain('"status":"queued"')
        return response([
          { id: 'generation_conversion_final', choices: [{
            index: 0, delta: { content: '两个附件转换处理完毕。' }, finish_reason: 'stop',
          }] },
          '[DONE]',
        ])
      },
    })
    appRef.current = app
    const starts = vi.spyOn(app.executionService, 'startReserved')
    const attachmentBindings = [
      {
        attachmentIndex: 0,
        ownerUserId: 'user_1',
        conversationId: 'conversation_1',
        displayName: 'favicon-source.png',
        mimeType: 'image/png',
        byteSize: 67,
        source: { kind: 'media' as const, mediaAssetId: 'media_private_png' },
        sourceFingerprint: 'a'.repeat(64),
      },
      {
        attachmentIndex: 1,
        ownerUserId: 'user_1',
        conversationId: 'conversation_1',
        displayName: 'contract.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        byteSize: 4_096,
        source: { kind: 'media' as const, mediaAssetId: 'media_private_docx' },
        sourceFingerprint: 'b'.repeat(64),
      },
    ]
    const firstPending = await app.orchestrator.run({
      conversationId: 'conversation_1',
      content: prompt,
      provider: 'openrouter',
      userId: 'user_1',
      userBlocks: [{ type: 'text', text: prompt }],
      modelContent: [
        '任务：选择并调用具备 file.convert 能力的本地工作流。',
        '附件数量：2',
        '附件索引：0, 1',
        '目标格式：pdf',
        '禁止读取附件内容或调用非 file.convert 工具。',
      ].join('\n'),
      assetIds: [],
      currentMedia: [
        { kind: 'image', byteSize: 67 },
        { kind: 'file', byteSize: 4_096 },
      ],
      attachmentBindings,
      allowTools: true,
      model: 'local-test-model',
      requestId: 'request_universal_conversion',
      providerSnapshot: app.providerSnapshot,
    })

    expect(firstPending).toMatchObject({ status: 'awaiting_approval' })
    const firstApproval = app.database.messages.listForConversation('conversation_1')
      .flatMap((message) => message.blocks)
      .find((block) => block.type === 'approval' && block.state === 'pending')
    expect(firstApproval).toMatchObject({
      type: 'approval',
      capability: 'file.convert',
      actionSummary: expect.stringMatching(
        /附件 0：favicon-source\.png.*附件 1：contract\.docx.*目标格式：pdf/u,
      ),
    })
    expect(JSON.stringify(firstApproval)).not.toMatch(/media_private|a{32}|b{32}/)

    const completed = await app.orchestrator.resumeApproval({
      executionId: firstPending.executionId!,
      permissionIndex: 0,
      scopeHash: scopeHash({ formats: ['ico', 'pdf'] }),
      decision: 'once',
    })

    expect(completed, JSON.stringify(completed)).toMatchObject({ status: 'completed' })
    expect(app.workers.workers).toHaveLength(1)
    expect(app.workers.workers.map((worker) => (
      worker.requests.find((request) => request.type === 'start')
    ))).toEqual([
      expect.objectContaining({
        type: 'start', workflowId: 'file.convert.universal',
        input: { files: [0, 1], targetFormat: 'pdf' },
      }),
    ])
    expect(starts.mock.calls.map(([, input]) => input.fileConvertAuthorization)).toEqual([
      expect.objectContaining({
        decision: 'once',
        attachments: [
          { index: 0, sourceFingerprint: 'a'.repeat(64) },
          { index: 1, sourceFingerprint: 'b'.repeat(64) },
        ],
        formats: ['pdf'],
      }),
    ])
    expect(providerBodies).toHaveLength(2)
    const providerPayload = JSON.stringify(providerBodies)
    expect(providerPayload).toContain('附件数量：2')
    expect(providerPayload).toContain('附件索引：0, 1')
    expect(providerPayload).toContain('目标格式：pdf')
    expect(providerPayload).not.toMatch(
      /favicon-source|contract\.docx|image\/png|application\/vnd\.openxmlformats|media_private|sourceFingerprint|attachmentBindings|fileConvertAuthorization/u,
    )
    expect(providerPayload).not.toContain(app.directory)
    expect(providerPayload).not.toMatch(/\/Users\/|[A-Za-z]:\\Users\\|iVBORw0|UEsDB|dataBase64|base64/i)
    const assistant = app.database.messages.listForConversation('conversation_1')
      .find((message) => message.role === 'assistant')!
    expect(assistant.blocks.filter((block) => block.type === 'text')).toEqual([
      expect.objectContaining({ type: 'text', text: '两个附件转换处理完毕。' }),
    ])
    expect(assistant.blocks).toContainEqual(expect.objectContaining({
      type: 'workflow_status',
      status: 'completed',
    }))
    expect(assistant.blocks).not.toContainEqual(expect.objectContaining({
      type: 'workflow_provenance',
    }))
    expect(assistant.blocks.findIndex((block) => (
      block.type === 'workflow_status' && block.status === 'completed'
    ))).toBeLessThan(assistant.blocks.findIndex((block) => (
      block.type === 'text' && block.text === '两个附件转换处理完毕。'
    )))
  })

  it.each([
    ['unknown city', '工作居住证怎么办', '请问要办理哪个城市？'],
    ['unrelated question', '什么是二进制？', '二进制是使用 0 和 1 表示数值的进位制。'],
  ] as const)('returns a direct answer for %s without execution, status, or provenance', async (_case, prompt, answer) => {
    const app = await runtime({
      workerBehavior: 'complete',
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as {
          tools: Array<{ function: { parameters: { required: string[] } } }>
        }
        expect(body.tools[0]!.function.parameters.required).toContain('resolvedCity')
        return response([
          { id: 'generation_direct', choices: [{ index: 0, delta: { content: answer }, finish_reason: 'stop' }] },
          '[DONE]',
        ])
      },
    })

    const result = await app.orchestrator.run({
      conversationId: 'conversation_1', content: prompt, provider: 'openrouter', userId: 'user_1',
      userBlocks: [{ type: 'text', text: prompt }], modelContent: prompt,
      assetIds: [], currentMedia: [], allowTools: true,
      model: 'local-test-model', requestId: `request_${_case.replace(' ', '_')}`, providerSnapshot: app.providerSnapshot,
    })

    expect(result).toMatchObject({ status: 'completed' })
    expect(app.workers.workers).toHaveLength(0)
    expect(app.database.executions.list()).toHaveLength(0)
    const assistant = app.database.messages.listForConversation('conversation_1')
      .find((message) => message.role === 'assistant')!
    expect(assistant.blocks).toEqual([expect.objectContaining({ type: 'text', text: answer })])
    expect(assistant.blocks).not.toContainEqual(expect.objectContaining({ type: 'workflow_status' }))
    expect(assistant.blocks).not.toContainEqual(expect.objectContaining({ type: 'workflow_provenance' }))
  })

  it.each([
    ['omitted', 'omitted'],
    ['empty', 'workflow'],
  ] as const)('treats %s cities as all cities at the Registry-to-Worker boundary', async (_case, manifestCities) => {
    const app = await runtime({
      manifestCities,
      workerBehavior: 'complete',
      workflowOverrides: { cities: [], permissions: [] },
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as {
          tools: Array<{ function: { name: string; parameters: { required: string[]; properties: Record<string, unknown> } } }>
          messages: unknown[]
        }
        if (body.messages.some((message) => (
          typeof message === 'object' && message !== null && 'role' in message && message.role === 'tool'
        ))) {
          return response([
            { id: 'generation_final', choices: [{ index: 0, delta: { content: '全国通用查询完成' }, finish_reason: 'stop' }] },
            '[DONE]',
          ])
        }
        const selected = body.tools[0]!.function
        expect(selected.parameters.required).toEqual(['input'])
        expect(selected.parameters.properties).not.toHaveProperty('resolvedCity')
        return response([
          { id: 'generation_tool', choices: [{ index: 0, delta: { tool_calls: [{
            index: 0,
            id: `tool_${_case}`,
            function: { name: selected.name, arguments: JSON.stringify({ input: { keyword: '上海材料' } }) },
          }] }, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ])
      },
    })

    expect((await app.registry.list())[0]?.cities).toEqual([])
    const result = await app.orchestrator.run({
      conversationId: 'conversation_1', content: '查询上海的通用材料', provider: 'openrouter', userId: 'user_1',
      userBlocks: [{ type: 'text', text: '查询上海的通用材料' }], modelContent: '查询上海的通用材料',
      assetIds: [], currentMedia: [], allowTools: true,
      model: 'local-test-model', requestId: `request_cities_${_case}`, providerSnapshot: app.providerSnapshot,
    })

    expect(result).toMatchObject({ status: 'completed' })
    expect(app.database.executions.list()).toEqual([
      expect.objectContaining({ status: 'completed', input: { keyword: '上海材料' } }),
    ])
    const assistant = app.database.messages.listForConversation('conversation_1')
      .find((message) => message.role === 'assistant')!
    expect(assistant.blocks).toContainEqual(expect.objectContaining({
      type: 'text',
      text: expect.any(String),
    }))
    expect(assistant.blocks).toContainEqual(expect.objectContaining({
      type: 'workflow_status',
      status: 'completed',
    }))
    expect(assistant.blocks).not.toContainEqual(expect.objectContaining({
      type: 'workflow_provenance',
    }))
    expect(assistant.blocks.findIndex((block) => (
      block.type === 'workflow_status' && block.status === 'completed'
    ))).toBeLessThan(assistant.blocks.findIndex((block) => (
      block.type === 'text' && block.text === '全国通用查询完成'
    )))
  })

  it.each(['disabled', 'renamed', 'output schema', 'timeout'] as const)(
    'rejects live Registry %s drift before execution persistence or Worker start',
    async (drift) => {
    let turn = 0
    const app = await runtime({
      fetch: async (_input, init) => {
        turn += 1
        if (turn === 1) {
          const body = JSON.parse(String(init?.body)) as { tools: Array<{ function: { name: string } }> }
          return response([
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'drift_tool', function: { name: body.tools[0]!.function.name, arguments: '{"resolvedCity":"北京","input":{"keyword":"今日天气"}}' } }] }, finish_reason: 'tool_calls' }] },
            '[DONE]',
          ])
        }
        return response([
          { choices: [{ index: 0, delta: { content: '工作流已变化，未执行' }, finish_reason: 'stop' }] },
          '[DONE]',
        ])
      },
    })
    const pending = await app.orchestrator.run({
      conversationId: 'conversation_1', content: '使用百度搜索今日天气', provider: 'openrouter',
      userId: 'user_1', userBlocks: [{ type: 'text', text: '使用百度搜索今日天气' }],
      modelContent: '使用百度搜索今日天气', assetIds: [], currentMedia: [], allowTools: true,
      model: 'local-test-model', requestId: 'drift_request', providerSnapshot: app.providerSnapshot,
    })
    expect(pending).toMatchObject({ status: 'awaiting_approval' })
    const installed = app.database.installedWorkflows.get(app.workflow.id, app.workflow.version)!
    const manifest = { ...(installed.manifest as Record<string, unknown>) }
    if (drift === 'renamed') manifest.name = '已改名的百度搜索'
    if (drift === 'output schema') manifest.outputSchema = { type: 'object', required: ['changed'] }
    if (drift === 'timeout') manifest.timeoutMs = 45_000
    app.database.installedWorkflows.upsert({
      ...installed,
      ...(drift === 'disabled' ? { enabled: false } : {}),
      manifest,
      updatedAt: 2,
    })

    const result = await app.orchestrator.resumeApproval({
      executionId: pending.executionId!, permissionIndex: 0,
      scopeHash: scopeHash(permission.scope), decision: 'once',
    })

    expect(result).toMatchObject({ status: 'completed' })
    expect(app.database.executions.get(pending.executionId!)).toBeUndefined()
    expect(app.workers.workers).toHaveLength(0)
    expect(JSON.stringify(app.database.messages.listForConversation('conversation_1'))).toContain('工作流已变化，未执行')
    },
  )

  it.each([
    ['input schema', (workflow: WorkflowDetail): WorkflowDetail => ({
      ...workflow,
      inputSchema: { type: 'object', required: ['changed'], properties: { changed: { type: 'boolean' } } },
    })],
    ['output schema', (workflow: WorkflowDetail): WorkflowDetail => ({
      ...workflow,
      outputSchema: { type: 'object', required: ['changed'], properties: { changed: { type: 'boolean' } } },
    })],
    ['cities', (workflow: WorkflowDetail): WorkflowDetail => ({ ...workflow, cities: ['上海'] })],
    ['name', (workflow: WorkflowDetail): WorkflowDetail => ({ ...workflow, name: '已变更的工作流' })],
    ['timeout', (workflow: WorkflowDetail): WorkflowDetail => ({ ...workflow, timeoutMs: 45_000 })],
  ] as const)('rejects service-side %s drift after the executor live check', async (_field, mutate) => {
    let resolverEntered!: () => void
    let releaseResolver!: () => void
    const entered = new Promise<void>((resolvePromise) => { resolverEntered = resolvePromise })
    const gate = new Promise<void>((resolvePromise) => { releaseResolver = resolvePromise })
    let serviceWorkflow!: WorkflowDetail
    let appDirectory = ''
    let turn = 0
    const app = await runtime({
      sourceResolver: {
        resolve: async () => {
          resolverEntered()
          await gate
          return {
            workflow: serviceWorkflow,
            rootPath: appDirectory,
            entryPath: 'workflow.mjs',
            integrity: 'valid',
          }
        },
      },
      fetch: async (_input, init) => {
        turn += 1
        if (turn === 1) {
          const body = JSON.parse(String(init?.body)) as { tools: Array<{ function: { name: string } }> }
          return response([
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'service_race_tool', function: { name: body.tools[0]!.function.name, arguments: '{"resolvedCity":"北京","input":{"keyword":"今日天气"}}' } }] }, finish_reason: 'tool_calls' }] },
            '[DONE]',
          ])
        }
        return response([
          { choices: [{ index: 0, delta: { content: '工作流在启动前发生变更' }, finish_reason: 'stop' }] },
          '[DONE]',
        ])
      },
    })
    appDirectory = app.directory
    serviceWorkflow = app.workflow
    const pending = await app.orchestrator.run({
      conversationId: 'conversation_1', content: '使用百度搜索今日天气', provider: 'openrouter',
      userId: 'user_1', userBlocks: [{ type: 'text', text: '使用百度搜索今日天气' }],
      modelContent: '使用百度搜索今日天气', assetIds: [], currentMedia: [], allowTools: true,
      model: 'local-test-model', requestId: 'service_race_request', providerSnapshot: app.providerSnapshot,
    })
    const releaseExecution = vi.spyOn(app.policy, 'releaseExecution')
    const resuming = app.orchestrator.resumeApproval({
      executionId: pending.executionId!, permissionIndex: 0,
      scopeHash: scopeHash(permission.scope), decision: 'once',
    })
    await entered

    serviceWorkflow = mutate(app.workflow)
    releaseResolver()

    await expect(resuming).resolves.toMatchObject({ status: 'completed' })
    expect(app.database.executions.get(pending.executionId!)).toMatchObject({
      status: 'failed', errorCode: 'WORKFLOW_CHANGED',
    })
    expect(app.workers.workers).toHaveLength(0)
    expect(releaseExecution).toHaveBeenCalledTimes(1)
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
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { tools: Array<{ function: { name: string } }> }
        return response([
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'cancel_tool', function: { name: body.tools[0]!.function.name, arguments: '{"resolvedCity":"北京","input":{"keyword":"今日天气"}}' } }] }, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ])
      },
    })
    appDirectory = app.directory
    const releaseExecution = vi.spyOn(app.policy, 'releaseExecution')
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
    expect(app.database.messages.listForConversation('conversation_1')
      .find((message) => message.role === 'assistant')?.blocks).toContainEqual(expect.objectContaining({
      type: 'workflow_status', status: 'cancelled', executionAvailable: true,
    }))
    expect(releaseExecution).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(app.database.messages.listForConversation('conversation_1').find((message) => message.role === 'assistant')!.blocks)).not.toContain('真实执行完成')
  })
})
