import type { AppSettings, ThemePreference, UpdateSettingsRequest } from '../../shared/contracts'
import type { AppDatabase } from '../database/app-database'

const themes: ThemePreference[] = ['light', 'dark', 'system']

export class SettingsService {
  constructor(
    private readonly database: AppDatabase,
    private readonly defaultDownloadDirectory: string,
    private readonly productionApiBaseUrl?: string
  ) {}

  get(): AppSettings {
    const storedTheme = this.database.getSetting('theme')
    const theme = themes.includes(storedTheme as ThemePreference)
      ? (storedTheme as ThemePreference)
      : 'light'
    return {
      theme,
      downloadDirectory: this.database.getSetting('downloadDirectory') ?? this.defaultDownloadDirectory,
      apiBaseUrl: this.productionApiBaseUrl ?? this.database.getSetting('apiBaseUrl') ?? 'http://127.0.0.1:4310'
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
    if (typeof request.apiBaseUrl === 'string') {
      if (this.productionApiBaseUrl) throw new Error('API address is fixed in production builds')
      const url = new URL(request.apiBaseUrl)
      const isLocalDevelopment = ['127.0.0.1', 'localhost'].includes(url.hostname) && url.protocol === 'http:'
      if (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && isLocalDevelopment)) throw new Error('API address must use HTTPS')
      this.database.setSetting('apiBaseUrl', url.origin)
    }
    return this.get()
  }
}
