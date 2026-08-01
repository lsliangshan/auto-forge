import {
  normalizeProxySettings,
  type AppSettings,
  type AppSettingsPatch,
  type ProviderDefaultModels,
  type ProxySettings,
} from '@autoforge/shared'
import type { AppRepositories } from '../database/repositories.js'

const settingsKey = 'app'
type LegacySettings = Omit<Partial<AppSettings>, 'proxy'> & { defaultModel?: unknown; proxy?: unknown }

function providerTextDefault(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value
  if (typeof value === 'object' && value !== null) {
    const text = (value as { text?: unknown }).text
    if (typeof text === 'string' && text.trim()) return text
  }
  return undefined
}

function openRouterDefaults(value: unknown): ProviderDefaultModels['openrouter'] {
  const record = typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : {}
  return Object.fromEntries(
    ['text', 'image', 'audio', 'video']
      .filter((key) => typeof record[key] === 'string' && String(record[key]).trim())
      .map((key) => [key, record[key]]),
  ) as ProviderDefaultModels['openrouter']
}

export class SettingsService {
  constructor(
    private readonly repository: AppRepositories['appSettings'],
    private readonly defaults: AppSettings,
  ) {}

  get(): AppSettings {
    const setting = this.repository.get(settingsKey)
    return this.normalize(setting?.value)
  }

  preview(patch: AppSettingsPatch): AppSettings {
    return this.normalize({ ...this.get(), ...patch })
  }

  commit(settings: AppSettings): AppSettings {
    const normalized = this.normalize(settings)
    this.repository.set(settingsKey, normalized)
    return normalized
  }

  update(patch: AppSettingsPatch): AppSettings {
    return this.commit(this.preview(patch))
  }

  private normalize(value: unknown): AppSettings {
    const stored = typeof value === 'object' && value !== null ? value as LegacySettings : {}
    const storedDefaults = stored.defaultModels
    return {
      theme: stored.theme ?? this.defaults.theme,
      language: stored.language ?? this.defaults.language,
      dataDirectory: this.defaults.dataDirectory,
      logDirectory: this.defaults.logDirectory,
      activeProvider: stored.activeProvider === 'deepseek'
        ? 'deepseek'
        : stored.activeProvider === 'openrouter'
          ? 'openrouter'
          : this.defaults.activeProvider,
      defaultModels: {
        openrouter: {
          ...openRouterDefaults(storedDefaults?.openrouter),
          text: providerTextDefault(storedDefaults?.openrouter)
            ?? providerTextDefault(stored.defaultModel)
            ?? this.defaults.defaultModels.openrouter.text,
        },
        deepseek: {
          text: providerTextDefault(storedDefaults?.deepseek)
            ?? this.defaults.defaultModels.deepseek.text,
        },
      },
      showCosts: stored.showCosts ?? this.defaults.showCosts,
      developerMode: stored.developerMode ?? this.defaults.developerMode,
      permissionDefault: 'ask',
      proxy: normalizeProxySettings(
        typeof stored.proxy === 'object' && stored.proxy !== null
          ? stored.proxy as ProxySettings
          : this.defaults.proxy,
      ),
    }
  }
}
