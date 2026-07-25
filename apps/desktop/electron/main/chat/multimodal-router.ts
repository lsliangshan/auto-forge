import {
  toSafeAppError,
  type AppError,
  type ConversationGenerationPreferences,
  type GenerationOptions,
  type ModelInfo,
  type ModelProviderId,
  type OutputType,
  type ProviderDefaultModels,
} from '@autoforge/shared'
import type { ResolvedMediaAsset } from '../media/media-asset-service.js'

const MAX_ASSETS = 5
const MAX_TOTAL_BYTES = 250 * 1024 * 1024
const OUTPUTS = ['text', 'image', 'audio', 'video'] as const

type ConcreteOutput = (typeof OUTPUTS)[number]

export interface ResolveChatRouteInput {
  provider: ModelProviderId
  requestedModel?: string
  requestedOutput: OutputType
  requestedGeneration: GenerationOptions
  defaults: ProviderDefaultModels
  conversationPreferences: ConversationGenerationPreferences
  models: ModelInfo[]
  assets: ResolvedMediaAsset[]
}

export interface ResolvedChatRoute {
  provider: ModelProviderId
  model: string
  supportsTools: boolean
  outputType: ConcreteOutput
  assets: ResolvedMediaAsset[]
  generation: GenerationOptions
}

export interface OutputSelectionRequired {
  selectionRequired: true
  compatibleOutputs: ConcreteOutput[]
}

export interface ModelSelectionRequired {
  modelRequired: true
  outputType: ConcreteOutput
  compatibleModels: ModelInfo[]
}

export type ChatRouteResolution = ResolvedChatRoute | OutputSelectionRequired | ModelSelectionRequired

function failure(code: AppError['code']): never {
  throw toSafeAppError({ code })
}

function isOutput(value: unknown): value is ConcreteOutput {
  return typeof value === 'string' && (OUTPUTS as readonly string[]).includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function providerDefault(defaults: ProviderDefaultModels, provider: ModelProviderId, output: ConcreteOutput): string | undefined {
  if (provider === 'deepseek') return output === 'text' ? defaults.deepseek.text : undefined
  return defaults.openrouter[output]
}

function modelForId(models: readonly ModelInfo[], id: string): ModelInfo | undefined {
  return models.find((candidate) => candidate.id === id)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'number' && Number.isSafeInteger(entry) && entry > 0)
}

function isModel(model: unknown): model is ModelInfo {
  if (!isRecord(model) || !isRecord(model.generation)) return false
  const image = model.generation.image
  const audio = model.generation.audio
  const video = model.generation.video
  return typeof model.id === 'string'
    && model.id.trim().length > 0
    && Array.isArray(model.inputModalities)
    && Array.isArray(model.outputModalities)
    && model.inputModalities.every(isOutput)
    && model.outputModalities.every(isOutput)
    && typeof model.supportsTools === 'boolean'
    && (image === undefined || (
      isRecord(image)
      && isStringArray(image.resolutions)
      && isStringArray(image.aspectRatios)
      && isStringArray(image.formats)
      && typeof image.maxCount === 'number'
      && Number.isSafeInteger(image.maxCount)
      && image.maxCount > 0
    ))
    && (audio === undefined || (
      isRecord(audio) && isStringArray(audio.voices) && isStringArray(audio.formats)
    ))
    && (video === undefined || (
      isRecord(video)
      && isStringArray(video.resolutions)
      && isStringArray(video.aspectRatios)
      && isNumberArray(video.durations)
      && typeof video.supportsAudio === 'boolean'
    ))
}

function assertCatalog(provider: ModelProviderId, models: readonly ModelInfo[]): void {
  if (!Array.isArray(models)) failure('INVALID_INPUT')
  const ids = new Set<string>()
  for (const candidate of models) {
    if (!isModel(candidate)) failure('MODEL_MODALITY_UNSUPPORTED')
    if (ids.has(candidate.id)) failure('CONFLICT')
    ids.add(candidate.id)
    if (provider === 'deepseek' && (
      candidate.inputModalities.some((modality: ConcreteOutput) => modality !== 'text')
      || candidate.outputModalities.some((modality: ConcreteOutput) => modality !== 'text')
    )) failure('MODEL_MODALITY_UNSUPPORTED')
  }
}

