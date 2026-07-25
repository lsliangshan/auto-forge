import type { ModelProviderId } from '@autoforge/shared'
import type { ModelProvider } from './model-provider.js'

export type ProviderCredentialKey = 'deepseek_api_key' | 'openrouter_api_key'

export function credentialKeyForProvider(provider: ModelProviderId): ProviderCredentialKey {
  return provider === 'deepseek' ? 'deepseek_api_key' : 'openrouter_api_key'
}

export class ModelProviderRegistry {
  constructor(private readonly providers: Record<ModelProviderId, ModelProvider>) {}

  get(provider: ModelProviderId): ModelProvider {
    return this.providers[provider]
  }
}
