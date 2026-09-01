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
  createProviderMediaProjection,
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

function protectedMediaFixture(
  purpose: 'image' | 'video',
  provider: ModelProvider,
) {
  let epoch = 3
  const prompt = purpose === 'image'
    ? 'make this image cinematic'
    : 'make a short harbor video'
  const authority = createProviderAttachmentDisclosureAuthority({ currentCredentialEpoch: () => epoch })
  const snapshot = sourceSnapshot(provider)
  const plan = authority.createPlan({
    requestId: `request_${purpose}`, text: prompt,
    context: { hasAttachments: true, requestedOutput: purpose, attachmentKinds: ['image'] },
    attachments: [{
      index: 0, id: 'asset_private', name: 'private.png', mimeType: 'image/png',
      byteSize: bytesA.length, fingerprint: fingerprintA,
    }],
  })
  const disclosure = authority.bindProvider(plan, snapshot)
  const projection = createProviderMediaProjection(disclosure, 'openrouter', purpose, prompt, [{
    assetId: 'asset_private', kind: 'image', mimeType: 'image/png', name: 'private.png',
    dataBase64: bytesA.toString('base64'),
  }])
  return {
    authority, disclosure, projection, prompt,
    protectedSnapshot: protectProviderSnapshot(snapshot, disclosure, { purpose: 'main' }),
    setEpoch: (value: number) => { epoch = value },
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
  it('requires an issued purpose-bound media projection before image or video Provider work', async () => {
    const generateImage = vi.fn<NonNullable<ModelProvider['generateImage']>>(async () => ({ outputs: [] }))
    const submitVideo = vi.fn<NonNullable<ModelProvider['submitVideo']>>(async () => ({
      providerJobId: 'job_1', status: 'pending',
    }))
    const provider = {
      listModels: async () => [], validateCredential: async () => ({ valid: true }),
      stream: async function* () {}, generateImage, submitVideo,
    }
    const authority = createProviderAttachmentDisclosureAuthority({ currentCredentialEpoch: () => 1 })
    const snapshot = sourceSnapshot(provider)
    const plan = authority.createPlan({
      requestId: 'request_media_projection', text: 'make this image cinematic',
      context: { hasAttachments: true, requestedOutput: 'image', attachmentKinds: ['image'] },
      attachments: [{
        index: 0, id: 'asset_private', name: 'private.png', mimeType: 'image/png',
        byteSize: bytesA.length, fingerprint: fingerprintA,
      }],
    })
    const disclosure = authority.bindProvider(plan, snapshot)
    const protectedSnapshot = protectProviderSnapshot(snapshot, disclosure, { purpose: 'main' })
    const inputs = [{
      assetId: 'asset_private', kind: 'image' as const, mimeType: 'image/png', name: 'private.png',
      dataBase64: bytesA.toString('base64'),
    }]
    const projection = createProviderMediaProjection(
      disclosure, 'openrouter', 'image', 'make this image cinematic', inputs,
    )
    await protectedSnapshot.provider.generateImage!({
      model: 'image-model', prompt: projection.prompt, options: {}, parameterSupport: {},
      references: projection.references,
    } as unknown as ModelImageRequest)

    await expect(protectedSnapshot.provider.generateImage!({
      model: 'image-model', prompt: 'changed prompt', options: {}, parameterSupport: {},
      references: projection.references,
    } as unknown as ModelImageRequest)).rejects.toThrow()
    await expect(protectedSnapshot.provider.generateImage!({
      model: 'image-model', prompt: projection.prompt, options: {}, parameterSupport: {},
      references: [{ mimeType: 'image/jpeg', dataBase64: bytesA.toString('base64') }],
    } as unknown as ModelImageRequest)).rejects.toThrow()
    await expect(protectedSnapshot.provider.submitVideo!({
      model: 'video-model', prompt: projection.prompt, options: {}, frameImages: [],
      references: projection.references,
    } as unknown as ModelVideoRequest)).rejects.toThrow()
    expect(generateImage).toHaveBeenCalledOnce()
    expect(submitVideo).not.toHaveBeenCalled()
  })

  it('makes ordinary title and summary capabilities text-only and purpose-separated', async () => {
    const stream = vi.fn<ModelProvider['stream']>(async function* () {})
    const value = fixture('ordinary', {
      listModels: async () => [], validateCredential: async () => ({ valid: true }), stream,
    })
    const title = protectProviderSnapshot(value.snapshot, value.disclosure, { purpose: 'title' })
    expect(() => title.provider.stream(request([{
      type: 'media', kind: 'image', mimeType: 'image/png', dataBase64: bytesA.toString('base64'),
    }]))).toThrow()
    await consume(title.provider.stream(request(value.disclosure.titleSafeText.text)))

    const summary = protectProviderSnapshot(value.snapshot, value.disclosure, { purpose: 'summary' })
    await consume(summary.provider.stream({
      model: 'model',
      messages: [
        { role: 'system', content: 'Summarize prior context.' },
        { role: 'user', content: 'The prior request described an image.' },
      ],
      maxOutputTokens: 64,
    }))
    expect(() => summary.provider.stream(request([{
      type: 'file', file: { filename: 'private.pdf', file_data: 'data:application/pdf;base64,QQ==' },
    }] as never))).toThrow()
    expect(() => assertProtectedProviderSnapshot(summary, value.disclosure, {
      ...binding(), purpose: 'main',
    })).toThrow()
    expect(stream).toHaveBeenCalledTimes(2)
  })

  it('releases one disclosure lease only after main and title work, then rejects every reuse', async () => {
    const stream = vi.fn<ModelProvider['stream']>(async function* () {})
    const value = fixture('local', {
      listModels: async () => [], validateCredential: async () => ({ valid: true }), stream,
    })
    const main = protectProviderSnapshot(value.snapshot, value.disclosure, { purpose: 'main' })
    const title = protectProviderSnapshot(value.snapshot, value.disclosure, { purpose: 'title' })
    expect(value.authority.activeCount('openrouter')).toBe(1)
    await consume(main.provider.stream(request(value.disclosure.mainSafeText.text)))
    await consume(title.provider.stream(request(value.disclosure.titleSafeText.text)))
    value.authority.release(value.disclosure)
    value.authority.release(value.disclosure)
    expect(value.authority.activeCount('openrouter')).toBe(0)
    expect(() => main.provider.stream(request(value.disclosure.mainSafeText.text))).toThrow()
    expect(() => title.provider.stream(request(value.disclosure.titleSafeText.text))).toThrow()
  })

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

  it('derives local main and title text only from structured conversion fields', () => {
    const authority = createProviderAttachmentDisclosureAuthority({ currentCredentialEpoch: () => 0 })
    const plan = authority.createPlan({
      requestId: 'request_canonical_local',
      text: 'See yes/no and /Users/Alice/Tax Return Records/private.pdf and other.pdf, then convert them to JPG',
      context: { hasAttachments: true, requestedOutput: 'text', attachmentKinds: ['file', 'file'] },
      attachments: [
        {
          index: 0, id: 'asset_private_a', name: 'private.pdf', mimeType: 'application/pdf',
          byteSize: bytesA.length, fingerprint: fingerprintA,
        },
        {
          index: 1, id: 'asset_private_b', name: 'other.pdf', mimeType: 'application/pdf',
          byteSize: bytesB.length, fingerprint: fingerprintB,
        },
      ],
    })

    expect(plan.access.decision).toBe('local')
    expect(plan.targetFormat).toBe('jpeg')
    expect(plan.selectedAttachmentIndexes).toEqual([0, 1])
    expect(plan.mainText).toBe([
      '任务：选择并调用具备 file.convert 能力的本地工作流。',
      '附件数量：2',
      '附件索引：0, 1',
      '目标格式：jpeg',
      '禁止读取附件内容或调用非 file.convert 工具。',
    ].join('\n'))
    expect(plan.titleText).toBe('本地文件转换 · 2 个附件 · JPEG')
    expect(`${plan.mainText}\n${plan.titleText}`).not.toMatch(
      /See|yes|no|Users|Alice|Tax|Return|Records|private|other|asset_/iu,
    )
  })

  it('binds a source-omitted command only to attachments supplied by the current request', () => {
    const authority = createProviderAttachmentDisclosureAuthority({ currentCredentialEpoch: () => 0 })
    const plan = authority.createPlan({
      requestId: 'request_implicit_current_attachments',
      text: '转换为 PDF',
      context: { hasAttachments: true, requestedOutput: 'text', attachmentKinds: ['image', 'image'] },
      attachments: [
        {
          index: 0, id: 'asset_current_a', name: 'current-a.png', mimeType: 'image/png',
          byteSize: bytesA.length, fingerprint: fingerprintA,
        },
        {
          index: 1, id: 'asset_current_b', name: 'current-b.png', mimeType: 'image/png',
          byteSize: bytesB.length, fingerprint: fingerprintB,
        },
      ],
    })

    expect(plan.access.decision).toBe('local')
    expect(plan.targetFormat).toBe('pdf')
    expect(plan.selectedAttachmentIndexes).toEqual([0, 1])
    expect(plan.mainText).toContain('附件索引：0, 1')
  })

  it.each([
    'convert this attachment to PDF, then save it as WebP',
    'convert this attachment not to PDF',
    'convert this attachment to DOCX',
  ])('keeps untrusted or conflicting conversion targets unbindable: %s', (text) => {
    const authority = createProviderAttachmentDisclosureAuthority({ currentCredentialEpoch: () => 0 })
    const plan = authority.createPlan({
      requestId: 'request_untrusted_target', text,
      context: { hasAttachments: true, requestedOutput: 'text', attachmentKinds: ['file'] },
      attachments: [{
        index: 0, id: 'asset_private', name: 'private.txt', mimeType: 'text/plain',
        byteSize: bytesA.length, fingerprint: fingerprintA,
      }],
    })

    expect(plan.access.decision).toBe('ambiguous')
    expect(plan.targetFormat).toBeUndefined()
  })

  it('does not issue a summary capability for local conversion disclosure', () => {
    const value = fixture('local')
    expect(() => protectProviderSnapshot(value.snapshot, value.disclosure, { purpose: 'summary' }))
      .toThrow('summary')
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
    const imageValue = protectedMediaFixture('image', provider)
    const videoValue = protectedMediaFixture('video', provider)
    const imageRequest = {
      model: 'image-model', prompt: imageValue.prompt, options: {}, parameterSupport: {},
      references: imageValue.projection.references,
    } as unknown as ModelImageRequest
    const videoRequest = {
      model: 'video-model', prompt: videoValue.prompt, options: {}, frameImages: [],
      references: videoValue.projection.references,
    } as unknown as ModelVideoRequest
    await Promise.all([
      imageValue.protectedSnapshot.provider.generateImage!(imageRequest),
      videoValue.protectedSnapshot.provider.submitVideo!(videoRequest),
    ])
    expect(Object.isFrozen(outboundImage?.references)).toBe(true)
    expect(Object.isFrozen(outboundVideo?.references)).toBe(true)
    await expect(imageValue.protectedSnapshot.provider.generateImage!({
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
    const value = protectedMediaFixture('image', {
      listModels: async () => [], validateCredential: async () => ({ valid: true }),
      stream: async function* () {}, generateImage,
    })
    const generating = value.protectedSnapshot.provider.generateImage!({
      model: 'image-model', prompt: value.prompt, options: {}, parameterSupport: {},
      references: value.projection.references,
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
