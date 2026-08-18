import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type {
  ChatBlock,
  ChatEvent,
  GenerationOptions,
  MediaAsset,
} from '@autoforge/shared'
import { openAppDatabase } from '../database/client.js'
import { ProviderUsageConsistencyError } from '../database/repositories.js'
import type {
  GeneratedStreamInput,
  MediaAssetService,
} from '../media/media-asset-service.js'
import type { ModelProvider, ModelProviderSnapshot } from './model-provider.js'
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
  videoFrameImages: ['first_frame', 'last_frame'],
}

const submitInput = {
  userId: 'user_1',
  requestId: 'request_video_1',
  conversationId: 'conversation_video_1',
  prompt: 'make a short harbor video',
  userBlocks: [{ type: 'text', text: 'make a short harbor video' }] satisfies ChatBlock[],
  assetIds: [] as string[],
  route,
}

const submittedOutputAssetId = 'video_8072e20a4619b4b2251a7c9e4522ab22a9728450834087c29e18d2651db6f0c0'

function createDatabase(databasePath?: string) {
  const path = databasePath ?? (() => {
    const directory = mkdtempSync(join(tmpdir(), 'autoforge-video-runner-'))
    temporaryDirectories.push(directory)
    return join(directory, 'autoforge.sqlite')
  })()
  const database = openAppDatabase(path)
  database.localAuth.createUserAndSession({
    id: 'user_1',
    account: 'User One',
    accountNormalized: 'user one',
    passwordDigest: 'digest-user-1',
    createdAt: 1,
    updatedAt: 1,
  }, 1)
  database.conversations.insert({ id: submitInput.conversationId, title: 'Video' })
  return database
}

