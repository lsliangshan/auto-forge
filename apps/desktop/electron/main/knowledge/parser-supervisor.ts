import type { EventEmitter } from 'node:events'
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import {
  DEFAULT_PARSER_LIMITS,
  PARSER_MEDIA_TYPES,
  parseParserRequest,
  parseParserResponse,
  type ParsedDocument,
  type ParserErrorCode,
  type ParserLimits,
  type ParserMediaType,
  type ParserResponse,
} from './parser-protocol.js'

const OBJECT_HANDLE_PATTERN = /^[0-9a-f]{32}$/
const SNAPSHOT_MAGIC = Buffer.from('AFKBSNP1', 'ascii')
const NONCE_BYTES = 12

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
  readonly webContents: ParserWebContents
  loadFile(path: string): Promise<void>
  destroy(): void
  isDestroyed(): boolean
}

interface ParserSession extends EventEmitter {
  readonly webRequest: {
    onBeforeRequest(
      filter: { urls: string[] },
      handler: (details: { url: string }, callback: (decision: { cancel: boolean }) => void) => void,
    ): void
  }
  setPermissionRequestHandler(
    handler: (contents: unknown, permission: string, callback: (allowed: boolean) => void) => void,
  ): void
  clearStorageData(): Promise<void>
  closeAllConnections(): Promise<void>
}

export interface ParserRendererDependencies {
  createWindow(options: Record<string, unknown>): ParserWindow
  createSession(partition: string): ParserSession
  createMessageChannel(): { port1: ParserPort; port2: ParserPort }
  resolveObject(objectHandle: string): Promise<Uint8Array>
  readonly workerHtmlPath: string
  readonly preloadPath: string
  partitionId(): string
  processMemoryBytes(window: ParserWindow): Promise<number> | number
}

export interface ParserStartInput {
  readonly objectHandle: string
  readonly oneTimeKey: Buffer
  readonly mediaType: ParserMediaType
  readonly limits?: ParserLimits
  readonly signal?: AbortSignal
}

export class ParserFailure extends Error {
  constructor(readonly code: ParserErrorCode) {
    super(code)
  }
}

interface ActiveJob {
  cancelled: boolean
  cancelActive?: () => void
  readonly drained: Promise<void>
  drain(): void
}

function clearArrayBuffer(value: ArrayBuffer | undefined): void {
  if (value && value.byteLength > 0) new Uint8Array(value).fill(0)
}

function fail(code: ParserErrorCode): never {
  throw new ParserFailure(code)
}

function validatedLimits(input: ParserStartInput): ParserLimits {
  try {
    return parseParserRequest({
      version: 1,
      type: 'parse',
      jobId: 'limit-validation',
      mediaType: input.mediaType,
      encryptedSnapshot: new ArrayBuffer(1),
      oneTimeKey: new ArrayBuffer(32),
      limits: input.limits ?? DEFAULT_PARSER_LIMITS,
    }).limits
  } catch {
    fail('PARSER_PROTOCOL_INVALID')
  }
}

function sealSnapshot(cleartext: Uint8Array, key: Buffer): Buffer {
  const nonce = randomBytes(NONCE_BYTES)
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(SNAPSHOT_MAGIC)
    return Buffer.concat([
      SNAPSHOT_MAGIC,
      nonce,
      cipher.update(cleartext),
      cipher.final(),
      cipher.getAuthTag(),
    ])
  } finally {
    nonce.fill(0)
  }
}

export class ParserSupervisor {
  private readonly jobs = new Set<ActiveJob>()
  private state: 'open' | 'closing' | 'closed' = 'open'
  private closing: Promise<void> | undefined

  constructor(private readonly dependencies: ParserRendererDependencies) {}

