import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import {
  toSafeAppError,
  type AppError,
  type ChatBlock,
  type ChatEvent,
  type MediaAsset,
} from '@autoforge/shared'
import type {
  AgentPersistencePort,
  AgentRunResult,
} from '../agent/agent-orchestrator.js'
import {
  MEDIA_LIMITS,
  type GeneratedAssetWriter,
  type MediaAssetService,
} from '../media/media-asset-service.js'
import type { SafeMediaDownloader } from '../media/safe-download.js'
import {
  ProviderUsageConsistencyError,
  type ProviderUsageRepository,
} from '../database/repositories.js'
import { trackProviderStream } from '../billing/provider-usage-stream.js'
import type {
  ModelImageResult,
  ModelProviderSnapshot,
  ModelProviderSnapshotSource,
} from './model-provider.js'
import type { ResolvedChatRoute } from './multimodal-router.js'

export interface MediaGenerationOrchestratorDependencies {
  providers: ModelProviderSnapshotSource
  persistence: AgentPersistencePort
  media: MediaAssetService
  downloader: Pick<SafeMediaDownloader, 'download'>
  providerUsage: Pick<ProviderUsageRepository, 'start' | 'bindIdentity' | 'report' | 'markUnknown'>
  emit: (event: ChatEvent) => void
  id?: () => string
  now?: () => number
}

interface UsageAttribution {
  userId: string
}

export interface MediaGenerationRunInput extends UsageAttribution {
  requestId: string
  conversationId: string
  prompt: string
  userBlocks: ChatBlock[]
  assetIds: string[]
  route: ResolvedChatRoute
}

interface ActiveGeneration {
  controller: AbortController
  writer?: GeneratedAssetWriter
}

interface PersistedGeneration {
  runId: string
  messageId: string
  blockId: string
  pending: Extract<ChatBlock, { type: 'media_generation' }>
}

function safeError(error: unknown, signal: AbortSignal): AppError {
  if (signal.aborted) return toSafeAppError({ code: 'CANCELLED' })
  const normalized = toSafeAppError(error)
  return normalized.code === 'INTERNAL_ERROR'
    ? toSafeAppError({ code: 'MEDIA_GENERATION_FAILED' })
    : normalized
}

function mediaBlock(
  blockId: string,
  asset: MediaAsset,
): Extract<ChatBlock, { type: 'media' }> {
  return {
    type: 'media',
    blockId,
    assetId: asset.id,
    kind: asset.kind,
    purpose: 'output',
    name: asset.name,
    mimeType: asset.mimeType,
    byteSize: asset.byteSize,
    ...(asset.width === undefined ? {} : { width: asset.width }),
    ...(asset.height === undefined ? {} : { height: asset.height }),
    ...(asset.durationMs === undefined ? {} : { durationMs: asset.durationMs }),
  }
}

export class MediaGenerationOrchestrator {
  private readonly id: () => string
  private readonly now: () => number
  private readonly active = new Map<string, ActiveGeneration>()

  constructor(private readonly dependencies: MediaGenerationOrchestratorDependencies) {
    this.id = dependencies.id ?? randomUUID
    this.now = dependencies.now ?? Date.now
  }

  async runImage(input: MediaGenerationRunInput): Promise<AgentRunResult> {
    return this.run(input, 'image')
  }

  async runAudio(input: MediaGenerationRunInput): Promise<AgentRunResult> {
    return this.run(input, 'audio')
  }

  async cancel(requestId: string): Promise<void> {
    const active = this.active.get(requestId)
    if (!active) return
    active.controller.abort()
  }

  hasActiveRuns(): boolean {
    return this.active.size > 0
  }

