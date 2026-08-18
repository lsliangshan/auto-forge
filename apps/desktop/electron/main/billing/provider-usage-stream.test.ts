import { describe, expect, it, vi } from 'vitest'
import {
  ProviderUsageConsistencyError,
  type ProviderUsageRepository,
} from '../database/repositories.js'
import type {
  ModelProviderSnapshot,
  ModelStreamEvent,
} from '../chat/model-provider.js'
import { trackProviderStream } from './provider-usage-stream.js'

async function* events(values: readonly ModelStreamEvent[]): AsyncIterable<ModelStreamEvent> {
  for (const value of values) yield value
}

async function collect(values: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const result: ModelStreamEvent[] = []
  for await (const value of values) result.push(value)
  return result
}

function harness(values: readonly ModelStreamEvent[], streamError?: unknown) {
  const order: string[] = []
  const providerUsage = {
    start: vi.fn((input) => { order.push('start'); return input as never }),
    bindIdentity: vi.fn((_key, input) => { order.push('bind'); return input as never }),
    report: vi.fn((_key, input) => { order.push('report'); return input as never }),
    markUnknown: vi.fn((key) => { order.push('unknown'); return key as never }),
  } satisfies Pick<ProviderUsageRepository, 'start' | 'bindIdentity' | 'report' | 'markUnknown'>
  const stream = vi.fn(async function* () {
    order.push('stream')
    yield* events(values)
    if (streamError !== undefined) throw streamError
  })
  const provider: ModelProviderSnapshot = {
    providerId: 'openrouter',
    apiKeyFingerprint: 'fingerprint_1',
    provider: {
      listModels: async () => [],
      validateCredential: async () => ({ valid: true }),
      stream,
    },
  }
  const tracked = trackProviderStream({
    operationKey: 'operation_1',
    attribution: {
      userId: 'user_1', requestId: 'request_1', chatRunId: 'run_1',
      model: 'openrouter/model', modality: 'text',
    },
    request: { model: 'openrouter/model', messages: [] },
    provider,
    providerUsage,
    id: () => 'usage_1',
    now: () => 100,
  })
  return { order, providerUsage, stream, tracked }
}

describe('trackProviderStream', () => {
  it('starts before streaming, binds generation, and reports the first exact cost once', async () => {
    const usage = { type: 'usage', inputTokens: 2, outputTokens: 3, totalTokens: 5, costUsd: '0.000000000009' } as const
    const test = harness([
      { type: 'generation', id: 'generation_1' },
      usage,
      { ...usage, costUsd: '999' },
    ])

    await expect(collect(test.tracked)).resolves.toHaveLength(3)

    expect(test.order).toEqual(['start', 'stream', 'bind', 'report'])
    expect(test.providerUsage.start).toHaveBeenCalledWith({
      id: 'usage_1', operationKey: 'operation_1', userId: 'user_1',
      provider: 'openrouter', apiKeyFingerprint: 'fingerprint_1',
      requestId: 'request_1', chatRunId: 'run_1', model: 'openrouter/model',
      modality: 'text', startedAt: 100,
    })
    expect(test.providerUsage.bindIdentity).toHaveBeenCalledWith(
      'operation_1', { generationId: 'generation_1' },
    )
    expect(test.providerUsage.report).toHaveBeenCalledTimes(1)
    expect(test.providerUsage.report).toHaveBeenCalledWith('operation_1', {
      generationId: 'generation_1', inputTokens: 2, outputTokens: 3,
      costUsd: '0.000000000009', endedAt: 100,
    })
    expect(test.providerUsage.markUnknown).not.toHaveBeenCalled()
  })

  it('marks missing cost unknown while preserving its generation identity', async () => {
    const test = harness([
      { type: 'generation', id: 'generation_unknown' },
      { type: 'usage', inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    ])

    await collect(test.tracked)

    expect(test.providerUsage.bindIdentity).toHaveBeenCalledWith(
      'operation_1', { generationId: 'generation_unknown' },
    )
    expect(test.providerUsage.report).not.toHaveBeenCalled()
    expect(test.providerUsage.markUnknown).toHaveBeenCalledWith('operation_1', 100)
  })

  it('keeps a reported cost when the provider later fails locally', async () => {
    const failure = new Error('local stream failure')
    const test = harness([
      { type: 'usage', inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: '0.04' },
    ], failure)

    await expect(collect(test.tracked)).rejects.toBe(failure)
    expect(test.providerUsage.report).toHaveBeenCalledTimes(1)
    expect(test.providerUsage.markUnknown).not.toHaveBeenCalled()
  })

  it('marks the operation unknown when the provider fails before reporting cost', async () => {
    const failure = new Error('upstream closed')
    const test = harness([{ type: 'generation', id: 'generation_failed' }], failure)

    await expect(collect(test.tracked)).rejects.toBe(failure)
    expect(test.providerUsage.bindIdentity).toHaveBeenCalledTimes(1)
    expect(test.providerUsage.markUnknown).toHaveBeenCalledWith('operation_1', 100)
  })

  it('marks the operation unknown when a consumer returns early', async () => {
    const test = harness([
      { type: 'generation', id: 'generation_early' },
      { type: 'usage', inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: '0.08' },
    ])

    for await (const event of test.tracked) {
      expect(event).toEqual({ type: 'generation', id: 'generation_early' })
      break
    }

    expect(test.providerUsage.bindIdentity).toHaveBeenCalledTimes(1)
    expect(test.providerUsage.report).not.toHaveBeenCalled()
    expect(test.providerUsage.markUnknown).toHaveBeenCalledWith('operation_1', 100)
  })

  it.each(['start', 'bindIdentity', 'report', 'markUnknown'] as const)(
    'propagates a %s consistency error directly',
    async (method) => {
      const values: ModelStreamEvent[] = method === 'markUnknown'
        ? []
        : method === 'bindIdentity'
          ? [{ type: 'generation', id: 'generation_conflict' }]
          : [{ type: 'usage', inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: '0.01' }]
      const test = harness(values)
      const error = new ProviderUsageConsistencyError()
      vi.mocked(test.providerUsage[method]).mockImplementation(() => { throw error })

      await expect(collect(test.tracked)).rejects.toBe(error)
    },
  )

  it('does not create a ledger event for a DeepSeek snapshot or serialize end-user data itself', async () => {
    const test = harness([{ type: 'finish', choiceIndex: 0, reason: 'stop' }])
    const deepSeek: ModelProviderSnapshot = {
      providerId: 'deepseek',
      provider: {
        listModels: async () => [], validateCredential: async () => ({ valid: true }),
        stream: test.stream,
      },
    }
    const request = { model: 'deepseek-chat', messages: [], endUserId: 'user_1' }

    await collect(trackProviderStream({
      operationKey: 'deepseek_1',
      attribution: { userId: 'user_1', requestId: 'request_1', model: 'deepseek-chat', modality: 'text' },
      request,
      provider: deepSeek,
      providerUsage: test.providerUsage,
      id: () => 'usage_2', now: () => 100,
    }))

    expect(test.providerUsage.start).not.toHaveBeenCalled()
    expect(test.stream).toHaveBeenCalledWith(request)
  })
})
