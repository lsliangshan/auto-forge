import { createHash, randomUUID } from 'node:crypto'
import {
  appErrorCodeSchema,
  modelProviderIdSchema,
  toSafeAppError,
  type AppError,
  type AppErrorCode,
  type ChatBlock,
  type ChatEvent,
  type MediaAsset,
} from '@autoforge/shared'
import {
  isVideoSubmissionIntent,
  type AppRepositories,
  type MediaGenerationJob,
  type MediaGenerationJobStatus,
  type ProviderUsageRepository,
  type VideoGenerationSubmissionIntentInput,
  type VideoGenerationTransition,
} from '../database/repositories.js'
import {
  MEDIA_LIMITS,
  type MediaAssetService,
} from '../media/media-asset-service.js'
import type { ModelProvider } from './model-provider.js'
import type { ResolvedChatRoute } from './multimodal-router.js'

const VIDEO_TIMEOUT_MS = 60 * 60 * 1_000
const PROVIDER_JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/
const ACTIVE_STATUSES: MediaGenerationJobStatus[] = [
  'pending',
  'in_progress',
  'downloading',
]

interface UsageAttribution {
  userId: string
  apiKeyFingerprint?: string
}

export interface SubmitVideoInput extends UsageAttribution {
  requestId: string
  conversationId: string
  prompt: string
  userBlocks: ChatBlock[]
  assetIds: string[]
  route: ResolvedChatRoute & { outputType: 'video' }
}

export interface VideoJobProviderRegistryPort {
  get(provider: ResolvedChatRoute['provider']): Pick<
    ModelProvider,
    'submitVideo' | 'pollVideo' | 'downloadVideo'
  >
}

