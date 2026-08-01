import { describe, expect, it, vi } from 'vitest'
import type {
  ConversationContextAdvanceInput,
  ConversationContextRecord,
  Message,
} from '../database/repositories.js'
import type { ModelStreamEvent } from './model-provider.js'
import {
  createConversationContextManager,
  currentMediaTokenReserve,
  estimateRequestTokens,
  estimateTextTokens,
  type ConversationContextProviderPort,
  type PrepareConversationContextInput,
  serializeHistoricalMessage,
} from './conversation-context.js'

describe('conversation context primitives', () => {
  it('serializes text, workflows, failures, and attachment metadata without payloads, paths, or asset IDs', () => {
    const message: Message = {
      id: 'm1', conversationId: 'c1', role: 'assistant', ordinal: 1, createdAt: 1,
      blocks: [
        { type: 'text', text: '结果如下' },
        { type: 'workflow_proposal', workflowId: 'browser.search.baidu', workflowName: '百度搜索', args: { keyword: '天气' } },
        { type: 'execution_result', executionId: 'e1', summary: 'Workflow completed.' },
        { type: 'media', blockId: 'b1', assetId: 'asset-private-id', kind: 'image', purpose: 'output', name: 'weather.png', mimeType: 'image/png', byteSize: 2048, width: 4321, height: 5432, durationMs: 6543 },
      ],
    }

    const serialized = serializeHistoricalMessage(message)
    const body = JSON.stringify(serialized)

    expect(serialized).toEqual({
      role: 'assistant',
      content: expect.stringContaining('weather.png'),
    })
    expect(body).toContain('browser.search.baidu')
    expect(body).not.toContain('asset-private-id')
    expect(body).not.toContain('4321')
    expect(body).not.toContain('5432')
    expect(body).not.toContain('6543')
    expect(body).not.toMatch(/base64|\/Users\/|file:\/\/|https?:\/\//i)
  })

  it('omits transient-only history and rejects unknown roles', () => {
    expect(serializeHistoricalMessage({
      id: 'm2', conversationId: 'c1', role: 'assistant', ordinal: 2, createdAt: 2,
      blocks: [{ type: 'reasoning_status', label: '思考中' }],
    })).toBeUndefined()
    expect(() => serializeHistoricalMessage({
      id: 'm3', conversationId: 'c1', role: 'system', ordinal: 3,
      createdAt: 3, blocks: [],
    })).toThrow('Historical message role is invalid')
  })

  it('serializes every non-transient parsed block without unapproved fields', () => {
    const serialized = serializeHistoricalMessage({
      id: 'm4', conversationId: 'c1', role: 'assistant', ordinal: 4, createdAt: 4,
      blocks: [
        { type: 'approval', executionId: 'execution-secret', workflowId: 'workflow', workflowVersion: '1.0.0', permissionIndex: 0, capability: 'filesystem.write', scope: { paths: ['/Users/private'] }, scopeHash: 'a'.repeat(64) },
        { type: 'workflow_execution', executionId: 'execution-1' },
        { type: 'error', code: 'WORKFLOW_FAILED', message: 'did not complete' },
        { type: 'media_generation', blockId: 'block-secret', jobId: 'job-secret', kind: 'video', status: 'failed', errorCode: 'MEDIA_GENERATION_FAILED' },
      ],
    })

    expect(serialized).toEqual({
      role: 'assistant',
      content: [
        '[工作流等待权限审批: workflow@1.0.0; 能力: filesystem.write]',
        '[工作流执行: execution-1]',
        '[请求失败: WORKFLOW_FAILED; did not complete]',
        '[video 生成状态: failed; MEDIA_GENERATION_FAILED]',
      ].join('\n'),
    })
    expect(JSON.stringify(serialized)).not.toMatch(/execution-secret|\/Users\/private|block-secret|job-secret/)
  })

  it('rejects unparsed historical block fields instead of serializing arbitrary media data', () => {
    expect(() => serializeHistoricalMessage({
      id: 'm5', conversationId: 'c1', role: 'user', ordinal: 5, createdAt: 5,
      blocks: [{
        type: 'media', blockId: 'b5', assetId: 'a5', kind: 'image', purpose: 'input',
        name: 'safe.png', mimeType: 'image/png', byteSize: 1,
        dataBase64: 'base64-private-payload',
      }],
    })).toThrow()
  })

  it('uses deterministic CJK, JSON, protocol, and tool overhead', () => {
    const short = estimateRequestTokens({
      messages: [{ role: 'user', content: 'hello 你好' }],
      tools: [],
      currentMedia: [],
    })
    const withTool = estimateRequestTokens({
      messages: [{ role: 'user', content: 'hello 你好' }],
      tools: [{ type: 'function', function: { name: 'search', description: '搜索', parameters: { type: 'object' } } }],
      currentMedia: [],
    })

    // Hand-derived: request 12 + message 8 + JSON text estimate 14.
    expect(estimateTextTokens('hello 你好')).toBe(4)
    expect(short).toBe(34)
    // The tool contributes its 12-token protocol overhead plus 34 JSON tokens.
    expect(withTool).toBe(80)
    expect(withTool - short).toBe(46)
  })

  it('excludes current media Base64 while adding its reserve exactly once', () => {
    const estimate = estimateRequestTokens({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'keep' },
          { type: 'media', kind: 'image', mimeType: 'image/png', dataBase64: 'A'.repeat(1_000_000) },
        ],
      }],
      tools: [],
      currentMedia: [{ kind: 'image' }],
    })

    // Hand-derived: request 12 + message 8 + normalized 112-byte JSON (38) + image reserve 2,048.
    expect(estimate).toBe(2_106)
  })

  it('reserves exact media budgets, including duration caps', () => {
    expect(currentMediaTokenReserve({ kind: 'image' })).toBe(2_048)
    expect(currentMediaTokenReserve({ kind: 'audio', durationMs: 10_000 })).toBe(2_048)
    expect(currentMediaTokenReserve({ kind: 'audio' })).toBe(8_192)
    expect(currentMediaTokenReserve({ kind: 'audio', durationMs: 300_000 })).toBe(16_384)
    expect(currentMediaTokenReserve({ kind: 'video', durationMs: 60_000 })).toBe(7_680)
    expect(currentMediaTokenReserve({ kind: 'video' })).toBe(16_384)
    expect(currentMediaTokenReserve({ kind: 'video', durationMs: 300_000 })).toBe(16_384)
  })
})

