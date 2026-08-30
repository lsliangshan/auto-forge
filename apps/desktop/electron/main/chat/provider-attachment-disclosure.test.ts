import { createHash } from 'node:crypto'
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
import {
  assertAttachmentByteAccess,
  assertProtectedProviderSnapshot,
  createProviderAttachmentDisclosureAuthority,
  createProviderAttachmentProjection,
  protectProviderSnapshot,
  type ProviderAttachmentPurpose,
} from './provider-attachment-disclosure.js'

const bytesA = Buffer.from('private-a')
const bytesB = Buffer.from('private-b')
const fingerprintA = createHash('sha256').update(bytesA).digest('hex')
const fingerprintB = createHash('sha256').update(bytesB).digest('hex')

function sourceSnapshot(provider: ModelProvider, apiKeyFingerprint = 'fingerprint_test'): ModelProviderSnapshot {
  return { providerId: 'openrouter', provider, apiKeyFingerprint }
}

function fixture(
  decision: 'local' | 'ordinary',
  provider: ModelProvider = {
    listModels: async () => [], validateCredential: async () => ({ valid: true }),
    stream: async function* () {},
  },
) {
  let epoch = 3
  const authority = createProviderAttachmentDisclosureAuthority({
    currentCredentialEpoch: () => epoch,
  })
  const snapshot = sourceSnapshot(provider)
  const text = decision === 'ordinary' ? 'describe this image' : 'convert this attachment to PDF'
  const plan = authority.createPlan({
    requestId: 'request_1', text,
    context: { hasAttachments: true, requestedOutput: 'text', attachmentKinds: ['image'] },
    attachments: [{
      index: 0, id: 'asset_private', name: 'private.png', mimeType: 'image/png',
      byteSize: bytesA.length, fingerprint: fingerprintA,
      forbiddenValues: ['/Users/private/source.png', 'RAW_UTF8_CANARY', 'UkFXX0JBU0U2NF9DQU5BUlk='],
    }],
  })
  const disclosure = authority.bindProvider(plan, snapshot)
  return { authority, snapshot, plan, disclosure, setEpoch: (value: number) => { epoch = value } }
}

