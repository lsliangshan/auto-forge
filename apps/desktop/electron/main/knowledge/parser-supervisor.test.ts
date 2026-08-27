import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARSER_LIMITS } from './parser-protocol.js'
import {
  createElectronParserSupervisor,
  ParserSupervisor,
  type ParserRendererDependencies,
} from './parser-supervisor.js'

const HANDLE = 'a'.repeat(32)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

class FakePort extends EventEmitter {
  close = vi.fn()
  start = vi.fn()
}

function harness(
  response?: unknown | ((request: { jobId: string; mediaType: string }) => unknown),
  overrides: Partial<ParserRendererDependencies> = {},
) {
  const port1 = new FakePort()
  const port2 = new FakePort()
  const webContents = new EventEmitter() as EventEmitter & {
    setWindowOpenHandler: ReturnType<typeof vi.fn>
    postMessage: ReturnType<typeof vi.fn>
    getOSProcessId: ReturnType<typeof vi.fn>
  }
  webContents.setWindowOpenHandler = vi.fn()
  webContents.getOSProcessId = vi.fn(() => 123)
  webContents.postMessage = vi.fn((_channel: string, request: { jobId: string; mediaType: string }) => {
    if (response !== undefined) {
      queueMicrotask(() => port2.emit('message', {
        data: typeof response === 'function' ? response(request) : response,
      }))
    }
  })
  const window = {
    webContents,
    loadFile: vi.fn(async () => { webContents.emit('did-finish-load') }),
    destroy: vi.fn(),
    isDestroyed: vi.fn(() => false),
  }
  let networkHandler: ((details: { url: string }, callback: (decision: { cancel: boolean }) => void) => void) | undefined
  let permissionHandler: ((contents: unknown, permission: string, callback: (allowed: boolean) => void) => void) | undefined
  const parserSession = new EventEmitter() as EventEmitter & {
    webRequest: { onBeforeRequest: ReturnType<typeof vi.fn> }
    setPermissionRequestHandler: ReturnType<typeof vi.fn>
    clearStorageData: ReturnType<typeof vi.fn>
    closeAllConnections: ReturnType<typeof vi.fn>
  }
  parserSession.webRequest = {
    onBeforeRequest: vi.fn((_filter, handler) => { networkHandler = handler }),
  }
  parserSession.setPermissionRequestHandler = vi.fn((handler) => { permissionHandler = handler })
  parserSession.clearStorageData = vi.fn(async () => undefined)
  parserSession.closeAllConnections = vi.fn(async () => undefined)
  const createWindow = vi.fn(() => window)
  const resolveObject = vi.fn(async () => Buffer.from('sandbox text'))
  const processMemoryBytes = vi.fn(async () => 1)
  const dependencies: ParserRendererDependencies = {
    createWindow: createWindow as ParserRendererDependencies['createWindow'],
    createSession: vi.fn(() => parserSession) as ParserRendererDependencies['createSession'],
    createMessageChannel: vi.fn(() => ({ port1, port2 })),
    resolveObject,
    workerHtmlPath: '/app/out/renderer/knowledge-parser/index.html',
    preloadPath: '/app/out/preload/knowledge-parser.cjs',
    partitionId: () => 'autoforge-parser-test-unique',
    processMemoryBytes,
    ...overrides,
  }
  return {
    supervisor: new ParserSupervisor(dependencies),
    createWindow,
    resolveObject,
    window,
    webContents,
    parserSession,
    processMemoryBytes,
    port1,
    port2,
    networkHandler: () => networkHandler,
    permissionHandler: () => permissionHandler,
  }
}

function success(request: { jobId: string; mediaType: string }) {
  return {
    version: 1,
    type: 'result',
    jobId: request.jobId,
    document: {
      mediaType: request.mediaType,
      text: 'sandbox text',
      blocks: [{
        id: 'line-1',
        text: 'sandbox text',
        coordinate: { kind: 'txt', lineStart: 1, lineEnd: 1, charStart: 0, charEnd: 12 },
      }],
    },
  }
}

