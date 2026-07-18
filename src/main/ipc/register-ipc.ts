import { dialog, ipcMain } from 'electron'
import type { UpdateSettingsRequest } from '../../shared/contracts'
import { ipcChannels, toSafeError } from '../../shared/ipc'
import type { CatalogService } from '../catalog/catalog-service'
import type { InstallationService } from '../installations/installation-service'
import type { SettingsService } from '../settings/settings-service'
import type { TemplateService } from '../templates/template-service'

export interface IpcServices {
  catalog: CatalogService
  installations: InstallationService
  settings: SettingsService
  templates: TemplateService
}

function failSafely(error: unknown): never {
  throw new Error(JSON.stringify(toSafeError(error)))
}

function requireToolId(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || typeof (payload as { toolId?: unknown }).toolId !== 'string') {
    throw new Error('A valid tool id is required')
  }
  const toolId = (payload as { toolId: string }).toolId.trim()
  if (!toolId) throw new Error('A valid tool id is required')
  return toolId
}

function parseSettings(payload: unknown): UpdateSettingsRequest {
  if (!payload || typeof payload !== 'object') throw new Error('Invalid settings payload')
  const request = payload as UpdateSettingsRequest
  if (request.theme !== undefined && !['light', 'dark', 'system'].includes(request.theme)) {
    throw new Error('Unsupported theme preference')
  }
  if (request.downloadDirectory !== undefined && typeof request.downloadDirectory !== 'string') {
    throw new Error('Invalid download directory')
  }
  return request
}

export function registerIpcHandlers(services: IpcServices): void {
  ipcMain.handle(ipcChannels.listTools, () => services.catalog.listTools())
  ipcMain.handle(ipcChannels.listInstalledToolIds, () => services.installations.listInstalledToolIds())

  ipcMain.handle(ipcChannels.installTool, (_event, payload: unknown) => {
    try {
      return services.installations.install(requireToolId(payload))
    } catch (error) {
      return failSafely(error)
    }
  })

  ipcMain.handle(ipcChannels.getSettings, () => services.settings.get())
  ipcMain.handle(ipcChannels.updateSettings, (_event, payload: unknown) => {
    try {
      return services.settings.update(parseSettings(payload))
    } catch (error) {
      return failSafely(error)
    }
  })

  ipcMain.handle(ipcChannels.exportToolTemplate, async () => {
    try {
      const settings = services.settings.get()
      const result = await dialog.showOpenDialog({
        title: '选择工具模板保存目录',
        defaultPath: settings.downloadDirectory,
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || !result.filePaths[0]) return { cancelled: true }

      const selectedDirectory = result.filePaths[0]
      services.settings.update({ downloadDirectory: selectedDirectory })
      return { cancelled: false, path: services.templates.exportTemplate(selectedDirectory) }
    } catch (error) {
      return failSafely(error)
    }
  })
}
