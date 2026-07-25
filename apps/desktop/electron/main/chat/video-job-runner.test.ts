import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type {
  ChatBlock,
  ChatEvent,
  GenerationOptions,
  MediaAsset,
} from '@autoforge/shared'
import { openAppDatabase } from '../database/client.js'
import type {
  GeneratedStreamInput,
  MediaAssetService,
} from '../media/media-asset-service.js'
import type { ModelProvider } from './model-provider.js'
import type { ResolvedChatRoute } from './multimodal-router.js'
import {
  VideoJobRunner,
  type VideoJobRunnerDependencies,
} from './video-job-runner.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const generation: GenerationOptions = {
  image: { count: 1, resolution: '1K', aspectRatio: 'auto', format: 'png' },
  audio: { format: 'mp3' },
  video: {
    durationSeconds: 5,
    resolution: '720p',
    aspectRatio: 'auto',
    generateAudio: false,
  },
}

const route: ResolvedChatRoute & { outputType: 'video' } = {
  provider: 'openrouter',
  model: 'video-model',
  supportsTools: false,
  outputType: 'video',
  assets: [],
  generation,
}

const submitInput = {
  requestId: 'request_video_1',
  conversationId: 'conversation_video_1',
  prompt: 'make a short harbor video',
  userBlocks: [{ type: 'text', text: 'make a short harbor video' }] satisfies ChatBlock[],
  assetIds: [] as string[],
  route,
}

const submittedOutputAssetId = 'video_8072e20a4619b4b2251a7c9e4522ab22a9728450834087c29e18d2651db6f0c0'

function createDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'autoforge-video-runner-'))
  temporaryDirectories.push(directory)
  const database = openAppDatabase(join(directory, 'autoforge.sqlite'))
  database.conversations.insert({ id: submitInput.conversationId, title: 'Video' })
  return database
}

function videoAsset(id: string): MediaAsset {
  return {
    id,
    kind: 'video',
    mimeType: 'video/mp4',
    name: 'generated-video.mp4',
    byteSize: 24,
  }
}

