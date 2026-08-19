import type { ModelProviderId } from '@autoforge/shared'
import type {
  ModelProvider,
  ModelProviderSnapshot,
  ModelProviderSnapshotSource,
} from './model-provider.js'

export type ProviderCredentialKey = 'deepseek_api_key' | 'openrouter_api_key'

export function credentialKeyForProvider(provider: ModelProviderId): ProviderCredentialKey {
  return provider === 'deepseek' ? 'deepseek_api_key' : 'openrouter_api_key'
}

export interface CredentialBoundModelProvider extends ModelProvider {
  acquireSnapshot(): Promise<ModelProviderSnapshot>
}

export class ModelProviderRegistry implements ModelProviderSnapshotSource {
  private readonly providers: Readonly<Record<ModelProviderId, CredentialBoundModelProvider>>

  constructor(providers: Record<ModelProviderId, CredentialBoundModelProvider>) {
    this.providers = { ...providers }
  }

  async acquire(providerId: ModelProviderId): Promise<ModelProviderSnapshot> {
    return this.providers[providerId].acquireSnapshot()
  }
}