  private async run(
    input: MediaGenerationRunInput,
    kind: 'image' | 'audio',
  ): Promise<AgentRunResult> {
    if (input.route.outputType !== kind) {
      return {
        requestId: input.requestId,
        status: 'failed',
        error: toSafeAppError({ code: 'INVALID_INPUT' }),
      }
    }
    if (
      input.assetIds.length !== input.route.assets.length
      || input.assetIds.some((assetId) => !input.route.assets.some((asset) => asset.id === assetId))
      || new Set(input.assetIds).size !== input.assetIds.length
    ) {
      return {
        requestId: input.requestId,
        status: 'failed',
        error: toSafeAppError({ code: 'INVALID_INPUT' }),
      }
    }
    if (this.active.has(input.requestId)) {
      return {
        requestId: input.requestId,
        status: 'failed',
        error: toSafeAppError({ code: 'CONFLICT' }),
      }
    }

    const active: ActiveGeneration = {
      controller: new AbortController(),
    }
    this.active.set(input.requestId, active)
    let persisted: PersistedGeneration | undefined
    try {
      persisted = this.persistStart(input, kind)
      this.safeEmit({
        type: 'block',
        conversationId: input.conversationId,
        messageId: persisted.messageId,
        block: persisted.pending,
      })
      this.safeEmit({
        type: 'status',
        conversationId: input.conversationId,
        requestId: input.requestId,
        status: 'running',
      })

      const providerSnapshot = await this.dependencies.providers.acquire(input.route.provider)
      if (providerSnapshot.providerId !== input.route.provider) {
        throw new ProviderUsageConsistencyError()
      }

      return kind === 'image'
        ? await this.generateImage(input, persisted, active, providerSnapshot)
        : await this.generateAudio(input, persisted, active, providerSnapshot)
    } catch (error) {
      if (error instanceof ProviderUsageConsistencyError) {
        if (persisted) {
          try {
            await this.fail(input, persisted, active, error, 'INTERNAL_ERROR')
          } catch {
            // The original ledger consistency failure remains authoritative.
          }
        }
        throw error
      }
      if (!persisted) {
        const failure = safeError(error, active.controller.signal)
        this.safeEmit({
          type: 'status',
          conversationId: input.conversationId,
          requestId: input.requestId,
          status: 'failed',
          error: failure,
        })
        return {
          requestId: input.requestId,
          status: 'failed',
          error: failure,
        }
      }
      try {
        return await this.fail(input, persisted, active, error)
      } catch (terminalError) {
        throw toSafeAppError(terminalError)
      }
    } finally {
      this.active.delete(input.requestId)
    }
  }

  private persistStart(
    input: MediaGenerationRunInput,
    kind: 'image' | 'audio',
  ): PersistedGeneration {
    const userMessageId = this.id()
    const runId = this.id()
    const messageId = this.id()
    const blockId = this.id()
    const startedAt = this.now()
    const pending: PersistedGeneration['pending'] = {
      type: 'media_generation',
      blockId,
      jobId: input.requestId,
      kind,
      status: 'in_progress',
    }

    this.dependencies.persistence.startMediaGeneration({
      user: {
        messageId: userMessageId,
        conversationId: input.conversationId,
        blocks: input.userBlocks,
        assetIds: input.assetIds,
        createdAt: startedAt,
      },
      run: {
        runId,
        conversationId: input.conversationId,
        requestId: input.requestId,
        userId: input.userId,
        provider: input.route.provider,
        model: input.route.model,
        startedAt,
      },
      assistant: {
        messageId,
        conversationId: input.conversationId,
        initialBlocks: [pending],
        createdAt: startedAt,
      },
    })
    return { runId, messageId, blockId, pending }
  }

  private async generateImage(
    input: MediaGenerationRunInput,
    persisted: PersistedGeneration,
    active: ActiveGeneration,
    providerSnapshot: ModelProviderSnapshot,
  ): Promise<AgentRunResult> {
    const provider = providerSnapshot.provider
    if (!provider.generateImage) throw toSafeAppError({ code: 'MODEL_MODALITY_UNSUPPORTED' })
    if (!input.route.imageParameterSupport) throw toSafeAppError({ code: 'INVALID_INPUT' })
    const modelInputs = await this.dependencies.media.modelInput(
      input.conversationId,
      input.route.assets.map((asset) => asset.id),
    )
    if (modelInputs.some((asset) => asset.kind !== 'image')) {
      throw toSafeAppError({ code: 'MODEL_MODALITY_UNSUPPORTED' })
    }
    const operationKey = `image:${input.requestId}`
    const recordsProviderUsage = providerSnapshot.providerId === 'openrouter'
    let costReported = false
    let result: ModelImageResult
    if (recordsProviderUsage) {
      this.dependencies.providerUsage.start({
        id: this.id(),
        operationKey,
        userId: input.userId,
        provider: providerSnapshot.providerId,
        ...(providerSnapshot.apiKeyFingerprint === undefined
          ? {}
          : { apiKeyFingerprint: providerSnapshot.apiKeyFingerprint }),
        requestId: input.requestId,
        chatRunId: persisted.runId,
        model: input.route.model,
        modality: 'image',
        startedAt: this.now(),
      })
    }
    try {
      result = await provider.generateImage({
        model: input.route.model,
        prompt: input.prompt,
        options: input.route.generation.image,
        parameterSupport: input.route.imageParameterSupport,
        references: modelInputs.map(({ mimeType, dataBase64 }) => ({ mimeType, dataBase64 })),
        signal: active.controller.signal,
      })
      if (recordsProviderUsage && result.usage?.costUsd !== undefined) {
        this.dependencies.providerUsage.report(operationKey, {
          ...(result.usage.inputTokens === undefined
            ? {}
            : { inputTokens: result.usage.inputTokens }),
          ...(result.usage.outputTokens === undefined
            ? {}
            : { outputTokens: result.usage.outputTokens }),
          costUsd: result.usage.costUsd,
          endedAt: this.now(),
        })
        costReported = true
      }
    } finally {
      if (recordsProviderUsage && !costReported) {
        this.dependencies.providerUsage.markUnknown(operationKey, this.now())
      }
    }
    if (active.controller.signal.aborted) throw toSafeAppError({ code: 'CANCELLED' })
    if (result.outputs.length !== 1) throw toSafeAppError({ code: 'MEDIA_GENERATION_FAILED' })

    const output = result.outputs[0]!
    const generated = output.type === 'base64'
      ? await this.dependencies.media.commitGeneratedBase64({
          conversationId: input.conversationId,
          messageId: persisted.messageId,
          kind: 'image',
          provider: input.route.provider,
          model: input.route.model,
          name: 'generated-image',
          dataBase64: output.dataBase64,
          ...(output.mimeType === undefined ? {} : { declaredMimeType: output.mimeType }),
        })
      : await this.downloadImage(input, persisted, output.url, active.controller.signal)
    await this.discardIfCancelled(generated, input.conversationId, active.controller.signal)
    return this.complete(
      input,
      persisted,
      mediaBlock(persisted.blockId, generated),
      result.usage,
    )
  }

