import {
  mergeOpenRouterModels,
  OpenAiCompatibleProvider,
  parseOpenRouterImageModels,
  parseOpenRouterModels,
  parseOpenRouterVideoModels,
  type ModelMessage,
  type ModelStreamEvent,
  type ModelStreamRequest,
  type ModelTool,
  type OpenAiCompatibleProviderDependencies,
} from './model-provider.js'

const CHAT_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'
const MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/models'
const IMAGE_MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/images/models'
const VIDEO_MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/videos/models'

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
  constructor(dependencies: OpenRouterProviderDependencies) {
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
    }, {
      ...dependencies,
      credential: { get: () => dependencies.credential.get('openrouter_api_key') },
    })
  }
}
