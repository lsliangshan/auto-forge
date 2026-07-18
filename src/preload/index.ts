import { contextBridge, ipcRenderer } from 'electron'
import type { AutoForgeApi } from '../shared/contracts'
import { ipcChannels } from '../shared/ipc'

const api: AutoForgeApi = {
  listTools: () => ipcRenderer.invoke(ipcChannels.listTools),
  listInstalledToolIds: () => ipcRenderer.invoke(ipcChannels.listInstalledToolIds),
  installTool: (request) => ipcRenderer.invoke(ipcChannels.installTool, request),
  getSettings: () => ipcRenderer.invoke(ipcChannels.getSettings),
  updateSettings: (request) => ipcRenderer.invoke(ipcChannels.updateSettings, request),
  exportToolTemplate: () => ipcRenderer.invoke(ipcChannels.exportToolTemplate)
}

contextBridge.exposeInMainWorld('autoForge', api)
