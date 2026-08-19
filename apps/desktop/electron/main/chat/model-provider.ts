import { createParser } from 'eventsource-parser'
import { z } from 'zod'
import {
  toSafeAppError,
  type AppError,
  type GenerationOptions,
  type ModelInfo,
  type ModelProviderId,
  type VideoFrameType,
} from '@autoforge/shared'
import type { ModelMediaInput } from '../media/media-asset-service.js'

const MAX_ATTEMPTS = 4
const MAX_RETRY_AFTER_MS = 5_000
const MAX_DIAGNOSTIC_BODY = 1_024
const MAX_MODEL_CATALOG_BODY = 4 * 1024 * 1024
const MAX_MODELS = 5_000
const MAX_MODEL_PARAMETERS = 256
const MAX_MODALITIES = 16
const MAX_CAPABILITY_VALUES = 64
const MAX_MODEL_ID_LENGTH = 256
const MAX_MODEL_NAME_LENGTH = 512
const MAX_CAPABILITY_VALUE_LENGTH = 128
const MAX_IMAGE_COUNT = 10
const VIDEO_FRAME_TYPES = ['first_frame', 'last_frame'] as const

export type ModelContentPart =
  | { type: 'text'; text: string }
  | ({ type: 'media' } & Pick<ModelMediaInput, 'kind' | 'mimeType' | 'dataBase64'>)

export type ModelMessage =
  | { role: 'system' | 'user'; content: string | ModelContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; content: string; tool_call_id: string }

export interface ModelTool {
  type: 'function'
  function: { name: string; description: string; parameters: unknown }
}

export interface ModelStreamRequest {
  model: string
  messages: ModelMessage[]
  tools?: ModelTool[]
  output?: { type: 'text' } | { type: 'audio'; voice?: string; format: string }
  maxOutputTokens?: number
  signal?: AbortSignal
  endUserId?: string
}

export type ModelStreamEvent =
  | { type: 'generation'; id: string }
  | { type: 'text_delta'; choiceIndex: number; text: string }
  | { type: 'tool_call'; choiceIndex: number; index: number; id: string; name: string; arguments: unknown }
  | { type: 'finish'; choiceIndex: number; reason: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; totalTokens: number; costUsd?: string }
  | { type: 'audio_delta'; choiceIndex: number; dataBase64: string; transcript?: string }

export interface ModelImageParameterSupport {
  resolution: boolean
  aspectRatio: boolean
  outputFormat: boolean
}

export interface ModelImageRequest {
  model: string
  prompt: string
  options: GenerationOptions['image']
  parameterSupport: ModelImageParameterSupport
  references: Array<{ mimeType: string; dataBase64: string }>
  signal?: AbortSignal
}

export interface ModelImageResult {
  outputs: Array<
    | { type: 'base64'; dataBase64: string; mimeType?: string }
    | { type: 'url'; url: string }
  >
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: string }
}

export interface ModelVideoRequest {
  model: string
  prompt: string
  options: GenerationOptions['video']
  references: Array<{ mimeType: string; dataBase64: string }>
  frameImages: VideoFrameType[]
  useInputReferences?: boolean
  signal?: AbortSignal
}

export type ModelVideoStatus =
  | { status: 'pending' | 'in_progress' }
  | { status: 'completed'; generationId?: string; costUsd?: string }
  | { status: 'failed'; errorCode: AppError['code']; generationId?: string; costUsd?: string }

export interface ModelGenerationUsage {
  generationId: string
  costUsd?: string
}

export interface GenerationUsageProviderPort {
  getGenerationUsage(generationId: string, signal?: AbortSignal): Promise<ModelGenerationUsage>
}

export interface ModelProvider {
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>
  validateCredential(signal?: AbortSignal): Promise<{ valid: boolean }>
  stream(request: ModelStreamRequest): AsyncIterable<ModelStreamEvent>
  generateImage?(request: ModelImageRequest): Promise<ModelImageResult>
  submitVideo?(request: ModelVideoRequest): Promise<{ providerJobId: string; status: 'pending' | 'in_progress' }>
  pollVideo?(providerJobId: string, signal?: AbortSignal): Promise<ModelVideoStatus>
  downloadVideo?(providerJobId: string, signal?: AbortSignal): Promise<Response>
  getGenerationUsage?: GenerationUsageProviderPort['getGenerationUsage']
}

export interface ModelProviderSnapshot {
  providerId: ModelProviderId
  provider: ModelProvider
  apiKeyFingerprint?: string
}

export interface ModelProviderSnapshotSource {
  acquire(providerId: ModelProviderId): Promise<ModelProviderSnapshot>
}

export interface ModelCredentialPort {
  get(): Promise<string | undefined>
}

type FetchPort = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
type SleepPort = (milliseconds: number, signal: AbortSignal | undefined) => Promise<void>

export interface OpenAiCompatibleProviderConfig {
  chatEndpoint: string
  modelsEndpoint: string
  parseModels(value: unknown): ModelInfo[]
  optionalModelCatalogs?: ReadonlyArray<{
    endpoint: string
    parse(value: unknown): ModelInfo[]
  }>
  mergeModels?(general: ModelInfo[], optional: ModelInfo[][]): ModelInfo[]
  includeUsageStreamOption: boolean
  supportsMediaInput: boolean
  supportsAudioOutput: boolean
  serializeEndUser?: (id: string) => string
}

export interface OpenAiCompatibleProviderDependencies {
  credential: ModelCredentialPort
  fetch?: FetchPort
  sleep?: SleepPort
  random?: () => number
  diagnostic?: (diagnostic: {
    operation: ProviderOperation
    status?: number
    code?: string | number
    error_type?: string
  }) => void
}

export type ProviderOperation = 'models' | 'chat' | 'image' | 'video' | 'generation'
type RetryPolicy = 'never' | 'idempotent'
interface AuthenticatedFetchOptions {
  retry: RetryPolicy
}

