import { describe, expect, it, vi } from 'vitest'
import {
  OpenRouterProvider,
  type OpenRouterStreamEvent,
} from './openrouter-provider.js'
import {
  mergeOpenRouterModels,
  parseOpenRouterImageModels,
  parseOpenRouterVideoModels,
} from './model-provider.js'
import { openRouterVideoModelsLiveFixture } from './openrouter-video-models-live.fixture.js'

function sseResponse(chunks: string[], status = 200, headers?: Record<string, string>): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }), { status, headers })
}

function abortingSlowJsonResponse(
  abort: AbortController,
  value: unknown,
): { response: Response; wasCancelled(): boolean } {
  const encoder = new TextEncoder()
  let cancelled = false
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(JSON.stringify(value)))
    },
    pull(controller) {
      abort.abort()
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          try { controller.close() } catch { /* the signal-aware reader already cancelled */ }
          resolve()
        }, 5)
      })
    },
    cancel() { cancelled = true },
  }, { highWaterMark: 0 }))
  return { response, wasCancelled: () => cancelled }
}

async function collect(stream: AsyncIterable<OpenRouterStreamEvent>) {
  const values: OpenRouterStreamEvent[] = []
  for await (const value of stream) values.push(value)
  return values
}

async function rejection(stream: AsyncIterable<OpenRouterStreamEvent>): Promise<unknown> {
  try {
    await collect(stream)
    return new Error('Expected stream rejection')
  } catch (error) {
    return error
  }
}

const credential = { get: vi.fn(async () => 'sk-private') }

