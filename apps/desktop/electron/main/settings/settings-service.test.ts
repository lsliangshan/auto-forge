import { describe, expect, it } from 'vitest'
import type { AppSettings } from '@autoforge/shared'
import type { AppRepositories } from '../database/repositories.js'
import { SettingsService } from './settings-service.js'

const defaults: AppSettings = {
  theme: 'system',
  language: 'zh-CN',
  dataDirectory: '/data',
  logDirectory: '/logs',
  activeProvider: 'deepseek',
  defaultModels: {
    openrouter: { text: 'openai/gpt-4.1-mini' },
    deepseek: { text: 'deepseek-v4-flash' },
  },
  showCosts: true,
  developerMode: false,
  permissionDefault: 'ask',
}

function settingsRepository(initial?: unknown): AppRepositories['appSettings'] {
  let value = initial
  return {
    get: (key) => value === undefined ? undefined : { key, value, updatedAt: 1 },
    set: (key, next) => {
      value = next
      return { key, value, updatedAt: 2 }
    },
    delete: () => { value = undefined },
  }
}

describe('SettingsService', () => {
  it('migrates a legacy defaultModel to the OpenRouter default', () => {
    const repository = settingsRepository({
      theme: 'dark',
      language: 'zh-CN',
      dataDirectory: '/legacy-data',
      logDirectory: '/legacy-logs',
      defaultModel: 'legacy/openrouter-model',
      showCosts: true,
      developerMode: false,
      permissionDefault: 'ask',
    })
    const service = new SettingsService(repository, defaults)

    expect(service.get()).toEqual({
      theme: 'dark',
      language: 'zh-CN',
      dataDirectory: '/data',
      logDirectory: '/logs',
      activeProvider: 'deepseek',
      defaultModels: {
        openrouter: { text: 'legacy/openrouter-model' },
        deepseek: { text: 'deepseek-v4-flash' },
      },
      showCosts: true,
      developerMode: false,
      permissionDefault: 'ask',
    })
    expect(service.get()).not.toHaveProperty('defaultModel')
  })

  it('uses DeepSeek when legacy settings do not contain a provider', () => {
    const service = new SettingsService(settingsRepository({
      theme: 'dark',
      defaultModel: 'legacy/openrouter-model',
    }), defaults)

    expect(service.get().activeProvider).toBe('deepseek')
  })

  it('preserves an explicitly saved OpenRouter provider', () => {
    const service = new SettingsService(settingsRepository({
      activeProvider: 'openrouter',
    }), defaults)

    expect(service.get().activeProvider).toBe('openrouter')
  })

  it('preserves an explicitly saved DeepSeek provider', () => {
    const service = new SettingsService(settingsRepository({
      activeProvider: 'deepseek',
    }), defaults)

    expect(service.get().activeProvider).toBe('deepseek')
  })

  it('uses DeepSeek when a legacy provider value is invalid', () => {
    const service = new SettingsService(settingsRepository({
      activeProvider: 'custom-provider',
    }), defaults)

    expect(service.get().activeProvider).toBe('deepseek')
  })

  it('migrates legacy provider strings to text defaults', () => {
    const repository = settingsRepository({
      activeProvider: 'openrouter',
      defaultModels: { openrouter: 'openai/gpt-4.1-mini', deepseek: 'deepseek-chat' },
    })
    const service = new SettingsService(repository, defaults)

    expect(service.get().defaultModels).toEqual({
      deepseek: { text: 'deepseek-chat' },
      openrouter: { text: 'openai/gpt-4.1-mini' },
    })
  })

  it('preserves non-empty nested OpenRouter output defaults', () => {
    const repository = settingsRepository({
      defaultModels: {
        deepseek: { text: 'deepseek-chat' },
        openrouter: { text: 'text-model', image: 'image-model', video: 'video-model' },
      },
    })
    const service = new SettingsService(repository, defaults)

    expect(service.get().defaultModels.openrouter.video).toBe('video-model')
    expect(service.get().defaultModels.openrouter).toEqual({
      text: 'text-model',
      image: 'image-model',
      video: 'video-model',
    })
  })

  it('updates one provider default without changing the other', () => {
    const service = new SettingsService(settingsRepository(), defaults)

    service.update({
      defaultModels: {
        ...service.get().defaultModels,
        deepseek: { text: 'deepseek-v4-pro' },
      },
    })

    expect(service.get().defaultModels).toEqual({
      openrouter: { text: 'openai/gpt-4.1-mini' },
      deepseek: { text: 'deepseek-v4-pro' },
    })
  })
})