function createLegacyV4VideoDatabase(status: 'pending' | 'in_progress' | 'downloading' = 'pending') {
  const directory = mkdtempSync(join(tmpdir(), 'autoforge-video-v4-'))
  temporaryDirectories.push(directory)
  const path = join(directory, 'autoforge.sqlite')
  const sqlite = new Database(path)
  for (const [index, fileName] of [
    '0001_init.sql',
    '0002_multimodal_media.sql',
    '0003_conversation_context.sql',
    '0004_local_auth.sql',
  ].entries()) {
    sqlite.exec(readFileSync(fileURLToPath(new URL(`../../../resources/migrations/${fileName}`, import.meta.url)), 'utf8'))
    sqlite.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(index + 1, index + 1)
  }
  sqlite.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(submitInput.conversationId, 'Legacy video', 1, 1)
  sqlite.prepare('INSERT INTO messages (id, conversation_id, role, blocks_json, ordinal, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('assistant_video_legacy', submitInput.conversationId, 'assistant', JSON.stringify([{
      type: 'media_generation',
      blockId: 'block_video_legacy',
      jobId: submitInput.requestId,
      kind: 'video',
      status,
    }]), 1, 1)
  sqlite.prepare('INSERT INTO chat_runs (id, conversation_id, request_id, model, status, started_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('run_video_legacy', submitInput.conversationId, submitInput.requestId, route.model, 'running', 1)
  sqlite.prepare(`
    INSERT INTO media_generation_jobs (
      id, conversation_id, assistant_message_id, provider, model, kind,
      provider_job_id, status, parameters_json, next_poll_at, poll_attempts,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'video', ?, ?, ?, ?, 0, 1, 1)
  `).run(
    submitInput.requestId,
    submitInput.conversationId,
    'assistant_video_legacy',
    'openrouter',
    route.model,
    'provider_job_legacy',
    status,
    JSON.stringify({ version: 1, options: generation.video }),
    status === 'downloading' ? null : 1,
  )
  sqlite.close()
  return openAppDatabase(path)
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
  overrides: Omit<Partial<VideoJobRunnerDependencies>, 'database'> & {
    database?: ReturnType<typeof createDatabase>
  } = {},
) {
  const database = overrides.database ?? createDatabase()
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
    providerUsage: database.providerUsage,
    providers: {
      acquire: vi.fn(async (providerId): Promise<ModelProviderSnapshot> => ({
        providerId,
        provider: provider as ModelProvider,
        ...(providerId === 'openrouter' ? { apiKeyFingerprint: 'fingerprint_1' } : {}),
      })),
    },
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
  it('rethrows submit-time provider usage consistency errors without failing the durable intent', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const harness = createHarness()
    const markUnknown = vi.spyOn(harness.dependencies.providerUsage, 'markUnknown')
    vi.spyOn(harness.dependencies.providerUsage, 'bindIdentity').mockImplementation(() => {
      throw new ProviderUsageConsistencyError()
    })
    const runner = new VideoJobRunner(harness.dependencies)

    await expect(runner.submit(submitInput)).rejects.toBeInstanceOf(ProviderUsageConsistencyError)

    expect(markUnknown).not.toHaveBeenCalled()
    expect(harness.database.mediaGenerationJobs.get('request_video_1')).toMatchObject({
      status: 'pending',
      providerJobId: 'local:autoforge_video_submission_intent',
    })
    expect(harness.database.chatRuns.get('run_video_1')?.status).toBe('running')
  })

  it('rethrows async provider usage consistency errors without failing the active video job', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const harness = createHarness()
    vi.mocked(harness.provider.pollVideo!).mockResolvedValue({
      status: 'completed',
      generationId: 'generation_consistency_error',
      costUsd: '0.33',
    })
    const runner = new VideoJobRunner(harness.dependencies)
    await runner.submit(submitInput)
    vi.spyOn(harness.dependencies.providerUsage, 'report').mockImplementation(() => {
      throw new ProviderUsageConsistencyError()
    })

    await expect((runner as unknown as { wake(jobId: string): Promise<void> })
      .wake('request_video_1')).rejects.toBeInstanceOf(ProviderUsageConsistencyError)

    expect(harness.database.mediaGenerationJobs.get('request_video_1')?.status).toBe('pending')
    expect(harness.database.chatRuns.get('run_video_1')?.status).toBe('running')
  })

  it('surfaces a timer-started provider usage consistency error through stop', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const harness = createHarness()
    let pollStarted!: () => void
    let releasePoll!: () => void
    const started = new Promise<void>((resolve) => { pollStarted = resolve })
    vi.mocked(harness.provider.pollVideo!).mockImplementation(async () => {
      pollStarted()
      return new Promise((resolve) => {
        releasePoll = () => resolve({
          status: 'completed',
          generationId: 'generation_shutdown_consistency',
          costUsd: '0.34',
        })
      })
    })
    const consistencyError = new ProviderUsageConsistencyError()
    vi.spyOn(harness.dependencies.providerUsage, 'report').mockImplementation(() => {
      throw consistencyError
    })
    const runner = new VideoJobRunner(harness.dependencies)
    await runner.submit(submitInput)

    const timer = vi.advanceTimersByTimeAsync(2_000)
    await started
    const stopping = runner.stop()
    const stoppedWithConsistencyError = expect(stopping).rejects.toBe(consistencyError)
    releasePoll()
    await timer

    await stoppedWithConsistencyError
    expect(harness.database.mediaGenerationJobs.get('request_video_1')?.status).toBe('pending')
    expect(harness.database.chatRuns.get('run_video_1')?.status).toBe('running')
  })

  it('records a completed poll returned after pause before respecting its abort signal', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const harness = createHarness()
    let resolvePoll!: (result: {
      status: 'completed'
      generationId: string
      costUsd: string
    }) => void
    vi.mocked(harness.provider.pollVideo!).mockImplementation(async () => (
      new Promise((resolve) => { resolvePoll = resolve })
    ))
    const bindIdentity = vi.spyOn(harness.dependencies.providerUsage, 'bindIdentity')
    const report = vi.spyOn(harness.dependencies.providerUsage, 'report')
    const runner = new VideoJobRunner(harness.dependencies)
    await runner.submit(submitInput)
    await vi.advanceTimersByTimeAsync(2_000)

    await runner.pause('request_video_1')
    resolvePoll({
      status: 'completed',
      generationId: 'generation_after_pause',
      costUsd: '0.44',
    })
    await flush()

    expect(bindIdentity).toHaveBeenLastCalledWith(
      'video:request_video_1',
      { generationId: 'generation_after_pause' },
    )
    expect(report).toHaveBeenCalledWith('video:request_video_1', {
      generationId: 'generation_after_pause',
      costUsd: '0.44',
      endedAt: 3_000,
    })
    expect(harness.database.mediaGenerationJobs.get('request_video_1')?.status).toBe('paused')
    expect(harness.provider.downloadVideo).not.toHaveBeenCalled()
  })

  it('replays an already reported completion at a new clock without duplicating cost', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const harness = createHarness()
    vi.mocked(harness.provider.pollVideo!).mockResolvedValue({
      status: 'completed',
      generationId: 'generation_replayed',
      costUsd: '0.55',
    })
    const report = vi.spyOn(harness.dependencies.providerUsage, 'report')
    const transition = vi.spyOn(harness.database.mediaGenerationJobs, 'transition')
    transition.mockImplementationOnce(() => undefined)
    const first = new VideoJobRunner(harness.dependencies)
    await first.submit(submitInput)
    await vi.advanceTimersByTimeAsync(2_000)

    expect(harness.database.mediaGenerationJobs.get('request_video_1')?.status).toBe('pending')
    expect(report.mock.results[0]?.value).toMatchObject({ status: 'reported', endedAt: 3_000 })
    transition.mockRestore()
    await first.stop()

    vi.setSystemTime(4_000)
    const recovered = new VideoJobRunner(harness.dependencies)
    await recovered.recover()
    await flush()

    expect(harness.database.mediaGenerationJobs.get('request_video_1')?.status).toBe('completed')
    expect(report).toHaveBeenCalledTimes(2)
    expect(report.mock.results[1]?.value).toMatchObject({ status: 'reported', endedAt: 3_000 })
    expect(harness.database.providerUsage.summarize({
      userId: 'user_1',
      yesterdayStartedAt: 0,
      todayStartedAt: 0,
      weekStartedAt: 0,
      monthStartedAt: 0,
      endedAt: 10_000,
    }).allTime).toMatchObject({
      openRouterCostUsd: '0.55',
      openRouterKnownCostCount: 1,
    })
  })

  it('replays a recovered unknown costless completion at a new clock and continues', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const harness = createHarness()
    const first = new VideoJobRunner(harness.dependencies)
    await first.submit(submitInput)
    await first.stop()
    harness.database.providerUsage.recoverPending(1_500)
    const markUnknown = vi.spyOn(harness.dependencies.providerUsage, 'markUnknown')
    vi.mocked(harness.provider.pollVideo!).mockResolvedValue({ status: 'completed' })

    vi.setSystemTime(3_000)
    const recovered = new VideoJobRunner(harness.dependencies)
    await recovered.recover()
    await flush()

    expect(markUnknown).toHaveBeenCalledWith('video:request_video_1', 3_000)
    expect(markUnknown.mock.results[0]?.value).toMatchObject({ status: 'unknown', endedAt: 1_500 })
    expect(harness.database.mediaGenerationJobs.get('request_video_1')?.status).toBe('completed')
  })

  it('starts the durable OpenRouter usage event before submission and immediately binds the provider job', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const harness = createHarness()
    const start = vi.spyOn(harness.dependencies.providerUsage, 'start')
    const bindIdentity = vi.spyOn(harness.dependencies.providerUsage, 'bindIdentity')

    await new VideoJobRunner(harness.dependencies).submit(submitInput)

    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      id: expect.any(String),
      operationKey: 'video:request_video_1',
      userId: 'user_1',
      apiKeyFingerprint: 'fingerprint_1',
      provider: 'openrouter',
      requestId: 'request_video_1',
      chatRunId: 'run_video_1',
      model: 'video-model',
      modality: 'video',
      startedAt: 1_000,
    }))
    expect(start.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(harness.provider.submitVideo!).mock.invocationCallOrder[0]!,
    )
    expect(bindIdentity).toHaveBeenCalledWith(
      'video:request_video_1',
      { providerJobId: 'provider_job_1' },
    )
    expect(vi.mocked(harness.provider.submitVideo!).mock.invocationCallOrder[0]).toBeLessThan(
      bindIdentity.mock.invocationCallOrder[0]!,
    )
    const request = vi.mocked(harness.provider.submitVideo!).mock.calls[0]?.[0] as unknown as Record<string, unknown>
    expect(request).not.toHaveProperty('endUserId')
  })

  it('binds and reports completed video cost before download and keeps it when download fails', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const harness = createHarness()
    const bindIdentity = vi.spyOn(harness.dependencies.providerUsage, 'bindIdentity')
    const report = vi.spyOn(harness.dependencies.providerUsage, 'report')
    vi.mocked(harness.provider.pollVideo!).mockResolvedValue({
      status: 'completed',
      generationId: 'generation_paid',
      costUsd: '0.42',
    })
    vi.mocked(harness.provider.downloadVideo!).mockRejectedValue({ code: 'MEDIA_DOWNLOAD_FAILED' })
    const runner = new VideoJobRunner(harness.dependencies)
    await runner.submit(submitInput)

    await vi.advanceTimersByTimeAsync(2_000)
    await flush()

    expect(bindIdentity).toHaveBeenCalledWith(
      'video:request_video_1',
      { generationId: 'generation_paid' },
    )
    expect(report).toHaveBeenCalledWith('video:request_video_1', {
      generationId: 'generation_paid',
      costUsd: '0.42',
      endedAt: 3_000,
    })
    expect(bindIdentity.mock.invocationCallOrder.at(-1)).toBeLessThan(
      report.mock.invocationCallOrder[0]!,
    )
    expect(report.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(harness.provider.downloadVideo!).mock.invocationCallOrder[0]!,
    )
    expect(harness.database.mediaGenerationJobs.get('request_video_1')?.status).toBe('failed')
    expect(harness.database.providerUsage.summarize({
      userId: 'user_1',
      yesterdayStartedAt: 0,
      todayStartedAt: 0,
      weekStartedAt: 0,
      monthStartedAt: 0,
      endedAt: 10_000,
    }).allTime).toMatchObject({
      openRouterCostUsd: '0.42',
      openRouterKnownCostCount: 1,
      openRouterUnknownCostCount: 0,
    })
  })

  it.each([
    { name: 'with generation identity', generationId: 'generation_costless' },
    { name: 'without generation identity', generationId: undefined },
  ])('marks a completed costless video unknown $name', async ({ generationId }) => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const harness = createHarness()
    const bindIdentity = vi.spyOn(harness.dependencies.providerUsage, 'bindIdentity')
    const markUnknown = vi.spyOn(harness.dependencies.providerUsage, 'markUnknown')
    vi.mocked(harness.provider.pollVideo!).mockResolvedValue({
      status: 'completed',
      ...(generationId === undefined ? {} : { generationId }),
    })
    const runner = new VideoJobRunner(harness.dependencies)
    await runner.submit(submitInput)

    await vi.advanceTimersByTimeAsync(2_000)
    await flush()

    if (generationId === undefined) {
      expect(bindIdentity).toHaveBeenCalledTimes(1)
    } else {
      expect(bindIdentity).toHaveBeenLastCalledWith(
        'video:request_video_1',
        { generationId },
      )
    }
    expect(markUnknown).toHaveBeenCalledWith('video:request_video_1', 3_000)
    expect(markUnknown.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(harness.provider.downloadVideo!).mock.invocationCallOrder[0]!,
    )
    expect(harness.database.providerUsage.summarize({
      userId: 'user_1',
      yesterdayStartedAt: 0,
      todayStartedAt: 0,
      weekStartedAt: 0,
      monthStartedAt: 0,
      endedAt: 10_000,
    }).allTime).toMatchObject({
      openRouterKnownCostCount: 0,
      openRouterUnknownCostCount: 1,
    })
  })

  it('reports a recovered video to its persisted submitter attribution after restart', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const directory = mkdtempSync(join(tmpdir(), 'autoforge-video-usage-restart-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'autoforge.sqlite')
    const database = createDatabase(path)
    const submittingHarness = createHarness({ database })
    const submitting = new VideoJobRunner(submittingHarness.dependencies)
    await submitting.submit(submitInput)
    await submitting.stop()
    database.close()

    const reopened = openAppDatabase(path)
    reopened.localAuth.createUserAndSession({
      id: 'user_2',
      account: 'User Two',
      accountNormalized: 'user two',
      passwordDigest: 'digest-user-2',
      createdAt: 1_500,
      updatedAt: 1_500,
    }, 1_500)
    expect(reopened.localAuth.getCurrentSession()?.user.id).toBe('user_2')
    reopened.providerUsage.recoverPending(1_500)
    const recoveredHarness = createHarness({ database: reopened })
    vi.mocked(recoveredHarness.provider.pollVideo!).mockResolvedValue({
      status: 'completed',
      generationId: 'generation_recovered',
      costUsd: '0.75',
    })
    vi.setSystemTime(3_000)
    const recovered = new VideoJobRunner(recoveredHarness.dependencies)
    await recovered.recover()
    await flush()

    expect(recoveredHarness.database.providerUsage.summarize({
      userId: 'user_1',
      yesterdayStartedAt: 0,
      todayStartedAt: 0,
      weekStartedAt: 0,
      monthStartedAt: 0,
      endedAt: 10_000,
    }).allTime).toMatchObject({
      openRouterCostUsd: '0.75',
      openRouterKnownCostCount: 1,
      openRouterUnknownCostCount: 0,
    })
    expect(recoveredHarness.database.providerUsage.summarize({
      userId: 'user_2',
      yesterdayStartedAt: 0,
      todayStartedAt: 0,
      weekStartedAt: 0,
      monthStartedAt: 0,
      endedAt: 10_000,
    }).allTime).toMatchObject({
      openRouterCostUsd: '0',
      openRouterKnownCostCount: 0,
      openRouterUnknownCostCount: 0,
    })
    reopened.close()
    const inspection = new Database(path, { readonly: true })
    expect(inspection.prepare(`
      SELECT user_id AS userId, api_key_fingerprint AS apiKeyFingerprint, status
      FROM provider_usage_events
      WHERE operation_key = ?
    `).get('video:request_video_1')).toEqual({
      userId: 'user_1',
      apiKeyFingerprint: 'fingerprint_1',
      status: 'reported',
    })
    inspection.close()
  })

  it.each([
    {
      name: 'completed and downloaded',
      configure: (harness: ReturnType<typeof createHarness>) => {
        vi.mocked(harness.provider.pollVideo!).mockResolvedValue({
          status: 'completed',
          generationId: 'generation_legacy',
          costUsd: '0.81',
        })
      },
      expectedStatus: 'completed',
    },
    {
      name: 'provider failed',
      configure: (harness: ReturnType<typeof createHarness>) => {
        vi.mocked(harness.provider.pollVideo!).mockResolvedValue({
          status: 'failed',
          errorCode: 'MODEL_PROVIDER_REQUEST_FAILED',
        })
      },
      expectedStatus: 'failed',
    },
    {
      name: 'download failed',
      configure: (harness: ReturnType<typeof createHarness>) => {
        vi.mocked(harness.provider.pollVideo!).mockResolvedValue({
          status: 'completed',
          generationId: 'generation_legacy_download',
          costUsd: '0.82',
        })
        vi.mocked(harness.provider.downloadVideo!).mockRejectedValue({ code: 'MEDIA_DOWNLOAD_FAILED' })
      },
      expectedStatus: 'failed',
    },
    {
      name: 'local asset commit failed',
      configure: (harness: ReturnType<typeof createHarness>) => {
        vi.mocked(harness.provider.pollVideo!).mockResolvedValue({
          status: 'completed',
          generationId: 'generation_legacy_local',
          costUsd: '0.83',
        })
        vi.mocked(harness.media.commitGeneratedStream).mockRejectedValue(new Error('disk unavailable'))
      },
      expectedStatus: 'failed',
    },
  ])('recovers a real v4 legacy OpenRouter video when $name without creating billing', async ({ configure, expectedStatus }) => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const database = createLegacyV4VideoDatabase()
    const harness = createHarness({ database })
    configure(harness)
    const start = vi.spyOn(harness.dependencies.providerUsage, 'start')
    const bindIdentity = vi.spyOn(harness.dependencies.providerUsage, 'bindIdentity')
    const report = vi.spyOn(harness.dependencies.providerUsage, 'report')
    const markUnknown = vi.spyOn(harness.dependencies.providerUsage, 'markUnknown')

    const recovered = new VideoJobRunner(harness.dependencies)
    await recovered.recover()
    await flush()

    expect(database.mediaGenerationJobs.get(submitInput.requestId)?.status).toBe(expectedStatus)
    expect(database.chatRuns.getByRequestId(submitInput.requestId)?.status)
      .toBe(expectedStatus === 'completed' ? 'completed' : 'failed')
    expect(database.providerUsage.find(`video:${submitInput.requestId}`)).toBeUndefined()
    expect(start).not.toHaveBeenCalled()
    expect(bindIdentity).not.toHaveBeenCalled()
    expect(report).not.toHaveBeenCalled()
    expect(markUnknown).not.toHaveBeenCalled()
  })

  it('finishes an already-downloading v4 legacy OpenRouter video without billing it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const database = createLegacyV4VideoDatabase('downloading')
    const harness = createHarness({ database })
    harness.dependencies.providers = {
      acquire: vi.fn(async (): Promise<ModelProviderSnapshot> => ({
        providerId: 'openrouter' as const,
        provider: harness.provider as ModelProvider,
        apiKeyFingerprint: 'legacy_current_fingerprint',
      })),
    }
    const runner = new VideoJobRunner(harness.dependencies)

    await runner.recover()
    await flush()

    expect(harness.provider.pollVideo).not.toHaveBeenCalled()
    expect(harness.provider.downloadVideo).toHaveBeenCalledTimes(1)
    expect(database.mediaGenerationJobs.get(submitInput.requestId)?.status).toBe('completed')
    expect(database.providerUsage.find(`video:${submitInput.requestId}`)).toBeUndefined()
  })

  it('rejects an owned v5 OpenRouter video whose durable usage event is missing', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const harness = createHarness()
    harness.database.messages.insert({
      id: 'assistant_owned_missing_usage',
      conversationId: submitInput.conversationId,
      role: 'assistant',
      blocks: [{
        type: 'media_generation', blockId: 'block_owned_missing_usage',
        jobId: 'request_owned_missing_usage', kind: 'video', status: 'pending',
      }],
      createdAt: 1,
    })
    harness.database.chatRuns.insert({
      id: 'run_owned_missing_usage',
      conversationId: submitInput.conversationId,
      requestId: 'request_owned_missing_usage',
      userId: 'user_1',
      provider: 'openrouter',
      model: route.model,
      status: 'running',
      startedAt: 1,
    })
    harness.database.mediaGenerationJobs.insert({
      id: 'request_owned_missing_usage',
      conversationId: submitInput.conversationId,
      assistantMessageId: 'assistant_owned_missing_usage',
      provider: 'openrouter',
      model: route.model,
      kind: 'video',
      providerJobId: 'provider_owned_missing_usage',
      status: 'pending',
      parameters: { version: 1, options: generation.video },
      nextPollAt: 1,
      pollAttempts: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    const runner = new VideoJobRunner(harness.dependencies)

    await runner.recover()
    await flush()
    await expect(runner.stop()).rejects.toBeInstanceOf(ProviderUsageConsistencyError)

    expect(harness.provider.pollVideo).not.toHaveBeenCalled()
    expect(harness.database.mediaGenerationJobs.get('request_owned_missing_usage')?.pollAttempts).toBe(0)
  })

  it('rejects contradictory legacy ownership when an attributed usage event exists', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const database = createLegacyV4VideoDatabase()
    database.localAuth.createUserAndSession({
      id: 'user_legacy_conflict',
      account: 'Legacy Conflict',
      accountNormalized: 'legacy conflict',
      passwordDigest: 'digest-legacy-conflict',
      createdAt: 1,
      updatedAt: 1,
    }, 1)
    database.providerUsage.start({
      id: 'usage_legacy_conflict',
      operationKey: `video:${submitInput.requestId}`,
      userId: 'user_legacy_conflict',
      provider: 'openrouter',
      apiKeyFingerprint: 'fingerprint_1',
      requestId: submitInput.requestId,
      chatRunId: 'run_video_legacy',
      model: route.model,
      modality: 'video',
      startedAt: 1,
    })
    database.providerUsage.bindIdentity(`video:${submitInput.requestId}`, {
      providerJobId: 'provider_job_legacy',
    })
    const harness = createHarness({ database })
    const runner = new VideoJobRunner(harness.dependencies)

    await expect((runner as unknown as { wake(jobId: string): Promise<void> })
      .wake(submitInput.requestId)).rejects.toBeInstanceOf(ProviderUsageConsistencyError)

    expect(harness.provider.pollVideo).not.toHaveBeenCalled()
    expect(database.mediaGenerationJobs.get(submitInput.requestId)?.pollAttempts).toBe(0)
  })

  it('keeps one acquired provider snapshot for submit, poll and download', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const harness = createHarness()
    const providerB = {
      submitVideo: vi.fn(async () => ({ providerJobId: 'provider_job_b', status: 'pending' as const })),
      pollVideo: vi.fn(async () => ({ status: 'completed' as const, costUsd: '9' })),
      downloadVideo: vi.fn(async () => new Response()),
    } satisfies Pick<ModelProvider, 'submitVideo' | 'pollVideo' | 'downloadVideo'>
    const snapshotA: ModelProviderSnapshot = {
      providerId: 'openrouter',
      provider: harness.provider as ModelProvider,
      apiKeyFingerprint: 'fingerprint_1',
    }
    const snapshotB: ModelProviderSnapshot = {
      providerId: 'openrouter',
      provider: providerB as unknown as ModelProvider,
      apiKeyFingerprint: 'fingerprint_2',
    }
    let current = snapshotA
    const acquire = vi.fn(async () => current)
    harness.dependencies.providers = { acquire }
    vi.mocked(harness.provider.pollVideo!).mockResolvedValue({
      status: 'completed', generationId: 'generation_snapshot', costUsd: '0.9',
    })
    const runner = new VideoJobRunner(harness.dependencies)

    await runner.submit(submitInput)
    current = snapshotB
    await vi.advanceTimersByTimeAsync(2_000)
    await flush()

    expect(acquire).toHaveBeenCalledTimes(1)
    expect(harness.provider.submitVideo).toHaveBeenCalledTimes(1)
    expect(harness.provider.pollVideo).toHaveBeenCalledTimes(1)
    expect(harness.provider.downloadVideo).toHaveBeenCalledTimes(1)
    expect(providerB.submitVideo).not.toHaveBeenCalled()
    expect(providerB.pollVideo).not.toHaveBeenCalled()
    expect(providerB.downloadVideo).not.toHaveBeenCalled()
    expect(harness.database.providerUsage.find(`video:${submitInput.requestId}`)?.apiKeyFingerprint)
      .toBe('fingerprint_1')
  })

  it('does not poll or spend attempts after restart until the persisted credential fingerprint matches', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const harness = createHarness()
    const snapshotA: ModelProviderSnapshot = {
      providerId: 'openrouter', provider: harness.provider as ModelProvider,
      apiKeyFingerprint: 'fingerprint_1',
    }
    const snapshotB: ModelProviderSnapshot = {
      providerId: 'openrouter', provider: harness.provider as ModelProvider,
      apiKeyFingerprint: 'fingerprint_2',
    }
    harness.dependencies.providers = {
      acquire: vi.fn(async () => snapshotA),
    }
    const submitting = new VideoJobRunner(harness.dependencies)
    await submitting.submit(submitInput)
    await submitting.stop()

    vi.setSystemTime(3_000)
    let current: ModelProviderSnapshot | undefined
    harness.dependencies.providers = {
      acquire: vi.fn(async () => {
        if (current === undefined) throw Object.assign(new Error('missing'), { code: 'CREDENTIAL_UNAVAILABLE' })
        return current
      }),
    }
    const recovered = new VideoJobRunner(harness.dependencies)
    await recovered.recover()
    await flush()

    expect(harness.provider.pollVideo).not.toHaveBeenCalled()
    expect(harness.database.mediaGenerationJobs.get(submitInput.requestId)?.pollAttempts).toBe(0)
    current = snapshotB
    await vi.advanceTimersByTimeAsync(2_000)

    expect(harness.provider.pollVideo).not.toHaveBeenCalled()
    expect(harness.database.mediaGenerationJobs.get(submitInput.requestId)?.pollAttempts).toBe(0)
    expect(harness.database.providerUsage.find(`video:${submitInput.requestId}`)).toMatchObject({
      reconcileAttempts: 0,
      apiKeyFingerprint: 'fingerprint_1',
    })

    vi.mocked(harness.provider.pollVideo!).mockResolvedValue({ status: 'in_progress' })
    current = snapshotA
    await vi.advanceTimersByTimeAsync(1_999)
    expect(harness.provider.pollVideo).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(harness.provider.pollVideo).toHaveBeenCalledTimes(1)
    expect(harness.database.mediaGenerationJobs.get(submitInput.requestId)?.pollAttempts).toBe(1)
  })

  it('retries a credential-unavailable legacy job without attributing or spending attempts', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const database = createLegacyV4VideoDatabase()
    const harness = createHarness({ database })
    const snapshot: ModelProviderSnapshot = {
      providerId: 'openrouter', provider: harness.provider as ModelProvider,
      apiKeyFingerprint: 'current_legacy_fingerprint',
    }
    let available = false
    harness.dependencies.providers = {
      acquire: vi.fn(async () => {
        if (!available) throw Object.assign(new Error('missing'), { code: 'CREDENTIAL_UNAVAILABLE' })
        return snapshot
      }),
    }
    vi.mocked(harness.provider.pollVideo!).mockResolvedValue({ status: 'completed' })
    const runner = new VideoJobRunner(harness.dependencies)

    await runner.recover()
    await flush()
    expect(harness.provider.pollVideo).not.toHaveBeenCalled()
    expect(database.mediaGenerationJobs.get(submitInput.requestId)?.pollAttempts).toBe(0)

    available = true
    await vi.advanceTimersByTimeAsync(2_000)

    expect(harness.provider.pollVideo).toHaveBeenCalledTimes(1)
    expect(database.mediaGenerationJobs.get(submitInput.requestId)?.status).toBe('completed')
    expect(database.providerUsage.find(`video:${submitInput.requestId}`)).toBeUndefined()
  })

  it('caps credential retry at the original video deadline', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(3_599_000)
    const database = createLegacyV4VideoDatabase()
    const harness = createHarness({ database })
    harness.dependencies.providers = {
      acquire: vi.fn(async () => {
        throw Object.assign(new Error('missing'), { code: 'CREDENTIAL_UNAVAILABLE' })
      }),
    }
    const runner = new VideoJobRunner(harness.dependencies)

    await runner.recover()
    await flush()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(database.mediaGenerationJobs.get(submitInput.requestId)?.status).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)

    expect(harness.provider.pollVideo).not.toHaveBeenCalled()
    expect(database.mediaGenerationJobs.get(submitInput.requestId)).toMatchObject({
      status: 'failed',
      errorCode: 'MEDIA_GENERATION_TIMEOUT',
      endedAt: 3_600_001,
    })
    expect(database.providerUsage.find(`video:${submitInput.requestId}`)).toBeUndefined()
  })

  it('does not poll when a job is paused while credential acquisition is pending', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const harness = createHarness()
    const snapshot: ModelProviderSnapshot = {
      providerId: 'openrouter', provider: harness.provider as ModelProvider,
      apiKeyFingerprint: 'fingerprint_1',
    }
    const submitting = new VideoJobRunner(harness.dependencies)
    await submitting.submit(submitInput)
    await submitting.stop()

    let resolveAcquire!: (snapshot: ModelProviderSnapshot) => void
    harness.dependencies.providers = {
      acquire: vi.fn(async () => new Promise<ModelProviderSnapshot>((resolve) => {
        resolveAcquire = resolve
      })),
    }
    vi.setSystemTime(3_000)
    const recovered = new VideoJobRunner(harness.dependencies)
    await recovered.recover()
    await flush()
    expect(resolveAcquire).toBeTypeOf('function')

    await recovered.pause(submitInput.requestId)
    resolveAcquire(snapshot)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(harness.database.mediaGenerationJobs.get(submitInput.requestId)?.status).toBe('paused')
    expect(harness.provider.pollVideo).not.toHaveBeenCalled()
    expect(harness.provider.downloadVideo).not.toHaveBeenCalled()
    await recovered.stop()
  })

  it('drains a delayed acquisition on stop without downloading after the job becomes stale', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const harness = createHarness()
    const snapshot: ModelProviderSnapshot = {
      providerId: 'openrouter', provider: harness.provider as ModelProvider,
      apiKeyFingerprint: 'fingerprint_1',
    }
    const submitting = new VideoJobRunner(harness.dependencies)
    await submitting.submit(submitInput)
    await submitting.stop()
    harness.database.mediaGenerationJobs.transition(submitInput.requestId, ['pending'], {
      status: 'in_progress',
      pollAttempts: 0,
      nextPollAt: null,
      updatedAt: 2_000,
    })
    harness.database.mediaGenerationJobs.transition(submitInput.requestId, ['in_progress'], {
      status: 'downloading',
      pollAttempts: 0,
      nextPollAt: null,
      updatedAt: 2_000,
    })

    let resolveAcquire!: (snapshot: ModelProviderSnapshot) => void
    harness.dependencies.providers = {
      acquire: vi.fn(async () => new Promise<ModelProviderSnapshot>((resolve) => {
        resolveAcquire = resolve
      })),
    }
    vi.setSystemTime(3_000)
    const recovered = new VideoJobRunner(harness.dependencies)
    await recovered.recover()
    await flush()
    expect(resolveAcquire).toBeTypeOf('function')

    let stopped = false
    const stopping = recovered.stop().then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    resolveAcquire(snapshot)
    await stopping

    expect(harness.provider.pollVideo).not.toHaveBeenCalled()
    expect(harness.provider.downloadVideo).not.toHaveBeenCalled()
    expect(harness.database.mediaGenerationJobs.get(submitInput.requestId)?.status).toBe('downloading')
  })
  it('persists a complete submission intent before the provider request can settle', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const harness = createHarness()
    vi.mocked(harness.provider.submitVideo!).mockImplementation(async () => (
      new Promise(() => undefined)
    ))
    const runner = new VideoJobRunner(harness.dependencies)

    void runner.submit(submitInput).catch(() => undefined)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(harness.provider.submitVideo).toHaveBeenCalledTimes(1)
    expect(harness.database.messages.get('user_message_1')).toMatchObject({
      role: 'user',
      blocks: submitInput.userBlocks,
    })
    expect(harness.database.messages.get('assistant_video_1')?.blocks).toEqual([{
      type: 'media_generation',
      blockId: 'block_video_1',
      jobId: 'request_video_1',
      kind: 'video',
      status: 'pending',
    }])
    expect(harness.database.chatRuns.get('run_video_1')).toMatchObject({
      requestId: 'request_video_1',
      userId: 'user_1',
      provider: 'openrouter',
      status: 'running',
    })
    expect(harness.database.mediaGenerationJobs.get('request_video_1')).toMatchObject({
      providerJobId: 'local:autoforge_video_submission_intent',
      status: 'pending',
      parameters: {
        version: 1,
        options: generation.video,
        submission: { phase: 'intent' },
      },
    })
  })

  it('rolls back a failed intent transaction before any provider request', async () => {
    vi.useFakeTimers()
    const directory = mkdtempSync(join(tmpdir(), 'autoforge-video-intent-failure-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'autoforge.sqlite')
    const database = createDatabase(path)
    const harness = createHarness({ database })
    const fault = new Database(path)
    fault.exec(`
      CREATE TRIGGER fail_video_intent_insert
      BEFORE INSERT ON media_generation_jobs
      BEGIN
        SELECT RAISE(FAIL, 'injected intent insert failure');
      END;
    `)
    fault.close()
    const runner = new VideoJobRunner(harness.dependencies)

    await expect(runner.submit(submitInput)).rejects.toMatchObject({
      code: 'MEDIA_GENERATION_FAILED',
    })
    expect(harness.provider.submitVideo).not.toHaveBeenCalled()
    expect(harness.media.modelInput).not.toHaveBeenCalled()
    expect(harness.database.messages.listForConversation(submitInput.conversationId)).toEqual([])
    expect(harness.database.chatRuns.get('run_video_1')).toBeUndefined()
    expect(harness.database.mediaGenerationJobs.get('request_video_1')).toBeUndefined()
  })

  it('returns a failed acknowledgement and atomically terminates the intent when provider submission rejects', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const harness = createHarness()
    vi.mocked(harness.provider.submitVideo!).mockRejectedValue({
      code: 'MODEL_PROVIDER_REQUEST_FAILED',
    })
    const runner = new VideoJobRunner(harness.dependencies)

    await expect(runner.submit(submitInput)).resolves.toEqual({
      jobId: 'request_video_1',
      requestId: 'request_video_1',
      status: 'failed',
    })
    expect(harness.database.mediaGenerationJobs.get('request_video_1')).toMatchObject({
      providerJobId: 'local:autoforge_video_submission_intent',
      status: 'failed',
      errorCode: 'MODEL_PROVIDER_REQUEST_FAILED',
    })
    expect(harness.database.chatRuns.get('run_video_1')).toMatchObject({
      status: 'failed',
      errorCode: 'MODEL_PROVIDER_REQUEST_FAILED',
    })
    expect(harness.database.messages.get('assistant_video_1')?.blocks).toEqual([
      expect.objectContaining({
        status: 'failed',
        errorCode: 'MODEL_PROVIDER_REQUEST_FAILED',
      }),
    ])
    expect(harness.events).toContainEqual(expect.objectContaining({
      type: 'status',
      requestId: 'request_video_1',
      status: 'failed',
    }))
  })

  it('keeps a complete diagnosable intent when the atomic provider bind fails', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const directory = mkdtempSync(join(tmpdir(), 'autoforge-video-bind-failure-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'autoforge.sqlite')
    const database = createDatabase(path)
    const harness = createHarness({ database })
    const fault = new Database(path)
    fault.exec(`
      CREATE TRIGGER fail_video_provider_bind
      BEFORE UPDATE OF provider_job_id ON media_generation_jobs
      WHEN OLD.provider_job_id = 'local:autoforge_video_submission_intent'
        AND NEW.provider_job_id <> OLD.provider_job_id
      BEGIN
        SELECT RAISE(FAIL, 'injected provider bind failure');
      END;
    `)
    fault.close()
    const runner = new VideoJobRunner(harness.dependencies)

    await expect(runner.submit(submitInput)).resolves.toEqual({
      jobId: 'request_video_1',
      requestId: 'request_video_1',
      status: 'failed',
    })
    expect(harness.database.mediaGenerationJobs.get('request_video_1')).toMatchObject({
      providerJobId: 'local:autoforge_video_submission_intent',
      status: 'failed',
      errorCode: 'MEDIA_GENERATION_FAILED',
    })
    expect(harness.database.messages.get('user_message_1')).toBeDefined()
    expect(harness.database.messages.get('assistant_video_1')?.blocks).toEqual([
      expect.objectContaining({
        status: 'failed',
        errorCode: 'MEDIA_GENERATION_FAILED',
      }),
    ])
    expect(harness.database.chatRuns.get('run_video_1')).toMatchObject({
      status: 'failed',
      errorCode: 'MEDIA_GENERATION_FAILED',
    })
  })

  it('leaves a failed-to-bind intent recoverable when the immediate terminal write also fails', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const directory = mkdtempSync(join(tmpdir(), 'autoforge-video-bind-and-fail-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'autoforge.sqlite')
    const database = createDatabase(path)
    const harness = createHarness({ database })
    const fault = new Database(path)
    fault.exec(`
      CREATE TRIGGER fail_video_provider_bind_twice
      BEFORE UPDATE OF provider_job_id ON media_generation_jobs
      WHEN OLD.provider_job_id = 'local:autoforge_video_submission_intent'
        AND NEW.provider_job_id <> OLD.provider_job_id
      BEGIN
        SELECT RAISE(FAIL, 'injected provider bind failure');
      END;
      CREATE TRIGGER fail_immediate_intent_terminal
      BEFORE UPDATE OF status ON media_generation_jobs
      WHEN OLD.provider_job_id = 'local:autoforge_video_submission_intent'
        AND NEW.status = 'failed'
        AND NEW.updated_at = 1000
      BEGIN
        SELECT RAISE(FAIL, 'injected immediate terminal failure');
      END;
    `)
    fault.close()
    const runner = new VideoJobRunner(harness.dependencies)

    await expect(runner.submit(submitInput)).rejects.toBeDefined()
    expect(harness.database.mediaGenerationJobs.get('request_video_1')).toMatchObject({
      providerJobId: 'local:autoforge_video_submission_intent',
      status: 'pending',
      parameters: expect.objectContaining({
        submission: { phase: 'intent' },
      }),
    })
    expect(harness.database.messages.get('user_message_1')).toBeDefined()
    expect(harness.database.messages.get('assistant_video_1')).toBeDefined()
    expect(harness.database.chatRuns.get('run_video_1')?.status).toBe('running')
    expect(harness.provider.pollVideo).not.toHaveBeenCalled()
    database.close()

    vi.setSystemTime(2_000)
    const reopened = openAppDatabase(path)
    reopened.recoverInterrupted()
    expect(reopened.mediaGenerationJobs.get('request_video_1')).toMatchObject({
      providerJobId: 'local:autoforge_video_submission_intent',
      status: 'failed',
      errorCode: 'MEDIA_GENERATION_FAILED',
    })
    expect(reopened.chatRuns.get('run_video_1')?.status).toBe('failed')
    expect(reopened.messages.get('assistant_video_1')?.blocks).toEqual([
      expect.objectContaining({ status: 'failed' }),
    ])
    reopened.close()
  })

  it('atomically binds the provider ID and matching active block before scheduling', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const harness = createHarness()
    vi.mocked(harness.provider.submitVideo!).mockResolvedValue({
      providerJobId: 'provider_bound',
      status: 'in_progress',
    })
    const runner = new VideoJobRunner(harness.dependencies)

    await expect(runner.submit(submitInput)).resolves.toMatchObject({
      status: 'in_progress',
    })
    expect(harness.database.mediaGenerationJobs.get('request_video_1')).toMatchObject({
      providerJobId: 'provider_bound',
      status: 'in_progress',
      nextPollAt: 3_000,
      parameters: {
        version: 1,
        options: generation.video,
      },
    })
    expect(harness.database.messages.get('assistant_video_1')?.blocks).toEqual([{
      type: 'media_generation',
      blockId: 'block_video_1',
      jobId: 'request_video_1',
      kind: 'video',
      status: 'in_progress',
    }])
    expect(harness.database.chatRuns.get('run_video_1')).toMatchObject({
      requestId: 'request_video_1',
      status: 'running',
    })
  })

  it('binds the former sentinel text when a provider returns it as a valid provider ID', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const harness = createHarness()
    vi.mocked(harness.provider.submitVideo!).mockResolvedValue({
      providerJobId: 'autoforge_video_submission_intent',
      status: 'pending',
    })
    const runner = new VideoJobRunner(harness.dependencies)

    await expect(runner.submit(submitInput)).resolves.toMatchObject({
      status: 'pending',
    })
    expect(harness.database.mediaGenerationJobs.get('request_video_1')).toMatchObject({
      providerJobId: 'autoforge_video_submission_intent',
      status: 'pending',
      nextPollAt: 3_000,
    })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(harness.provider.pollVideo).toHaveBeenCalledWith(
      'autoforge_video_submission_intent',
      expect.any(AbortSignal),
    )
  })

  it('fails an unbound intent during runner recovery without polling its sentinel', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const harness = createHarness()
    vi.mocked(harness.provider.submitVideo!).mockImplementation(async () => (
      new Promise(() => undefined)
    ))
    const submitting = new VideoJobRunner(harness.dependencies)
    void submitting.submit(submitInput).catch(() => undefined)
    await Promise.resolve()
    await Promise.resolve()

    const recovered = new VideoJobRunner(harness.dependencies)
    await recovered.recover()
    await flush()

    expect(harness.provider.pollVideo).not.toHaveBeenCalled()
    expect(harness.database.mediaGenerationJobs.get('request_video_1')).toMatchObject({
      providerJobId: 'local:autoforge_video_submission_intent',
      status: 'failed',
      errorCode: 'MEDIA_GENERATION_FAILED',
    })
    expect(harness.database.chatRuns.get('run_video_1')).toMatchObject({
      status: 'failed',
      errorCode: 'MEDIA_GENERATION_FAILED',
    })
    expect(harness.database.messages.get('assistant_video_1')?.blocks).toEqual([
      expect.objectContaining({
        status: 'failed',
        errorCode: 'MEDIA_GENERATION_FAILED',
      }),
    ])
  })

  it('never polls the reserved sentinel even when intent parameters are corrupt', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const harness = createHarness()
    vi.mocked(harness.provider.submitVideo!).mockImplementation(async () => (
      new Promise(() => undefined)
    ))
    const submitting = new VideoJobRunner(harness.dependencies)
    void submitting.submit(submitInput).catch(() => undefined)
    await Promise.resolve()
    await Promise.resolve()
    harness.database.mediaGenerationJobs.update('request_video_1', {
      parameters: {},
      updatedAt: 1_001,
    })

    const recovered = new VideoJobRunner(harness.dependencies)
    await recovered.recover()
    await flush()

    expect(harness.provider.pollVideo).not.toHaveBeenCalled()
    expect(harness.database.mediaGenerationJobs.get('request_video_1')).toMatchObject({
      providerJobId: 'local:autoforge_video_submission_intent',
      status: 'failed',
    })
  })

  it('reopens a crashed pre-bind intent as terminal instead of resumable', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const directory = mkdtempSync(join(tmpdir(), 'autoforge-video-intent-recovery-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'autoforge.sqlite')
    const database = createDatabase(path)
    const harness = createHarness({ database })
    vi.mocked(harness.provider.submitVideo!).mockImplementation(async () => (
      new Promise(() => undefined)
    ))
    const submitting = new VideoJobRunner(harness.dependencies)
    void submitting.submit(submitInput).catch(() => undefined)
    await Promise.resolve()
    await Promise.resolve()
    database.close()

    const reopened = openAppDatabase(path)
    reopened.recoverInterrupted()

    expect(reopened.mediaGenerationJobs.get('request_video_1')).toMatchObject({
      providerJobId: 'local:autoforge_video_submission_intent',
      status: 'failed',
      errorCode: 'MEDIA_GENERATION_FAILED',
    })
    expect(reopened.chatRuns.get('run_video_1')).toMatchObject({
      status: 'failed',
    })
    expect(reopened.messages.get('assistant_video_1')?.blocks).toEqual([
      expect.objectContaining({
        status: 'failed',
        errorCode: 'MEDIA_GENERATION_FAILED',
      }),
    ])
    expect(reopened.mediaGenerationJobs.listActive()).toEqual([])
    reopened.close()
  })

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
    vi.mocked(harness.media.modelInput).mockImplementation(async () => {
      expect(harness.database.mediaAssets.get('reference_image')?.messageId)
        .toBe('user_message_1')
      return [{
        assetId: 'reference_image',
        kind: 'image',
        mimeType: 'image/png',
        dataBase64: 'iVBORw0KGgo=',
      }]
    })
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
      frameImages: ['first_frame', 'last_frame'],
    }))
    expect(harness.database.mediaAssets.get('reference_image')?.messageId).toBe('user_message_1')
    expect(harness.database.messages.get('user_message_1')?.blocks).toEqual(userBlocks)
  })

  it('rejects already-claimed reference assets before making a paid provider submission', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    harness.database.mediaAssets.insert({
      id: 'claimed_reference',
      conversationId: submitInput.conversationId,
      source: 'upload',
      kind: 'image',
      mimeType: 'image/png',
      originalName: 'claimed.png',
      relativePath: `${submitInput.conversationId}/claimed_reference.png`,
      byteSize: 12,
      sha256: 'a'.repeat(64),
      status: 'ready',
      createdAt: 1,
      updatedAt: 1,
    })
    const referenceBlock: Extract<ChatBlock, { type: 'media' }> = {
      type: 'media',
      blockId: 'claimed_reference_block',
      assetId: 'claimed_reference',
      kind: 'image',
      purpose: 'input',
      name: 'claimed.png',
      mimeType: 'image/png',
      byteSize: 12,
    }
    harness.database.messages.insertWithAssets({
      id: 'existing_user_message',
      conversationId: submitInput.conversationId,
      role: 'user',
      blocks: [referenceBlock],
      createdAt: 1,
    }, ['claimed_reference'])
    const runner = new VideoJobRunner(harness.dependencies)

    await expect(runner.submit({
      ...submitInput,
      userBlocks: [referenceBlock],
      assetIds: ['claimed_reference'],
      route: {
        ...route,
        assets: [{
          id: 'claimed_reference',
          kind: 'image',
          mimeType: 'image/png',
          name: 'claimed.png',
          byteSize: 12,
          conversationId: submitInput.conversationId,
          absolutePath: '/managed/claimed.png',
          relativePath: `${submitInput.conversationId}/claimed_reference.png`,
          inlineSafe: true,
        }],
      },
    })).rejects.toMatchObject({ code: 'MEDIA_GENERATION_FAILED' })

    expect(harness.media.modelInput).not.toHaveBeenCalled()
    expect(harness.provider.submitVideo).not.toHaveBeenCalled()
    expect(harness.events).toEqual([])
  })

  it('rejects malformed and metadata-mismatched user blocks before provider submission', async () => {
    vi.useFakeTimers()
    const malformed = createHarness()
    const malformedRunner = new VideoJobRunner(malformed.dependencies)

    await expect(malformedRunner.submit({
      ...submitInput,
      userBlocks: [{ type: 'text', text: 42 }] as unknown as ChatBlock[],
    })).rejects.toMatchObject({ code: 'MEDIA_GENERATION_FAILED' })
    expect(malformed.provider.submitVideo).not.toHaveBeenCalled()

    const mismatched = createHarness()
    mismatched.database.mediaAssets.insert({
      id: 'mismatched_reference',
      conversationId: submitInput.conversationId,
      source: 'upload',
      kind: 'image',
      mimeType: 'image/png',
      originalName: 'mismatched.png',
      relativePath: `${submitInput.conversationId}/mismatched_reference.png`,
      byteSize: 12,
      sha256: 'a'.repeat(64),
      status: 'ready',
      createdAt: 1,
      updatedAt: 1,
    })
    const mismatchedRunner = new VideoJobRunner(mismatched.dependencies)

    await expect(mismatchedRunner.submit({
      ...submitInput,
      userBlocks: [{
        type: 'media',
        blockId: 'mismatched_reference_block',
        assetId: 'mismatched_reference',
        kind: 'image',
        purpose: 'input',
        name: 'mismatched.png',
        mimeType: 'image/png',
        byteSize: 13,
      }],
      assetIds: ['mismatched_reference'],
      route: {
        ...route,
        assets: [{
          id: 'mismatched_reference',
          kind: 'image',
          mimeType: 'image/png',
          name: 'mismatched.png',
          byteSize: 12,
          conversationId: submitInput.conversationId,
          absolutePath: '/managed/mismatched.png',
          relativePath: `${submitInput.conversationId}/mismatched_reference.png`,
          inlineSafe: true,
        }],
      },
    })).rejects.toMatchObject({ code: 'MEDIA_GENERATION_FAILED' })
    expect(mismatched.provider.submitVideo).not.toHaveBeenCalled()
  })

  it('rejects duplicate request IDs before making a paid provider submission', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    harness.database.chatRuns.insert({
      id: 'existing_run',
      conversationId: submitInput.conversationId,
      requestId: submitInput.requestId,
      model: route.model,
      status: 'running',
      startedAt: 1,
    })
    const runner = new VideoJobRunner(harness.dependencies)

    await expect(runner.submit(submitInput)).rejects.toMatchObject({
      code: 'MEDIA_GENERATION_FAILED',
    })
    expect(harness.media.modelInput).not.toHaveBeenCalled()
    expect(harness.provider.submitVideo).not.toHaveBeenCalled()
    expect(harness.events).toEqual([])
  })

  it('rejects generated message and run ID collisions before provider submission', async () => {
    vi.useFakeTimers()
    const messageCollision = createHarness()
    messageCollision.database.messages.insert({
      id: 'user_message_1',
      conversationId: submitInput.conversationId,
      role: 'user',
      blocks: [{ type: 'text', text: 'existing' }],
      createdAt: 1,
    })
    const messageRunner = new VideoJobRunner(messageCollision.dependencies)

    await expect(messageRunner.submit(submitInput)).rejects.toMatchObject({
      code: 'MEDIA_GENERATION_FAILED',
    })
    expect(messageCollision.provider.submitVideo).not.toHaveBeenCalled()

    const runCollision = createHarness()
    runCollision.database.chatRuns.insert({
      id: 'run_video_1',
      conversationId: submitInput.conversationId,
      requestId: 'existing_request',
      model: route.model,
      status: 'running',
      startedAt: 1,
    })
    const runRunner = new VideoJobRunner(runCollision.dependencies)

    await expect(runRunner.submit(submitInput)).rejects.toMatchObject({
      code: 'MEDIA_GENERATION_FAILED',
    })
    expect(runCollision.provider.submitVideo).not.toHaveBeenCalled()
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

  it('fails the durable intent when the provider returns a malformed job ID', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    vi.mocked(harness.provider.submitVideo!).mockResolvedValue({
      providerJobId: 'https://evil.example/jobs/1',
      status: 'pending',
    })
    const runner = new VideoJobRunner(harness.dependencies)

    await expect(runner.submit(submitInput)).resolves.toEqual({
      jobId: 'request_video_1',
      requestId: 'request_video_1',
      status: 'failed',
    })
    expect(harness.database.mediaGenerationJobs.get('request_video_1')).toMatchObject({
      providerJobId: 'local:autoforge_video_submission_intent',
      status: 'failed',
      errorCode: 'MODEL_PROVIDER_REQUEST_FAILED',
    })
    expect(harness.database.mediaGenerationJobs.listActive()).toEqual([])
    expect(harness.events).toContainEqual(expect.objectContaining({
      type: 'status',
      requestId: 'request_video_1',
      status: 'failed',
    }))
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

  it('fails truncated and overlong response bodies against an exact Content-Length', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const mp4 = new Uint8Array([
      0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70,
      0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0,
      0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31,
    ])
    const truncated = createHarness()
    vi.mocked(truncated.provider.pollVideo!).mockResolvedValue({ status: 'completed' })
    vi.mocked(truncated.provider.downloadVideo!).mockResolvedValue(new Response(
      mp4,
      { headers: { 'content-type': 'video/mp4', 'content-length': '25' } },
    ))
    const truncatedRunner = new VideoJobRunner(truncated.dependencies)
    await truncatedRunner.submit(submitInput)
    await vi.advanceTimersByTimeAsync(2_000)
    await flush()

    expect(truncated.database.mediaGenerationJobs.get('request_video_1')).toMatchObject({
      status: 'failed',
      errorCode: 'MEDIA_DOWNLOAD_FAILED',
    })
    expect(truncated.database.mediaAssets.get(submittedOutputAssetId)).toBeUndefined()

    const overlong = createHarness()
    vi.mocked(overlong.provider.pollVideo!).mockResolvedValue({ status: 'completed' })
    vi.mocked(overlong.provider.downloadVideo!).mockResolvedValue(new Response(
      new Uint8Array([...mp4, 0]),
      { headers: { 'content-type': 'video/mp4', 'content-length': '24' } },
    ))
    const overlongRunner = new VideoJobRunner(overlong.dependencies)
    await overlongRunner.submit(submitInput)
    await vi.advanceTimersByTimeAsync(2_000)
    await flush()

    expect(overlong.database.mediaGenerationJobs.get('request_video_1')).toMatchObject({
      status: 'failed',
      errorCode: 'MEDIA_DOWNLOAD_FAILED',
    })
    expect(overlong.database.mediaAssets.get(submittedOutputAssetId)).toBeUndefined()
  })

  it('enforces the generated byte limit while streaming and cancels the oversized body', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const harness = createHarness()
    vi.mocked(harness.provider.pollVideo!).mockResolvedValue({ status: 'completed' })
    const chunk = new Uint8Array(1024 * 1024)
    let chunks = 0
    let cancelled = false
    vi.mocked(harness.provider.downloadVideo!).mockResolvedValue(new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(chunk)
          chunks += 1
          if (chunks === 502) controller.close()
        },
        cancel() {
          cancelled = true
        },
      }),
      { headers: { 'content-type': 'video/mp4' } },
    ))
    const runner = new VideoJobRunner(harness.dependencies)
    await runner.submit(submitInput)
    await vi.advanceTimersByTimeAsync(2_000)
    await flush()

    expect(harness.database.mediaGenerationJobs.get('request_video_1')).toMatchObject({
      status: 'failed',
      errorCode: 'MEDIA_SIZE_LIMIT_EXCEEDED',
    })
    expect(cancelled).toBe(true)
    expect(harness.database.mediaAssets.get(submittedOutputAssetId)).toBeUndefined()
  })

  it('cancels response bodies rejected before streaming for invalid length and non-success status', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const invalidLength = createHarness()
    vi.mocked(invalidLength.provider.pollVideo!).mockResolvedValue({ status: 'completed' })
    let invalidLengthCancelled = false
    vi.mocked(invalidLength.provider.downloadVideo!).mockResolvedValue(new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          invalidLengthCancelled = true
        },
      }),
      { headers: { 'content-type': 'video/mp4', 'content-length': 'invalid' } },
    ))
    const invalidLengthRunner = new VideoJobRunner(invalidLength.dependencies)
    await invalidLengthRunner.submit(submitInput)
    await vi.advanceTimersByTimeAsync(2_000)
    await flush()

    expect(invalidLengthCancelled).toBe(true)
    expect(invalidLength.database.mediaGenerationJobs.get('request_video_1')).toMatchObject({
      status: 'failed',
      errorCode: 'MEDIA_DOWNLOAD_FAILED',
    })

    const unsuccessful = createHarness()
    vi.mocked(unsuccessful.provider.pollVideo!).mockResolvedValue({ status: 'completed' })
    let unsuccessfulCancelled = false
    vi.mocked(unsuccessful.provider.downloadVideo!).mockResolvedValue(new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          unsuccessfulCancelled = true
        },
      }),
      { status: 502, headers: { 'content-type': 'video/mp4' } },
    ))
    const unsuccessfulRunner = new VideoJobRunner(unsuccessful.dependencies)
    await unsuccessfulRunner.submit(submitInput)
    await vi.advanceTimersByTimeAsync(2_000)
    await flush()

    expect(unsuccessfulCancelled).toBe(true)
    expect(unsuccessful.database.mediaGenerationJobs.get('request_video_1')).toMatchObject({
      status: 'failed',
      errorCode: 'MEDIA_DOWNLOAD_FAILED',
    })
  })

  it('normalizes a parameterized mixed-case video Content-Type before persistence', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const harness = createHarness()
    vi.mocked(harness.provider.pollVideo!).mockResolvedValue({ status: 'completed' })
    vi.mocked(harness.provider.downloadVideo!).mockResolvedValue(new Response(
      new Uint8Array([
        0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70,
        0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0,
        0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31,
      ]),
      { headers: { 'content-type': ' Video/MP4; charset=binary ' } },
    ))
    const runner = new VideoJobRunner(harness.dependencies)
    await runner.submit(submitInput)
    await vi.advanceTimersByTimeAsync(2_000)
    await flush()

    expect(vi.mocked(harness.media.commitGeneratedStream).mock.calls[0]?.[0])
      .toMatchObject({ declaredMimeType: 'video/mp4' })
    expect(harness.database.mediaGenerationJobs.get('request_video_1')?.status)
      .toBe('completed')
  })

  it('waits for abort-ignoring model input cleanup and terminally cancels its durable intent', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    let releaseModelInput!: () => void
    vi.mocked(harness.media.modelInput).mockImplementation(async () => (
      new Promise((resolve) => {
        releaseModelInput = () => resolve([])
      })
    ))
    const runner = new VideoJobRunner(harness.dependencies)
    const submission = runner.submit(submitInput)
    await Promise.resolve()

    let stopped = false
    const stopping = runner.stop().then(() => { stopped = true })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(stopped).toBe(false)
    releaseModelInput()
    expect(await submission).toMatchObject({ status: 'failed' })
    await stopping

    expect(harness.provider.submitVideo).not.toHaveBeenCalled()
    expect(harness.database.mediaGenerationJobs.get('request_video_1')).toMatchObject({
      status: 'failed',
      errorCode: 'CANCELLED',
    })
    expect(harness.database.chatRuns.get('run_video_1')).toMatchObject({
      status: 'failed',
      errorCode: 'CANCELLED',
    })
    expect(harness.database.mediaGenerationJobs.listActive()).toEqual([])
    expect(harness.events).toContainEqual(expect.objectContaining({
      type: 'status',
      status: 'failed',
    }))
  })

  it('waits for an abort-ignoring provider submission and terminally cancels its durable intent', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    const bindIdentity = vi.spyOn(harness.dependencies.providerUsage, 'bindIdentity')
    let releaseProvider!: () => void
    vi.mocked(harness.provider.submitVideo!).mockImplementation(async () => (
      new Promise((resolve) => {
        releaseProvider = () => resolve({
          providerJobId: 'provider_job_late',
          status: 'pending',
        })
      })
    ))
    const runner = new VideoJobRunner(harness.dependencies)
    const submission = runner.submit(submitInput)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    let stopped = false
    const stopping = runner.stop().then(() => { stopped = true })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(stopped).toBe(false)
    releaseProvider()
    expect(await submission).toMatchObject({ status: 'failed' })
    await stopping

    expect(bindIdentity).toHaveBeenCalledWith(
      'video:request_video_1',
      { providerJobId: 'provider_job_late' },
    )

    expect(harness.database.mediaGenerationJobs.get('request_video_1')).toMatchObject({
      status: 'failed',
      errorCode: 'CANCELLED',
    })
    expect(harness.database.chatRuns.get('run_video_1')).toMatchObject({
      status: 'failed',
      errorCode: 'CANCELLED',
    })
    expect(harness.database.mediaGenerationJobs.listActive()).toEqual([])
    expect(harness.events).toContainEqual(expect.objectContaining({
      type: 'status',
      status: 'failed',
    }))
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

  it('fails corrupted resumable associations while preserving exact active and paused pairs', () => {
    const database = createDatabase()
    database.conversations.insert({ id: 'conversation_other', title: 'Other' })
    const addJob = (input: {
      id: string
      status?: 'pending' | 'paused'
      runConversationId?: string
      runModel?: string
      messageRole?: string
      jobAssistantMessageId?: string
      blockStatus?: 'pending' | 'in_progress' | 'paused'
      blockKind?: 'image' | 'video'
    }) => {
      const status = input.status ?? 'pending'
      const messageId = `assistant_${input.id}`
      const jobAssistantMessageId = input.jobAssistantMessageId ?? messageId
      database.messages.insert({
        id: messageId,
        conversationId: submitInput.conversationId,
        role: input.messageRole ?? 'assistant',
        blocks: [{
          type: 'media_generation',
          blockId: `block_${input.id}`,
          jobId: input.id,
          kind: input.blockKind ?? 'video',
          status: input.blockStatus ?? status,
        }],
        createdAt: 1,
      })
      if (jobAssistantMessageId !== messageId) {
        database.messages.insert({
          id: jobAssistantMessageId,
          conversationId: submitInput.conversationId,
          role: 'assistant',
          blocks: [{ type: 'text', text: 'wrong assistant' }],
          createdAt: 1,
        })
      }
      database.chatRuns.insert({
        id: `run_${input.id}`,
        conversationId: input.runConversationId ?? submitInput.conversationId,
        requestId: input.id,
        model: input.runModel ?? route.model,
        status: 'running',
        startedAt: 1,
      })
      database.mediaGenerationJobs.insert({
        id: input.id,
        conversationId: submitInput.conversationId,
        assistantMessageId: jobAssistantMessageId,
        provider: 'openrouter',
        model: route.model,
        kind: 'video',
        providerJobId: `provider_${input.id}`,
        status,
        parameters: {},
        createdAt: 1,
        updatedAt: 1,
      })
    }

    addJob({ id: 'valid_active' })
    addJob({ id: 'valid_paused', status: 'paused' })
    addJob({ id: 'wrong_conversation', runConversationId: 'conversation_other' })
    addJob({ id: 'wrong_model', runModel: 'other-model' })
    addJob({ id: 'wrong_message', jobAssistantMessageId: 'assistant_decoy' })
    addJob({ id: 'wrong_role', messageRole: 'user' })
    addJob({ id: 'wrong_block_status', blockStatus: 'in_progress' })
    addJob({ id: 'wrong_block_kind', blockKind: 'image' })

    database.recoverInterrupted()

    expect(database.chatRuns.get('run_valid_active')?.status).toBe('running')
    expect(database.chatRuns.get('run_valid_paused')?.status).toBe('running')
    expect(database.messages.get('assistant_valid_active')?.blocks).toEqual([
      expect.objectContaining({ status: 'pending' }),
    ])
    expect(database.messages.get('assistant_valid_paused')?.blocks).toEqual([
      expect.objectContaining({ status: 'paused' }),
    ])
    const invalidIds = [
      'wrong_conversation',
      'wrong_model',
      'wrong_message',
      'wrong_role',
      'wrong_block_status',
      'wrong_block_kind',
    ]
    for (const id of invalidIds) {
      expect(database.mediaGenerationJobs.get(id)).toMatchObject({
        status: 'failed',
        errorCode: 'MEDIA_GENERATION_FAILED',
      })
      expect(database.chatRuns.get(`run_${id}`)).toMatchObject({
        status: 'failed',
        errorCode: 'INTERNAL_ERROR',
      })
      expect(database.messages.get(`assistant_${id}`)?.blocks).toEqual([
        expect.objectContaining({
          status: 'failed',
          errorCode: 'MEDIA_GENERATION_FAILED',
        }),
      ])
    }
    expect(database.mediaGenerationJobs.listActive().map((job) => job.id))
      .toEqual(['valid_active'])
  })

  it('does not roll back interrupted recovery when an associated message has malformed blocks JSON', () => {
    const directory = mkdtempSync(join(tmpdir(), 'autoforge-video-corrupt-recovery-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'autoforge.sqlite')
    const database = openAppDatabase(path)
    database.conversations.insert({ id: 'conversation_corrupt_recovery', title: 'Corrupt' })
    database.messages.insert({
      id: 'assistant_corrupt_recovery',
      conversationId: 'conversation_corrupt_recovery',
      role: 'assistant',
      blocks: [{
        type: 'media_generation',
        blockId: 'block_corrupt_recovery',
        jobId: 'request_corrupt_recovery',
        kind: 'video',
        status: 'pending',
      }],
      createdAt: 1,
    })
    database.chatRuns.insert({
      id: 'run_corrupt_recovery',
      conversationId: 'conversation_corrupt_recovery',
      requestId: 'request_corrupt_recovery',
      model: route.model,
      status: 'running',
      startedAt: 1,
    })
    database.mediaGenerationJobs.insert({
      id: 'request_corrupt_recovery',
      conversationId: 'conversation_corrupt_recovery',
      assistantMessageId: 'assistant_corrupt_recovery',
      provider: 'openrouter',
      model: route.model,
      kind: 'video',
      providerJobId: 'provider_corrupt_recovery',
      status: 'pending',
      parameters: {},
      createdAt: 1,
      updatedAt: 1,
    })
    const fault = new Database(path)
    fault.prepare('UPDATE messages SET blocks_json = ? WHERE id = ?')
      .run('{not valid json', 'assistant_corrupt_recovery')
    fault.close()

    expect(() => database.recoverInterrupted()).not.toThrow()
    expect(database.mediaGenerationJobs.get('request_corrupt_recovery')).toMatchObject({
      status: 'failed',
      errorCode: 'MEDIA_GENERATION_FAILED',
    })
    expect(database.chatRuns.get('run_corrupt_recovery')).toMatchObject({
      status: 'failed',
      errorCode: 'INTERNAL_ERROR',
    })
    expect(database.mediaGenerationJobs.listActive()).toEqual([])
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