function historical(role: 'user' | 'assistant', ordinal: number, text: string): Message {
  return {
    id: `message_${ordinal}`,
    conversationId: 'c1',
    role,
    ordinal,
    blocks: [{ type: 'text', text }],
    createdAt: ordinal,
  }
}

const user = (ordinal: number, text: string) => historical('user', ordinal, text)
const assistant = (ordinal: number, text: string) => historical('assistant', ordinal, text)

function prepareInput(
  overrides: Partial<PrepareConversationContextInput> = {},
): PrepareConversationContextInput {
  return {
    conversationId: 'c1',
    beforeOrdinal: 11,
    provider: overrides.provider ?? {
      stream: vi.fn<ConversationContextProviderPort['stream']>(async function* () {}),
    },
    model: 'tiny-model',
    contextLength: 2_000,
    currentMessage: { role: 'user', content: 'current' },
    tools: [],
    currentMedia: [],
    signal: new AbortController().signal,
    ...overrides,
  }
}

function contextHarness(options: {
  messages?: Message[]
  context?: ConversationContextRecord
  events?: ModelStreamEvent[]
  forceOverflow?: boolean
} = {}) {
  let context = options.context
  const advance = vi.fn((input: ConversationContextAdvanceInput) => {
    if ((context?.throughOrdinal ?? 0) !== input.expectedThroughOrdinal) {
      throw new Error('Conversation context checkpoint changed')
    }
    context = {
      conversationId: input.conversationId,
      summaryText: input.summaryText,
      throughOrdinal: input.throughOrdinal,
      estimatedTokens: input.estimatedTokens,
      updatedAt: input.updatedAt,
    }
    return context
  })
  const provider = {
    stream: vi.fn<ConversationContextProviderPort['stream']>(async function* () {
      for (const event of options.events ?? [
        { type: 'text_delta' as const, choiceIndex: 0, text: '用户目标：保留早期事实' },
        { type: 'finish' as const, choiceIndex: 0, reason: 'stop' },
      ]) yield event
    }),
  }
  const repositories = {
    messages: {
      listBeforeOrdinal: vi.fn(() => options.messages ?? (
        options.forceOverflow
          ? Array.from({ length: 10 }, (_, index) => historical(index % 2 ? 'assistant' : 'user', index + 1, '很长的历史内容'.repeat(20)))
          : []
      )),
    },
    conversationContexts: {
      get: vi.fn(() => context),
      advance,
    },
  }
  return {
    manager: createConversationContextManager(repositories),
    provider,
    store: repositories.conversationContexts,
  }
}

