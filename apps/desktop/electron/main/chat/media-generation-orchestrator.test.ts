import { Buffer } from 'node:buffer'
import type { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type {
  ChatBlock,
  ChatEvent,
  GenerationOptions,
  MediaAsset,
} from '@autoforge/shared'
import type { AgentPersistencePort } from '../agent/agent-orchestrator.js'
import type {
  GeneratedAssetWriter,
  MediaAssetService,
} from '../media/media-asset-service.js'
import type { ModelProvider } from './model-provider.js'
import {
  MediaGenerationOrchestrator,
  type MediaGenerationOrchestratorDependencies,
} from './media-generation-orchestrator.js'
import type { ResolvedChatRoute } from './multimodal-router.js'

const generation: GenerationOptions = {
  image: { count: 1, resolution: '1K', aspectRatio: 'auto', format: 'png' },
  audio: { format: 'mp3' },
  video: { durationSeconds: 5, resolution: '720p', aspectRatio: 'auto', generateAudio: false },
}

const imageRoute: ResolvedChatRoute = {
  provider: 'openrouter',
  model: 'image-model',
  supportsTools: false,
  outputType: 'image',
  assets: [],
  generation,
}

const audioRoute: ResolvedChatRoute = {
  provider: 'openrouter',
  model: 'audio-model',
  supportsTools: false,
  outputType: 'audio',
  assets: [],
  generation,
}

const imageAsset: MediaAsset = {
  id: 'asset_image',
  kind: 'image',
  mimeType: 'image/png',
  name: 'generated.png',
  byteSize: 8,
  width: 1,
  height: 1,
}

const audioAsset: MediaAsset = {
  id: 'asset_audio',
  kind: 'audio',
  mimeType: 'audio/mpeg',
  name: 'generated.mp3',
  byteSize: 4,
}

async function* streamEvents(values: Array<Record<string, unknown>>) {
  for (const value of values) yield value as never
}

function createHarness(overrides: Partial<MediaGenerationOrchestratorDependencies> = {}) {
  const calls: string[] = []
  const events: ChatEvent[] = []
  const finalizations: Array<Parameters<AgentPersistencePort['finalize']>[0]> = []
  const replacements: Array<{ messageId: string; blockId: string; block: ChatBlock }> = []
  const writer: GeneratedAssetWriter = {
    appendBase64Chunk: vi.fn(async (chunk: string) => { calls.push(`append:${chunk}`) }),
    commit: vi.fn(async () => {
      calls.push('writer.commit')
      return audioAsset
    }),
    abort: vi.fn(async () => { calls.push('writer.abort') }),
  }
  const persistence: AgentPersistencePort = {
    persistUser: vi.fn(() => { calls.push('persistUser') }),
    createRun: vi.fn(() => { calls.push('createRun') }),
    createAssistant: vi.fn(() => { calls.push('createAssistant') }),
    updateAssistant: vi.fn(),
    replaceAssistantBlock: vi.fn((messageId, blockId, block) => {
      calls.push('replaceAssistantBlock')
      replacements.push({ messageId, blockId, block })
      return { blocks: [block] }
    }),
    finalize: vi.fn((input) => {
      calls.push('finalize')
      finalizations.push(input)
    }),
  }
  const media: MediaAssetService = {
    importPaths: vi.fn(),
    importClipboardImage: vi.fn(),
    removeDraft: vi.fn(),
    resolveReadyAsset: vi.fn(),
    modelInput: vi.fn(async () => []),
    createGeneratedWriter: vi.fn(async () => writer),
    commitGeneratedBase64: vi.fn(async () => {
      calls.push('commitGeneratedBase64')
      return imageAsset
    }),
    commitGeneratedStream: vi.fn(async (input) => {
      const chunks: Buffer[] = []
      for await (const chunk of input.stream) chunks.push(Buffer.from(chunk))
      calls.push(`commitGeneratedStream:${Buffer.concat(chunks).toString('hex')}`)
      return imageAsset
    }),
    cleanupDrafts: vi.fn(),
  }
  const generateImage = vi.fn<NonNullable<ModelProvider['generateImage']>>(async () => {
      calls.push('generateImage')
      return { outputs: [{ type: 'base64' as const, dataBase64: 'iVBORw0KGgo=', mimeType: 'image/png' }] }
    })
  const stream = vi.fn<ModelProvider['stream']>(() => streamEvents([
      { type: 'audio_delta', choiceIndex: 0, dataBase64: 'AQI=', transcript: '你' },
      { type: 'audio_delta', choiceIndex: 0, dataBase64: 'AwQ=', transcript: '好' },
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ]))
  const provider = { generateImage, stream }
  const dependencies: MediaGenerationOrchestratorDependencies = {
    providers: { get: vi.fn(() => provider) },
    persistence,
    media,
    downloader: {
      download: vi.fn(async (_url: string, destination: NodeJS.WritableStream) => {
        ;(destination as Writable).write(Buffer.from('89504e47', 'hex'))
        return { byteSize: 4, contentType: 'image/png' }
      }),
    },
    emit: (event) => { events.push(event) },
    id: (() => {
      const ids = ['user_message', 'run', 'assistant_message', 'generation_block']
      return () => ids.shift() ?? 'unexpected_id'
    })(),
    now: () => 100,
    ...overrides,
  }
  return {
    calls,
    dependencies,
    events,
    finalizations,
    media,
    persistence,
    provider,
    replacements,
    writer,
  }
}

const input = {
  requestId: 'request_1',
  conversationId: 'conversation_1',
  prompt: 'paint a harbor',
  userBlocks: [{ type: 'text', text: 'paint a harbor' }] satisfies ChatBlock[],
  assetIds: [] as string[],
}

describe('MediaGenerationOrchestrator', () => {
  it('persists the user and stable pending block before generating and atomically claims a Base64 image', async () => {
    const harness = createHarness()
    const orchestrator = new MediaGenerationOrchestrator(harness.dependencies)

    const result = await orchestrator.runImage({ ...input, route: imageRoute })

    expect(result).toEqual({ requestId: 'request_1', status: 'completed' })
    expect(harness.persistence.persistUser).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conversation_1',
      blocks: input.userBlocks,
      assetIds: [],
    }))
    expect(harness.persistence.createAssistant).toHaveBeenCalledWith(expect.objectContaining({
      initialBlocks: [{
        type: 'media_generation',
        blockId: 'generation_block',
        jobId: 'request_1',
        kind: 'image',
        status: 'in_progress',
      }],
    }))
    expect(harness.calls.indexOf('persistUser')).toBeLessThan(harness.calls.indexOf('generateImage'))
    expect(harness.calls.indexOf('createAssistant')).toBeLessThan(harness.calls.indexOf('generateImage'))
    expect(harness.calls.indexOf('commitGeneratedBase64')).toBeLessThan(harness.calls.indexOf('replaceAssistantBlock'))
    expect(harness.replacements).toEqual([{
      messageId: 'assistant_message',
      blockId: 'generation_block',
      block: expect.objectContaining({
        type: 'media',
        blockId: 'generation_block',
        assetId: 'asset_image',
        kind: 'image',
        purpose: 'output',
      }),
    }])
    expect(harness.finalizations).toEqual([
      expect.objectContaining({
        status: 'completed',
        blocks: [expect.objectContaining({ type: 'media', blockId: 'generation_block' })],
      }),
    ])
  })

  it('downloads URL image output through the safe downloader without persisting or emitting its URL', async () => {
    const harness = createHarness()
    harness.provider.generateImage.mockResolvedValue({
      outputs: [{ type: 'url', url: 'https://cdn.example/private-output.png' }],
    })
    const orchestrator = new MediaGenerationOrchestrator(harness.dependencies)

    await orchestrator.runImage({ ...input, route: imageRoute })

    expect(harness.dependencies.downloader.download).toHaveBeenCalledWith(
      'https://cdn.example/private-output.png',
      expect.anything(),
      expect.objectContaining({ maxBytes: 500 * 1024 * 1024 }),
    )
    expect(harness.media.commitGeneratedStream).toHaveBeenCalledTimes(1)
    expect(harness.calls).toContain('commitGeneratedStream:89504e47')
    expect(JSON.stringify({
      events: harness.events,
      finalizations: harness.finalizations,
      replacements: harness.replacements,
    })).not.toContain('cdn.example')
  })

  it('writes audio deltas in order, persists its transcript, and claims the output asset', async () => {
    const harness = createHarness()
    const orchestrator = new MediaGenerationOrchestrator(harness.dependencies)

    const result = await orchestrator.runAudio({ ...input, route: audioRoute })

    expect(result.status).toBe('completed')
    expect(harness.writer.appendBase64Chunk).toHaveBeenNthCalledWith(1, 'AQI=')
    expect(harness.writer.appendBase64Chunk).toHaveBeenNthCalledWith(2, 'AwQ=')
    expect(harness.calls.indexOf('append:AQI=')).toBeLessThan(harness.calls.indexOf('append:AwQ='))
    expect(harness.calls.indexOf('append:AwQ=')).toBeLessThan(harness.calls.indexOf('writer.commit'))
    expect(harness.replacements[0]?.block).toMatchObject({
      type: 'media',
      blockId: 'generation_block',
      assetId: 'asset_audio',
      kind: 'audio',
      purpose: 'output',
    })
    expect(harness.finalizations[0]?.blocks).toEqual([
      expect.objectContaining({ type: 'media', blockId: 'generation_block' }),
      { type: 'text', text: '你好' },
    ])
    expect(harness.provider.stream).toHaveBeenCalledWith(expect.objectContaining({
      model: 'audio-model',
      output: { type: 'audio', format: 'mp3' },
      signal: expect.any(AbortSignal),
    }))
  })

  it('aborts audio staging and replaces only the generation block with a safe failed state', async () => {
    const harness = createHarness()
    harness.provider.stream.mockImplementation(() => (async function* () {
      yield { type: 'audio_delta' as const, choiceIndex: 0, dataBase64: 'AQI=' }
      throw Object.assign(new Error('secret upstream body'), { code: 'MODEL_PROVIDER_REQUEST_FAILED' })
    })())
    const orchestrator = new MediaGenerationOrchestrator(harness.dependencies)

    const result = await orchestrator.runAudio({ ...input, route: audioRoute })

    expect(result).toEqual({
      requestId: 'request_1',
      status: 'failed',
      error: {
        code: 'MODEL_PROVIDER_REQUEST_FAILED',
        message: 'The model provider request failed.',
      },
    })
    expect(harness.writer.abort).toHaveBeenCalledTimes(1)
    expect(harness.replacements).toEqual([{
      messageId: 'assistant_message',
      blockId: 'generation_block',
      block: {
        type: 'media_generation',
        blockId: 'generation_block',
        jobId: 'request_1',
        kind: 'audio',
        status: 'failed',
        errorCode: 'MODEL_PROVIDER_REQUEST_FAILED',
      },
    }])
    expect(harness.finalizations[0]?.blocks).toEqual([harness.replacements[0]!.block])
    expect(harness.events).toContainEqual(expect.objectContaining({
      type: 'block_update',
      blockId: 'generation_block',
      block: harness.replacements[0]!.block,
    }))
    expect(JSON.stringify(harness.events)).not.toContain('secret upstream body')
  })

  it('removes an unclaimed generated output when atomic message replacement fails', async () => {
    const harness = createHarness()
    vi.mocked(harness.persistence.replaceAssistantBlock)
      .mockImplementationOnce(() => { throw new Error('database write failed') })
      .mockImplementationOnce((_messageId, _blockId, block) => ({ blocks: [block] }))
    const orchestrator = new MediaGenerationOrchestrator(harness.dependencies)

    const result = await orchestrator.runImage({ ...input, route: imageRoute })

    expect(harness.media.removeDraft).toHaveBeenCalledWith('asset_image', 'conversation_1')
    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'MEDIA_GENERATION_FAILED' },
    })
    expect(harness.finalizations[0]?.blocks).toEqual([
      expect.objectContaining({
        type: 'media_generation',
        blockId: 'generation_block',
        status: 'failed',
      }),
    ])
  })

  it('aborts the provider and persists a cancelled generation state', async () => {
    const harness = createHarness()
    let providerSignal: AbortSignal | undefined
    harness.provider.generateImage.mockImplementation(async (request) => {
      providerSignal = request.signal
      await new Promise((_resolve, reject) => {
        request.signal?.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('aborted'), { code: 'CANCELLED' })),
          { once: true },
        )
      })
      throw new Error('unreachable')
    })
    const orchestrator = new MediaGenerationOrchestrator(harness.dependencies)
    const running = orchestrator.runImage({ ...input, route: imageRoute })
    await vi.waitFor(() => expect(providerSignal).toBeDefined())

    await orchestrator.cancel('request_1')
    const result = await running

    expect(providerSignal?.aborted).toBe(true)
    expect(result).toMatchObject({ status: 'cancelled', error: { code: 'CANCELLED' } })
    expect(harness.finalizations[0]).toMatchObject({
      status: 'cancelled',
      blocks: [expect.objectContaining({ status: 'failed', errorCode: 'CANCELLED' })],
    })
  })

  it('discards an output committed concurrently with cancellation before it can be claimed', async () => {
    const harness = createHarness()
    let releaseCommit: ((asset: MediaAsset) => void) | undefined
    vi.mocked(harness.media.commitGeneratedBase64).mockImplementation(() => (
      new Promise<MediaAsset>((resolve) => { releaseCommit = resolve })
    ))
    const orchestrator = new MediaGenerationOrchestrator(harness.dependencies)
    const running = orchestrator.runImage({ ...input, route: imageRoute })
    await vi.waitFor(() => expect(releaseCommit).toBeDefined())

    await orchestrator.cancel('request_1')
    releaseCommit!(imageAsset)
    const result = await running

    expect(harness.media.removeDraft).toHaveBeenCalledWith('asset_image', 'conversation_1')
    expect(harness.replacements[0]?.block).toMatchObject({
      type: 'media_generation',
      status: 'failed',
      errorCode: 'CANCELLED',
    })
    expect(result.status).toBe('cancelled')
  })
})
