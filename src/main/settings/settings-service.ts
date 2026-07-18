import type { AppSettings, ThemePreference, UpdateSettingsRequest } from '../../shared/contracts'
import type { AppDatabase } from '../database/app-database'

const themes: ThemePreference[] = ['light', 'dark', 'system']

export class SettingsService {
  constructor(
    private readonly database: AppDatabase,
    private readonly defaultDownloadDirectory: string
  ) {}

  get(): AppSettings {
    const storedTheme = this.database.getSetting('theme')
    const theme = themes.includes(storedTheme as ThemePreference)
      ? (storedTheme as ThemePreference)
      : 'light'
    return {
      theme,
      downloadDirectory: this.database.getSetting('downloadDirectory') ?? this.defaultDownloadDirectory
    }
  }

  update(request: UpdateSettingsRequest): AppSettings {
    if (request.theme) {
      if (!themes.includes(request.theme)) throw new Error('Unsupported theme preference')
      this.database.setSetting('theme', request.theme)
    }
    if (typeof request.downloadDirectory === 'string') {
      const directory = request.downloadDirectory.trim()
      if (!directory) throw new Error('Download directory is required')
      this.database.setSetting('downloadDirectory', directory)
    }
    return this.get()
  }
}
