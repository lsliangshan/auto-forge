import { z } from 'zod'
import type { ModelInfo } from '@autoforge/shared'
import {
  OpenAiCompatibleProvider,
  type OpenAiCompatibleProviderDependencies,
} from './model-provider.js'

const CHAT_ENDPOINT = 'https://api.deepseek.com/chat/completions'
const MODELS_ENDPOINT = 'https://api.deepseek.com/models'

const deepSeekModelsSchema = z.object({
  object: z.literal('list').optional(),
  data: z.array(z.object({
    id: z.string().trim().min(1),
    object: z.literal('model').optional(),
    owned_by: z.string().optional(),
  }).passthrough()),
}).passthrough()

function parseDeepSeekModels(value: unknown): ModelInfo[] {
  return deepSeekModelsSchema.parse(value).data
    .map(({ id }) => ({ id, name: id }))
    .sort((left, right) => left.id.localeCompare(right.id))
}

export interface DeepSeekProviderDependencies extends Omit<OpenAiCompatibleProviderDependencies, 'credential'> {
  credential: { get(key: 'deepseek_api_key'): Promise<string | undefined> }
}

export class DeepSeekProvider extends OpenAiCompatibleProvider {
  constructor(dependencies: DeepSeekProviderDependencies) {
    super({
      chatEndpoint: CHAT_ENDPOINT,
      modelsEndpoint: MODELS_ENDPOINT,
      parseModels: parseDeepSeekModels,
      includeUsageStreamOption: false,
    }, {
      ...dependencies,
      credential: { get: () => dependencies.credential.get('deepseek_api_key') },
    })
  }
}