export interface VideoJobRunnerDependencies {
  database: Pick<
    AppRepositories,
    'conversations' | 'mediaGenerationJobs' | 'mediaAssets' | 'messages' | 'chatRuns'
  >
  providerUsage: Pick<ProviderUsageRepository, 'start' | 'bindIdentity' | 'report' | 'markUnknown'>
  providers: VideoJobProviderRegistryPort
  media: Pick<
    MediaAssetService,
    'modelInput' | 'commitGeneratedStream' | 'resolveReadyAsset' | 'removeDraft'
  >
  emit: (event: ChatEvent) => void
  id?: () => string
  now?: () => number
  timers?: {
    set(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
    clear(handle: ReturnType<typeof setTimeout>): void
  }
}

export interface SubmittedVideoJob {
  jobId: string
  requestId: string
  status: 'pending' | 'in_progress' | 'failed'
}

function pollDelay(attempt: number): number {
  if (attempt <= 5) return 2_000
  if (attempt <= 20) return 5_000
  return 10_000
}

function mappedFailure(error: unknown): AppError {
  const safe = toSafeAppError(error)
  return safe.code === 'INTERNAL_ERROR'
    ? toSafeAppError({ code: 'MEDIA_GENERATION_FAILED' })
    : safe
}

function outputAssetId(jobId: string): string {
  return `video_${createHash('sha256').update(jobId).digest('hex')}`
}

interface VideoTerminalMetadata {
  generationId?: string
  costUsd?: string
}

function persistedParameters(
  options: SubmitVideoInput['route']['generation']['video'],
  terminal?: VideoTerminalMetadata,
  submissionIntent = false,
): unknown {
  return {
    version: 1,
    options,
    ...(submissionIntent ? { submission: { phase: 'intent' } } : {}),
    ...(terminal === undefined ? {} : { terminal }),
  }
}

function terminalMetadata(parameters: unknown): VideoTerminalMetadata {
  if (
    typeof parameters !== 'object'
    || parameters === null
    || !('terminal' in parameters)
    || typeof parameters.terminal !== 'object'
    || parameters.terminal === null
  ) return {}
  const terminal = parameters.terminal as Record<string, unknown>
  const generationId = (
    typeof terminal.generationId === 'string'
    && terminal.generationId === terminal.generationId.trim()
    && terminal.generationId.length > 0
    && terminal.generationId.length <= 256
  ) ? terminal.generationId : undefined
  const costUsd = (
    typeof terminal.costUsd === 'string'
    && terminal.costUsd.length > 0
    && terminal.costUsd.length <= 64
    && Number.isFinite(Number(terminal.costUsd))
    && Number(terminal.costUsd) >= 0
  ) ? terminal.costUsd : undefined
  return {
    ...(generationId === undefined ? {} : { generationId }),
    ...(costUsd === undefined ? {} : { costUsd }),
  }
}

function generationOptions(parameters: unknown): SubmitVideoInput['route']['generation']['video'] {
  if (
    typeof parameters === 'object'
    && parameters !== null
    && 'options' in parameters
  ) return parameters.options as SubmitVideoInput['route']['generation']['video']
  return parameters as SubmitVideoInput['route']['generation']['video']
}

function mediaBlock(
  blockId: string,
  asset: MediaAsset,
): Extract<ChatBlock, { type: 'media' }> {
  return {
    type: 'media',
    blockId,
    assetId: asset.id,
    kind: 'video',
    purpose: 'output',
    name: asset.name,
    mimeType: asset.mimeType,
    byteSize: asset.byteSize,
    ...(asset.width === undefined ? {} : { width: asset.width }),
    ...(asset.height === undefined ? {} : { height: asset.height }),
    ...(asset.durationMs === undefined ? {} : { durationMs: asset.durationMs }),
  }
}

function contentLength(response: Response): number | undefined {
  const header = response.headers.get('content-length')
  if (header === null) return undefined
  if (!/^(?:0|[1-9]\d*)$/.test(header)) throw toSafeAppError({ code: 'MEDIA_DOWNLOAD_FAILED' })
  const value = Number(header)
  if (!Number.isSafeInteger(value)) throw toSafeAppError({ code: 'MEDIA_DOWNLOAD_FAILED' })
  return value
}

async function* responseBody(
  response: Response,
  signal: AbortSignal,
  expectedLength?: number,
): AsyncGenerator<Uint8Array> {
  if (!response.ok || !response.body) throw toSafeAppError({ code: 'MEDIA_DOWNLOAD_FAILED' })
  const reader = response.body.getReader()
  let received = 0
  try {
    while (true) {
      if (signal.aborted) throw toSafeAppError({ code: 'CANCELLED' })
      const chunk = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        const onAbort = () => {
          void reader.cancel().catch(() => undefined)
          reject(toSafeAppError({ code: 'CANCELLED' }))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        reader.read().then(resolve, reject).finally(() => {
          signal.removeEventListener('abort', onAbort)
        })
      })
      if (chunk.done) {
        if (expectedLength !== undefined && received !== expectedLength) {
          throw toSafeAppError({ code: 'MEDIA_DOWNLOAD_FAILED' })
        }
        return
      }
      const nextReceived = received + chunk.value.byteLength
      if (nextReceived > MEDIA_LIMITS.generatedBytes) {
        throw toSafeAppError({ code: 'MEDIA_SIZE_LIMIT_EXCEEDED' })
      }
      if (expectedLength !== undefined && nextReceived > expectedLength) {
        throw toSafeAppError({ code: 'MEDIA_DOWNLOAD_FAILED' })
      }
      received = nextReceived
      yield chunk.value
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

export class VideoJobRunner {
  private readonly id: () => string
  private readonly now: () => number
  private readonly timersApi: NonNullable<VideoJobRunnerDependencies['timers']>
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly deadlineTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly work = new Map<string, Promise<void>>()
  private readonly submissions = new Set<Promise<SubmittedVideoJob>>()
  private stopped = false

  constructor(private readonly dependencies: VideoJobRunnerDependencies) {
    this.id = dependencies.id ?? randomUUID
    this.now = dependencies.now ?? Date.now
    this.timersApi = dependencies.timers ?? {
      set: (callback, delayMs) => setTimeout(callback, delayMs),
      clear: (handle) => clearTimeout(handle),
    }
  }

  async submit(input: SubmitVideoInput): Promise<SubmittedVideoJob> {
    const operation = this.submitInternal(input)
    this.submissions.add(operation)
    try {
      return await operation
    } finally {
      this.submissions.delete(operation)
    }
  }

  private async submitInternal(input: SubmitVideoInput): Promise<SubmittedVideoJob> {
    const usageAttribution = {
      userId: input.userId,
      ...(input.apiKeyFingerprint === undefined
        ? {}
        : { apiKeyFingerprint: input.apiKeyFingerprint }),
    }
    this.assertSubmit(input)
    if (
      this.stopped
      || this.controllers.has(input.requestId)
      || this.dependencies.database.mediaGenerationJobs.get(input.requestId)
    ) throw toSafeAppError({ code: 'CONFLICT' })
    if (!this.dependencies.database.conversations.get(input.conversationId)) {
      throw toSafeAppError({ code: 'NOT_FOUND' })
    }

    let controller: AbortController | undefined
    let intent: MediaGenerationJob | undefined
    let usageStarted = false
    let usageContinues = false
    try {
      const preparedAt = this.now()
      const userMessageId = this.id()
      const runId = this.id()
      const assistantMessageId = this.id()
      const blockId = this.id()
      const preparedBlock: Extract<ChatBlock, { type: 'media_generation' }> = {
        type: 'media_generation',
        blockId,
        jobId: input.requestId,
        kind: 'video',
        status: 'pending',
      }
      const preparedTurn = {
        userMessage: {
          id: userMessageId,
          conversationId: input.conversationId,
          role: 'user',
          blocks: input.userBlocks,
          createdAt: preparedAt,
        },
        userAssetIds: input.assetIds,
        assistantMessage: {
          id: assistantMessageId,
          conversationId: input.conversationId,
          role: 'assistant',
          blocks: [preparedBlock],
          createdAt: preparedAt,
        },
        run: {
          id: runId,
          conversationId: input.conversationId,
          requestId: input.requestId,
          model: input.route.model,
          status: 'running',
          startedAt: preparedAt,
        },
        job: {
          id: input.requestId,
          conversationId: input.conversationId,
          assistantMessageId,
          provider: input.route.provider,
          model: input.route.model,
          kind: 'video',
          status: 'pending',
          parameters: persistedParameters(input.route.generation.video, undefined, true),
          pollAttempts: 0,
          createdAt: preparedAt,
          updatedAt: preparedAt,
        },
      } satisfies VideoGenerationSubmissionIntentInput
      intent = this.dependencies.database.mediaGenerationJobs.startSubmissionIntent(preparedTurn)

      controller = new AbortController()
      this.controllers.set(input.requestId, controller)
      const provider = this.provider(input.route.provider)
      if (!provider.submitVideo) throw toSafeAppError({ code: 'MODEL_MODALITY_UNSUPPORTED' })
      const inputs = await this.dependencies.media.modelInput(
        input.conversationId,
        input.assetIds,
      )
      if (this.stopped || controller.signal.aborted) {
        throw toSafeAppError({ code: 'CANCELLED' })
      }
      if (
        inputs.length !== input.assetIds.length
        || inputs.some((asset, index) => (
          asset.assetId !== input.assetIds[index] || asset.kind !== 'image'
        ))
      ) throw toSafeAppError({ code: 'MODEL_MODALITY_UNSUPPORTED' })
      const operationKey = `video:${input.requestId}`
      if (input.route.provider === 'openrouter') {
        this.dependencies.providerUsage.start({
          id: this.id(),
          operationKey,
          ...usageAttribution,
          provider: input.route.provider,
          requestId: input.requestId,
          chatRunId: runId,
          model: input.route.model,
          modality: 'video',
          startedAt: this.now(),
        })
        usageStarted = true
      }
      const submitted = await provider.submitVideo({
        model: input.route.model,
        prompt: input.prompt,
        options: input.route.generation.video,
        references: inputs.map(({ mimeType, dataBase64 }) => ({ mimeType, dataBase64 })),
        frameImages: input.route.videoFrameImages ?? [],
        signal: controller.signal,
      })
      if (
        this.stopped
        || controller.signal.aborted
        || !PROVIDER_JOB_ID_PATTERN.test(submitted.providerJobId)
        || (submitted.status !== 'pending' && submitted.status !== 'in_progress')
      ) {
        throw controller.signal.aborted
          ? toSafeAppError({ code: 'CANCELLED' })
          : toSafeAppError({ code: 'MODEL_PROVIDER_REQUEST_FAILED' })
      }
      if (input.route.provider === 'openrouter') {
        this.dependencies.providerUsage.bindIdentity(operationKey, {
          providerJobId: submitted.providerJobId,
        })
      }

      const createdAt = this.now()
      const block: Extract<ChatBlock, { type: 'media_generation' }> = {
        ...preparedBlock,
        status: submitted.status,
      }
      const bound = this.dependencies.database.mediaGenerationJobs.bindSubmitted(
        input.requestId,
        {
          providerJobId: submitted.providerJobId,
          status: submitted.status,
          parameters: persistedParameters(input.route.generation.video),
          nextPollAt: createdAt + pollDelay(1),
          updatedAt: createdAt,
        },
      )
      if (!bound) throw toSafeAppError({ code: 'CONFLICT' })
      usageContinues = true
      const { job } = bound
      this.safeEmit({
        type: 'block_update',
        conversationId: job.conversationId,
        messageId: job.assistantMessageId,
        blockId: block.blockId,
        block,
      })
      this.safeEmit({
        type: 'status',
        conversationId: job.conversationId,
        requestId: job.id,
        status: 'running',
      })
      this.schedule(job)
      return {
        jobId: job.id,
        requestId: input.requestId,
        status: submitted.status,
      }
    } catch (error) {
      if (usageStarted && !usageContinues) {
        this.dependencies.providerUsage.markUnknown(`video:${input.requestId}`, this.now())
      }
      const safe = (
        this.stopped
        || controller?.signal.aborted
      ) ? toSafeAppError({ code: 'CANCELLED' }) : mappedFailure(error)
      if (!intent) throw safe
      const current = this.dependencies.database.mediaGenerationJobs.get(intent.id)
      if (current && ACTIVE_STATUSES.includes(current.status)) {
        this.fail(current, safe.code)
      }
      return {
        jobId: intent.id,
        requestId: input.requestId,
        status: 'failed',
      }
    } finally {
      if (controller && this.controllers.get(input.requestId) === controller) {
        this.controllers.delete(input.requestId)
      }
    }
  }

  async pause(jobId: string): Promise<void> {
    const transition = this.dependencies.database.mediaGenerationJobs.transition(
      jobId,
      ['pending', 'in_progress'],
      {
        status: 'paused',
        nextPollAt: null,
        updatedAt: this.now(),
      },
    )
    if (!transition) {
      if (!this.dependencies.database.mediaGenerationJobs.get(jobId)) {
        throw toSafeAppError({ code: 'NOT_FOUND' })
      }
      throw toSafeAppError({ code: 'CONFLICT' })
    }
    this.clearTimer(jobId)
    this.controllers.get(jobId)?.abort()
    this.emitTransition(transition)
  }

  async resume(jobId: string): Promise<void> {
    if (this.stopped) throw toSafeAppError({ code: 'CONFLICT' })
    const resumedAt = this.now()
    const transition = this.dependencies.database.mediaGenerationJobs.transition(
      jobId,
      ['paused'],
      {
        status: 'pending',
        nextPollAt: resumedAt + pollDelay(1),
        updatedAt: resumedAt,
      },
    )
    if (!transition) {
      if (!this.dependencies.database.mediaGenerationJobs.get(jobId)) {
        throw toSafeAppError({ code: 'NOT_FOUND' })
      }
      throw toSafeAppError({ code: 'CONFLICT' })
    }
    this.emitTransition(transition)
    this.schedule(transition.job)
  }

  async recover(): Promise<void> {
    if (this.stopped) return
    for (const job of this.dependencies.database.mediaGenerationJobs.listActive()) {
      if (isVideoSubmissionIntent(job)) {
        this.fail(job, 'MEDIA_GENERATION_FAILED')
        continue
      }
      this.schedule(job)
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const jobId of [...this.timers.keys()]) this.clearTimer(jobId)
    for (const jobId of [...this.deadlineTimers.keys()]) this.clearDeadlineTimer(jobId)
    for (const controller of this.controllers.values()) controller.abort()
    await Promise.allSettled([
      ...this.work.values(),
      ...this.submissions,
    ])
  }

  private assertSubmit(input: SubmitVideoInput): void {
    if (
      input.route.outputType !== 'video'
      || input.requestId.trim().length === 0
      || !PROVIDER_JOB_ID_PATTERN.test(input.requestId)
      || input.conversationId.trim().length === 0
      || !input.route.model.trim()
      || input.assetIds.length !== input.route.assets.length
      || new Set(input.assetIds).size !== input.assetIds.length
      || input.assetIds.some((assetId, index) => input.route.assets[index]?.id !== assetId)
    ) throw toSafeAppError({ code: 'INVALID_INPUT' })
  }

  private provider(provider: ResolvedChatRoute['provider']) {
    modelProviderIdSchema.parse(provider)
    return this.dependencies.providers.get(provider)
  }

  private schedule(job: MediaGenerationJob): void {
    if (
      this.stopped
      || isVideoSubmissionIntent(job)
      || !ACTIVE_STATUSES.includes(job.status)
    ) return
    this.clearTimer(job.id)
    const deadline = job.createdAt + VIDEO_TIMEOUT_MS
    const target = job.status === 'downloading'
      ? this.now()
      : Math.min(job.nextPollAt ?? this.now(), deadline)
    const handle = this.timersApi.set(() => {
      this.timers.delete(job.id)
      void this.wake(job.id)
    }, Math.max(0, target - this.now()))
    this.timers.set(job.id, handle)
  }

  private clearTimer(jobId: string): void {
    const handle = this.timers.get(jobId)
    if (handle === undefined) return
    this.timersApi.clear(handle)
    this.timers.delete(jobId)
  }

  private async wake(jobId: string): Promise<void> {
    if (this.stopped || this.work.has(jobId)) return
    const controller = new AbortController()
    this.controllers.set(jobId, controller)
    const operation = this.process(jobId, controller)
      .catch((error: unknown) => this.handleOperationFailure(jobId, controller, error))
      .finally(() => {
        if (this.controllers.get(jobId) === controller) this.controllers.delete(jobId)
        this.work.delete(jobId)
        if (
          !this.stopped
          && controller.signal.aborted
          && !this.timers.has(jobId)
        ) {
          const current = this.dependencies.database.mediaGenerationJobs.get(jobId)
          if (current && ACTIVE_STATUSES.includes(current.status)) this.schedule(current)
        }
      })
    this.work.set(jobId, operation)
    await operation
  }

  private async process(jobId: string, controller: AbortController): Promise<void> {
    const job = this.dependencies.database.mediaGenerationJobs.get(jobId)
    if (!job || !ACTIVE_STATUSES.includes(job.status) || this.stopped) return
    if (isVideoSubmissionIntent(job)) {
      this.fail(job, 'MEDIA_GENERATION_FAILED')
      return
    }
    const deadline = job.createdAt + VIDEO_TIMEOUT_MS
    if (this.now() >= deadline) {
      if (job.provider === 'openrouter' && job.status !== 'downloading') {
        this.dependencies.providerUsage.markUnknown(`video:${job.id}`, this.now())
      }
      this.fail(job, 'MEDIA_GENERATION_TIMEOUT')
      return
    }
    this.clearDeadlineTimer(job.id)
    const deadlineTimer = this.timersApi.set(
      () => controller.abort(),
      Math.max(0, deadline - this.now()),
    )
    this.deadlineTimers.set(job.id, deadlineTimer)
    try {
      if (job.status === 'downloading') {
        await this.download(job, controller.signal)
        return
      }
      await this.poll(job, controller.signal)
    } finally {
      if (this.deadlineTimers.get(job.id) === deadlineTimer) {
        this.clearDeadlineTimer(job.id)
      }
    }
  }

  private async poll(job: MediaGenerationJob, signal: AbortSignal): Promise<void> {
    if (isVideoSubmissionIntent(job)) {
      this.fail(job, 'MEDIA_GENERATION_FAILED')
      return
    }
    let result: Awaited<ReturnType<NonNullable<ModelProvider['pollVideo']>>>
    try {
      const provider = this.provider(modelProviderIdSchema.parse(job.provider))
      if (!provider.pollVideo) throw toSafeAppError({ code: 'MODEL_MODALITY_UNSUPPORTED' })
      result = await provider.pollVideo(job.providerJobId, signal)
    } catch (error) {
      if (job.provider === 'openrouter') {
        this.dependencies.providerUsage.markUnknown(`video:${job.id}`, this.now())
      }
      throw error
    }
    if (this.stopped || signal.aborted) return
    const attempts = (job.pollAttempts ?? 0) + 1
    if (result.status === 'failed') {
      if (job.provider === 'openrouter') {
        this.dependencies.providerUsage.markUnknown(`video:${job.id}`, this.now())
      }
      this.fail(job, appErrorCodeSchema.parse(result.errorCode))
      return
    }
    if (result.status === 'completed') {
      if (job.provider === 'openrouter') {
        const operationKey = `video:${job.id}`
        if (result.generationId !== undefined) {
          this.dependencies.providerUsage.bindIdentity(operationKey, {
            generationId: result.generationId,
          })
        }
        if (result.costUsd === undefined) {
          this.dependencies.providerUsage.markUnknown(operationKey, this.now())
        } else {
          this.dependencies.providerUsage.report(operationKey, {
            ...(result.generationId === undefined
              ? {}
              : { generationId: result.generationId }),
            costUsd: result.costUsd,
            endedAt: this.now(),
          })
        }
      }
      let current = job
      if (current.status === 'pending') {
        const progress = this.dependencies.database.mediaGenerationJobs.transition(
          current.id,
          ['pending'],
          {
            status: 'in_progress',
            pollAttempts: attempts,
            nextPollAt: null,
            updatedAt: this.now(),
          },
        )
        if (!progress) return
        this.emitTransition(progress)
        current = progress.job
      }
      const downloading = this.dependencies.database.mediaGenerationJobs.transition(
        current.id,
        ['in_progress'],
        {
          status: 'downloading',
          parameters: persistedParameters(
            generationOptions(current.parameters),
            {
              ...(result.generationId === undefined
                ? {}
                : { generationId: result.generationId }),
              ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }),
            },
          ),
          pollAttempts: attempts,
          nextPollAt: null,
          updatedAt: this.now(),
        },
      )
      if (!downloading) return
      this.emitTransition(downloading)
      await this.download(downloading.job, signal, {
        generationId: result.generationId,
        costUsd: result.costUsd,
      })
      return
    }

    const desired = job.status === 'pending' && result.status === 'in_progress'
      ? 'in_progress'
      : job.status
    const nextAttempt = attempts + 1
    const transition = this.dependencies.database.mediaGenerationJobs.transition(
      job.id,
      [job.status],
      {
        status: desired,
        pollAttempts: attempts,
        nextPollAt: this.now() + pollDelay(nextAttempt),
        updatedAt: this.now(),
      },
    )
    if (!transition) return
    this.emitTransition(transition)
    this.schedule(transition.job)
  }

  private async download(
    job: MediaGenerationJob,
    signal: AbortSignal,
    terminal?: VideoTerminalMetadata,
  ): Promise<void> {
    if (isVideoSubmissionIntent(job)) {
      this.fail(job, 'MEDIA_GENERATION_FAILED')
      return
    }
    const completedMetadata = terminal ?? terminalMetadata(job.parameters)
    const assetId = outputAssetId(job.id)
    let asset: MediaAsset | undefined
    const existing = this.dependencies.database.mediaAssets.get(assetId)
    if (
      existing
      && (
        existing.conversationId !== job.conversationId
        || existing.source !== 'generated'
        || existing.kind !== 'video'
        || existing.provider !== job.provider
        || existing.model !== job.model
        || (
          existing.messageId !== undefined
          && existing.messageId !== job.assistantMessageId
        )
      )
    ) throw toSafeAppError({ code: 'MEDIA_GENERATION_FAILED' })
    if (existing?.status === 'ready') {
      try {
        asset = await this.dependencies.media.resolveReadyAsset(assetId, job.conversationId)
      } catch {
        await this.dependencies.media.removeDraft(assetId, job.conversationId)
      }
    } else if (existing) {
      await this.dependencies.media.removeDraft(assetId, job.conversationId)
    }
    if (!asset) {
      const provider = this.provider(modelProviderIdSchema.parse(job.provider))
      if (!provider.downloadVideo) throw toSafeAppError({ code: 'MODEL_MODALITY_UNSUPPORTED' })
      const response = await provider.downloadVideo(job.providerJobId, signal)
      let length: number | undefined
      try {
        if (!response.ok || !response.body) {
          throw toSafeAppError({ code: 'MEDIA_DOWNLOAD_FAILED' })
        }
        length = contentLength(response)
        if (length !== undefined && length > MEDIA_LIMITS.generatedBytes) {
          throw toSafeAppError({ code: 'MEDIA_SIZE_LIMIT_EXCEEDED' })
        }
      } catch (error) {
        await response.body?.cancel().catch(() => undefined)
        throw error
      }
      const declaredMimeType = response.headers.get('content-type')
        ?.split(';', 1)[0]
        ?.trim()
        .toLowerCase()
      asset = await this.dependencies.media.commitGeneratedStream({
        assetId,
        conversationId: job.conversationId,
        messageId: job.assistantMessageId,
        kind: 'video',
        provider: modelProviderIdSchema.parse(job.provider),
        model: job.model,
        name: 'generated-video.mp4',
        stream: responseBody(response, signal, length),
        ...(declaredMimeType ? { declaredMimeType } : {}),
      })
    }
    if (this.stopped || signal.aborted) return
    const active = this.dependencies.database.messages.get(job.assistantMessageId)
      ?.blocks
      .find((block): block is Extract<ChatBlock, { type: 'media_generation' }> => (
        typeof block === 'object'
        && block !== null
        && 'type' in block
        && block.type === 'media_generation'
        && 'jobId' in block
        && block.jobId === job.id
      ))
    if (!active) return
    const block = mediaBlock(active.blockId, asset)
    try {
      const completed = this.dependencies.database.mediaGenerationJobs.complete(
        job.id,
        ['downloading'],
        {
          assetId,
          block,
          endedAt: this.now(),
          ...(completedMetadata.generationId === undefined
            ? {}
            : { generationId: completedMetadata.generationId }),
          ...(completedMetadata.costUsd === undefined
            ? {}
            : { costUsd: completedMetadata.costUsd }),
        },
      )
      if (!completed) return
    } catch (error) {
      await this.dependencies.media.removeDraft(assetId, job.conversationId).catch(() => undefined)
      throw error
    }
    this.safeEmit({
      type: 'block_update',
      conversationId: job.conversationId,
      messageId: job.assistantMessageId,
      blockId: block.blockId,
      block,
    })
    this.safeEmit({
      type: 'status',
      conversationId: job.conversationId,
      requestId: job.id,
      status: 'completed',
    })
  }

  private async handleOperationFailure(
    jobId: string,
    controller: AbortController,
    error: unknown,
  ): Promise<void> {
    if (this.stopped) return
    const job = this.dependencies.database.mediaGenerationJobs.get(jobId)
    if (!job || !ACTIVE_STATUSES.includes(job.status)) return
    if (controller.signal.aborted && this.now() < job.createdAt + VIDEO_TIMEOUT_MS) return
    const safe = this.now() >= job.createdAt + VIDEO_TIMEOUT_MS
      ? toSafeAppError({ code: 'MEDIA_GENERATION_TIMEOUT' })
      : mappedFailure(error)
    this.fail(job, safe.code)
  }

  private fail(job: MediaGenerationJob, errorCode: AppErrorCode): void {
    const failed = this.dependencies.database.mediaGenerationJobs.fail(
      job.id,
      ACTIVE_STATUSES,
      errorCode,
      this.now(),
    )
    if (!failed) return
    this.emitTransition(failed)
    this.safeEmit({
      type: 'status',
      conversationId: job.conversationId,
      requestId: job.id,
      status: 'failed',
      error: toSafeAppError({ code: errorCode }),
    })
  }

  private clearDeadlineTimer(jobId: string): void {
    const handle = this.deadlineTimers.get(jobId)
    if (handle === undefined) return
    this.timersApi.clear(handle)
    this.deadlineTimers.delete(jobId)
  }

  private emitTransition(transition: VideoGenerationTransition): void {
    this.safeEmit({
      type: 'block_update',
      conversationId: transition.job.conversationId,
      messageId: transition.job.assistantMessageId,
      blockId: transition.block.blockId,
      block: transition.block,
    })
  }

  private safeEmit(event: ChatEvent): void {
    try {
      this.dependencies.emit(event)
    } catch {
      // Renderer listeners are observational.
    }
  }
}
