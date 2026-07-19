import { createParser } from 'eventsource-parser'
import { z } from 'zod'
import { toSafeAppError, type AppError, type ModelInfo } from '@autoforge/shared'

const CHAT_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'
const MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/models?supported_parameters=tools'
const MAX_ATTEMPTS = 4
const MAX_RETRY_AFTER_MS = 5_000
const MAX_DIAGNOSTIC_BODY = 1_024

export type OpenRouterMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; content: string; tool_call_id: string }

export interface OpenRouterTool {
  type: 'function'
  function: { name: string; description: string; parameters: unknown }
}

export interface OpenRouterStreamRequest {
  model: string
  messages: OpenRouterMessage[]
  tools?: OpenRouterTool[]
  signal?: AbortSignal
}

export type OpenRouterStreamEvent =
  | { type: 'generation'; id: string }
  | { type: 'text_delta'; choiceIndex: number; text: string }
  | { type: 'tool_call'; choiceIndex: number; index: number; id: string; name: string; arguments: unknown }
  | { type: 'finish'; choiceIndex: number; reason: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; totalTokens: number; costUsd?: string }

export interface OpenRouterCredentialPort {
  get(key: 'openrouter_api_key'): Promise<string | undefined>
}

type FetchPort = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
type SleepPort = (milliseconds: number, signal: AbortSignal | undefined) => Promise<void>

export interface OpenRouterProviderDependencies {
  credential: OpenRouterCredentialPort
  fetch?: FetchPort
  sleep?: SleepPort
  random?: () => number
  diagnostic?: (diagnostic: { operation: 'models' | 'chat'; status?: number; body?: string }) => void
}

const modelResponseSchema = z.object({
  data: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    supported_parameters: z.array(z.string()).optional(),
    architecture: z.object({
      input_modalities: z.array(z.string()).optional(),
      output_modalities: z.array(z.string()).optional(),
    }).passthrough().optional(),
    context_length: z.number().int().positive().optional(),
    pricing: z.object({ prompt: z.string().optional(), completion: z.string().optional() }).passthrough().optional(),
  }).passthrough()),
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
  }).passthrough()).optional().default([]),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
    cost: z.union([z.number(), z.string()]).refine((value) => Number.isFinite(Number(value)) && Number(value) >= 0).optional(),
  }).passthrough().optional(),
}).passthrough()

class RetryableFailure extends Error {
  constructor(readonly retryAfterMs?: number, readonly cause?: unknown) {
    super('Retryable OpenRouter request failure')
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

function safeBody(value: string, secret: string): string {
  const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return value
    .slice(0, MAX_DIAGNOSTIC_BODY)
    .replace(new RegExp(escaped, 'g'), '[REDACTED]')
    .replace(/(authorization|api[_-]?key|token|cookie)\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/gi, '$1=[REDACTED]')
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

function millionPrice(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed * 1_000_000 : undefined
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

export class OpenRouterProvider {
  private readonly fetch: FetchPort
  private readonly sleep: SleepPort
  private readonly random: () => number

  constructor(private readonly dependencies: OpenRouterProviderDependencies) {
    this.fetch = dependencies.fetch ?? globalThis.fetch
    this.sleep = dependencies.sleep ?? defaultSleep
    this.random = dependencies.random ?? Math.random
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const { response, secret } = await this.fetchModels(signal)
    if (!response.ok) await this.throwHttpFailure('models', response, secret)
    let parsed: z.infer<typeof modelResponseSchema>
    try {
      parsed = modelResponseSchema.parse(await response.json())
    } catch {
      throw failure('OPENROUTER_REQUEST_FAILED')
    }
    return parsed.data
      .filter((model) => model.supported_parameters?.includes('tools') === true
        && model.architecture?.input_modalities?.includes('text') === true
        && model.architecture.output_modalities?.includes('text') === true)
      .map((model) => {
        const inputCostPerMillion = millionPrice(model.pricing?.prompt)
        const outputCostPerMillion = millionPrice(model.pricing?.completion)
        return {
          id: model.id,
          name: model.name,
          ...(model.context_length === undefined ? {} : { contextLength: model.context_length }),
          ...(inputCostPerMillion === undefined ? {} : { inputCostPerMillion }),
          ...(outputCostPerMillion === undefined ? {} : { outputCostPerMillion }),
        }
      })
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  async validateCredential(signal?: AbortSignal): Promise<{ valid: boolean }> {
    try {
      const { response } = await this.fetchModels(signal)
      if (response.status === 401 || response.status === 403) return { valid: false }
      if (!response.ok) throw failure('OPENROUTER_REQUEST_FAILED')
      modelResponseSchema.parse(await response.json())
      return { valid: true }
    } catch (error) {
      if (isAbort(error, signal)) throw failure('CANCELLED')
      if (typeof error === 'object' && error !== null && 'code' in error) throw error
      throw failure('OPENROUTER_REQUEST_FAILED')
    }
  }

  async *stream(request: OpenRouterStreamRequest): AsyncGenerator<OpenRouterStreamEvent> {
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
          stream_options: { include_usage: true },
        })
        let response: Response
        try {
          response = await this.fetch(CHAT_ENDPOINT, {
            method: 'POST',
            headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
            body,
            signal: request.signal,
          })
        } catch (error) {
          if (isAbort(error, request.signal)) throw failure('CANCELLED')
          if (error instanceof TypeError) throw new RetryableFailure(undefined, error)
          throw failure('OPENROUTER_REQUEST_FAILED')
        }
        if (response.status === 429 || response.status >= 500) {
          await this.readDiagnostic('chat', response, secret)
          throw new RetryableFailure(retryAfter(response))
        }
        if (!response.ok) await this.throwHttpFailure('chat', response, secret)

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
          if (error instanceof RetryableFailure) throw failure('OPENROUTER_REQUEST_FAILED')
          throw error
        }
        const base = 200 * (2 ** attempt)
        const delay = error.retryAfterMs ?? Math.min(MAX_RETRY_AFTER_MS, base * (1 + this.random() * 0.25))
        try {
          await this.sleep(delay, request.signal)
        } catch (sleepError) {
          if (isAbort(sleepError, request.signal) || request.signal?.aborted) throw failure('CANCELLED')
          throw failure('OPENROUTER_REQUEST_FAILED')
        }
      }
    }
  }

