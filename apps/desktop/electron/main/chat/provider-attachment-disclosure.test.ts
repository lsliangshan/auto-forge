import { describe, expect, it, vi } from 'vitest'
import type {
  ModelContentPart,
  ModelImageRequest,
  ModelProvider,
  ModelProviderSnapshot,
  ModelStreamRequest,
  ModelVideoRequest,
} from './model-provider.js'
import { OpenRouterProvider } from './openrouter-provider.js'
import { providerAttachmentAccess } from './attachment-conversion-policy.js'
import {
  assertAttachmentByteAccess,
  assertProtectedProviderSnapshot,
  createProviderAttachmentDisclosure,
  createProviderAttachmentSafeText,
  protectProviderSnapshot,
  type ProviderAttachmentPurpose,
} from './provider-attachment-disclosure.js'

const fingerprint = 'f'.repeat(64)

function sourceSnapshot(provider: ModelProvider, apiKeyFingerprint = 'fingerprint_test'): ModelProviderSnapshot {
  return { providerId: 'openrouter', provider, apiKeyFingerprint }
}

function fixture(
  decision: 'local' | 'ordinary' | 'ambiguous',
  provider: ModelProvider = {
    listModels: async () => [], validateCredential: async () => ({ valid: true }),
    stream: async function* () {},
  },
  forbiddenValues: string[] = [
    '/Users/private/source.txt', 'asset_private', fingerprint,
    'RAW_UTF8_CANARY', 'UkFXX0JBU0U2NF9DQU5BUlk=',
  ],
) {
  const snapshot = sourceSnapshot(provider)
  const access = providerAttachmentAccess(decision, decision === 'ordinary'
    ? '描述这张图片'
    : decision === 'local' ? 'convert this attachment to PDF' : 'reformat attachment', {
    hasAttachments: true,
    requestedOutput: 'text',
    attachmentKinds: ['image'],
  })
  const disclosure = createProviderAttachmentDisclosure({
    requestId: 'request_1', providerSnapshot: snapshot, credentialEpoch: 3, access,
    assetIds: ['asset_private'], assetFingerprints: [fingerprint], forbiddenValues,
  })
  return { snapshot, disclosure }
}

function protectedFixture(
  decision: 'local' | 'ordinary' | 'ambiguous',
  provider?: ModelProvider,
  purpose: ProviderAttachmentPurpose = 'main',
) {
  const value = fixture(decision, provider)
  const safeText = createProviderAttachmentSafeText(value.disclosure, purpose, '只澄清转换目标。')
  return {
    ...value,
    safeText,
    protectedSnapshot: protectProviderSnapshot(value.snapshot, value.disclosure, { purpose, safeText }),
  }
}

function binding(overrides: Partial<{
  requestId: string
  providerId: 'openrouter' | 'deepseek'
  assetIds: string[]
  assetFingerprints: string[]
  purpose: ProviderAttachmentPurpose
}> = {}) {
  return {
    requestId: 'request_1', providerId: 'openrouter' as const,
    assetIds: ['asset_private'], assetFingerprints: [fingerprint], purpose: 'main' as const,
    ...overrides,
  }
}

function request(content: string | ModelContentPart[]): ModelStreamRequest {
  return { model: 'model', messages: [{ role: 'user', content }] }
}

async function consume(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of iterable) void _event
}

