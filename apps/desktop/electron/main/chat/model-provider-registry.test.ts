import { describe, expect, it, vi } from 'vitest'
import type { ModelInfo } from '@autoforge/shared'
import type { ModelProvider } from './model-provider.js'
import { credentialKeyForProvider, ModelProviderRegistry } from './model-provider-registry.js'

function provider(models: ModelInfo[] = []): ModelProvider {
  return {
    listModels: vi.fn(async () => models),
    validateCredential: vi.fn(async () => ({ valid: true })),
    stream: vi.fn(async function* () { yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' } }),
  }
}

describe('ModelProviderRegistry', () => {
  it('routes only fixed providers and maps separate credential keys', async () => {
    const openRouterModels: ModelInfo[] = [{
      id: 'image/model',
      name: 'Image model',
      inputModalities: ['text'],
      outputModalities: ['image'],
      supportsTools: false,
      generation: {
        image: { resolutions: [], aspectRatios: [], formats: [], maxCount: 1 },
      },
    }]
    const openrouter = provider(openRouterModels)
    const deepseek = provider()
    const registry = new ModelProviderRegistry({ openrouter, deepseek })

    expect(registry.get('openrouter')).toBe(openrouter)
    expect(registry.get('deepseek')).toBe(deepseek)
    expect(credentialKeyForProvider('openrouter')).toBe('openrouter_api_key')
    expect(credentialKeyForProvider('deepseek')).toBe('deepseek_api_key')
    await expect(registry.get('openrouter').listModels()).resolves.toEqual(openRouterModels)
  })
})