function protectedFixture(
  decision: 'local' | 'ordinary',
  provider?: ModelProvider,
  purpose: ProviderAttachmentPurpose = 'main',
) {
  const value = fixture(decision, provider)
  return {
    ...value,
    protectedSnapshot: protectProviderSnapshot(value.snapshot, value.disclosure, { purpose }),
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
    assetIds: ['asset_private'], assetFingerprints: [fingerprintA], purpose: 'main' as const,
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
  it('keeps an attachment-free ordinary Provider snapshot usable for context compression', async () => {
    const stream = vi.fn<ModelProvider['stream']>(async function* () {
      yield { type: 'text_delta', choiceIndex: 0, text: 'summary' }
      yield { type: 'finish', choiceIndex: 0, reason: 'stop' }
    })
    const provider = {
      listModels: async () => [], validateCredential: async () => ({ valid: true }), stream,
    }
    const authority = createProviderAttachmentDisclosureAuthority({ currentCredentialEpoch: () => 1 })
    const plan = authority.createPlan({
      requestId: 'request_no_assets', text: 'continue',
      context: { hasAttachments: false, requestedOutput: 'text', attachmentKinds: [] },
      attachments: [],
    })
    const snapshot = sourceSnapshot(provider)
    const disclosure = authority.bindProvider(plan, snapshot)
    const protectedSnapshot = protectProviderSnapshot(
      snapshot,
      disclosure,
      { purpose: 'main' },
    )
    await consume(protectedSnapshot.provider.stream({
      model: 'model', messages: [{ role: 'user', content: 'summarize prior messages' }],
      maxOutputTokens: 100,
    }))
    expect(stream).toHaveBeenCalledOnce()
  })

  it('atomically derives access and safe text while rejecting contradictory plans and ambiguous binding', () => {
    const provider = {
      listModels: async () => [], validateCredential: async () => ({ valid: true }),
      stream: async function* () {},
    }
    const snapshot = sourceSnapshot(provider)
    const authority = createProviderAttachmentDisclosureAuthority({ currentCredentialEpoch: () => 0 })
    expect(() => authority.createPlan({
      requestId: 'request_bad', text: 'describe this image',
      context: { hasAttachments: false, requestedOutput: 'text', attachmentKinds: ['image'] },
      attachments: [{
        index: 0, id: 'asset_private', name: 'private.png', mimeType: 'image/png',
        byteSize: bytesA.length, fingerprint: fingerprintA,
      }],
    })).toThrow('inconsistent')

    const ambiguous = authority.createPlan({
      requestId: 'request_ambiguous', text: 'reformat this image',
      context: { hasAttachments: true, requestedOutput: 'text', attachmentKinds: ['image'] },
      attachments: [{
        index: 0, id: 'asset_private', name: 'private.png', mimeType: 'image/png',
        byteSize: bytesA.length, fingerprint: fingerprintA,
      }],
    })
    expect(ambiguous.access).toEqual({ decision: 'ambiguous', allowProviderBytes: false })
    expect(ambiguous.mainText).toContain('文件-1')
    expect(() => authority.bindProvider(ambiguous, snapshot)).toThrow('cannot be bound')
  })

  it('rejects missing, forged, reordered, or changed-fingerprint byte authority', () => {
    const { disclosure } = fixture('ordinary')
    expect(() => assertAttachmentByteAccess(undefined, binding())).toThrow()
    expect(() => assertAttachmentByteAccess({ ...disclosure }, binding())).toThrow()
    expect(() => assertAttachmentByteAccess(disclosure, binding({ assetIds: ['asset_other'] }))).toThrow()
    expect(() => assertAttachmentByteAccess(disclosure, binding({ assetFingerprints: [fingerprintB] }))).toThrow()
    expect(() => assertAttachmentByteAccess(disclosure, binding())).not.toThrow()
  })

  it('binds the original Provider snapshot identity and distinct main/title purposes', () => {
    const { disclosure, protectedSnapshot } = protectedFixture('ordinary')
    expect(() => assertProtectedProviderSnapshot(protectedSnapshot, disclosure, binding({ purpose: 'title' })))
      .toThrow()
    expect(() => assertProtectedProviderSnapshot(protectedSnapshot, disclosure, binding())).not.toThrow()
    const otherSnapshot = sourceSnapshot({
      listModels: async () => [], validateCredential: async () => ({ valid: true }),
      stream: async function* () {},
    }, 'new_credential')
    expect(() => protectProviderSnapshot(otherSnapshot, disclosure, { purpose: 'main' })).toThrow()
  })

  it('issues one canonical projection only after ordered asset IDs and raw byte SHA match', () => {
    const { disclosure } = fixture('ordinary')
    const projection = createProviderAttachmentProjection(disclosure, 'openrouter', [{
      assetId: 'asset_private', kind: 'image', mimeType: 'image/png', name: 'private.png',
      dataBase64: bytesA.toString('base64'),
    }])
    expect(projection.content).toEqual([
      { type: 'text', text: 'describe this image' },
      { type: 'media', kind: 'image', mimeType: 'image/png', dataBase64: bytesA.toString('base64') },
    ])
    expect(() => createProviderAttachmentProjection(disclosure, 'openrouter', [{
      assetId: 'asset_private', kind: 'image', mimeType: 'image/png', name: 'private.png',
      dataBase64: bytesB.toString('base64'),
    }])).toThrow()
  })

  it('derives a text-file envelope from verified bytes and rejects A authority carrying B bytes', () => {
    const provider = {
      listModels: async () => [], validateCredential: async () => ({ valid: true }),
      stream: async function* () {},
    }
    const authority = createProviderAttachmentDisclosureAuthority({ currentCredentialEpoch: () => 0 })
    const snapshot = sourceSnapshot(provider)
    const plan = authority.createPlan({
      requestId: 'request_text', text: 'read this text file',
      context: { hasAttachments: true, requestedOutput: 'text', attachmentKinds: ['file'] },
      attachments: [{
        index: 0, id: 'asset_private', name: 'private.txt', mimeType: 'text/plain',
        byteSize: bytesA.length, fingerprint: fingerprintA,
      }],
    })
    const disclosure = authority.bindProvider(plan, snapshot)
    const projection = createProviderAttachmentProjection(disclosure, 'openrouter', [{
      assetId: 'asset_private', kind: 'file', mimeType: 'text/plain', name: 'private.txt',
      dataBase64: bytesA.toString('base64'),
    }])
    expect(JSON.stringify(projection.content)).toContain('附件内容开始')
    expect(JSON.stringify(projection.content)).toContain(bytesA.toString('utf8'))
    expect(() => createProviderAttachmentProjection(disclosure, 'openrouter', [{
      assetId: 'asset_private', kind: 'file', mimeType: 'text/plain', name: 'private.txt',
      dataBase64: bytesB.toString('base64'),
    }])).toThrow()
    for (const changed of [
      { kind: 'image' as const, mimeType: 'text/plain', name: 'private.txt' },
      { kind: 'file' as const, mimeType: 'application/octet-stream', name: 'private.txt' },
      { kind: 'file' as const, mimeType: 'text/plain', name: 'other.txt' },
    ]) {
      expect(() => createProviderAttachmentProjection(disclosure, 'openrouter', [{
        assetId: 'asset_private', dataBase64: bytesA.toString('base64'), ...changed,
      }])).toThrow('metadata')
    }
  })

  it('requires the exact issued projection on every ordinary stream/tool loop', async () => {
    const stream = vi.fn<ModelProvider['stream']>(async function* () {})
    const value = protectedFixture('ordinary', {
      listModels: async () => [], validateCredential: async () => ({ valid: true }), stream,
    })
    const projection = createProviderAttachmentProjection(value.disclosure, 'openrouter', [{
      assetId: 'asset_private', kind: 'image', mimeType: 'image/png', name: 'private.png',
      dataBase64: bytesA.toString('base64'),
    }])
    await consume(value.protectedSnapshot.provider.stream(request(projection.content as ModelContentPart[])))
    await consume(value.protectedSnapshot.provider.stream({
      model: 'model',
      messages: [
        { role: 'user', content: projection.content as ModelContentPart[] },
        { role: 'assistant', content: null, tool_calls: [] },
        { role: 'tool', content: 'done', tool_call_id: 'tool_1' },
      ],
    }))
    expect(() => value.protectedSnapshot.provider.stream(request([
      ...(projection.content as ModelContentPart[]),
      { type: 'media', kind: 'image', mimeType: 'image/png', dataBase64: bytesB.toString('base64') },
    ]))).toThrow()
    expect(stream).toHaveBeenCalledTimes(2)
  })

  it('copies at stream call time and revokes before first next without invoking the source', async () => {
    const stream = vi.fn<ModelProvider['stream']>(async function* () {})
    const value = protectedFixture('local', {
      listModels: async () => [], validateCredential: async () => ({ valid: true }), stream,
    })
    const original = request(value.disclosure.mainSafeText.text)
    const iterable = value.protectedSnapshot.provider.stream(original)
    original.messages[0]!.content = 'LATE_RAW_INJECTION'
    value.authority.revokeProvider('openrouter')
    value.setEpoch(4)
    await expect(consume(iterable)).rejects.toThrow('revoked')
    expect(stream).not.toHaveBeenCalled()
  })

  it('copies and freezes paid media requests and hashes every actual reference', async () => {
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
    const value = protectedFixture('ordinary', provider)
    const imageRequest = {
      model: 'image-model', prompt: 'paint', options: {}, parameterSupport: {},
      references: [{ mimeType: 'image/png', dataBase64: bytesA.toString('base64') }],
    } as unknown as ModelImageRequest
    const videoRequest = {
      model: 'video-model', prompt: 'animate', options: {}, frameImages: [],
      references: [{ mimeType: 'image/png', dataBase64: bytesA.toString('base64') }],
    } as unknown as ModelVideoRequest
    await Promise.all([
      value.protectedSnapshot.provider.generateImage!(imageRequest),
      value.protectedSnapshot.provider.submitVideo!(videoRequest),
    ])
    expect(Object.isFrozen(outboundImage?.references)).toBe(true)
    expect(Object.isFrozen(outboundVideo?.references)).toBe(true)
    await expect(value.protectedSnapshot.provider.generateImage!({
      ...imageRequest,
      references: [{ mimeType: 'image/png', dataBase64: bytesB.toString('base64') }],
    })).rejects.toThrow()
    expect(provider.generateImage).toHaveBeenCalledTimes(1)
  })

  it('aborts and rejects paid media when the credential epoch changes while awaiting the Provider', async () => {
    let release!: () => void
    const pending = new Promise<{ outputs: [] }>((resolve) => { release = () => resolve({ outputs: [] }) })
    let providerSignal: AbortSignal | undefined
    const generateImage = vi.fn<NonNullable<ModelProvider['generateImage']>>((request) => {
      providerSignal = request.signal
      return pending
    })
    const value = protectedFixture('ordinary', {
      listModels: async () => [], validateCredential: async () => ({ valid: true }),
      stream: async function* () {}, generateImage,
    })
    const generating = value.protectedSnapshot.provider.generateImage!({
      model: 'image-model', prompt: 'paint', options: {}, parameterSupport: {},
      references: [{ mimeType: 'image/png', dataBase64: bytesA.toString('base64') }],
    } as unknown as ModelImageRequest)
    expect(providerSignal).toBeDefined()
    value.authority.revokeProvider('openrouter')
    value.setEpoch(4)
    expect(providerSignal?.aborted).toBe(true)
    release()

    await expect(generating).rejects.toThrow('revoked')
    expect(generateImage).toHaveBeenCalledOnce()
  })

  it('allows local retries, rejects unsigned user text, and limits title capability to one use', async () => {
    const stream = vi.fn<ModelProvider['stream']>(async function* () {})
    const value = fixture('local', {
      listModels: async () => [], validateCredential: async () => ({ valid: true }), stream,
    })
    const main = protectProviderSnapshot(value.snapshot, value.disclosure, { purpose: 'main' })
    const title = protectProviderSnapshot(value.snapshot, value.disclosure, { purpose: 'title' })
    await consume(main.provider.stream(request(value.disclosure.mainSafeText.text)))
    await consume(main.provider.stream(request(value.disclosure.mainSafeText.text)))
    expect(() => main.provider.stream(request('UNLISTED_RAW_UTF8 QkFTRTY0'))).toThrow()
    await consume(title.provider.stream(request(value.disclosure.titleSafeText.text)))
    expect(() => title.provider.stream(request(value.disclosure.titleSafeText.text))).toThrow()
    expect(stream).toHaveBeenCalledTimes(3)
  })

  it('keeps local retry bodies metadata-only across network, 429, and 5xx failures', async () => {
    const bodies: string[] = []
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body))
      if (bodies.length === 1) throw new TypeError('network unavailable')
      if (bodies.length === 2) return new Response('busy', { status: 429 })
      if (bodies.length === 3) return new Response('down', { status: 503 })
      return new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    const provider = new OpenRouterProvider({
      credential: { get: async () => 'sk-private' }, fetch, random: () => 0,
      sleep: async () => undefined,
    })
    const value = fixture('local', provider)
    const snapshot = protectProviderSnapshot(value.snapshot, value.disclosure, { purpose: 'main' })
    await consume(snapshot.provider.stream(request(value.disclosure.mainSafeText.text)))
    expect(bodies).toHaveLength(4)
    expect(new Set(bodies).size).toBe(1)
    expect(bodies.join('')).not.toMatch(/RAW_UTF8_CANARY|UkFXX0JBUU2NF9DQU5BUlk=|asset_private|source\.png/)
  })
})
