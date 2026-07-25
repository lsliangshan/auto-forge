import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { createDesktopApi } from './bridge.js'

const autoForge = createDesktopApi({
  invoke: (channel, input) => ipcRenderer.invoke(channel, input),
  on: (channel, listener) => { ipcRenderer.on(channel, listener) },
  removeListener: (channel, listener) => { ipcRenderer.removeListener(channel, listener) },
}, {
  getPathForFile: (file) => webUtils.getPathForFile(file),
})

contextBridge.exposeInMainWorld('autoForge', autoForge)
