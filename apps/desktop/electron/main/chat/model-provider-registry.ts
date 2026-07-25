import type { ModelProviderId } from '@autoforge/shared'
import type { ModelProvider } from './model-provider.js'

export type ProviderCredentialKey = 'deepseek_api_key' | 'openrouter_api_key'

export function credentialKeyForProvider(provider: ModelProviderId): ProviderCredentialKey {
  return provider === 'deepseek' ? 'deepseek_api_key' : 'openrouter_api_key'
}

export class ModelProviderRegistry {
  private readonly providers: Readonly<Record<ModelProviderId, ModelProvider>>

  constructor(providers: Record<ModelProviderId, ModelProvider>) {
    this.providers = { ...providers }
  }

  get(provider: ModelProviderId): ModelProvider {
    return this.providers[provider]
  }
}
