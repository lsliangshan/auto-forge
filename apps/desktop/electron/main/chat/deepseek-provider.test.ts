import { describe, expect, it, vi } from 'vitest'
import { DeepSeekProvider } from './deepseek-provider.js'
import type { ModelProvider, ModelStreamEvent } from './model-provider.js'
import { NetworkProxyService } from '../network/network-proxy-service.js'

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
  it('binds snapshots without exposing an OpenRouter fingerprint or serializing a user', async () => {
    let apiKey = 'sk-deepseek-a'
    const credential = { get: vi.fn(async () => apiKey) }
    const requests: Array<{ authorization: string; body: unknown }> = []
    const source = new DeepSeekProvider({
      credential,
      fetch: vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        requests.push({
          authorization: new Headers(init?.headers).get('authorization') ?? '',
          body: JSON.parse(String(init?.body)),
        })
        return sseResponse(['data: [DONE]\n\n'])
      }),
    })
    const snapshot = await source.acquireSnapshot()
    apiKey = 'sk-deepseek-b'

    await collect(snapshot.provider.stream({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'hello' }],
      endUserId: 'user-1',
    }))

    expect(snapshot.providerId).toBe('deepseek')
    expect(snapshot.apiKeyFingerprint).toBeUndefined()
    expect(credential.get).toHaveBeenCalledTimes(1)
    expect(requests).toEqual([{
      authorization: 'Bearer sk-deepseek-a',
      body: expect.not.objectContaining({ user: expect.anything() }),
    }])
    expect(JSON.stringify(snapshot)).not.toContain('sk-deepseek-a')
    expect(JSON.stringify(snapshot)).not.toContain('sk-deepseek-b')
  })

  it('uses the existing credential-unavailable error when snapshot acquisition has no key', async () => {
    const provider = new DeepSeekProvider({
      credential: { get: vi.fn(async () => undefined) },
      fetch: vi.fn(),
    })

    await expect(provider.acquireSnapshot()).rejects.toMatchObject({
      code: 'CREDENTIAL_UNAVAILABLE',
    })
  })

  it('does not serialize an end user into DeepSeek chat requests', async () => {
    let body: unknown
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return sseResponse(['data: [DONE]\n\n'])
    })
    const provider: ModelProvider = new DeepSeekProvider({
      credential: { get: vi.fn(async () => 'sk-deepseek-private') },
      fetch,
    })

    await collect(provider.stream({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'hello' }],
      endUserId: 'user-1',
    } as never))

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(body).not.toHaveProperty('user')
    expect(provider.getGenerationUsage).toBeUndefined()
  })

  it('releases a managed 401 response before returning an invalid credential result', async () => {
    const networkProxy = new NetworkProxyService({
      setProxy: vi.fn(async () => undefined),
      closeAllConnections: vi.fn(async () => undefined),
      fetch: vi.fn(async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('unauthorized'))
          controller.close()
        },
      }), { status: 401 })),
    })
    await networkProxy.initialize({ enabled: false, bypassDomains: [] })
    const provider = new DeepSeekProvider({
      credential: { get: vi.fn(async () => 'diagnostic-non-secret') },
      fetch: (input, init) => networkProxy.fetch(input instanceof URL ? input.toString() : input, init),
    })

    await expect(provider.validateCredential()).resolves.toEqual({ valid: false })
    const transition = networkProxy.transition({
      enabled: true,
      httpProxy: 'http://127.0.0.1:7890',
      bypassDomains: [],
    })

    await expect(Promise.race([
      transition.then(() => 'applied'),
      new Promise((resolve) => setTimeout(resolve, 25, 'blocked')),
    ])).resolves.toBe('applied')
  })

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
