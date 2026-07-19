import { contextBridge, ipcRenderer } from 'electron'
import { createDesktopApi } from './bridge.js'

const autoForge = createDesktopApi({
  invoke: (channel, input) => ipcRenderer.invoke(channel, input),
  on: (channel, listener) => { ipcRenderer.on(channel, listener) },
  removeListener: (channel, listener) => { ipcRenderer.removeListener(channel, listener) },
})

contextBridge.exposeInMainWorld('autoForge', autoForge)
