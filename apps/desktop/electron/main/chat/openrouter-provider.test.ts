import { describe, expect, it, vi } from 'vitest'
import {
  OpenRouterProvider,
  type OpenRouterStreamEvent,
} from './openrouter-provider.js'

function sseResponse(chunks: string[], status = 200, headers?: Record<string, string>): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }), { status, headers })
}

async function collect(stream: AsyncIterable<OpenRouterStreamEvent>) {
  const values: OpenRouterStreamEvent[] = []
  for await (const value of stream) values.push(value)
  return values
}

const credential = { get: vi.fn(async () => 'sk-private') }

describe('OpenRouterProvider', () => {
  it('parses arbitrary SSE boundaries, CRLF comments, usage, choices, and indexed tool fragments', async () => {
    const payload = [
      ': keep-alive\r\n\r\n',
      'data: {"id":"gen_1","choices":[{"index":0,"delta":{"content":"你好","tool_calls":[{"index":0,"id":"call_1","function":{"name":"browser.search.baidu","arguments":"{\\"keyword\\":"}}]}},{"index":1,"delta":{"content":"备选"}}]}\r\n\r\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"今日天气\\"}"}}]},"finish_reason":"tool_calls"},{"index":1,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10,"cost":0.001}}\r\n\r\n',
      'data: [DONE]\r\n\r\n',
    ].join('')
    const chunks = [payload.slice(0, 11), payload.slice(11, 53), payload.slice(53, 137), payload.slice(137)]
    const provider = new OpenRouterProvider({
      credential,
      fetch: vi.fn(async () => sseResponse(chunks)),
    })

    const events = await collect(provider.stream({ model: 'model', messages: [{ role: 'user', content: '搜索' }] }))

    expect(events).toContainEqual({ type: 'generation', id: 'gen_1' })
    expect(events).toContainEqual({ type: 'text_delta', choiceIndex: 0, text: '你好' })
    expect(events).toContainEqual({ type: 'text_delta', choiceIndex: 1, text: '备选' })
    expect(events).toContainEqual({
      type: 'tool_call', choiceIndex: 0, index: 0, id: 'call_1',
      name: 'browser.search.baidu', arguments: { keyword: '今日天气' },
    })
    expect(events).toContainEqual({ type: 'finish', choiceIndex: 0, reason: 'tool_calls' })
    expect(events).toContainEqual({ type: 'finish', choiceIndex: 1, reason: 'stop' })
    expect(events).toContainEqual({ type: 'usage', inputTokens: 7, outputTokens: 3, totalTokens: 10, costUsd: '0.001' })
  })

  it('merges stable capability metadata by exact model ID without dropping media-only models', async () => {
    const calls: Array<{ url: string; authorization?: string }> = []
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, authorization: new Headers(init?.headers).get('authorization') ?? undefined })
      if (url === 'https://openrouter.ai/api/v1/images/models') {
        return Response.json({ data: [
          {
            id: 'google/gemini-2.5-flash-image',
            name: 'Nano Banana dedicated',
            architecture: { input_modalities: ['image', 'text', 'image'], output_modalities: ['image'] },
            supported_parameters: {
              resolution: { type: 'enum', values: ['2K', '1K', '2K'] },
              aspect_ratio: { type: 'enum', values: ['16:9', 'auto', '1:1', 'auto'] },
              output_format: { type: 'enum', values: ['png', 'jpeg', 'png'] },
              n: { type: 'range', min: 1, max: 1 },
              seed: { type: 'boolean' },
            },
          },
          {
            id: 'shared/model',
            name: 'Dedicated image descriptor',
            architecture: { input_modalities: ['text'], output_modalities: ['image'] },
            supported_parameters: {
              resolution: { type: 'enum', values: ['1K'] },
              output_format: { type: 'enum', values: ['webp'] },
            },
          },
          { id: 'dedicated-only/image', name: 'Not authoritative', architecture: { output_modalities: ['image'] }, supported_parameters: {} },
          { id: '__proto__', name: 'Prototype key', architecture: { output_modalities: ['image'] }, supported_parameters: {} },
        ] })
      }
      if (url === 'https://openrouter.ai/api/v1/videos/models') {
        return Response.json({ data: [
          {
            id: 'shared/model',
            canonical_slug: 'shared/model',
            name: 'Dedicated video descriptor',
            supported_resolutions: ['1080p', '720p', '1080p'],
            supported_aspect_ratios: ['9:16', '16:9', '9:16'],
            supported_durations: [10, 5, 10],
            allowed_passthrough_parameters: ['generate_audio'],
          },
          {
            id: 'video/no-options',
            canonical_slug: 'video/no-options',
            name: 'No invented options',
          },
        ] })
      }
      return Response.json({ data: [
        {
          id: 'z/text',
          name: 'Z text',
          supported_parameters: ['tools'],
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
          context_length: 1000,
          pricing: { prompt: '0.000001', completion: '0.000002' },
        },
        {
          id: 'google/gemini-2.5-flash-image',
          name: 'Nano Banana',
          supported_parameters: [],
          architecture: { input_modalities: ['text'], output_modalities: ['image'] },
        },
        {
          id: 'shared/model',
          name: 'Shared',
          supported_parameters: ['tools'],
          architecture: { input_modalities: ['text', 'image'], output_modalities: ['text', 'image', 'video'] },
        },
        {
          id: 'shared/model',
          name: 'Duplicate must merge',
          supported_parameters: [],
          architecture: { input_modalities: ['audio'], output_modalities: ['audio'] },
        },
        {
          id: 'video/no-options',
          name: 'Video without options',
          supported_parameters: [],
          architecture: { input_modalities: ['text'], output_modalities: ['video'] },
        },
      ] })
    })
    const provider = new OpenRouterProvider({
      credential: { get: vi.fn(async () => 'sk-private') },
      fetch,
    })

    await expect(provider.listModels()).resolves.toEqual([
      {
        id: 'google/gemini-2.5-flash-image',
        name: 'Nano Banana',
        inputModalities: ['text', 'image'],
        outputModalities: ['image'],
        supportsTools: false,
        generation: {
          image: {
            resolutions: ['1K', '2K'],
            aspectRatios: ['16:9', '1:1', 'auto'],
            formats: ['jpeg', 'png'],
            maxCount: 1,
          },
        },
      },
      {
        id: 'shared/model',
        name: 'Shared',
        inputModalities: ['text', 'image', 'audio'],
        outputModalities: ['text', 'image', 'audio', 'video'],
        supportsTools: true,
        generation: {
          image: {
            resolutions: ['1K'],
            aspectRatios: [],
            formats: ['webp'],
            maxCount: 1,
          },
          audio: { voices: [], formats: [] },
          video: {
            resolutions: ['1080p', '720p'],
            aspectRatios: ['16:9', '9:16'],
            durations: [5, 10],
            supportsAudio: true,
          },
        },
      },
      {
        id: 'video/no-options',
        name: 'Video without options',
        inputModalities: ['text'],
        outputModalities: ['video'],
        supportsTools: false,
        generation: {
          video: {
            resolutions: [],
            aspectRatios: [],
            durations: [],
            supportsAudio: false,
          },
        },
      },
      {
        id: 'z/text',
        name: 'Z text',
        contextLength: 1000,
        inputCostPerMillion: 1,
        outputCostPerMillion: 2,
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
        generation: {},
      },
    ])
    expect(calls.map(({ url }) => url)).toEqual([
      'https://openrouter.ai/api/v1/models',
      'https://openrouter.ai/api/v1/images/models',
      'https://openrouter.ai/api/v1/videos/models',
    ])
    expect(calls.every(({ authorization }) => authorization === 'Bearer sk-private')).toBe(true)
    expect(JSON.stringify(await provider.listModels())).not.toContain('sk-private')
  })

  it('keeps the authoritative general list when optional catalogs fail or contain malformed entries', async () => {
    const diagnostic = vi.fn()
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/images/models')) {
        return new Response('Bearer optional-catalog-secret', { status: 403 })
      }
      if (url.endsWith('/videos/models')) {
        return Response.json({ data: [
          { id: 'text/model/variant', name: 'Wrong exact ID', supported_resolutions: ['1080p'] },
          { id: 'text/model-suffix', name: 'Wrong exact ID', supported_resolutions: ['4K'] },
          { id: '', name: 'Malformed empty ID', supported_resolutions: ['720p'] },
          { id: 'text/model', name: 'Oversized option', supported_resolutions: ['x'.repeat(300)] },
          null,
        ] })
      }
      return Response.json({ data: [
        null,
        { id: '', name: 'empty' },
        { id: 'text/model', name: 'Text model', supported_parameters: [], architecture: { input_modalities: ['text', 'unknown'], output_modalities: ['text'] } },
        { id: 'broken/model', name: 42 },
      ] })
    })
    const provider = new OpenRouterProvider({ credential, fetch, diagnostic })

    await expect(provider.listModels()).resolves.toEqual([{
      id: 'text/model',
      name: 'Text model',
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportsTools: false,
      generation: {},
    }])
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('optional-catalog-secret')
    expect(JSON.stringify(diagnostic.mock.calls).length).toBeLessThan(1000)
  })

  it.each([
    [401, 'CREDENTIAL_INVALID'],
    [403, 'MODEL_PROVIDER_ACCESS_DENIED'],
  ] as const)('keeps general discovery authoritative for HTTP %s', async (status, code) => {
    const diagnostic = vi.fn()
    const fetch = vi.fn(async () => new Response(`Bearer authoritative-secret ${'x'.repeat(3000)}`, { status }))
    const provider = new OpenRouterProvider({ credential, fetch, diagnostic })

    await expect(provider.listModels()).rejects.toMatchObject({ code })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('authoritative-secret')
    expect(JSON.stringify(diagnostic.mock.calls).length).toBeLessThan(1000)
  })

  it('validates credentials without returning the secret', async () => {
    const valid = new OpenRouterProvider({ credential, fetch: vi.fn(async () => Response.json({ data: [] })) })
    const invalid = new OpenRouterProvider({ credential, fetch: vi.fn(async () => new Response('', { status: 401 })) })
    const forbidden = new OpenRouterProvider({ credential, fetch: vi.fn(async () => new Response('', { status: 403 })) })

    await expect(valid.validateCredential()).resolves.toEqual({ valid: true })
    await expect(invalid.validateCredential()).resolves.toEqual({ valid: false })
    await expect(forbidden.validateCredential()).rejects.toMatchObject({ code: 'MODEL_PROVIDER_ACCESS_DENIED' })
  })

  it('applies the same bounded retry policy to model discovery', async () => {
    let attempt = 0
    const fetch = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) return new Response('busy', { status: 503 })
      return Response.json({ data: [] })
    })
    const sleep = vi.fn(async () => undefined)
    const provider = new OpenRouterProvider({ credential, fetch, sleep, random: () => 0 })

    await expect(provider.listModels()).resolves.toEqual([])
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(sleep).toHaveBeenCalledWith(200, undefined)
  })

  it('retries network, 429, and 5xx with fresh requests while suppressing replayed deltas', async () => {
    let attempts = 0
    const bodies: string[] = []
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      attempts += 1
      bodies.push(String(init?.body))
      if (attempts === 1) return new Response('busy', { status: 429, headers: { 'retry-after': '99' } })
      if (attempts === 2) return new Response('down', { status: 503 })
      if (attempts === 3) {
        const encoder = new TextEncoder()
        let emitted = false
        return new Response(new ReadableStream({
          pull(controller) {
            if (!emitted) {
              emitted = true
              controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"A"}}]}\n\n'))
            } else {
              controller.error(new TypeError('socket closed'))
            }
          },
        }))
      }
      return sseResponse(['data: {"choices":[{"index":0,"delta":{"content":"AB"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'])
    })
    const sleeps: number[] = []
    const provider = new OpenRouterProvider({ credential, fetch, random: () => 0, sleep: async (ms) => { sleeps.push(ms) } })

    const events = await collect(provider.stream({ model: 'model', messages: [{ role: 'user', content: 'hi' }] }))

    expect(events.filter((event) => event.type === 'text_delta')).toEqual([
      { type: 'text_delta', choiceIndex: 0, text: 'A' },
      { type: 'text_delta', choiceIndex: 0, text: 'B' },
    ])
    expect(attempts).toBe(4)
    expect(sleeps).toEqual([5_000, 400, 800])
    expect(new Set(bodies).size).toBe(1)
    expect(bodies.every((body) => body.includes('"stream":true'))).toBe(true)
  })

  it.each([400, 401, 403])('does not retry HTTP %s and reports only a safe error', async (status) => {
    const diagnostic = vi.fn()
    const fetch = vi.fn(async () => new Response(`authorization: Bearer sk-private ${'x'.repeat(3000)}`, { status }))
    const provider = new OpenRouterProvider({ credential, fetch, diagnostic })

    await expect(collect(provider.stream({ model: 'm', messages: [] }))).rejects.toMatchObject({
      code: status === 401
        ? 'CREDENTIAL_INVALID'
        : status === 403 ? 'MODEL_PROVIDER_ACCESS_DENIED' : 'MODEL_PROVIDER_REQUEST_FAILED',
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('sk-private')
    expect(JSON.stringify(diagnostic.mock.calls).length).toBeLessThan(1500)
  })

  it('propagates cancellation through request, response reading, and retry backoff without retrying', async () => {
    const controller = new AbortController()
    const fetch = vi.fn(async () => {
      controller.abort()
      throw new DOMException('aborted', 'AbortError')
    })
    const sleep = vi.fn(async () => undefined)
    const provider = new OpenRouterProvider({ credential, fetch, sleep })

    await expect(collect(provider.stream({ model: 'm', messages: [], signal: controller.signal })))
      .rejects.toMatchObject({ code: 'CANCELLED' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('stops during retry backoff when cancellation wins the race', async () => {
    const controller = new AbortController()
    const fetch = vi.fn(async () => new Response('busy', { status: 503 }))
    const sleep = vi.fn(async (_milliseconds: number, signal?: AbortSignal) => {
      controller.abort()
      expect(signal?.aborted).toBe(true)
      throw new DOMException('aborted', 'AbortError')
    })
    const provider = new OpenRouterProvider({ credential, fetch, sleep })

    await expect(collect(provider.stream({ model: 'm', messages: [], signal: controller.signal })))
      .rejects.toMatchObject({ code: 'CANCELLED' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('retries a streamed 429 error after partial text without duplicating text or usage', async () => {
    let attempt = 0
    const fetch = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) return sseResponse([
        'data: {"choices":[{"index":0,"delta":{"content":"A"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2,"cost":0.1}}\n\n',
        'data: {"error":{"code":429,"message":"prompt must never leak","metadata":{"error_type":"rate_limit"}}}\n\n',
      ])
      return sseResponse([
        'data: {"choices":[{"index":0,"delta":{"content":"AB"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2,"cost":0.1}}\n\n',
        'data: [DONE]\n\n',
      ])
    })
    const diagnostic = vi.fn()
    const provider = new OpenRouterProvider({ credential, fetch, diagnostic, sleep: async () => undefined })

    const result = await collect(provider.stream({ model: 'm', messages: [{ role: 'user', content: 'prompt must never leak' }] }))

    expect(result.filter((event) => event.type === 'text_delta')).toEqual([
      { type: 'text_delta', choiceIndex: 0, text: 'A' },
      { type: 'text_delta', choiceIndex: 0, text: 'B' },
    ])
    expect(result.filter((event) => event.type === 'usage')).toHaveLength(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('prompt must never leak')
  })

  it('maps a streamed 403 error to access denied without claiming the credential is invalid', async () => {
    const diagnostic = vi.fn()
    const fetch = vi.fn(async () => sseResponse([
      'data: {"error":{"code":403,"message":"user content secret","metadata":{"error_type":"permission"}}}\n\n',
    ]))
    const provider = new OpenRouterProvider({ credential, fetch, diagnostic })

    await expect(collect(provider.stream({ model: 'm', messages: [] })))
      .rejects.toMatchObject({ code: 'MODEL_PROVIDER_ACCESS_DENIED' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('user content secret')
  })

  it('rejects a clean EOF without DONE or an explicit non-error finish frame', async () => {
    const fetch = vi.fn(async () => sseResponse([
      'data: {"choices":[{"index":0,"delta":{"content":"truncated"}}]}\n\n',
    ]))
    const provider = new OpenRouterProvider({ credential, fetch, sleep: async () => undefined })

    await expect(collect(provider.stream({ model: 'm', messages: [] })))
      .rejects.toMatchObject({ code: 'MODEL_PROVIDER_REQUEST_FAILED' })
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('never treats finish_reason error as a normal finish', async () => {
    const fetch = vi.fn(async () => sseResponse([
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"error","error":{"code":400,"message":"bad prompt"}}]}\n\n',
    ]))
    const provider = new OpenRouterProvider({ credential, fetch })

    await expect(collect(provider.stream({ model: 'm', messages: [] })))
      .rejects.toMatchObject({ code: 'MODEL_PROVIDER_REQUEST_FAILED' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('cancels the response reader when an SSE error aborts parsing', async () => {
    const encoder = new TextEncoder()
    let readerCancelled = false
    const fetch = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"error":{"code":403,"message":"denied"}}\n\n'))
      },
      cancel() { readerCancelled = true },
    })))
    const provider = new OpenRouterProvider({ credential, fetch })

    await expect(collect(provider.stream({ model: 'm', messages: [] })))
      .rejects.toMatchObject({ code: 'MODEL_PROVIDER_ACCESS_DENIED' })
    expect(readerCancelled).toBe(true)
  })
})
