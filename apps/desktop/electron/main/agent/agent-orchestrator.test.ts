import { describe, expect, it, vi } from 'vitest'
import type { ModelProviderId, WorkflowDetail } from '@autoforge/shared'
import {
  AgentOrchestrator,
  createAgentPersistence,
  type AgentRunInput,
  type AgentOrchestratorDependencies,
  type AgentProviderPort,
  type ProviderStreamEvent,
} from './agent-orchestrator.js'
import { scopeHash } from '../permissions/policy-engine.js'
import type { ConversationHistoryPort } from '../chat/conversation-context.js'
import type { ModelProvider, ModelProviderSnapshot, ModelStreamRequest } from '../chat/model-provider.js'
import {
  ProviderUsageConsistencyError,
  type ProviderUsageRepository,
} from '../database/repositories.js'
import { createWorkflowSourceSelectorVault } from '../workflows/workflow-source-selector.js'

const workflow: WorkflowDetail = {
  id: 'browser.search.baidu', version: '1.0.0', name: '百度搜索', description: '使用百度搜索',
  author: 'AutoForge', category: 'search', enabled: true, source: 'installed', integrity: 'valid',
  updatedAt: '2026-07-19T00:00:00.000Z', codeSha256: 'a'.repeat(64), cities: [],
  runtimeIdentity: { id: 'browser.search.baidu', version: '1.0.0', source: 'installed' }, timeoutMs: 30_000,
  permissions: [{ capability: 'browser.open', scope: { origins: ['https://www.baidu.com'] } }],
  activationExamples: ['使用百度搜索今日天气'], activationNegativeExamples: [],
  inputSchema: { type: 'object', properties: { keyword: { type: 'string' } }, required: ['keyword'], additionalProperties: false },
  outputSchema: { type: 'object' },
}

function largeWorkflow(index: number, options: { descriptionPadding?: number } = {}): WorkflowDetail {
  return {
    ...workflow,
    id: `workflow.${index}`,
    name: `工作流 ${index}`,
    description: `处理任务 ${index}${'说明'.repeat(options.descriptionPadding ?? 0)}`,
    codeSha256: String(index).padStart(64, '0'),
    runtimeIdentity: { id: `workflow.${index}`, version: workflow.version, source: 'installed' },
    activationExamples: [`执行任务 ${index}`],
    activationNegativeExamples: [`不要执行任务 ${index}`],
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string', description: 'x'.repeat(5_000) } },
      additionalProperties: false,
    },
  }
}

let currentProviderInstances: Record<ModelProviderId, AgentProviderPort>

async function* events(values: ProviderStreamEvent[]) {
  for (const value of values) yield value
}

function harness(turns: ProviderStreamEvent[][]): AgentOrchestratorDependencies & {
  records: {
    users: unknown[]
    runs: unknown[]
    starts: unknown[]
    reservations: unknown[]
    decisions: unknown[]
    discards: unknown[]
    events: unknown[]
    terminal: unknown[]
    usage: Array<{ method: string; args: unknown[] }>
    order: string[]
  }
  providerInstances: Record<ModelProviderId, AgentProviderPort>
  history: { prepare: ReturnType<typeof vi.fn<ConversationHistoryPort['prepare']>> }
  providerUsage: Pick<ProviderUsageRepository, 'start' | 'bindIdentity' | 'report' | 'markUnknown'>
} {
  const records = {
    users: [] as unknown[],
    runs: [] as unknown[],
    starts: [] as unknown[],
    reservations: [] as unknown[],
    decisions: [] as unknown[],
    discards: [] as unknown[],
    events: [] as unknown[],
    terminal: [] as unknown[],
    usage: [] as Array<{ method: string; args: unknown[] }>,
    order: [] as string[],
  }
  const messages = new Map<string, { blocks: unknown[] }>()
  let reservation = 0
  const providerInstances = {
    openrouter: { stream: vi.fn(() => events(turns.shift() ?? [])) },
    deepseek: { stream: vi.fn(() => events(turns.shift() ?? [])) },
  }
  currentProviderInstances = providerInstances
  const history = { prepare: vi.fn<ConversationHistoryPort['prepare']>(async () => []) }
  const sourceSelectorVault = createWorkflowSourceSelectorVault()
  const workflows = { list: async () => [workflow] }
  const providerUsage = {
    start: vi.fn((...args: unknown[]) => {
      records.order.push('usage.start')
      records.usage.push({ method: 'start', args })
      return args[0] as never
    }),
    bindIdentity: vi.fn((...args: unknown[]) => {
      records.order.push('usage.bindIdentity')
      records.usage.push({ method: 'bindIdentity', args })
      return args[1] as never
    }),
    report: vi.fn((...args: unknown[]) => {
      records.order.push('usage.report')
      records.usage.push({ method: 'report', args })
      return args[1] as never
    }),
    markUnknown: vi.fn((...args: unknown[]) => {
      records.order.push('usage.markUnknown')
      records.usage.push({ method: 'markUnknown', args })
      return args[0] as never
    }),
  }
  return {
    records,
    providerInstances,
    workflows,
    policy: {
      evaluate: vi.fn(() => ({ allowed: false, requiresApproval: true })),
      record: vi.fn((value) => { records.decisions.push(value); return value as never }),
      releaseExecution: vi.fn(() => undefined),
    },
    executions: {
      reserve: () => {
        const reserved = { executionId: `reserved_${++reservation}` }
        records.reservations.push(reserved)
        return reserved
      },
      discardReservation: (reserved) => { records.discards.push(reserved); return true },
      startReserved: async (reserved, input) => {
        records.starts.push({ ...input, executionId: reserved.executionId })
        return { id: reserved.executionId, finished: Promise.resolve({ id: reserved.executionId, status: 'completed', result: { title: '天气' } }) }
      },
      cancel: async () => undefined,
    },
    createSourceSelector: sourceSelectorVault.create,
    inspectSource: sourceSelectorVault.inspect,
    resolveCurrentWorkflow: async (_selector, id, version) => (
      (await workflows.list()).find((candidate) => candidate.id === id && candidate.version === version)
    ),
    checkRemainingBudgets: () => undefined,
    persistence: {
      persistUser(value) { records.users.push(value); return { ordinal: records.users.length } },
      createRun(value) { records.runs.push(value) },
      createAssistant(value) { messages.set(value.messageId, { blocks: value.initialBlocks }) },
      startMediaGeneration() {},
      updateAssistant(messageId, blocks) { messages.set(messageId, { blocks }); return { blocks } },
      replaceAssistantBlock(messageId, blockId, block) {
        const current = messages.get(messageId)?.blocks ?? []
        const blocks = current.map((candidate) => (
          typeof candidate === 'object'
          && candidate !== null
          && 'blockId' in candidate
          && candidate.blockId === blockId
            ? block
            : candidate
        ))
        messages.set(messageId, { blocks })
        return { blocks }
      },
      finalize(value) { records.terminal.push(value); messages.set(value.messageId, { blocks: value.blocks }) },
    },
    emit: (event) => { records.events.push(event) },
    history,
    providerUsage,
    id: (() => { let value = 0; return () => `id_${++value}` })(),
    now: () => 100,
  }
}

const toolTurn: ProviderStreamEvent[] = [
  { type: 'tool_call', choiceIndex: 0, index: 0, id: 'call_1', name: 'workflow_1', arguments: { input: { keyword: '今日天气' } } },
  { type: 'finish', choiceIndex: 0, reason: 'tool_calls' },
]
const approvalWorkflow: WorkflowDetail = {
  ...workflow,
  permissions: [{ capability: 'browser.fill', scope: { origins: ['https://www.baidu.com'] } }],
}
const externalApprovalIdentity = {
  permissionIndex: 0,
  scopeHash: scopeHash(approvalWorkflow.permissions[0]!.scope),
}

function requireChatApproval(dependencies: AgentOrchestratorDependencies): void {
  dependencies.workflows.list = async () => [approvalWorkflow]
}

function textRunInput(
  input: Pick<AgentRunInput, 'conversationId' | 'content' | 'provider' | 'model'> & Pick<Partial<AgentRunInput>, 'requestId'>,
): AgentRunInput {
  return {
    ...input,
    userId: 'user_1',
    providerSnapshot: {
      providerId: input.provider,
      provider: currentProviderInstances[input.provider] as ModelProvider,
      ...(input.provider === 'openrouter' ? { apiKeyFingerprint: 'fingerprint_1' } : {}),
    },
    userBlocks: [{ type: 'text', text: input.content }],
    modelContent: input.content,
    assetIds: [],
    currentMedia: [],
    allowTools: true,
  }
}

