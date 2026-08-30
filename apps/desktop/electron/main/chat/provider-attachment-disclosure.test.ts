import { describe, expect, it, vi } from 'vitest'
import type { ModelContentPart, ModelProvider, ModelStreamRequest } from './model-provider.js'
import { OpenRouterProvider } from './openrouter-provider.js'
import {
  assertAttachmentByteAccess,
  assertProtectedProviderSnapshot,
  createProviderAttachmentDisclosure,
  protectProviderSnapshot,
} from './provider-attachment-disclosure.js'

function disclosure(decision: 'local' | 'ordinary' | 'ambiguous') {
  return createProviderAttachmentDisclosure({
    requestId: 'request_1',
    providerId: 'openrouter',
    access: {
      decision,
      allowProviderBytes: decision === 'ordinary',
    },
    assetIds: ['asset_private'],
    assetFingerprints: ['f'.repeat(64)],
    forbiddenValues: [
      '/Users/private/source.txt',
      'asset_private',
      'f'.repeat(64),
      'RAW_UTF8_CANARY',
      'UkFXX0JBU0U2NF9DQU5BUlk=',
    ],
  })
}

function request(content: string | ModelContentPart[]): ModelStreamRequest {
  return { model: 'model', messages: [{ role: 'user', content }] }
}

async function consume(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of iterable) void _event
}

describe('provider attachment disclosure', () => {
  it('rejects missing or forged capabilities before attachment byte access', () => {
    expect(() => assertAttachmentByteAccess(undefined, {
      requestId: 'request_1', providerId: 'openrouter', assetIds: ['asset_private'],
    })).toThrow()
    expect(() => assertAttachmentByteAccess({
      ...disclosure('ordinary'),
    }, {
      requestId: 'request_1', providerId: 'openrouter', assetIds: ['asset_private'],
    })).toThrow()
  })

  it('binds an issued capability to request, provider, and ordered assets', () => {
    const issued = disclosure('ordinary')
    expect(() => assertAttachmentByteAccess(issued, {
      requestId: 'request_other', providerId: 'openrouter', assetIds: ['asset_private'],
    })).toThrow()
    expect(() => assertAttachmentByteAccess(issued, {
      requestId: 'request_1', providerId: 'deepseek', assetIds: ['asset_private'],
    })).toThrow()
    expect(() => assertAttachmentByteAccess(issued, {
      requestId: 'request_1', providerId: 'openrouter', assetIds: ['asset_other'],
    })).toThrow()
    expect(() => assertAttachmentByteAccess(issued, {
      requestId: 'request_1', providerId: 'openrouter', assetIds: ['asset_private'],
    })).not.toThrow()
  })

  it('binds a protected provider snapshot to the same request and asset set', () => {
    const issued = disclosure('ordinary')
    const snapshot = protectProviderSnapshot({
      providerId: 'openrouter',
      provider: {
        listModels: async () => [], validateCredential: async () => ({ valid: true }),
        stream: async function* () {},
      },
    }, issued)

    expect(() => assertProtectedProviderSnapshot(snapshot, issued, {
      requestId: 'request_other', providerId: 'openrouter', assetIds: ['asset_private'],
    })).toThrow()
    expect(() => assertProtectedProviderSnapshot(snapshot, issued, {
      requestId: 'request_1', providerId: 'openrouter', assetIds: ['asset_private'],
    })).not.toThrow()
  })

  it.each([
    [{ type: 'media', kind: 'image', mimeType: 'image/png', dataBase64: 'AAAA' }],
    [{ type: 'file', name: 'safe.txt', mimeType: 'text/plain', dataBase64: 'AAAA' }],
    [{ type: 'reference', sourceId: 'asset_private' }],
    [{ type: 'text', text: 'RAW_UTF8_CANARY' }],
    [{ type: 'text', text: 'UkFXX0JBU0U2NF9DQU5BUlk=' }],
  ])('rejects tainted structured or text content before provider stream: %j', async (content) => {
    const stream = vi.fn<ModelProvider['stream']>(async function* () {
      yield { type: 'finish', choiceIndex: 0, reason: 'stop' }
    })
    const snapshot = protectProviderSnapshot({
      providerId: 'openrouter',
      provider: {
        listModels: async () => [], validateCredential: async () => ({ valid: true }), stream,
      },
    }, disclosure('ambiguous'))

    await expect(consume(snapshot.provider.stream(request(content as never)))).rejects.toBeDefined()
    expect(stream).not.toHaveBeenCalled()
  })

  it.each(['local', 'ambiguous'] as const)(
    'blocks image and video provider methods for %s disclosure',
    async (decision) => {
      const generateImage = vi.fn<NonNullable<ModelProvider['generateImage']>>()
      const submitVideo = vi.fn<NonNullable<ModelProvider['submitVideo']>>()
      const snapshot = protectProviderSnapshot({
        providerId: 'openrouter',
        provider: {
          listModels: async () => [], validateCredential: async () => ({ valid: true }),
          stream: async function* () {}, generateImage, submitVideo,
        },
      }, disclosure(decision))

      await expect(snapshot.provider.generateImage!({} as never)).rejects.toBeDefined()
      await expect(snapshot.provider.submitVideo!({} as never)).rejects.toBeDefined()
      expect(generateImage).not.toHaveBeenCalled()
      expect(submitVideo).not.toHaveBeenCalled()
    },
  )

  it('revalidates every provider stream attempt with the same frozen capability', async () => {
    const stream = vi.fn<ModelProvider['stream']>(async function* () {
      yield { type: 'finish', choiceIndex: 0, reason: 'stop' }
    })
    const snapshot = protectProviderSnapshot({
      providerId: 'openrouter',
      provider: {
        listModels: async () => [], validateCredential: async () => ({ valid: true }), stream,
      },
    }, disclosure('ambiguous'))
    const safe = request('只询问目标格式，不读取附件。')

    await consume(snapshot.provider.stream(safe))
    await consume(snapshot.provider.stream(safe))
    expect(stream).toHaveBeenCalledTimes(2)
  })

  it('keeps every network retry body metadata-only across network, 429, and 5xx failures', async () => {
    const bodies: string[] = []
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body))
      if (bodies.length === 1) throw new TypeError('network unavailable')
      if (bodies.length === 2) return new Response('busy', { status: 429 })
      if (bodies.length === 3) return new Response('down', { status: 503 })
      return new Response('data: {"choices":[{"index":0,"delta":{"content":"请确认目标格式"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    const source = new OpenRouterProvider({
      credential: { get: async () => 'sk-private' },
      fetch,
      random: () => 0,
      sleep: async () => undefined,
    })
    const snapshot = protectProviderSnapshot({
      providerId: 'openrouter',
      provider: source,
      apiKeyFingerprint: 'fingerprint_test',
    }, disclosure('ambiguous'))

    await consume(snapshot.provider.stream(request('只澄清转换对象和目标格式。')))

    expect(bodies).toHaveLength(4)
    expect(new Set(bodies).size).toBe(1)
    for (const body of bodies) {
      expect(body).not.toMatch(/RAW_UTF8_CANARY|UkFXX0JBU0U2NF9DQU5BUlk=|asset_private|source\.txt/)
      expect(body).toContain('只澄清转换对象和目标格式')
    }
  })
})
