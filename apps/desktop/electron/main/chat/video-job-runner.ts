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
  ProviderUsageConsistencyError,
  type AppRepositories,
  type ChatRun,
  type MediaGenerationJob,
  type MediaGenerationJobStatus,
  type ProviderUsageEvent,
  type ProviderUsageRepository,
  type VideoGenerationSubmissionIntentInput,
  type VideoGenerationTransition,
} from '../database/repositories.js'
import {
  MEDIA_LIMITS,
  type MediaAssetService,
} from '../media/media-asset-service.js'
import type {
  ModelProvider,
  ModelProviderSnapshot,
  ModelProviderSnapshotSource,
} from './model-provider.js'
import type { ResolvedChatRoute } from './multimodal-router.js'
import {
  assertAttachmentByteAccess,
  assertProtectedProviderSnapshot,
  createProviderMediaProjection,
  type ProviderAttachmentDisclosure,
} from './provider-attachment-disclosure.js'

const VIDEO_TIMEOUT_MS = 60 * 60 * 1_000
const CREDENTIAL_RETRY_MS = 2_000
const PROVIDER_JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/
const ACTIVE_STATUSES: MediaGenerationJobStatus[] = [
  'pending',
  'in_progress',
  'downloading',
]

interface UsageAttribution {
  userId: string
}

export interface SubmitVideoInput extends UsageAttribution {
  requestId: string
  conversationId: string
  prompt: string
  userBlocks: ChatBlock[]
  assetIds: string[]
  attachmentFingerprints?: readonly string[]
  route: ResolvedChatRoute & { outputType: 'video' }
  attachmentDisclosure?: ProviderAttachmentDisclosure
  providerSnapshot?: ModelProviderSnapshot
}

export interface VideoJobProviderRegistryPort {
  acquire: ModelProviderSnapshotSource['acquire']
}

export interface VideoJobRunnerDependencies {
  database: Pick<
    AppRepositories,
    'conversations' | 'mediaGenerationJobs' | 'mediaAssets' | 'messages' | 'chatRuns'
  >
  providerUsage: Pick<ProviderUsageRepository,
    'find' | 'start' | 'bindIdentity' | 'report' | 'markUnknown' | 'recordByokUsage'>
  providers: VideoJobProviderRegistryPort
  media: Pick<
    MediaAssetService,
    'modelInput' | 'commitGeneratedStream' | 'resolveReadyAsset' | 'removeDraft'
  >
  emit: (event: ChatEvent) => void
  onBackgroundFailure: (error: unknown) => void
  onMutationCommitted: (conversationId: string) => void
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

type VideoUsageClassification =
  | { kind: 'untracked' }
  | { kind: 'legacy-unattributed' }
  | { kind: 'tracked'; event: ProviderUsageEvent }

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
  private readonly providerSnapshots = new Map<string, ModelProviderSnapshot>()
  private readonly backgroundFailures: unknown[] = []
  private stopped = false

  constructor(private readonly dependencies: VideoJobRunnerDependencies) {
    this.id = dependencies.id ?? randomUUID
    this.now = dependencies.now ?? Date.now
    this.timersApi = dependencies.timers ?? {
      set: (callback, delayMs) => setTimeout(callback, delayMs),
      clear: (handle) => clearTimeout(handle),
    }
  }

  private recordBackgroundFailure(error: unknown): void {
    this.backgroundFailures.push(error)
    try { this.dependencies.onBackgroundFailure(error) } catch { /* Failure reporting is observational. */ }
  }

  async submit(input: SubmitVideoInput): Promise<SubmittedVideoJob> {
    if (input.assetIds.length > 0) {
      assertAttachmentByteAccess(input.attachmentDisclosure, {
        requestId: input.requestId,
        providerId: input.route.provider,
        assetIds: input.assetIds,
        assetFingerprints: input.attachmentFingerprints ?? [],
      })
      if (!input.providerSnapshot) throw new Error('Attachment provider snapshot is missing')
      assertProtectedProviderSnapshot(input.providerSnapshot, input.attachmentDisclosure, {
        requestId: input.requestId,
        providerId: input.route.provider,
        assetIds: input.assetIds,
        assetFingerprints: input.attachmentFingerprints ?? [],
        purpose: 'main',
      })
      if (input.assetIds.length !== input.route.assets.length
        || input.assetIds.some((assetId, index) => input.route.assets[index]?.id !== assetId)) {
        throw new Error('Attachment route binding is invalid')
      }
    }
    const operation = this.submitInternal(input)
    this.submissions.add(operation)
    try {
      return await operation
    } finally {
      this.submissions.delete(operation)
    }
  }

