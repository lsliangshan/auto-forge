import { describe, expect, it } from 'vitest'
import type { WorkflowDetail } from '@autoforge/shared'
import {
  AgentOrchestrator,
  type AgentOrchestratorDependencies,
  type ProviderStreamEvent,
} from './agent-orchestrator.js'

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
  records: { users: unknown[]; starts: unknown[]; decisions: unknown[]; events: unknown[]; terminal: unknown[] }
} {
  const records = { users: [] as unknown[], starts: [] as unknown[], decisions: [] as unknown[], events: [] as unknown[], terminal: [] as unknown[] }
  const messages = new Map<string, { blocks: unknown[] }>()
  return {
    records,
    provider: { stream: () => events(turns.shift() ?? []) },
    workflows: { list: async () => [workflow] },
    retrieve: () => [workflow],
    policy: {
      evaluate: () => ({ allowed: false, requiresApproval: true }),
      record: (value) => { records.decisions.push(value); return value as never },
      releaseExecution: () => undefined,
    },
    executions: {
      start: async (input) => {
        records.starts.push(input)
        return { id: input.executionId, finished: Promise.resolve({ id: input.executionId, status: 'completed', result: { title: '天气' } }) }
      },
      cancel: async () => undefined,
    },
    persistence: {
      persistUser(value) { records.users.push(value) },
      createRun() {},
      createAssistant(value) { messages.set(value.messageId, { blocks: [] }) },
      updateAssistant(messageId, blocks) { messages.set(messageId, { blocks }); return { blocks } },
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

describe('AgentOrchestrator', () => {
  it('persists the user first and pauses before starting an approval-gated workflow', async () => {
    const dependencies = harness([toolTurn])
    const orchestrator = new AgentOrchestrator(dependencies)

    const result = await orchestrator.run({ conversationId: 'conversation_1', content: '使用百度搜索今日天气', model: 'model' })

    expect(result.status).toBe('awaiting_approval')
    expect(dependencies.records.users).toHaveLength(1)
    expect(dependencies.records.starts).toHaveLength(0)
    expect(dependencies.records.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'block', block: expect.objectContaining({ type: 'workflow_proposal', workflowId: workflow.id }) }),
      expect.objectContaining({ type: 'block', block: expect.objectContaining({ type: 'approval' }) }),
    ]))
  })

  it('validates approval and tool arguments, then returns the result with the original tool call id', async () => {
    const dependencies = harness([toolTurn, [
      { type: 'text_delta', choiceIndex: 0, text: '搜索结果：天气晴' },
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ]])
    const providerInputs: unknown[] = []
    dependencies.provider.stream = (input) => { providerInputs.push(input); return events((providerInputs.length === 1 ? toolTurn : [
      { type: 'text_delta', choiceIndex: 0, text: '搜索结果：天气晴' },
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ])) }
    const orchestrator = new AgentOrchestrator(dependencies)
    const pending = await orchestrator.run({ conversationId: 'conversation_1', content: '使用百度搜索今日天气', model: 'model' })

    const done = await orchestrator.resumeApproval({ executionId: pending.executionId!, decision: 'once' })

    expect(done.status).toBe('completed')
    expect(dependencies.records.starts).toHaveLength(1)
    expect(JSON.stringify(providerInputs[1])).toContain('"tool_call_id":"call_1"')
    expect(dependencies.records.terminal.at(-1)).toMatchObject({ status: 'completed' })
  })

  it('binds always approval to the exact manifest permission and deny never starts execution', async () => {
    const mismatchDependencies = harness([toolTurn])
    const mismatchOrchestrator = new AgentOrchestrator(mismatchDependencies)
    const mismatchPending = await mismatchOrchestrator.run({ conversationId: 'c1', content: '搜索', model: 'm' })
    const mismatch = await mismatchOrchestrator.resumeApproval({
      executionId: mismatchPending.executionId!, decision: 'always', workflowId: workflow.id,
      workflowVersion: workflow.version, capability: 'browser.open', scope: { origins: ['https://example.com'] },
    })
    expect(mismatch).toMatchObject({ status: 'failed', error: { code: 'INVALID_INPUT' } })
    expect(mismatchDependencies.records.decisions).toHaveLength(0)
    expect(mismatchDependencies.records.starts).toHaveLength(0)

    const denyDependencies = harness([toolTurn])
    const denyOrchestrator = new AgentOrchestrator(denyDependencies)
    const denyPending = await denyOrchestrator.run({ conversationId: 'c2', content: '搜索', model: 'm' })
    const denied = await denyOrchestrator.resumeApproval({ executionId: denyPending.executionId!, decision: 'deny' })
    expect(denied).toMatchObject({ status: 'failed', error: { code: 'PERMISSION_DENIED' } })
    expect(denyDependencies.records.starts).toHaveLength(0)
    expect(denyDependencies.records.terminal).toHaveLength(1)
  })

  it('rejects unknown tools, invalid args, multiple active tools, and model-turn overflow', async () => {
    const unknown = harness([[{ ...toolTurn[0]!, name: 'unknown' } as ProviderStreamEvent, toolTurn[1]!]])
    await expect(new AgentOrchestrator(unknown).run({ conversationId: 'c', content: 'x', model: 'm' }))
      .resolves.toMatchObject({ status: 'failed' })

    const invalid = harness([[{ ...toolTurn[0]!, arguments: {} } as ProviderStreamEvent, toolTurn[1]!]])
    await expect(new AgentOrchestrator(invalid).run({ conversationId: 'c', content: 'x', model: 'm' }))
      .resolves.toMatchObject({ status: 'failed' })

    const multiple = harness([[toolTurn[0]!, { ...toolTurn[0]!, id: 'call_2', index: 1 } as ProviderStreamEvent, toolTurn[1]!]])
    await expect(new AgentOrchestrator(multiple).run({ conversationId: 'c', content: 'x', model: 'm' }))
      .resolves.toMatchObject({ status: 'failed' })

    const overflow = harness(Array.from({ length: 9 }, () => [{ type: 'finish', choiceIndex: 0, reason: 'length' } as ProviderStreamEvent]))
    await expect(new AgentOrchestrator(overflow).run({ conversationId: 'c', content: 'x', model: 'm' }))
      .resolves.toMatchObject({ status: 'failed' })
  })

  it('persists partial text before emitting and terminalizes when the event sink throws', async () => {
    const dependencies = harness([[
      { type: 'text_delta', choiceIndex: 0, text: '部分' },
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ]])
    const order: string[] = []
    dependencies.persistence.updateAssistant = (_id, blocks) => { order.push(`persist:${JSON.stringify(blocks)}`); return { blocks } }
    dependencies.emit = () => { order.push('emit'); throw new Error('renderer closed') }

    const result = await new AgentOrchestrator(dependencies).run({ conversationId: 'c', content: 'x', model: 'm' })

    expect(result.status).toBe('completed')
    expect(order[0]).toContain('persist')
    expect(dependencies.records.terminal).toHaveLength(1)
  })

  it('terminalizes the durable run when workflow discovery fails before the provider starts', async () => {
    const dependencies = harness([])
    dependencies.workflows.list = async () => { throw new Error('registry unavailable') }

    const result = await new AgentOrchestrator(dependencies).run({ conversationId: 'c', content: 'x', model: 'm' })

    expect(result).toMatchObject({ status: 'failed', error: { code: 'INTERNAL_ERROR' } })
    expect(dependencies.records.users).toHaveLength(1)
    expect(dependencies.records.terminal).toHaveLength(1)
  })

  it('cancels provider and execution and rejects concurrent resume races', async () => {
    let resolveExecution!: (value: { id: string; status: string }) => void
    const dependencies = harness([toolTurn])
    dependencies.policy.evaluate = () => ({ allowed: true, requiresApproval: false })
    dependencies.executions.start = async (input) => ({
      id: input.executionId,
      finished: new Promise((resolve) => { resolveExecution = resolve }),
    })
    let cancelled = false
    dependencies.executions.cancel = async () => { cancelled = true; resolveExecution({ id: 'x', status: 'cancelled' }) }
    const orchestrator = new AgentOrchestrator(dependencies)
    const running = orchestrator.run({ conversationId: 'c', content: 'x', model: 'm', requestId: 'request_1' })
    for (let index = 0; index < 20 && dependencies.records.starts.length === 0; index += 1) await Promise.resolve()

    await orchestrator.cancel('request_1')
    await expect(running).resolves.toMatchObject({ status: 'cancelled' })
    expect(cancelled).toBe(true)
    expect(dependencies.records.terminal).toHaveLength(1)
  })

  it('allows only one resume continuation for the same approval', async () => {
    let finishExecution!: (value: { id: string; status: string; result: unknown }) => void
    const dependencies = harness([toolTurn, [
      { type: 'text_delta', choiceIndex: 0, text: '完成' },
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ]])
    dependencies.executions.start = async (input) => {
      dependencies.records.starts.push(input)
      return {
        id: input.executionId,
        finished: new Promise((resolve) => { finishExecution = resolve }),
      }
    }
    const orchestrator = new AgentOrchestrator(dependencies)
    const pending = await orchestrator.run({ conversationId: 'c', content: '搜索', model: 'm' })

    const first = orchestrator.resumeApproval({ executionId: pending.executionId!, decision: 'once' })
    const second = await orchestrator.resumeApproval({ executionId: pending.executionId!, decision: 'once' })
    expect(second).toMatchObject({ status: 'failed', error: { code: 'CONFLICT' } })
    expect(dependencies.records.starts).toHaveLength(1)

    finishExecution({ id: pending.executionId!, status: 'completed', result: { ok: true } })
    await expect(first).resolves.toMatchObject({ status: 'completed' })
    expect(dependencies.records.terminal).toHaveLength(1)
  })
})