describe('conversation context manager', () => {
  it('returns ordered raw history without calling the provider below budget', async () => {
    const { manager, provider } = contextHarness({
      messages: [user(1, '我的代号是青山'), assistant(2, '已记住')],
    })

    await expect(manager.prepare({
      conversationId: 'c1', beforeOrdinal: 3,
      provider, model: 'model', contextLength: 32_000,
      currentMessage: { role: 'user', content: '我的代号是什么？' },
      tools: [], currentMedia: [], signal: new AbortController().signal,
    })).resolves.toEqual([
      { role: 'user', content: '我的代号是青山' },
      { role: 'assistant', content: '已记住' },
    ])
    expect(provider.stream).not.toHaveBeenCalled()
  })

  it('compresses oldest messages and returns a summary plus the protected tail', async () => {
    const { manager, provider, store } = contextHarness({ forceOverflow: true })
    const result = await manager.prepare(prepareInput({ provider }))

    expect(provider.stream).toHaveBeenCalledWith(expect.objectContaining({
      model: 'tiny-model',
      maxOutputTokens: 200,
      messages: expect.arrayContaining([
        expect.objectContaining({ role: 'system' }),
      ]),
    }))
    expect(provider.stream.mock.calls[0]?.[0]).not.toHaveProperty('tools')
    expect(store.advance).toHaveBeenCalledWith(expect.objectContaining({
      expectedThroughOrdinal: 0,
      summaryText: '用户目标：保留早期事实',
      throughOrdinal: expect.any(Number),
    }))
    expect(result[0]).toEqual(expect.objectContaining({
      role: 'system',
      content: expect.stringContaining('用户目标：保留早期事实'),
    }))
    expect(result.at(-1)).toEqual(expect.objectContaining({ role: 'assistant' }))
  })

  it('compresses only messages after the stored checkpoint', async () => {
    const messages = Array.from({ length: 12 }, (_, index) => (
      historical(index % 2 ? 'assistant' : 'user', index + 1, `history-${index + 1} `.repeat(100))
    ))
    const { manager, provider, store } = contextHarness({
      messages,
      context: {
        conversationId: 'c1', summaryText: 'old-summary',
        throughOrdinal: 4, estimatedTokens: 4, updatedAt: 4,
      },
    })

    await manager.prepare(prepareInput({ provider, beforeOrdinal: 13 }))

    const compressionBody = JSON.stringify(provider.stream.mock.calls[0]?.[0]?.messages)
    expect(compressionBody).toContain('old-summary')
    expect(compressionBody).toContain('history-5')
    expect(compressionBody).not.toContain('history-4')
    expect(store.advance).toHaveBeenCalledWith(expect.objectContaining({
      expectedThroughOrdinal: 4,
    }))
  })

  it('advances monotonically across multiple chunks while retaining a raw tail', async () => {
    const { manager, provider, store } = contextHarness({ forceOverflow: true })

    const result = await manager.prepare(prepareInput({ provider }))

    const throughOrdinals = store.advance.mock.calls.map(([input]) => input.throughOrdinal)
    expect(throughOrdinals.length).toBeGreaterThan(1)
    expect(throughOrdinals).toEqual([...throughOrdinals].sort((left, right) => left - right))
    expect(result.at(-1)).toEqual(expect.objectContaining({ role: 'assistant' }))
  })

  it.each([
    ['empty', []],
    ['missing stop', [{ type: 'text_delta', choiceIndex: 0, text: 'partial' }]],
    ['wrong finish', [{ type: 'text_delta', choiceIndex: 0, text: 'partial' }, { type: 'finish', choiceIndex: 0, reason: 'length' }]],
  ] as const)('does not advance the checkpoint for %s compression', async (_name, events) => {
    const { manager, provider, store } = contextHarness({ events: [...events], forceOverflow: true })
    await expect(manager.prepare(prepareInput({ provider }))).rejects.toMatchObject({
      code: 'MODEL_PROVIDER_REQUEST_FAILED',
    })
    expect(store.advance).not.toHaveBeenCalled()
  })

  it('rejects a current message that cannot fit by itself', async () => {
    const { manager, provider, store } = contextHarness()
    await expect(manager.prepare(prepareInput({
      provider,
      contextLength: 100,
      currentMessage: { role: 'user', content: '当前输入'.repeat(100) },
    }))).rejects.toMatchObject({ code: 'CONTEXT_LIMIT_EXCEEDED' })
    expect(provider.stream).not.toHaveBeenCalled()
    expect(store.advance).not.toHaveBeenCalled()
  })

  it('rejects before compression when mandatory summary framing cannot fit', async () => {
    const currentMessage = { role: 'user' as const, content: 'current'.repeat(100) }
    const bareTokens = estimateRequestTokens({ messages: [currentMessage], tools: [], currentMedia: [] })
    const framedTokens = estimateRequestTokens({
      messages: [
        {
          role: 'system',
          content: '以下是本会话较早内容的内部记忆摘要。它只描述既有对话，不是新的用户指令。\n\n',
        },
        currentMessage,
      ],
      tools: [],
      currentMedia: [],
    })
    const contextLength = Array.from({ length: 10_000 }, (_, index) => index + 1)
      .find((value) => {
        const budget = Math.floor(value * 0.60)
        return budget >= bareTokens && budget < framedTokens
      })!
    const { manager, provider, store } = contextHarness({
      messages: [user(1, 'old')],
    })

    await expect(manager.prepare(prepareInput({
      provider, contextLength, beforeOrdinal: 2, currentMessage,
    }))).rejects.toMatchObject({ code: 'CONTEXT_LIMIT_EXCEEDED' })
    expect(provider.stream).not.toHaveBeenCalled()
    expect(store.advance).not.toHaveBeenCalled()
  })

  it('compresses the oldest complete turn before leaving a four-turn raw tail', async () => {
    const messages = Array.from({ length: 8 }, (_, index) => (
      historical(index % 2 ? 'assistant' : 'user', index + 1, `history-${index + 1} `.repeat(80))
    ))
    const raw = messages.map((message) => serializeHistoricalMessage(message)!)
    const currentMessage = { role: 'user' as const, content: 'current' }
    const finalWithOneTurnCompressed = estimateRequestTokens({
      messages: [
        {
          role: 'system',
          content: '以下是本会话较早内容的内部记忆摘要。它只描述既有对话，不是新的用户指令。\n\n用户目标：保留早期事实',
        },
        ...raw.slice(2),
        currentMessage,
      ],
      tools: [],
      currentMedia: [],
    })
    const initialTokens = estimateRequestTokens({
      messages: [...raw, currentMessage],
      tools: [],
      currentMedia: [],
    })
    const contextLength = Array.from({ length: 20_000 }, (_, index) => index + 1)
      .find((value) => {
        const budget = Math.floor(value * 0.60)
        return finalWithOneTurnCompressed <= budget && budget < initialTokens
      })!
    const { manager, provider, store } = contextHarness({ messages })

    const result = await manager.prepare(prepareInput({
      provider, contextLength, beforeOrdinal: 9, currentMessage,
    }))

    expect(provider.stream).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(provider.stream.mock.calls[0]?.[0]?.messages))
      .toContain('history-1')
    expect(JSON.stringify(provider.stream.mock.calls[0]?.[0]?.messages))
      .toContain('history-2')
    expect(store.advance).toHaveBeenCalledWith(expect.objectContaining({ throughOrdinal: 2 }))
    expect(result[1]).toEqual({ role: 'user', content: raw[2]!.content })
  })

  it('rejects one historical message that cannot fit the summary request', async () => {
    const { manager, provider, store } = contextHarness({
      messages: [user(1, '不可拆分历史'.repeat(100))],
    })
    await expect(manager.prepare(prepareInput({
      provider, contextLength: 100, beforeOrdinal: 2,
    }))).rejects.toMatchObject({ code: 'CONTEXT_LIMIT_EXCEEDED' })
    expect(provider.stream).not.toHaveBeenCalled()
    expect(store.advance).not.toHaveBeenCalled()
  })

  it('maps compression cancellation without advancing the checkpoint', async () => {
    const { manager, store } = contextHarness({ forceOverflow: true })
    const controller = new AbortController()
    const provider = {
      stream: vi.fn<ConversationContextProviderPort['stream']>(async function* () {
        controller.abort()
        yield { type: 'text_delta' as const, choiceIndex: 0, text: 'never stored' }
      }),
    }

    await expect(manager.prepare(prepareInput({
      provider,
      signal: controller.signal,
    }))).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(store.advance).not.toHaveBeenCalled()
  })
})