describe('sandbox parser supervisor', () => {
  it('resolves only an opaque object handle and transfers no path, plaintext, master key, or credentials', async () => {
    const h = harness(success)
    const oneTimeKey = Buffer.alloc(32, 7)
    await expect(h.supervisor.parse({
      objectHandle: HANDLE,
      oneTimeKey,
      mediaType: 'text/plain',
      limits: DEFAULT_PARSER_LIMITS,
    })).resolves.toMatchObject({ text: 'sandbox text' })

    expect(h.resolveObject).toHaveBeenCalledWith(HANDLE)
    const sent = h.webContents.postMessage.mock.calls[0]?.[1] as Record<string, unknown>
    expect(Object.keys(sent).sort()).toEqual([
      'encryptedSnapshot', 'jobId', 'limits', 'mediaType', 'oneTimeKey', 'type', 'version',
    ])
    expect(JSON.stringify(sent)).not.toContain(HANDLE)
    expect(JSON.stringify(sent)).not.toContain('sandbox text')
    expect(JSON.stringify(sent)).not.toMatch(/path|master|safeStorage|cloudbase|provider|credential|env/i)
    expect(h.webContents.postMessage.mock.calls[0]?.[2]).toEqual([h.port1])
    expect(oneTimeKey.every(byte => byte === 0)).toBe(true)

    const escaped = Buffer.alloc(32, 8)
    await expect(h.supervisor.parse({
      objectHandle: '../../private/document.txt',
      oneTimeKey: escaped,
      mediaType: 'text/plain',
      limits: DEFAULT_PARSER_LIMITS,
    })).rejects.toMatchObject({ code: 'PARSER_PROTOCOL_INVALID' })
    expect(escaped.every(byte => byte === 0)).toBe(true)
    expect(h.resolveObject).toHaveBeenCalledTimes(1)
  })

  it('creates a hidden no-Node sandbox and denies network, navigation, windows, permissions, and downloads', async () => {
    const h = harness(success)
    await h.supervisor.parse({
      objectHandle: HANDLE,
      oneTimeKey: Buffer.alloc(32, 7),
      mediaType: 'text/plain',
      limits: DEFAULT_PARSER_LIMITS,
    })
    expect(h.createWindow).toHaveBeenCalledWith(expect.objectContaining({
      show: false,
      webPreferences: expect.objectContaining({
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        backgroundThrottling: false,
        partition: 'autoforge-parser-test-unique',
        preload: '/app/out/preload/knowledge-parser.cjs',
      }),
    }))
    const networkDecision = vi.fn()
    h.networkHandler()?.({ url: 'https://invalid.example/steal' }, networkDecision)
    expect(networkDecision).toHaveBeenCalledWith({ cancel: true })
    const navigation = { preventDefault: vi.fn() }
    h.webContents.emit('will-navigate', navigation)
    expect(navigation.preventDefault).toHaveBeenCalledOnce()
    expect(h.webContents.setWindowOpenHandler.mock.calls[0]?.[0]()).toEqual({ action: 'deny' })
    const permissionDecision = vi.fn()
    h.permissionHandler()?.({}, 'clipboard-read', permissionDecision)
    expect(permissionDecision).toHaveBeenCalledWith(false)
    const download = { preventDefault: vi.fn() }
    h.parserSession.emit('will-download', download)
    expect(download.preventDefault).toHaveBeenCalledOnce()
  })

  it('terminates and cleans every resource on timeout, cancellation, crash, and memory limit', async () => {
    const timed = harness()
    await expect(timed.supervisor.parse({
      objectHandle: HANDLE,
      oneTimeKey: Buffer.alloc(32, 1),
      mediaType: 'text/plain',
      limits: { ...DEFAULT_PARSER_LIMITS, timeoutMs: 50 },
    })).rejects.toMatchObject({ code: 'PARSER_TIMEOUT' })
    expect(timed.window.destroy).toHaveBeenCalledOnce()
    expect(timed.port1.close).toHaveBeenCalledOnce()
    expect(timed.port2.close).toHaveBeenCalledOnce()
    expect(timed.parserSession.closeAllConnections).toHaveBeenCalledOnce()
    expect(timed.parserSession.clearStorageData).toHaveBeenCalledOnce()

    const cancelled = harness()
    const controller = new AbortController()
    const cancellation = cancelled.supervisor.parse({
      objectHandle: HANDLE,
      oneTimeKey: Buffer.alloc(32, 2),
      mediaType: 'text/plain',
      limits: DEFAULT_PARSER_LIMITS,
      signal: controller.signal,
    })
    await vi.waitFor(() => expect(cancelled.webContents.postMessage).toHaveBeenCalledOnce())
    controller.abort()
    await expect(cancellation).rejects.toMatchObject({ code: 'PARSER_CANCELLED' })
    expect(cancelled.window.destroy).toHaveBeenCalledOnce()

    const crashed = harness()
    crashed.window.loadFile.mockImplementation(async () => { crashed.webContents.emit('render-process-gone') })
    await expect(crashed.supervisor.parse({
      objectHandle: HANDLE,
      oneTimeKey: Buffer.alloc(32, 3),
      mediaType: 'text/plain',
      limits: DEFAULT_PARSER_LIMITS,
    })).rejects.toMatchObject({ code: 'PARSER_INTERNAL_ERROR' })
    expect(crashed.window.destroy).toHaveBeenCalledOnce()

    const memory = harness()
    memory.processMemoryBytes.mockResolvedValue(40 * 1024 * 1024)
    await expect(memory.supervisor.parse({
      objectHandle: HANDLE,
      oneTimeKey: Buffer.alloc(32, 4),
      mediaType: 'text/plain',
      limits: { ...DEFAULT_PARSER_LIMITS, maxMemoryBytes: 32 * 1024 * 1024, timeoutMs: 500 },
    })).rejects.toMatchObject({ code: 'PARSER_LIMIT_EXCEEDED' })
    expect(memory.window.destroy).toHaveBeenCalledOnce()
  })

  it('tracks pre-launch jobs so shutdown drains object resolution and never launches a late renderer', async () => {
    let release!: (bytes: Uint8Array) => void
    const cleartext = Buffer.alloc(32, 9)
    const resolveObject = vi.fn(() => new Promise<Uint8Array>((resolve) => { release = resolve }))
    const h = harness(undefined, { resolveObject })
    const key = Buffer.alloc(32, 5)
    const parse = h.supervisor.parse({
      objectHandle: HANDLE,
      oneTimeKey: key,
      mediaType: 'text/plain',
      limits: DEFAULT_PARSER_LIMITS,
    })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    let drained = false
    const shutdown = h.supervisor.terminateAll().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    release(cleartext)
    await shutdown
    await expect(parse).rejects.toMatchObject({ code: 'PARSER_CANCELLED' })
    expect(h.createWindow).not.toHaveBeenCalled()
    expect(cleartext.every(byte => byte === 0)).toBe(true)
    expect(key.every(byte => byte === 0)).toBe(true)

    await expect(h.supervisor.parse({
      objectHandle: HANDLE,
      oneTimeKey: Buffer.alloc(32, 6),
      mediaType: 'text/plain',
      limits: DEFAULT_PARSER_LIMITS,
    })).rejects.toMatchObject({ code: 'PARSER_CANCELLED' })
  })

  it('fails closed for oversized objects and malformed or oversized renderer responses', async () => {
    const unsupported = harness()
    await expect(unsupported.supervisor.parse({
      objectHandle: HANDLE,
      oneTimeKey: Buffer.alloc(32, 1),
      mediaType: 'application/vnd.ms-excel',
      limits: DEFAULT_PARSER_LIMITS,
    } as never)).rejects.toMatchObject({ code: 'PARSER_UNSUPPORTED_FORMAT' })
    expect(unsupported.resolveObject).not.toHaveBeenCalled()
    expect(unsupported.createWindow).not.toHaveBeenCalled()

    const oversized = harness(undefined, {
      resolveObject: vi.fn(async () => Buffer.alloc(32)),
    })
    await expect(oversized.supervisor.parse({
      objectHandle: HANDLE,
      oneTimeKey: Buffer.alloc(32, 1),
      mediaType: 'text/plain',
      limits: { ...DEFAULT_PARSER_LIMITS, maxFileBytes: 16 },
    })).rejects.toMatchObject({ code: 'PARSER_LIMIT_EXCEEDED' })
    expect(oversized.createWindow).not.toHaveBeenCalled()

    const malformed = harness({ type: 'result', jobId: 'wrong', document: {} })
    await expect(malformed.supervisor.parse({
      objectHandle: HANDLE,
      oneTimeKey: Buffer.alloc(32, 1),
      mediaType: 'text/plain',
      limits: DEFAULT_PARSER_LIMITS,
    })).rejects.toMatchObject({ code: 'PARSER_PROTOCOL_INVALID' })
    expect(malformed.window.destroy).toHaveBeenCalledOnce()

    const amplified = harness((request: { jobId: string; mediaType: string }) => ({
      ...success(request),
      document: { ...success(request).document, text: 'x'.repeat(512) },
    }))
    await expect(amplified.supervisor.parse({
      objectHandle: HANDLE,
      oneTimeKey: Buffer.alloc(32, 1),
      mediaType: 'text/plain',
      limits: { ...DEFAULT_PARSER_LIMITS, maxTextChars: 512, maxResponseBytes: 256 },
    })).rejects.toMatchObject({ code: 'PARSER_PROTOCOL_INVALID' })
  })

  it('ships a deny-by-default parser CSP and verifies packaged assets before supervisor creation', async () => {
    const html = await readFile(new URL('../../knowledge-parser/index.html', import.meta.url), 'utf8')
    expect(html).toContain("default-src 'none'")
    expect(html).toContain("connect-src 'none'")
    expect(html).not.toMatch(/unsafe-inline|unsafe-eval/)

    const root = await mkdtemp(join(tmpdir(), 'autoforge-parser-assets-'))
    roots.push(root)
    await expect(createElectronParserSupervisor({
      workerHtmlPath: join(root, 'missing.html'),
      preloadPath: join(root, 'missing.cjs'),
      resolveObject: async () => Buffer.alloc(1),
    })).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
