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

interface CredentialBoundModelProvider extends ModelProvider {
  acquireSnapshot(): Promise<ModelProviderSnapshot>
}

function supportsCredentialSnapshot(provider: ModelProvider): provider is CredentialBoundModelProvider {
  return 'acquireSnapshot' in provider && typeof provider.acquireSnapshot === 'function'
}

export class ModelProviderRegistry implements ModelProviderSnapshotSource {
  private readonly providers: Readonly<Record<ModelProviderId, ModelProvider>>

  constructor(providers: Record<ModelProviderId, ModelProvider>) {
    this.providers = { ...providers }
  }

  get(provider: ModelProviderId): ModelProvider {
    return this.providers[provider]
  }

  async acquire(providerId: ModelProviderId): Promise<ModelProviderSnapshot> {
    const provider = this.providers[providerId]
    if (supportsCredentialSnapshot(provider)) return provider.acquireSnapshot()
    throw new TypeError(`Provider ${providerId} does not support credential snapshots`)
  }
}
