import { randomUUID } from 'node:crypto'
import type { EventEmitter } from 'node:events'
import { DEFAULT_PARSER_LIMITS, parseParserResponse, type ParserFormat, type ParserLimits, type ParserResponse } from './parser-protocol.js'
import { readEncryptedObjectSnapshot } from './encrypted-object-store.js'

interface ParserPort extends EventEmitter {
  start(): void
  close(): void
}

interface ParserWebContents extends EventEmitter {
  setWindowOpenHandler(handler: () => { action: 'deny' }): void
  postMessage(channel: string, message: unknown, transfer: ParserPort[]): void
  getOSProcessId(): number
}

interface ParserWindow {
  webContents: ParserWebContents
  loadFile(path: string): Promise<void>
  destroy(): void
  isDestroyed(): boolean
}

interface ParserSession {
  webRequest: {
    onBeforeRequest(filter: { urls: string[] }, handler: (details: unknown, callback: (decision: { cancel: boolean }) => void) => void): void
  }
  clearStorageData(): Promise<void>
  closeAllConnections(): Promise<void>
}

export interface ParserRendererDependencies {
  createWindow(options: Record<string, unknown>): ParserWindow
  createSession(partition: string): ParserSession
  createMessageChannel(): { port1: ParserPort; port2: ParserPort }
  workerHtmlPath: string
  preloadPath: string
  partitionId(): string
  processMemoryBytes(window: ParserWindow): Promise<number> | number
}

export interface ParserStartInput {
  readonly jobId: string
  readonly format: ParserFormat
  readonly objectPath: string
  readonly fileKey: Buffer
  readonly limits?: ParserLimits
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

interface ActiveParser {
  cancel(): void
  drained: Promise<void>
}

function terminal(jobId: string, code: Extract<ParserResponse, { type: 'error' }>['code']): ParserResponse {
  return { version: 1, type: 'error', jobId, code }
}

export class ParserSupervisor {
  private readonly active = new Set<ActiveParser>()

  constructor(private readonly dependencies: ParserRendererDependencies) {}

  async parse(input: ParserStartInput): Promise<ParserResponse> {
    const rejectBeforeTransfer = (code: Extract<ParserResponse, { type: 'error' }>['code']) => {
      input.fileKey.fill(0)
      return terminal(input.jobId, code)
    }
    if (input.fileKey.length !== 32) return rejectBeforeTransfer('PARSER_PROTOCOL_INVALID')
    const limits = input.limits ?? DEFAULT_PARSER_LIMITS
    const timeoutMs = input.timeoutMs ?? limits.timeoutMs
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > DEFAULT_PARSER_LIMITS.timeoutMs) {
      return rejectBeforeTransfer('PARSER_PROTOCOL_INVALID')
    }
    if (input.signal?.aborted) return rejectBeforeTransfer('PARSER_CANCELLED')

