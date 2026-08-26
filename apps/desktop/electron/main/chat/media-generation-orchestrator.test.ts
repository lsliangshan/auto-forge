import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type {
  ChatBlock,
  ChatEvent,
  GenerationOptions,
  MediaAsset,
} from '@autoforge/shared'
import {
  createAgentPersistence,
  type AgentPersistencePort,
} from '../agent/agent-orchestrator.js'
import {
  openTestUserDataDatabase,
  type TestUserDataDatabase,
} from '../../test-support/user-data-database.js'
import {
  ProviderUsageConsistencyError,
  type ProviderUsageRepository,
} from '../database/repositories.js'
import { fingerprintApiKey } from '../billing/provider-usage-reconciler.js'
import type {
  GeneratedAssetWriter,
  MediaAssetService,
} from '../media/media-asset-service.js'
import { createMediaAssetService } from '../media/media-asset-service.js'
import type { ModelProvider } from './model-provider.js'
import { OpenRouterProvider } from './openrouter-provider.js'
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
  supportsImageInput: false,
  outputType: 'image',
  assets: [],
  generation,
  imageParameterSupport: {
    resolution: false,
    aspectRatio: true,
    outputFormat: true,
  },
}

const audioRoute: ResolvedChatRoute = {
  provider: 'openrouter',
  model: 'audio-model',
  supportsTools: false,
  supportsImageInput: false,
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
  const writer: GeneratedAssetWriter = {
    appendBase64Chunk: vi.fn(async (chunk: string) => { calls.push(`append:${chunk}`) }),
    commit: vi.fn(async () => {
      calls.push('writer.commit')
      return audioAsset
    }),
    abort: vi.fn(async () => { calls.push('writer.abort') }),
  }
  const persistence: AgentPersistencePort = {
    persistUser: vi.fn(() => { calls.push('persistUser'); return { ordinal: 1 } }),
    createRun: vi.fn(() => { calls.push('createRun') }),
    createAssistant: vi.fn(() => { calls.push('createAssistant') }),
    startMediaGeneration: vi.fn(() => { calls.push('startMediaGeneration') }),
    updateAssistant: vi.fn(),
    replaceAssistantBlock: vi.fn((messageId, blockId, block) => {
      calls.push('replaceAssistantBlock')
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
      return {
        outputs: [{ type: 'base64' as const, dataBase64: 'iVBORw0KGgo=', mimeType: 'image/png' }],
        usage: { inputTokens: 2, outputTokens: 3, costUsd: '0.01' },
      }
    })
  const stream = vi.fn<ModelProvider['stream']>(() => {
    calls.push('provider.stream')
    return streamEvents([
      { type: 'audio_delta', choiceIndex: 0, dataBase64: 'AQI=', transcript: '你' },
      { type: 'audio_delta', choiceIndex: 0, dataBase64: 'AwQ=', transcript: '好' },
      { type: 'generation', id: 'generation_audio' },
      { type: 'usage', inputTokens: 5, outputTokens: 6, totalTokens: 11, costUsd: '0.02' },
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ])
  })
  const provider = {
    listModels: vi.fn(async () => []),
    validateCredential: vi.fn(async () => ({ valid: true })),
    generateImage,
    stream,
  } satisfies ModelProvider
  const providers = {
    acquire: vi.fn(async (providerId: ResolvedChatRoute['provider']) => ({
      providerId,
      provider,
      ...(providerId === 'openrouter' ? { apiKeyFingerprint: 'fingerprint_1' } : {}),
    })),
  }
  const providerUsage: Pick<ProviderUsageRepository, 'start' | 'bindIdentity' | 'report' | 'markUnknown'> = {
    start: vi.fn((event) => {
      calls.push('providerUsage.start')
      return event as never
    }),
    bindIdentity: vi.fn((_operationKey, identity) => {
      calls.push('providerUsage.bindIdentity')
      return identity as never
    }),
    report: vi.fn((_operationKey, report) => {
      calls.push('providerUsage.report')
      return report as never
    }),
    markUnknown: vi.fn((operationKey) => {
      calls.push('providerUsage.markUnknown')
      return operationKey as never
    }),
  }
  const dependencies: MediaGenerationOrchestratorDependencies = {
    providers,
    persistence,
    media,
    downloader: {
      download: vi.fn(async (_url: string, destination: NodeJS.WritableStream) => {
        ;(destination as Writable).write(Buffer.from('89504e47', 'hex'))
        return { byteSize: 4, contentType: 'image/png' }
      }),
    },
    emit: (event) => { events.push(event) },
    providerUsage,
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
    providers,
    providerUsage,
    writer,
  }
}

const input = {
  userId: 'user_1',
  requestId: 'request_1',
  conversationId: 'conversation_1',
  prompt: 'paint a harbor',
  userBlocks: [{ type: 'text', text: 'paint a harbor' }] satisfies ChatBlock[],
  assetIds: [] as string[],
}

describe('MediaGenerationOrchestrator', () => {
  it('keeps image wire credentials and ledger attribution on one snapshot across a key switch', async () => {
    let apiKey = 'sk-image-a'
    const authorizations: string[] = []
    const source = new OpenRouterProvider({
      credential: { get: vi.fn(async () => apiKey) },
      fetch: vi.fn(async (_url, init) => {
        authorizations.push(new Headers(init?.headers).get('authorization') ?? '')
        return Response.json({
          data: [{ b64_json: 'iVBORw0KGgo=', media_type: 'image/png' }],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, cost: '0.01' },
        })
      }),
    })
    const providers = {
      get: vi.fn(() => {
        apiKey = 'sk-image-b'
        return source
      }),
      acquire: vi.fn(async () => {
        const snapshot = await source.acquireSnapshot()
        apiKey = 'sk-image-b'
        return snapshot
      }),
    }
    const harness = createHarness({ providers })
    const orchestrator = new MediaGenerationOrchestrator(harness.dependencies)

    await expect(orchestrator.runImage({ ...input, requestId: 'image_a', route: imageRoute }))
      .resolves.toMatchObject({ status: 'completed' })
    await expect(orchestrator.runImage({ ...input, requestId: 'image_b', route: imageRoute }))
      .resolves.toMatchObject({ status: 'completed' })

    expect(providers.acquire).toHaveBeenCalledTimes(2)
    expect(providers.get).not.toHaveBeenCalled()
    expect(authorizations).toEqual(['Bearer sk-image-a', 'Bearer sk-image-b'])
    expect(harness.providerUsage.start).toHaveBeenNthCalledWith(1, expect.objectContaining({
      operationKey: 'image:image_a',
      apiKeyFingerprint: fingerprintApiKey('sk-image-a'),
    }))
    expect(harness.providerUsage.start).toHaveBeenNthCalledWith(2, expect.objectContaining({
      operationKey: 'image:image_b',
      apiKeyFingerprint: fingerprintApiKey('sk-image-b'),
    }))
  })

  it('keeps audio wire credentials and ledger attribution on one snapshot across a key switch', async () => {
    let apiKey = 'sk-audio-a'
    let responseIndex = 0
    const authorizations: string[] = []
    const source = new OpenRouterProvider({
      credential: { get: vi.fn(async () => apiKey) },
      fetch: vi.fn(async (_url, init) => {
        authorizations.push(new Headers(init?.headers).get('authorization') ?? '')
        responseIndex += 1
        const generationId = `generation_audio_${responseIndex}`
        const payload = [
          `data: {"id":"${generationId}","choices":[{"index":0,"delta":{"audio":{"data":"AQI="}}}]}`,
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":6,"total_tokens":11,"cost":"0.02"}}',
          'data: [DONE]',
        ].join('\n\n') + '\n\n'
        return new Response(payload, { headers: { 'content-type': 'text/event-stream' } })
      }),
    })
    const providers = {
      get: vi.fn(() => {
        apiKey = 'sk-audio-b'
        return source
      }),
      acquire: vi.fn(async () => {
        const snapshot = await source.acquireSnapshot()
        apiKey = 'sk-audio-b'
        return snapshot
      }),
    }
    const harness = createHarness({ providers })
    const orchestrator = new MediaGenerationOrchestrator(harness.dependencies)

    await expect(orchestrator.runAudio({ ...input, requestId: 'audio_a', route: audioRoute }))
      .resolves.toMatchObject({ status: 'completed' })
    await expect(orchestrator.runAudio({ ...input, requestId: 'audio_b', route: audioRoute }))
      .resolves.toMatchObject({ status: 'completed' })

    expect(providers.acquire).toHaveBeenCalledTimes(2)
    expect(providers.get).not.toHaveBeenCalled()
    expect(authorizations).toEqual(['Bearer sk-audio-a', 'Bearer sk-audio-b'])
    expect(harness.providerUsage.start).toHaveBeenNthCalledWith(1, expect.objectContaining({
      operationKey: 'audio:audio_a',
      apiKeyFingerprint: fingerprintApiKey('sk-audio-a'),
    }))
    expect(harness.providerUsage.start).toHaveBeenNthCalledWith(2, expect.objectContaining({
      operationKey: 'audio:audio_b',
      apiKeyFingerprint: fingerprintApiKey('sk-audio-b'),
    }))
  })

  it.each([
    ['image', imageRoute],
    ['audio', audioRoute],
  ] as const)('does not create an OpenRouter ledger event for DeepSeek %s operations', async (kind, route) => {
    const harness = createHarness()
    const orchestrator = new MediaGenerationOrchestrator(harness.dependencies)
    const deepSeekRoute = { ...route, provider: 'deepseek' as const }

    const result = kind === 'image'
      ? await orchestrator.runImage({ ...input, route: deepSeekRoute })
      : await orchestrator.runAudio({ ...input, route: deepSeekRoute })

    expect(result).toMatchObject({ status: 'completed' })
    expect(harness.providers.acquire).toHaveBeenCalledTimes(1)
    expect(harness.providerUsage.start).not.toHaveBeenCalled()
    expect(harness.providerUsage.bindIdentity).not.toHaveBeenCalled()
    expect(harness.providerUsage.report).not.toHaveBeenCalled()
    expect(harness.providerUsage.markUnknown).not.toHaveBeenCalled()
  })

  it.each([
    ['image', imageRoute],
    ['audio', audioRoute],
  ] as const)('terminalizes a persisted %s run before rethrowing the original provider usage consistency error', async (kind, route) => {
    const harness = createHarness()
    const consistencyError = new ProviderUsageConsistencyError()
    vi.mocked(harness.providerUsage.report).mockImplementation(() => { throw consistencyError })
    const orchestrator = new MediaGenerationOrchestrator(harness.dependencies)

    const running = kind === 'image'
      ? orchestrator.runImage({ ...input, route })
      : orchestrator.runAudio({ ...input, route })
    await expect(running).rejects.toBe(consistencyError)

    expect(harness.persistence.finalize).toHaveBeenCalledTimes(1)
    expect(harness.finalizations).toEqual([expect.objectContaining({
      runId: 'run',
      status: 'failed',
      errorCode: 'INTERNAL_ERROR',
      blocks: [expect.objectContaining({
        type: 'media_generation',
        status: 'failed',
        errorCode: 'INTERNAL_ERROR',
      })],
    })])
    expect(orchestrator.hasActiveRuns()).toBe(false)
  })

  it('terminalizes a snapshot provider mismatch before rethrowing a consistency error', async () => {
    const harness = createHarness()
    harness.providers.acquire.mockResolvedValue({
      providerId: 'deepseek',
      provider: harness.provider,
    })
    const orchestrator = new MediaGenerationOrchestrator(harness.dependencies)

    await expect(orchestrator.runImage({ ...input, route: imageRoute }))
      .rejects.toBeInstanceOf(ProviderUsageConsistencyError)

    expect(harness.finalizations).toEqual([expect.objectContaining({
      status: 'failed',
      errorCode: 'INTERNAL_ERROR',
    })])
    expect(orchestrator.hasActiveRuns()).toBe(false)
  })

  it('continues consistency terminalization when writer abort throws synchronously', async () => {
    const harness = createHarness()
    const consistencyError = new ProviderUsageConsistencyError()
    vi.mocked(harness.providerUsage.report).mockImplementation(() => { throw consistencyError })
    vi.mocked(harness.writer.abort).mockImplementation(() => { throw new Error('sync abort failure') })

    await expect(new MediaGenerationOrchestrator(harness.dependencies)
      .runAudio({ ...input, route: audioRoute }))
      .rejects.toBe(consistencyError)

    expect(harness.persistence.finalize).toHaveBeenCalledTimes(1)
    expect(harness.finalizations[0]).toMatchObject({
      status: 'failed',
      errorCode: 'INTERNAL_ERROR',
    })
  })

  it.each([
    {
      name: 'generation identity',
      event: { type: 'generation', id: 'generation_audio_after_cancel' },
      assertRecorded(harness: ReturnType<typeof createHarness>) {
        expect(harness.providerUsage.bindIdentity).toHaveBeenCalledWith(
          'audio:request_1',
          { generationId: 'generation_audio_after_cancel' },
        )
      },
    },
    {
      name: 'reported cost',
      event: { type: 'usage', inputTokens: 6, outputTokens: 7, totalTokens: 13, costUsd: '0.13' },
      assertRecorded(harness: ReturnType<typeof createHarness>) {
        expect(harness.providerUsage.report).toHaveBeenCalledWith(
          'audio:request_1',
          { inputTokens: 6, outputTokens: 7, costUsd: '0.13', endedAt: 100 },
        )
      },
    },
  ])('records delivered audio $name before respecting cancellation', async ({ event, assertRecorded }) => {
    const harness = createHarness()
    let providerStarted!: () => void
    let releaseProvider!: () => void
    const started = new Promise<void>((resolve) => { providerStarted = resolve })
    const released = new Promise<void>((resolve) => { releaseProvider = resolve })
    harness.provider.stream.mockImplementation(() => (async function* () {
      providerStarted()
      await released
      yield event as never
    })())
    const orchestrator = new MediaGenerationOrchestrator(harness.dependencies)
    const running = orchestrator.runAudio({ ...input, route: audioRoute })
    await started

    await orchestrator.cancel('request_1')
    releaseProvider()

    await expect(running).resolves.toMatchObject({ status: 'cancelled' })
    assertRecorded(harness)
  })

  it('reports image cost before local asset persistence and keeps it when persistence fails', async () => {
    const harness = createHarness()
    vi.mocked(harness.media.commitGeneratedBase64).mockImplementation(async () => {
      harness.calls.push('local.image.commit')
      throw Object.assign(new Error('disk full'), { code: 'MEDIA_STORAGE_FULL' })
    })

    const result = await new MediaGenerationOrchestrator(harness.dependencies)
      .runImage({ ...input, route: imageRoute })

    expect(result).toMatchObject({ status: 'failed', error: { code: 'MEDIA_STORAGE_FULL' } })
    expect(harness.calls.indexOf('providerUsage.start')).toBeLessThan(
      harness.calls.indexOf('generateImage'),
    )
    expect(harness.calls.indexOf('providerUsage.report')).toBeLessThan(
      harness.calls.indexOf('local.image.commit'),
    )
    expect(harness.providerUsage.start).toHaveBeenCalledWith(expect.objectContaining({
      id: expect.any(String),
      operationKey: 'image:request_1',
      userId: 'user_1',
      apiKeyFingerprint: 'fingerprint_1',
      provider: 'openrouter',
      requestId: 'request_1',
      chatRunId: 'run',
      model: 'image-model',
      modality: 'image',
      startedAt: 100,
    }))
    expect(harness.providerUsage.report).toHaveBeenCalledWith('image:request_1', {
      inputTokens: 2,
      outputTokens: 3,
      costUsd: '0.01',
      endedAt: 100,
    })
    expect(harness.providerUsage.markUnknown).not.toHaveBeenCalled()
    const request = harness.provider.generateImage.mock.calls[0]?.[0] as unknown as Record<string, unknown>
    expect(request).not.toHaveProperty('endUserId')
  })

  it('reports chat audio cost before local commit and sends only the supported end-user field', async () => {
    const harness = createHarness()
    vi.mocked(harness.writer.commit).mockImplementation(async () => {
      harness.calls.push('local.audio.commit')
      throw Object.assign(new Error('disk full'), { code: 'MEDIA_STORAGE_FULL' })
    })

    const result = await new MediaGenerationOrchestrator(harness.dependencies)
      .runAudio({ ...input, route: audioRoute })

    expect(result).toMatchObject({ status: 'failed', error: { code: 'MEDIA_STORAGE_FULL' } })
    expect(harness.calls.indexOf('providerUsage.start')).toBeLessThan(
      harness.calls.indexOf('provider.stream'),
    )
    expect(harness.calls.indexOf('providerUsage.bindIdentity')).toBeLessThan(
      harness.calls.indexOf('providerUsage.report'),
    )
    expect(harness.calls.indexOf('providerUsage.report')).toBeLessThan(
      harness.calls.indexOf('local.audio.commit'),
    )
    expect(harness.providerUsage.start).toHaveBeenCalledWith(expect.objectContaining({
      operationKey: 'audio:request_1',
      userId: 'user_1',
      apiKeyFingerprint: 'fingerprint_1',
      provider: 'openrouter',
      requestId: 'request_1',
      chatRunId: 'run',
      model: 'audio-model',
      modality: 'audio',
      startedAt: 100,
    }))
    expect(harness.providerUsage.bindIdentity).toHaveBeenCalledWith(
      'audio:request_1',
      { generationId: 'generation_audio' },
    )
    expect(harness.providerUsage.report).toHaveBeenCalledWith('audio:request_1', {
      generationId: 'generation_audio',
      inputTokens: 5,
      outputTokens: 6,
      costUsd: '0.02',
      endedAt: 100,
    })
    expect(harness.provider.stream).toHaveBeenCalledWith(expect.objectContaining({
      endUserId: 'user_1',
    }))
    expect(harness.providerUsage.markUnknown).not.toHaveBeenCalled()
  })

  it('binds costless chat audio generation identity before marking the event unknown', async () => {
    const harness = createHarness()
    harness.provider.stream.mockImplementation(() => streamEvents([
      { type: 'generation', id: 'generation_costless' },
      { type: 'usage', inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ]))

    await new MediaGenerationOrchestrator(harness.dependencies)
      .runAudio({ ...input, route: audioRoute })

    expect(harness.providerUsage.bindIdentity).toHaveBeenCalledWith(
      'audio:request_1',
      { generationId: 'generation_costless' },
    )
    expect(harness.providerUsage.markUnknown).toHaveBeenCalledWith('audio:request_1', 100)
    expect(harness.providerUsage.report).not.toHaveBeenCalled()
  })
  it('persists the user and stable pending block before generating and atomically claims a Base64 image', async () => {
    const harness = createHarness()
    const orchestrator = new MediaGenerationOrchestrator(harness.dependencies)

    const result = await orchestrator.runImage({ ...input, route: imageRoute })

    expect(result).toEqual({ requestId: 'request_1', status: 'completed' })
    expect(harness.persistence.startMediaGeneration).toHaveBeenCalledWith({
      user: expect.objectContaining({
        conversationId: 'conversation_1',
        blocks: input.userBlocks,
        assetIds: [],
      }),
      run: expect.objectContaining({
        requestId: 'request_1',
        userId: 'user_1',
        provider: 'openrouter',
        model: 'image-model',
      }),
      assistant: expect.objectContaining({
        initialBlocks: [{
          type: 'media_generation',
          blockId: 'generation_block',
          jobId: 'request_1',
          kind: 'image',
          status: 'in_progress',
        }],
      }),
    })
    expect(harness.calls.indexOf('startMediaGeneration')).toBeLessThan(
      harness.calls.indexOf('generateImage'),
    )
    expect(harness.provider.generateImage).toHaveBeenCalledWith(expect.objectContaining({
      parameterSupport: imageRoute.imageParameterSupport,
    }))
    expect(harness.persistence.persistUser).not.toHaveBeenCalled()
    expect(harness.persistence.createRun).not.toHaveBeenCalled()
    expect(harness.persistence.createAssistant).not.toHaveBeenCalled()
    expect(harness.calls.indexOf('commitGeneratedBase64')).toBeLessThan(harness.calls.indexOf('finalize'))
    expect(harness.persistence.replaceAssistantBlock).not.toHaveBeenCalled()
    expect(harness.finalizations).toEqual([
      expect.objectContaining({
        status: 'completed',
        blocks: [expect.objectContaining({ type: 'media', blockId: 'generation_block' })],
        inputTokens: 2,
        outputTokens: 3,
        costUsd: '0.01',
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
    })).not.toContain('cdn.example')
  })

  it('fails safely when a URL image download fails and emits no success replacement', async () => {
    const harness = createHarness()
    harness.provider.generateImage.mockResolvedValue({
      outputs: [{ type: 'url', url: 'https://cdn.example/failing-output.png' }],
    })
    vi.mocked(harness.dependencies.downloader.download).mockImplementation(
      async (_url, destination) => {
        destination.emit('error', Object.assign(new Error('secret download failure'), {
          code: 'MEDIA_DOWNLOAD_FAILED',
        }))
        throw Object.assign(new Error('secret download failure'), { code: 'MEDIA_DOWNLOAD_FAILED' })
      },
    )
    const orchestrator = new MediaGenerationOrchestrator(harness.dependencies)

    const result = await orchestrator.runImage({ ...input, route: imageRoute })

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'MEDIA_DOWNLOAD_FAILED' },
    })
    expect(harness.finalizations.at(-1)).toMatchObject({
      status: 'failed',
      blocks: [expect.objectContaining({
        type: 'media_generation',
        status: 'failed',
        errorCode: 'MEDIA_DOWNLOAD_FAILED',
      })],
    })
    expect(harness.events.some((event) => (
      event.type === 'block_update' && event.block.type === 'media'
    ))).toBe(false)
    expect(JSON.stringify(harness.events)).not.toContain('secret download failure')
  })

  it('cancels an active URL download by closing its destination and persists cancellation', async () => {
    const harness = createHarness()
    harness.provider.generateImage.mockResolvedValue({
      outputs: [{ type: 'url', url: 'https://cdn.example/slow-output.png' }],
    })
    let downloadStarted = false
    vi.mocked(harness.dependencies.downloader.download).mockImplementation(
      async (_url, destination) => new Promise((_resolve, reject) => {
        downloadStarted = true
        const fail = () => reject(Object.assign(new Error('closed'), { code: 'MEDIA_DOWNLOAD_FAILED' }))
        destination.once('error', fail)
        destination.once('close', fail)
      }),
    )
    const orchestrator = new MediaGenerationOrchestrator(harness.dependencies)
    const running = orchestrator.runImage({ ...input, route: imageRoute })
    await vi.waitFor(() => expect(downloadStarted).toBe(true))

    await orchestrator.cancel('request_1')
    const result = await running

    expect(result).toMatchObject({ status: 'cancelled', error: { code: 'CANCELLED' } })
    expect(harness.finalizations.at(-1)).toMatchObject({
      status: 'cancelled',
      blocks: [expect.objectContaining({ errorCode: 'CANCELLED' })],
    })
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
    expect(harness.finalizations[0]?.blocks[0]).toMatchObject({
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
    expect(harness.finalizations[0]).toMatchObject({
      generationId: 'generation_audio',
      inputTokens: 5,
      outputTokens: 6,
      costUsd: '0.02',
    })
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
    expect(harness.finalizations[0]?.blocks).toEqual([{
        type: 'media_generation',
        blockId: 'generation_block',
        jobId: 'request_1',
        kind: 'audio',
        status: 'failed',
        errorCode: 'MODEL_PROVIDER_REQUEST_FAILED',
    }])
    expect(harness.events).toContainEqual(expect.objectContaining({
      type: 'block_update',
      blockId: 'generation_block',
      block: harness.finalizations[0]!.blocks[0],
    }))
    expect(JSON.stringify(harness.events)).not.toContain('secret upstream body')
  })

  it('aborts audio staging and persists failure when writer commit fails', async () => {
    const harness = createHarness()
    vi.mocked(harness.writer.commit).mockRejectedValue(
      Object.assign(new Error('secret storage path'), { code: 'MEDIA_STORAGE_FULL' }),
    )
    const orchestrator = new MediaGenerationOrchestrator(harness.dependencies)

    const result = await orchestrator.runAudio({ ...input, route: audioRoute })

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'MEDIA_STORAGE_FULL' },
    })
    expect(harness.writer.abort).toHaveBeenCalledTimes(1)
    expect(harness.finalizations.at(-1)).toMatchObject({
      status: 'failed',
      blocks: [expect.objectContaining({
        type: 'media_generation',
        status: 'failed',
        errorCode: 'MEDIA_STORAGE_FULL',
      })],
    })
    expect(JSON.stringify(harness.events)).not.toContain('secret storage path')
  })

  it('rolls back a failed atomic success terminal, cleans its output, then persists failure', async () => {
    const harness = createHarness()
    vi.mocked(harness.persistence.finalize)
      .mockImplementationOnce(() => { throw new Error('atomic terminal write failed') })
      .mockImplementationOnce((value) => {
        harness.calls.push('finalize')
        harness.finalizations.push(value)
      })
    const orchestrator = new MediaGenerationOrchestrator(harness.dependencies)

    const result = await orchestrator.runImage({ ...input, route: imageRoute })

    expect(harness.media.removeDraft).toHaveBeenCalledWith('asset_image', 'conversation_1')
    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'MEDIA_GENERATION_FAILED' },
    })
    expect(harness.finalizations).toHaveLength(1)
    expect(harness.finalizations[0]?.blocks).toEqual([
      expect.objectContaining({
        type: 'media_generation',
        blockId: 'generation_block',
        status: 'failed',
      }),
    ])
    expect(harness.events.some((event) => (
      event.type === 'block_update' && event.block.type === 'media'
    ))).toBe(false)
  })

  it('emits no terminal event when the atomic failure terminal itself does not commit', async () => {
    const harness = createHarness()
    harness.provider.generateImage.mockRejectedValue(
      Object.assign(new Error('provider failed'), { code: 'MODEL_PROVIDER_REQUEST_FAILED' }),
    )
    vi.mocked(harness.persistence.finalize).mockImplementation(() => {
      throw new Error('terminal transaction failed')
    })
    const orchestrator = new MediaGenerationOrchestrator(harness.dependencies)

    await expect(orchestrator.runImage({ ...input, route: imageRoute }))
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR' })

    expect(harness.events.some((event) => event.type === 'block_update')).toBe(false)
    expect(harness.events.some((event) => (
      event.type === 'status' && event.status === 'failed'
    ))).toBe(false)
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
    expect(harness.finalizations[0]?.blocks[0]).toMatchObject({
      type: 'media_generation',
      status: 'failed',
      errorCode: 'CANCELLED',
    })
    expect(result.status).toBe('cancelled')
  })
})

