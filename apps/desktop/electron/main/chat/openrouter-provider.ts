import { z } from 'zod'
import { toSafeAppError, type AppError, type VideoFrameType } from '@autoforge/shared'
import { normalizeUsd } from '../billing/decimal-usd.js'
import { fingerprintApiKey } from '../billing/provider-usage-reconciler.js'
import {
  mergeOpenRouterModels,
  OpenAiCompatibleProvider,
  parseOpenRouterImageModels,
  parseOpenRouterModels,
  parseOpenRouterVideoModels,
  readCredentialSnapshot,
  type ModelProviderSnapshot,
  type ModelImageRequest,
  type ModelImageResult,
  type ModelGenerationUsage,
  type ModelMessage,
  type ModelStreamEvent,
  type ModelStreamRequest,
  type ModelTool,
  type ModelVideoRequest,
  type ModelVideoStatus,
  type OpenAiCompatibleProviderDependencies,
} from './model-provider.js'

const CHAT_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'
const MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/models'
const IMAGE_MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/images/models'
const VIDEO_MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/videos/models'
const IMAGE_ENDPOINT = 'https://openrouter.ai/api/v1/images'
const VIDEO_ENDPOINT = 'https://openrouter.ai/api/v1/videos'
const GENERATION_ENDPOINT = 'https://openrouter.ai/api/v1/generation'
const MAX_MEDIA_JSON_BODY = 32 * 1024 * 1024
const MAX_REFERENCE_COUNT = 5
const MAX_IMAGE_BASE64_LENGTH = Math.ceil((20 * 1024 * 1024) / 3) * 4
const MAX_PROMPT_LENGTH = 1_000_000
const MAX_OPTION_LENGTH = 128

type ProviderFetch = NonNullable<OpenAiCompatibleProviderDependencies['fetch']>

function releaseUnauthorizedResponse(fetch: ProviderFetch): ProviderFetch {
  return async (input, init) => {
    const response = await fetch(input, init)
    if (response.status === 401 && !response.bodyUsed) {
      try {
        await response.body?.cancel()
      } catch {
        // The status remains authoritative when a transport cannot cancel its body.
      }
    }
    return response
  }
}

const imageMimeTypeSchema = z.enum([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/svg+xml',
])
const canonicalStringSchema = z.string()
  .min(1)
  .max(MAX_OPTION_LENGTH)
  .refine((value) => value === value.trim())
const canonicalBase64Schema = z.string()
  .min(1)
  .max(MAX_IMAGE_BASE64_LENGTH)
  .refine((value) => {
    if (
      value.length % 4 !== 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
    ) return false
    try {
      return Buffer.from(value, 'base64').toString('base64') === value
    } catch {
      return false
    }
  })
const imageReferenceSchema = z.object({
  mimeType: imageMimeTypeSchema,
  dataBase64: canonicalBase64Schema,
}).strict()
const abortSignalSchema = z.custom<AbortSignal>((value) => value instanceof AbortSignal)
const aspectRatioSchema = z.string()
  .min(1)
  .max(16)
  .refine((value) => value === 'auto' || /^[1-9]\d{0,2}:[1-9]\d{0,2}$/.test(value))
const formatSchema = z.string()
  .min(1)
  .max(32)
  .refine((value) => value === value.trim() && /^[a-z0-9][a-z0-9_-]*$/.test(value))
const modelSchema = z.string()
  .min(1)
  .max(256)
  .refine((value) => value === value.trim())
const promptSchema = z.string().min(1).max(MAX_PROMPT_LENGTH)
const imageRequestSchema = z.object({
  model: modelSchema,
  prompt: promptSchema,
  options: z.object({
    count: z.literal(1),
    resolution: canonicalStringSchema,
    aspectRatio: aspectRatioSchema,
    format: formatSchema,
  }).strict(),
  parameterSupport: z.object({
    resolution: z.boolean(),
    aspectRatio: z.boolean(),
    outputFormat: z.boolean(),
  }).strict(),
  references: z.array(imageReferenceSchema).max(MAX_REFERENCE_COUNT),
  signal: abortSignalSchema.optional(),
}).strict()
const videoRequestSchema = z.object({
  model: modelSchema,
  prompt: promptSchema,
  options: z.object({
    durationSeconds: z.number().int().positive().max(600),
    resolution: canonicalStringSchema,
    aspectRatio: aspectRatioSchema,
    generateAudio: z.boolean(),
  }).strict(),
  references: z.array(imageReferenceSchema).max(2),
  frameImages: z.array(z.enum(['first_frame', 'last_frame'])).max(2),
  useInputReferences: z.boolean().optional(),
  signal: abortSignalSchema.optional(),
}).strict()
const providerJobIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/)
const generationIdSchema = z.string()
  .min(1)
  .max(256)
  .refine((value) => value === value.trim())