  private async fetchModels(signal?: AbortSignal): Promise<{ response: Response; secret: string }> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const secret = await this.secret()
      let response: Response
      try {
        response = await this.fetch(MODELS_ENDPOINT, { headers: { authorization: `Bearer ${secret}` }, signal })
      } catch (error) {
        if (isAbort(error, signal)) throw failure('CANCELLED')
        if (!(error instanceof TypeError) || attempt === MAX_ATTEMPTS - 1) throw failure('OPENROUTER_REQUEST_FAILED')
        await this.retryDelay(attempt, undefined, signal)
        continue
      }
      if (response.status !== 429 && response.status < 500) return { response, secret }
      await this.readDiagnostic('models', response, secret)
      if (attempt === MAX_ATTEMPTS - 1) throw failure('OPENROUTER_REQUEST_FAILED')
      await this.retryDelay(attempt, retryAfter(response), signal)
    }
    throw failure('OPENROUTER_REQUEST_FAILED')
  }

  private async retryDelay(attempt: number, requested: number | undefined, signal?: AbortSignal): Promise<void> {
    const base = 200 * (2 ** attempt)
    const delay = requested ?? Math.min(MAX_RETRY_AFTER_MS, base * (1 + this.random() * 0.25))
    try {
      await this.sleep(delay, signal)
    } catch (error) {
      if (isAbort(error, signal) || signal?.aborted) throw failure('CANCELLED')
      throw failure('OPENROUTER_REQUEST_FAILED')
    }
  }

  private async secret(): Promise<string> {
    try {
      const value = await this.dependencies.credential.get('openrouter_api_key')
      if (!value) throw failure('CREDENTIAL_UNAVAILABLE')
      return value
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error) throw error
      throw failure('CREDENTIAL_UNAVAILABLE')
    }
  }

  private async throwHttpFailure(operation: 'models' | 'chat', response: Response, secret: string): Promise<never> {
    await this.readDiagnostic(operation, response, secret)
    if (response.status === 401 || response.status === 403) throw failure('CREDENTIAL_INVALID')
    throw failure('OPENROUTER_REQUEST_FAILED')
  }

  private async readDiagnostic(operation: 'models' | 'chat', response: Response, secret: string): Promise<void> {
    if (!this.dependencies.diagnostic) return
    let body = ''
    try { body = safeBody(await boundedResponseText(response), secret) } catch { /* response diagnostics are optional */ }
    try { this.dependencies.diagnostic({ operation, status: response.status, ...(body ? { body } : {}) }) } catch { /* diagnostics are observational */ }
  }

  private async *parseStream(response: Response, replay: ReplayState, signal?: AbortSignal): AsyncGenerator<OpenRouterStreamEvent> {
    if (!response.body) throw failure('OPENROUTER_REQUEST_FAILED')
    const pending: OpenRouterStreamEvent[] = []
    const attemptText = new Map<number, string>()
    const tools = new Map<string, ToolAccumulator>()
    let parserError: unknown
    let done = false
    const parser = createParser({
      maxBufferSize: 1024 * 1024,
      onError(error) { parserError = error },
      onEvent: ({ data }) => {
        if (data === '[DONE]') { done = true; return }
        let chunk: z.infer<typeof streamChunkSchema>
        try { chunk = streamChunkSchema.parse(JSON.parse(data)) } catch (error) { parserError = error; return }
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
              parserError = new Error('OpenRouter retry replay diverged')
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
          const event: Extract<OpenRouterStreamEvent, { type: 'usage' }> = {
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
    } finally {
      if (signal?.aborted || done) await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }
}