describe('MediaGenerationOrchestrator persistence integration', () => {
  it.each([
    {
      failure: 'chat run',
      ids: ['user_atomic_run', 'run_atomic_conflict', 'assistant_atomic_run', 'block_atomic_run'],
      arrange(database: TestUserDataDatabase) {
        database.chatRuns.insert({
          id: 'run_atomic_conflict',
          conversationId: 'conversation_atomic',
          requestId: 'request_existing',
          userId: 'user_atomic',
          provider: 'openrouter',
          model: 'image-model',
          status: 'completed',
          startedAt: 1,
          endedAt: 2,
        })
      },
      userMessageId: 'user_atomic_run',
      runId: 'run_atomic_conflict',
      assistantMessageId: 'assistant_atomic_run',
      kind: 'image' as const,
    },
    {
      failure: 'assistant message',
      ids: ['user_atomic_assistant', 'run_atomic_assistant', 'assistant_atomic_conflict', 'block_atomic_assistant'],
      arrange(database: TestUserDataDatabase) {
        database.messages.insert({
          id: 'assistant_atomic_conflict',
          conversationId: 'conversation_atomic',
          role: 'assistant',
          blocks: [],
          createdAt: 1,
        })
      },
      userMessageId: 'user_atomic_assistant',
      runId: 'run_atomic_assistant',
      assistantMessageId: 'assistant_atomic_conflict',
      kind: 'audio' as const,
    },
  ])('rolls back the entire $kind start and emits a terminal failure when the $failure insert violates a database constraint', async ({
    ids,
    arrange,
    userMessageId,
    runId,
    assistantMessageId,
    kind,
  }) => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-media-start-'))
    const database = openTestUserDataDatabase(root, 'user_atomic')
    const events: ChatEvent[] = []
    const provider = {
      listModels: vi.fn(async () => []),
      validateCredential: vi.fn(async () => ({ valid: true })),
      stream: vi.fn<ModelProvider['stream']>(),
      generateImage: vi.fn<NonNullable<ModelProvider['generateImage']>>(),
    } satisfies ModelProvider
    const asset = {
      id: 'asset_atomic',
      conversationId: 'conversation_atomic',
      source: 'upload' as const,
      kind: 'image' as const,
      mimeType: 'image/png',
      originalName: 'atomic.png',
      relativePath: 'conversation_atomic/asset_atomic.png',
      byteSize: 12,
      sha256: 'a'.repeat(64),
      status: 'ready' as const,
      createdAt: 1,
      updatedAt: 1,
    }
    try {
      database.conversations.insert({ id: 'conversation_atomic', title: 'Atomic start' })
      database.mediaAssets.insert(asset)
      arrange(database)
      const harness = createHarness({
        providers: {
          acquire: async (providerId) => ({ providerId, provider }),
        },
        persistence: createAgentPersistence(database),
        emit: (event) => { events.push(event) },
        id: () => ids.shift() ?? 'unexpected_id',
      })
      const orchestrator = new MediaGenerationOrchestrator(harness.dependencies)
      const run = kind === 'image'
        ? orchestrator.runImage.bind(orchestrator)
        : orchestrator.runAudio.bind(orchestrator)
      const result = await run({
        userId: 'user_atomic',
        requestId: 'request_atomic',
        conversationId: 'conversation_atomic',
        prompt: 'paint atomically',
        userBlocks: [
          { type: 'text', text: 'paint atomically' },
          {
            type: 'media',
            blockId: 'block_asset_atomic',
            assetId: asset.id,
            kind: asset.kind,
            purpose: 'input',
            name: asset.originalName,
            mimeType: asset.mimeType,
            byteSize: asset.byteSize,
          },
        ],
        assetIds: [asset.id],
        route: {
          ...(kind === 'image' ? imageRoute : audioRoute),
          assets: [{
            id: asset.id,
            kind: asset.kind,
            mimeType: asset.mimeType,
            name: asset.originalName,
            byteSize: asset.byteSize,
            conversationId: asset.conversationId,
            absolutePath: join(root, asset.relativePath),
            relativePath: asset.relativePath,
            inlineSafe: true,
          }],
        },
      })

      expect(database.messages.get(userMessageId)).toBeUndefined()
      if (runId === 'run_atomic_conflict') {
        expect(database.chatRuns.get(runId)?.requestId).toBe('request_existing')
      } else {
        expect(database.chatRuns.get(runId)).toBeUndefined()
      }
      if (assistantMessageId !== 'assistant_atomic_conflict') {
        expect(database.messages.get(assistantMessageId)).toBeUndefined()
      }
      expect(database.mediaAssets.get(asset.id)?.messageId).toBeUndefined()
      expect(provider.generateImage).not.toHaveBeenCalled()
      expect(provider.stream).not.toHaveBeenCalled()
      expect(orchestrator.hasActiveRuns()).toBe(false)
      expect(result).toEqual({
        requestId: 'request_atomic',
        status: 'failed',
        error: expect.objectContaining({ code: 'MEDIA_GENERATION_FAILED' }),
      })
      expect(events).toEqual([{
        type: 'status',
        conversationId: 'conversation_atomic',
        requestId: 'request_atomic',
        status: 'failed',
        error: expect.objectContaining({ code: 'MEDIA_GENERATION_FAILED' }),
      }])
    } finally {
      database.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('persists independently padded audio deltas, transcript, usage, and ownership atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-audio-orchestrator-'))
    const database = openTestUserDataDatabase(root, 'user_audio_real')
    const mediaRoot = join(root, 'media')
    const mp3 = Buffer.concat([
      Buffer.from('ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000', 'binary'),
      Buffer.from('audio'),
    ])
    const first = mp3.subarray(0, 11).toString('base64')
    const second = mp3.subarray(11).toString('base64')
    try {
      database.conversations.insert({ id: 'conversation_audio_real', title: 'Audio real' })
      const media = createMediaAssetService({
        database,
        mediaRoot,
        id: () => 'asset_audio_real',
      })
      const provider: ModelProvider = {
        listModels: vi.fn(async () => []),
        validateCredential: vi.fn(async () => ({ valid: true })),
        stream: () => streamEvents([
          { type: 'generation', id: 'generation_audio_real' },
          { type: 'audio_delta', choiceIndex: 0, dataBase64: first, transcript: '你' },
          { type: 'audio_delta', choiceIndex: 0, dataBase64: second, transcript: '好' },
          {
            type: 'usage',
            inputTokens: 7,
            outputTokens: 9,
            totalTokens: 16,
            costUsd: '0.02',
          },
          { type: 'finish', choiceIndex: 0, reason: 'stop' },
        ]),
      }
      const orchestrator = new MediaGenerationOrchestrator({
        providers: {
          acquire: async () => ({
            providerId: 'openrouter',
            provider,
            apiKeyFingerprint: 'fingerprint_audio_real',
          }),
        },
        persistence: createAgentPersistence(database),
        media,
        downloader: { download: vi.fn() },
        providerUsage: database.providerUsage,
        emit: () => undefined,
        id: (() => {
          const ids = ['user_audio_real', 'run_audio_real', 'assistant_audio_real', 'block_audio_real']
          return () => ids.shift() ?? 'unexpected_id'
        })(),
        now: () => 100,
      })

      await expect(orchestrator.runAudio({
        userId: 'user_audio_real',
        requestId: 'request_audio_real',
        conversationId: 'conversation_audio_real',
        prompt: 'say hello',
        userBlocks: [{ type: 'text', text: 'say hello' }],
        assetIds: [],
        route: { ...audioRoute, model: 'audio-model-real' },
      })).resolves.toEqual({ requestId: 'request_audio_real', status: 'completed' })

      const assistant = database.messages.get('assistant_audio_real')
      expect(assistant?.blocks).toEqual([
        expect.objectContaining({
          type: 'media',
          blockId: 'block_audio_real',
          assetId: 'asset_audio_real',
          kind: 'audio',
          purpose: 'output',
        }),
        { type: 'text', text: '你好' },
      ])
      const asset = database.mediaAssets.get('asset_audio_real')
      expect(asset?.messageId).toBe('assistant_audio_real')
      expect(await readFile(join(mediaRoot, asset!.relativePath!))).toEqual(mp3)
      expect(database.chatRuns.get('run_audio_real')).toMatchObject({
        userId: 'user_audio_real',
        provider: 'openrouter',
        status: 'completed',
        generationId: 'generation_audio_real',
        inputTokens: 7,
        outputTokens: 9,
        costUsd: '0.02',
      })
    } finally {
      database.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
