import { createParser } from 'eventsource-parser'
import { z } from 'zod'
import { toSafeAppError, type AppError, type ModelInfo } from '@autoforge/shared'

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

export type ModelMessage =
  | { role: 'system' | 'user'; content: string }
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
  signal?: AbortSignal
}

export type ModelStreamEvent =
  | { type: 'generation'; id: string }
  | { type: 'text_delta'; choiceIndex: number; text: string }
  | { type: 'tool_call'; choiceIndex: number; index: number; id: string; name: string; arguments: unknown }
  | { type: 'finish'; choiceIndex: number; reason: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; totalTokens: number; costUsd?: string }

export interface ModelProvider {
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>
  validateCredential(signal?: AbortSignal): Promise<{ valid: boolean }>
  stream(request: ModelStreamRequest): AsyncIterable<ModelStreamEvent>
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
}

export interface OpenAiCompatibleProviderDependencies {
  credential: ModelCredentialPort
  fetch?: FetchPort
  sleep?: SleepPort
  random?: () => number
  diagnostic?: (diagnostic: { operation: 'models' | 'chat'; status?: number; code?: string | number; error_type?: string }) => void
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

const boundedModelIdSchema = z.string().trim().min(1).max(MAX_MODEL_ID_LENGTH)
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
  supported_resolutions: z.array(boundedCapabilityValueSchema).max(MAX_CAPABILITY_VALUES).optional(),
  supported_aspect_ratios: z.array(boundedCapabilityValueSchema).max(MAX_CAPABILITY_VALUES).optional(),
  supported_durations: z.array(z.number().int().positive().max(3_600)).max(MAX_CAPABILITY_VALUES).optional(),
  allowed_passthrough_parameters: z.array(boundedCapabilityValueSchema).max(MAX_MODEL_PARAMETERS).optional(),
}).passthrough()