  private async submitInternal(input: SubmitVideoInput): Promise<SubmittedVideoJob> {
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
          userId: input.userId,
          provider: input.route.provider,
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
      this.dependencies.onMutationCommitted(intent.conversationId)

      controller = new AbortController()
      this.controllers.set(input.requestId, controller)
      const providerSnapshot = input.providerSnapshot
        ?? await this.acquireSubmitSnapshot(input.route.provider)
      this.providerSnapshots.set(input.requestId, providerSnapshot)
      const provider = providerSnapshot.provider
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
      const protectedProjection = input.attachmentDisclosure === undefined
        ? undefined
        : createProviderMediaProjection(
            input.attachmentDisclosure,
            input.route.provider,
            'video',
            input.prompt,
            inputs,
          )
      const operationKey = `video:${input.requestId}`
      if (input.route.provider === 'openrouter') {
        if (providerSnapshot.apiKeyFingerprint === undefined) {
          throw toSafeAppError({ code: 'CREDENTIAL_UNAVAILABLE' })
        }
        this.dependencies.providerUsage.start({
          id: this.id(),
          operationKey,
          userId: input.userId,
          apiKeyFingerprint: providerSnapshot.apiKeyFingerprint,
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
        prompt: protectedProjection?.prompt ?? input.prompt,
        options: input.route.generation.video,
        references: protectedProjection?.references
          ?? inputs.map(({ mimeType, dataBase64 }) => ({ mimeType, dataBase64 })),
        frameImages: input.route.videoFrameImages ?? [],
        ...(input.route.videoUsesInputReferences ? { useInputReferences: true } : {}),
        signal: controller.signal,
      })
      if (
        !PROVIDER_JOB_ID_PATTERN.test(submitted.providerJobId)
        || (submitted.status !== 'pending' && submitted.status !== 'in_progress')
      ) {
        throw toSafeAppError({ code: 'MODEL_PROVIDER_REQUEST_FAILED' })
      }
      if (input.route.provider === 'openrouter') {
        this.dependencies.providerUsage.bindIdentity(operationKey, {
          providerJobId: submitted.providerJobId,
        })
      }
      if (this.stopped || controller.signal.aborted) {
        throw toSafeAppError({ code: 'CANCELLED' })
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
      if (error instanceof ProviderUsageConsistencyError) throw error
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
    const results = await Promise.allSettled([
      ...this.work.values(),
      ...this.submissions,
    ])
    const consistencyFailure = [
      ...results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []),
      ...this.backgroundFailures,
    ].find((error) => error instanceof ProviderUsageConsistencyError)
    if (consistencyFailure) throw consistencyFailure
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

  private async acquireSubmitSnapshot(
    providerId: ResolvedChatRoute['provider'],
  ): Promise<ModelProviderSnapshot> {
    modelProviderIdSchema.parse(providerId)
    const snapshot = await this.dependencies.providers.acquire(providerId)
    if (snapshot.providerId !== providerId) throw new ProviderUsageConsistencyError()
    return snapshot
  }

  private classifyUsage(job: MediaGenerationJob): VideoUsageClassification {
    const run = this.dependencies.database.chatRuns.getByRequestId(job.id)
    if (
      !run
      || run.conversationId !== job.conversationId
      || run.model !== job.model
      || run.requestId !== job.id
      || run.status !== 'running'
    ) throw new ProviderUsageConsistencyError()
    const event = this.dependencies.providerUsage.find(`video:${job.id}`)
    if (job.provider !== 'openrouter') {
      if (
        event !== undefined
        || (run.userId === undefined) !== (run.provider === undefined)
        || (run.provider !== undefined && run.provider !== job.provider)
      ) throw new ProviderUsageConsistencyError()
      return { kind: 'untracked' }
    }
    if (run.userId === undefined && run.provider === undefined) {
      if (event !== undefined) throw new ProviderUsageConsistencyError()
      return { kind: 'legacy-unattributed' }
    }
    if (run.userId === undefined || run.provider !== 'openrouter' || event === undefined) {
      throw new ProviderUsageConsistencyError()
    }
    this.assertTrackedUsage(job, run, event)
    return { kind: 'tracked', event }
  }

  private assertTrackedUsage(
    job: MediaGenerationJob,
    run: ChatRun,
    event: ProviderUsageEvent,
  ): void {
    if (
      event.userId !== run.userId
      || event.provider !== 'openrouter'
      || event.requestId !== job.id
      || event.chatRunId !== run.id
      || event.model !== job.model
      || event.modality !== 'video'
      || event.providerJobId !== job.providerJobId
    ) throw new ProviderUsageConsistencyError()
  }

  private async snapshotForJob(
    job: MediaGenerationJob,
    usage: VideoUsageClassification,
  ): Promise<ModelProviderSnapshot | undefined> {
    const persisted = this.providerSnapshots.get(job.id)
    if (persisted !== undefined) {
      if (persisted.providerId !== job.provider) throw new ProviderUsageConsistencyError()
      if (
        usage.kind === 'tracked'
        && (
          usage.event.apiKeyFingerprint === undefined
          || persisted.apiKeyFingerprint !== usage.event.apiKeyFingerprint
        )
      ) throw new ProviderUsageConsistencyError()
      return persisted
    }
    let snapshot: ModelProviderSnapshot
    try {
      snapshot = await this.dependencies.providers.acquire(modelProviderIdSchema.parse(job.provider))
    } catch (error) {
      if (toSafeAppError(error).code === 'CREDENTIAL_UNAVAILABLE') return undefined
      throw error
    }
    if (snapshot.providerId !== job.provider) throw new ProviderUsageConsistencyError()
    if (usage.kind === 'tracked') {
      if (usage.event.apiKeyFingerprint === undefined) {
        throw new ProviderUsageConsistencyError()
      }
      if (snapshot.apiKeyFingerprint !== usage.event.apiKeyFingerprint) return undefined
    }
    this.providerSnapshots.set(job.id, snapshot)
    return snapshot
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
      void this.wake(job.id).catch((error: unknown) => {
        this.recordBackgroundFailure(error)
      })
    }, Math.max(0, target - this.now()))
    this.timers.set(job.id, handle)
  }

