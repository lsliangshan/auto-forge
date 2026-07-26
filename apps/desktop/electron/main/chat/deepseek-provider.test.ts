import { describe, expect, it, vi } from 'vitest'
import { DeepSeekProvider } from './deepseek-provider.js'
import type { ModelStreamEvent } from './model-provider.js'

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }))
}

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const values: ModelStreamEvent[] = []
  for await (const value of stream) values.push(value)
  return values
}

describe('DeepSeekProvider', () => {
  it('uses the fixed models endpoint and only the DeepSeek credential', async () => {
    const credential = { get: vi.fn(async () => 'sk-deepseek-private') }
    const fetch = vi.fn(async (...request: Parameters<typeof globalThis.fetch>) => {
      void request
      return Response.json({
        object: 'list',
        data: [
          { id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek' },
          { id: 'deepseek-v4-flash', object: 'model', owned_by: 'deepseek' },
          { id: ' deepseek-v4-flash', object: 'model', owned_by: 'deepseek' },
          { id: 'deepseek-v4-pro ', object: 'model', owned_by: 'deepseek' },
        ],
      })
    })
    const provider = new DeepSeekProvider({ credential, fetch })

    await expect(provider.listModels()).resolves.toEqual([
      {
        id: 'deepseek-v4-flash',
        name: 'deepseek-v4-flash',
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
        generation: {},
      },
      {
        id: 'deepseek-v4-pro',
        name: 'deepseek-v4-pro',
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
        generation: {},
      },
    ])
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.deepseek.com/models')
    expect(credential.get).toHaveBeenCalledWith('deepseek_api_key')
    expect(JSON.stringify(await provider.listModels())).not.toContain('sk-deepseek-private')
  })

  it('rejects non-canonical model IDs instead of trimming them', async () => {
    const provider = new DeepSeekProvider({
      credential: { get: vi.fn(async () => 'sk-deepseek-private') },
      fetch: vi.fn(async () => Response.json({
        object: 'list',
        data: [
          { id: ' deepseek-leading', object: 'model' },
          { id: 'deepseek-trailing ', object: 'model' },
        ],
      })),
    })

    await expect(provider.listModels()).resolves.toEqual([])
  })

  it('uses DeepSeek chat and parses text, tools, nullable usage, and final usage', async () => {
    const fetch = vi.fn(async (...request: Parameters<typeof globalThis.fetch>) => {
      void request
      return sseResponse([
        'data: {"id":"deep_1","choices":[{"index":0,"delta":{"reasoning_content":"private chain","content":"结果"}}],"usage":null}\n\n',
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"browser.search.baidu","arguments":"{\\"keyword\\":\\"天气\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n',
        'data: [DONE]\n\n',
      ])
    })
    const provider = new DeepSeekProvider({
      credential: { get: vi.fn(async () => 'sk-deepseek-private') },
      fetch,
    })

    const events = await collect(provider.stream({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: '天气' }],
    }))

    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.deepseek.com/chat/completions')
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: '天气' }],
      stream: true,
    })
    expect(events).toContainEqual({ type: 'generation', id: 'deep_1' })
    expect(events).toContainEqual({ type: 'text_delta', choiceIndex: 0, text: '结果' })
    expect(events).toContainEqual({
      type: 'tool_call',
      choiceIndex: 0,
      index: 0,
      id: 'call_1',
      name: 'browser.search.baidu',
      arguments: { keyword: '天气' },
    })
    expect(events).toContainEqual({ type: 'finish', choiceIndex: 0, reason: 'tool_calls' })
    expect(events).toContainEqual({
      type: 'usage',
      inputTokens: 4,
      outputTokens: 2,
      totalTokens: 6,
    })
    expect(JSON.stringify(events)).not.toContain('private chain')
  })

  it.each([
    {
      name: 'media input',
      request: {
        model: 'deepseek-v4-pro',
        messages: [{
          role: 'user' as const,
          content: [{ type: 'media' as const, kind: 'image' as const, mimeType: 'image/png', dataBase64: 'AQID' }],
        }],
      },
    },
    {
      name: 'audio output',
      request: {
        model: 'deepseek-v4-pro',
        messages: [{ role: 'user' as const, content: '朗读' }],
        output: { type: 'audio' as const, format: 'mp3' },
      },
    },
  ])('rejects $name locally before reading credentials or fetching', async ({ request }) => {
    const credential = { get: vi.fn(async () => 'sk-deepseek-private') }
    const fetch = vi.fn(async () => sseResponse([]))
    const provider = new DeepSeekProvider({ credential, fetch })

    await expect(collect(provider.stream(request))).rejects.toMatchObject({
      code: 'MODEL_MODALITY_UNSUPPORTED',
    })
    expect(credential.get).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
})
