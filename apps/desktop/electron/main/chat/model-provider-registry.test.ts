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
  it('snapshots the provider mapping while preserving optional media operations', async () => {
    const generateImage = vi.fn(async () => ({ outputs: [] }))
    const openrouter = { ...provider(), generateImage }
    const replacement = provider()
    const providers: Record<'openrouter' | 'deepseek', ModelProvider> = {
      openrouter,
      deepseek: provider(),
    }
    const registry = new ModelProviderRegistry(providers)

    providers.openrouter = replacement

    expect(registry.get('openrouter')).toBe(openrouter)
    await expect(registry.get('openrouter').generateImage?.({
      model: 'image/model',
      prompt: 'draw',
      options: { count: 1, resolution: '1K', aspectRatio: 'auto', format: 'png' },
      references: [],
    })).resolves.toEqual({ outputs: [] })
    expect(generateImage).toHaveBeenCalledTimes(1)
  })

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