const streamChunkSchema = z.object({
  id: z.string().optional(),
  choices: z.array(z.object({
    index: z.number().int().nonnegative(),
    delta: z.object({
      content: z.string().nullable().optional(),
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

async function boundedResponseText(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let output = ''
  try {
    while (total < MAX_DIAGNOSTIC_BODY) {
      const chunk = await reader.read()
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

async function boundedResponseJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength && Number(declaredLength) > MAX_MODEL_CATALOG_BODY) {
    throw new Error('Model catalog response exceeded the size limit')
  }
  if (!response.body) throw new Error('Model catalog response had no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let output = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > MAX_MODEL_CATALOG_BODY) throw new Error('Model catalog response exceeded the size limit')
      output += decoder.decode(chunk.value, { stream: true })
    }
    output += decoder.decode()
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
  return [...new Set(valid)].sort(compareStrings)
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

function generationForOutputs(outputModalities: ModelInfo['outputModalities']): ModelInfo['generation'] {
  return {
    ...(outputModalities.includes('image')
      ? { image: { resolutions: [], aspectRatios: [], formats: [], maxCount: 1 } }
      : {}),
    ...(outputModalities.includes('audio')
      ? { audio: { voices: [], formats: [] } }
      : {}),
    ...(outputModalities.includes('video')
      ? { video: { resolutions: [], aspectRatios: [], durations: [], supportsAudio: false } }
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
    && parsed.data.max <= 100
  ) return parsed.data.max
  if (parsed.data.type !== 'enum') return 1
  const values = parsed.data.values.flatMap((candidate) => (
    typeof candidate === 'number'
    && Number.isSafeInteger(candidate)
    && candidate > 0
    && candidate <= 100
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
    if (!result.success || byId.has(result.data.id)) continue
    const model = result.data
    const inputModalities = sortedModalities(model.architecture?.input_modalities)
    const outputModalities = mergeModalities(
      sortedModalities(model.architecture?.output_modalities),
      ['image'],
    )
    byId.set(model.id, {
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
    })
  }
  return [...byId.values()].sort((left, right) => compareStrings(left.id, right.id))
}

function sortedPositiveIntegers(values: unknown[] | undefined): number[] {
  const valid = values?.flatMap((value) => (
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 3_600
      ? [value]
      : []
  )) ?? []
  return [...new Set(valid)].sort((left, right) => left - right)
}

export function parseOpenRouterVideoModels(value: unknown): ModelInfo[] {
  const parsed = modelResponseSchema.parse(value)
  const byId = new Map<string, ModelInfo>()
  for (const entry of parsed.data) {
    const result = videoCapabilityModelSchema.safeParse(entry)
    if (!result.success || byId.has(result.data.id)) continue
    const model = result.data
    byId.set(model.id, {
      id: model.id,
      name: model.name,
      inputModalities: [],
      outputModalities: ['video'],
      supportsTools: false,
      generation: {
        video: {
          resolutions: sortedUniqueStrings(model.supported_resolutions),
          aspectRatios: sortedUniqueStrings(model.supported_aspect_ratios),
          durations: sortedPositiveIntegers(model.supported_durations),
          supportsAudio: model.allowed_passthrough_parameters?.includes('generate_audio') === true,
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
      if (!base) continue
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
  generations: Set<string>
  tools: Set<string>
  finishes: Set<string>
  usages: Set<string>
}

export class OpenAiCompatibleProvider implements ModelProvider {
  private readonly fetch: FetchPort
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
    if (!response.ok) await this.throwHttpFailure('models', response)
    let general: ModelInfo[]
    try {
      general = this.config.parseModels(await boundedResponseJson(response))
    } catch {
      throw failure('MODEL_PROVIDER_REQUEST_FAILED')
    }
    if (!this.config.optionalModelCatalogs?.length) return general
    const results = await Promise.allSettled(this.config.optionalModelCatalogs.map(async (catalog) => {
      const { response: optionalResponse } = await this.fetchModels(signal, catalog.endpoint)
      if (!optionalResponse.ok) await this.throwHttpFailure('models', optionalResponse)
      return catalog.parse(await boundedResponseJson(optionalResponse))
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
      if (!response.ok) await this.throwHttpFailure('models', response)
      this.config.parseModels(await boundedResponseJson(response))
      return { valid: true }
    } catch (error) {
      if (isAbort(error, signal)) throw failure('CANCELLED')
      if (typeof error === 'object' && error !== null && 'code' in error) throw error
      throw failure('MODEL_PROVIDER_REQUEST_FAILED')
    }
  }

  async *stream(request: ModelStreamRequest): AsyncGenerator<ModelStreamEvent> {
    const replay: ReplayState = {
      text: new Map(), generations: new Set(), tools: new Set(), finishes: new Set(), usages: new Set(),
    }
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        const secret = await this.secret()
        const body = JSON.stringify({
          model: request.model,
          messages: request.messages,
          ...(request.tools?.length ? { tools: request.tools } : {}),
          stream: true,
          ...(this.config.includeUsageStreamOption ? { stream_options: { include_usage: true } } : {}),
        })
        let response: Response
        try {
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
        }
        if (response.status === 429 || response.status >= 500) {
          await this.readDiagnostic('chat', response)
          throw new RetryableFailure(retryAfter(response))
        }
        if (!response.ok) await this.throwHttpFailure('chat', response)

        try {
          yield* this.parseStream(response, replay, request.signal)
          return
        } catch (error) {
          if (isAbort(error, request.signal)) throw failure('CANCELLED')
          if (error instanceof TypeError) throw new RetryableFailure(undefined, error)
          throw error
        }
      } catch (error) {
        if (!(error instanceof RetryableFailure) || attempt === MAX_ATTEMPTS - 1) {
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
      await this.readDiagnostic('models', response)
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

  private async throwHttpFailure(operation: 'models' | 'chat', response: Response): Promise<never> {
    await this.readDiagnostic(operation, response)
    if (response.status === 401) throw failure('CREDENTIAL_INVALID')
    if (response.status === 403) throw failure('MODEL_PROVIDER_ACCESS_DENIED')
    throw failure('MODEL_PROVIDER_REQUEST_FAILED')
  }

  private async readDiagnostic(operation: 'models' | 'chat', response: Response): Promise<void> {
    let metadata: { code?: string | number; error_type?: string } = {}
    try {
      const parsed = JSON.parse(await boundedResponseText(response)) as unknown
      const envelope = z.object({ error: providerErrorSchema.optional() }).passthrough().safeParse(parsed)
      const direct = providerErrorSchema.safeParse(parsed)
      metadata = providerErrorMetadata(envelope.success && envelope.data.error
        ? envelope.data.error
        : direct.success ? direct.data : undefined)
    } catch {
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
        if (chunk.error) {
          this.reportStreamDiagnostic(chunk.error)
          parserError = streamedFailure(chunk.error)
          return
        }
        if (chunk.id && !replay.generations.has(chunk.id)) {
          replay.generations.add(chunk.id)
          pending.push({ type: 'generation', id: chunk.id })
        }
        for (const choice of chunk.choices) {
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
          for (const fragment of choice.delta.tool_calls ?? []) {
            const key = `${choice.index}:${fragment.index}`
            const accumulated = tools.get(key) ?? { id: '', name: '', arguments: '' }
            accumulated.id += fragment.id ?? ''
            accumulated.name += fragment.function?.name ?? ''
            accumulated.arguments += fragment.function?.arguments ?? ''
            tools.set(key, accumulated)
          }
          if (choice.finish_reason) {
            if (choice.finish_reason === 'error' || choice.error) {
              this.reportStreamDiagnostic(choice.error)
              parserError = streamedFailure(choice.error)
              return
            }
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
    let normalCompletion = false
    try {
      while (!done) {
        if (signal?.aborted) throw failure('CANCELLED')
        const result = await reader.read()
        if (result.done) break
        parser.feed(decoder.decode(result.value, { stream: true }))
        if (parserError) throw parserError
        while (pending.length) yield pending.shift()!
      }
      parser.feed(decoder.decode())
      parser.reset({ consume: true })
      if (parserError) throw parserError
      while (pending.length) yield pending.shift()!
      if (!done && !explicitTerminal) throw new RetryableFailure()
      normalCompletion = true
    } finally {
      if (!normalCompletion) await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }

  private reportStreamDiagnostic(error: ProviderError | undefined): void {
    if (!this.dependencies.diagnostic) return
    try { this.dependencies.diagnostic({ operation: 'chat', ...providerErrorMetadata(error) }) } catch { /* diagnostics are observational */ }
  }
}