const providerErrorSchema = z.object({
  code: z.union([z.string(), z.number()]).optional(),
  message: z.string().optional(),
  error_type: z.string().optional(),
  metadata: z.object({ error_type: z.string().optional() }).passthrough().optional(),
}).passthrough()

const modelResponseSchema = z.object({
  data: z.array(z.unknown()).max(MAX_MODELS),
}).passthrough()

const boundedModelIdSchema = z.string()
  .min(1)
  .max(MAX_MODEL_ID_LENGTH)
  .refine((value) => value === value.trim())
const boundedModelNameSchema = z.string().trim().min(1).max(MAX_MODEL_NAME_LENGTH)
const boundedCapabilityValueSchema = z.string().trim().min(1).max(MAX_CAPABILITY_VALUE_LENGTH)
const modelModalitySchema = z.enum(['text', 'image', 'audio', 'video'])
const capabilityDescriptorSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('enum'),
    values: z.array(z.union([
      boundedCapabilityValueSchema,
      z.number().safe(),
      z.boolean(),
    ])).max(MAX_CAPABILITY_VALUES),
  }).passthrough(),
  z.object({
    type: z.literal('range'),
    min: z.number().safe(),
    max: z.number().safe(),
  }).passthrough(),
  z.object({ type: z.literal('boolean') }).passthrough(),
])
const generalModelSchema = z.object({
  id: boundedModelIdSchema,
  name: boundedModelNameSchema,
  supported_parameters: z.array(boundedCapabilityValueSchema).max(MAX_MODEL_PARAMETERS).optional(),
  architecture: z.object({
    input_modalities: z.array(z.unknown()).max(MAX_MODALITIES).optional(),
    output_modalities: z.array(z.unknown()).max(MAX_MODALITIES).optional(),
  }).passthrough().optional(),
  context_length: z.number().int().nonnegative().safe().optional(),
  pricing: z.object({
    prompt: z.string().max(64).optional(),
    completion: z.string().max(64).optional(),
  }).passthrough().optional(),
}).passthrough()

const imageCapabilityModelSchema = z.object({
  id: boundedModelIdSchema,
  name: boundedModelNameSchema,
  architecture: z.object({
    input_modalities: z.array(z.unknown()).max(MAX_MODALITIES).optional(),
    output_modalities: z.array(z.unknown()).max(MAX_MODALITIES).optional(),
  }).passthrough().optional(),
  supported_parameters: z.object({
    resolution: z.unknown().optional(),
    aspect_ratio: z.unknown().optional(),
    output_format: z.unknown().optional(),
    n: z.unknown().optional(),
  }).passthrough().optional(),
}).passthrough()

const videoCapabilityModelSchema = z.object({
  id: boundedModelIdSchema,
  name: boundedModelNameSchema,
  supported_resolutions: z.array(z.unknown()).max(MAX_CAPABILITY_VALUES).nullish(),
  supported_aspect_ratios: z.array(z.unknown()).max(MAX_CAPABILITY_VALUES).nullish(),
  supported_durations: z.array(z.unknown()).max(MAX_CAPABILITY_VALUES).nullish(),
  supported_frame_images: z.array(z.unknown()).max(MAX_CAPABILITY_VALUES).nullish(),
  generate_audio: z.boolean().nullish(),
}).passthrough()

const modelContentPartSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string(),
  }).strict(),
  z.object({
    type: z.literal('media'),
    kind: z.enum(['image', 'audio', 'video']),
    mimeType: z.string().min(1),
    dataBase64: z.string(),
  }).strict(),
])

const streamChunkSchema = z.object({
  id: z.string().optional(),
  choices: z.array(z.object({
    index: z.number().int().nonnegative(),
    delta: z.object({
      content: z.string().nullable().optional(),
      audio: z.object({
        data: z.string().min(1),
        transcript: z.string().optional(),
      }).passthrough().optional(),
      tool_calls: z.array(z.object({
        index: z.number().int().nonnegative(),
        id: z.string().optional(),
        function: z.object({ name: z.string().optional(), arguments: z.string().optional() }).passthrough().optional(),
      }).passthrough()).optional(),
    }).passthrough().optional().default({}),
    finish_reason: z.string().nullable().optional(),
    error: providerErrorSchema.optional(),
  }).passthrough()).optional().default([]),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
    cost: z.union([z.number(), z.string()]).refine((value) => Number.isFinite(Number(value)) && Number(value) >= 0).optional(),
  }).passthrough().nullable().optional(),
  error: providerErrorSchema.optional(),
}).passthrough()

class RetryableFailure extends Error {
  constructor(readonly retryAfterMs?: number, readonly cause?: unknown) {
    super('Retryable model provider request failure')
  }
}

function failure(code: AppError['code']): AppError {
  return toSafeAppError({ code })
}

