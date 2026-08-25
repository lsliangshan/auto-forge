import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEncryptedObjectSnapshot, unwrapSnapshotFileKey } from './encrypted-object-store.js'
import { DEFAULT_PARSER_LIMITS } from './parser-protocol.js'
import {
  createElectronParserSupervisor,
  ParserSupervisor,
  type ParserRendererDependencies,
} from './parser-supervisor.js'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map(async path => (await import('node:fs/promises')).rm(path, { recursive: true, force: true }))))

class FakePort extends EventEmitter {
  close = vi.fn()
  start = vi.fn()
  postMessage = vi.fn()
}

async function harness(response?: unknown, options: { readEncryptedSnapshot?: () => Promise<Buffer> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'autoforge-supervisor-'))
  directories.push(directory)
  const sourcePath = join(directory, 'source.txt')
  const objectPath = join(directory, 'object')
  const userKey = randomBytes(32)
  await writeFile(sourcePath, 'sandbox text')
  const snapshot = await createEncryptedObjectSnapshot({ sourcePath, objectPath, userKey })
  const fileKey = unwrapSnapshotFileKey(snapshot.wrappedFileKey, userKey)
  userKey.fill(0)

  const port1 = new FakePort()
  const port2 = new FakePort()
  const webContents = new EventEmitter() as EventEmitter & {
    setWindowOpenHandler: ReturnType<typeof vi.fn<(handler: () => { action: 'deny' }) => void>>
    postMessage: ReturnType<typeof vi.fn<(channel: string, data: unknown, transfer: FakePort[]) => void>>
    getOSProcessId: ReturnType<typeof vi.fn<() => number>>
  }
  webContents.setWindowOpenHandler = vi.fn<(handler: () => { action: 'deny' }) => void>()
  webContents.postMessage = vi.fn<(channel: string, data: unknown, transfer: FakePort[]) => void>((_channel, data) => {
    if (response) queueMicrotask(() => port2.emit('message', { data: typeof response === 'function' ? response(data) : response }))
  })
  webContents.getOSProcessId = vi.fn(() => 123)
  const window = {
    webContents,
    loadFile: vi.fn(async () => { webContents.emit('did-finish-load') }),
    destroy: vi.fn(),
    isDestroyed: vi.fn(() => false),
  }
  let networkHandler: ((details: unknown, callback: (decision: { cancel: boolean }) => void) => void) | undefined
  const parserSession = {
    webRequest: { onBeforeRequest: vi.fn((_filter, handler) => { networkHandler = handler }) },
    clearStorageData: vi.fn(async () => undefined),
    closeAllConnections: vi.fn(async () => undefined),
  }
  const createWindow = vi.fn(() => window)
  const processMemoryBytes = vi.fn(async () => 1)
  const dependencies: ParserRendererDependencies = {
    createWindow,
    createSession: vi.fn(() => parserSession),
    createMessageChannel: vi.fn(() => ({ port1, port2 })),
    workerHtmlPath: '/app/out/renderer/parser-worker.html',
    preloadPath: '/app/out/preload/parser.cjs',
    partitionId: () => 'autoforge-parser-test-unique',
    processMemoryBytes,
    readEncryptedSnapshot: options.readEncryptedSnapshot ?? (async () => readFile(objectPath)),
  }
  return { supervisor: new ParserSupervisor(dependencies), createWindow, window, webContents, parserSession, processMemoryBytes, port1, port2, objectPath, fileKey, getNetworkHandler: () => networkHandler }
}

