import type { ToolSummary } from './catalog'

export type ThemePreference = 'light' | 'dark' | 'system'

export interface AppSettings {
  theme: ThemePreference
  downloadDirectory: string
}

export interface InstallToolRequest {
  toolId: string
}

export interface InstallToolResult {
  toolId: string
  installedAt: string
}

export interface UpdateSettingsRequest {
  theme?: ThemePreference
  downloadDirectory?: string
}

export interface TemplateExportResult {
  cancelled: boolean
  path?: string
}

export interface SafeError {
  code: string
  message: string
}

export interface AutoForgeApi {
  listTools(): Promise<ToolSummary[]>
  listInstalledToolIds(): Promise<string[]>
  installTool(request: InstallToolRequest): Promise<InstallToolResult>
  getSettings(): Promise<AppSettings>
  updateSettings(request: UpdateSettingsRequest): Promise<AppSettings>
  exportToolTemplate(): Promise<TemplateExportResult>
}
