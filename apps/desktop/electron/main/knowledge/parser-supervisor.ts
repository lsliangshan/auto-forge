import type { EventEmitter } from 'node:events'
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_PARSER_LIMITS,
  PARSER_MEDIA_TYPES,
  clearParserResponseChunkBytes,
  parseParserRequest,
  parseParserResponseBytes,
  parseParserResponseChunk,
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
  setPermissionCheckHandler(handler: (contents: unknown, permission: string) => boolean): void
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

function isAllowedParserAsset(url: string, workerHtmlPath: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:' || parsed.search || parsed.hash) return false
    const candidate = resolve(fileURLToPath(parsed))
    if (candidate === resolve(workerHtmlPath)) return true
    const assetRoot = resolve(dirname(workerHtmlPath), '../../assets')
    if (dirname(candidate) !== assetRoot) return false
    return /^(?:knowledgeParser|schemas|decode|_commonjsHelpers|text|markdown|html|docx|pdf)-[A-Za-z0-9_-]+\.js$/.test(basename(candidate))
      || /^pdf\.worker-[A-Za-z0-9_-]+\.mjs$/.test(basename(candidate))
  } catch {
    return false
  }
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
    let deadlinePromise: Promise<never> | undefined
    let operationStopPromise: Promise<never> | undefined
    let rejectDeadline: ((error: ParserFailure) => void) | undefined
    let rejectOperation: ((error: ParserFailure) => void) | undefined
    let terminalCode: ParserErrorCode | undefined
    let cancelResponse: ((code: ParserErrorCode) => void) | undefined
    let deadlineAt = Number.POSITIVE_INFINITY
    let expireDeadline: (() => void) | undefined
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
      deadlinePromise = new Promise<never>((_resolve, reject) => { rejectDeadline = reject })
      operationStopPromise = new Promise<never>((_resolve, reject) => { rejectOperation = reject })
      let deadlineExpired = false
      deadlineAt = performance.now() + limits.timeoutMs
      expireDeadline = () => {
        if (deadlineExpired) return
        deadlineExpired = true
        const error = new ParserFailure('PARSER_TIMEOUT')
        if (!terminalCode) {
          terminalCode = 'PARSER_TIMEOUT'
          cancelResponse?.('PARSER_TIMEOUT')
          rejectOperation?.(error)
        }
        rejectDeadline?.(error)
      }
      const stopOperation = (code: ParserErrorCode) => {
        if (code === 'PARSER_TIMEOUT') {
          expireDeadline?.()
          return
        }
        if (terminalCode) return
        terminalCode = code
        const error = new ParserFailure(code)
        cancelResponse?.(code)
        rejectOperation?.(error)
      }
      abortListener = () => stopOperation('PARSER_CANCELLED')
      job.cancelActive = abortListener
      input.signal?.addEventListener('abort', abortListener, { once: true })
      timeoutTimer = setTimeout(expireDeadline, limits.timeoutMs)
      const ensureWithinDeadline = () => {
        if (performance.now() >= deadlineAt) expireDeadline?.()
      }
      const withinOperation = <T>(operation: Promise<T>): Promise<T> => Promise.race([
        operation,
        operationStopPromise!,
      ])
      if (cancelled()) abortListener()

      try {
        const brokerResult = Promise.resolve()
          .then(() => this.dependencies.resolveObject(input.objectHandle))
          .then((bytes) => {
            if (terminalCode || cancelled()) {
              bytes.fill(0)
              throw new ParserFailure(terminalCode ?? 'PARSER_CANCELLED')
            }
            return bytes
          })
        cleartext = await withinOperation(brokerResult)
        ensureWithinDeadline()
      } catch {
        if (cancelled()) fail('PARSER_CANCELLED')
        if (terminalCode) fail(terminalCode)
        fail('PARSER_MALFORMED_DOCUMENT')
      }
      if (terminalCode) fail(terminalCode)
      if (cancelled()) fail('PARSER_CANCELLED')
      if (!(cleartext instanceof Uint8Array)) fail('PARSER_INTERNAL_ERROR')
      if (cleartext.byteLength > limits.maxFileBytes) fail('PARSER_LIMIT_EXCEEDED')
      encryptedSnapshot = sealSnapshot(cleartext, input.oneTimeKey)
      ensureWithinDeadline()
      cleartext.fill(0)
      cleartext = undefined
      if (terminalCode) fail(terminalCode)
      if (encryptedSnapshot.byteLength > limits.maxEncryptedBytes) fail('PARSER_LIMIT_EXCEEDED')

      try {
        const partition = this.dependencies.partitionId()
        parserSession = this.dependencies.createSession(partition)
        parserSession.webRequest.onBeforeRequest(
          { urls: ['<all_urls>'] },
          (details, callback) => callback({
            cancel: !isAllowedParserAsset(details.url, this.dependencies.workerHtmlPath),
          }),
        )
        parserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
        parserSession.setPermissionCheckHandler(() => false)
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
      ensureWithinDeadline()
      if (terminalCode) fail(terminalCode)
      if (cancelled()) fail('PARSER_CANCELLED')

      const response = await withinOperation(new Promise<ParserResponse>((resolve, reject) => {
        let settled = false
        let responseBuffer: Uint8Array | undefined
        let responseOffset = 0
        let responseChunks = 0
        let responseChunkCount = 0
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
          if (memoryTimer) clearInterval(memoryTimer)
          responseBuffer?.fill(0)
          operation()
        }
        const rejectCode = (code: ParserErrorCode) => settle(() => reject(new ParserFailure(code)))
        cancelResponse = rejectCode
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
        port2?.on('message', (event: { data: unknown }) => {
          if (settled || terminalCode) {
            clearParserResponseChunkBytes(event.data)
            return
          }
          try {
            ensureWithinDeadline()
          } catch {
            clearParserResponseChunkBytes(event.data)
            rejectCode('PARSER_TIMEOUT')
            return
          }
          let chunk
          try {
            chunk = parseParserResponseChunk(event.data, limits.maxResponseBytes)
          } catch {
            clearParserResponseChunkBytes(event.data)
            rejectCode('PARSER_PROTOCOL_INVALID')
            return
          }
          if (!responseBuffer) {
            responseBuffer = new Uint8Array(chunk.totalBytes)
            responseChunkCount = chunk.totalChunks
          }
          if (
            chunk.index !== responseChunks
            || chunk.totalChunks !== responseChunkCount
            || chunk.totalBytes !== responseBuffer.byteLength
            || responseOffset + chunk.bytes.byteLength > responseBuffer.byteLength
          ) {
            clearParserResponseChunkBytes(event.data)
            rejectCode('PARSER_PROTOCOL_INVALID')
            return
          }
          const incomingBytes = new Uint8Array(
            chunk.bytes.buffer,
            chunk.bytes.byteOffset,
            chunk.bytes.byteLength,
          )
          responseBuffer.set(incomingBytes, responseOffset)
          incomingBytes.fill(0)
          responseOffset += chunk.bytes.byteLength
          responseChunks += 1
          if (responseChunks < responseChunkCount) return
          if (responseOffset !== responseBuffer.byteLength) {
            rejectCode('PARSER_PROTOCOL_INVALID')
            return
          }
          let parsed: ParserResponse
          try {
            parsed = parseParserResponseBytes(responseBuffer, {
              jobId: request.jobId,
              mediaType: input.mediaType,
              limits,
            })
          } catch {
            rejectCode('PARSER_PROTOCOL_INVALID')
            return
          } finally {
            responseBuffer.fill(0)
          }
          if (parsed.type === 'error') rejectCode(parsed.code)
          else settle(() => resolve(parsed))
        })
        port2?.start()
        parserWindow?.webContents.on('render-process-gone', () => rejectCode('PARSER_INTERNAL_ERROR'))
        parserWindow?.webContents.on('unresponsive', () => rejectCode('PARSER_INTERNAL_ERROR'))

        parserWindow?.webContents.once('did-finish-load', () => {
          ensureWithinDeadline()
          if (settled || terminalCode || cancelled() || !encryptedSnapshot || !parserWindow || !port1) return
          try {
            request.encryptedSnapshot = Uint8Array.from(encryptedSnapshot).buffer
            request.oneTimeKey = Uint8Array.from(input.oneTimeKey).buffer
            encryptedSnapshot.fill(0)
            input.oneTimeKey.fill(0)
            parserWindow.webContents.postMessage('knowledge-parser:request', request, [port1])
          } catch {
            rejectCode('PARSER_INTERNAL_ERROR')
          } finally {
            clearArrayBuffer(request.encryptedSnapshot)
            clearArrayBuffer(request.oneTimeKey)
          }
        })
        try {
          void parserWindow?.loadFile(this.dependencies.workerHtmlPath)
            .catch(() => rejectCode('PARSER_INTERNAL_ERROR'))
        } catch {
          rejectCode('PARSER_INTERNAL_ERROR')
        }
      }))
      if (response.type === 'error') fail(response.code)
      return response.document
    } catch (error) {
      if (error instanceof ParserFailure) throw error
      throw new ParserFailure('PARSER_INTERNAL_ERROR')
    } finally {
      if (memoryTimer) clearInterval(memoryTimer)
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
      const cleanupPromise = Promise.allSettled(cleanup.map(async (operation) => {
        try {
          await operation()
        } catch {
          // Cleanup is best effort, but every independent action is attempted.
        }
      }))
      if (performance.now() >= deadlineAt) expireDeadline?.()
      let cleanupTimedOut = false
      try {
        if (deadlinePromise) await Promise.race([cleanupPromise, deadlinePromise])
        else await cleanupPromise
      } catch (error) {
        cleanupTimedOut = error instanceof ParserFailure && error.code === 'PARSER_TIMEOUT'
      }
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (abortListener) input.signal?.removeEventListener('abort', abortListener)
      job.cancelActive = undefined
      cancelResponse = undefined
      this.jobs.delete(job)
      job.drain()
      if (cleanupTimedOut) throw new ParserFailure('PARSER_TIMEOUT')
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