export async function readCredentialSnapshot(
  read: () => Promise<string | undefined>,
): Promise<string> {
  try {
    const value = await read()
    if (!value) throw failure('CREDENTIAL_UNAVAILABLE')
    return value
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error) throw error
    throw failure('CREDENTIAL_UNAVAILABLE')
  }
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError')
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(failure('CANCELLED'))
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(failure('CANCELLED'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function retryAfter(response: Response): number | undefined {
  const value = response.headers.get('retry-after')?.trim()
  if (!value) return undefined
  const seconds = Number(value)
  const milliseconds = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(value) - Date.now()
  if (!Number.isFinite(milliseconds)) return undefined
  return Math.max(0, Math.min(MAX_RETRY_AFTER_MS, milliseconds))
}

async function readResponseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read()
  if (signal.aborted) throw failure('CANCELLED')
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(failure('CANCELLED'))
    signal.addEventListener('abort', onAbort, { once: true })
    reader.read().then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
}

async function boundedResponseText(response: Response, signal?: AbortSignal): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let output = ''
  try {
    while (total < MAX_DIAGNOSTIC_BODY) {
      const chunk = await readResponseChunk(reader, signal)
      if (chunk.done) break
      const remaining = MAX_DIAGNOSTIC_BODY - total
      const value = chunk.value.byteLength > remaining ? chunk.value.subarray(0, remaining) : chunk.value
      total += value.byteLength
      output += decoder.decode(value, { stream: total < MAX_DIAGNOSTIC_BODY })
      if (chunk.value.byteLength > remaining) break
    }
    output += decoder.decode()
    return output
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

async function boundedResponseJson(
  response: Response,
  maximumBytes = MAX_MODEL_CATALOG_BODY,
  signal?: AbortSignal,
): Promise<unknown> {
  const cancelBody = async () => response.body?.cancel().catch(() => undefined)
  if (signal?.aborted) {
    await cancelBody()
    throw failure('CANCELLED')
  }
  const declaredLength = response.headers.get('content-length')
  if (declaredLength && Number(declaredLength) > maximumBytes) {
    await cancelBody()
    throw new Error('Model provider response exceeded the size limit')
  }
  if (!response.body) throw new Error('Model provider response had no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let output = ''
  try {
    while (true) {
      if (signal?.aborted) throw failure('CANCELLED')
      const chunk = await readResponseChunk(reader, signal)
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > maximumBytes) throw new Error('Model provider response exceeded the size limit')
      output += decoder.decode(chunk.value, { stream: true })
    }
    output += decoder.decode()
    if (signal?.aborted) throw failure('CANCELLED')
    return JSON.parse(output) as unknown
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

type ProviderError = z.infer<typeof providerErrorSchema>

function safeMetadataValue(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.length <= 64 && /^[a-z0-9_.-]+$/i.test(value)) return value
  return undefined
}

function providerErrorMetadata(error: ProviderError | undefined): { code?: string | number; error_type?: string } {
  const code = safeMetadataValue(error?.code)
  const errorTypeValue = safeMetadataValue(error?.metadata?.error_type ?? error?.error_type)
  return {
    ...(code === undefined ? {} : { code }),
    ...(typeof errorTypeValue === 'string' ? { error_type: errorTypeValue } : {}),
  }
}

function numericProviderCode(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && /^\d{3}$/.test(value)) return Number(value)
  return undefined
}

function streamedFailure(error: ProviderError | undefined): RetryableFailure | AppError {
  const code = numericProviderCode(error?.code)
  const errorType = String(error?.metadata?.error_type ?? error?.error_type ?? '').toLowerCase()
  if (code === 401) return failure('CREDENTIAL_INVALID')
  if (code === 403) return failure('MODEL_PROVIDER_ACCESS_DENIED')
  if (code === 429 || (code !== undefined && code >= 500)) return new RetryableFailure()
  if (/network|connection|timeout|upstream|unavailable/.test(errorType)) return new RetryableFailure()
  return failure('MODEL_PROVIDER_REQUEST_FAILED')
}

function millionPrice(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed * 1_000_000 : undefined
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sortedUniqueStrings(values: unknown[] | undefined): string[] {
  const valid = values?.flatMap((value) => {
    const parsed = boundedCapabilityValueSchema.safeParse(value)
    return parsed.success ? [parsed.data] : []
  }) ?? []
  return [...new Set(valid)].sort(compareStrings).slice(0, MAX_CAPABILITY_VALUES)
}

function sortedUniquePositiveIntegers(values: unknown[] | null | undefined): number[] {
  const valid = values?.filter((value): value is number => (
    typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0
  )) ?? []
  return [...new Set(valid)].sort((left, right) => left - right).slice(0, MAX_CAPABILITY_VALUES)
}

function sortedModalities(values: unknown[] | undefined): Array<'text' | 'image' | 'audio' | 'video'> {
  const order = ['text', 'image', 'audio', 'video'] as const
  const included = new Set(values?.flatMap((value) => {
    const parsed = modelModalitySchema.safeParse(value)
    return parsed.success ? [parsed.data] : []
  }) ?? [])
  return order.filter((modality) => included.has(modality))
}

function mergeModalities(
  ...values: Array<ReadonlyArray<'text' | 'image' | 'audio' | 'video'>>
): Array<'text' | 'image' | 'audio' | 'video'> {
  return sortedModalities(values.flat())
}

function videoFrameTypes(values: readonly unknown[] | undefined): VideoFrameType[] {
  const present = new Set(values?.filter(
    (value): value is VideoFrameType => VIDEO_FRAME_TYPES.includes(value as VideoFrameType),
  ))
  return VIDEO_FRAME_TYPES.filter((value) => present.has(value))
}

function generationForOutputs(outputModalities: ModelInfo['outputModalities']): ModelInfo['generation'] {
  return {
    ...(outputModalities.includes('image')
      ? { image: { resolutions: [], aspectRatios: [], formats: [], maxCount: 1 } }
      : {}),
    ...(outputModalities.includes('audio')
      ? { audio: { voices: [], formats: [] } }
      : {}),
    ...(outputModalities.includes('video')
      ? { video: { resolutions: [], aspectRatios: [], durations: [], supportsAudio: false, frameImages: [] } }
      : {}),
  }
}

export function parseOpenRouterModels(value: unknown): ModelInfo[] {
  const parsed = modelResponseSchema.parse(value)
  const byId = new Map<string, ModelInfo>()
  for (const entry of parsed.data) {
    const result = generalModelSchema.safeParse(entry)
    if (!result.success) continue
    const model = result.data
    const inputModalities = sortedModalities(model.architecture?.input_modalities)
    const outputModalities = sortedModalities(model.architecture?.output_modalities)
    const existing = byId.get(model.id)
    if (existing) {
      const mergedOutputs = mergeModalities(existing.outputModalities, outputModalities)
      byId.set(model.id, {
        ...existing,
        inputModalities: mergeModalities(existing.inputModalities, inputModalities),
        outputModalities: mergedOutputs,
        supportsTools: existing.supportsTools || model.supported_parameters?.includes('tools') === true,
        generation: generationForOutputs(mergedOutputs),
      })
      continue
    }
    const inputCostPerMillion = millionPrice(model.pricing?.prompt)
    const outputCostPerMillion = millionPrice(model.pricing?.completion)
    byId.set(model.id, {
      id: model.id,
      name: model.name,
      ...(model.context_length === undefined || model.context_length === 0
        ? {}
        : { contextLength: model.context_length }),
      ...(inputCostPerMillion === undefined ? {} : { inputCostPerMillion }),
      ...(outputCostPerMillion === undefined ? {} : { outputCostPerMillion }),
      inputModalities,
      outputModalities,
      supportsTools: model.supported_parameters?.includes('tools') === true,
      generation: generationForOutputs(outputModalities),
    })
  }
  return [...byId.values()].sort((left, right) => compareStrings(left.id, right.id))
}

function enumDescriptorValues(value: unknown): string[] {
  const parsed = capabilityDescriptorSchema.safeParse(value)
  return parsed.success && parsed.data.type === 'enum'
    ? sortedUniqueStrings(parsed.data.values)
    : []
}

function maxImageCount(value: unknown): number {
  const parsed = capabilityDescriptorSchema.safeParse(value)
  if (!parsed.success) return 1
  if (
    parsed.data.type === 'range'
    && Number.isSafeInteger(parsed.data.min)
    && Number.isSafeInteger(parsed.data.max)
    && parsed.data.min > 0
    && parsed.data.max >= parsed.data.min
    && parsed.data.min <= MAX_IMAGE_COUNT
  ) return Math.min(parsed.data.max, MAX_IMAGE_COUNT)
  if (parsed.data.type !== 'enum') return 1
  const values = parsed.data.values.flatMap((candidate) => (
    typeof candidate === 'number'
    && Number.isSafeInteger(candidate)
    && candidate > 0
    && candidate <= MAX_IMAGE_COUNT
      ? [candidate]
      : []
  ))
  return values.length ? Math.max(...values) : 1
}

export function parseOpenRouterImageModels(value: unknown): ModelInfo[] {
  const parsed = modelResponseSchema.parse(value)
  const byId = new Map<string, ModelInfo>()
  for (const entry of parsed.data) {
    const result = imageCapabilityModelSchema.safeParse(entry)
    if (!result.success) continue
    const model = result.data
    const inputModalities = sortedModalities(model.architecture?.input_modalities)
    const outputModalities = mergeModalities(
      sortedModalities(model.architecture?.output_modalities),
      ['image'],
    )
    const candidate: ModelInfo = {
      id: model.id,
      name: model.name,
      inputModalities,
      outputModalities,
      supportsTools: false,
      generation: {
        image: {
          resolutions: enumDescriptorValues(model.supported_parameters?.resolution),
          aspectRatios: enumDescriptorValues(model.supported_parameters?.aspect_ratio),
          formats: enumDescriptorValues(model.supported_parameters?.output_format),
          maxCount: maxImageCount(model.supported_parameters?.n),
        },
      },
    }
    const existing = byId.get(model.id)
    if (!existing) {
      byId.set(model.id, candidate)
      continue
    }
    const existingImage = existing.generation.image!
    const candidateImage = candidate.generation.image!
    byId.set(model.id, {
      ...existing,
      name: compareStrings(existing.name, candidate.name) <= 0 ? existing.name : candidate.name,
      inputModalities: mergeModalities(existing.inputModalities, candidate.inputModalities),
      outputModalities: mergeModalities(existing.outputModalities, candidate.outputModalities),
      generation: {
        image: {
          resolutions: sortedUniqueStrings([...existingImage.resolutions, ...candidateImage.resolutions]),
          aspectRatios: sortedUniqueStrings([...existingImage.aspectRatios, ...candidateImage.aspectRatios]),
          formats: sortedUniqueStrings([...existingImage.formats, ...candidateImage.formats]),
          maxCount: Math.min(MAX_IMAGE_COUNT, Math.max(existingImage.maxCount, candidateImage.maxCount)),
        },
      },
    })
  }
  return [...byId.values()].sort((left, right) => compareStrings(left.id, right.id))
}

const OPENROUTER_VIDEO_REFERENCE_IMAGE_LIMITS = new Map<string, number>([
  ['openai/sora-2-pro', 1],
])

export function parseOpenRouterVideoModels(value: unknown): ModelInfo[] {
  const parsed = modelResponseSchema.parse(value)
  const byId = new Map<string, ModelInfo>()
  for (const entry of parsed.data) {
    const result = videoCapabilityModelSchema.safeParse(entry)
    if (!result.success) continue
    const model = result.data
    const frameImages = videoFrameTypes(model.supported_frame_images ?? undefined)
    const maxReferenceImages = OPENROUTER_VIDEO_REFERENCE_IMAGE_LIMITS.get(model.id)
    const supportsImageInput = frameImages.length > 0 || maxReferenceImages !== undefined
    const candidate: ModelInfo = {
      id: model.id,
      name: model.name,
      inputModalities: supportsImageInput ? ['text', 'image'] : ['text'],
      outputModalities: ['video'],
      supportsTools: false,
      generation: {
        video: {
          resolutions: sortedUniqueStrings(model.supported_resolutions ?? undefined),
          aspectRatios: sortedUniqueStrings(model.supported_aspect_ratios ?? undefined),
          durations: sortedUniquePositiveIntegers(model.supported_durations),
          supportsAudio: model.generate_audio === true,
          frameImages,
          ...(maxReferenceImages === undefined ? {} : { maxReferenceImages }),
        },
      },
    }
    const existing = byId.get(model.id)
    if (!existing) {
      byId.set(model.id, candidate)
      continue
    }
    const existingVideo = existing.generation.video!
    const candidateVideo = candidate.generation.video!
    const mergedMaxReferenceImages = Math.max(
      existingVideo.maxReferenceImages ?? 0,
      candidateVideo.maxReferenceImages ?? 0,
    )
    byId.set(model.id, {
      ...existing,
      name: compareStrings(existing.name, candidate.name) <= 0 ? existing.name : candidate.name,
      inputModalities: mergeModalities(existing.inputModalities, candidate.inputModalities),
      outputModalities: mergeModalities(existing.outputModalities, candidate.outputModalities),
      generation: {
        video: {
          resolutions: sortedUniqueStrings([...existingVideo.resolutions, ...candidateVideo.resolutions]),
          aspectRatios: sortedUniqueStrings([...existingVideo.aspectRatios, ...candidateVideo.aspectRatios]),
          durations: sortedUniquePositiveIntegers([...existingVideo.durations, ...candidateVideo.durations]),
          supportsAudio: existingVideo.supportsAudio || candidateVideo.supportsAudio,
          frameImages: videoFrameTypes([...existingVideo.frameImages, ...candidateVideo.frameImages]),
          ...(mergedMaxReferenceImages === 0
            ? {}
            : { maxReferenceImages: mergedMaxReferenceImages }),
        },
      },
    })
  }
  return [...byId.values()].sort((left, right) => compareStrings(left.id, right.id))
}

export function mergeOpenRouterModels(general: ModelInfo[], optional: ModelInfo[][]): ModelInfo[] {
  const byId = new Map(general.map((model) => [model.id, model]))
  for (const catalog of optional) {
    for (const dedicated of catalog) {
      const base = byId.get(dedicated.id)
      if (!base) {
        byId.set(dedicated.id, dedicated)
        continue
      }
      byId.set(base.id, {
        ...base,
        inputModalities: mergeModalities(base.inputModalities, dedicated.inputModalities),
        outputModalities: mergeModalities(base.outputModalities, dedicated.outputModalities),
        generation: {
          ...base.generation,
          ...dedicated.generation,
        },
      })
    }
  }
  return [...byId.values()].sort((left, right) => compareStrings(left.id, right.id))
}

interface ToolAccumulator {
  id: string
  name: string
  arguments: string
}

interface ReplayState {
  text: Map<number, string>
  audio: Map<number, Array<{ dataBase64: string; transcript?: string }>>
  generations: Set<string>
  tools: Set<string>
  finishes: Set<string>
  usages: Set<string>
}

const IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/svg+xml',
])
const AUDIO_FORMAT_BY_MIME = new Map([
  ['audio/mpeg', 'mp3'],
  ['audio/wav', 'wav'],
  ['audio/ogg', 'ogg'],
  ['audio/flac', 'flac'],
  ['audio/mp4', 'm4a'],
])
const VIDEO_MIME_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/webm',
])

