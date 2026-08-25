import { ipcRenderer } from 'electron'

ipcRenderer.once('knowledge-parser:request', (event, request: unknown) => {
  const port = event.ports[0]
  if (!port) return
  const transfer: Transferable[] = [port]
  if (typeof request === 'object' && request !== null) {
    const { encryptedBytes, fileKey } = request as { encryptedBytes?: unknown; fileKey?: unknown }
    if (encryptedBytes instanceof ArrayBuffer) transfer.push(encryptedBytes)
    if (fileKey instanceof ArrayBuffer) transfer.push(fileKey)
  }
  window.postMessage(request, '*', transfer)
})