  private async downloadImage(
    input: MediaGenerationRunInput,
    persisted: PersistedGeneration,
    url: string,
    signal: AbortSignal,
  ): Promise<MediaAsset> {
    if (signal.aborted) throw toSafeAppError({ code: 'CANCELLED' })
    const stream = new PassThrough()
    const abort = () => stream.destroy(new Error('cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    try {
      const download = this.dependencies.downloader.download(url, stream, {
        maxBytes: MEDIA_LIMITS.generatedBytes,
      }).then(
        (value) => {
          stream.end()
          return value
        },
        (error) => {
          stream.destroy()
          throw error
        },
      )
      const [asset] = await Promise.all([
        this.dependencies.media.commitGeneratedStream({
          conversationId: input.conversationId,
          messageId: persisted.messageId,
          kind: 'image',
          provider: input.route.provider,
          model: input.route.model,
          name: 'generated-image',
          stream,
        }),
        download,
      ])
      return asset
    } finally {
      signal.removeEventListener('abort', abort)
      if (!stream.destroyed) stream.destroy()
    }
  }

  private async generateAudio(
    input: MediaGenerationRunInput,
    persisted: PersistedGeneration,
    active: ActiveGeneration,
    providerSnapshot: ModelProviderSnapshot,
  ): Promise<AgentRunResult> {
    const modelInputs = await this.dependencies.media.modelInput(
      input.conversationId,
      input.route.assets.map((asset) => asset.id),
    )
    if (active.controller.signal.aborted) throw toSafeAppError({ code: 'CANCELLED' })
    const writer = await this.dependencies.media.createGeneratedWriter({
      conversationId: input.conversationId,
      messageId: persisted.messageId,
      kind: 'audio',
      provider: input.route.provider,
      model: input.route.model,
      name: 'generated-audio',
    })
    active.writer = writer
    let transcript = ''
    let finishReason: string | undefined
    let generationId: string | undefined
    let usage: { inputTokens?: number; outputTokens?: number; costUsd?: string } | undefined
    const content = [
      { type: 'text' as const, text: input.prompt },
      ...modelInputs.map(({ kind, mimeType, dataBase64 }) => ({
        type: 'media' as const,
        kind,
        mimeType,
        dataBase64,
      })),
    ]
    const operationKey = `audio:${input.requestId}`
    for await (const event of trackProviderStream({
      operationKey,
      purpose: 'media_generation',
      attribution: {
        userId: input.userId,
        requestId: input.requestId,
        chatRunId: persisted.runId,
        model: input.route.model,
        modality: 'audio',
      },
      request: {
        model: input.route.model,
        messages: [{ role: 'user', content }],
        output: {
          type: 'audio',
          ...input.route.generation.audio,
        },
        signal: active.controller.signal,
        endUserId: input.userId,
      },
      provider: providerSnapshot,
      providerUsage: this.dependencies.providerUsage,
      id: this.id,
      now: this.now,
    })) {
      if (
        active.controller.signal.aborted
        && event.type !== 'generation'
        && event.type !== 'usage'
      ) throw toSafeAppError({ code: 'CANCELLED' })
      if ('choiceIndex' in event && event.choiceIndex !== 0) continue
      if (event.type === 'audio_delta') {
        await writer.appendBase64Chunk(event.dataBase64)
        if (event.transcript) transcript += event.transcript
      } else if (event.type === 'finish') {
        finishReason = event.reason
      } else if (event.type === 'generation') {
        generationId = event.id
      } else if (event.type === 'usage') {
        usage = {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          ...(event.costUsd === undefined ? {} : { costUsd: event.costUsd }),
        }
      } else if (event.type === 'tool_call') {
        throw toSafeAppError({ code: 'MODEL_PROVIDER_REQUEST_FAILED' })
      }
      if (active.controller.signal.aborted) throw toSafeAppError({ code: 'CANCELLED' })
    }
    if (finishReason !== 'stop') throw toSafeAppError({ code: 'MODEL_PROVIDER_REQUEST_FAILED' })
    if (active.controller.signal.aborted) throw toSafeAppError({ code: 'CANCELLED' })
    const generated = await writer.commit()
    await this.discardIfCancelled(generated, input.conversationId, active.controller.signal)
    const output = mediaBlock(persisted.blockId, generated)
    return this.complete(input, persisted, output, usage, transcript, generationId)
  }

  private async complete(
    input: MediaGenerationRunInput,
    persisted: PersistedGeneration,
    output: Extract<ChatBlock, { type: 'media' }>,
    usage?: { inputTokens?: number; outputTokens?: number; costUsd?: string },
    transcript = '',
    generationId?: string,
  ): Promise<AgentRunResult> {
    const blocks: ChatBlock[] = [
      output,
      ...(transcript ? [{ type: 'text' as const, text: transcript }] : []),
    ]
    try {
      this.dependencies.persistence.finalize({
        runId: persisted.runId,
        requestId: input.requestId,
        messageId: persisted.messageId,
        blocks,
        status: 'completed',
        endedAt: this.now(),
        ...(generationId === undefined ? {} : { generationId }),
        ...(usage?.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
        ...(usage?.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
        ...(usage?.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
      })
    } catch (error) {
      await this.dependencies.media.removeDraft(output.assetId, input.conversationId).catch(() => undefined)
      throw error
    }
    this.safeEmit({
      type: 'block_update',
      conversationId: input.conversationId,
      messageId: persisted.messageId,
      blockId: persisted.blockId,
      block: output,
    })
    if (transcript) {
      this.safeEmit({
        type: 'block',
        conversationId: input.conversationId,
        messageId: persisted.messageId,
        block: { type: 'text', text: transcript },
      })
    }
    this.safeEmit({
      type: 'status',
      conversationId: input.conversationId,
      requestId: input.requestId,
      status: 'completed',
    })
    return { requestId: input.requestId, status: 'completed' }
  }

  private async fail(
    input: MediaGenerationRunInput,
    persisted: PersistedGeneration,
    active: ActiveGeneration,
    error: unknown,
    failureCode?: AppError['code'],
  ): Promise<AgentRunResult> {
    await Promise.resolve().then(() => active.writer?.abort()).catch(() => undefined)
    const failure = failureCode === undefined
      ? safeError(error, active.controller.signal)
      : toSafeAppError({ code: failureCode })
    const block: PersistedGeneration['pending'] = {
      ...persisted.pending,
      status: 'failed',
      errorCode: failure.code,
    }
    const status = failure.code === 'CANCELLED' ? 'cancelled' : 'failed'
    this.dependencies.persistence.finalize({
      runId: persisted.runId,
      requestId: input.requestId,
      messageId: persisted.messageId,
      blocks: [block],
      status,
      endedAt: this.now(),
      errorCode: failure.code,
    })
    this.safeEmit({
      type: 'block_update',
      conversationId: input.conversationId,
      messageId: persisted.messageId,
      blockId: persisted.blockId,
      block,
    })
    this.safeEmit({
      type: 'status',
      conversationId: input.conversationId,
      requestId: input.requestId,
      status,
      error: failure,
    })
    return {
      requestId: input.requestId,
      status,
      error: failure,
    }
  }

  private async discardIfCancelled(
    asset: MediaAsset,
    conversationId: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (!signal.aborted) return
    await this.dependencies.media.removeDraft(asset.id, conversationId).catch(() => undefined)
    throw toSafeAppError({ code: 'CANCELLED' })
  }

  private safeEmit(event: ChatEvent): void {
    try {
      this.dependencies.emit(event)
    } catch {
      // Renderer listeners are observational.
    }
  }
}
