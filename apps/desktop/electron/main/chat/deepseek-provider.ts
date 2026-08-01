import { z } from 'zod'
import type { ModelInfo } from '@autoforge/shared'
import {
  OpenAiCompatibleProvider,
  type OpenAiCompatibleProviderDependencies,
} from './model-provider.js'

const CHAT_ENDPOINT = 'https://api.deepseek.com/chat/completions'
const MODELS_ENDPOINT = 'https://api.deepseek.com/models'
const MAX_DEEPSEEK_MODELS = 1_000
const MAX_MODEL_ID_LENGTH = 256

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

const deepSeekModelsSchema = z.object({
  object: z.literal('list').optional(),
  data: z.array(z.unknown()).max(MAX_DEEPSEEK_MODELS),
}).passthrough()

const deepSeekModelSchema = z.object({
  id: z.string()
    .min(1)
    .max(MAX_MODEL_ID_LENGTH)
    .refine((value) => value === value.trim()),
  object: z.literal('model').optional(),
  owned_by: z.string().max(256).optional(),
}).passthrough()

function parseDeepSeekModels(value: unknown): ModelInfo[] {
  const models = new Map<string, ModelInfo>()
  for (const entry of deepSeekModelsSchema.parse(value).data) {
    const parsed = deepSeekModelSchema.safeParse(entry)
    if (!parsed.success || models.has(parsed.data.id)) continue
    const { id } = parsed.data
    models.set(id, {
      id,
      name: id,
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportsTools: true,
      generation: {},
    })
  }
  return [...models.values()].sort((left, right) => (
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  ))
}

export interface DeepSeekProviderDependencies extends Omit<OpenAiCompatibleProviderDependencies, 'credential'> {
  credential: { get(key: 'deepseek_api_key'): Promise<string | undefined> }
}

export class DeepSeekProvider extends OpenAiCompatibleProvider {
  constructor(dependencies: DeepSeekProviderDependencies) {
    const fetch = releaseUnauthorizedResponse(dependencies.fetch ?? globalThis.fetch)
    super({
      chatEndpoint: CHAT_ENDPOINT,
      modelsEndpoint: MODELS_ENDPOINT,
      parseModels: parseDeepSeekModels,
      includeUsageStreamOption: false,
      supportsMediaInput: false,
      supportsAudioOutput: false,
    }, {
      ...dependencies,
      fetch,
      credential: { get: () => dependencies.credential.get('deepseek_api_key') },
    })
  }
}