  async parse(input: ParserStartInput): Promise<ParsedDocument> {
    if (this.state !== 'open') {
      input.oneTimeKey.fill(0)
      fail('PARSER_CANCELLED')
    }

    let resolveDrained!: () => void
    const job: ActiveJob = {
      cancelled: false,
      drained: new Promise(resolve => { resolveDrained = resolve }),
      drain: () => resolveDrained(),
    }
    this.jobs.add(job)

    let cleartext: Uint8Array | undefined
    let encryptedSnapshot: Buffer | undefined
    let parserSession: ParserSession | undefined
    let parserWindow: ParserWindow | undefined
    let port1: ParserPort | undefined
    let port2: ParserPort | undefined
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    let memoryTimer: ReturnType<typeof setInterval> | undefined
    let abortListener: (() => void) | undefined
    const cancelled = () => job.cancelled || this.state !== 'open' || input.signal?.aborted === true

    try {
      if (!Buffer.isBuffer(input.oneTimeKey) || input.oneTimeKey.length !== 32) {
        fail('PARSER_PROTOCOL_INVALID')
      }
      if (!OBJECT_HANDLE_PATTERN.test(input.objectHandle)) fail('PARSER_PROTOCOL_INVALID')
      if (!(PARSER_MEDIA_TYPES as readonly unknown[]).includes(input.mediaType)) {
        fail('PARSER_UNSUPPORTED_FORMAT')
      }
      const limits = validatedLimits(input)
      if (cancelled()) fail('PARSER_CANCELLED')

      try {
        cleartext = await this.dependencies.resolveObject(input.objectHandle)
      } catch {
        if (cancelled()) fail('PARSER_CANCELLED')
        fail('PARSER_MALFORMED_DOCUMENT')
      }
      if (cancelled()) fail('PARSER_CANCELLED')
      if (!(cleartext instanceof Uint8Array)) fail('PARSER_INTERNAL_ERROR')
      if (cleartext.byteLength > limits.maxFileBytes) fail('PARSER_LIMIT_EXCEEDED')
      encryptedSnapshot = sealSnapshot(cleartext, input.oneTimeKey)
      cleartext.fill(0)
      cleartext = undefined
      if (encryptedSnapshot.byteLength > limits.maxEncryptedBytes) fail('PARSER_LIMIT_EXCEEDED')

      try {
        const partition = this.dependencies.partitionId()
        parserSession = this.dependencies.createSession(partition)
        parserSession.webRequest.onBeforeRequest(
          { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] },
          (_details, callback) => callback({ cancel: true }),
        )
        parserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
        parserSession.on('will-download', (event: { preventDefault(): void }) => event.preventDefault())
        parserWindow = this.dependencies.createWindow({
          show: false,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            webviewTag: false,
            allowRunningInsecureContent: false,
            backgroundThrottling: false,
            enableWebSQL: false,
            spellcheck: false,
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
        fail('PARSER_INTERNAL_ERROR')
      }
      if (cancelled()) fail('PARSER_CANCELLED')

      const response = await new Promise<ParserResponse>((resolve, reject) => {
        let settled = false
        const request = {
          version: 1,
          type: 'parse',
          jobId: randomUUID(),
          mediaType: input.mediaType,
          encryptedSnapshot: undefined as ArrayBuffer | undefined,
          oneTimeKey: undefined as ArrayBuffer | undefined,
          limits,
        }
        const settle = (operation: () => void) => {
          if (settled) return
          settled = true
          if (timeoutTimer) clearTimeout(timeoutTimer)
          if (memoryTimer) clearInterval(memoryTimer)
          if (abortListener) input.signal?.removeEventListener('abort', abortListener)
          job.cancelActive = undefined
          operation()
        }
        const rejectCode = (code: ParserErrorCode) => settle(() => reject(new ParserFailure(code)))
        abortListener = () => rejectCode('PARSER_CANCELLED')
        job.cancelActive = abortListener
        if (cancelled()) {
          abortListener()
          return
        }

        timeoutTimer = setTimeout(() => rejectCode('PARSER_TIMEOUT'), limits.timeoutMs)
        let checkingMemory = false
        memoryTimer = setInterval(() => {
          if (checkingMemory || settled || !parserWindow) return
          checkingMemory = true
          void Promise.resolve(this.dependencies.processMemoryBytes(parserWindow))
            .then((bytes) => {
              if (bytes > limits.maxMemoryBytes) rejectCode('PARSER_LIMIT_EXCEEDED')
            })
            .catch(() => rejectCode('PARSER_INTERNAL_ERROR'))
            .finally(() => { checkingMemory = false })
        }, 25)
        input.signal?.addEventListener('abort', abortListener, { once: true })
        port2?.on('message', (event: { data: unknown }) => {
          let parsed: ParserResponse
          try {
            parsed = parseParserResponse(event.data, {
              jobId: request.jobId,
              mediaType: input.mediaType,
              limits,
            })
          } catch {
            rejectCode('PARSER_PROTOCOL_INVALID')
            return
          }
          if (parsed.type === 'error') rejectCode(parsed.code)
          else settle(() => resolve(parsed))
        })
        port2?.start()
        parserWindow?.webContents.on('render-process-gone', () => rejectCode('PARSER_INTERNAL_ERROR'))
        parserWindow?.webContents.on('unresponsive', () => rejectCode('PARSER_INTERNAL_ERROR'))

        parserWindow?.webContents.once('did-finish-load', () => {
          if (settled || cancelled() || !encryptedSnapshot || !parserWindow || !port1) return
          try {
            request.encryptedSnapshot = Uint8Array.from(encryptedSnapshot).buffer
            request.oneTimeKey = Uint8Array.from(input.oneTimeKey).buffer
            encryptedSnapshot.fill(0)
            input.oneTimeKey.fill(0)
            parserWindow.webContents.postMessage('knowledge-parser:request', request, [port1])
          } catch {
            rejectCode('PARSER_INTERNAL_ERROR')
          }
        })
        try {
          void parserWindow?.loadFile(this.dependencies.workerHtmlPath)
            .catch(() => rejectCode('PARSER_INTERNAL_ERROR'))
        } catch {
          rejectCode('PARSER_INTERNAL_ERROR')
        }
      })
      if (response.type === 'error') fail(response.code)
      return response.document
    } catch (error) {
      if (error instanceof ParserFailure) throw error
      throw new ParserFailure('PARSER_INTERNAL_ERROR')
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (memoryTimer) clearInterval(memoryTimer)
      if (abortListener) input.signal?.removeEventListener('abort', abortListener)
      input.oneTimeKey.fill(0)
      cleartext?.fill(0)
      encryptedSnapshot?.fill(0)
      const cleanup: Array<() => void | Promise<void>> = []
      if (port1) cleanup.push(() => port1?.close())
      if (port2) cleanup.push(() => port2?.close())
      if (parserWindow) cleanup.push(() => {
        let destroyed = false
        try {
          destroyed = parserWindow?.isDestroyed() ?? true
        } catch {
          // Still attempt destruction below.
        }
        if (!destroyed) parserWindow?.destroy()
      })
      if (parserSession) {
        cleanup.push(() => parserSession?.closeAllConnections())
        cleanup.push(() => parserSession?.clearStorageData())
      }
      await Promise.all(cleanup.map(async (operation) => {
        try {
          await operation()
        } catch {
          // Cleanup is best effort, but every independent action is attempted.
        }
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
    this.closing = Promise.allSettled(jobs.map(job => job.drained)).then(() => {
      this.state = 'closed'
    })
    return this.closing
  }
}

export interface ElectronParserSupervisorOptions {
  readonly workerHtmlPath: string
  readonly preloadPath: string
  readonly resolveObject: (objectHandle: string) => Promise<Uint8Array>
}

export async function createElectronParserSupervisor(
  options: ElectronParserSupervisorOptions,
): Promise<ParserSupervisor> {
  const [worker, preload] = await Promise.all([
    stat(options.workerHtmlPath),
    stat(options.preloadPath),
  ])
  if (!worker.isFile() || !preload.isFile()) throw new Error('Knowledge parser assets must be regular files')
  const electron = await import('electron')
  return new ParserSupervisor({
    workerHtmlPath: options.workerHtmlPath,
    preloadPath: options.preloadPath,
    resolveObject: options.resolveObject,
    partitionId: () => `autoforge-parser-${randomUUID()}`,
    processMemoryBytes: (window) => {
      const pid = window.webContents.getOSProcessId()
      const metric = electron.app.getAppMetrics().find(candidate => candidate.pid === pid)
      if (!metric) throw new Error('Knowledge parser process metrics are unavailable')
      return metric.memory.peakWorkingSetSize * 1024
    },
    createSession: partition => electron.session.fromPartition(partition, { cache: false }) as unknown as ParserSession,
    createWindow: settings => new electron.BrowserWindow(settings) as unknown as ParserWindow,
    createMessageChannel: () => new electron.MessageChannelMain() as unknown as {
      port1: ParserPort
      port2: ParserPort
    },
  })
}