function assertAssets(assets: readonly ResolvedMediaAsset[]): void {
  if (!Array.isArray(assets)) failure('INVALID_INPUT')
  if (assets.length > MAX_ASSETS) failure('MEDIA_ATTACHMENT_LIMIT_EXCEEDED')

  const ids = new Set<string>()
  let totalBytes = 0
  for (const asset of assets) {
    if (
      !asset
      || typeof asset.id !== 'string'
      || asset.id.trim().length === 0
      || !isOutput(asset.kind)
      || asset.kind === 'text'
      || typeof asset.mimeType !== 'string'
      || asset.mimeType.trim().length === 0
      || !Number.isSafeInteger(asset.byteSize)
      || asset.byteSize < 0
      || typeof asset.conversationId !== 'string'
      || asset.conversationId.trim().length === 0
      || typeof asset.absolutePath !== 'string'
      || asset.absolutePath.length === 0
      || typeof asset.relativePath !== 'string'
      || asset.relativePath.length === 0
    ) failure('MEDIA_ASSET_UNAVAILABLE')
    if (ids.has(asset.id)) failure('CONFLICT')
    ids.add(asset.id)
    totalBytes += asset.byteSize
    if (totalBytes > MAX_TOTAL_BYTES) failure('MEDIA_SIZE_LIMIT_EXCEEDED')
  }
}

function supportsRequest(model: ModelInfo, output: ConcreteOutput, assets: readonly ResolvedMediaAsset[]): boolean {
  if (
    !model.outputModalities.includes(output)
    || !model.inputModalities.includes('text')
    || !supportsGeneration(model, output)
  ) return false
  if ((output === 'image' || output === 'video') && assets.some((asset) => asset.kind !== 'image')) return false
  return assets.every((asset) => model.inputModalities.includes(asset.kind))
}

function supportsGeneration(model: ModelInfo, output: ConcreteOutput): boolean {
  if (output === 'text') return true
  if (output === 'image') {
    const capability = model.generation.image
    return capability !== undefined
      && capability.maxCount >= 1
      && capability.resolutions.length > 0
      && capability.aspectRatios.length > 0
      && capability.formats.length > 0
  }
  if (output === 'audio') return (model.generation.audio?.formats.length ?? 0) > 0
  const capability = model.generation.video
  return capability !== undefined
    && capability.resolutions.length > 0
    && capability.aspectRatios.length > 0
    && capability.durations.length > 0
}

function compatibleOutputs(model: ModelInfo, assets: readonly ResolvedMediaAsset[]): ConcreteOutput[] {
  return OUTPUTS.filter((output) => supportsRequest(model, output, assets))
}

function compatibleModels(models: readonly ModelInfo[], output: ConcreteOutput, assets: readonly ResolvedMediaAsset[]): ModelInfo[] {
  return models
    .filter((candidate) => supportsRequest(candidate, output, assets))
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id))
}

function preferredModel(
  input: ResolveChatRouteInput,
  output: ConcreteOutput,
): ModelInfo | undefined {
  const preferredIds = [
    input.conversationPreferences.models[output],
    providerDefault(input.defaults, input.provider, output),
  ]
  for (const id of preferredIds) {
    if (!id) continue
    const candidate = modelForId(input.models, id)
    if (candidate && supportsRequest(candidate, output, input.assets)) return candidate
  }
  return undefined
}

function normalizeGeneration(
  requested: GenerationOptions,
  model: ModelInfo,
  output: ConcreteOutput,
): GenerationOptions {
  const normalized: GenerationOptions = {
    image: { ...requested.image },
    audio: { ...requested.audio },
    video: { ...requested.video },
  }

  if (output === 'image') {
    const capability = model.generation.image
    if (!capability || capability.maxCount < 1) failure('MODEL_MODALITY_UNSUPPORTED')
    normalized.image = {
      count: 1,
      resolution: selectString(requested.image.resolution, capability.resolutions),
      aspectRatio: selectString(requested.image.aspectRatio, capability.aspectRatios),
      format: selectString(requested.image.format, capability.formats),
    }
  }
  if (output === 'audio') {
    const capability = model.generation.audio
    if (!capability) failure('MODEL_MODALITY_UNSUPPORTED')
    normalized.audio = {
      format: selectString(requested.audio.format, capability.formats),
      ...(requested.audio.voice === undefined ? {} : { voice: selectString(requested.audio.voice, capability.voices) }),
    }
  }
  if (output === 'video') {
    const capability = model.generation.video
    if (!capability) failure('MODEL_MODALITY_UNSUPPORTED')
    normalized.video = {
      durationSeconds: selectNumber(requested.video.durationSeconds, capability.durations),
      resolution: selectString(requested.video.resolution, capability.resolutions),
      aspectRatio: selectString(requested.video.aspectRatio, capability.aspectRatios),
      generateAudio: requested.video.generateAudio && capability.supportsAudio,
    }
  }
  return normalized
}