function assertSupportedRequest(request: ModelStreamRequest, config: OpenAiCompatibleProviderConfig): void {
  if (request.output?.type === 'audio' && !config.supportsAudioOutput) {
    throw failure('MODEL_MODALITY_UNSUPPORTED')
  }
  for (const message of request.messages) {
    if (message.role === 'assistant') {
      if (typeof message.content !== 'string' && message.content !== null) throw failure('INVALID_INPUT')
      continue
    }
    if (message.role === 'tool') {
      if (typeof message.content !== 'string') throw failure('INVALID_INPUT')
      continue
    }
    if (typeof message.content === 'string') continue
    if (!Array.isArray(message.content)) throw failure('INVALID_INPUT')
    const parsed = modelContentPartSchema.array().safeParse(message.content)
    if (!parsed.success) throw failure('INVALID_INPUT')
    for (const part of parsed.data) {
      if (part.type === 'text') continue
      if (!config.supportsMediaInput) throw failure('MODEL_MODALITY_UNSUPPORTED')
      const compatible = part.kind === 'image'
        ? IMAGE_MIME_TYPES.has(part.mimeType)
        : part.kind === 'audio'
          ? AUDIO_FORMAT_BY_MIME.has(part.mimeType)
          : VIDEO_MIME_TYPES.has(part.mimeType)
      if (!compatible) throw failure('MODEL_MODALITY_UNSUPPORTED')
    }
  }
}