describe('sandbox parser supervisor', () => {
  it('creates a hidden isolated sandbox window and cancels every network/navigation/window attempt', async () => {
    const h = await harness({ version: 1, type: 'error', jobId: 'job-boundary', code: 'PARSER_MALFORMED_DOCUMENT' })
    const promise = h.supervisor.parse({ jobId: 'job-boundary', format: 'txt', objectPath: h.objectPath, fileKey: h.fileKey })
    await promise
    expect(h.createWindow).toHaveBeenCalledWith(expect.objectContaining({
      show: false,
      webPreferences: expect.objectContaining({ nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, partition: 'autoforge-parser-test-unique', preload: '/app/out/preload/parser.cjs' }),
    }))
    const decision = vi.fn()
    h.getNetworkHandler()?.({ url: 'https://evil.test' }, decision)
    expect(decision).toHaveBeenCalledWith({ cancel: true })
    const navigation = { preventDefault: vi.fn() }
    h.webContents.emit('will-navigate', navigation)
    expect(navigation.preventDefault).toHaveBeenCalled()
    expect(h.webContents.setWindowOpenHandler).toHaveBeenCalled()
    expect(h.webContents.setWindowOpenHandler.mock.calls[0]?.[0]()).toEqual({ action: 'deny' })
  })

  it('transfers only encrypted bytes, one-time key, bounded metadata and tears down on result', async () => {
    const h = await harness((request: { jobId: string }) => ({ version: 1, type: 'error', jobId: request.jobId, code: 'PARSER_MALFORMED_DOCUMENT' }))
    await h.supervisor.parse({ jobId: 'job-secret-free', format: 'txt', objectPath: h.objectPath, fileKey: h.fileKey })
    const sent = h.webContents.postMessage.mock.calls[0]?.[1] as Record<string, unknown>
    expect(Object.keys(sent).sort()).toEqual(['encryptedBytes', 'fileKey', 'format', 'jobId', 'limits', 'type', 'version'])
    expect(JSON.stringify(sent)).not.toContain(h.objectPath)
    expect(JSON.stringify(sent)).not.toMatch(/master|safeStorage|cloudbase|provider|env/i)
    expect(h.webContents.postMessage.mock.calls[0]?.[2]).toEqual([h.port1])
    expect(h.window.destroy).toHaveBeenCalledOnce()
    expect(h.port1.close).toHaveBeenCalledOnce()
    expect(h.port2.close).toHaveBeenCalledOnce()
    expect(h.parserSession.clearStorageData).toHaveBeenCalledOnce()
    expect(h.parserSession.closeAllConnections).toHaveBeenCalledOnce()
  })

  it('kills and drains the renderer on timeout and cancellation', async () => {
    const timed = await harness()
    const timeoutPromise = timed.supervisor.parse({ jobId: 'job-timeout', format: 'txt', objectPath: timed.objectPath, fileKey: timed.fileKey, timeoutMs: 100 })
    await expect(timeoutPromise).resolves.toMatchObject({ type: 'error', code: 'PARSER_TIMEOUT' })
    expect(timed.window.destroy).toHaveBeenCalledOnce()
    expect(timed.port2.close).toHaveBeenCalledOnce()

    const cancelled = await harness()
    const controller = new AbortController()
    const cancelPromise = cancelled.supervisor.parse({ jobId: 'job-cancel', format: 'txt', objectPath: cancelled.objectPath, fileKey: cancelled.fileKey, signal: controller.signal })
    await vi.waitFor(() => expect(cancelled.webContents.postMessage).toHaveBeenCalledOnce())
    controller.abort()
    await expect(cancelPromise).resolves.toMatchObject({ type: 'error', code: 'PARSER_CANCELLED' })
    expect(cancelled.window.destroy).toHaveBeenCalledOnce()
    expect(cancelled.port2.close).toHaveBeenCalledOnce()
  })

  it('clears a one-time file key when cancellation wins before renderer creation', async () => {
    const h = await harness()
    const controller = new AbortController()
    controller.abort()
    await expect(h.supervisor.parse({ jobId: 'job-pre-cancel', format: 'txt', objectPath: h.objectPath, fileKey: h.fileKey, signal: controller.signal })).resolves.toMatchObject({ code: 'PARSER_CANCELLED' })
    expect(h.fileKey.every(byte => byte === 0)).toBe(true)
    expect(h.createWindow).not.toHaveBeenCalled()
  })

  it('cancels and drains every active renderer during supervisor shutdown', async () => {
    const h = await harness()
    const parse = h.supervisor.parse({ jobId: 'job-shutdown', format: 'txt', objectPath: h.objectPath, fileKey: h.fileKey, timeoutMs: 200 })
    await vi.waitFor(() => expect(h.webContents.postMessage).toHaveBeenCalledOnce())
    await h.supervisor.terminateAll()
    await expect(parse).resolves.toMatchObject({ type: 'error', code: 'PARSER_CANCELLED' })
    expect(h.window.destroy).toHaveBeenCalledOnce()
    expect(h.port2.close).toHaveBeenCalledOnce()
  })

  it('tracks jobs before snapshot I/O and never launches a renderer after shutdown', async () => {
    let releaseRead!: (value: Buffer) => void
    const encrypted = Buffer.alloc(64, 9)
    const h = await harness(undefined, { readEncryptedSnapshot: () => new Promise(resolve => { releaseRead = resolve }) })
    const parse = h.supervisor.parse({ jobId: 'job-starting', format: 'txt', objectPath: h.objectPath, fileKey: h.fileKey })
    await vi.waitFor(() => expect(releaseRead).toBeTypeOf('function'))
    let shutdownFinished = false
    const shutdown = h.supervisor.terminateAll().then(() => { shutdownFinished = true })
    await Promise.resolve()
    expect(shutdownFinished).toBe(false)
    releaseRead(encrypted)
    await shutdown
    await expect(parse).resolves.toMatchObject({ type: 'error', code: 'PARSER_CANCELLED' })
    expect(h.createWindow).not.toHaveBeenCalled()
    expect(h.fileKey.every(byte => byte === 0)).toBe(true)
    expect(encrypted.every(byte => byte === 0)).toBe(true)

    const laterKey = Buffer.alloc(32, 4)
    await expect(h.supervisor.parse({ jobId: 'job-after-close', format: 'txt', objectPath: h.objectPath, fileKey: laterKey })).resolves.toMatchObject({ code: 'PARSER_CANCELLED' })
    expect(laterKey.every(byte => byte === 0)).toBe(true)
    expect(h.createWindow).not.toHaveBeenCalled()
  })

  it('clears secrets and ignores late load after load or renderer failure', async () => {
    const load = await harness()
    load.window.loadFile.mockImplementation(() => new Promise(() => undefined))
    const encrypted = await readFile(load.objectPath)
    ;(load.supervisor as unknown as { dependencies: ParserRendererDependencies }).dependencies.readEncryptedSnapshot = async () => encrypted
    const pending = load.supervisor.parse({ jobId: 'job-load-timeout', format: 'txt', objectPath: load.objectPath, fileKey: load.fileKey, timeoutMs: 100 })
    await expect(pending).resolves.toMatchObject({ code: 'PARSER_TIMEOUT' })
    expect(load.fileKey.every(byte => byte === 0)).toBe(true)
    expect(encrypted.every(byte => byte === 0)).toBe(true)
    load.webContents.emit('did-finish-load')
    expect(load.webContents.postMessage).not.toHaveBeenCalled()

    const gone = await harness()
    gone.window.loadFile.mockImplementation(async () => { gone.webContents.emit('render-process-gone') })
    await expect(gone.supervisor.parse({ jobId: 'job-gone', format: 'txt', objectPath: gone.objectPath, fileKey: gone.fileKey })).resolves.toMatchObject({ code: 'PARSER_INTERNAL_ERROR' })
    expect(gone.fileKey.every(byte => byte === 0)).toBe(true)

    const rejectedBytes = Buffer.alloc(64, 3)
    const rejected = await harness(undefined, { readEncryptedSnapshot: async () => rejectedBytes })
    rejected.window.loadFile.mockRejectedValue(new Error('load failed'))
    await expect(rejected.supervisor.parse({ jobId: 'job-load-failed', format: 'txt', objectPath: rejected.objectPath, fileKey: rejected.fileKey })).resolves.toMatchObject({ code: 'PARSER_INTERNAL_ERROR' })
    expect(rejected.fileKey.every(byte => byte === 0)).toBe(true)
    expect(rejectedBytes.every(byte => byte === 0)).toBe(true)
  })

  it('clears the one-time key when session/window/channel construction fails', async () => {
    const h = await harness()
    h.createWindow.mockImplementation(() => { throw new Error('window construction') })
    await expect(h.supervisor.parse({ jobId: 'job-construction', format: 'txt', objectPath: h.objectPath, fileKey: h.fileKey })).resolves.toMatchObject({ code: 'PARSER_INTERNAL_ERROR' })
    expect(h.fileKey.every(byte => byte === 0)).toBe(true)
    expect(h.parserSession.closeAllConnections).toHaveBeenCalledOnce()
    expect(h.parserSession.clearStorageData).toHaveBeenCalledOnce()
  })

  it('settles while attempting every cleanup action even when cleanup throws', async () => {
    const h = await harness({ version: 1, type: 'error', jobId: 'job-cleanup', code: 'PARSER_MALFORMED_DOCUMENT' })
    h.port1.close.mockImplementation(() => { throw new Error('port1 close') })
    h.port2.close.mockImplementation(() => { throw new Error('port2 close') })
    h.window.destroy.mockImplementation(() => { throw new Error('destroy') })
    h.parserSession.closeAllConnections.mockRejectedValue(new Error('connections'))
    h.parserSession.clearStorageData.mockRejectedValue(new Error('storage'))
    await expect(h.supervisor.parse({ jobId: 'job-cleanup', format: 'txt', objectPath: h.objectPath, fileKey: h.fileKey })).resolves.toMatchObject({ code: 'PARSER_MALFORMED_DOCUMENT' })
    expect(h.port1.close).toHaveBeenCalledOnce()
    expect(h.port2.close).toHaveBeenCalledOnce()
    expect(h.window.destroy).toHaveBeenCalledOnce()
    expect(h.parserSession.closeAllConnections).toHaveBeenCalledOnce()
    expect(h.parserSession.clearStorageData).toHaveBeenCalledOnce()
  })

  it('rejects caller-limit and coordinate violations from the renderer', async () => {
    const response = (request: { jobId: string }) => ({
      version: 1, type: 'result', jobId: request.jobId, text: '123456',
      blocks: [{ id: 'page-1', text: '123456', coordinate: { kind: 'pdf', page: 1, itemStart: 0, itemEnd: 1 } }],
      chunks: [{ index: 0, text: '123456', blockIds: ['page-1'] }],
    })
    const h = await harness(response)
    await expect(h.supervisor.parse({
      jobId: 'job-lowered', format: 'txt', objectPath: h.objectPath, fileKey: h.fileKey,
      limits: { ...DEFAULT_PARSER_LIMITS, maxTextChars: 5 },
    })).resolves.toMatchObject({ type: 'error', code: 'PARSER_PROTOCOL_INVALID' })
  })

  it('fails closed and tears down for malformed renderer messages', async () => {
    const h = await harness({ type: 'result', jobId: 'job-invalid', text: 'unbounded' })
    await expect(h.supervisor.parse({ jobId: 'job-invalid', format: 'txt', objectPath: h.objectPath, fileKey: h.fileKey })).resolves.toMatchObject({ type: 'error', code: 'PARSER_PROTOCOL_INVALID' })
    expect(h.window.destroy).toHaveBeenCalledOnce()
  })

  it('terminates a renderer that crosses the configured memory budget', async () => {
    const h = await harness()
    h.processMemoryBytes.mockResolvedValue(70 * 1024 * 1024)
    await expect(h.supervisor.parse({
      jobId: 'job-memory', format: 'txt', objectPath: h.objectPath, fileKey: h.fileKey,
      limits: { ...DEFAULT_PARSER_LIMITS, maxMemoryBytes: 64 * 1024 * 1024 }, timeoutMs: 200,
    })).resolves.toMatchObject({ type: 'error', code: 'PARSER_LIMIT_EXCEEDED' })
    expect(h.window.destroy).toHaveBeenCalledOnce()
  })

  it('ships a parser document CSP that denies default and network sources', async () => {
    const html = await readFile(new URL('./parser-worker.html', import.meta.url), 'utf8')
    expect(html).toContain("default-src 'none'")
    expect(html).toContain("connect-src 'none'")
    expect(html).not.toMatch(/unsafe-inline|unsafe-eval/)
  })

  it('fails the runtime probe before construction when packaged parser assets are missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'autoforge-supervisor-assets-'))
    directories.push(directory)
    await expect(createElectronParserSupervisor(
      join(directory, 'missing-worker.html'),
      join(directory, 'missing-preload.cjs'),
    )).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
