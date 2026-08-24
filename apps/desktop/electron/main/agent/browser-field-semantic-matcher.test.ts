import { describe, expect, it, vi } from 'vitest'
import type {
  ModelProviderSnapshot,
  ModelStreamEvent,
  ModelStreamRequest,
} from '../chat/model-provider.js'
import {
  ProviderUsageConsistencyError,
  type ProviderUsageRepository,
} from '../database/repositories.js'
import { matchBrowserFieldSemantics } from './browser-field-semantic-matcher.js'

function harness(events: readonly ModelStreamEvent[], streamError?: unknown) {
  const stream = vi.fn(async function* (request: ModelStreamRequest) {
    void request
    for (const event of events) yield event
    if (streamError !== undefined) throw streamError
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
  const run = (
    trustedRequest = '我的证件号码是多少',
    signal: AbortSignal = new AbortController().signal,
  ) => matchBrowserFieldSemantics({
    trustedRequest,
    candidates: [
      { id: 'candidate_1', label: '证件编号' },
      { id: 'candidate_2', label: '证件号码' },
      { id: 'candidate_3', label: '证件类型' },
    ],
    providerSnapshot,
    providerUsage,
    model: 'deepseek/deepseek-v4',
    userId: 'user_1',
    requestId: 'request_1',
    evidenceRevision: 1,
    chatRunId: 'run_1',
    signal,
    id: () => 'usage_1',
    now: () => 100,
  })
  return { run, stream, providerUsage }
}

describe('matchBrowserFieldSemantics', () => {
  it('lets the model select the single best semantic match without receiving values', async () => {
    const usage = { type: 'usage', inputTokens: 12, outputTokens: 3, totalTokens: 15, costUsd: '0.001' } as const
    const test = harness([
      { type: 'tool_call', choiceIndex: 0, index: 0, id: 'call_1', name: 'report_browser_field_matches', arguments: { matchingCandidateIds: ['candidate_2'] } },
      { type: 'finish', choiceIndex: 0, reason: 'tool_calls' },
      usage,
    ])

    await expect(test.run()).resolves.toEqual({
      matchingCandidateIds: ['candidate_2'],
      usage,
    })
    const request = test.stream.mock.calls[0]![0]
    expect(request.messages).toHaveLength(2)
    expect(JSON.stringify(request.messages)).toContain('我的证件号码是多少')
    expect(JSON.stringify(request.messages)).toContain('证件编号')
    expect(JSON.stringify(request.messages)).toContain('证件号码')
    expect(JSON.stringify(request.messages)).toContain('证件类型')
    expect(JSON.stringify(request.messages)).not.toMatch(/202111127927|身份证/u)
    expect(request.tools).toEqual([expect.objectContaining({
      function: expect.objectContaining({
        name: 'report_browser_field_matches',
        parameters: expect.objectContaining({
          properties: expect.objectContaining({
            matchingCandidateIds: expect.objectContaining({ maxItems: 1 }),
          }),
        }),
      }),
    })])
    expect(test.providerUsage.start).toHaveBeenCalledWith(expect.objectContaining({
      operationKey: 'agent:request_1:browser-field-match:1',
    }))
  })

  it('lets the model reject a related but semantically different attribute', async () => {
    const test = harness([
      { type: 'tool_call', choiceIndex: 0, index: 0, id: 'call_1', name: 'report_browser_field_matches', arguments: { matchingCandidateIds: [] } },
      { type: 'finish', choiceIndex: 0, reason: 'tool_calls' },
    ])

    await expect(test.run('我的证件类型是什么')).resolves.toEqual({ matchingCandidateIds: [] })
  })

  it.each([
    ['unknown candidate', { matchingCandidateIds: ['candidate_missing'] }, 'tool_calls', false],
    ['duplicate candidate', { matchingCandidateIds: ['candidate_1', 'candidate_1'] }, 'tool_calls', false],
    ['multiple candidates', { matchingCandidateIds: ['candidate_1', 'candidate_2'] }, 'tool_calls', false],
    ['unknown key', { matchingCandidateIds: ['candidate_1'], explanation: 'trust me' }, 'tool_calls', false],
    ['wrong finish reason', { matchingCandidateIds: ['candidate_1'] }, 'stop', false],
    ['authoritative prose', { matchingCandidateIds: ['candidate_1'] }, 'tool_calls', true],
  ])('fails closed for %s', async (_case, args, reason, includeText) => {
    const test = harness([
      ...(includeText ? [{ type: 'text_delta', choiceIndex: 0, text: 'candidate_1' } as const] : []),
      { type: 'tool_call', choiceIndex: 0, index: 0, id: 'call_1', name: 'report_browser_field_matches', arguments: args },
      { type: 'finish', choiceIndex: 0, reason },
    ])

    await expect(test.run()).resolves.toEqual({ matchingCandidateIds: [] })
  })

  it('fails closed on ordinary provider errors but propagates billing consistency failures', async () => {
    const ordinary = harness([], new Error('provider unavailable'))
    await expect(ordinary.run()).resolves.toEqual({ matchingCandidateIds: [] })

    const consistency = harness([])
    consistency.providerUsage.start.mockImplementationOnce(() => {
      throw new ProviderUsageConsistencyError()
    })
    await expect(consistency.run()).rejects.toBeInstanceOf(ProviderUsageConsistencyError)
  })

  it('rejects multiple matcher tool calls and cancellation', async () => {
    const multiple = harness([
      { type: 'tool_call', choiceIndex: 0, index: 0, id: 'call_1', name: 'report_browser_field_matches', arguments: { matchingCandidateIds: ['candidate_1'] } },
      { type: 'tool_call', choiceIndex: 0, index: 1, id: 'call_2', name: 'report_browser_field_matches', arguments: { matchingCandidateIds: [] } },
      { type: 'finish', choiceIndex: 0, reason: 'tool_calls' },
    ])
    await expect(multiple.run()).resolves.toEqual({ matchingCandidateIds: [] })

    const cancelled = harness([])
    const controller = new AbortController()
    controller.abort()
    await expect(cancelled.run('我的证件号码是多少', controller.signal))
      .rejects.toMatchObject({ code: 'CANCELLED' })
    expect(cancelled.stream).not.toHaveBeenCalled()
  })
})