describe('OpenRouterProvider', () => {
  it('generates one image through the fixed endpoint with verified reference bytes', async () => {
    const localCredential = { get: vi.fn(async () => 'sk-private') }
    const calls: Array<{ input: string; init?: RequestInit; body: string }> = []
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input: String(input), init: { ...init }, body: String(init?.body) })
      return Response.json({
        created: 1_748_372_400,
        data: [{ b64_json: 'AQID', media_type: 'image/png', provider_detail: true }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, cost: 0.04 },
      })
    })
    const provider = new OpenRouterProvider({ credential: localCredential, fetch })

    await expect(provider.generateImage({
      model: 'google/gemini-2.5-flash-image',
      prompt: 'watercolor harbor',
      options: { count: 1, resolution: '1K', aspectRatio: 'auto', format: 'png' },
      references: [{ mimeType: 'image/png', dataBase64: 'AQID' }],
    })).resolves.toEqual({
      outputs: [{ type: 'base64', dataBase64: 'AQID', mimeType: 'image/png' }],
      usage: { inputTokens: 2, outputTokens: 3, costUsd: '0.04' },
    })

    expect(localCredential.get).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(calls[0]?.input).toBe('https://openrouter.ai/api/v1/images')
    expect(calls[0]?.init).toMatchObject({
      method: 'POST',
      headers: { authorization: 'Bearer sk-private', 'content-type': 'application/json' },
    })
    expect(JSON.parse(calls[0]!.body)).toEqual({
      model: 'google/gemini-2.5-flash-image',
      prompt: 'watercolor harbor',
      n: 1,
      resolution: '1K',
      output_format: 'png',
      input_references: [{
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,AQID' },
      }],
    })
  })

  it('accepts canonical HTTPS image outputs and preserves SVG MIME metadata', async () => {
    const bodies: string[] = []
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body))
      return bodies.length === 1
        ? Response.json({ data: [{ url: 'https://media.example/generated.png' }] })
        : Response.json({ data: [{ b64_json: 'PHN2Zz4=', media_type: 'image/svg+xml' }] })
    })
    const provider = new OpenRouterProvider({ credential, fetch })
    const request = {
      model: 'image/model',
      prompt: 'draw',
      options: { count: 1 as const, resolution: '2K', aspectRatio: '16:9', format: 'svg' },
      references: [],
    }

    await expect(provider.generateImage(request)).resolves.toEqual({
      outputs: [{ type: 'url', url: 'https://media.example/generated.png' }],
    })
    await expect(provider.generateImage(request)).resolves.toEqual({
      outputs: [{ type: 'base64', dataBase64: 'PHN2Zz4=', mimeType: 'image/svg+xml' }],
    })

    expect(JSON.parse(bodies[0]!)).toEqual({
      model: 'image/model',
      prompt: 'draw',
      n: 1,
      resolution: '2K',
      aspect_ratio: '16:9',
      output_format: 'svg',
    })
  })

  it.each([
    ['data URL', 'data:image/png;base64,AQID'],
    ['file URL', 'file:///tmp/generated.png'],
    ['HTTP URL', 'http://media.example/generated.png'],
    ['credential URL', 'https://user:password@media.example/generated.png'],
    ['non-default port', 'https://media.example:444/generated.png'],
    ['fragment URL', 'https://media.example/generated.png#raw'],
    ['non-canonical host', 'https://MEDIA.example/generated.png'],
    ['dot-segment path', 'https://media.example/a/../generated.png'],
    ['encoded dot-segment path', 'https://media.example/a/%2e%2e/generated.png'],
  ])('rejects a provider %s image output with a fixed safe error', async (_description, url) => {
    const provider = new OpenRouterProvider({
      credential,
      fetch: vi.fn(async () => Response.json({ data: [{ url }] })),
    })

    await expect(provider.generateImage({
      model: 'image/model',
      prompt: 'draw',
      options: { count: 1, resolution: '1K', aspectRatio: 'auto', format: 'png' },
      references: [],
    })).rejects.toMatchObject({
      code: 'MODEL_PROVIDER_REQUEST_FAILED',
      message: 'The model provider request failed.',
    })
  })

  it.each([
    ['a non-image MIME', [{ mimeType: 'audio/mpeg', dataBase64: 'AQID' }]],
    ['an unsupported image MIME', [{ mimeType: 'image/bmp', dataBase64: 'AQID' }]],
    ['a data URL instead of raw Base64', [{ mimeType: 'image/png', dataBase64: 'data:image/png;base64,AQID' }]],
    ['non-canonical Base64', [{ mimeType: 'image/png', dataBase64: 'AQI' }]],
    ['empty Base64', [{ mimeType: 'image/png', dataBase64: '' }]],
    ['too many references', Array.from({ length: 6 }, () => ({ mimeType: 'image/png', dataBase64: 'AQID' }))],
  ])('rejects %s before credential access or fetch', async (_description, references) => {
    const localCredential = { get: vi.fn(async () => 'sk-private') }
    const fetch = vi.fn(async () => Response.json({ data: [] }))
    const provider = new OpenRouterProvider({ credential: localCredential, fetch })

    await expect(provider.generateImage({
      model: 'image/model',
      prompt: 'draw',
      options: { count: 1, resolution: '1K', aspectRatio: 'auto', format: 'png' },
      references,
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(localCredential.get).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['count', { count: 2, resolution: '1K', aspectRatio: 'auto', format: 'png' }],
    ['resolution', { count: 1, resolution: '', aspectRatio: 'auto', format: 'png' }],
    ['aspect ratio', { count: 1, resolution: '1K', aspectRatio: 'wide', format: 'png' }],
    ['format', { count: 1, resolution: '1K', aspectRatio: 'auto', format: 'x'.repeat(33) }],
  ])('rejects an invalid image %s before credential access or fetch', async (_description, options) => {
    const localCredential = { get: vi.fn(async () => 'sk-private') }
    const fetch = vi.fn(async () => Response.json({ data: [] }))
    const provider = new OpenRouterProvider({ credential: localCredential, fetch })

    await expect(provider.generateImage({
      model: 'image/model',
      prompt: 'draw',
      options,
      references: [],
    } as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(localCredential.get).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    [{ data: [{ b64_json: 'AQID', media_type: 'image/png' }], unexpected: true }],
    [{ data: { b64_json: 'AQID', media_type: 'image/png' } }],
    [{ data: [] }],
    [{ data: [{ b64_json: 'AQI', media_type: 'image/png' }] }],
    [{ data: [{ b64_json: 'AQID', media_type: 'audio/mpeg' }] }],
    [{ data: [{ b64_json: 'AQID', url: 'https://media.example/generated.png' }] }],
  ])('rejects malformed image response shape without returning provider data', async (payload) => {
    const provider = new OpenRouterProvider({
      credential,
      fetch: vi.fn(async () => Response.json(payload)),
    })

    await expect(provider.generateImage({
      model: 'image/model',
      prompt: 'draw',
      options: { count: 1, resolution: '1K', aspectRatio: 'auto', format: 'png' },
      references: [],
    })).rejects.toMatchObject({ code: 'MODEL_PROVIDER_REQUEST_FAILED' })
  })

  it('submits, polls, and downloads video only through fixed ID-derived endpoints', async () => {
    const successfulDownload = new Response('video-bytes', {
      headers: { 'content-type': 'video/mp4' },
    })
    const calls: Array<{ input: string; body: string }> = []
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input: String(input), body: String(init?.body) })
      if (calls.length === 1) {
        return Response.json({
          id: 'abc123',
          status: 'pending',
          polling_url: 'http://attacker.example/poll',
          download_url: 'file:///tmp/secret',
        }, { status: 202 })
      }
      if (calls.length === 2) {
        return Response.json({
          id: 'abc123',
          status: 'completed',
          generation_id: 'gen-123',
          polling_url: 'https://attacker.example/poll',
          unsigned_urls: ['http://attacker.example/video'],
          usage: { cost: 0.25, is_byok: false },
        })
      }
      return successfulDownload
    })
    const provider = new OpenRouterProvider({ credential, fetch })

    await expect(provider.submitVideo({
      model: 'google/veo-3.1',
      prompt: 'slow camera move',
      options: { durationSeconds: 5, resolution: '720p', aspectRatio: 'auto', generateAudio: false },
      references: [],
    })).resolves.toEqual({ providerJobId: 'abc123', status: 'pending' })
    await expect(provider.pollVideo('abc123')).resolves.toEqual({
      status: 'completed',
      generationId: 'gen-123',
      costUsd: '0.25',
    })
    const downloaded = await provider.downloadVideo('abc123')

    expect(downloaded).toBe(successfulDownload)
    expect(downloaded.bodyUsed).toBe(false)
    expect(calls.map((call) => call.input)).toEqual([
      'https://openrouter.ai/api/v1/videos',
      'https://openrouter.ai/api/v1/videos/abc123',
      'https://openrouter.ai/api/v1/videos/abc123/content?index=0',
    ])
    expect(JSON.parse(calls[0]!.body)).toEqual({
      model: 'google/veo-3.1',
      prompt: 'slow camera move',
      duration: 5,
      resolution: '720p',
      generate_audio: false,
    })
  })

  it('submits verified video references with explicit aspect ratio', async () => {
    const bodies: string[] = []
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body))
      return Response.json({ id: 'job_1', status: 'in_progress' }, { status: 202 })
    })
    const provider = new OpenRouterProvider({ credential, fetch })

    await expect(provider.submitVideo({
      model: 'video/model',
      prompt: 'animate',
      options: { durationSeconds: 10, resolution: '1080p', aspectRatio: '9:16', generateAudio: true },
      references: [{ mimeType: 'image/webp', dataBase64: 'AQID' }],
    })).resolves.toEqual({ providerJobId: 'job_1', status: 'in_progress' })

    const expected = {
      model: 'video/model',
      prompt: 'animate',
      duration: 10,
      resolution: '1080p',
      aspect_ratio: '9:16',
      generate_audio: true,
      input_references: [{
        type: 'image_url',
        image_url: { url: 'data:image/webp;base64,AQID' },
      }],
    }
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(bodies.map((body) => JSON.parse(body))).toEqual([expected])
  })

  it.each([
    ['pending', { status: 'pending' }],
    ['in_progress', { status: 'in_progress' }],
    ['failed', { status: 'failed', errorCode: 'MEDIA_GENERATION_FAILED' }],
  ] as const)('maps documented %s video status deterministically', async (status, expected) => {
    const provider = new OpenRouterProvider({
      credential,
      fetch: vi.fn(async () => Response.json({
        id: 'job-1',
        status,
        error: 'RAW_PROVIDER_ERROR_MUST_NOT_ESCAPE',
      })),
    })

    await expect(provider.pollVideo('job-1')).resolves.toEqual(expected)
  })

  it.each([
    'cancelled',
    'expired',
    'complete',
    '',
  ])('rejects unknown video status %s with a fixed safe error', async (status) => {
    const provider = new OpenRouterProvider({
      credential,
      fetch: vi.fn(async () => Response.json({ id: 'job-1', status })),
    })

    await expect(provider.pollVideo('job-1')).rejects.toMatchObject({
      code: 'MODEL_PROVIDER_REQUEST_FAILED',
      message: 'The model provider request failed.',
    })
  })

  it.each([
    '',
    '../job',
    'job/child',
    'job%2Fchild',
    'job%252Fchild',
    'job?index=1',
    'job#fragment',
    'x'.repeat(201),
  ])('rejects malformed provider job ID %s before credential access or fetch', async (providerJobId) => {
    const localCredential = { get: vi.fn(async () => 'sk-private') }
    const fetch = vi.fn(async () => Response.json({ id: providerJobId, status: 'pending' }))
    const provider = new OpenRouterProvider({ credential: localCredential, fetch })

    await expect(provider.pollVideo(providerJobId)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(provider.downloadVideo(providerJobId)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(localCredential.get).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps a valid provider job ID byte-for-byte in poll and content paths', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ id: 'Az_09-job', status: 'pending' }))
      .mockResolvedValueOnce(new Response('bytes'))
    const provider = new OpenRouterProvider({ credential, fetch })

    await provider.pollVideo('Az_09-job')
    await provider.downloadVideo('Az_09-job')

    expect(fetch.mock.calls.map((call) => String(call[0]))).toEqual([
      'https://openrouter.ai/api/v1/videos/Az_09-job',
      'https://openrouter.ai/api/v1/videos/Az_09-job/content?index=0',
    ])
  })

  it.each([
    [401, 'CREDENTIAL_INVALID', 1],
    [403, 'MODEL_PROVIDER_ACCESS_DENIED', 1],
    [402, 'MODEL_PROVIDER_REQUEST_FAILED', 1],
    [429, 'MODEL_PROVIDER_REQUEST_FAILED', 1],
    [503, 'MODEL_PROVIDER_REQUEST_FAILED', 1],
  ] as const)('maps media HTTP %s safely with bounded diagnostics', async (status, code, attempts) => {
    const diagnostic = vi.fn()
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: status,
        message: `RAW_PROVIDER_BODY_${'x'.repeat(3_000)}`,
        metadata: { error_type: 'upstream_error' },
      },
    }), { status }))
    const provider = new OpenRouterProvider({
      credential,
      fetch,
      diagnostic,
      sleep: vi.fn(async () => undefined),
    })

    await expect(provider.generateImage({
      model: 'image/model',
      prompt: 'draw',
      options: { count: 1, resolution: '1K', aspectRatio: 'auto', format: 'png' },
      references: [],
    })).rejects.toMatchObject({ code })
    expect(fetch).toHaveBeenCalledTimes(attempts)
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('RAW_PROVIDER_BODY')
    expect(JSON.stringify(diagnostic.mock.calls).length).toBeLessThan(2_000)
  })

  it.each([
    ['network TypeError', 'network'],
    ['HTTP 429', 429],
    ['HTTP 503', 503],
  ] as const)('attempts a paid image POST only once on %s', async (_description, failure) => {
    const diagnostic = vi.fn()
    const fetch = vi.fn(async () => {
      if (failure === 'network') throw new TypeError('socket closed')
      return new Response(JSON.stringify({
        error: {
          code: failure,
          message: `RAW_PROVIDER_BODY_${'x'.repeat(3_000)}`,
          metadata: { error_type: 'upstream_error' },
        },
      }), { status: failure })
    })
    const sleep = vi.fn(async () => undefined)
    const provider = new OpenRouterProvider({ credential, fetch, diagnostic, sleep })

    await expect(provider.generateImage({
      model: 'image/model',
      prompt: 'draw',
      options: { count: 1, resolution: '1K', aspectRatio: 'auto', format: 'png' },
      references: [],
    })).rejects.toMatchObject({
      code: 'MODEL_PROVIDER_REQUEST_FAILED',
      message: 'The model provider request failed.',
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('RAW_PROVIDER_BODY')
    expect(JSON.stringify(diagnostic.mock.calls).length).toBeLessThan(2_000)
  })

  it.each([
    ['network TypeError', 'network'],
    ['HTTP 429', 429],
    ['HTTP 503', 503],
  ] as const)('attempts a paid video submission POST only once on %s', async (_description, failure) => {
    const diagnostic = vi.fn()
    const fetch = vi.fn(async () => {
      if (failure === 'network') throw new TypeError('socket closed')
      return new Response(JSON.stringify({
        error: {
          code: failure,
          message: `RAW_PROVIDER_BODY_${'x'.repeat(3_000)}`,
          metadata: { error_type: 'upstream_error' },
        },
      }), { status: failure })
    })
    const sleep = vi.fn(async () => undefined)
    const provider = new OpenRouterProvider({ credential, fetch, diagnostic, sleep })

    await expect(provider.submitVideo({
      model: 'video/model',
      prompt: 'animate',
      options: { durationSeconds: 5, resolution: '720p', aspectRatio: 'auto', generateAudio: false },
      references: [],
    })).rejects.toMatchObject({
      code: 'MODEL_PROVIDER_REQUEST_FAILED',
      message: 'The model provider request failed.',
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('RAW_PROVIDER_BODY')
    expect(JSON.stringify(diagnostic.mock.calls).length).toBeLessThan(2_000)
  })

  it.each([
    ['network TypeError', 'network'],
    ['HTTP 429', 429],
    ['HTTP 503', 503],
  ] as const)('attempts a paid audio-output POST only once on %s', async (_description, failure) => {
    const diagnostic = vi.fn()
    const fetch = vi.fn(async () => {
      if (failure === 'network') throw new TypeError('socket closed')
      return new Response(JSON.stringify({
        error: {
          code: failure,
          message: `RAW_PROVIDER_BODY_${'x'.repeat(3_000)}`,
          metadata: { error_type: 'upstream_error' },
        },
      }), { status: failure })
    })
    const sleep = vi.fn(async () => undefined)
    const provider = new OpenRouterProvider({ credential, fetch, diagnostic, sleep })

    await expect(collect(provider.stream({
      model: 'audio/model',
      messages: [{ role: 'user', content: '朗读' }],
      output: { type: 'audio', format: 'mp3' },
    }))).rejects.toMatchObject({
      code: 'MODEL_PROVIDER_REQUEST_FAILED',
      message: 'The model provider request failed.',
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('RAW_PROVIDER_BODY')
    expect(JSON.stringify(diagnostic.mock.calls).length).toBeLessThan(2_000)
  })

  it('keeps bounded retries for idempotent video polling', async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError('socket closed'))
      .mockResolvedValueOnce(new Response('busy', { status: 429 }))
      .mockResolvedValueOnce(new Response('down', { status: 503 }))
      .mockResolvedValueOnce(Response.json({ id: 'job_1', status: 'pending' }))
    const sleep = vi.fn(async () => undefined)
    const provider = new OpenRouterProvider({ credential, fetch, sleep, random: () => 0 })

    await expect(provider.pollVideo('job_1')).resolves.toEqual({ status: 'pending' })
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(sleep).toHaveBeenCalledTimes(3)
  })

  it('treats an extra-key diagnostic envelope as malformed while keeping safe HTTP mapping', async () => {
    const diagnostic = vi.fn()
    const provider = new OpenRouterProvider({
      credential,
      fetch: vi.fn(async () => Response.json({
        error: {
          code: 'RAW_NESTED_CODE',
          message: 'RAW_NESTED_MESSAGE',
          error_type: 'RAW_NESTED_TYPE',
        },
        unexpected: true,
      }, { status: 403 })),
      diagnostic,
    })

    await expect(provider.downloadVideo('job_1')).rejects.toMatchObject({
      code: 'MODEL_PROVIDER_ACCESS_DENIED',
      message: 'The model provider denied access.',
    })
    expect(diagnostic).toHaveBeenCalledWith({ operation: 'video', status: 403 })
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('RAW_NESTED')
  })

  it('rejects a non-2xx video download after draining only bounded diagnostics', async () => {
    let cancelled = false
    const encoder = new TextEncoder()
    const fetch = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(JSON.stringify({
          error: { code: 403, message: `RAW_DOWNLOAD_BODY_${'x'.repeat(3_000)}` },
        })))
      },
      cancel() { cancelled = true },
    }), { status: 403 }))
    const diagnostic = vi.fn()
    const provider = new OpenRouterProvider({ credential, fetch, diagnostic })

    await expect(provider.downloadVideo('job_1')).rejects.toMatchObject({
      code: 'MODEL_PROVIDER_ACCESS_DENIED',
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(cancelled).toBe(true)
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('RAW_DOWNLOAD_BODY')
  })

  it('maps malformed and oversized media JSON to a fixed safe error', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('{"data":[', {
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('{}', {
        headers: { 'content-length': String(40 * 1024 * 1024) },
      }))
      .mockResolvedValueOnce(Response.json({ id: 'different-job', status: 'pending' }))
    const provider = new OpenRouterProvider({ credential, fetch })
    const request = {
      model: 'image/model',
      prompt: 'draw',
      options: { count: 1 as const, resolution: '1K', aspectRatio: 'auto', format: 'png' },
      references: [],
    }

    await expect(provider.generateImage(request)).rejects.toMatchObject({ code: 'MODEL_PROVIDER_REQUEST_FAILED' })
    await expect(provider.generateImage(request)).rejects.toMatchObject({ code: 'MODEL_PROVIDER_REQUEST_FAILED' })
    await expect(provider.pollVideo('job_1')).rejects.toMatchObject({ code: 'MODEL_PROVIDER_REQUEST_FAILED' })
  })

  it('propagates cancellation before credential access, during fetch, and during retry backoff', async () => {
    const preAborted = new AbortController()
    preAborted.abort()
    const preCredential = { get: vi.fn(async () => 'sk-private') }
    const preFetch = vi.fn(async () => Response.json({ data: [] }))
    const preProvider = new OpenRouterProvider({ credential: preCredential, fetch: preFetch })
    const request = {
      model: 'image/model',
      prompt: 'draw',
      options: { count: 1 as const, resolution: '1K', aspectRatio: 'auto', format: 'png' },
      references: [],
      signal: preAborted.signal,
    }

    await expect(preProvider.generateImage(request)).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(preCredential.get).not.toHaveBeenCalled()
    expect(preFetch).not.toHaveBeenCalled()

    const duringFetch = new AbortController()
    const abortingFetch = vi.fn(async () => {
      duringFetch.abort()
      throw new DOMException('aborted', 'AbortError')
    })
    const fetchProvider = new OpenRouterProvider({ credential, fetch: abortingFetch })
    await expect(fetchProvider.generateImage({ ...request, signal: duringFetch.signal }))
      .rejects.toMatchObject({ code: 'CANCELLED' })
    expect(abortingFetch).toHaveBeenCalledTimes(1)

    const duringBackoff = new AbortController()
    const backoffFetch = vi.fn(async () => new Response('busy', { status: 503 }))
    const sleep = vi.fn(async (_milliseconds: number, signal?: AbortSignal) => {
      duringBackoff.abort()
      expect(signal?.aborted).toBe(true)
      throw new DOMException('aborted', 'AbortError')
    })
    const backoffProvider = new OpenRouterProvider({ credential, fetch: backoffFetch, sleep })
    await expect(backoffProvider.pollVideo('job_1', duringBackoff.signal))
      .rejects.toMatchObject({ code: 'CANCELLED' })
    expect(backoffFetch).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('maps cancellation while reading a media JSON body to CANCELLED', async () => {
    const controller = new AbortController()
    const encoder = new TextEncoder()
    let emitted = false
    const fetch = vi.fn(async () => new Response(new ReadableStream({
      pull(streamController) {
        if (!emitted) {
          emitted = true
          controller.abort()
          streamController.enqueue(encoder.encode('{"data":['))
        } else {
          streamController.error(new DOMException('aborted', 'AbortError'))
        }
      },
    })))
    const provider = new OpenRouterProvider({ credential, fetch })

    await expect(provider.generateImage({
      model: 'image/model',
      prompt: 'draw',
      options: { count: 1, resolution: '1K', aspectRatio: 'auto', format: 'png' },
      references: [],
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('maps cancellation while draining a media error diagnostic to CANCELLED', async () => {
    const controller = new AbortController()
    const encoder = new TextEncoder()
    let readerCancelled = false
    const fetch = vi.fn(async () => new Response(new ReadableStream({
      start(streamController) {
        streamController.enqueue(encoder.encode('{"error":'))
      },
      pull() {
        queueMicrotask(() => controller.abort())
        return new Promise(() => undefined)
      },
      cancel() { readerCancelled = true },
    }, { highWaterMark: 0 }), { status: 403 }))
    const provider = new OpenRouterProvider({ credential, fetch })

    await expect(provider.downloadVideo('job_1', controller.signal))
      .rejects.toMatchObject({ code: 'CANCELLED' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(readerCancelled).toBe(true)
  })

  it.each([
    ['range zero', { type: 'range', min: 0, max: 0 }, 1],
    ['range one', { type: 'range', min: 1, max: 1 }, 1],
    ['range ten', { type: 'range', min: 1, max: 10 }, 10],
    ['range above global maximum', { type: 'range', min: 1, max: 11 }, 10],
    ['range unsafe maximum', { type: 'range', min: 1, max: Number.MAX_SAFE_INTEGER + 1 }, 1],
    ['range reversed', { type: 'range', min: 10, max: 1 }, 1],
    ['enum zero', { type: 'enum', values: [0] }, 1],
    ['enum one', { type: 'enum', values: [1] }, 1],
    ['enum ten', { type: 'enum', values: [10] }, 10],
    ['enum above global maximum', { type: 'enum', values: [11] }, 1],
    ['enum unsafe value', { type: 'enum', values: [Number.MAX_SAFE_INTEGER + 1] }, 1],
  ] as const)('bounds image count for %s', (_case, descriptor, expected) => {
    const [model] = parseOpenRouterImageModels({ data: [{
      id: 'image/model',
      name: 'Image model',
      supported_parameters: { n: descriptor },
    }] })

    expect(model?.generation.image?.maxCount).toBe(expected)
  })

  it('merges duplicate dedicated image IDs independently of record order', () => {
    const first = {
      id: 'duplicate/image',
      name: 'Same image model',
      architecture: { input_modalities: ['text'], output_modalities: ['image'] },
      supported_parameters: {
        resolution: { type: 'enum', values: ['2K'] },
        aspect_ratio: { type: 'enum', values: ['16:9'] },
        output_format: { type: 'enum', values: ['png'] },
        n: { type: 'range', min: 1, max: 2 },
      },
    }
    const second = {
      id: 'duplicate/image',
      name: 'Same image model',
      architecture: { input_modalities: ['image'], output_modalities: ['image'] },
      supported_parameters: {
        resolution: { type: 'enum', values: ['1K'] },
        aspect_ratio: { type: 'enum', values: ['1:1'] },
        output_format: { type: 'enum', values: ['jpeg'] },
        n: { type: 'range', min: 1, max: 4 },
      },
    }
    const expected = [{
      id: 'duplicate/image',
      name: 'Same image model',
      inputModalities: ['text', 'image'],
      outputModalities: ['image'],
      supportsTools: false,
      generation: {
        image: {
          resolutions: ['1K', '2K'],
          aspectRatios: ['16:9', '1:1'],
          formats: ['jpeg', 'png'],
          maxCount: 4,
        },
      },
    }]

    expect(parseOpenRouterImageModels({ data: [first, second] })).toEqual(expected)
    expect(parseOpenRouterImageModels({ data: [second, first] })).toEqual(expected)
  })

  it('merges duplicate dedicated video IDs independently of record order', () => {
    const first = {
      id: 'duplicate/video',
      name: 'Same video model',
      supported_resolutions: ['1080p'],
      supported_aspect_ratios: ['16:9'],
      supported_durations: [10],
      supported_frame_images: null,
      generate_audio: null,
    }
    const second = {
      id: 'duplicate/video',
      name: 'Same video model',
      supported_resolutions: ['720p'],
      supported_aspect_ratios: ['9:16'],
      supported_durations: [5],
      supported_frame_images: ['first_frame'],
      generate_audio: true,
    }
    const expected = [{
      id: 'duplicate/video',
      name: 'Same video model',
      inputModalities: ['text', 'image'],
      outputModalities: ['video'],
      supportsTools: false,
      generation: {
        video: {
          resolutions: ['1080p', '720p'],
          aspectRatios: ['16:9', '9:16'],
          durations: [5, 10],
          supportsAudio: true,
        },
      },
    }]

    expect(parseOpenRouterVideoModels({ data: [first, second] })).toEqual(expected)
    expect(parseOpenRouterVideoModels({ data: [second, first] })).toEqual(expected)
  })

  it('parses nullable live video catalog fields into truthful prompt and generation capabilities', () => {
    const models = parseOpenRouterVideoModels(openRouterVideoModelsLiveFixture)

    expect(models).toHaveLength(4)
    expect(models.find(({ id }) => id === 'kwaivgi/kling-v3.0-std')).toEqual({
      id: 'kwaivgi/kling-v3.0-std',
      name: 'Kling: Video v3.0 Standard',
      inputModalities: ['text', 'image'],
      outputModalities: ['video'],
      supportsTools: false,
      generation: {
        video: {
          resolutions: ['720p'],
          aspectRatios: ['16:9', '1:1', '9:16'],
          durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
          supportsAudio: true,
        },
      },
    })
    expect(models.find(({ id }) => id === 'openai/sora-2-pro')).toMatchObject({
      inputModalities: ['text'],
      outputModalities: ['video'],
      generation: { video: { supportsAudio: true } },
    })
    expect(models.find(({ id }) => id === 'alibaba/happyhorse-1.1')).toMatchObject({
      inputModalities: ['text', 'image'],
      generation: { video: { supportsAudio: false } },
    })
    expect(models.find(({ id }) => id === 'x-ai/grok-imagine-video-1.5')).toMatchObject({
      inputModalities: ['text', 'image'],
      generation: { video: { aspectRatios: [], supportsAudio: false } },
    })
  })

  it('filters, bounds, sorts, and deduplicates video capability values per record', () => {
    const models = parseOpenRouterVideoModels({ data: [
      {
        id: 'video/filtered',
        name: 'Filtered video',
        supported_resolutions: ['720p', '', '1080p', '720p', 42, 'x'.repeat(129)],
        supported_aspect_ratios: ['9:16', '16:9', '9:16', null],
        supported_durations: [10, 5, 10, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '5'],
        supported_frame_images: ['', 'first_frame', 'first_frame', 42],
        generate_audio: false,
      },
      {
        id: 'video/oversized',
        name: 'Oversized video',
        supported_resolutions: Array.from({ length: 65 }, () => '720p'),
      },
    ] })

    expect(models).toEqual([{
      id: 'video/filtered',
      name: 'Filtered video',
      inputModalities: ['text', 'image'],
      outputModalities: ['video'],
      supportsTools: false,
      generation: {
        video: {
          resolutions: ['1080p', '720p'],
          aspectRatios: ['16:9', '9:16'],
          durations: [5, 10],
          supportsAudio: false,
        },
      },
    }])
  })

  it('bounds merged duplicate video capability arrays after normalization', () => {
    const models = parseOpenRouterVideoModels({ data: [
      {
        id: 'video/bounded-merge',
        name: 'Bounded merge',
        supported_resolutions: Array.from({ length: 64 }, (_, index) => `r${String(index).padStart(3, '0')}`),
        supported_aspect_ratios: Array.from({ length: 64 }, (_, index) => `a${String(index).padStart(3, '0')}`),
        supported_durations: Array.from({ length: 64 }, (_, index) => index + 1),
      },
      {
        id: 'video/bounded-merge',
        name: 'Bounded merge',
        supported_resolutions: Array.from({ length: 64 }, (_, index) => `r${String(index + 64).padStart(3, '0')}`),
        supported_aspect_ratios: Array.from({ length: 64 }, (_, index) => `a${String(index + 64).padStart(3, '0')}`),
        supported_durations: Array.from({ length: 64 }, (_, index) => index + 65),
      },
    ] })
    const capability = models[0]?.generation.video

    expect(capability?.resolutions).toHaveLength(64)
    expect(capability?.resolutions.at(0)).toBe('r000')
    expect(capability?.resolutions.at(-1)).toBe('r063')
    expect(capability?.aspectRatios).toHaveLength(64)
    expect(capability?.aspectRatios.at(0)).toBe('a000')
    expect(capability?.aspectRatios.at(-1)).toBe('a063')
    expect(capability?.durations).toHaveLength(64)
    expect(capability?.durations.at(0)).toBe(1)
    expect(capability?.durations.at(-1)).toBe(64)
  })

  it('preserves dedicated-only models without inventing missing image inputs', () => {
    const image = parseOpenRouterImageModels({ data: [{
      id: 'dedicated-only/image',
      name: 'Dedicated image',
      supported_parameters: {},
    }] })
    const video = parseOpenRouterVideoModels({ data: [{
      id: 'dedicated-only/video',
      name: 'Dedicated video',
      supported_frame_images: null,
    }] })

    expect(mergeOpenRouterModels([], [image, video])).toEqual([
      expect.objectContaining({
        id: 'dedicated-only/image',
        inputModalities: [],
        outputModalities: ['image'],
      }),
      expect.objectContaining({
        id: 'dedicated-only/video',
        inputModalities: ['text'],
        outputModalities: ['video'],
      }),
    ])
  })

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

  it('converts verified image, audio, and video content and requests audio output', async () => {
    const fetch = vi.fn(async (...request: Parameters<typeof globalThis.fetch>) => {
      void request
      return sseResponse([
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      ])
    })
    const provider = new OpenRouterProvider({ credential, fetch })

    await collect(provider.stream({
      model: 'audio-model',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '描述这些媒体' },
          { type: 'media', kind: 'image', mimeType: 'image/png', dataBase64: 'iVBORw==' },
          { type: 'media', kind: 'audio', mimeType: 'audio/mpeg', dataBase64: 'AQID' },
          { type: 'media', kind: 'video', mimeType: 'video/mp4', dataBase64: 'AAAA' },
        ],
      }],
      output: { type: 'audio', voice: 'alloy', format: 'mp3' },
    }))

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      model: 'audio-model',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '描述这些媒体' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw==' } },
          { type: 'input_audio', input_audio: { data: 'AQID', format: 'mp3' } },
          { type: 'video_url', video_url: { url: 'data:video/mp4;base64,AAAA' } },
        ],
      }],
      stream: true,
      stream_options: { include_usage: true },
      modalities: ['text', 'audio'],
      audio: { voice: 'alloy', format: 'mp3' },
    })
  })

  it.each([
    ['an image part with audio MIME', { kind: 'image', mimeType: 'audio/mpeg' }],
    ['an audio part with an unsupported MIME', { kind: 'audio', mimeType: 'audio/aac' }],
    ['a video part with image MIME', { kind: 'video', mimeType: 'image/png' }],
  ] as const)('rejects %s before fetching', async (_description, media) => {
    const fetch = vi.fn(async () => sseResponse([]))
    const provider = new OpenRouterProvider({ credential, fetch })

    await expect(collect(provider.stream({
      model: 'media-model',
      messages: [{
        role: 'user',
        content: [{ type: 'media', ...media, dataBase64: 'AQID' }],
      }],
    }))).rejects.toMatchObject({ code: 'MODEL_MODALITY_UNSUPPORTED' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['non-array structured content', { type: 'text', text: 'not wrapped in an array' }],
    ['an unknown part type', [{ type: 'bogus', kind: 'image', mimeType: 'image/png', dataBase64: 'AQID' }]],
    ['an unknown media kind', [{ type: 'media', kind: 'document', mimeType: 'video/mp4', dataBase64: 'AQID' }]],
    ['a text part without text', [{ type: 'text' }]],
    ['a media part without MIME', [{ type: 'media', kind: 'image', dataBase64: 'AQID' }]],
    ['a media part without data', [{ type: 'media', kind: 'image', mimeType: 'image/png' }]],
  ])('rejects %s before reading credentials or fetching', async (_description, content) => {
    const localCredential = { get: vi.fn(async () => 'sk-private') }
    const fetch = vi.fn(async () => sseResponse([]))
    const provider = new OpenRouterProvider({ credential: localCredential, fetch })

    const error = await rejection(provider.stream({
      model: 'media-model',
      messages: [{ role: 'user', content } as never],
    }))

    expect(error).toMatchObject({
      code: 'INVALID_INPUT',
      message: 'The request is invalid.',
    })
    expect(localCredential.get).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['audio/mpeg', 'mp3'],
    ['audio/wav', 'wav'],
    ['audio/ogg', 'ogg'],
    ['audio/flac', 'flac'],
    ['audio/mp4', 'm4a'],
  ] as const)('maps verified %s input to exact %s wire format', async (mimeType, format) => {
    const bodies: unknown[] = []
    const provider = new OpenRouterProvider({
      credential,
      fetch: vi.fn(async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return sseResponse([
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        ])
      }),
    })

    await collect(provider.stream({
      model: 'audio-model',
      messages: [{
        role: 'user',
        content: [{ type: 'media', kind: 'audio', mimeType, dataBase64: 'AQID' }],
      }],
    }))

    expect(bodies).toEqual([
      expect.objectContaining({
        messages: [{
          role: 'user',
          content: [{ type: 'input_audio', input_audio: { data: 'AQID', format } }],
        }],
      }),
    ])
  })

  it('emits audio chunks in stream order while preserving text and usage events', async () => {
    const provider = new OpenRouterProvider({
      credential,
      fetch: vi.fn(async () => sseResponse([
        'data: {"id":"audio_1","choices":[{"index":0,"delta":{"audio":{"data":"AQI=","transcript":"你"}}}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{"content":"文本","audio":{"data":"AwQ=","transcript":"好"}},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\n',
        'data: [DONE]\n\n',
      ])),
    })

    const result = await collect(provider.stream({
      model: 'audio-model',
      messages: [{ role: 'user', content: '朗读' }],
      output: { type: 'audio', format: 'wav' },
    }))

    expect(result).toEqual([
      { type: 'generation', id: 'audio_1' },
      { type: 'audio_delta', choiceIndex: 0, dataBase64: 'AQI=', transcript: '你' },
      { type: 'text_delta', choiceIndex: 0, text: '文本' },
      { type: 'audio_delta', choiceIndex: 0, dataBase64: 'AwQ=', transcript: '好' },
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
      { type: 'usage', inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    ])
  })

  it('does not retry a paid audio-output POST after a streamed network failure', async () => {
    const fetch = vi.fn(async () => {
      const encoder = new TextEncoder()
      let emitted = false
      return new Response(new ReadableStream({
        pull(controller) {
          if (!emitted) {
            emitted = true
            controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"audio":{"data":"AQI="}}}]}\n\n'))
          } else {
            controller.error(new TypeError('socket closed'))
          }
        },
      }))
    })
    const provider = new OpenRouterProvider({
      credential,
      sleep: async () => undefined,
      fetch,
    })

    await expect(collect(provider.stream({
      model: 'audio-model',
      messages: [{ role: 'user', content: '朗读' }],
      output: { type: 'audio', format: 'wav' },
    }))).rejects.toMatchObject({ code: 'MODEL_PROVIDER_REQUEST_FAILED' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      'invalid JSON',
      'RAW_JSON_SECRET',
      'data: {"choices":[RAW_JSON_SECRET\n\n',
    ],
    [
      'schema-invalid audio',
      'RAW_AUDIO_SECRET',
      'data: {"choices":[{"index":0,"delta":{"audio":{"data":42,"transcript":"RAW_AUDIO_SECRET"}}}]}\n\n',
    ],
    [
      'an incomplete tool fragment',
      'RAW_TOOL_SECRET',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"RAW_TOOL_SECRET","function":{"arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    ],
  ])('maps %s to a fixed safe error and cancels the reader', async (_description, marker, payload) => {
    const encoder = new TextEncoder()
    let readerCancelled = false
    const fetch = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(payload))
      },
      cancel() { readerCancelled = true },
    })))
    const provider = new OpenRouterProvider({ credential, fetch })

    const error = await rejection(provider.stream({ model: 'm', messages: [] }))

    expect(error).toMatchObject({
      code: 'MODEL_PROVIDER_REQUEST_FAILED',
      message: 'The model provider request failed.',
    })
    expect(JSON.stringify(error)).not.toContain(marker)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(readerCancelled).toBe(true)
  })

  it.each([
    [
      'text',
      'data: {"choices":[{"index":0,"delta":{"content":"SAFE"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"RAW_TEXT_DIVERGENCE"}}]}\n\n',
      'RAW_TEXT_DIVERGENCE',
    ],
    [
      'audio',
      'data: {"choices":[{"index":0,"delta":{"audio":{"data":"AQI="}}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"audio":{"data":"UkFXX0FVRElPX0RJVkVSR0VOQ0U="}}}]}\n\n',
      'RAW_AUDIO_DIVERGENCE',
    ],
  ])('maps divergent %s replay to a fixed safe error and cancels the replay reader', async (
    _kind,
    firstPayload,
    divergentPayload,
    marker,
  ) => {
    const encoder = new TextEncoder()
    let attempt = 0
    let replayReaderCancelled = false
    const fetch = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) {
        let emitted = false
        return new Response(new ReadableStream({
          pull(controller) {
            if (!emitted) {
              emitted = true
              controller.enqueue(encoder.encode(firstPayload))
            } else {
              controller.error(new TypeError('socket closed'))
            }
          },
        }))
      }
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(divergentPayload))
        },
        cancel() { replayReaderCancelled = true },
      }))
    })
    const provider = new OpenRouterProvider({
      credential,
      fetch,
      sleep: async () => undefined,
    })

    const error = await rejection(provider.stream({ model: 'm', messages: [] }))

    expect(error).toMatchObject({
      code: 'MODEL_PROVIDER_REQUEST_FAILED',
      message: 'The model provider request failed.',
    })
    expect(JSON.stringify(error)).not.toContain(marker)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(replayReaderCancelled).toBe(true)
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
          {
            id: 'shared/model ',
            name: 'Whitespace variant must not merge',
            architecture: { output_modalities: ['image'] },
            supported_parameters: {
              resolution: { type: 'enum', values: ['whitespace-only'] },
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
          id: ' shared/model',
          name: 'Whitespace variant must not deduplicate',
          supported_parameters: [],
          architecture: { input_modalities: ['video'], output_modalities: ['video'] },
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
        id: '__proto__',
        name: 'Prototype key',
        inputModalities: [],
        outputModalities: ['image'],
        supportsTools: false,
        generation: {
          image: {
            resolutions: [],
            aspectRatios: [],
            formats: [],
            maxCount: 1,
          },
        },
      },
      {
        id: 'dedicated-only/image',
        name: 'Not authoritative',
        inputModalities: [],
        outputModalities: ['image'],
        supportsTools: false,
        generation: {
          image: {
            resolutions: [],
            aspectRatios: [],
            formats: [],
            maxCount: 1,
          },
        },
      },
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
            supportsAudio: false,
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

  it('keeps valid dedicated records while isolating optional catalog and record failures', async () => {
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

    await expect(provider.listModels()).resolves.toEqual([
      {
        id: 'text/model',
        name: 'Text model',
        inputModalities: ['text'],
        outputModalities: ['text', 'video'],
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
        id: 'text/model-suffix',
        name: 'Wrong exact ID',
        inputModalities: ['text'],
        outputModalities: ['video'],
        supportsTools: false,
        generation: {
          video: {
            resolutions: ['4K'],
            aspectRatios: [],
            durations: [],
            supportsAudio: false,
          },
        },
      },
      {
        id: 'text/model/variant',
        name: 'Wrong exact ID',
        inputModalities: ['text'],
        outputModalities: ['video'],
        supportsTools: false,
        generation: {
          video: {
            resolutions: ['1080p'],
            aspectRatios: [],
            durations: [],
            supportsAudio: false,
          },
        },
      },
    ])
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

  it('cancels a slow general catalog body before optional discovery starts', async () => {
    const controller = new AbortController()
    const slow = abortingSlowJsonResponse(controller, { data: [] })
    const fetch = vi.fn(async () => (
      fetch.mock.calls.length === 1 ? slow.response : Response.json({ data: [] })
    ))
    const provider = new OpenRouterProvider({ credential, fetch })

    await expect(provider.listModels(controller.signal)).rejects.toMatchObject({
      code: 'CANCELLED',
      message: 'The operation was cancelled.',
    })
    expect(slow.wasCancelled()).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('cancels a slow credential-validation body instead of returning valid', async () => {
    const controller = new AbortController()
    const slow = abortingSlowJsonResponse(controller, { data: [] })
    const fetch = vi.fn(async () => slow.response)
    const provider = new OpenRouterProvider({ credential, fetch })

    await expect(provider.validateCredential(controller.signal)).rejects.toMatchObject({
      code: 'CANCELLED',
      message: 'The operation was cancelled.',
    })
    expect(slow.wasCancelled()).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
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
