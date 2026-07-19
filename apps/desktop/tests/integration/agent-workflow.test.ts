import { describe, expect, it } from 'vitest'
import { AgentOrchestrator } from '../../electron/main/agent/agent-orchestrator.js'
import type { WorkflowDetail } from '@autoforge/shared'

describe('agent workflow integration', () => {
  it('runs a local provider through approval, execution, tool result, and final text without product-data fallback', async () => {
    const calls: unknown[] = []
    const terminals: unknown[] = []
    const workflow: WorkflowDetail = {
      id: 'browser.search.baidu', version: '1.0.0', name: '百度搜索', description: '搜索网页', author: 'AutoForge', category: 'search',
      enabled: true, source: 'installed', integrity: 'valid', updatedAt: new Date(0).toISOString(), timeoutMs: 30_000,
      permissions: [{ capability: 'browser.open', scope: { origins: ['https://www.baidu.com'] } }],
      activationExamples: ['百度搜索'], activationNegativeExamples: [], inputSchema: { type: 'object', required: ['keyword'], properties: { keyword: { type: 'string' } } }, outputSchema: {},
    }
    const provider = {
      async *stream(input: unknown) {
        calls.push(input)
        if (calls.length === 1) {
          yield { type: 'tool_call' as const, choiceIndex: 0, index: 0, id: 'tool_original', name: workflow.id, arguments: { keyword: '今日天气' } }
          yield { type: 'finish' as const, choiceIndex: 0, reason: 'tool_calls' }
        } else {
          yield { type: 'text_delta' as const, choiceIndex: 0, text: '真实执行完成' }
          yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
        }
      },
    }
    const orchestrator = new AgentOrchestrator({
      provider, workflows: { list: async () => [workflow] }, retrieve: () => [workflow],
      policy: { evaluate: () => ({ allowed: false, requiresApproval: true }), record: (value) => value as never, releaseExecution() {} },
      executions: { start: async (input) => ({ id: input.executionId, finished: Promise.resolve({ id: input.executionId, status: 'completed', result: { title: '结果' } }) }), async cancel() {} },
      persistence: { persistUser() {}, createRun() {}, createAssistant() {}, updateAssistant: (_id, blocks) => ({ blocks }), finalize: (value) => { terminals.push(value) } },
      emit() {}, id: (() => { let n = 0; return () => `integration_${++n}` })(), now: () => 1,
    })

    const pending = await orchestrator.run({ conversationId: 'conversation', content: '百度搜索', model: 'local-test-provider' })
    const result = await orchestrator.resumeApproval({ executionId: pending.executionId!, decision: 'once' })

    expect(result).toMatchObject({ status: 'completed' })
    expect(JSON.stringify(calls[1])).toContain('"tool_call_id":"tool_original"')
    expect(terminals).toHaveLength(1)
  })
})