describe('AgentOrchestrator', () => {
  it('passes depleted run-scoped tool budgets through the executor before reserve or start', async () => {
    const dependencies = harness([
      toolTurn,
      [
        { type: 'text_delta', choiceIndex: 0, text: '已安全停止工具执行' },
        { type: 'finish', choiceIndex: 0, reason: 'stop' },
      ],
    ])
    const checkRemainingBudgets = vi.fn(() => 'TOOL_CALL_LIMIT' as const)
    Object.assign(dependencies, { checkRemainingBudgets })

    const result = await new AgentOrchestrator(dependencies).run(textRunInput({
      conversationId: 'conversation_budget', content: '使用百度搜索今日天气', provider: 'openrouter',
      model: 'openrouter/model', requestId: 'request_budget',
    }))

    expect(result).toMatchObject({ requestId: 'request_budget', status: 'completed' })
    expect(checkRemainingBudgets).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'request_budget', phase: 'prepare', toolExecutions: 0,
    }))
    expect(dependencies.records.reservations).toHaveLength(0)
    expect(dependencies.records.starts).toHaveLength(0)
  })

  it('uses one supplied credential snapshot for context compression and every normal turn', async () => {
    const dependencies = harness([])
    const stream = vi.fn(() => events([
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ]))
    const snapshot: ModelProviderSnapshot = {
      providerId: 'openrouter',
      apiKeyFingerprint: 'snapshot_fingerprint',
      provider: {
        listModels: async () => [],
        validateCredential: async () => ({ valid: true }),
        stream,
      },
    }

    const result = await new AgentOrchestrator(dependencies).run({
      ...textRunInput({
        conversationId: 'conversation_snapshot', content: '回答', provider: 'openrouter',
        model: 'openrouter/model', requestId: 'request_snapshot',
      }),
      providerSnapshot: snapshot,
    })

    expect(result.status).toBe('completed')
    expect(dependencies.history.prepare).toHaveBeenCalledWith(expect.objectContaining({
      providerSnapshot: snapshot,
      callIdentity: expect.objectContaining({
        requestId: 'request_snapshot', userId: 'user_1', chatRunId: expect.any(String),
      }),
    }))
    expect(stream).toHaveBeenCalledTimes(1)
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({ endUserId: 'user_1' }))
    expect(dependencies.providerUsage.start).toHaveBeenCalledWith(expect.objectContaining({
      apiKeyFingerprint: 'snapshot_fingerprint',
    }))
  })

  it('routes oversized tools with the same model attribution and invisibly aggregates routing usage', async () => {
    const dependencies = harness([])
    const workflows = [largeWorkflow(1), largeWorkflow(2), largeWorkflow(3)]
    dependencies.workflows.list = async () => workflows
    const providerInputs: Array<Parameters<ModelProvider['stream']>[0]> = []
    dependencies.providerInstances.openrouter.stream = vi.fn((request) => {
      providerInputs.push(request)
      return events(providerInputs.length === 1 ? [
        { type: 'generation', id: 'routing_generation' },
        { type: 'usage', inputTokens: 2, outputTokens: 3, totalTokens: 5 },
        { type: 'text_delta', choiceIndex: 0, text: JSON.stringify([
          'workflow.3\u00001.0.0\u00003',
          'workflow.1\u00001.0.0\u00001',
        ]) },
        { type: 'finish', choiceIndex: 0, reason: 'stop' },
        { type: 'usage', inputTokens: 4, outputTokens: 5, totalTokens: 9, costUsd: '0.03' },
        { type: 'usage', inputTokens: 4, outputTokens: 5, totalTokens: 9, costUsd: '0.03' },
      ] : [
        { type: 'text_delta', choiceIndex: 0, text: '直接回答' },
        { type: 'finish', choiceIndex: 0, reason: 'stop' },
        { type: 'usage', inputTokens: 7, outputTokens: 11, totalTokens: 18, costUsd: '0.04' },
      ])
    })

    const result = await new AgentOrchestrator(dependencies).run({
      ...textRunInput({
        conversationId: 'conversation_routing', content: '执行第三个再第一个', provider: 'openrouter',
        model: 'openrouter/model', requestId: 'request_routing',
      }),
      contextLength: 32_000,
    })

    expect(result.status).toBe('completed')
    expect(providerInputs).toHaveLength(2)
    expect(providerInputs[0]).toMatchObject({
      model: 'openrouter/model', endUserId: 'user_1', messages: expect.any(Array),
    })
    expect(providerInputs[0]).not.toHaveProperty('tools')
    expect(JSON.stringify(providerInputs[0])).not.toContain('dataBase64')
    expect(providerInputs[1]).toMatchObject({
      model: 'openrouter/model', endUserId: 'user_1',
      tools: [
        expect.objectContaining({ function: expect.objectContaining({ name: 'workflow_3' }) }),
        expect.objectContaining({ function: expect.objectContaining({ name: 'workflow_1' }) }),
      ],
    })
    expect(providerInputs[0]!.signal).toBe(providerInputs[1]!.signal)
    expect(dependencies.providerUsage.start).toHaveBeenNthCalledWith(1, expect.objectContaining({
      operationKey: 'agent:request_routing:workflow-routing',
      userId: 'user_1', requestId: 'request_routing', model: 'openrouter/model',
      apiKeyFingerprint: 'fingerprint_1', chatRunId: expect.any(String),
    }))
    expect(dependencies.providerUsage.start).toHaveBeenNthCalledWith(2, expect.objectContaining({
      operationKey: 'agent:request_routing:turn:0',
    }))
    expect(dependencies.records.terminal.at(-1)).toMatchObject({
      status: 'completed', inputTokens: 11, outputTokens: 16, costUsd: '0.07',
      blocks: [{ type: 'text', text: '直接回答' }],
    })
    expect(JSON.stringify(dependencies.records.events)).not.toContain('workflow.3\\u0000')
    expect(dependencies.records.starts).toHaveLength(0)
  })

  it('fails compact routing overflow before provider selection or workflow execution', async () => {
    const dependencies = harness([])
    dependencies.workflows.list = async () => [
      largeWorkflow(1, { descriptionPadding: 10_000 }),
      largeWorkflow(2, { descriptionPadding: 10_000 }),
    ]

    const result = await new AgentOrchestrator(dependencies).run({
      ...textRunInput({
        conversationId: 'conversation_routing_overflow', content: '执行任务', provider: 'openrouter',
        model: 'openrouter/model', requestId: 'request_routing_overflow',
      }),
      contextLength: 32_000,
    })

    expect(result).toMatchObject({ status: 'failed', error: { code: 'CONTEXT_LIMIT_EXCEEDED' } })
    expect(dependencies.providerInstances.openrouter.stream).not.toHaveBeenCalled()
    expect(dependencies.records.starts).toHaveLength(0)
    expect(dependencies.records.terminal).toEqual([
      expect.objectContaining({ status: 'failed', errorCode: 'CONTEXT_LIMIT_EXCEEDED' }),
    ])
  })

  it('aborts routing without entering a normal model decision or workflow execution', async () => {
    const dependencies = harness([])
    dependencies.workflows.list = async () => [largeWorkflow(1), largeWorkflow(2), largeWorkflow(3)]
    let routingStarted!: () => void
    let releaseRouting!: () => void
    const started = new Promise<void>((resolve) => { routingStarted = resolve })
    const released = new Promise<void>((resolve) => { releaseRouting = resolve })
    const requests: ModelStreamRequest[] = []
    dependencies.providerInstances.openrouter.stream = vi.fn(async function* (request) {
      requests.push(request)
      yield {
        type: 'usage' as const, inputTokens: 3, outputTokens: 2, totalTokens: 5,
      }
      yield {
        type: 'usage' as const, inputTokens: 5, outputTokens: 4, totalTokens: 9, costUsd: '0.06',
      }
      routingStarted()
      await released
      yield {
        type: 'text_delta' as const, choiceIndex: 0,
        text: JSON.stringify(['workflow.1\u00001.0.0\u00001']),
      }
      yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
    })
    const orchestrator = new AgentOrchestrator(dependencies)
    const running = orchestrator.run({
      ...textRunInput({
        conversationId: 'conversation_routing_abort', content: '执行任务', provider: 'openrouter',
        model: 'openrouter/model', requestId: 'request_routing_abort',
      }),
      contextLength: 32_000,
    })
    await started

    await orchestrator.cancel('request_routing_abort')
    releaseRouting()

    await expect(running).resolves.toMatchObject({ status: 'cancelled' })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.signal?.aborted).toBe(true)
    expect(dependencies.records.starts).toHaveLength(0)
    expect(dependencies.records.terminal).toEqual([
      expect.objectContaining({
        status: 'cancelled', inputTokens: 5, outputTokens: 4, costUsd: '0.06',
      }),
    ])
    expect(dependencies.records.events).toEqual([
      expect.objectContaining({ type: 'status', status: 'cancelled' }),
    ])
  })

  it('propagates a context compression usage consistency error after terminalizing the durable run', async () => {
    const dependencies = harness([])
    const error = new ProviderUsageConsistencyError()
    dependencies.history.prepare = vi.fn<ConversationHistoryPort['prepare']>(async () => {
      throw error
    })

    await expect(new AgentOrchestrator(dependencies).run(textRunInput({
      conversationId: 'conversation_summary_consistency', content: '回答', provider: 'openrouter',
      model: 'openrouter/model', requestId: 'request_summary_consistency',
    }))).rejects.toBe(error)
    expect(dependencies.records.terminal).toHaveLength(1)
  })

  it('accumulates compatibility costs with exact decimal addition including large, tiny, zero, and undefined values', async () => {
    const dependencies = harness([
      [
        { type: 'usage', inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: '9007199254740992.000000000001' },
        ...toolTurn,
      ],
      [
        { type: 'usage', inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: '0.000000000009' },
        ...toolTurn,
      ],
      [
        { type: 'usage', inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: '0' },
        ...toolTurn,
      ],
      [
        { type: 'usage', inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        { type: 'finish', choiceIndex: 0, reason: 'stop' },
      ],
    ])
    dependencies.policy.evaluate = () => ({ allowed: true, requiresApproval: false })

    const result = await new AgentOrchestrator(dependencies).run(textRunInput({
      conversationId: 'conversation_exact_cost', content: '连续调用', provider: 'openrouter',
      model: 'openrouter/model', requestId: 'request_exact_cost',
    }))

    expect(result.status).toBe('completed')
    expect(dependencies.records.terminal.at(-1)).toMatchObject({
      inputTokens: 4,
      outputTokens: 4,
      costUsd: '9007199254740992.00000000001',
    })
  })

  it.each([
    ['zero', '0', '0'],
    ['undefined', undefined, undefined],
  ] as const)('preserves %s compatibility cost semantics', async (_name, costUsd, expected) => {
    const dependencies = harness([[
      {
        type: 'usage', inputTokens: 1, outputTokens: 2, totalTokens: 3,
        ...(costUsd === undefined ? {} : { costUsd }),
      },
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ]])

    await new AgentOrchestrator(dependencies).run(textRunInput({
      conversationId: `conversation_${_name}`, content: '回答', provider: 'openrouter', model: 'm',
    }))

    const terminal = dependencies.records.terminal.at(-1) as { costUsd?: string }
    if (expected === undefined) expect(terminal).not.toHaveProperty('costUsd')
    else expect(terminal.costUsd).toBe(expected)
  })

  it('records each OpenRouter turn before streaming and reports only that turn cost immediately', async () => {
    const dependencies = harness([])
    const firstTurn = [
      { type: 'generation', id: 'generation_1' },
      { type: 'usage', inputTokens: 2, outputTokens: 3, totalTokens: 5, costUsd: '0.01' },
      ...toolTurn,
    ] satisfies ProviderStreamEvent[]
    const secondTurn = [
      { type: 'generation', id: 'generation_2' },
      { type: 'usage', inputTokens: 5, outputTokens: 7, totalTokens: 12, costUsd: '0.02' },
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ] satisfies ProviderStreamEvent[]
    let turn = 0
    dependencies.providerInstances.openrouter.stream = vi.fn((request) => {
      dependencies.records.order.push(`provider.stream:${turn}`)
      expect(request.endUserId).toBe('user_1')
      return events(turn++ === 0 ? firstTurn : secondTurn)
    })
    dependencies.policy.evaluate = () => ({ allowed: true, requiresApproval: false })

    const result = await new AgentOrchestrator(dependencies).run(textRunInput({
      conversationId: 'conversation_usage',
      content: '搜索后回答',
      provider: 'openrouter',
      model: 'openrouter/model',
      requestId: 'request_usage',
    }))

    expect(result.status).toBe('completed')
    expect(dependencies.records.order).toEqual([
      'usage.start',
      'provider.stream:0',
      'usage.bindIdentity',
      'usage.report',
      'usage.start',
      'provider.stream:1',
      'usage.bindIdentity',
      'usage.report',
    ])
    expect(dependencies.providerUsage.start).toHaveBeenNthCalledWith(1, expect.objectContaining({
      id: expect.any(String),
      operationKey: 'agent:request_usage:turn:0',
      userId: 'user_1',
      apiKeyFingerprint: 'fingerprint_1',
      provider: 'openrouter',
      requestId: 'request_usage',
      chatRunId: expect.any(String),
      model: 'openrouter/model',
      modality: 'text',
      startedAt: 100,
    }))
    expect(dependencies.providerUsage.start).toHaveBeenNthCalledWith(2, expect.objectContaining({
      operationKey: 'agent:request_usage:turn:1',
    }))
    expect(dependencies.providerUsage.report).toHaveBeenNthCalledWith(1,
      'agent:request_usage:turn:0',
      {
        generationId: 'generation_1',
        inputTokens: 2,
        outputTokens: 3,
        costUsd: '0.01',
        endedAt: 100,
      },
    )
    expect(dependencies.providerUsage.report).toHaveBeenNthCalledWith(2,
      'agent:request_usage:turn:1',
      {
        generationId: 'generation_2',
        inputTokens: 5,
        outputTokens: 7,
        costUsd: '0.02',
        endedAt: 100,
      },
    )
    expect(dependencies.providerUsage.markUnknown).not.toHaveBeenCalled()
    expect(dependencies.records.terminal.at(-1)).toMatchObject({
      inputTokens: 7,
      outputTokens: 10,
      costUsd: '0.03',
    })
  })

  it('keeps a reported OpenRouter charge when later local tool execution fails', async () => {
    const dependencies = harness([[
      { type: 'generation', id: 'generation_paid' },
      { type: 'usage', inputTokens: 2, outputTokens: 1, totalTokens: 3, costUsd: '0.04' },
      ...toolTurn,
    ], [{ type: 'finish', choiceIndex: 0, reason: 'stop' }]])
    dependencies.policy.evaluate = () => ({ allowed: true, requiresApproval: false })
    dependencies.executions.startReserved = async (reservation) => ({
      id: reservation.executionId,
      finished: Promise.resolve({ id: reservation.executionId, status: 'failed', errorCode: 'INTERNAL_ERROR' }),
    })

    const result = await new AgentOrchestrator(dependencies).run(textRunInput({
      conversationId: 'conversation_local_failure',
      content: '搜索',
      provider: 'openrouter',
      model: 'openrouter/model',
      requestId: 'request_local_failure',
    }))

    expect(result).toMatchObject({ status: 'completed' })
    expect(dependencies.providerUsage.report).toHaveBeenCalledWith(
      'agent:request_local_failure:turn:0',
      expect.objectContaining({ costUsd: '0.04', generationId: 'generation_paid' }),
    )
    expect(dependencies.providerUsage.markUnknown).toHaveBeenCalledWith(
      'agent:request_local_failure:turn:1', 100,
    )
  })

  it('marks a costless OpenRouter turn unknown after binding its generation identity', async () => {
    const dependencies = harness([[
      { type: 'generation', id: 'generation_unknown' },
      { type: 'usage', inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ]])

    await new AgentOrchestrator(dependencies).run(textRunInput({
      conversationId: 'conversation_unknown',
      content: '回答',
      provider: 'openrouter',
      model: 'openrouter/model',
      requestId: 'request_unknown',
    }))

    expect(dependencies.providerUsage.bindIdentity).toHaveBeenCalledWith(
      'agent:request_unknown:turn:0',
      { generationId: 'generation_unknown' },
    )
    expect(dependencies.providerUsage.markUnknown).toHaveBeenCalledWith(
      'agent:request_unknown:turn:0',
      100,
    )
    expect(dependencies.providerUsage.report).not.toHaveBeenCalled()
  })

  it('keeps DeepSeek token compatibility without creating an OpenRouter usage event', async () => {
    const dependencies = harness([[
      { type: 'usage', inputTokens: 8, outputTokens: 9, totalTokens: 17, costUsd: '0.05' },
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ]])

    await new AgentOrchestrator(dependencies).run(textRunInput({
      conversationId: 'conversation_deepseek',
      content: '回答',
      provider: 'deepseek',
      model: 'deepseek-chat',
      requestId: 'request_deepseek',
    }))

    expect(dependencies.providerUsage.start).not.toHaveBeenCalled()
    expect(dependencies.providerUsage.report).not.toHaveBeenCalled()
    expect(dependencies.records.runs).toEqual([
      expect.objectContaining({
        userId: 'user_1',
        provider: 'deepseek',
        requestId: 'request_deepseek',
      }),
    ])
    expect(dependencies.records.terminal.at(-1)).toMatchObject({
      inputTokens: 8,
      outputTokens: 9,
      costUsd: '0.05',
    })
  })
  it('prepends prepared history before the current user message', async () => {
    const dependencies = harness([[
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ]])
    dependencies.history.prepare = vi.fn<ConversationHistoryPort['prepare']>(async () => [
      { role: 'user', content: '我的代号是青山' },
      { role: 'assistant', content: '已记住' },
    ])
    const currentMedia = [{ kind: 'audio' as const, durationMs: 1_000 }]

    await new AgentOrchestrator(dependencies).run({
      ...textRunInput({
        conversationId: 'c1', content: '我的代号是什么？', provider: 'openrouter', model: 'model',
      }),
      contextLength: 4_096,
      currentMedia,
    })

    expect(dependencies.history.prepare).toHaveBeenCalledWith({
      conversationId: 'c1',
      beforeOrdinal: 1,
      providerSnapshot: {
        providerId: 'openrouter',
        provider: dependencies.providerInstances.openrouter,
        apiKeyFingerprint: 'fingerprint_1',
      },
      callIdentity: { requestId: 'id_1', chatRunId: 'id_3', userId: 'user_1' },
      model: 'model',
      contextLength: 4_096,
      currentMessage: { role: 'user', content: '我的代号是什么？' },
      tools: [{
        type: 'function',
        function: {
          name: 'workflow_1',
          description: expect.stringContaining(workflow.id),
          parameters: {
            type: 'object', additionalProperties: false, required: ['input'],
            properties: { input: workflow.inputSchema },
          },
        },
      }],
      currentMedia,
      signal: expect.any(AbortSignal),
    })
    expect(dependencies.providerInstances.openrouter.stream).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: 'user', content: '我的代号是青山' },
          { role: 'assistant', content: '已记住' },
          { role: 'user', content: '我的代号是什么？' },
        ],
      }),
    )
  })

  it('rejects only same-conversation concurrent runs before persistence', async () => {
    const dependencies = harness([])
    let started!: () => void
    let release!: () => void
    const providerStarted = new Promise<void>((resolve) => { started = resolve })
    const providerReleased = new Promise<void>((resolve) => { release = resolve })
    dependencies.providerInstances.openrouter.stream = vi.fn(async function* () {
      started()
      await providerReleased
      yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
    })
    const orchestrator = new AgentOrchestrator(dependencies)

    const first = orchestrator.run(textRunInput({
      conversationId: 'c1', content: 'first', provider: 'openrouter', model: 'm',
    }))
    await providerStarted
    const duplicate = await orchestrator.run(textRunInput({
      conversationId: 'c1', content: 'duplicate', provider: 'openrouter', model: 'm',
    }))
    const other = orchestrator.run(textRunInput({
      conversationId: 'c2', content: 'other', provider: 'openrouter', model: 'm',
    }))

    expect(duplicate).toMatchObject({
      status: 'failed', error: { code: 'CONFLICT' },
    })
    expect(dependencies.records.users).toHaveLength(2)
    release()
    await expect(Promise.all([first, other])).resolves.toEqual([
      expect.objectContaining({ status: 'completed' }),
      expect.objectContaining({ status: 'completed' }),
    ])
  })

  it('keeps prepared summaries private from chat events', async () => {
    const dependencies = harness([[
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ]])
    dependencies.history.prepare = vi.fn<ConversationHistoryPort['prepare']>(async () => [
      { role: 'system', content: '内部摘要：用户曾说过青山' },
    ])

    await new AgentOrchestrator(dependencies).run(textRunInput({
      conversationId: 'c1', content: '继续', provider: 'openrouter', model: 'm',
    }))

    expect(dependencies.providerInstances.openrouter.stream).toHaveBeenCalledWith(expect.objectContaining({
      messages: [
        { role: 'system', content: '内部摘要：用户曾说过青山' },
        { role: 'user', content: '继续' },
      ],
    }))
    expect(JSON.stringify(dependencies.records.events)).not.toContain('内部摘要')
  })

  it('finalizes a context-limit failure once and releases the conversation for retry', async () => {
    const dependencies = harness([[
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ]])
    dependencies.history.prepare = vi.fn<ConversationHistoryPort['prepare']>(async () => {
      throw { code: 'CONTEXT_LIMIT_EXCEEDED' }
    })
    const orchestrator = new AgentOrchestrator(dependencies)

    const failed = await orchestrator.run(textRunInput({
      conversationId: 'c1', content: '过长', provider: 'openrouter', model: 'm',
    }))
    dependencies.history.prepare = vi.fn<ConversationHistoryPort['prepare']>(async () => [])
    const retried = await orchestrator.run(textRunInput({
      conversationId: 'c1', content: '重试', provider: 'openrouter', model: 'm',
    }))

    expect(failed).toMatchObject({ status: 'failed', error: { code: 'CONTEXT_LIMIT_EXCEEDED' } })
    expect(dependencies.records.terminal).toHaveLength(2)
    expect(dependencies.records.terminal[0]).toMatchObject({
      status: 'failed', errorCode: 'CONTEXT_LIMIT_EXCEEDED',
    })
    expect(retried).toMatchObject({ status: 'completed' })
  })

  it('persists supplied display blocks with exact assets and sends normalized content only to the provider', async () => {
    const dependencies = harness([[
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ]])
    const userBlocks = [
      { type: 'text' as const, text: '描述图片' },
      {
        type: 'media' as const,
        blockId: 'block_image',
        assetId: 'asset_image',
        kind: 'image' as const,
        purpose: 'input' as const,
        name: 'image.png',
        mimeType: 'image/png',
        byteSize: 3,
      },
    ]
    const modelContent = [
      { type: 'text' as const, text: '描述图片' },
      { type: 'media' as const, kind: 'image' as const, mimeType: 'image/png', dataBase64: 'AQID' },
    ]
    const orchestrator = new AgentOrchestrator(dependencies)

    const result = await orchestrator.run({
      userId: 'user_1',
      providerSnapshot: {
        providerId: 'openrouter', provider: dependencies.providerInstances.openrouter as ModelProvider,
        apiKeyFingerprint: 'fingerprint_1',
      },
      conversationId: 'conversation_media',
      content: '描述图片',
      userBlocks,
      modelContent,
      assetIds: ['asset_image'],
      currentMedia: [{ kind: 'image' }],
      allowTools: false,
      provider: 'openrouter',
      model: 'vision-model',
    })

    expect(result.status).toBe('completed')
    expect(dependencies.records.users).toEqual([
      expect.objectContaining({
        conversationId: 'conversation_media',
        blocks: userBlocks,
        assetIds: ['asset_image'],
      }),
    ])
    expect(JSON.stringify(dependencies.records.users)).not.toContain('AQID')
    expect(dependencies.providerInstances.openrouter.stream).toHaveBeenCalledWith(expect.objectContaining({
      messages: [{ role: 'user', content: modelContent }],
    }))
  })

  it('claims exact assets when the production persistence adapter inserts a user message', () => {
    const insert = vi.fn()
    const insertRun = vi.fn()
    const insertWithAssets = vi.fn(() => ({ ordinal: 7 }))
    const replaceBlock = vi.fn()
    const persistence = createAgentPersistence({
      messages: { insert, insertWithAssets, replaceBlock },
      chatRuns: { insert: insertRun },
    } as never)
    const blocks = [{ type: 'text' as const, text: '带附件' }]

    expect(persistence.persistUser({
      messageId: 'message_1',
      conversationId: 'conversation_1',
      blocks,
      assetIds: ['asset_1'],
      createdAt: 10,
    })).toEqual({ ordinal: 7 })

    expect(insertWithAssets).toHaveBeenCalledWith({
      id: 'message_1',
      conversationId: 'conversation_1',
      role: 'user',
      blocks,
      createdAt: 10,
    }, ['asset_1'])
    expect(insert).not.toHaveBeenCalled()

    persistence.createRun({
      runId: 'run_1',
      conversationId: 'conversation_1',
      requestId: 'request_1',
      userId: 'user_1',
      provider: 'openrouter',
      model: 'openrouter/model',
      startedAt: 10,
    })
    expect(insertRun).toHaveBeenCalledWith({
      id: 'run_1',
      conversationId: 'conversation_1',
      requestId: 'request_1',
      userId: 'user_1',
      provider: 'openrouter',
      model: 'openrouter/model',
      status: 'running',
      startedAt: 10,
    })

    const pending = {
      type: 'media_generation' as const,
      blockId: 'block_1',
      jobId: 'request_1',
      kind: 'image' as const,
      status: 'in_progress' as const,
    }
    persistence.createAssistant({
      messageId: 'assistant_1',
      conversationId: 'conversation_1',
      initialBlocks: [pending],
      createdAt: 11,
    })
    expect(insert).toHaveBeenCalledWith({
      id: 'assistant_1',
      conversationId: 'conversation_1',
      role: 'assistant',
      blocks: [pending],
      createdAt: 11,
    })
    persistence.replaceAssistantBlock('assistant_1', 'block_1', pending)
    expect(replaceBlock).toHaveBeenCalledWith('assistant_1', 'block_1', pending)

    const finalizeWithMessage = vi.fn()
    const terminalPersistence = createAgentPersistence({
      messages: { insert, insertWithAssets, replaceBlock },
      chatRuns: { finalizeWithMessage },
    } as never)
    terminalPersistence.finalize({
      runId: 'run_1',
      requestId: 'request_1',
      messageId: 'assistant_1',
      blocks: [pending],
      status: 'failed',
      endedAt: 12,
      errorCode: 'MEDIA_GENERATION_FAILED',
    })
    expect(finalizeWithMessage).toHaveBeenCalledWith(
      'run_1',
      'assistant_1',
      'request_1',
      expect.objectContaining({ status: 'failed', errorCode: 'MEDIA_GENERATION_FAILED' }),
    )
  })

  it('skips workflow listing when tools are disabled', async () => {
    const dependencies = harness([[
      { type: 'text_delta', choiceIndex: 0, text: '视觉结果' },
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ]])
    dependencies.workflows.list = vi.fn(async () => { throw new Error('must not list workflows') })

    const result = await new AgentOrchestrator(dependencies).run({
      userId: 'user_1',
      providerSnapshot: {
        providerId: 'openrouter', provider: dependencies.providerInstances.openrouter as ModelProvider,
        apiKeyFingerprint: 'fingerprint_1',
      },
      conversationId: 'conversation_1',
      content: '描述图片',
      userBlocks: [{ type: 'text', text: '描述图片' }],
      modelContent: '描述图片',
      assetIds: [],
      currentMedia: [],
      allowTools: false,
      provider: 'openrouter',
      model: 'vision-model',
    })

    expect(result.status).toBe('completed')
    expect(dependencies.workflows.list).not.toHaveBeenCalled()
    expect(dependencies.providerInstances.openrouter.stream).toHaveBeenCalledWith(
      expect.not.objectContaining({ tools: expect.anything() }),
    )
  })

  it('persists the user first and pauses before starting an approval-gated workflow', async () => {
    const dependencies = harness([toolTurn])
    requireChatApproval(dependencies)
    const orchestrator = new AgentOrchestrator(dependencies)

    const result = await orchestrator.run(textRunInput({ conversationId: 'conversation_1', content: '使用百度搜索今日天气', provider: 'openrouter', model: 'model' }))

    expect(result.status).toBe('awaiting_approval')
    expect(dependencies.records.users).toHaveLength(1)
    expect(dependencies.records.starts).toHaveLength(0)
    expect(dependencies.records.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'block', block: expect.objectContaining({ type: 'workflow_proposal', workflowId: workflow.id }) }),
      expect.objectContaining({
        type: 'block',
        block: expect.objectContaining({ type: 'approval', workflowId: workflow.id, workflowVersion: workflow.version }),
      }),
    ]))
  })

  it('auto-grants safe navigation and starts through the workflow executor without approval', async () => {
    const dependencies = harness([toolTurn, [
      { type: 'text_delta', choiceIndex: 0, text: '搜索完成' },
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ]])

    const result = await new AgentOrchestrator(dependencies).run(textRunInput({
      conversationId: 'safe_navigation', content: '使用百度搜索今日天气', provider: 'openrouter', model: 'model',
    }))

    expect(result.status).toBe('completed')
    expect(dependencies.records.starts).toHaveLength(1)
    expect(dependencies.policy.record).toHaveBeenCalledWith(expect.objectContaining({
      executionId: expect.any(String), capability: 'browser.open', decision: 'once',
    }))
    expect(dependencies.policy.evaluate).not.toHaveBeenCalled()
    expect(dependencies.records.events).not.toContainEqual(expect.objectContaining({
      type: 'block', block: expect.objectContaining({ type: 'approval' }),
    }))
  })

  it('returns semantic input failure to the model without reserving or starting', async () => {
    const invalidToolTurn: ProviderStreamEvent[] = [
      { type: 'tool_call', choiceIndex: 0, index: 0, id: 'call_invalid', name: 'workflow_1', arguments: { input: {} } },
      { type: 'finish', choiceIndex: 0, reason: 'tool_calls' },
    ]
    const dependencies = harness([invalidToolTurn, [
      { type: 'text_delta', choiceIndex: 0, text: '请补充关键词' },
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ]])
    const providerInputs: ModelStreamRequest[] = []
    const turns = [invalidToolTurn, [
      { type: 'text_delta', choiceIndex: 0, text: '请补充关键词' },
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ]] satisfies ProviderStreamEvent[][]
    dependencies.providerInstances.openrouter.stream = vi.fn((request) => {
      providerInputs.push(request)
      return events(turns.shift() ?? [])
    })
    const reserve = vi.spyOn(dependencies.executions, 'reserve')

    const result = await new AgentOrchestrator(dependencies).run(textRunInput({
      conversationId: 'invalid_input', content: '搜索', provider: 'openrouter', model: 'model',
    }))

    expect(result.status).toBe('completed')
    expect(reserve).not.toHaveBeenCalled()
    expect(dependencies.records.starts).toHaveLength(0)
    expect(providerInputs[1]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'tool', tool_call_id: 'call_invalid', content: expect.stringContaining('INVALID_INPUT') }),
    ]))
  })

  it('continues after chat denial with a safe permission result and releases the reservation', async () => {
    const externalWorkflow: WorkflowDetail = {
      ...workflow,
      permissions: [{ capability: 'browser.fill', scope: { origins: ['https://www.baidu.com'] } }],
    }
    const dependencies = harness([toolTurn, [
      { type: 'text_delta', choiceIndex: 0, text: '已取消操作' },
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ]])
    dependencies.workflows.list = async () => [externalWorkflow]
    const providerInputs: ModelStreamRequest[] = []
    const turns = [toolTurn, [
      { type: 'text_delta', choiceIndex: 0, text: '已取消操作' },
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ]] satisfies ProviderStreamEvent[][]
    dependencies.providerInstances.openrouter.stream = vi.fn((request) => {
      providerInputs.push(request)
      return events(turns.shift() ?? [])
    })
    const release = vi.spyOn(dependencies.policy, 'releaseExecution')
    const orchestrator = new AgentOrchestrator(dependencies)
    const pending = await orchestrator.run(textRunInput({
      conversationId: 'denial', content: '填写搜索框', provider: 'openrouter', model: 'model',
    }))

    const result = await orchestrator.resumeApproval({
      executionId: pending.executionId!,
      permissionIndex: 0,
      scopeHash: scopeHash(externalWorkflow.permissions[0]!.scope),
      decision: 'deny',
    })

    expect(result.status).toBe('completed')
    expect(dependencies.records.starts).toHaveLength(0)
    expect(dependencies.records.discards).toHaveLength(1)
    expect(release).toHaveBeenCalledTimes(1)
    expect(providerInputs[1]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'tool', content: expect.stringContaining('PERMISSION_DENIED') }),
    ]))
  })

  it('keeps an oversized completed workflow result out of the next model request', async () => {
    const dependencies = harness([toolTurn, [
      { type: 'text_delta', choiceIndex: 0, text: '结果过大' },
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ]])
    dependencies.executions.startReserved = async (reservation) => ({
      id: reservation.executionId,
      finished: Promise.resolve({ id: reservation.executionId, status: 'completed', result: '汉'.repeat(100_000) }),
    })
    const providerInputs: ModelStreamRequest[] = []
    const turns = [toolTurn, [
      { type: 'text_delta', choiceIndex: 0, text: '结果过大' },
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ]] satisfies ProviderStreamEvent[][]
    dependencies.providerInstances.openrouter.stream = vi.fn((request) => {
      providerInputs.push(request)
      return events(turns.shift() ?? [])
    })

    const result = await new AgentOrchestrator(dependencies).run({
      ...textRunInput({ conversationId: 'large_result', content: '搜索', provider: 'openrouter', model: 'model' }),
      contextLength: 128_000,
    })

    expect(result.status).toBe('completed')
    expect(providerInputs[1]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'tool', content: expect.stringContaining('RESULT_TOO_LARGE') }),
    ]))
    expect(JSON.stringify(providerInputs[1])).not.toContain('汉汉汉汉汉汉汉汉')
  })

  it('validates approval and tool arguments, then returns the result with the original tool call id', async () => {
    const dependencies = harness([toolTurn, [
      { type: 'text_delta', choiceIndex: 0, text: '搜索结果：天气晴' },
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ]])
    requireChatApproval(dependencies)
    const providerInputs: unknown[] = []
    dependencies.providerInstances.openrouter.stream = vi.fn((input) => { providerInputs.push(input); return events((providerInputs.length === 1 ? toolTurn : [
      { type: 'text_delta', choiceIndex: 0, text: '搜索结果：天气晴' },
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ])) })
    const orchestrator = new AgentOrchestrator(dependencies)
    const pending = await orchestrator.run(textRunInput({ conversationId: 'conversation_1', content: '使用百度搜索今日天气', provider: 'openrouter', model: 'model' }))

    const done = await orchestrator.resumeApproval({ executionId: pending.executionId!, ...externalApprovalIdentity, decision: 'once' })

    expect(done.status).toBe('completed')
    expect(dependencies.records.starts).toHaveLength(1)
    expect(dependencies.records.starts[0]).toMatchObject({ userId: 'user_1' })
    expect(JSON.stringify(providerInputs[1])).toContain('"tool_call_id":"call_1"')
    expect(dependencies.records.terminal.at(-1)).toMatchObject({ status: 'completed' })
  })

  it.each(['terminal completion', 'cancellation'] as const)(
    'cleans Agent execution ownership after %s',
    async (testCase) => {
      const dependencies = harness([toolTurn, [
        { type: 'text_delta', choiceIndex: 0, text: 'done' },
        { type: 'finish', choiceIndex: 0, reason: 'stop' },
      ]])
      requireChatApproval(dependencies)
      const orchestrator = new AgentOrchestrator(dependencies)
      const pending = await orchestrator.run(textRunInput({
        conversationId: `ownership_${testCase}`,
        content: 'search',
        provider: 'openrouter',
        model: 'model',
      }))
      const ownsExecution = (executionId: string) => (
        orchestrator as unknown as { ownsExecution(id: string): boolean }
      ).ownsExecution(executionId)

      expect(ownsExecution(pending.executionId!)).toBe(true)
      if (testCase === 'terminal completion') {
        await orchestrator.resumeApproval({
          executionId: pending.executionId!,
          ...externalApprovalIdentity,
          decision: 'once',
        })
      } else {
        await orchestrator.cancelExecution(pending.executionId!)
      }
      expect(ownsExecution(pending.executionId!)).toBe(false)
    },
  )

  it('keeps a resolved city outside the workflow input passed to the Worker', async () => {
    const cityWorkflow: WorkflowDetail = { ...workflow, cities: ['北京'] }
    const cityToolTurn: ProviderStreamEvent[] = [
      {
        type: 'tool_call', choiceIndex: 0, index: 0, id: 'call_city', name: 'workflow_1',
        arguments: { resolvedCity: '北京', input: { keyword: '今日天气' } },
      },
      { type: 'finish', choiceIndex: 0, reason: 'tool_calls' },
    ]
    const dependencies = harness([cityToolTurn, [{ type: 'finish', choiceIndex: 0, reason: 'stop' }]])
    dependencies.workflows.list = async () => [cityWorkflow]
    dependencies.policy.evaluate = () => ({ allowed: true, requiresApproval: false })

    const result = await new AgentOrchestrator(dependencies).run(textRunInput({
      conversationId: 'city', content: '北京今天天气', provider: 'openrouter', model: 'model',
    }))

    expect(result.status).toBe('completed')
    expect(dependencies.records.starts[0]).toMatchObject({ input: { keyword: '今日天气' } })
    expect(dependencies.records.starts[0]).not.toMatchObject({ input: expect.objectContaining({ resolvedCity: expect.anything() }) })
  })

  it.each([
    ['$defs', {
      type: 'object', additionalProperties: false, required: ['amount'],
      $defs: { amount: { type: 'number' } },
      properties: { amount: { $ref: '#/$defs/amount' } },
    }],
    ['definitions', {
      type: 'object', additionalProperties: false, required: ['amount'],
      definitions: { amount: { type: 'number' } },
      properties: { amount: { $ref: '#/definitions/amount' } },
    }],
  ] as const)('validates a workflow input with local %s references', async (_kind, inputSchema) => {
    const referencedWorkflow: WorkflowDetail = { ...workflow, inputSchema }
    const dependencies = harness([[
      { type: 'tool_call', choiceIndex: 0, index: 0, id: 'call_ref', name: 'workflow_1', arguments: { input: { amount: 1 } } },
      { type: 'finish', choiceIndex: 0, reason: 'tool_calls' },
    ], [{ type: 'finish', choiceIndex: 0, reason: 'stop' }]])
    dependencies.workflows.list = async () => [referencedWorkflow]
    dependencies.policy.evaluate = () => ({ allowed: true, requiresApproval: false })

    const result = await new AgentOrchestrator(dependencies).run(textRunInput({
      conversationId: `references_${_kind}`, content: '金额', provider: 'openrouter', model: 'model',
    }))

    expect(result.status).toBe('completed')
    expect(dependencies.records.starts[0]).toMatchObject({ input: { amount: 1 } })
  })

  it('keeps the first normalized media message unchanged across a tool follow-up', async () => {
    const dependencies = harness([])
    requireChatApproval(dependencies)
    const providerInputs: Array<Parameters<AgentProviderPort['stream']>[0]> = []
    dependencies.providerInstances.openrouter.stream = vi.fn((input) => {
      providerInputs.push(input)
      return events(providerInputs.length === 1 ? toolTurn : [
        { type: 'text_delta', choiceIndex: 0, text: '搜索完成' },
        { type: 'finish', choiceIndex: 0, reason: 'stop' },
      ])
    })
    const modelContent = [
      { type: 'text' as const, text: '结合图片搜索' },
      { type: 'media' as const, kind: 'image' as const, mimeType: 'image/png', dataBase64: 'AQID' },
    ]
    const orchestrator = new AgentOrchestrator(dependencies)

    const pending = await orchestrator.run({
      userId: 'user_1',
      providerSnapshot: {
        providerId: 'openrouter', provider: dependencies.providerInstances.openrouter as ModelProvider,
        apiKeyFingerprint: 'fingerprint_1',
      },
      conversationId: 'conversation_1',
      content: '结合图片搜索',
      userBlocks: [{ type: 'text', text: '结合图片搜索' }],
      modelContent,
      assetIds: [],
      currentMedia: [{ kind: 'image' }],
      allowTools: true,
      provider: 'openrouter',
      model: 'vision-model',
    })
    const done = await orchestrator.resumeApproval({
      executionId: pending.executionId!,
      ...externalApprovalIdentity,
      decision: 'once',
    })

    expect(done.status).toBe('completed')
    expect(providerInputs[1]?.messages).toEqual([
      { role: 'user', content: modelContent },
      expect.objectContaining({ role: 'assistant' }),
      expect.objectContaining({ role: 'tool', tool_call_id: 'call_1' }),
    ])
  })

  it('reuses the supplied provider snapshot after a tool continuation', async () => {
    const dependencies = harness([toolTurn, [
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ]])
    requireChatApproval(dependencies)
    const original = dependencies.providerInstances.deepseek
    const replacement: AgentProviderPort = { stream: vi.fn(() => events([])) }
    const orchestrator = new AgentOrchestrator(dependencies)

    const pending = await orchestrator.run(textRunInput({
      conversationId: 'c',
      content: '搜索',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    }))
    dependencies.providerInstances.deepseek = replacement
    const result = await orchestrator.resumeApproval({
      executionId: pending.executionId!,
      ...externalApprovalIdentity,
      decision: 'once',
    })

    expect(result.status).toBe('completed')
    expect(original.stream).toHaveBeenCalledTimes(2)
    expect(replacement.stream).not.toHaveBeenCalled()
  })

  it('binds always approval to the exact manifest permission and deny never starts execution', async () => {
    const mismatchDependencies = harness([toolTurn])
    requireChatApproval(mismatchDependencies)
    const mismatchOrchestrator = new AgentOrchestrator(mismatchDependencies)
    const mismatchPending = await mismatchOrchestrator.run(textRunInput({ conversationId: 'c1', content: '搜索', provider: 'openrouter', model: 'm' }))
    const mismatch = await mismatchOrchestrator.resumeApproval({
      executionId: mismatchPending.executionId!, ...externalApprovalIdentity, decision: 'always', workflowId: workflow.id,
      workflowVersion: workflow.version, capability: 'browser.fill', scope: { origins: ['https://example.com'] },
    })
    expect(mismatch).toMatchObject({ status: 'failed', error: { code: 'INVALID_INPUT' } })
    expect(mismatchDependencies.records.decisions).toHaveLength(0)
    expect(mismatchDependencies.records.starts).toHaveLength(0)

    const denyDependencies = harness([toolTurn, [{ type: 'finish', choiceIndex: 0, reason: 'stop' }]])
    requireChatApproval(denyDependencies)
    const denyOrchestrator = new AgentOrchestrator(denyDependencies)
    const denyPending = await denyOrchestrator.run(textRunInput({ conversationId: 'c2', content: '搜索', provider: 'openrouter', model: 'm' }))
    const denied = await denyOrchestrator.resumeApproval({ executionId: denyPending.executionId!, ...externalApprovalIdentity, decision: 'deny' })
    expect(denied).toMatchObject({ status: 'completed' })
    expect(denyDependencies.records.starts).toHaveLength(0)
    expect(denyDependencies.records.terminal).toHaveLength(1)
    expect(denyDependencies.records.discards).toHaveLength(1)
  })

  it('returns a safe tool error and discards an unstarted reservation when policy recording throws', async () => {
    const dependencies = harness([toolTurn, [{ type: 'finish', choiceIndex: 0, reason: 'stop' }]])
    requireChatApproval(dependencies)
    dependencies.policy.record = () => { throw new Error('policy unavailable') }
    const orchestrator = new AgentOrchestrator(dependencies)
    const pending = await orchestrator.run(textRunInput({ conversationId: 'c', content: '搜索', provider: 'openrouter', model: 'm' }))

    const result = await orchestrator.resumeApproval({
      executionId: pending.executionId!, ...externalApprovalIdentity, decision: 'once',
    })

    expect(result).toMatchObject({ status: 'completed' })
    expect(dependencies.records.starts).toHaveLength(0)
    expect(dependencies.records.discards).toHaveLength(1)
    expect(dependencies.records.terminal).toEqual([expect.objectContaining({ status: 'completed' })])
  })

  it('identifies and emits each missing permission one at a time', async () => {
    const firstPermission = { capability: 'browser.fill' as const, scope: { origins: ['https://www.baidu.com'] } }
    const secondPermission = { capability: 'browser.click' as const, scope: { origins: ['https://www.baidu.com'] } }
    const twoPermissionWorkflow = { ...workflow, permissions: [firstPermission, secondPermission] }
    const dependencies = harness([toolTurn, [
      { type: 'text_delta', choiceIndex: 0, text: '完成' },
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ]])
    dependencies.workflows.list = async () => [twoPermissionWorkflow]
    const orchestrator = new AgentOrchestrator(dependencies)
    const first = await orchestrator.run(textRunInput({ conversationId: 'c', content: '搜索', provider: 'openrouter', model: 'm' }))

    const second = await orchestrator.resumeApproval({
      executionId: first.executionId!, permissionIndex: 0, scopeHash: scopeHash(firstPermission.scope), decision: 'once',
    })

    expect(second).toMatchObject({ status: 'awaiting_approval', executionId: first.executionId })
    expect(dependencies.records.starts).toHaveLength(0)
    const approvals = dependencies.records.events
      .map((event) => (event as { block?: unknown }).block)
      .filter((block): block is { type: string; permissionIndex: number; scopeHash: string; capability: string } => Boolean(block) && (block as { type?: string }).type === 'approval')
    expect(approvals.map((block) => block.permissionIndex)).toEqual([0, 1])
    expect(approvals.map((block) => block.capability)).toEqual(['browser.fill', 'browser.click'])

    const stale = await orchestrator.resumeApproval({
      executionId: first.executionId!, permissionIndex: 0, scopeHash: scopeHash(firstPermission.scope), decision: 'once',
    })
    expect(stale).toMatchObject({ status: 'failed', error: { code: 'CONFLICT' } })
    expect(dependencies.records.starts).toHaveLength(0)

    const done = await orchestrator.resumeApproval({
      executionId: first.executionId!, permissionIndex: 1, scopeHash: scopeHash(secondPermission.scope), decision: 'once',
    })
    expect(done.status).toBe('completed')
    expect(dependencies.records.starts).toHaveLength(1)
  })

  it('rejects unknown tools, invalid args, and multiple active tools', async () => {
    const unknown = harness([[{ ...toolTurn[0]!, name: 'unknown' } as ProviderStreamEvent, toolTurn[1]!]])
    await expect(new AgentOrchestrator(unknown).run(textRunInput({ conversationId: 'c', content: 'x', provider: 'openrouter', model: 'm' })))
      .resolves.toMatchObject({ status: 'failed' })

    const invalid = harness([[{ ...toolTurn[0]!, arguments: {} } as ProviderStreamEvent, toolTurn[1]!]])
    await expect(new AgentOrchestrator(invalid).run(textRunInput({ conversationId: 'c', content: 'x', provider: 'openrouter', model: 'm' })))
      .resolves.toMatchObject({ status: 'failed' })

    const multiple = harness([[toolTurn[0]!, { ...toolTurn[0]!, id: 'call_2', index: 1 } as ProviderStreamEvent, toolTurn[1]!]])
    await expect(new AgentOrchestrator(multiple).run(textRunInput({ conversationId: 'c', content: 'x', provider: 'openrouter', model: 'm' })))
      .resolves.toMatchObject({ status: 'failed' })

  })

  it.each(['length', 'content_filter', 'unknown_finish'])('terminalizes partial text after %s without another provider round', async (reason) => {
    const dependencies = harness([])
    let providerCalls = 0
    dependencies.providerInstances.openrouter.stream = vi.fn(() => {
      providerCalls += 1
      return events([
        { type: 'text_delta', choiceIndex: 0, text: '保留部分内容' },
        { type: 'finish', choiceIndex: 0, reason },
        { type: 'usage', inputTokens: 2, outputTokens: 1, totalTokens: 3, costUsd: '0.01' },
      ])
    })

    const result = await new AgentOrchestrator(dependencies).run(textRunInput({ conversationId: 'c', content: 'x', provider: 'openrouter', model: 'm' }))

    expect(result).toMatchObject({ status: 'failed', error: { code: 'MODEL_PROVIDER_REQUEST_FAILED' } })
    expect(providerCalls).toBe(1)
    expect(dependencies.records.terminal).toHaveLength(1)
    expect(dependencies.records.terminal[0]).toMatchObject({
      status: 'failed', inputTokens: 2, outputTokens: 1, costUsd: '0.01',
      blocks: expect.arrayContaining([expect.objectContaining({ type: 'text', text: '保留部分内容' })]),
    })
  })

  it('persists partial text before emitting and terminalizes when the event sink throws', async () => {
    const dependencies = harness([[
      { type: 'text_delta', choiceIndex: 0, text: '部分' },
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ]])
    const order: string[] = []
    dependencies.persistence.updateAssistant = (_id, blocks) => { order.push(`persist:${JSON.stringify(blocks)}`); return { blocks } }
    dependencies.emit = () => { order.push('emit'); throw new Error('renderer closed') }

    const result = await new AgentOrchestrator(dependencies).run(textRunInput({ conversationId: 'c', content: 'x', provider: 'openrouter', model: 'm' }))

    expect(result.status).toBe('completed')
    expect(order[0]).toContain('persist')
    expect(dependencies.records.terminal).toHaveLength(1)
  })

  it('atomically finalizes an error block before emitting that block and terminal status', async () => {
    const dependencies = harness([[
      { ...toolTurn[0]!, name: 'unknown' } as ProviderStreamEvent,
      toolTurn[1]!,
    ]])
    const order: string[] = []
    dependencies.persistence.finalize = (value) => {
      order.push(`finalize:${JSON.stringify(value.blocks.at(-1))}`)
      dependencies.records.terminal.push(value)
    }
    dependencies.emit = (event) => {
      const detail = event.type === 'block'
        ? event.block.type
        : event.type === 'status' ? event.status : event.block.type
      order.push(`emit:${event.type}:${detail}`)
    }

    const result = await new AgentOrchestrator(dependencies).run(textRunInput({ conversationId: 'c', content: 'x', provider: 'openrouter', model: 'm' }))

    expect(result.status).toBe('failed')
    expect(order.slice(-3)).toEqual([
      expect.stringContaining('finalize:{"type":"error"'),
      'emit:block:error',
      'emit:status:failed',
    ])
  })

  it('terminalizes the durable run when workflow discovery fails before the provider starts', async () => {
    const dependencies = harness([])
    dependencies.workflows.list = async () => { throw new Error('registry unavailable') }

    const result = await new AgentOrchestrator(dependencies).run(textRunInput({ conversationId: 'c', content: 'x', provider: 'openrouter', model: 'm' }))

    expect(result).toMatchObject({ status: 'failed', error: { code: 'INTERNAL_ERROR' } })
    expect(dependencies.records.users).toHaveLength(1)
    expect(dependencies.records.terminal).toHaveLength(1)
  })

  it('cancels provider and execution and rejects concurrent resume races', async () => {
    let resolveExecution!: (value: { id: string; status: string }) => void
    const dependencies = harness([toolTurn])
    dependencies.policy.evaluate = () => ({ allowed: true, requiresApproval: false })
    dependencies.executions.startReserved = async (reserved) => ({
      id: reserved.executionId,
      finished: new Promise((resolve) => { resolveExecution = resolve }),
    })
    let cancelled = false
    dependencies.executions.cancel = async () => { cancelled = true; resolveExecution({ id: 'x', status: 'cancelled' }) }
    const orchestrator = new AgentOrchestrator(dependencies)
    const running = orchestrator.run(textRunInput({ conversationId: 'c', content: 'x', provider: 'openrouter', model: 'm', requestId: 'request_1' }))
    for (let index = 0; index < 20 && dependencies.records.starts.length === 0; index += 1) await Promise.resolve()

    await orchestrator.cancel('request_1')
    await expect(running).resolves.toMatchObject({ status: 'cancelled' })
    expect(cancelled).toBe(true)
    expect(dependencies.records.terminal).toHaveLength(1)
  })

  it.each([
    {
      name: 'generation identity',
      event: { type: 'generation', id: 'generation_after_cancel' } as ProviderStreamEvent,
      assertRecorded(dependencies: ReturnType<typeof harness>) {
        expect(dependencies.providerUsage.bindIdentity).toHaveBeenCalledWith(
          'agent:request_after_cancel:turn:0',
          { generationId: 'generation_after_cancel' },
        )
      },
    },
    {
      name: 'reported cost',
      event: {
        type: 'usage', inputTokens: 4, outputTokens: 5, totalTokens: 9, costUsd: '0.09',
      } as ProviderStreamEvent,
      assertRecorded(dependencies: ReturnType<typeof harness>) {
        expect(dependencies.providerUsage.report).toHaveBeenCalledWith(
          'agent:request_after_cancel:turn:0',
          { inputTokens: 4, outputTokens: 5, costUsd: '0.09', endedAt: 100 },
        )
      },
    },
  ])('records a delivered $name before respecting cancellation', async ({ event, assertRecorded }) => {
    const dependencies = harness([])
    let providerStarted!: () => void
    let releaseProvider!: () => void
    const started = new Promise<void>((resolve) => { providerStarted = resolve })
    const released = new Promise<void>((resolve) => { releaseProvider = resolve })
    dependencies.providerInstances.openrouter.stream = vi.fn(async function* () {
      providerStarted()
      await released
      yield event
    })
    const orchestrator = new AgentOrchestrator(dependencies)
    const running = orchestrator.run(textRunInput({
      conversationId: 'conversation_after_cancel',
      content: '回答',
      provider: 'openrouter',
      model: 'openrouter/model',
      requestId: 'request_after_cancel',
    }))
    await started

    await orchestrator.cancel('request_after_cancel')
    releaseProvider()

    await expect(running).resolves.toMatchObject({ status: 'cancelled' })
    assertRecorded(dependencies)
  })

  it('rethrows provider usage consistency errors even after cancellation terminalized the run', async () => {
    const dependencies = harness([])
    let providerStarted!: () => void
    let releaseProvider!: () => void
    const started = new Promise<void>((resolve) => { providerStarted = resolve })
    const released = new Promise<void>((resolve) => { releaseProvider = resolve })
    dependencies.providerInstances.openrouter.stream = vi.fn(async function* () {
      providerStarted()
      await released
      yield { type: 'usage' as const, inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: '0.01' }
    })
    vi.mocked(dependencies.providerUsage.report).mockImplementation(() => {
      throw new ProviderUsageConsistencyError()
    })
    const orchestrator = new AgentOrchestrator(dependencies)
    const running = orchestrator.run(textRunInput({
      conversationId: 'conversation_consistency_error',
      content: '回答',
      provider: 'openrouter',
      model: 'openrouter/model',
      requestId: 'request_consistency_error',
    }))
    await started

    await orchestrator.cancel('request_consistency_error')
    releaseProvider()

    await expect(running).rejects.toBeInstanceOf(ProviderUsageConsistencyError)
    expect(dependencies.records.terminal).toHaveLength(1)
  })

  it('terminalizes an approved run when the next model turn hits a usage consistency error', async () => {
    const dependencies = harness([
      toolTurn,
      [
        { type: 'usage', inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: '0.01' },
        { type: 'finish', choiceIndex: 0, reason: 'stop' },
      ],
    ])
    requireChatApproval(dependencies)
    const error = new ProviderUsageConsistencyError()
    vi.mocked(dependencies.providerUsage.report).mockImplementation(() => { throw error })
    const orchestrator = new AgentOrchestrator(dependencies)
    const pending = await orchestrator.run(textRunInput({
      conversationId: 'conversation_resume_consistency',
      content: '搜索后回答',
      provider: 'openrouter',
      model: 'openrouter/model',
      requestId: 'request_resume_consistency',
    }))

    await expect(orchestrator.resumeApproval({
      executionId: pending.executionId!,
      ...externalApprovalIdentity,
      decision: 'once',
    })).rejects.toBe(error)

    expect(dependencies.records.terminal).toHaveLength(1)
    expect(dependencies.records.terminal[0]).toMatchObject({
      status: 'failed', errorCode: 'INTERNAL_ERROR',
    })
    expect(orchestrator.hasActiveRuns()).toBe(false)

    dependencies.providerInstances.openrouter.stream = vi.fn(() => events([
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ]))
    await expect(orchestrator.run(textRunInput({
      conversationId: 'conversation_resume_consistency',
      content: '重新回答',
      provider: 'openrouter',
      model: 'openrouter/model',
      requestId: 'request_after_resume_consistency',
    }))).resolves.toMatchObject({ status: 'completed' })
  })

  it('aborts an in-flight media provider turn and terminalizes cancellation once', async () => {
    const dependencies = harness([])
    let providerSignal: AbortSignal | undefined
    let providerStarted!: () => void
    const started = new Promise<void>((resolve) => { providerStarted = resolve })
    dependencies.providerInstances.openrouter.stream = vi.fn(async function* (input) {
      providerSignal = input.signal
      providerStarted()
      await new Promise<void>((_resolve, reject) => {
        input.signal?.addEventListener('abort', () => reject({ code: 'CANCELLED' }), { once: true })
      })
      yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
    })
    const orchestrator = new AgentOrchestrator(dependencies)
    const running = orchestrator.run({
      userId: 'user_1',
      providerSnapshot: {
        providerId: 'openrouter', provider: dependencies.providerInstances.openrouter as ModelProvider,
        apiKeyFingerprint: 'fingerprint_1',
      },
      conversationId: 'conversation_1',
      content: '描述图片',
      userBlocks: [{ type: 'text', text: '描述图片' }],
      modelContent: [
        { type: 'text', text: '描述图片' },
        { type: 'media', kind: 'image', mimeType: 'image/png', dataBase64: 'AQID' },
      ],
      assetIds: [],
      currentMedia: [{ kind: 'image' }],
      allowTools: false,
      provider: 'openrouter',
      model: 'vision-model',
      requestId: 'media_request',
    })
    await started

    await orchestrator.cancel('media_request')

    await expect(running).resolves.toMatchObject({ status: 'cancelled' })
    expect(providerSignal?.aborted).toBe(true)
    expect(dependencies.records.terminal).toHaveLength(1)
  })

  it('cancels an approval-gated agent run by its execution identity', async () => {
    const dependencies = harness([toolTurn])
    requireChatApproval(dependencies)
    const orchestrator = new AgentOrchestrator(dependencies)
    const pending = await orchestrator.run(textRunInput({ conversationId: 'c', content: '搜索', provider: 'openrouter', model: 'm' }))

    await orchestrator.cancelExecution(pending.executionId!)

    expect(dependencies.records.terminal).toEqual([
      expect.objectContaining({ requestId: pending.requestId, status: 'cancelled' }),
    ])
    expect(dependencies.records.discards).toHaveLength(1)
  })

  it('allows only one resume continuation for the same approval', async () => {
    let finishExecution!: (value: { id: string; status: string; result: unknown }) => void
    let markStartEntered!: () => void
    const startEntered = new Promise<void>((resolve) => { markStartEntered = resolve })
    const dependencies = harness([toolTurn, [
      { type: 'text_delta', choiceIndex: 0, text: '完成' },
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ]])
    requireChatApproval(dependencies)
    dependencies.executions.startReserved = async (reserved, input) => {
      dependencies.records.starts.push({ ...input, executionId: reserved.executionId })
      markStartEntered()
      return {
        id: reserved.executionId,
        finished: new Promise((resolve) => { finishExecution = resolve }),
      }
    }
    const orchestrator = new AgentOrchestrator(dependencies)
    const pending = await orchestrator.run(textRunInput({ conversationId: 'c', content: '搜索', provider: 'openrouter', model: 'm' }))

    const first = orchestrator.resumeApproval({ executionId: pending.executionId!, ...externalApprovalIdentity, decision: 'once' })
    await startEntered
    const second = await orchestrator.resumeApproval({ executionId: pending.executionId!, ...externalApprovalIdentity, decision: 'once' })
    expect(second).toMatchObject({ status: 'failed', error: { code: 'CONFLICT' } })
    expect(dependencies.records.starts).toHaveLength(1)

    finishExecution({ id: pending.executionId!, status: 'completed', result: { ok: true } })
    await expect(first).resolves.toMatchObject({ status: 'completed' })
    expect(dependencies.records.terminal).toHaveLength(1)
  })
})