const tokenCountSchema = z.number().int().nonnegative().safe()
const costSchema = z.union([
  z.number().nonnegative().finite(),
  z.string().min(1).max(64).refine((value) => Number.isFinite(Number(value)) && Number(value) >= 0),
])
const mediaUsageSchema = z.object({
  prompt_tokens: z.unknown().optional(),
  completion_tokens: z.unknown().optional(),
  total_tokens: z.unknown().optional(),
  cost: costSchema.optional(),
}).passthrough()
const imageOutputSchema = z.object({
  b64_json: canonicalBase64Schema.optional(),
  media_type: imageMimeTypeSchema.optional(),
  url: z.string().min(1).max(4_096).optional(),
}).passthrough().superRefine((value, context) => {
  if ((value.b64_json === undefined) === (value.url === undefined)) {
    context.addIssue({ code: 'custom', message: 'Exactly one image output is required' })
  }
})
const imageResponseSchema = z.object({
  created: z.number().int().nonnegative().safe().optional(),
  data: z.array(imageOutputSchema).length(1),
  usage: mediaUsageSchema.optional(),
}).strict()
const videoJobSchema = z.object({
  id: providerJobIdSchema,
  status: z.string().min(1).max(32),
  generation_id: generationIdSchema.nullable().optional(),
  polling_url: z.unknown().optional(),
  download_url: z.unknown().optional(),
  unsigned_urls: z.array(z.unknown()).max(10).optional(),
  usage: z.object({ cost: costSchema.optional() }).passthrough().optional(),
  error: z.unknown().optional(),
}).passthrough()
const generationUsageSchema = z.object({
  data: z.object({
    id: z.string().min(1),
    total_cost: z.union([z.string(), z.number()]).nullish(),
  }),
})

function failure(code: AppError['code']): AppError {
  return toSafeAppError({ code })
}