function wireContentPart(part: ModelContentPart): unknown {
  switch (part.type) {
    case 'text':
      return part
    case 'media':
      switch (part.kind) {
        case 'image':
          if (!IMAGE_MIME_TYPES.has(part.mimeType)) throw failure('MODEL_MODALITY_UNSUPPORTED')
          return { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.dataBase64}` } }
        case 'audio': {
          const format = AUDIO_FORMAT_BY_MIME.get(part.mimeType)
          if (!format) throw failure('MODEL_MODALITY_UNSUPPORTED')
          return {
            type: 'input_audio',
            input_audio: { data: part.dataBase64, format },
          }
        }
        case 'video':
          if (!VIDEO_MIME_TYPES.has(part.mimeType)) throw failure('MODEL_MODALITY_UNSUPPORTED')
          return { type: 'video_url', video_url: { url: `data:${part.mimeType};base64,${part.dataBase64}` } }
      }
      throw failure('INVALID_INPUT')
    }
  throw failure('INVALID_INPUT')
}

function wireMessages(messages: ModelMessage[]): unknown[] {
  return messages.map((message) => (
    'content' in message && Array.isArray(message.content)
      ? { ...message, content: message.content.map(wireContentPart) }
      : message
  ))
}

export class OpenAiCompatibleProvider implements ModelProvider {
  protected readonly fetch: FetchPort
  private readonly sleep: SleepPort
  private readonly random: () => number

  constructor(
    private readonly config: OpenAiCompatibleProviderConfig,
    private readonly dependencies: OpenAiCompatibleProviderDependencies,
  ) {
    this.fetch = dependencies.fetch ?? globalThis.fetch
    this.sleep = dependencies.sleep ?? defaultSleep
    this.random = dependencies.random ?? Math.random
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const { response } = await this.fetchModels(signal)
    if (!response.ok) await this.throwHttpFailure('models', response, signal)
    let general: ModelInfo[]
    try {
      general = this.config.parseModels(await boundedResponseJson(
        response,
        MAX_MODEL_CATALOG_BODY,
        signal,
      ))
    } catch (error) {
      if (isAbort(error, signal)) throw failure('CANCELLED')
      throw failure('MODEL_PROVIDER_REQUEST_FAILED')
    }
    if (!this.config.optionalModelCatalogs?.length) return general
    const results = await Promise.allSettled(this.config.optionalModelCatalogs.map(async (catalog) => {
      const { response: optionalResponse } = await this.fetchModels(signal, catalog.endpoint)
      if (!optionalResponse.ok) await this.throwHttpFailure('models', optionalResponse, signal)
      return catalog.parse(await boundedResponseJson(
        optionalResponse,
        MAX_MODEL_CATALOG_BODY,
        signal,
      ))
    }))
    if (signal?.aborted) throw failure('CANCELLED')
    const optional = results.flatMap((result) => {
      if (result.status === 'fulfilled') return [result.value]
      this.reportModelDiscoveryFailure()
      return []
    })
    return this.config.mergeModels?.(general, optional) ?? general
  }

  async validateCredential(signal?: AbortSignal): Promise<{ valid: boolean }> {
    try {
      const { response } = await this.fetchModels(signal)
      if (response.status === 401) return { valid: false }
      if (!response.ok) await this.throwHttpFailure('models', response, signal)
      this.config.parseModels(await boundedResponseJson(
        response,
        MAX_MODEL_CATALOG_BODY,
        signal,
      ))
      return { valid: true }
    } catch (error) {
      if (isAbort(error, signal)) throw failure('CANCELLED')
      if (typeof error === 'object' && error !== null && 'code' in error) throw error
      throw failure('MODEL_PROVIDER_REQUEST_FAILED')
    }
  }

  async *stream(request: ModelStreamRequest): AsyncGenerator<ModelStreamEvent> {
    assertSupportedRequest(request, this.config)
    const replay: ReplayState = {
      text: new Map(), audio: new Map(), generations: new Set(), tools: new Set(), finishes: new Set(), usages: new Set(),
    }
    const maxAttempts = request.output?.type === 'audio' ? 1 : MAX_ATTEMPTS
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const secret = await this.secret()
        let response: Response
        let body: string | undefined
        let messages: unknown[] | undefined
        try {
          messages = wireMessages(request.messages)
          body = JSON.stringify({
            model: request.model,
            messages,
            ...(request.endUserId === undefined || this.config.serializeEndUser === undefined
              ? {}
              : { user: this.config.serializeEndUser(request.endUserId) }),
            ...(request.tools?.length ? { tools: request.tools } : {}),
            ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
            stream: true,
            ...(this.config.includeUsageStreamOption ? { stream_options: { include_usage: true } } : {}),
            ...(request.output?.type === 'audio'
              ? {
                  modalities: ['text', 'audio'],
                  audio: {
                    ...(request.output.voice === undefined ? {} : { voice: request.output.voice }),
                    format: request.output.format,
                  },
                }
              : {}),
          })
          response = await this.fetch(this.config.chatEndpoint, {
            method: 'POST',
            headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
            body,
            signal: request.signal,
          })
        } catch (error) {
          if (isAbort(error, request.signal)) throw failure('CANCELLED')
          if (error instanceof TypeError) throw new RetryableFailure(undefined, error)
          throw failure('MODEL_PROVIDER_REQUEST_FAILED')
        } finally {
          body = undefined
          messages = undefined
        }
        if (response.status === 429 || response.status >= 500) {
          await this.readDiagnostic('chat', response, request.signal)
          throw new RetryableFailure(retryAfter(response))
        }
        if (!response.ok) await this.throwHttpFailure('chat', response, request.signal)

        try {
          yield* this.parseStream(response, replay, request.signal)
          return
        } catch (error) {
          if (isAbort(error, request.signal)) throw failure('CANCELLED')
          if (error instanceof TypeError) throw new RetryableFailure(undefined, error)
          if (error instanceof RetryableFailure) throw error
          if (typeof error === 'object' && error !== null && 'code' in error) {
            const safe = toSafeAppError(error)
            if (safe.code !== 'INTERNAL_ERROR' || error.code === 'INTERNAL_ERROR') throw safe
          }
          throw failure('MODEL_PROVIDER_REQUEST_FAILED')
        }
      } catch (error) {
        if (
          error instanceof RetryableFailure
          && (replay.generations.size > 0 || replay.usages.size > 0)
        ) throw failure('MODEL_PROVIDER_REQUEST_FAILED')
        if (!(error instanceof RetryableFailure) || attempt === maxAttempts - 1) {
          if (error instanceof RetryableFailure) throw failure('MODEL_PROVIDER_REQUEST_FAILED')
          throw error
        }
        const base = 200 * (2 ** attempt)
        const delay = error.retryAfterMs ?? Math.min(MAX_RETRY_AFTER_MS, base * (1 + this.random() * 0.25))
        try {
          await this.sleep(delay, request.signal)
        } catch (sleepError) {
          if (isAbort(sleepError, request.signal) || request.signal?.aborted) throw failure('CANCELLED')
          throw failure('MODEL_PROVIDER_REQUEST_FAILED')
        }
      }
    }
  }

  private async fetchModels(
    signal?: AbortSignal,
    endpoint = this.config.modelsEndpoint,
  ): Promise<{ response: Response; secret: string }> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const secret = await this.secret()
      let response: Response
      try {
        response = await this.fetch(endpoint, { headers: { authorization: `Bearer ${secret}` }, signal })
      } catch (error) {
        if (isAbort(error, signal)) throw failure('CANCELLED')
        if (!(error instanceof TypeError) || attempt === MAX_ATTEMPTS - 1) throw failure('MODEL_PROVIDER_REQUEST_FAILED')
        await this.retryDelay(attempt, undefined, signal)
        continue
      }
      if (response.status !== 429 && response.status < 500) return { response, secret }
      await this.readDiagnostic('models', response, signal)
      if (attempt === MAX_ATTEMPTS - 1) throw failure('MODEL_PROVIDER_REQUEST_FAILED')
      await this.retryDelay(attempt, retryAfter(response), signal)
    }
    throw failure('MODEL_PROVIDER_REQUEST_FAILED')
  }

  private async retryDelay(attempt: number, requested: number | undefined, signal?: AbortSignal): Promise<void> {
    const base = 200 * (2 ** attempt)
    const delay = requested ?? Math.min(MAX_RETRY_AFTER_MS, base * (1 + this.random() * 0.25))
    try {
      await this.sleep(delay, signal)
    } catch (error) {
      if (isAbort(error, signal) || signal?.aborted) throw failure('CANCELLED')
      throw failure('MODEL_PROVIDER_REQUEST_FAILED')
    }
  }

  protected async authenticatedFetch(
    endpoint: string,
    operation: ProviderOperation,
    signal: AbortSignal | undefined,
    request: () => RequestInit,
    options: AuthenticatedFetchOptions,
  ): Promise<Response> {
    if (signal?.aborted) throw failure('CANCELLED')
    const maxAttempts = options.retry === 'idempotent' ? MAX_ATTEMPTS : 1
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (signal?.aborted) throw failure('CANCELLED')
      const secret = await this.secret()
      if (signal?.aborted) throw failure('CANCELLED')
      let init: RequestInit | undefined
      let response: Response
      try {
        init = request()
        const headers = new Headers(init.headers)
        headers.set('authorization', `Bearer ${secret}`)
        init.headers = Object.fromEntries(headers.entries())
        init.signal = signal
        response = await this.fetch(endpoint, init)
      } catch (error) {
        if (isAbort(error, signal)) throw failure('CANCELLED')
        if (!(error instanceof TypeError) || attempt === maxAttempts - 1) {
          throw failure('MODEL_PROVIDER_REQUEST_FAILED')
        }
        await this.retryDelay(attempt, undefined, signal)
        continue
      } finally {
        if (init) init.body = undefined
        init = undefined
      }
      if (response.status !== 429 && response.status < 500) {
        if (!response.ok) await this.throwHttpFailure(operation, response, signal)
        return response
      }
      await this.readDiagnostic(operation, response, signal)
      if (attempt === maxAttempts - 1) throw failure('MODEL_PROVIDER_REQUEST_FAILED')
      await this.retryDelay(attempt, retryAfter(response), signal)
    }
    throw failure('MODEL_PROVIDER_REQUEST_FAILED')
  }

  protected async boundedJson(
    response: Response,
    maximumBytes: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    try {
      return await boundedResponseJson(response, maximumBytes, signal)
    } catch (error) {
      if (isAbort(error, signal)) throw failure('CANCELLED')
      throw failure('MODEL_PROVIDER_REQUEST_FAILED')
    }
  }

  private async secret(): Promise<string> {
    try {
      const value = await this.dependencies.credential.get()
      if (!value) throw failure('CREDENTIAL_UNAVAILABLE')
      return value
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error) throw error
      throw failure('CREDENTIAL_UNAVAILABLE')
    }
  }

  private async throwHttpFailure(
    operation: ProviderOperation,
    response: Response,
    signal?: AbortSignal,
  ): Promise<never> {
    await this.readDiagnostic(operation, response, signal)
    if (signal?.aborted) throw failure('CANCELLED')
    if (response.status === 401) throw failure('CREDENTIAL_INVALID')
    if (response.status === 403) throw failure('MODEL_PROVIDER_ACCESS_DENIED')
    throw failure('MODEL_PROVIDER_REQUEST_FAILED')
  }

  private async readDiagnostic(
    operation: ProviderOperation,
    response: Response,
    signal?: AbortSignal,
  ): Promise<void> {
    let metadata: { code?: string | number; error_type?: string } = {}
    try {
      const parsed = JSON.parse(await boundedResponseText(response, signal)) as unknown
      const envelope = z.object({ error: providerErrorSchema.optional() }).strict().safeParse(parsed)
      const direct = providerErrorSchema.safeParse(parsed)
      metadata = providerErrorMetadata(envelope.success && envelope.data.error
        ? envelope.data.error
        : direct.success ? direct.data : undefined)
    } catch (error) {
      if (isAbort(error, signal)) throw failure('CANCELLED')
      // The body is deliberately drained but never forwarded to diagnostics.
    }
    if (!this.dependencies.diagnostic) return
    try { this.dependencies.diagnostic({ operation, status: response.status, ...metadata }) } catch { /* diagnostics are observational */ }
  }

  private reportModelDiscoveryFailure(): void {
    if (!this.dependencies.diagnostic) return
    try { this.dependencies.diagnostic({ operation: 'models' }) } catch { /* diagnostics are observational */ }
  }

  private async *parseStream(response: Response, replay: ReplayState, signal?: AbortSignal): AsyncGenerator<ModelStreamEvent> {
    if (!response.body) throw failure('MODEL_PROVIDER_REQUEST_FAILED')
    const pending: ModelStreamEvent[] = []
    const attemptText = new Map<number, string>()
    const attemptAudio = new Map<number, Array<{ dataBase64: string; transcript?: string }>>()
    const tools = new Map<string, ToolAccumulator>()
    let parserError: unknown
    let done = false
    let explicitTerminal = false
    const parser = createParser({
      maxBufferSize: 1024 * 1024,
      onError(error) { parserError = error },
      onEvent: ({ data }) => {
        if (data === '[DONE]') { done = true; return }
        let chunk: z.infer<typeof streamChunkSchema>
        try { chunk = streamChunkSchema.parse(JSON.parse(data)) } catch (error) { parserError = error; return }
        const failedChoice = chunk.choices.find((choice) => (
          choice.finish_reason === 'error' || choice.error !== undefined
        ))
        const hasFrameError = chunk.error !== undefined || failedChoice !== undefined
        if (hasFrameError) {
          const frameError = chunk.error ?? failedChoice?.error
          this.reportStreamDiagnostic(frameError)
          parserError = streamedFailure(frameError)
        }
        if (chunk.id && !replay.generations.has(chunk.id)) {
          replay.generations.add(chunk.id)
          pending.push({ type: 'generation', id: chunk.id })
        }
        for (const choice of hasFrameError ? [] : chunk.choices) {
          const content = choice.delta.content ?? ''
          if (content) {
            const cumulative = `${attemptText.get(choice.index) ?? ''}${content}`
            attemptText.set(choice.index, cumulative)
            const delivered = replay.text.get(choice.index) ?? ''
            if (!delivered.startsWith(cumulative) && !cumulative.startsWith(delivered)) {
              parserError = new Error('Model provider retry replay diverged')
              return
            }
            if (cumulative.length > delivered.length) {
              const suffix = cumulative.slice(delivered.length)
              replay.text.set(choice.index, cumulative)
              pending.push({ type: 'text_delta', choiceIndex: choice.index, text: suffix })
            }
          }
          if (choice.delta.audio) {
            const audio = {
              dataBase64: choice.delta.audio.data,
              ...(choice.delta.audio.transcript === undefined ? {} : { transcript: choice.delta.audio.transcript }),
            }
            const attemptChunks = attemptAudio.get(choice.index) ?? []
            attemptChunks.push(audio)
            attemptAudio.set(choice.index, attemptChunks)
            const delivered = replay.audio.get(choice.index) ?? []
            const chunkIndex = attemptChunks.length - 1
            const previous = delivered[chunkIndex]
            if (previous && (previous.dataBase64 !== audio.dataBase64 || previous.transcript !== audio.transcript)) {
              parserError = new Error('Model provider retry replay diverged')
              return
            }
            if (!previous) {
              delivered.push(audio)
              replay.audio.set(choice.index, delivered)
              pending.push({ type: 'audio_delta', choiceIndex: choice.index, ...audio })
            }
          }
          for (const fragment of choice.delta.tool_calls ?? []) {
            const key = `${choice.index}:${fragment.index}`
            const accumulated = tools.get(key) ?? { id: '', name: '', arguments: '' }
            accumulated.id += fragment.id ?? ''
            accumulated.name += fragment.function?.name ?? ''
            accumulated.arguments += fragment.function?.arguments ?? ''
            tools.set(key, accumulated)
          }
          if (choice.finish_reason) {
            if (choice.index === 0) explicitTerminal = true
            if (choice.finish_reason === 'tool_calls') {
              for (const [key, tool] of tools) {
                const [choiceIndexValue, toolIndexValue] = key.split(':')
                if (Number(choiceIndexValue) !== choice.index) continue
                let argumentsValue: unknown
                try { argumentsValue = JSON.parse(tool.arguments) } catch { parserError = new Error('Invalid tool arguments'); return }
                if (!tool.id || !tool.name) { parserError = new Error('Incomplete tool call'); return }
                const signature = JSON.stringify([choice.index, Number(toolIndexValue), tool.id, tool.name, argumentsValue])
                if (!replay.tools.has(signature)) {
                  replay.tools.add(signature)
                  pending.push({ type: 'tool_call', choiceIndex: choice.index, index: Number(toolIndexValue), id: tool.id, name: tool.name, arguments: argumentsValue })
                }
              }
            }
            const signature = `${choice.index}:${choice.finish_reason}`
            if (!replay.finishes.has(signature)) {
              replay.finishes.add(signature)
              pending.push({ type: 'finish', choiceIndex: choice.index, reason: choice.finish_reason })
            }
          }
        }
        if (chunk.usage) {
          const event: Extract<ModelStreamEvent, { type: 'usage' }> = {
            type: 'usage', inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens,
            totalTokens: chunk.usage.total_tokens,
            ...(chunk.usage.cost === undefined ? {} : { costUsd: String(chunk.usage.cost) }),
          }
          const signature = JSON.stringify(event)
          if (!replay.usages.has(signature)) { replay.usages.add(signature); pending.push(event) }
        }
      },
    })
    const decoder = new TextDecoder()
    const reader = response.body.getReader()
    let physicalEof = false
    try {
      while (!done) {
        if (signal?.aborted) throw failure('CANCELLED')
        const result = await reader.read()
        if (result.done) {
          physicalEof = true
          break
        }
        parser.feed(decoder.decode(result.value, { stream: true }))
        while (pending.length) yield pending.shift()!
        if (parserError) throw parserError
      }
      parser.feed(decoder.decode())
      parser.reset({ consume: true })
      while (pending.length) yield pending.shift()!
      if (parserError) throw parserError
      if (!done && !explicitTerminal) throw new RetryableFailure()
    } finally {
      if (!physicalEof) await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }

  private reportStreamDiagnostic(error: ProviderError | undefined): void {
    if (!this.dependencies.diagnostic) return
    try { this.dependencies.diagnostic({ operation: 'chat', ...providerErrorMetadata(error) }) } catch { /* diagnostics are observational */ }
  }
}
