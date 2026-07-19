import { contextBridge, ipcRenderer } from 'electron'
contextBridge.exposeInMainWorld('workflowSdk', {
  call: (executionId: string, method: string, args: unknown[]) => ipcRenderer.invoke('workflow-sdk:call', { executionId, method, args })
})
