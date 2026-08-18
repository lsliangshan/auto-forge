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
import type { ProviderUsageRepository } from '../database/repositories.js'
import type { ModelImageResult, ModelProvider } from './model-provider.js'
import type { ResolvedChatRoute } from './multimodal-router.js'

export interface MediaGenerationProviderRegistryPort {
  get(provider: ResolvedChatRoute['provider']): Pick<ModelProvider, 'stream' | 'generateImage'>
}

export interface MediaGenerationOrchestratorDependencies {
  providers: MediaGenerationProviderRegistryPort
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
  apiKeyFingerprint?: string
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
  userId: string
  apiKeyFingerprint?: string
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
      userId: input.userId,
      ...(input.apiKeyFingerprint === undefined
        ? {}
        : { apiKeyFingerprint: input.apiKeyFingerprint }),
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

      return kind === 'image'
        ? await this.generateImage(input, persisted, active)
        : await this.generateAudio(input, persisted, active)
    } catch (error) {
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
  ): Promise<AgentRunResult> {
    const provider = this.dependencies.providers.get(input.route.provider)
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
    const recordsProviderUsage = input.route.provider === 'openrouter'
    let costReported = false
    let result: ModelImageResult
    if (recordsProviderUsage) {
      this.dependencies.providerUsage.start({
        id: this.id(),
        operationKey,
        userId: active.userId,
        provider: input.route.provider,
        ...(active.apiKeyFingerprint === undefined
          ? {}
          : { apiKeyFingerprint: active.apiKeyFingerprint }),
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
  ): Promise<AgentRunResult> {
    const provider = this.dependencies.providers.get(input.route.provider)
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
    const recordsProviderUsage = input.route.provider === 'openrouter'
    let costReported = false
    if (recordsProviderUsage) {
      this.dependencies.providerUsage.start({
        id: this.id(),
        operationKey,
        userId: active.userId,
        provider: input.route.provider,
        ...(active.apiKeyFingerprint === undefined
          ? {}
          : { apiKeyFingerprint: active.apiKeyFingerprint }),
        requestId: input.requestId,
        chatRunId: persisted.runId,
        model: input.route.model,
        modality: 'audio',
        startedAt: this.now(),
      })
    }
    try {
      for await (const event of provider.stream({
        model: input.route.model,
        messages: [{ role: 'user', content }],
        output: {
          type: 'audio',
          ...input.route.generation.audio,
        },
        signal: active.controller.signal,
        endUserId: active.userId,
      })) {
        if (active.controller.signal.aborted) throw toSafeAppError({ code: 'CANCELLED' })
        if ('choiceIndex' in event && event.choiceIndex !== 0) continue
        if (event.type === 'audio_delta') {
          await writer.appendBase64Chunk(event.dataBase64)
          if (event.transcript) transcript += event.transcript
        } else if (event.type === 'finish') {
          finishReason = event.reason
        } else if (event.type === 'generation') {
          generationId = event.id
          if (recordsProviderUsage) {
            this.dependencies.providerUsage.bindIdentity(operationKey, {
              generationId: event.id,
            })
          }
        } else if (event.type === 'usage') {
          usage = {
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            ...(event.costUsd === undefined ? {} : { costUsd: event.costUsd }),
          }
          if (recordsProviderUsage && event.costUsd !== undefined && !costReported) {
            this.dependencies.providerUsage.report(operationKey, {
              ...(generationId === undefined ? {} : { generationId }),
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              costUsd: event.costUsd,
              endedAt: this.now(),
            })
            costReported = true
          }
        } else if (event.type === 'tool_call') {
          throw toSafeAppError({ code: 'MODEL_PROVIDER_REQUEST_FAILED' })
        }
      }
    } finally {
      if (recordsProviderUsage && !costReported) {
        this.dependencies.providerUsage.markUnknown(operationKey, this.now())
      }
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
  ): Promise<AgentRunResult> {
    await active.writer?.abort().catch(() => undefined)
    const failure = safeError(error, active.controller.signal)
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
