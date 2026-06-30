import { contextBridge, ipcRenderer } from 'electron'
import { ipcChannels, type AutoForgeBridge } from '@shared/contracts'

const api: AutoForgeBridge = {
  getOverview: () => ipcRenderer.invoke(ipcChannels.getOverview),
  browser: {
    openWindow: () => ipcRenderer.invoke(ipcChannels.browserOpenWindow),
    loadUrl: (url) => ipcRenderer.invoke(ipcChannels.browserLoadUrl, url),
    goBack: () => ipcRenderer.invoke(ipcChannels.browserGoBack),
    getState: () => ipcRenderer.invoke(ipcChannels.browserGetState),
    onStateChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, state: unknown): void => {
        callback(state as Awaited<ReturnType<AutoForgeBridge['browser']['getState']>>)
      }
      ipcRenderer.on(ipcChannels.browserStateChanged, listener)
      return () => {
        ipcRenderer.removeListener(ipcChannels.browserStateChanged, listener)
      }
    }
  },
  workflow: {
    getSnapshot: () => ipcRenderer.invoke(ipcChannels.workflowGetSnapshot),
    start: () => ipcRenderer.invoke(ipcChannels.workflowStart),
    pause: () => ipcRenderer.invoke(ipcChannels.workflowPause),
    resume: () => ipcRenderer.invoke(ipcChannels.workflowResume),
    reset: () => ipcRenderer.invoke(ipcChannels.workflowReset),
    onChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, snapshot: unknown): void => {
        callback(snapshot as Awaited<ReturnType<AutoForgeBridge['workflow']['getSnapshot']>>)
      }
      ipcRenderer.on(ipcChannels.workflowChanged, listener)
      return () => {
        ipcRenderer.removeListener(ipcChannels.workflowChanged, listener)
      }
    }
  },
  plugins: {
    list: () => ipcRenderer.invoke(ipcChannels.pluginsList),
    validateManifest: (manifest) => ipcRenderer.invoke(ipcChannels.pluginsValidateManifest, manifest)
  }
}

contextBridge.exposeInMainWorld('autoForge', api)
