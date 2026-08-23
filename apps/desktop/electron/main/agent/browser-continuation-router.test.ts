import { describe, expect, it, vi } from 'vitest'
import type {
  ModelProviderSnapshot,
  ModelStreamEvent,
  ModelStreamRequest,
} from '../chat/model-provider.js'
import type { ProviderUsageRepository } from '../database/repositories.js'
import { routeBrowserContinuationRequest } from './browser-continuation-router.js'

function harness(events: readonly ModelStreamEvent[]) {
  const stream = vi.fn(async function* (request: ModelStreamRequest) {
    void request
    for (const event of events) yield event
  })
  const providerSnapshot: ModelProviderSnapshot = {
    providerId: 'openrouter',
    apiKeyFingerprint: 'fingerprint_1',
    provider: {
      listModels: async () => [],
      validateCredential: async () => ({ valid: true }),
      stream,
    },
  }
  const providerUsage = {
    start: vi.fn((input) => input as never),
    bindIdentity: vi.fn((_key, input) => input as never),
    report: vi.fn((_key, input) => input as never),
    markUnknown: vi.fn((key) => key as never),
  } satisfies Pick<ProviderUsageRepository, 'start' | 'bindIdentity' | 'report' | 'markUnknown'>
  const run = (trustedRequest = '我的证件号码是？') => routeBrowserContinuationRequest({
    trustedRequest,
    candidates: [
      {
        bindingId: 'binding_1', workflowLabel: '办事帮助', pageLabel: '帮助中心',
        origin: 'https://help.example.gov.cn',
      },
      {
        bindingId: 'binding_2', workflowLabel: '证件查询', pageLabel: '证件详情',
        origin: 'https://permit.example.gov.cn',
      },
    ],
    providerSnapshot,
    providerUsage,
    model: 'deepseek/deepseek-v4',
    userId: 'user_1',
    requestId: 'request_1',
    chatRunId: 'run_1',
    signal: new AbortController().signal,
    id: () => 'usage_1',
    now: () => 100,
  })
  return { run, stream }
}

describe('routeBrowserContinuationRequest', () => {
  it('selects the single bound page whose purpose can answer the request', async () => {
    const test = harness([
      {
        type: 'tool_call', choiceIndex: 0, index: 0, id: 'call_1',
        name: 'report_browser_continuation_route', arguments: { bindingId: 'binding_2' },
      },
      { type: 'finish', choiceIndex: 0, reason: 'tool_calls' },
    ])

    await expect(test.run()).resolves.toEqual({ bindingId: 'binding_2' })
    const request = test.stream.mock.calls[0]![0]
    expect(JSON.stringify(request.messages)).toContain('我的证件号码是？')
    expect(JSON.stringify(request.messages)).toContain('证件详情')
    expect(JSON.stringify(request.messages)).not.toContain('430722******8715')
  })

  it('returns no route when the request does not require any bound page', async () => {
    const test = harness([
      {
        type: 'tool_call', choiceIndex: 0, index: 0, id: 'call_1',
        name: 'report_browser_continuation_route', arguments: { bindingId: null },
      },
      { type: 'finish', choiceIndex: 0, reason: 'tool_calls' },
    ])

    await expect(test.run('什么是二进制？')).resolves.toEqual({ bindingId: null })
  })

  it.each([
    ['unknown binding', { bindingId: 'binding_missing' }, 'tool_calls', false],
    ['unknown key', { bindingId: 'binding_2', explanation: 'trust me' }, 'tool_calls', false],
    ['wrong finish reason', { bindingId: 'binding_2' }, 'stop', false],
    ['ordinary text', { bindingId: 'binding_2' }, 'tool_calls', true],
  ])('fails closed for %s', async (_case, argumentsValue, finishReason, includeText) => {
    const test = harness([
      ...(includeText ? [{ type: 'text_delta', choiceIndex: 0, text: 'binding_2' } as const] : []),
      {
        type: 'tool_call', choiceIndex: 0, index: 0, id: 'call_1',
        name: 'report_browser_continuation_route', arguments: argumentsValue,
      },
      { type: 'finish', choiceIndex: 0, reason: finishReason },
    ])

    await expect(test.run()).resolves.toEqual({ bindingId: null })
  })
})