describe('provider attachment disclosure', () => {
  it('rejects contradictory or unissued access decisions', () => {
    const snapshot = sourceSnapshot({
      listModels: async () => [], validateCredential: async () => ({ valid: true }),
      stream: async function* () {},
    })
    expect(() => createProviderAttachmentDisclosure({
      requestId: 'request_1', providerSnapshot: snapshot, credentialEpoch: 0,
      access: { decision: 'ordinary', allowProviderBytes: false } as never,
      assetIds: ['asset_private'], assetFingerprints: [fingerprint], forbiddenValues: [],
    })).toThrow()
  })

  it('rejects missing or forged capabilities before attachment byte access', () => {
    expect(() => assertAttachmentByteAccess(undefined, binding())).toThrow()
    expect(() => assertAttachmentByteAccess({ ...fixture('ordinary').disclosure }, binding())).toThrow()
  })

  it('binds byte access to request, provider, ordered assets, and current fingerprints', () => {
    const { disclosure } = fixture('ordinary')
    expect(() => assertAttachmentByteAccess(disclosure, binding({ requestId: 'request_other' }))).toThrow()
    expect(() => assertAttachmentByteAccess(disclosure, binding({ providerId: 'deepseek' }))).toThrow()
    expect(() => assertAttachmentByteAccess(disclosure, binding({ assetIds: ['asset_other'] }))).toThrow()
    expect(() => assertAttachmentByteAccess(disclosure, binding({
      assetFingerprints: ['e'.repeat(64)],
    }))).toThrow()
    expect(() => assertAttachmentByteAccess(disclosure, binding())).not.toThrow()
  })

  it('rejects reordered and duplicated assets', () => {
    const snapshot = sourceSnapshot({
      listModels: async () => [], validateCredential: async () => ({ valid: true }),
      stream: async function* () {},
    })
    const access = providerAttachmentAccess('ordinary', '描述附件', {
      hasAttachments: true, requestedOutput: 'text', attachmentKinds: ['image', 'image'],
    })
    const disclosure = createProviderAttachmentDisclosure({
      requestId: 'request_1', providerSnapshot: snapshot, credentialEpoch: 0, access,
      assetIds: ['asset_1', 'asset_2'], assetFingerprints: ['1'.repeat(64), '2'.repeat(64)],
      forbiddenValues: [],
    })
    expect(() => assertAttachmentByteAccess(disclosure, {
      requestId: 'request_1', providerId: 'openrouter',
      assetIds: ['asset_2', 'asset_1'], assetFingerprints: ['2'.repeat(64), '1'.repeat(64)],
    })).toThrow()
    expect(() => createProviderAttachmentDisclosure({
      requestId: 'request_1', providerSnapshot: snapshot, credentialEpoch: 0, access,
      assetIds: ['asset_1', 'asset_1'], assetFingerprints: ['1'.repeat(64), '1'.repeat(64)],
      forbiddenValues: [],
    })).toThrow()
  })

  it('binds protected snapshots to original identity, request, assets, and purpose', () => {
    const { disclosure, protectedSnapshot } = protectedFixture('ordinary')
    expect(() => assertProtectedProviderSnapshot(protectedSnapshot, disclosure, binding({
      requestId: 'request_other',
    }))).toThrow()
    expect(() => assertProtectedProviderSnapshot(protectedSnapshot, disclosure, binding({
      purpose: 'title',
    }))).toThrow()
    expect(() => assertProtectedProviderSnapshot(protectedSnapshot, disclosure, binding())).not.toThrow()
  })

  it('rejects a different or newly credentialed snapshot identity', () => {
    const { disclosure } = fixture('ordinary')
    const otherSnapshot = sourceSnapshot({
      listModels: async () => [], validateCredential: async () => ({ valid: true }),
      stream: async function* () {},
    }, 'different_fingerprint')
    expect(() => protectProviderSnapshot(otherSnapshot, disclosure, { purpose: 'main' })).toThrow()
  })

  it('copies and freezes a stream request at stream() call time while preserving signal identity', async () => {
    let outbound: ModelStreamRequest | undefined
    const stream = vi.fn<ModelProvider['stream']>((value) => {
      outbound = value
      return (async function* () {
        expect(Object.isFrozen(value)).toBe(true)
        expect(Object.isFrozen(value.messages)).toBe(true)
        expect(Object.isFrozen(value.messages[0])).toBe(true)
        expect(() => { (value.messages[0] as { content: string }).content = 'MUTATED_BY_PROVIDER' }).toThrow()
        yield { type: 'finish', choiceIndex: 0, reason: 'stop' }
      })()
    })
    const provider = {
      listModels: async () => [], validateCredential: async () => ({ valid: true }), stream,
    }
    const { protectedSnapshot, safeText } = protectedFixture('ambiguous', provider)
    const controller = new AbortController()
    const original = { ...request(safeText.text), signal: controller.signal }
    const iterable = protectedSnapshot.provider.stream(original)
    original.messages[0]!.content = 'LATE_RAW_UTF8_INJECTION'
    await consume(iterable)

    expect(outbound?.messages[0]?.content).toBe('只澄清转换目标。')
    expect(outbound?.signal).toBe(controller.signal)
  })

  it('copies and freezes image and video requests before paid provider calls', async () => {
    let outboundImage: ModelImageRequest | undefined
    let outboundVideo: ModelVideoRequest | undefined
    const provider = {
      listModels: async () => [], validateCredential: async () => ({ valid: true }),
      stream: async function* () {},
      generateImage: vi.fn<NonNullable<ModelProvider['generateImage']>>(async (value) => {
        outboundImage = value
        return { outputs: [] }
      }),
      submitVideo: vi.fn<NonNullable<ModelProvider['submitVideo']>>(async (value) => {
        outboundVideo = value
        return { providerJobId: 'job_1', status: 'pending' }
      }),
    }
    const { protectedSnapshot } = protectedFixture('ordinary', provider)
    const imageRequest = {
      model: 'image-model', prompt: 'paint', options: {}, parameterSupport: {},
      references: [{ mimeType: 'image/png', dataBase64: 'AAAA' }],
    } as unknown as ModelImageRequest
    const videoRequest = {
      model: 'video-model', prompt: 'animate', options: {}, frameImages: [],
      references: [{ mimeType: 'image/png', dataBase64: 'AAAA' }],
    } as unknown as ModelVideoRequest

    const imagePromise = protectedSnapshot.provider.generateImage!(imageRequest)
    const videoPromise = protectedSnapshot.provider.submitVideo!(videoRequest)
    imageRequest.references[0]!.dataBase64 = 'LATE_IMAGE_MUTATION'
    videoRequest.references[0]!.dataBase64 = 'LATE_VIDEO_MUTATION'
    await Promise.all([imagePromise, videoPromise])

    expect(outboundImage?.references[0]?.dataBase64).toBe('AAAA')
    expect(outboundVideo?.references[0]?.dataBase64).toBe('AAAA')
    expect(Object.isFrozen(outboundImage?.references)).toBe(true)
    expect(Object.isFrozen(outboundVideo?.references)).toBe(true)
  })

  it('rejects unsigned raw UTF8 or Base64 even when absent from forbidden values', async () => {
    const provider = {
      listModels: async () => [], validateCredential: async () => ({ valid: true }),
      stream: vi.fn<ModelProvider['stream']>(async function* () {}),
    }
    const { snapshot, disclosure } = fixture('ambiguous', provider, [])
    const safeText = createProviderAttachmentSafeText(disclosure, 'main', '只澄清转换目标。')
    const protectedSnapshot = protectProviderSnapshot(snapshot, disclosure, { purpose: 'main', safeText })

    expect(() => protectedSnapshot.provider.stream(request('UNLISTED_RAW_UTF8 QkFTRTY0'))).toThrow()
    expect(provider.stream).not.toHaveBeenCalled()
  })

  it.each([
    [{ type: 'media', kind: 'image', mimeType: 'image/png', dataBase64: 'AAAA' }],
    [{ type: 'file', name: 'safe.txt', mimeType: 'text/plain', dataBase64: 'AAAA' }],
    [{ type: 'reference', sourceId: 'asset_private' }],
    [{ type: 'text', text: 'RAW_UTF8_CANARY' }],
    [{ type: 'text', text: 'UkFXX0JBU0U2NF9DQU5BUlk=' }],
  ])('rejects tainted structured or text content before provider stream: %j', (content) => {
    const provider = {
      listModels: async () => [], validateCredential: async () => ({ valid: true }),
      stream: vi.fn<ModelProvider['stream']>(async function* () {}),
    }
    const { protectedSnapshot } = protectedFixture('ambiguous', provider)

    expect(() => protectedSnapshot.provider.stream(request(content as never))).toThrow()
    expect(provider.stream).not.toHaveBeenCalled()
  })

  it.each(['local', 'ambiguous'] as const)(
    'blocks image and video provider methods for %s disclosure',
    async (decision) => {
      const generateImage = vi.fn<NonNullable<ModelProvider['generateImage']>>()
      const submitVideo = vi.fn<NonNullable<ModelProvider['submitVideo']>>()
      const provider = {
        listModels: async () => [], validateCredential: async () => ({ valid: true }),
        stream: async function* () {}, generateImage, submitVideo,
      }
      const { protectedSnapshot } = protectedFixture(decision, provider)

      await expect(protectedSnapshot.provider.generateImage!({} as never)).rejects.toBeDefined()
      await expect(protectedSnapshot.provider.submitVideo!({} as never)).rejects.toBeDefined()
      expect(generateImage).not.toHaveBeenCalled()
      expect(submitVideo).not.toHaveBeenCalled()
    },
  )

  it('allows main retries but prevents main/title purpose swaps and title reuse', async () => {
    const stream = vi.fn<ModelProvider['stream']>(async function* () {})
    const provider = { listModels: async () => [], validateCredential: async () => ({ valid: true }), stream }
    const value = fixture('ambiguous', provider)
    const mainText = createProviderAttachmentSafeText(value.disclosure, 'main', '只澄清转换目标。')
    const titleText = createProviderAttachmentSafeText(value.disclosure, 'title', '用户：匿名附件转换')
    const main = protectProviderSnapshot(value.snapshot, value.disclosure, { purpose: 'main', safeText: mainText })
    const title = protectProviderSnapshot(value.snapshot, value.disclosure, { purpose: 'title', safeText: titleText })

    await consume(main.provider.stream(request(mainText.text)))
    await consume(main.provider.stream(request(mainText.text)))
    expect(() => main.provider.stream(request(titleText.text))).toThrow()
    await consume(title.provider.stream(request(titleText.text)))
    expect(() => title.provider.stream(request(titleText.text))).toThrow()
    expect(stream).toHaveBeenCalledTimes(3)
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
    const provider = new OpenRouterProvider({
      credential: { get: async () => 'sk-private' }, fetch, random: () => 0,
      sleep: async () => undefined,
    })
    const value = fixture('ambiguous', provider)
    const safeText = createProviderAttachmentSafeText(value.disclosure, 'main', '只澄清转换对象和目标格式。')
    const snapshot = protectProviderSnapshot(value.snapshot, value.disclosure, { purpose: 'main', safeText })

    await consume(snapshot.provider.stream(request(safeText.text)))

    expect(bodies).toHaveLength(4)
    expect(new Set(bodies).size).toBe(1)
    for (const body of bodies) {
      expect(body).not.toMatch(/RAW_UTF8_CANARY|UkFXX0JBU0U2NF9DQU5BUlk=|asset_private|source\.txt/)
      expect(body).toContain('只澄清转换对象和目标格式')
    }
  })
})