function safeTokenCount(value: unknown): number | undefined {
  const parsed = tokenCountSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function canonicalHttpsUrl(value: string): string {
  if (
    value !== value.trim()
    || !value.startsWith('https://')
    || value.includes('\\')
    || [...value].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 0x20 || code === 0x7f
    })
  ) throw failure('MODEL_PROVIDER_REQUEST_FAILED')
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw failure('MODEL_PROVIDER_REQUEST_FAILED')
  }
  const authority = value.slice('https://'.length).split(/[/?#]/u, 1)[0]
  if (
    parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.port !== ''
    || parsed.hash !== ''
    || parsed.href !== value
    || authority !== parsed.host
    || authority.includes('%')
    || authority.includes('@')
    || parsed.hostname.endsWith('.')
  ) throw failure('MODEL_PROVIDER_REQUEST_FAILED')
  return value
}

function parsedImageRequest(request: ModelImageRequest): ModelImageRequest {
  const parsed = imageRequestSchema.safeParse(request)
  if (!parsed.success) throw failure('INVALID_INPUT')
  if (request.signal?.aborted) throw failure('CANCELLED')
  return request
}

function parsedVideoRequest(request: ModelVideoRequest): ModelVideoRequest {
  const parsed = videoRequestSchema.safeParse(request)
  if (!parsed.success) throw failure('INVALID_INPUT')
  if (request.signal?.aborted) throw failure('CANCELLED')
  return request
}

function parsedJobId(providerJobId: string): string {
  const parsed = providerJobIdSchema.safeParse(providerJobId)
  if (!parsed.success) throw failure('INVALID_INPUT')
  return parsed.data
}

function parsedGenerationId(generationId: string): string {
  const parsed = generationIdSchema.safeParse(generationId)
  if (!parsed.success) throw failure('INVALID_INPUT')
  return parsed.data
}

function wireReferences(references: Array<{ mimeType: string; dataBase64: string }>) {
  return references.map(({ mimeType, dataBase64 }) => ({
    type: 'image_url',
    image_url: { url: `data:${mimeType};base64,${dataBase64}` },
  }))
}

function wireFrameImages(
  references: Array<{ mimeType: string; dataBase64: string }>,
  frameImages: VideoFrameType[],
) {
  if (references.length === 0) return []
  if (references.length > frameImages.length) throw failure('MODEL_MODALITY_UNSUPPORTED')
  const types: VideoFrameType[] = references.length === 1
    ? [frameImages.includes('last_frame') ? 'last_frame' : frameImages[0]!]
    : ['first_frame', 'last_frame']
  if (types.some((type) => !frameImages.includes(type))) {
    throw failure('MODEL_MODALITY_UNSUPPORTED')
  }
  return wireReferences(references).map((reference, index) => ({
    ...reference,
    frame_type: types[index]!,
  }))
}

export type OpenRouterMessage = ModelMessage
export type OpenRouterTool = ModelTool
export type OpenRouterStreamRequest = ModelStreamRequest
export type OpenRouterStreamEvent = ModelStreamEvent

export interface OpenRouterCredentialPort {
  get(key: 'openrouter_api_key'): Promise<string | undefined>
}

export interface OpenRouterProviderDependencies extends Omit<OpenAiCompatibleProviderDependencies, 'credential'> {
  credential: OpenRouterCredentialPort
}

export class OpenRouterProvider extends OpenAiCompatibleProvider {
  private readonly snapshotDependencies: OpenRouterProviderDependencies

  constructor(dependencies: OpenRouterProviderDependencies) {
    const fetch = releaseUnauthorizedResponse(dependencies.fetch ?? globalThis.fetch)
    super({
      chatEndpoint: CHAT_ENDPOINT,
      modelsEndpoint: MODELS_ENDPOINT,
      parseModels: parseOpenRouterModels,
      optionalModelCatalogs: [
        { endpoint: IMAGE_MODELS_ENDPOINT, parse: parseOpenRouterImageModels },
        { endpoint: VIDEO_MODELS_ENDPOINT, parse: parseOpenRouterVideoModels },
      ],
      mergeModels: mergeOpenRouterModels,
      includeUsageStreamOption: true,
      supportsMediaInput: true,
      supportsAudioOutput: true,
      serializeEndUser: (id) => `autoforge:${id}`,
    }, {
      ...dependencies,
      fetch,
      credential: { get: () => dependencies.credential.get('openrouter_api_key') },
    })
    this.snapshotDependencies = dependencies
  }

  async acquireSnapshot(): Promise<ModelProviderSnapshot> {
    const apiKey = await readCredentialSnapshot(
      () => this.snapshotDependencies.credential.get('openrouter_api_key'),
    )
    return {
      providerId: 'openrouter',
      provider: new OpenRouterProvider({
        ...this.snapshotDependencies,
        credential: { get: async () => apiKey },
      }),
      apiKeyFingerprint: fingerprintApiKey(apiKey),
    }
  }

  async getGenerationUsage(generationId: string, signal?: AbortSignal): Promise<ModelGenerationUsage> {
    const id = parsedGenerationId(generationId)
    const response = await this.authenticatedFetch(
      `${GENERATION_ENDPOINT}?id=${encodeURIComponent(id)}`,
      'generation',
      signal,
      () => ({ method: 'GET' }),
      { retry: 'never' },
    )
    const parsed = generationUsageSchema.safeParse(
      await this.boundedJson(response, MAX_MEDIA_JSON_BODY, signal),
    )
    if (!parsed.success || parsed.data.data.id !== id) throw failure('MODEL_PROVIDER_REQUEST_FAILED')
    try {
      return {
        generationId: id,
        ...(parsed.data.data.total_cost == null
          ? {}
          : { costUsd: normalizeUsd(parsed.data.data.total_cost) }),
      }
    } catch {
      throw failure('MODEL_PROVIDER_REQUEST_FAILED')
    }
  }

  async generateImage(request: ModelImageRequest): Promise<ModelImageResult> {
    const parsedRequest = parsedImageRequest(request)
    const response = await this.authenticatedFetch(
      IMAGE_ENDPOINT,
      'image',
      parsedRequest.signal,
      () => {
        const inputReferences = wireReferences(parsedRequest.references)
        return {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: parsedRequest.model,
            prompt: parsedRequest.prompt,
            n: 1,
            ...(parsedRequest.parameterSupport.resolution
              ? { resolution: parsedRequest.options.resolution }
              : {}),
            ...(parsedRequest.parameterSupport.aspectRatio && parsedRequest.options.aspectRatio !== 'auto'
              ? { aspect_ratio: parsedRequest.options.aspectRatio }
              : {}),
            ...(parsedRequest.parameterSupport.outputFormat
              ? { output_format: parsedRequest.options.format }
              : {}),
            ...(inputReferences.length ? { input_references: inputReferences } : {}),
          }),
        }
      },
      { retry: 'never' },
    )
    const parsed = imageResponseSchema.safeParse(
      await this.boundedJson(response, MAX_MEDIA_JSON_BODY, parsedRequest.signal),
    )
    if (!parsed.success) throw failure('MODEL_PROVIDER_REQUEST_FAILED')
    const outputs: ModelImageResult['outputs'] = parsed.data.data.map((output) => {
      if (output.b64_json !== undefined) {
        return {
          type: 'base64',
          dataBase64: output.b64_json,
          ...(output.media_type === undefined ? {} : { mimeType: output.media_type }),
        }
      }
      return { type: 'url', url: canonicalHttpsUrl(output.url!) }
    })
    const inputTokens = safeTokenCount(parsed.data.usage?.prompt_tokens)
    const outputTokens = safeTokenCount(parsed.data.usage?.completion_tokens)
    const usage = parsed.data.usage
      ? {
          ...(inputTokens === undefined
            ? {}
            : { inputTokens }),
          ...(outputTokens === undefined
            ? {}
            : { outputTokens }),
          ...(parsed.data.usage.cost === undefined
            ? {}
            : { costUsd: String(parsed.data.usage.cost) }),
        }
      : undefined
    return {
      outputs,
      ...(usage && Object.keys(usage).length ? { usage } : {}),
    }
  }

  async submitVideo(
    request: ModelVideoRequest,
  ): Promise<{ providerJobId: string; status: 'pending' | 'in_progress' }> {
    const parsedRequest = parsedVideoRequest(request)
    const response = await this.authenticatedFetch(
      VIDEO_ENDPOINT,
      'video',
      parsedRequest.signal,
      () => {
        const inputReferences = parsedRequest.useInputReferences
          ? wireReferences(parsedRequest.references)
          : []
        const frameImages = parsedRequest.useInputReferences
          ? []
          : wireFrameImages(parsedRequest.references, parsedRequest.frameImages)
        return {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: parsedRequest.model,
            prompt: parsedRequest.prompt,
            duration: parsedRequest.options.durationSeconds,
            resolution: parsedRequest.options.resolution,
            ...(parsedRequest.options.aspectRatio === 'auto'
              ? {}
              : { aspect_ratio: parsedRequest.options.aspectRatio }),
            generate_audio: parsedRequest.options.generateAudio,
            ...(inputReferences.length ? { input_references: inputReferences } : {}),
            ...(frameImages.length ? { frame_images: frameImages } : {}),
          }),
        }
      },
      { retry: 'never' },
    )
    const parsed = videoJobSchema.safeParse(
      await this.boundedJson(response, MAX_MEDIA_JSON_BODY, parsedRequest.signal),
    )
    if (
      !parsed.success
      || (parsed.data.status !== 'pending' && parsed.data.status !== 'in_progress')
    ) throw failure('MODEL_PROVIDER_REQUEST_FAILED')
    return { providerJobId: parsed.data.id, status: parsed.data.status }
  }

  async pollVideo(providerJobId: string, signal?: AbortSignal): Promise<ModelVideoStatus> {
    const id = parsedJobId(providerJobId)
    if (signal?.aborted) throw failure('CANCELLED')
    const response = await this.authenticatedFetch(
      `${VIDEO_ENDPOINT}/${id}`,
      'video',
      signal,
      () => ({ method: 'GET' }),
      { retry: 'idempotent' },
    )
    const parsed = videoJobSchema.safeParse(
      await this.boundedJson(response, MAX_MEDIA_JSON_BODY, signal),
    )
    if (!parsed.success || parsed.data.id !== id) throw failure('MODEL_PROVIDER_REQUEST_FAILED')
    switch (parsed.data.status) {
      case 'pending':
      case 'in_progress':
        return { status: parsed.data.status }
      case 'completed':
        return {
          status: 'completed',
          ...(parsed.data.generation_id == null
            ? {}
            : { generationId: parsed.data.generation_id }),
          ...(parsed.data.usage?.cost === undefined
            ? {}
            : { costUsd: String(parsed.data.usage.cost) }),
        }
      case 'failed':
        return {
          status: 'failed',
          errorCode: 'MEDIA_GENERATION_FAILED',
          ...(parsed.data.generation_id == null
            ? {}
            : { generationId: parsed.data.generation_id }),
          ...(parsed.data.usage?.cost === undefined
            ? {}
            : { costUsd: String(parsed.data.usage.cost) }),
        }
      default:
        throw failure('MODEL_PROVIDER_REQUEST_FAILED')
    }
  }

  async downloadVideo(providerJobId: string, signal?: AbortSignal): Promise<Response> {
    const id = parsedJobId(providerJobId)
    if (signal?.aborted) throw failure('CANCELLED')
    return this.authenticatedFetch(
      `${VIDEO_ENDPOINT}/${id}/content?index=0`,
      'video',
      signal,
      () => ({ method: 'GET' }),
      { retry: 'idempotent' },
    )
  }
}
