import { describe, expect, it, vi } from 'vitest'
import { openAppDatabase } from '../database/client.js'
import { DeepSeekProvider } from './deepseek-provider.js'
import type {
  ConversationContextAdvanceInput,
  ConversationContextRecord,
  Message,
} from '../database/repositories.js'
import { ProviderUsageConsistencyError } from '../database/repositories.js'
import type { ModelProviderSnapshot, ModelStreamEvent } from './model-provider.js'
import {
  createConversationContextManager,
  currentMediaTokenReserve,
  estimateRequestTokens,
  estimateTextTokens,
  resolveChatInputBudget,
  type ConversationContextProviderPort,
  type PrepareConversationContextInput,
  serializeHistoricalMessage,
} from './conversation-context.js'

describe('conversation context primitives', () => {
  it('uses 60 percent of a positive context length and the 32000 fallback otherwise', () => {
    expect(resolveChatInputBudget(100_000)).toBe(60_000)
    expect(resolveChatInputBudget(0)).toBe(19_200)
    expect(resolveChatInputBudget(undefined)).toBe(19_200)
  })

  it('serializes text, workflows, failures, and attachment metadata without payloads, paths, or asset IDs', () => {
    const message: Message = {
      id: 'm1', conversationId: 'c1', role: 'assistant', ordinal: 1, createdAt: 1,
      blocks: [
        { type: 'text', text: '结果如下' },
        { type: 'workflow_proposal', workflowId: 'browser.search.baidu', workflowName: '百度搜索', args: { path: '/Users/private/query.json' } },
        { type: 'execution_result', executionId: 'e1', summary: 'Raw result at /Users/private/result.json' },
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

  it('serializes workflow status and provenance without build, input, result, path, or scope data', () => {
    const serialized = serializeHistoricalMessage({
      id: 'workflow_message', conversationId: 'c1', role: 'assistant', ordinal: 2, createdAt: 2,
      blocks: [
        {
          type: 'workflow_status', blockId: 'status_1', executionId: 'execution_1',
          workflowId: 'workflow.secret', workflowName: '安全查询', workflowVersion: '1.2.3',
          source: 'development', buildHash: 'a'.repeat(64), city: '北京', status: 'completed',
          executionAvailable: true, executionIndex: 1, executionLimit: 5,
          errorCode: 'RESULT_TOO_LARGE', errorSummary: 'The workflow result is too large.',
        },
        {
          type: 'workflow_provenance', blockId: 'provenance_1', entries: [{
            executionId: 'execution_1', workflowId: 'workflow.secret', workflowName: '安全查询',
            workflowVersion: '1.2.3', source: 'development', buildHash: 'a'.repeat(64),
            city: '北京', status: 'completed',
          }],
        },
      ],
    })

    expect(serialized).toEqual({
      role: 'assistant',
      content: [
        '[工作流: 安全查询; 城市: 北京; 状态: completed]',
        '[已使用工作流: 安全查询; 城市: 北京; 状态: completed]',
      ].join('\n'),
    })
    expect(serialized?.content).not.toContain('RESULT_TOO_LARGE')
    expect(serialized?.content).not.toContain('The workflow result is too large.')
    expect(JSON.stringify(serialized)).not.toMatch(/a{64}|execution_1|workflow\.secret|1\.2\.3|input|result|path|scope/i)
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
        { type: 'approval', blockId: 'approval-secret', state: 'denied', executionId: 'execution-secret', workflowId: 'workflow', workflowName: '工作流', workflowVersion: '1.0.0', source: 'installed', actionSummary: '写入文件', permissionIndex: 0, capability: 'filesystem.write', scope: { paths: ['/Users/private'] }, scopeHash: 'a'.repeat(64) },
        { type: 'workflow_execution', executionId: 'execution-1' },
        { type: 'error', code: 'WORKFLOW_FAILED', message: 'did not complete' },
        { type: 'media_generation', blockId: 'block-secret', jobId: 'job-secret', kind: 'video', status: 'failed', errorCode: 'MEDIA_GENERATION_FAILED' },
      ],
    })

    expect(serialized).toEqual({
      role: 'assistant',
      content: [
        '[工作流权限审批状态: denied; workflow@1.0.0; 能力: filesystem.write]',
        '[工作流执行: execution-1]',
        '[请求失败: WORKFLOW_FAILED; did not complete]',
        '[video 生成状态: failed; MEDIA_GENERATION_FAILED]',
      ].join('\n'),
    })
    expect(JSON.stringify(serialized)).not.toMatch(/execution-secret|approval-secret|\/Users\/private|block-secret|job-secret/)
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
  overrides: Partial<PrepareConversationContextInput> & { provider?: ConversationContextProviderPort } = {},
): PrepareConversationContextInput {
  const provider = overrides.provider ?? {
    stream: vi.fn<ConversationContextProviderPort['stream']>(async function* () {}),
  }
  const { provider: _legacyProvider, ...inputOverrides } = overrides
  void _legacyProvider
  return {
    conversationId: 'c1',
    beforeOrdinal: 11,
    model: 'tiny-model',
    contextLength: 2_000,
    currentMessage: { role: 'user', content: 'current' },
    tools: [],
    currentMedia: [],
    signal: new AbortController().signal,
    providerSnapshot: overrides.providerSnapshot ?? {
      providerId: 'openrouter',
      apiKeyFingerprint: 'fingerprint_1',
      provider: {
        listModels: async () => [],
        validateCredential: async () => ({ valid: true }),
        stream: provider.stream,
      },
    },
    callIdentity: overrides.callIdentity ?? {
      requestId: 'request_1', chatRunId: 'run_1', userId: 'user_1',
    },
    ...inputOverrides,
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
    providerUsage: {
      start: vi.fn((value) => value as never),
      bindIdentity: vi.fn((_key, value) => value as never),
      report: vi.fn((_key, value) => value as never),
      markUnknown: vi.fn((key) => key as never),
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

    await expect(manager.prepare(prepareInput({
      conversationId: 'c1', beforeOrdinal: 3,
      provider, model: 'model', contextLength: 32_000,
      currentMessage: { role: 'user', content: '我的代号是什么？' },
      tools: [], currentMedia: [], signal: new AbortController().signal,
    }))).resolves.toEqual([
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

  it('keeps a mutable media-generation message behind the checkpoint across later updates', async () => {
    const mutable: Message = {
      id: 'message_2', conversationId: 'c1', role: 'assistant', ordinal: 2, createdAt: 2,
      blocks: [{
        type: 'media_generation', blockId: 'block_2', jobId: 'job_2',
        kind: 'image', status: 'in_progress',
      }],
    }
    const messages = [
      user(1, 'old '.repeat(1_000)),
      mutable,
      ...Array.from({ length: 8 }, (_, index) => (
        historical(index % 2 ? 'assistant' : 'user', index + 3, `recent-${index + 3}`)
      )),
    ]
    const { manager, provider, store } = contextHarness({ messages })

    const first = await manager.prepare(prepareInput({ provider }))

    expect(store.advance).toHaveBeenCalledWith(expect.objectContaining({ throughOrdinal: 1 }))
    expect(JSON.stringify(provider.stream.mock.calls[0]?.[0]?.messages)).not.toContain('in_progress')
    expect(JSON.stringify(first)).toContain('in_progress')

    mutable.blocks = [{
      type: 'media_generation', blockId: 'block_2', jobId: 'job_2',
      kind: 'image', status: 'failed', errorCode: 'MEDIA_GENERATION_FAILED',
    }]
    const later = await manager.prepare(prepareInput({
      provider, contextLength: 32_000,
    }))

    expect(JSON.stringify(later)).toContain('failed')
    expect(JSON.stringify(later)).toContain('MEDIA_GENERATION_FAILED')
  })

  it('rejects overflow instead of compressing through a mutable media-generation barrier', async () => {
    const messages: Message[] = [
      {
        id: 'message_1', conversationId: 'c1', role: 'assistant', ordinal: 1, createdAt: 1,
        blocks: [{
          type: 'media_generation', blockId: 'block_1', jobId: 'job_1',
          kind: 'video', status: 'paused',
        }],
      },
      user(2, 'after barrier '.repeat(700)),
    ]
    const { manager, provider, store } = contextHarness({ messages })

    await expect(manager.prepare(prepareInput({
      provider, beforeOrdinal: 3,
    }))).rejects.toMatchObject({ code: 'CONTEXT_LIMIT_EXCEEDED' })
    expect(provider.stream).not.toHaveBeenCalled()
    expect(store.advance).not.toHaveBeenCalled()
  })

  it('rejects before compressing a prefix when the mutable barrier suffix cannot fit', async () => {
    const messages: Message[] = [
      user(1, 'compressible prefix'),
      {
        id: 'message_2', conversationId: 'c1', role: 'assistant', ordinal: 2, createdAt: 2,
        blocks: [{
          type: 'media_generation', blockId: 'block_2', jobId: 'job_2',
          kind: 'video', status: 'downloading',
        }],
      },
      user(3, 'large immutable suffix '.repeat(700)),
    ]
    const { manager, provider, store } = contextHarness({ messages })

    await expect(manager.prepare(prepareInput({
      provider, beforeOrdinal: 4,
    }))).rejects.toMatchObject({ code: 'CONTEXT_LIMIT_EXCEEDED' })
    expect(provider.stream).not.toHaveBeenCalled()
    expect(store.advance).not.toHaveBeenCalled()
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

  it('reserves the Main policy prefix before admitting the current message', async () => {
    const currentMessage = { role: 'user' as const, content: 'current'.repeat(100) }
    const leadingMessage = { role: 'system' as const, content: 'policy'.repeat(200) }
    const withoutPolicy = estimateRequestTokens({ messages: [currentMessage], tools: [], currentMedia: [] })
    const withPolicy = estimateRequestTokens({
      messages: [leadingMessage, currentMessage], tools: [], currentMedia: [],
    })
    const contextLength = Array.from({ length: 20_000 }, (_, index) => index + 1)
      .find((value) => {
        const budget = Math.floor(value * 0.60)
        return withoutPolicy <= budget && budget < withPolicy
      })!
    const { manager, provider, store } = contextHarness()
    const input = prepareInput({ provider, contextLength, currentMessage })
    Object.assign(input, { leadingMessages: [leadingMessage] })

    await expect(manager.prepare(input)).rejects.toMatchObject({ code: 'CONTEXT_LIMIT_EXCEEDED' })
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

function sqliteContextHarness(eventsForRound: (round: number) => ModelStreamEvent[]) {
  const database = openAppDatabase(':memory:')
  database.localAuth.createUserAndSession({
    id: 'user_1', account: 'Alice', accountNormalized: 'alice',
    passwordDigest: 'digest', createdAt: 1, updatedAt: 1,
  }, 1)
  database.conversations.insert({ id: 'c1', title: 'Context billing' })
  for (let index = 0; index < 10; index += 1) {
    database.messages.insert({
      id: `message_${index + 1}`,
      conversationId: 'c1',
      role: index % 2 === 0 ? 'user' : 'assistant',
      blocks: [{ type: 'text', text: `history-${index + 1} ${'很长的历史内容'.repeat(20)}` }],
      createdAt: index + 1,
    })
  }
  let round = 0
  const requests: Parameters<ConversationContextProviderPort['stream']>[0][] = []
  const provider = {
    listModels: async () => [],
    validateCredential: async () => ({ valid: true }),
    stream: vi.fn<ConversationContextProviderPort['stream']>(async function* (request) {
      requests.push(request)
      for (const event of eventsForRound(round++)) yield event
    }),
  }
  const snapshot: ModelProviderSnapshot = {
    providerId: 'openrouter',
    provider,
    apiKeyFingerprint: 'fingerprint_1',
  }
  const start = vi.spyOn(database.providerUsage, 'start')
  const bindIdentity = vi.spyOn(database.providerUsage, 'bindIdentity')
  const report = vi.spyOn(database.providerUsage, 'report')
  const markUnknown = vi.spyOn(database.providerUsage, 'markUnknown')
  const manager = createConversationContextManager(database)
  const input = prepareInput({
    provider,
    providerSnapshot: snapshot,
    callIdentity: { requestId: 'request_summary', chatRunId: 'run_summary', userId: 'user_1' },
  })
  return {
    database, manager, input, requests,
    usage: { start, bindIdentity, report, markUnknown },
  }
}

function providerCostQuery() {
  return {
    userId: 'user_1', yesterdayStartedAt: 0, todayStartedAt: 0,
    weekStartedAt: 0, monthStartedAt: 0, endedAt: Number.MAX_SAFE_INTEGER,
  }
}

describe('conversation context compression billing', () => {
  it('persists every real SQLite compression round under stable distinct operation keys', async () => {
    const test = sqliteContextHarness((round) => [
      { type: 'generation', id: `summary_generation_${round}` },
      { type: 'usage', inputTokens: round + 1, outputTokens: 2, totalTokens: round + 3, costUsd: `0.0${round + 1}` },
      { type: 'text_delta', choiceIndex: 0, text: `summary-${round}` },
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ])
    try {
      await test.manager.prepare(test.input)

      expect(test.usage.start.mock.calls.length).toBeGreaterThan(1)
      const starts = test.usage.start.mock.calls.map(([value]) => value)
      const operationKeys = starts.map((value) => value.operationKey)
      expect(new Set(operationKeys).size).toBe(operationKeys.length)
      expect(operationKeys).toEqual(starts.map((value, index) => {
        const expectedThroughOrdinal = index === 0
          ? 0
          : Number(operationKeys[index - 1]!.split(':').at(-1))
        const throughOrdinal = Number(value.operationKey.split(':').at(-1))
        return `conversation-summary:request_summary:${expectedThroughOrdinal}:${throughOrdinal}`
      }))
      expect(starts).toEqual(starts.map((value) => expect.objectContaining({
        operationKey: value.operationKey,
        userId: 'user_1', requestId: 'request_summary', chatRunId: 'run_summary',
        provider: 'openrouter', apiKeyFingerprint: 'fingerprint_1',
        model: 'tiny-model', modality: 'text',
      })))
      expect(test.requests).toHaveLength(starts.length)
      expect(test.requests.every((request) => request.endUserId === 'user_1')).toBe(true)
      expect(test.usage.bindIdentity).toHaveBeenCalledTimes(starts.length)
      expect(test.usage.report).toHaveBeenCalledTimes(starts.length)
      expect(test.usage.markUnknown).not.toHaveBeenCalled()
      expect(test.database.providerUsage.summarize(providerCostQuery()).allTime)
        .toMatchObject({ openRouterKnownCostCount: starts.length, openRouterUnknownCostCount: 0 })
    } finally {
      test.database.close()
    }
  })

  it('persists a reported compression cost before a later context advance failure', async () => {
    const test = sqliteContextHarness(() => [
      { type: 'generation', id: 'summary_generation_paid' },
      { type: 'usage', inputTokens: 3, outputTokens: 4, totalTokens: 7, costUsd: '0.07' },
      { type: 'text_delta', choiceIndex: 0, text: 'summary-paid' },
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ])
    vi.spyOn(test.database.conversationContexts, 'advance').mockImplementation(() => {
      throw new Error('checkpoint changed')
    })
    try {
      await expect(test.manager.prepare(test.input)).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(test.database.providerUsage.summarize(providerCostQuery()).allTime).toMatchObject({
        openRouterCostUsd: '0.07', openRouterKnownCostCount: 1, openRouterUnknownCostCount: 0,
      })
    } finally {
      test.database.close()
    }
  })

  it('keeps cancellation generation and reported cost without advancing context', async () => {
    const controller = new AbortController()
    const test = sqliteContextHarness(() => [
      { type: 'generation', id: 'summary_generation_cancelled' },
      { type: 'usage', inputTokens: 2, outputTokens: 2, totalTokens: 4, costUsd: '0.04' },
      { type: 'text_delta', choiceIndex: 0, text: 'never advanced' },
    ])
    test.input.signal = controller.signal
    vi.mocked(test.input.providerSnapshot.provider.stream).mockImplementation(async function* (request) {
      void request
      yield { type: 'generation', id: 'summary_generation_cancelled' }
      yield { type: 'usage', inputTokens: 2, outputTokens: 2, totalTokens: 4, costUsd: '0.04' }
      controller.abort()
      yield { type: 'text_delta', choiceIndex: 0, text: 'never advanced' }
    })
    try {
      await expect(test.manager.prepare(test.input)).rejects.toMatchObject({ code: 'CANCELLED' })
      expect(test.database.conversationContexts.get('c1')).toBeUndefined()
      expect(test.usage.bindIdentity).toHaveBeenCalledWith(
        expect.any(String), { generationId: 'summary_generation_cancelled' },
      )
      expect(test.database.providerUsage.summarize(providerCostQuery()).allTime).toMatchObject({
        openRouterCostUsd: '0.04', openRouterKnownCostCount: 1,
      })
    } finally {
      test.database.close()
    }
  })

  it('persists a completed compression generation as unknown when cost is absent', async () => {
    const test = sqliteContextHarness((round) => [
      { type: 'generation', id: `summary_generation_unknown_${round}` },
      { type: 'usage', inputTokens: 2, outputTokens: 2, totalTokens: 4 },
      { type: 'text_delta', choiceIndex: 0, text: 'summary-unknown' },
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ])
    try {
      await test.manager.prepare(test.input)
      expect(test.database.providerUsage.summarize(providerCostQuery()).allTime).toMatchObject({
        openRouterCostUsd: '0', openRouterKnownCostCount: 0,
        openRouterUnknownCostCount: test.usage.start.mock.calls.length,
      })
      expect(test.database.providerUsage.listReconcilable(Number.MAX_SAFE_INTEGER))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ generationId: 'summary_generation_unknown_0', status: 'unknown' }),
        ]))
    } finally {
      test.database.close()
    }
  })

  it('does not write a provider usage event for DeepSeek compression', async () => {
    const test = sqliteContextHarness(() => [])
    const bodies: unknown[] = []
    const provider = new DeepSeekProvider({
      credential: { get: async () => 'deepseek-key' },
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return new Response([
          'data: {"choices":[{"index":0,"delta":{"content":"deepseek-summary"},"finish_reason":"stop"}]}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'), { headers: { 'content-type': 'text/event-stream' } })
      },
    })
    test.input.providerSnapshot = await provider.acquireSnapshot()
    try {
      await test.manager.prepare(test.input)
      expect(test.usage.start).not.toHaveBeenCalled()
      expect(bodies.length).toBeGreaterThan(0)
      expect(bodies.every((body) => !Object.hasOwn(body as object, 'user'))).toBe(true)
      expect(test.database.providerUsage.summarize(providerCostQuery()).allTime).toMatchObject({
        openRouterKnownCostCount: 0, openRouterUnknownCostCount: 0,
      })
    } finally {
      test.database.close()
    }
  })

  it('propagates provider usage consistency errors without converting them to context failures', async () => {
    const test = sqliteContextHarness(() => [
      { type: 'usage', inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: '0.01' },
    ])
    const error = new ProviderUsageConsistencyError()
    test.usage.report.mockImplementation(() => { throw error })
    try {
      await expect(test.manager.prepare(test.input)).rejects.toBe(error)
    } finally {
      test.database.close()
    }
  })
})