function createHarness(
  overrides: Partial<VideoJobRunnerDependencies> = {},
) {
  const database = createDatabase()
  const events: ChatEvent[] = []
  const provider: Pick<ModelProvider, 'submitVideo' | 'pollVideo' | 'downloadVideo'> = {
    submitVideo: vi.fn(async () => ({
      providerJobId: 'provider_job_1',
      status: 'pending' as const,
    })),
    pollVideo: vi.fn(async () => ({ status: 'in_progress' as const })),
    downloadVideo: vi.fn(async () => new Response(
      new Uint8Array([
        0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70,
        0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0,
        0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31,
      ]),
      { headers: { 'content-type': 'video/mp4', 'content-length': '24' } },
    )),
  }
  const readyAssets = new Map<string, MediaAsset>()
  const media: Pick<
    MediaAssetService,
    'modelInput' | 'commitGeneratedStream' | 'resolveReadyAsset' | 'removeDraft'
  > = {
    modelInput: vi.fn(async () => []),
    commitGeneratedStream: vi.fn(async (input: GeneratedStreamInput) => {
      for await (const chunk of input.stream) {
        // Exercise the runner's abort-aware response stream.
        void chunk
      }
      const asset = videoAsset(input.assetId!)
      database.mediaAssets.insert({
        id: asset.id,
        conversationId: input.conversationId,
        source: 'generated',
        kind: 'video',
        mimeType: asset.mimeType,
        originalName: asset.name,
        relativePath: `${input.conversationId}/${asset.id}.mp4`,
        byteSize: asset.byteSize,
        sha256: 'a'.repeat(64),
        provider: input.provider,
        model: input.model,
        status: 'ready',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      readyAssets.set(asset.id, asset)
      return asset
    }),
    resolveReadyAsset: vi.fn(async (assetId: string, conversationId?: string) => {
      const record = database.mediaAssets.get(assetId)
      if (!record || record.conversationId !== conversationId || record.status !== 'ready') {
        throw Object.assign(new Error('unavailable'), { code: 'MEDIA_ASSET_UNAVAILABLE' })
      }
      return {
        ...readyAssets.get(assetId)!,
        conversationId: record.conversationId,
        absolutePath: '/managed/video.mp4',
        relativePath: record.relativePath!,
        inlineSafe: false,
      }
    }),
    removeDraft: vi.fn(async (assetId: string, conversationId: string) => {
      const record = database.mediaAssets.get(assetId)
      if (record?.conversationId === conversationId && record.messageId === undefined) {
        database.mediaAssets.delete(assetId)
        readyAssets.delete(assetId)
      }
    }),
  }
  const dependencies: VideoJobRunnerDependencies = {
    database,
    providers: { get: vi.fn(() => provider as ModelProvider) },
    media,
    emit: (event) => events.push(event),
    id: (() => {
      const ids = ['user_message_1', 'run_video_1', 'assistant_video_1', 'block_video_1']
      return () => ids.shift() ?? 'unexpected_id'
    })(),
    now: () => Date.now(),
    ...overrides,
  }
  return { database, dependencies, events, media, provider }
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

describe('VideoJobRunner', () => {
  it('atomically persists the submitted provider job, input claim, stable block, and chat run', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const harness = createHarness()
    const runner = new VideoJobRunner(harness.dependencies)

    const result = await runner.submit(submitInput)

    expect(result).toEqual({
      jobId: 'request_video_1',
      requestId: 'request_video_1',
      status: 'pending',
    })
    expect(harness.database.mediaGenerationJobs.get(result.jobId)).toMatchObject({
      providerJobId: 'provider_job_1',
      provider: 'openrouter',
      model: 'video-model',
      status: 'pending',
      nextPollAt: 3_000,
      pollAttempts: 0,
    })
    expect(harness.database.chatRuns.get('run_video_1')).toMatchObject({
      requestId: 'request_video_1',
      model: 'video-model',
      status: 'running',
    })
    expect(harness.database.messages.get('assistant_video_1')?.blocks).toEqual([{
      type: 'media_generation',
      blockId: 'block_video_1',
      jobId: 'request_video_1',
      kind: 'video',
      status: 'pending',
    }])
  })

  it('claims exact input assets in the submitted user turn and sends only validated image references', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    harness.database.mediaAssets.insert({
      id: 'reference_image',
      conversationId: submitInput.conversationId,
      source: 'upload',
      kind: 'image',
      mimeType: 'image/png',
      originalName: 'reference.png',
      relativePath: `${submitInput.conversationId}/reference_image.png`,
      byteSize: 12,
      width: 1,
      height: 1,
      sha256: 'a'.repeat(64),
      status: 'ready',
      createdAt: 1,
      updatedAt: 1,
    })
    vi.mocked(harness.media.modelInput).mockResolvedValue([{
      assetId: 'reference_image',
      kind: 'image',
      mimeType: 'image/png',
      dataBase64: 'iVBORw0KGgo=',
    }])
    const referencedRoute: typeof route = {
      ...route,
      assets: [{
        id: 'reference_image',
        kind: 'image',
        mimeType: 'image/png',
        name: 'reference.png',
        byteSize: 12,
        width: 1,
        height: 1,
        conversationId: submitInput.conversationId,
        absolutePath: '/managed/reference.png',
        relativePath: `${submitInput.conversationId}/reference_image.png`,
        inlineSafe: true,
      }],
    }
    const userBlocks: ChatBlock[] = [
      { type: 'text', text: submitInput.prompt },
      {
        type: 'media',
        blockId: 'reference_block',
        assetId: 'reference_image',
        kind: 'image',
        purpose: 'input',
        name: 'reference.png',
        mimeType: 'image/png',
        byteSize: 12,
        width: 1,
        height: 1,
      },
    ]
    const runner = new VideoJobRunner(harness.dependencies)

    await runner.submit({
      ...submitInput,
      userBlocks,
      assetIds: ['reference_image'],
      route: referencedRoute,
    })

    expect(harness.provider.submitVideo).toHaveBeenCalledWith(expect.objectContaining({
      references: [{ mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' }],
    }))
    expect(harness.database.mediaAssets.get('reference_image')?.messageId).toBe('user_message_1')
    expect(harness.database.messages.get('user_message_1')?.blocks).toEqual(userBlocks)
  })

  it('uses the exact polling schedule and atomically completes the durable block, job, asset, and run', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const harness = createHarness()
    vi.mocked(harness.provider.pollVideo!)
      .mockResolvedValueOnce({ status: 'in_progress' })
      .mockResolvedValueOnce({ status: 'completed', generationId: 'generation_video', costUsd: '0.42' })
    const runner = new VideoJobRunner(harness.dependencies)
    await runner.submit(submitInput)

    await vi.advanceTimersByTimeAsync(1_999)
    expect(harness.provider.pollVideo).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(harness.provider.pollVideo).toHaveBeenCalledTimes(1)
    expect(harness.database.mediaGenerationJobs.get('request_video_1')).toMatchObject({
      status: 'in_progress',
      pollAttempts: 1,
      nextPollAt: 14_000,
    })
    await vi.advanceTimersByTimeAsync(2_000)
    await flush()

    const job = harness.database.mediaGenerationJobs.get('request_video_1')
    expect(job).toMatchObject({
      status: 'completed',
      pollAttempts: 2,
      assetId: submittedOutputAssetId,
      endedAt: 14_000,
    })
    expect(harness.database.messages.get('assistant_video_1')?.blocks).toEqual([
      expect.objectContaining({
        type: 'media',
        blockId: 'block_video_1',
        assetId: submittedOutputAssetId,
        kind: 'video',
      }),
    ])
    expect(harness.database.mediaAssets.get(submittedOutputAssetId)?.messageId)
      .toBe('assistant_video_1')
    expect(harness.database.chatRuns.get('run_video_1')).toMatchObject({
      status: 'completed',
      generationId: 'generation_video',
      costUsd: '0.42',
      endedAt: 14_000,
    })
    expect(harness.events.at(-2)).toMatchObject({
      type: 'block_update',
      block: { type: 'media', assetId: submittedOutputAssetId },
    })
    expect(harness.events.at(-1)).toMatchObject({
      type: 'status',
      requestId: 'request_video_1',
      status: 'completed',
    })
  })

  it('uses 2 seconds for attempts 1-5, 5 seconds for 6-20, then 10 seconds', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const harness = createHarness()
    const pollTimes: number[] = []
    vi.mocked(harness.provider.pollVideo!).mockImplementation(async () => {
      pollTimes.push(Date.now())
      return { status: 'in_progress' }
    })
    const runner = new VideoJobRunner(harness.dependencies)
    await runner.submit(submitInput)

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await vi.advanceTimersByTimeAsync(2_000)
    }
    for (let attempt = 6; attempt <= 20; attempt += 1) {
      await vi.advanceTimersByTimeAsync(5_000)
    }
    await vi.advanceTimersByTimeAsync(10_000)

    expect(pollTimes.slice(0, 6)).toEqual([2_000, 4_000, 6_000, 8_000, 10_000, 15_000])
    expect(pollTimes[19]).toBe(85_000)
    expect(pollTimes[20]).toBe(95_000)
  })

  it('recovers future jobs at their durable next poll without duplicate wakeups', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const harness = createHarness()
    const first = new VideoJobRunner(harness.dependencies)
    await first.submit(submitInput)
    await first.stop()

    const recovered = new VideoJobRunner(harness.dependencies)
    await Promise.all([recovered.recover(), recovered.recover()])
    await vi.advanceTimersByTimeAsync(1_999)
    expect(harness.provider.pollVideo).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(harness.provider.pollVideo).toHaveBeenCalledTimes(1)
  })

  it('recovers downloading jobs after restart without duplicate wakeups', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const harness = createHarness()
    const first = new VideoJobRunner(harness.dependencies)
    await first.submit(submitInput)
    await first.stop()
    harness.database.mediaGenerationJobs.transition(
      'request_video_1',
      ['pending'],
      {
        status: 'in_progress',
        updatedAt: 1_500,
        nextPollAt: undefined,
        pollAttempts: 0,
      },
    )
    harness.database.mediaGenerationJobs.transition(
      'request_video_1',
      ['in_progress'],
      {
        status: 'downloading',
        updatedAt: 1_500,
        nextPollAt: undefined,
        pollAttempts: 0,
      },
    )
    vi.mocked(harness.provider.pollVideo!).mockResolvedValue({ status: 'completed' })

    const recovered = new VideoJobRunner(harness.dependencies)
    await Promise.all([recovered.recover(), recovered.recover()])
    await flush()

    expect(harness.provider.downloadVideo).toHaveBeenCalledTimes(1)
    expect(harness.database.mediaGenerationJobs.get('request_video_1')?.status).toBe('completed')
  })

  it('pauses and resumes through durable CAS so a late poll cannot overwrite paused state', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const harness = createHarness()
    let resolvePoll!: (value: { status: 'in_progress' }) => void
    vi.mocked(harness.provider.pollVideo!).mockImplementation(async () => (
      new Promise((resolve) => { resolvePoll = resolve })
    ))
    const runner = new VideoJobRunner(harness.dependencies)
    await runner.submit(submitInput)
    await vi.advanceTimersByTimeAsync(2_000)

    await runner.pause('request_video_1')
    resolvePoll({ status: 'in_progress' })
    await flush()

    expect(harness.database.mediaGenerationJobs.get('request_video_1')).toMatchObject({
      status: 'paused',
    })
    expect(harness.database.messages.get('assistant_video_1')?.blocks).toEqual([
      expect.objectContaining({ status: 'paused' }),
    ])

    await runner.resume('request_video_1')
    expect(harness.database.mediaGenerationJobs.get('request_video_1')).toMatchObject({
      status: 'pending',
      nextPollAt: 5_000,
    })
  })

  it('reschedules a resumed job after an abort-ignoring stale poll finally settles', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const harness = createHarness()
    let resolveStalePoll!: (value: { status: 'in_progress' }) => void
    vi.mocked(harness.provider.pollVideo!)
      .mockImplementationOnce(async () => (
        new Promise((resolve) => { resolveStalePoll = resolve })
      ))
      .mockResolvedValue({ status: 'in_progress' })
    const runner = new VideoJobRunner(harness.dependencies)
    await runner.submit(submitInput)
    await vi.advanceTimersByTimeAsync(2_000)

    await runner.pause('request_video_1')
    await runner.resume('request_video_1')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(harness.provider.pollVideo).toHaveBeenCalledTimes(1)
    resolveStalePoll({ status: 'in_progress' })
    await flush()

    expect(harness.provider.pollVideo).toHaveBeenCalledTimes(2)
    expect(harness.database.mediaGenerationJobs.get('request_video_1')?.status)
      .toBe('in_progress')
  })

  it('times out from createdAt at exactly 60 minutes and persists one safe terminal', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const harness = createHarness()
    const runner = new VideoJobRunner(harness.dependencies)
    await runner.submit(submitInput)

    await vi.advanceTimersByTimeAsync(60 * 60 * 1_000)
    await flush()

    expect(harness.database.mediaGenerationJobs.get('request_video_1')).toMatchObject({
      status: 'failed',
      errorCode: 'MEDIA_GENERATION_TIMEOUT',
      endedAt: 60 * 60 * 1_000,
    })
    expect(harness.database.messages.get('assistant_video_1')?.blocks).toEqual([
      expect.objectContaining({
        status: 'failed',
        errorCode: 'MEDIA_GENERATION_TIMEOUT',
      }),
    ])
    expect(harness.database.chatRuns.get('run_video_1')).toMatchObject({
      status: 'failed',
      errorCode: 'MEDIA_GENERATION_TIMEOUT',
    })
  })

  it('aborts a hanging provider poll at the createdAt deadline before persisting timeout', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const harness = createHarness()
    vi.mocked(harness.provider.pollVideo!).mockImplementation(async (_jobId, signal) => (
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { code: 'CANCELLED' }))
        }, { once: true })
      })
    ))
    const runner = new VideoJobRunner(harness.dependencies)
    await runner.submit(submitInput)
    await vi.advanceTimersByTimeAsync(2_000)

    await vi.advanceTimersByTimeAsync(60 * 60 * 1_000 - 2_000)
    await flush()

    expect(harness.database.mediaGenerationJobs.get('request_video_1')).toMatchObject({
      status: 'failed',
      errorCode: 'MEDIA_GENERATION_TIMEOUT',
      endedAt: 60 * 60 * 1_000,
    })
  })

  it('fails terminal provider errors, oversized downloads, and missing conversations without success events', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const failed = createHarness()
    vi.mocked(failed.provider.pollVideo!).mockResolvedValue({
      status: 'failed',
      errorCode: 'MODEL_PROVIDER_REQUEST_FAILED',
    })
    const failedRunner = new VideoJobRunner(failed.dependencies)
    await failedRunner.submit(submitInput)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(failed.database.mediaGenerationJobs.get('request_video_1')).toMatchObject({
      status: 'failed',
      errorCode: 'MODEL_PROVIDER_REQUEST_FAILED',
    })

    const oversized = createHarness()
    vi.mocked(oversized.provider.pollVideo!).mockResolvedValue({ status: 'completed' })
    vi.mocked(oversized.provider.downloadVideo!).mockResolvedValue(new Response(
      new Uint8Array(),
      { headers: { 'content-length': String(500 * 1024 * 1024 + 1) } },
    ))
    const oversizedRunner = new VideoJobRunner(oversized.dependencies)
    await oversizedRunner.submit(submitInput)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(oversized.database.mediaGenerationJobs.get('request_video_1')).toMatchObject({
      status: 'failed',
      errorCode: 'MEDIA_SIZE_LIMIT_EXCEEDED',
    })
    expect(oversized.media.commitGeneratedStream).not.toHaveBeenCalled()

    const missing = createHarness()
    const missingRunner = new VideoJobRunner(missing.dependencies)
    await missingRunner.submit(submitInput)
    missing.database.conversations.delete(submitInput.conversationId)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(missing.provider.pollVideo).not.toHaveBeenCalled()
    expect(missing.events.some((event) => (
      event.type === 'status' && event.status === 'completed'
    ))).toBe(false)
  })

  it('rejects malformed provider job IDs before creating any local turn', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    vi.mocked(harness.provider.submitVideo!).mockResolvedValue({
      providerJobId: 'https://evil.example/jobs/1',
      status: 'pending',
    })
    const runner = new VideoJobRunner(harness.dependencies)

    await expect(runner.submit(submitInput)).rejects.toMatchObject({
      code: 'MODEL_PROVIDER_REQUEST_FAILED',
    })
    expect(harness.database.messages.listForConversation(submitInput.conversationId)).toEqual([])
    expect(harness.database.mediaGenerationJobs.listActive()).toEqual([])
    expect(harness.events).toEqual([])
  })

  it('rejects a missing conversation before making a paid provider submission', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    harness.database.conversations.delete(submitInput.conversationId)
    const runner = new VideoJobRunner(harness.dependencies)

    await expect(runner.submit(submitInput)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(harness.provider.submitVideo).not.toHaveBeenCalled()
    expect(harness.events).toEqual([])
  })

  it('persists the longest provider job ID accepted by the provider contract', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    const providerJobId = `p${'x'.repeat(199)}`
    vi.mocked(harness.provider.submitVideo!).mockResolvedValue({
      providerJobId,
      status: 'pending',
    })
    const runner = new VideoJobRunner(harness.dependencies)

    await expect(runner.submit(submitInput)).resolves.toMatchObject({
      status: 'pending',
    })
    expect(harness.database.mediaGenerationJobs.get('request_video_1')?.providerJobId)
      .toBe(providerJobId)
  })

  it('derives a bounded deterministic output asset ID for the longest accepted request ID', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const harness = createHarness()
    vi.mocked(harness.provider.pollVideo!).mockResolvedValue({ status: 'completed' })
    const requestId = `r${'x'.repeat(127)}`
    const runner = new VideoJobRunner(harness.dependencies)

    await runner.submit({ ...submitInput, requestId })
    await vi.advanceTimersByTimeAsync(2_000)

    const generatedInput = vi.mocked(harness.media.commitGeneratedStream).mock.calls[0]?.[0]
    const generatedAssetId = generatedInput?.assetId ?? ''
    expect(generatedAssetId).toMatch(/^video_[a-f0-9]{64}$/)
    expect(generatedAssetId.length).toBeLessThanOrEqual(128)
  })

  it('keeps downloading durable on stop and reuses a deterministic ready output during recovery', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const harness = createHarness()
    vi.mocked(harness.provider.pollVideo!).mockResolvedValue({
      status: 'completed',
      generationId: 'generation_recovered',
      costUsd: '0.75',
    })
    vi.mocked(harness.provider.downloadVideo!).mockImplementation(async (_jobId, signal) => (
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { code: 'CANCELLED' }))
        }, { once: true })
      })
    ))
    const runner = new VideoJobRunner(harness.dependencies)
    await runner.submit(submitInput)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(harness.database.mediaGenerationJobs.get('request_video_1')?.status).toBe('downloading')
    await runner.stop()
    expect(harness.database.mediaGenerationJobs.get('request_video_1')?.status).toBe('downloading')

    harness.database.mediaAssets.insert({
      id: submittedOutputAssetId,
      conversationId: submitInput.conversationId,
      source: 'generated',
      kind: 'video',
      mimeType: 'video/mp4',
      originalName: 'generated-video.mp4',
      relativePath: `${submitInput.conversationId}/${submittedOutputAssetId}.mp4`,
      byteSize: 24,
      sha256: 'a'.repeat(64),
      provider: 'openrouter',
      model: 'video-model',
      status: 'ready',
      createdAt: 2_000,
      updatedAt: 2_000,
    })
    const ready = videoAsset(submittedOutputAssetId)
    vi.mocked(harness.media.resolveReadyAsset).mockResolvedValue({
      ...ready,
      conversationId: submitInput.conversationId,
      absolutePath: '/managed/video.mp4',
      relativePath: `${submitInput.conversationId}/${submittedOutputAssetId}.mp4`,
      inlineSafe: false,
    })
    const recovered = new VideoJobRunner(harness.dependencies)
    await recovered.recover()
    await flush()

    expect(harness.provider.downloadVideo).toHaveBeenCalledTimes(1)
    expect(harness.database.mediaGenerationJobs.get('request_video_1')?.status).toBe('completed')
    expect(harness.database.chatRuns.get('run_video_1')).toMatchObject({
      status: 'completed',
      generationId: 'generation_recovered',
      costUsd: '0.75',
    })
  })

  it('cancels timers and waits for active I/O abort cleanup before stop resolves', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const harness = createHarness()
    let releaseCleanup!: () => void
    let abortObserved = false
    vi.mocked(harness.provider.pollVideo!).mockImplementation(async (_jobId, signal) => (
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          abortObserved = true
          releaseCleanup = () => reject(Object.assign(new Error('aborted'), { code: 'CANCELLED' }))
        }, { once: true })
      })
    ))
    const runner = new VideoJobRunner(harness.dependencies)
    await runner.submit(submitInput)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    let stopped = false
    const stopping = runner.stop().then(() => { stopped = true })
    await Promise.resolve()
    expect(abortObserved).toBe(true)
    expect(stopped).toBe(false)
    releaseCleanup()
    await stopping

    expect(vi.getTimerCount()).toBe(0)
    expect(harness.database.mediaGenerationJobs.get('request_video_1')?.status).toBe('pending')
  })

  it('waits for an active response stream to cancel while preserving downloading on stop', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const harness = createHarness()
    vi.mocked(harness.provider.pollVideo!).mockResolvedValue({ status: 'completed' })
    let streamCancelled = false
    vi.mocked(harness.provider.downloadVideo!).mockResolvedValue(new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          streamCancelled = true
        },
      }),
      { headers: { 'content-type': 'video/mp4' } },
    ))
    const runner = new VideoJobRunner(harness.dependencies)
    await runner.submit(submitInput)
    await vi.advanceTimersByTimeAsync(2_000)

    await runner.stop()

    expect(streamCancelled).toBe(true)
    expect(harness.database.mediaGenerationJobs.get('request_video_1')?.status)
      .toBe('downloading')
    expect(harness.database.mediaAssets.get(submittedOutputAssetId)).toBeUndefined()
  })

  it('does not delete or claim an unrelated asset that collides with the deterministic recovery ID', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const harness = createHarness()
    const first = new VideoJobRunner(harness.dependencies)
    await first.submit(submitInput)
    await first.stop()
    harness.database.mediaGenerationJobs.transition(
      'request_video_1',
      ['pending'],
      {
        status: 'in_progress',
        updatedAt: 1_500,
        nextPollAt: null,
      },
    )
    harness.database.mediaGenerationJobs.transition(
      'request_video_1',
      ['in_progress'],
      {
        status: 'downloading',
        updatedAt: 1_500,
        nextPollAt: null,
      },
    )
    harness.database.mediaAssets.insert({
      id: submittedOutputAssetId,
      conversationId: submitInput.conversationId,
      source: 'upload',
      kind: 'video',
      mimeType: 'video/mp4',
      originalName: 'unrelated.mp4',
      relativePath: `${submitInput.conversationId}/${submittedOutputAssetId}.mp4`,
      byteSize: 24,
      sha256: 'b'.repeat(64),
      status: 'ready',
      createdAt: 2_000,
      updatedAt: 2_000,
    })

    const recovered = new VideoJobRunner(harness.dependencies)
    await recovered.recover()
    await flush()

    expect(harness.database.mediaGenerationJobs.get('request_video_1')).toMatchObject({
      status: 'failed',
      errorCode: 'MEDIA_GENERATION_FAILED',
    })
    expect(harness.database.mediaAssets.get(submittedOutputAssetId)).toMatchObject({
      source: 'upload',
      originalName: 'unrelated.mp4',
    })
    expect(harness.provider.downloadVideo).not.toHaveBeenCalled()
    expect(harness.media.removeDraft).not.toHaveBeenCalled()
  })
})