  private scheduleCredentialRetry(job: MediaGenerationJob): void {
    if (this.stopped || !ACTIVE_STATUSES.includes(job.status)) return
    this.clearTimer(job.id)
    const target = Math.min(
      this.now() + CREDENTIAL_RETRY_MS,
      job.createdAt + VIDEO_TIMEOUT_MS,
    )
    const handle = this.timersApi.set(() => {
      this.timers.delete(job.id)
      void this.wake(job.id).catch((error: unknown) => {
        this.recordBackgroundFailure(error)
      })
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
    const usage = this.classifyUsage(job)
    const deadline = job.createdAt + VIDEO_TIMEOUT_MS
    if (this.now() >= deadline) {
      if (usage.kind === 'tracked' && job.status !== 'downloading') {
        this.dependencies.providerUsage.markUnknown(`video:${job.id}`, this.now())
      }
      this.fail(job, 'MEDIA_GENERATION_TIMEOUT')
      return
    }
    const providerSnapshot = await this.snapshotForJob(job, usage)
    const current = this.currentActiveJob(job, controller.signal)
    if (current === undefined) return
    const currentUsage = this.classifyUsage(current)
    if (this.now() >= deadline) {
      if (currentUsage.kind === 'tracked' && current.status !== 'downloading') {
        this.dependencies.providerUsage.markUnknown(`video:${current.id}`, this.now())
      }
      this.fail(current, 'MEDIA_GENERATION_TIMEOUT')
      return
    }
    if (providerSnapshot === undefined) {
      this.scheduleCredentialRetry(current)
      return
    }
    this.clearDeadlineTimer(job.id)
    const deadlineTimer = this.timersApi.set(
      () => controller.abort(),
      Math.max(0, deadline - this.now()),
    )
    this.deadlineTimers.set(job.id, deadlineTimer)
    try {
      if (current.status === 'downloading') {
        await this.download(current, controller.signal, providerSnapshot.provider)
        return
      }
      await this.poll(current, controller.signal, currentUsage, providerSnapshot.provider)
    } finally {
      if (this.deadlineTimers.get(job.id) === deadlineTimer) {
        this.clearDeadlineTimer(job.id)
      }
    }
  }

  private currentActiveJob(
    expected: MediaGenerationJob,
    signal: AbortSignal,
  ): MediaGenerationJob | undefined {
    if (this.stopped || signal.aborted) return undefined
    const current = this.dependencies.database.mediaGenerationJobs.get(expected.id)
    if (
      !current
      || !ACTIVE_STATUSES.includes(current.status)
      || isVideoSubmissionIntent(current)
      || current.conversationId !== expected.conversationId
      || current.assistantMessageId !== expected.assistantMessageId
      || current.provider !== expected.provider
      || current.model !== expected.model
      || current.providerJobId !== expected.providerJobId
      || current.status !== expected.status
      || current.pollAttempts !== expected.pollAttempts
      || current.nextPollAt !== expected.nextPollAt
      || current.updatedAt !== expected.updatedAt
    ) return undefined
    return current
  }

  private async poll(
    job: MediaGenerationJob,
    signal: AbortSignal,
    usage: VideoUsageClassification,
    provider: ModelProvider,
  ): Promise<void> {
    if (isVideoSubmissionIntent(job)) {
      this.fail(job, 'MEDIA_GENERATION_FAILED')
      return
    }
    let result: Awaited<ReturnType<NonNullable<ModelProvider['pollVideo']>>>
    try {
      if (!provider.pollVideo) throw toSafeAppError({ code: 'MODEL_MODALITY_UNSUPPORTED' })
      result = await provider.pollVideo(job.providerJobId, signal)
    } catch (error) {
      if (usage.kind === 'tracked') {
        this.dependencies.providerUsage.markUnknown(`video:${job.id}`, this.now())
      }
      throw error
    }
    const attempts = (job.pollAttempts ?? 0) + 1
    if (result.status === 'failed') {
      this.recordTerminalProviderUsage(job.id, usage, result)
      if (this.stopped || signal.aborted) return
      this.fail(job, appErrorCodeSchema.parse(result.errorCode))
      return
    }
    if (result.status === 'completed') {
      this.recordTerminalProviderUsage(job.id, usage, result)
      if (this.stopped || signal.aborted) return
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
      await this.download(downloading.job, signal, provider, {
        generationId: result.generationId,
        costUsd: result.costUsd,
      })
      return
    }

    if (this.stopped || signal.aborted) return

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

  private recordTerminalProviderUsage(
    jobId: string,
    usage: VideoUsageClassification,
    result: { generationId?: string; costUsd?: string },
  ): void {
    if (usage.kind !== 'tracked') return
    const operationKey = `video:${jobId}`
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
    const common = {
      id: usage.event.id,
      operationId: operationKey,
      purpose: 'media_generation',
      credentialOwner: 'user' as const,
      billable: false as const,
      provider: usage.event.provider,
      model: usage.event.model,
      modality: 'video' as const,
      occurredAt: new Date(usage.event.startedAt).toISOString(),
    }
    this.dependencies.providerUsage.recordByokUsage?.(result.costUsd === undefined
      ? { ...common, costStatus: 'unavailable' }
      : { ...common, costStatus: 'estimated', estimatedCostUsd: result.costUsd })
  }

  private async download(
    job: MediaGenerationJob,
    signal: AbortSignal,
    provider: ModelProvider,
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
      this.dependencies.onMutationCommitted(completed.job.conversationId)
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
    this.providerSnapshots.delete(job.id)
  }

  private async handleOperationFailure(
    jobId: string,
    controller: AbortController,
    error: unknown,
  ): Promise<void> {
    if (error instanceof ProviderUsageConsistencyError) throw error
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
    this.dependencies.onMutationCommitted(failed.job.conversationId)
    this.providerSnapshots.delete(job.id)
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
