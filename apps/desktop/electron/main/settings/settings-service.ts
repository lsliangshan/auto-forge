import type { AppSettings, AppSettingsPatch, ProviderDefaultModels } from '@autoforge/shared'
import type { AppRepositories } from '../database/repositories.js'

const settingsKey = 'app'
type LegacySettings = Partial<AppSettings> & { defaultModel?: unknown }

export class SettingsService {
  constructor(
    private readonly repository: AppRepositories['appSettings'],
    private readonly defaults: AppSettings,
  ) {}

  get(): AppSettings {
    const setting = this.repository.get(settingsKey)
    return this.normalize(setting?.value)
  }

  update(patch: AppSettingsPatch): AppSettings {
    const settings = this.normalize({ ...this.get(), ...patch })
    this.repository.set(settingsKey, settings)
    return settings
  }

  private normalize(value: unknown): AppSettings {
    const stored = typeof value === 'object' && value !== null ? value as LegacySettings : {}
    const storedDefaults = typeof stored.defaultModels === 'object' && stored.defaultModels !== null
      ? stored.defaultModels as Partial<ProviderDefaultModels>
      : {}
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
        openrouter: typeof storedDefaults.openrouter === 'string' && storedDefaults.openrouter.trim()
          ? storedDefaults.openrouter
          : typeof stored.defaultModel === 'string' && stored.defaultModel.trim()
            ? stored.defaultModel
            : this.defaults.defaultModels.openrouter,
        deepseek: typeof storedDefaults.deepseek === 'string' && storedDefaults.deepseek.trim()
          ? storedDefaults.deepseek
          : this.defaults.defaultModels.deepseek,
      },
      showCosts: stored.showCosts ?? this.defaults.showCosts,
      developerMode: stored.developerMode ?? this.defaults.developerMode,
      permissionDefault: 'ask',
    }
  }
}