    let encrypted: Buffer
    try { encrypted = await readEncryptedObjectSnapshot(input.objectPath) } catch { return rejectBeforeTransfer('PARSER_MALFORMED_DOCUMENT') }
    if (input.signal?.aborted) {
      encrypted.fill(0)
      return rejectBeforeTransfer('PARSER_CANCELLED')
    }
    const partition = this.dependencies.partitionId()
    const parserSession = this.dependencies.createSession(partition)
    parserSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
      (_details, callback) => callback({ cancel: true }),
    )
    const parserWindow = this.dependencies.createWindow({
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        partition,
        preload: this.dependencies.preloadPath,
      },
    })
    parserWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    parserWindow.webContents.on('will-navigate', (event: { preventDefault(): void }) => event.preventDefault())
    const { port1, port2 } = this.dependencies.createMessageChannel()
    let cleaned = false
    let activeParser: ActiveParser | undefined
    let resolveDrained: () => void = () => undefined
    const drained = new Promise<void>((resolve) => { resolveDrained = resolve })
    const cleanup = async () => {
      if (cleaned) return
      cleaned = true
      try {
        port2.close()
        if (!parserWindow.isDestroyed()) parserWindow.destroy()
        await Promise.allSettled([parserSession.closeAllConnections(), parserSession.clearStorageData()])
      } finally {
        if (activeParser) this.active.delete(activeParser)
        resolveDrained()
      }
    }

    return new Promise<ParserResponse>((resolve) => {
      let settled = false
      const finish = (response: ParserResponse) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearInterval(memoryTimer)
        input.signal?.removeEventListener('abort', cancel)
        void cleanup().then(() => resolve(response))
      }
      const cancel = () => finish(terminal(input.jobId, 'PARSER_CANCELLED'))
      activeParser = { cancel, drained }
      this.active.add(activeParser)
      const timer = setTimeout(() => finish(terminal(input.jobId, 'PARSER_TIMEOUT')), timeoutMs)
      let checkingMemory = false
      const memoryTimer = setInterval(() => {
        if (checkingMemory || settled) return
        checkingMemory = true
        void Promise.resolve(this.dependencies.processMemoryBytes(parserWindow))
          .then(bytes => { if (bytes > limits.maxMemoryBytes) finish(terminal(input.jobId, 'PARSER_LIMIT_EXCEEDED')) })
          .catch(() => finish(terminal(input.jobId, 'PARSER_INTERNAL_ERROR')))
          .finally(() => { checkingMemory = false })
      }, 50)
      input.signal?.addEventListener('abort', cancel, { once: true })
      port2.on('message', (event: { data: unknown }) => {
        let response: ParserResponse
        try { response = parseParserResponse(event.data) } catch { response = terminal(input.jobId, 'PARSER_PROTOCOL_INVALID') }
        if (response.jobId !== input.jobId) response = terminal(input.jobId, 'PARSER_PROTOCOL_INVALID')
        finish(response)
      })
      port2.start()
      parserWindow.webContents.on('render-process-gone', () => finish(terminal(input.jobId, 'PARSER_INTERNAL_ERROR')))
      parserWindow.webContents.once('did-finish-load', () => {
        const encryptedBytes = Uint8Array.from(encrypted).buffer
        const fileKey = Uint8Array.from(input.fileKey).buffer
        encrypted.fill(0)
        input.fileKey.fill(0)
        parserWindow.webContents.postMessage('knowledge-parser:request', {
          version: 1, type: 'parse', jobId: input.jobId, format: input.format,
          encryptedBytes, fileKey, limits: { ...limits, timeoutMs },
        }, [port1])
      })
      void parserWindow.loadFile(this.dependencies.workerHtmlPath).catch(() => finish(terminal(input.jobId, 'PARSER_INTERNAL_ERROR')))
    })
  }

  async terminateAll(): Promise<void> {
    const active = [...this.active]
    for (const parser of active) parser.cancel()
    await Promise.allSettled(active.map(parser => parser.drained))
  }
}

export async function createElectronParserSupervisor(workerHtmlPath: string, preloadPath: string): Promise<ParserSupervisor> {
  const electron = await import('electron')
  return new ParserSupervisor({
    workerHtmlPath,
    preloadPath,
    partitionId: () => `autoforge-parser-${randomUUID()}`,
    processMemoryBytes: (window) => {
      const pid = window.webContents.getOSProcessId()
      const metric = electron.app.getAppMetrics().find(candidate => candidate.pid === pid)
      if (!metric) throw new Error('Parser renderer process metrics are unavailable')
      return metric.memory.peakWorkingSetSize * 1024
    },
    createSession: partition => electron.session.fromPartition(partition, { cache: false }) as unknown as ParserSession,
    createWindow: options => new electron.BrowserWindow(options) as unknown as ParserWindow,
    createMessageChannel: () => new electron.MessageChannelMain() as unknown as { port1: ParserPort; port2: ParserPort },
  })
}
