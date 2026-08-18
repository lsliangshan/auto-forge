import { describe, expect, it, vi } from 'vitest'
import type { ModelInfo } from '@autoforge/shared'
import type { ModelProvider } from './model-provider.js'
import { credentialKeyForProvider, ModelProviderRegistry } from './model-provider-registry.js'
import { OpenRouterProvider } from './openrouter-provider.js'
import { DeepSeekProvider } from './deepseek-provider.js'
import { fingerprintApiKey } from '../billing/provider-usage-reconciler.js'

function provider(models: ModelInfo[] = []): ModelProvider {
  return {
    listModels: vi.fn(async () => models),
    validateCredential: vi.fn(async () => ({ valid: true })),
    stream: vi.fn(async function* () { yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' } }),
  }
}

describe('ModelProviderRegistry', () => {
  it('binds an acquired OpenRouter provider to one credential across retries', async () => {
    let apiKey = 'sk-openrouter-a'
    const credential = { get: vi.fn(async () => apiKey) }
    const authorizations: string[] = []
    let attempts = 0
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get('authorization') ?? '')
      attempts += 1
      if (attempts === 1) return new Response('{}', { status: 500 })
      return new Response('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
    })
    const registry = new ModelProviderRegistry({
      openrouter: new OpenRouterProvider({ credential, fetch, sleep: async () => undefined }),
      deepseek: new DeepSeekProvider({ credential: { get: vi.fn(async () => 'sk-deepseek') }, fetch }),
    })

    const first = await registry.acquire('openrouter')
    apiKey = 'sk-openrouter-b'
    for await (const _event of first.provider.stream({ model: 'text/model', messages: [] })) {
      // Drain the bound stream through its retry path.
    }

    const second = await registry.acquire('openrouter')
    for await (const _event of second.provider.stream({ model: 'text/model', messages: [] })) {
      // Drain a newly acquired provider using the updated credential.
    }

    expect(authorizations).toEqual([
      'Bearer sk-openrouter-a',
      'Bearer sk-openrouter-a',
      'Bearer sk-openrouter-b',
    ])
    expect(credential.get).toHaveBeenCalledTimes(2)
    expect(first.apiKeyFingerprint).toBe(fingerprintApiKey('sk-openrouter-a'))
    expect(second.apiKeyFingerprint).toBe(fingerprintApiKey('sk-openrouter-b'))
    expect(Object.keys(first)).not.toContain('apiKey')
    expect(JSON.stringify(first)).not.toContain('sk-openrouter-a')
    expect(JSON.stringify(first)).not.toContain('sk-openrouter-b')
  })

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
    await expect(registry.acquire('openrouter')).rejects.toThrow(
      'Provider openrouter does not support credential snapshots',
    )
    await expect(registry.get('openrouter').generateImage?.({
      model: 'image/model',
      prompt: 'draw',
      options: { count: 1, resolution: '1K', aspectRatio: 'auto', format: 'png' },
      parameterSupport: { resolution: true, aspectRatio: true, outputFormat: true },
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