function isGenerationOptions(value: unknown): value is GenerationOptions {
  if (!isRecord(value) || !isRecord(value.image) || !isRecord(value.audio) || !isRecord(value.video)) return false
  return value.image.count === 1
    && typeof value.image.resolution === 'string'
    && typeof value.image.aspectRatio === 'string'
    && typeof value.image.format === 'string'
    && (value.audio.voice === undefined || typeof value.audio.voice === 'string')
    && typeof value.audio.format === 'string'
    && typeof value.video.durationSeconds === 'number'
    && Number.isSafeInteger(value.video.durationSeconds)
    && value.video.durationSeconds > 0
    && typeof value.video.resolution === 'string'
    && typeof value.video.aspectRatio === 'string'
    && typeof value.video.generateAudio === 'boolean'
}

function isDefaults(value: unknown): value is ProviderDefaultModels {
  if (!isRecord(value)) return false
  const deepseek = value.deepseek
  const openrouter = value.openrouter
  if (!isRecord(deepseek) || !isRecord(openrouter)) return false
  if (typeof deepseek.text !== 'string' || deepseek.text.trim().length === 0) return false
  return OUTPUTS.every((output) => {
    if (output === 'text' || output === 'image' || output === 'audio' || output === 'video') {
      const defaultModel = openrouter[output]
      return defaultModel === undefined || (typeof defaultModel === 'string' && defaultModel.trim().length > 0)
    }
    return false
  })
}

function isPreferences(value: unknown): value is ConversationGenerationPreferences {
  if (!isRecord(value)) return false
  const models = value.models
  if (!isRecord(models)) return false
  if (value.outputType !== 'auto' && !isOutput(value.outputType)) return false
  return isGenerationOptions(value.generation)
    && OUTPUTS.every((output) => {
      const model = models[output]
      return model === undefined || (typeof model === 'string' && model.trim().length > 0)
    })
}

function selectString(requested: string, advertised: readonly string[]): string {
  if (advertised.includes(requested)) return requested
  if (advertised.length === 0) failure('MODEL_MODALITY_UNSUPPORTED')
  return advertised[0]!
}

function selectNumber(requested: number, advertised: readonly number[]): number {
  if (advertised.includes(requested)) return requested
  if (advertised.length === 0) failure('MODEL_MODALITY_UNSUPPORTED')
  return advertised[0]!
}

function route(input: ResolveChatRouteInput, model: ModelInfo, output: ConcreteOutput): ResolvedChatRoute {
  if (!supportsRequest(model, output, input.assets)) failure('MODEL_MODALITY_UNSUPPORTED')
  return {
    provider: input.provider,
    model: model.id,
    supportsTools: output === 'text' && model.supportsTools && model.inputModalities.includes('text'),
    outputType: output,
    assets: input.assets.slice(),
    generation: normalizeGeneration(input.requestedGeneration, model, output),
  }
}

export function resolveChatRoute(input: ResolveChatRouteInput): ChatRouteResolution {
  if (!input || (input.provider !== 'deepseek' && input.provider !== 'openrouter')) failure('INVALID_INPUT')
  if (!isGenerationOptions(input.requestedGeneration) || !isDefaults(input.defaults) || !isPreferences(input.conversationPreferences)) {
    failure('INVALID_INPUT')
  }
  assertAssets(input.assets)
  assertCatalog(input.provider, input.models)

  if (input.requestedOutput !== 'auto' && !isOutput(input.requestedOutput)) failure('INVALID_INPUT')

  if (input.requestedModel) {
    const selected = modelForId(input.models, input.requestedModel)
    if (!selected) failure('NOT_FOUND')
    if (input.requestedOutput !== 'auto') return route(input, selected, input.requestedOutput)

    const outputs = compatibleOutputs(selected, input.assets)
    const remembered = input.conversationPreferences.outputType
    if (isOutput(remembered) && outputs.includes(remembered)) return route(input, selected, remembered)
    if (outputs.length === 1) return route(input, selected, outputs[0]!)
    if (outputs.length === 0) failure('MODEL_MODALITY_UNSUPPORTED')
    return { selectionRequired: true, compatibleOutputs: outputs }
  }

  const remembered = input.conversationPreferences.outputType
  const output = input.requestedOutput === 'auto'
    ? (isOutput(remembered) ? remembered : 'text')
    : input.requestedOutput
  const selected = preferredModel(input, output)
  if (selected) return route(input, selected, output)

  const candidates = compatibleModels(input.models, output, input.assets)
  if (candidates.length === 0) failure('MODEL_MODALITY_UNSUPPORTED')
  return { modelRequired: true, outputType: output, compatibleModels: candidates }
}