describe('video job persistence boundaries', () => {
  it('preserves resumable video chat runs during interrupted recovery', () => {
    const database = createDatabase()
    database.messages.insert({
      id: 'assistant_recovery',
      conversationId: submitInput.conversationId,
      role: 'assistant',
      blocks: [{
        type: 'media_generation',
        blockId: 'block_recovery',
        jobId: 'request_recovery',
        kind: 'video',
        status: 'in_progress',
      }],
      createdAt: 1,
    })
    database.chatRuns.insert({
      id: 'run_recovery',
      conversationId: submitInput.conversationId,
      requestId: 'request_recovery',
      model: 'video-model',
      status: 'running',
      startedAt: 1,
    })
    database.mediaGenerationJobs.insert({
      id: 'request_recovery',
      conversationId: submitInput.conversationId,
      assistantMessageId: 'assistant_recovery',
      provider: 'openrouter',
      model: 'video-model',
      kind: 'video',
      providerJobId: 'provider_recovery',
      status: 'in_progress',
      parameters: {},
      createdAt: 1,
      updatedAt: 1,
    })

    database.recoverInterrupted()

    expect(database.chatRuns.get('run_recovery')?.status).toBe('running')
  })

  it('rolls back the entire submitted turn when the video job insert fails', () => {
    const database = createDatabase()
    database.mediaAssets.insert({
      id: 'asset_atomic',
      conversationId: submitInput.conversationId,
      source: 'upload',
      kind: 'image',
      mimeType: 'image/png',
      originalName: 'atomic.png',
      relativePath: `${submitInput.conversationId}/asset_atomic.png`,
      byteSize: 12,
      sha256: 'a'.repeat(64),
      status: 'ready',
      createdAt: 1,
      updatedAt: 1,
    })
    database.chatRuns.insert({
      id: 'run_existing',
      conversationId: submitInput.conversationId,
      requestId: 'request_atomic',
      model: 'video-model',
      status: 'running',
      startedAt: 1,
    })
    expect(() => database.mediaGenerationJobs.insertTurn({
      userMessage: {
        id: 'user_atomic',
        conversationId: submitInput.conversationId,
        role: 'user',
        blocks: [{
          type: 'media',
          blockId: 'block_asset_atomic',
          assetId: 'asset_atomic',
          kind: 'image',
          purpose: 'input',
          name: 'atomic.png',
          mimeType: 'image/png',
          byteSize: 12,
        }],
        createdAt: 1,
      },
      userAssetIds: ['asset_atomic'],
      assistantMessage: {
        id: 'assistant_atomic',
        conversationId: submitInput.conversationId,
        role: 'assistant',
        blocks: [{
          type: 'media_generation',
          blockId: 'block_atomic',
          jobId: 'request_atomic',
          kind: 'video',
          status: 'pending',
        }],
        createdAt: 1,
      },
      run: {
        id: 'run_atomic',
        conversationId: submitInput.conversationId,
        requestId: 'request_atomic',
        model: 'video-model',
        status: 'running',
        startedAt: 1,
      },
      job: {
        id: 'request_atomic',
        conversationId: submitInput.conversationId,
        assistantMessageId: 'assistant_atomic',
        provider: 'openrouter',
        model: 'video-model',
        kind: 'video',
        providerJobId: 'provider_atomic',
        status: 'pending',
        parameters: generation.video,
        createdAt: 1,
        updatedAt: 1,
      },
    })).toThrow()

    expect(database.messages.get('user_atomic')).toBeUndefined()
    expect(database.messages.get('assistant_atomic')).toBeUndefined()
    expect(database.chatRuns.get('run_atomic')).toBeUndefined()
    expect(database.chatRuns.get('run_existing')?.status).toBe('running')
    expect(database.mediaGenerationJobs.get('request_atomic')).toBeUndefined()
    expect(database.mediaAssets.get('asset_atomic')?.messageId).toBeUndefined()
  })

  it('rolls back asset claim, block replacement, job completion, and run completion together', () => {
    const directory = mkdtempSync(join(tmpdir(), 'autoforge-video-terminal-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'autoforge.sqlite')
    const database = openAppDatabase(path)
    database.conversations.insert({ id: 'conversation_terminal', title: 'Terminal' })
    database.mediaGenerationJobs.insertTurn({
      userMessage: {
        id: 'user_terminal',
        conversationId: 'conversation_terminal',
        role: 'user',
        blocks: [{ type: 'text', text: 'video' }],
        createdAt: 1,
      },
      userAssetIds: [],
      assistantMessage: {
        id: 'assistant_terminal',
        conversationId: 'conversation_terminal',
        role: 'assistant',
        blocks: [{
          type: 'media_generation',
          blockId: 'block_terminal',
          jobId: 'request_terminal',
          kind: 'video',
          status: 'pending',
        }],
        createdAt: 1,
      },
      run: {
        id: 'run_terminal',
        conversationId: 'conversation_terminal',
        requestId: 'request_terminal',
        model: 'video-model',
        status: 'running',
        startedAt: 1,
      },
      job: {
        id: 'request_terminal',
        conversationId: 'conversation_terminal',
        assistantMessageId: 'assistant_terminal',
        provider: 'openrouter',
        model: 'video-model',
        kind: 'video',
        providerJobId: 'provider_terminal',
        status: 'pending',
        parameters: generation.video,
        createdAt: 1,
        updatedAt: 1,
      },
    })
    database.mediaGenerationJobs.transition('request_terminal', ['pending'], {
      status: 'in_progress',
      updatedAt: 2,
      nextPollAt: null,
    })
    database.mediaGenerationJobs.transition('request_terminal', ['in_progress'], {
      status: 'downloading',
      updatedAt: 3,
      nextPollAt: null,
    })
    database.mediaAssets.insert({
      id: 'video_terminal',
      conversationId: 'conversation_terminal',
      source: 'generated',
      kind: 'video',
      mimeType: 'video/mp4',
      originalName: 'terminal.mp4',
      relativePath: 'conversation_terminal/video_terminal.mp4',
      byteSize: 24,
      sha256: 'a'.repeat(64),
      provider: 'openrouter',
      model: 'video-model',
      status: 'ready',
      createdAt: 3,
      updatedAt: 3,
    })
    const fault = new Database(path)
    fault.exec(`
      CREATE TRIGGER fail_video_job_completion
      BEFORE UPDATE ON media_generation_jobs
      WHEN NEW.id = 'request_terminal' AND NEW.status = 'completed'
      BEGIN
        SELECT RAISE(FAIL, 'injected video terminal failure');
      END;
    `)
    fault.close()

    expect(() => database.mediaGenerationJobs.complete(
      'request_terminal',
      ['downloading'],
      {
        assetId: 'video_terminal',
        block: {
          type: 'media',
          blockId: 'block_terminal',
          assetId: 'video_terminal',
          kind: 'video',
          purpose: 'output',
          name: 'terminal.mp4',
          mimeType: 'video/mp4',
          byteSize: 24,
        },
        endedAt: 4,
      },
    )).toThrow()

    expect(database.mediaAssets.get('video_terminal')?.messageId).toBeUndefined()
    expect(database.messages.get('assistant_terminal')?.blocks).toEqual([{
      type: 'media_generation',
      blockId: 'block_terminal',
      jobId: 'request_terminal',
      kind: 'video',
      status: 'downloading',
    }])
    expect(database.mediaGenerationJobs.get('request_terminal')?.status).toBe('downloading')
    expect(database.chatRuns.get('run_terminal')?.status).toBe('running')
  })
})
