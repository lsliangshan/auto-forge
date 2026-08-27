import { ipcRenderer } from 'electron'

ipcRenderer.once('knowledge-parser:request', (event, request: unknown) => {
  const port = event.ports[0]
  if (!port) return
  const transfer: Transferable[] = [port]
  if (typeof request === 'object' && request !== null) {
    const candidate = request as { encryptedSnapshot?: unknown; oneTimeKey?: unknown }
    if (candidate.encryptedSnapshot instanceof ArrayBuffer) transfer.push(candidate.encryptedSnapshot)
    if (candidate.oneTimeKey instanceof ArrayBuffer) transfer.push(candidate.oneTimeKey)
  }
  window.postMessage(request, '*', transfer)
})
