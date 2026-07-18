import catalog from '../../../../resources/catalog/tools.json'
import type { ToolSummary } from '../../../shared/catalog'
import type { AppSettings, AutoForgeApi } from '../../../shared/contracts'

const installed = new Set<string>(['web-collector'])
let settings: AppSettings = { theme: 'light', downloadDirectory: '下载' }

const browserFallback: AutoForgeApi = {
  async listTools() {
    return structuredClone(catalog as ToolSummary[])
  },
  async listInstalledToolIds() {
    return [...installed]
  },
  async installTool({ toolId }) {
    await new Promise((resolve) => window.setTimeout(resolve, 400))
    installed.add(toolId)
    return { toolId, installedAt: new Date().toISOString() }
  },
  async getSettings() {
    return { ...settings }
  },
  async updateSettings(request) {
    settings = { ...settings, ...request }
    return { ...settings }
  },
  async exportToolTemplate() {
    await new Promise((resolve) => window.setTimeout(resolve, 500))
    return { cancelled: false, path: '下载/auto-forge-tool-template' }
  }
}

export function getDesktopApi(): AutoForgeApi {
  return window.autoForge ?? browserFallback
}
