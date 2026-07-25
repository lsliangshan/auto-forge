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

const workflow: WorkflowDetail = {
  id: 'browser.search.baidu', version: '1.0.0', name: '百度搜索', description: '使用百度搜索',
  author: 'AutoForge', category: 'search', enabled: true, source: 'installed', integrity: 'valid',
  updatedAt: '2026-07-19T00:00:00.000Z', timeoutMs: 30_000,
  permissions: [{ capability: 'browser.open', scope: { origins: ['https://www.baidu.com'] } }],
  activationExamples: ['使用百度搜索今日天气'], activationNegativeExamples: [],
  inputSchema: { type: 'object', properties: { keyword: { type: 'string' } }, required: ['keyword'], additionalProperties: false },
  outputSchema: { type: 'object' },
}

async function* events(values: ProviderStreamEvent[]) {
  for (const value of values) yield value
}

function harness(turns: ProviderStreamEvent[][]): AgentOrchestratorDependencies & {
  records: { users: unknown[]; starts: unknown[]; decisions: unknown[]; discards: unknown[]; events: unknown[]; terminal: unknown[] }
  providerInstances: Record<ModelProviderId, AgentProviderPort>
  registry: { get: ReturnType<typeof vi.fn> }
} {
  const records = { users: [] as unknown[], starts: [] as unknown[], decisions: [] as unknown[], discards: [] as unknown[], events: [] as unknown[], terminal: [] as unknown[] }
  const messages = new Map<string, { blocks: unknown[] }>()
  let reservation = 0
  const providerInstances = {
    openrouter: { stream: vi.fn(() => events(turns.shift() ?? [])) },
    deepseek: { stream: vi.fn(() => events(turns.shift() ?? [])) },
  }
  const registry = { get: vi.fn((provider: ModelProviderId) => providerInstances[provider]) }
  return {
    records,
    providers: registry,
    providerInstances,
    registry,
    workflows: { list: async () => [workflow] },
    retrieve: () => [workflow],
    policy: {
      evaluate: () => ({ allowed: false, requiresApproval: true }),
      record: (value) => { records.decisions.push(value); return value as never },
      releaseExecution: () => undefined,
    },
    executions: {
      reserve: () => ({ executionId: `reserved_${++reservation}` }),
      discardReservation: (reserved) => { records.discards.push(reserved); return true },
      startReserved: async (reserved, input) => {
        records.starts.push({ ...input, executionId: reserved.executionId })
        return { id: reserved.executionId, finished: Promise.resolve({ id: reserved.executionId, status: 'completed', result: { title: '天气' } }) }
      },
      cancel: async () => undefined,
    },
    persistence: {
      persistUser(value) { records.users.push(value) },
      createRun() {},
      createAssistant(value) { messages.set(value.messageId, { blocks: value.initialBlocks }) },
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
    id: (() => { let value = 0; return () => `id_${++value}` })(),
    now: () => 100,
  }
}

const toolTurn: ProviderStreamEvent[] = [
  { type: 'tool_call', choiceIndex: 0, index: 0, id: 'call_1', name: workflow.id, arguments: { keyword: '今日天气' } },
  { type: 'finish', choiceIndex: 0, reason: 'tool_calls' },
]
const approvalIdentity = { permissionIndex: 0, scopeHash: scopeHash(workflow.permissions[0]!.scope) }

function textRunInput(
  input: Pick<AgentRunInput, 'conversationId' | 'content' | 'provider' | 'model'> & Pick<Partial<AgentRunInput>, 'requestId'>,
): AgentRunInput {
  return {
    ...input,
    userBlocks: [{ type: 'text', text: input.content }],
    modelContent: input.content,
    assetIds: [],
    allowTools: true,
  }
}

describe('AgentOrchestrator', () => {
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
      conversationId: 'conversation_media',
      content: '描述图片',
      userBlocks,
      modelContent,
      assetIds: ['asset_image'],
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
    const insertWithAssets = vi.fn()
    const replaceBlock = vi.fn()
    const persistence = createAgentPersistence({
      messages: { insert, insertWithAssets, replaceBlock },
      chatRuns: {},
    } as never)
    const blocks = [{ type: 'text' as const, text: '带附件' }]

    persistence.persistUser({
      messageId: 'message_1',
      conversationId: 'conversation_1',
      blocks,
      assetIds: ['asset_1'],
      createdAt: 10,
    })

    expect(insertWithAssets).toHaveBeenCalledWith({
      id: 'message_1',
      conversationId: 'conversation_1',
      role: 'user',
      blocks,
      createdAt: 10,
    }, ['asset_1'])
    expect(insert).not.toHaveBeenCalled()

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

  it('skips workflow listing and retrieval when tools are disabled', async () => {
    const dependencies = harness([[
      { type: 'text_delta', choiceIndex: 0, text: '视觉结果' },
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ]])
    dependencies.workflows.list = vi.fn(async () => { throw new Error('must not list workflows') })
    dependencies.retrieve = vi.fn(() => { throw new Error('must not retrieve workflows') })

    const result = await new AgentOrchestrator(dependencies).run({
      conversationId: 'conversation_1',
      content: '描述图片',
      userBlocks: [{ type: 'text', text: '描述图片' }],
      modelContent: '描述图片',
      assetIds: [],
      allowTools: false,
      provider: 'openrouter',
      model: 'vision-model',
    })

    expect(result.status).toBe('completed')
    expect(dependencies.workflows.list).not.toHaveBeenCalled()
    expect(dependencies.retrieve).not.toHaveBeenCalled()
    expect(dependencies.providerInstances.openrouter.stream).toHaveBeenCalledWith(
      expect.not.objectContaining({ tools: expect.anything() }),
    )
  })

  it('persists the user first and pauses before starting an approval-gated workflow', async () => {
    const dependencies = harness([toolTurn])
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

  it('validates approval and tool arguments, then returns the result with the original tool call id', async () => {
    const dependencies = harness([toolTurn, [
      { type: 'text_delta', choiceIndex: 0, text: '搜索结果：天气晴' },
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ]])
    const providerInputs: unknown[] = []
    dependencies.providerInstances.openrouter.stream = vi.fn((input) => { providerInputs.push(input); return events((providerInputs.length === 1 ? toolTurn : [
      { type: 'text_delta', choiceIndex: 0, text: '搜索结果：天气晴' },
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ])) })
    const orchestrator = new AgentOrchestrator(dependencies)
    const pending = await orchestrator.run(textRunInput({ conversationId: 'conversation_1', content: '使用百度搜索今日天气', provider: 'openrouter', model: 'model' }))

    const done = await orchestrator.resumeApproval({ executionId: pending.executionId!, ...approvalIdentity, decision: 'once' })

    expect(done.status).toBe('completed')
    expect(dependencies.records.starts).toHaveLength(1)
    expect(JSON.stringify(providerInputs[1])).toContain('"tool_call_id":"call_1"')
    expect(dependencies.records.terminal.at(-1)).toMatchObject({ status: 'completed' })
  })

  it('keeps the first normalized media message unchanged across a tool follow-up', async () => {
    const dependencies = harness([])
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
      conversationId: 'conversation_1',
      content: '结合图片搜索',
      userBlocks: [{ type: 'text', text: '结合图片搜索' }],
      modelContent,
      assetIds: [],
      allowTools: true,
      provider: 'openrouter',
      model: 'vision-model',
    })
    const done = await orchestrator.resumeApproval({
      executionId: pending.executionId!,
      ...approvalIdentity,
      decision: 'once',
    })

    expect(done.status).toBe('completed')
    expect(providerInputs[1]?.messages).toEqual([
      { role: 'user', content: modelContent },
      expect.objectContaining({ role: 'assistant' }),
      expect.objectContaining({ role: 'tool', tool_call_id: 'call_1' }),
    ])
  })

  it('resolves a provider once and reuses it after a tool continuation', async () => {
    const dependencies = harness([toolTurn, [
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ]])
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
    await orchestrator.resumeApproval({
      executionId: pending.executionId!,
      ...approvalIdentity,
      decision: 'once',
    })

    expect(original.stream).toHaveBeenCalledTimes(2)
    expect(replacement.stream).not.toHaveBeenCalled()
    expect(dependencies.registry.get).toHaveBeenCalledTimes(1)
  })

  it('binds always approval to the exact manifest permission and deny never starts execution', async () => {
    const mismatchDependencies = harness([toolTurn])
    const mismatchOrchestrator = new AgentOrchestrator(mismatchDependencies)
    const mismatchPending = await mismatchOrchestrator.run(textRunInput({ conversationId: 'c1', content: '搜索', provider: 'openrouter', model: 'm' }))
    const mismatch = await mismatchOrchestrator.resumeApproval({
      executionId: mismatchPending.executionId!, ...approvalIdentity, decision: 'always', workflowId: workflow.id,
      workflowVersion: workflow.version, capability: 'browser.open', scope: { origins: ['https://example.com'] },
    })
    expect(mismatch).toMatchObject({ status: 'failed', error: { code: 'INVALID_INPUT' } })
    expect(mismatchDependencies.records.decisions).toHaveLength(0)
    expect(mismatchDependencies.records.starts).toHaveLength(0)

    const denyDependencies = harness([toolTurn])
    const denyOrchestrator = new AgentOrchestrator(denyDependencies)
    const denyPending = await denyOrchestrator.run(textRunInput({ conversationId: 'c2', content: '搜索', provider: 'openrouter', model: 'm' }))
    const denied = await denyOrchestrator.resumeApproval({ executionId: denyPending.executionId!, ...approvalIdentity, decision: 'deny' })
    expect(denied).toMatchObject({ status: 'failed', error: { code: 'PERMISSION_DENIED' } })
    expect(denyDependencies.records.starts).toHaveLength(0)
    expect(denyDependencies.records.terminal).toHaveLength(1)
    expect(denyDependencies.records.discards).toHaveLength(1)
  })

  it('terminalizes and discards an unstarted reservation when policy recording throws', async () => {
    const dependencies = harness([toolTurn])
    dependencies.policy.record = () => { throw new Error('policy unavailable') }
    const orchestrator = new AgentOrchestrator(dependencies)
    const pending = await orchestrator.run(textRunInput({ conversationId: 'c', content: '搜索', provider: 'openrouter', model: 'm' }))

    const result = await orchestrator.resumeApproval({
      executionId: pending.executionId!, ...approvalIdentity, decision: 'once',
    })

    expect(result).toMatchObject({ status: 'failed', error: { code: 'INTERNAL_ERROR' } })
    expect(dependencies.records.starts).toHaveLength(0)
    expect(dependencies.records.discards).toHaveLength(1)
    expect(dependencies.records.terminal).toHaveLength(1)
  })

  it.each(['once', 'always'] as const)('identifies and emits each missing permission across %s then once approval', async (firstDecision) => {
    const secondPermission = { capability: 'browser.fill' as const, scope: { origins: ['https://www.baidu.com'] } }
    const twoPermissionWorkflow = { ...workflow, permissions: [workflow.permissions[0]!, secondPermission] }
    const dependencies = harness([toolTurn, [
      { type: 'text_delta', choiceIndex: 0, text: '完成' },
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ]])
    dependencies.workflows.list = async () => [twoPermissionWorkflow]
    dependencies.retrieve = () => [twoPermissionWorkflow]
    dependencies.policy.evaluate = (request) => ({
      allowed: dependencies.records.decisions.some((record) => {
        const value = record as { capability: string; scope: unknown }
        return value.capability === request.capability && JSON.stringify(value.scope) === JSON.stringify(request.scope)
      }),
      requiresApproval: true,
    })
    const orchestrator = new AgentOrchestrator(dependencies)
    const first = await orchestrator.run(textRunInput({ conversationId: 'c', content: '搜索', provider: 'openrouter', model: 'm' }))

    const second = await orchestrator.resumeApproval(firstDecision === 'always' ? {
      executionId: first.executionId!, permissionIndex: 0, scopeHash: scopeHash(workflow.permissions[0]!.scope),
      decision: 'always', workflowId: workflow.id, workflowVersion: workflow.version,
      capability: workflow.permissions[0]!.capability, scope: workflow.permissions[0]!.scope,
    } : {
      executionId: first.executionId!, permissionIndex: 0, scopeHash: scopeHash(workflow.permissions[0]!.scope), decision: 'once',
    })

    expect(second).toMatchObject({ status: 'awaiting_approval', executionId: first.executionId })
    expect(dependencies.records.starts).toHaveLength(0)
    const approvals = dependencies.records.events
      .map((event) => (event as { block?: unknown }).block)
      .filter((block): block is { type: string; permissionIndex: number; scopeHash: string; capability: string } => Boolean(block) && (block as { type?: string }).type === 'approval')
    expect(approvals.map((block) => block.permissionIndex)).toEqual([0, 1])
    expect(approvals.map((block) => block.capability)).toEqual(['browser.open', 'browser.fill'])
    if (firstDecision === 'always') {
      expect(dependencies.records.decisions[0]).toMatchObject({
        workflowId: workflow.id,
        workflowVersion: workflow.version,
        capability: workflow.permissions[0]!.capability,
        scope: workflow.permissions[0]!.scope,
      })
    }

    const stale = await orchestrator.resumeApproval({
      executionId: first.executionId!, permissionIndex: 0, scopeHash: scopeHash(workflow.permissions[0]!.scope), decision: 'once',
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
      conversationId: 'conversation_1',
      content: '描述图片',
      userBlocks: [{ type: 'text', text: '描述图片' }],
      modelContent: [
        { type: 'text', text: '描述图片' },
        { type: 'media', kind: 'image', mimeType: 'image/png', dataBase64: 'AQID' },
      ],
      assetIds: [],
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
    const dependencies = harness([toolTurn, [
      { type: 'text_delta', choiceIndex: 0, text: '完成' },
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ]])
    dependencies.executions.startReserved = async (reserved, input) => {
      dependencies.records.starts.push({ ...input, executionId: reserved.executionId })
      return {
        id: reserved.executionId,
        finished: new Promise((resolve) => { finishExecution = resolve }),
      }
    }
    const orchestrator = new AgentOrchestrator(dependencies)
    const pending = await orchestrator.run(textRunInput({ conversationId: 'c', content: '搜索', provider: 'openrouter', model: 'm' }))

    const first = orchestrator.resumeApproval({ executionId: pending.executionId!, ...approvalIdentity, decision: 'once' })
    const second = await orchestrator.resumeApproval({ executionId: pending.executionId!, ...approvalIdentity, decision: 'once' })
    expect(second).toMatchObject({ status: 'failed', error: { code: 'CONFLICT' } })
    expect(dependencies.records.starts).toHaveLength(1)

    finishExecution({ id: pending.executionId!, status: 'completed', result: { ok: true } })
    await expect(first).resolves.toMatchObject({ status: 'completed' })
    expect(dependencies.records.terminal).toHaveLength(1)
  })
})
