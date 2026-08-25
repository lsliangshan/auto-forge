import { randomUUID } from 'node:crypto'
import type { EventEmitter } from 'node:events'
import { DEFAULT_PARSER_LIMITS, parseParserRequest, parseParserResponse, type ParserFormat, type ParserLimits, type ParserResponse } from './parser-protocol.js'
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
  readEncryptedSnapshot(path: string): Promise<Buffer>
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

interface ParserJob {
  cancelled: boolean
  cancelActive?: () => void
  readonly drained: Promise<void>
  drain(): void
}

function terminal(jobId: string, code: Extract<ParserResponse, { type: 'error' }>['code']): ParserResponse {
  return { version: 1, type: 'error', jobId, code }
}

function clearArrayBuffer(buffer: ArrayBuffer | undefined): void {
  if (buffer && buffer.byteLength > 0) new Uint8Array(buffer).fill(0)
}

export class ParserSupervisor {
  private readonly jobs = new Set<ParserJob>()
  private state: 'open' | 'closing' | 'closed' = 'open'
  private closing: Promise<void> | undefined

  constructor(private readonly dependencies: ParserRendererDependencies) {}

  async parse(input: ParserStartInput): Promise<ParserResponse> {
    if (this.state !== 'open') {
      input.fileKey.fill(0)
      return terminal(input.jobId, 'PARSER_CANCELLED')
    }

    let resolveDrained!: () => void
    const job: ParserJob = {
      cancelled: false,
      drained: new Promise(resolve => { resolveDrained = resolve }),
      drain: () => resolveDrained(),
    }
    this.jobs.add(job)

    let encrypted: Buffer | undefined
    let parserSession: ParserSession | undefined
    let parserWindow: ParserWindow | undefined
    let port1: ParserPort | undefined
    let port2: ParserPort | undefined
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    let memoryTimer: ReturnType<typeof setInterval> | undefined
    let cancelListener: (() => void) | undefined
    const cancelled = () => job.cancelled || this.state !== 'open' || input.signal?.aborted === true

    try {
      if (input.fileKey.length !== 32) return terminal(input.jobId, 'PARSER_PROTOCOL_INVALID')
      let limits: ParserLimits
      try {
        limits = parseParserRequest({
          version: 1, type: 'parse', jobId: input.jobId, format: input.format,
          encryptedBytes: new ArrayBuffer(1), fileKey: new ArrayBuffer(32),
          limits: input.limits ?? DEFAULT_PARSER_LIMITS,
        }).limits
      } catch {
        return terminal(input.jobId, 'PARSER_PROTOCOL_INVALID')
      }
      const timeoutMs = input.timeoutMs ?? limits.timeoutMs
      if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > DEFAULT_PARSER_LIMITS.timeoutMs) {
        return terminal(input.jobId, 'PARSER_PROTOCOL_INVALID')
      }
      if (cancelled()) return terminal(input.jobId, 'PARSER_CANCELLED')

      try {
        encrypted = await this.dependencies.readEncryptedSnapshot(input.objectPath)
      } catch {
        return cancelled() ? terminal(input.jobId, 'PARSER_CANCELLED') : terminal(input.jobId, 'PARSER_MALFORMED_DOCUMENT')
      }
      if (cancelled()) return terminal(input.jobId, 'PARSER_CANCELLED')
      if (encrypted.byteLength > limits.maxEncryptedBytes) return terminal(input.jobId, 'PARSER_LIMIT_EXCEEDED')

      try {
        const partition = this.dependencies.partitionId()
        parserSession = this.dependencies.createSession(partition)
        parserSession.webRequest.onBeforeRequest(
          { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
          (_details, callback) => callback({ cancel: true }),
        )
        parserWindow = this.dependencies.createWindow({
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
        const channel = this.dependencies.createMessageChannel()
        port1 = channel.port1
        port2 = channel.port2
      } catch {
        return terminal(input.jobId, 'PARSER_INTERNAL_ERROR')
      }
      if (cancelled()) return terminal(input.jobId, 'PARSER_CANCELLED')

      return await new Promise<ParserResponse>((resolve) => {
        let settled = false
        const finish = (value: ParserResponse) => {
          if (settled) return
          settled = true
          if (timeoutTimer) clearTimeout(timeoutTimer)
          if (memoryTimer) clearInterval(memoryTimer)
          if (cancelListener) input.signal?.removeEventListener('abort', cancelListener)
          job.cancelActive = undefined
          resolve(value)
        }
        cancelListener = () => finish(terminal(input.jobId, 'PARSER_CANCELLED'))
        job.cancelActive = cancelListener
        if (cancelled()) {
          cancelListener()
          return
        }

        timeoutTimer = setTimeout(() => finish(terminal(input.jobId, 'PARSER_TIMEOUT')), timeoutMs)
        let checkingMemory = false
        memoryTimer = setInterval(() => {
          if (checkingMemory || settled || !parserWindow) return
          checkingMemory = true
          void Promise.resolve(this.dependencies.processMemoryBytes(parserWindow))
            .then(bytes => { if (bytes > limits.maxMemoryBytes) finish(terminal(input.jobId, 'PARSER_LIMIT_EXCEEDED')) })
            .catch(() => finish(terminal(input.jobId, 'PARSER_INTERNAL_ERROR')))
            .finally(() => { checkingMemory = false })
        }, 50)
        input.signal?.addEventListener('abort', cancelListener, { once: true })
        port2?.on('message', (event: { data: unknown }) => {
          let parsed: ParserResponse
          try { parsed = parseParserResponse(event.data, { jobId: input.jobId, format: input.format, limits }) } catch { parsed = terminal(input.jobId, 'PARSER_PROTOCOL_INVALID') }
          finish(parsed)
        })
        port2?.start()
        parserWindow?.webContents.on('render-process-gone', () => finish(terminal(input.jobId, 'PARSER_INTERNAL_ERROR')))
        parserWindow?.webContents.once('did-finish-load', () => {
          if (settled || cancelled() || !encrypted || !parserWindow || !port1) return
          let encryptedBytes: ArrayBuffer | undefined
          let fileKey: ArrayBuffer | undefined
          try {
            encryptedBytes = Uint8Array.from(encrypted).buffer
            fileKey = Uint8Array.from(input.fileKey).buffer
            encrypted.fill(0)
            input.fileKey.fill(0)
            parserWindow.webContents.postMessage('knowledge-parser:request', {
              version: 1, type: 'parse', jobId: input.jobId, format: input.format,
              encryptedBytes, fileKey, limits: { ...limits, timeoutMs },
            }, [port1])
          } catch {
            finish(terminal(input.jobId, 'PARSER_INTERNAL_ERROR'))
          } finally {
            clearArrayBuffer(encryptedBytes)
            clearArrayBuffer(fileKey)
          }
        })
        try {
          void parserWindow?.loadFile(this.dependencies.workerHtmlPath).catch(() => finish(terminal(input.jobId, 'PARSER_INTERNAL_ERROR')))
        } catch {
          finish(terminal(input.jobId, 'PARSER_INTERNAL_ERROR'))
        }
      })
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (memoryTimer) clearInterval(memoryTimer)
      if (cancelListener) input.signal?.removeEventListener('abort', cancelListener)
      input.fileKey.fill(0)
      encrypted?.fill(0)
      const attempts: Array<() => void | Promise<void>> = []
      if (port1) attempts.push(() => port1?.close())
      if (port2) attempts.push(() => port2?.close())
      if (parserWindow) attempts.push(() => {
        let destroyed = false
        try { destroyed = parserWindow?.isDestroyed() ?? true } catch { /* still attempt destroy */ }
        if (!destroyed) parserWindow?.destroy()
      })
      if (parserSession) {
        attempts.push(() => parserSession?.closeAllConnections())
        attempts.push(() => parserSession?.clearStorageData())
      }
      await Promise.all(attempts.map(async attempt => {
        try { await attempt() } catch { /* cleanup is best effort but every action is attempted */ }
      }))
      this.jobs.delete(job)
      job.drain()
    }
  }

  terminateAll(): Promise<void> {
    if (this.closing) return this.closing
    this.state = 'closing'
    const jobs = [...this.jobs]
    for (const job of jobs) {
      job.cancelled = true
      job.cancelActive?.()
    }
    this.closing = Promise.allSettled(jobs.map(job => job.drained)).then(() => { this.state = 'closed' })
    return this.closing
  }
}

export async function createElectronParserSupervisor(workerHtmlPath: string, preloadPath: string): Promise<ParserSupervisor> {
  const electron = await import('electron')
  return new ParserSupervisor({
    workerHtmlPath,
    preloadPath,
    readEncryptedSnapshot: readEncryptedObjectSnapshot,
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
