import { ipcRenderer } from 'electron'

ipcRenderer.once('knowledge-parser:request', (event, request: unknown) => {
  const port = event.ports[0]
  if (!port) return
  window.postMessage(request, '*', [port])
})
