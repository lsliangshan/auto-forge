import type { AppSettings, AppSettingsPatch } from '@autoforge/shared'
import type { AppRepositories } from '../database/repositories.js'

const settingsKey = 'app'

export class SettingsService {
  constructor(
    private readonly repository: AppRepositories['appSettings'],
    private readonly defaults: AppSettings,
  ) {}

  get(): AppSettings {
    const setting = this.repository.get(settingsKey)
    return setting ? { ...this.defaults, ...(setting.value as AppSettingsPatch) } : { ...this.defaults }
  }

  update(patch: AppSettingsPatch): AppSettings {
    const settings = { ...this.get(), ...patch }
    this.repository.set(settingsKey, settings)
    return settings
  }
}
