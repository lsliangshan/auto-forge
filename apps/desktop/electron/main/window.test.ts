import { describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import {
  createSecureWindow,
  installMediaProtocolRequestGuard,
  type BrowserWindowConstructor,
} from './window.js'

class FakeBrowserWindow {
  static last: FakeBrowserWindow | undefined
  readonly webContents = {
    id: 7,
    isDestroyed: vi.fn(() => false),
    on: vi.fn((name: string, listener: (...args: unknown[]) => void) => { this.webContentsListeners.set(name, listener) }),
    setWindowOpenHandler: vi.fn((listener: (details: { url: string }) => unknown) => { this.openHandler = listener }),
  }
  readonly webContentsListeners = new Map<string, (...args: unknown[]) => void>()
  openHandler?: (details: { url: string }) => unknown
  loadURL = vi.fn().mockResolvedValue(undefined)
  loadFile = vi.fn().mockResolvedValue(undefined)

  constructor(readonly options: Record<string, unknown>) { FakeBrowserWindow.last = this }
}

describe('createSecureWindow', () => {
  it('creates a sandboxed isolated window and loads only the trusted development target', async () => {
    const deny = vi.fn()
    const session = { setPermissionRequestHandler: vi.fn((handler) => { deny.mockImplementation(handler) }) }
    const windowOptions = {
      BrowserWindow: FakeBrowserWindow as unknown as BrowserWindowConstructor,
      session,
      preloadPath: '/app/preload.js',
      rendererTarget: { kind: 'development' as const, origin: 'http://127.0.0.1:5173' },
      backgroundColor: '#f3f5f8',
    }
    await createSecureWindow(windowOptions)
    const created = FakeBrowserWindow.last!

    expect(created.options.webPreferences as Record<string, unknown>).toMatchObject({
      contextIsolation: true, sandbox: true, webSecurity: true, nodeIntegration: false,
      preload: '/app/preload.js', webviewTag: false,
    })
    expect(created.options.backgroundColor).toBe('#f3f5f8')
    expect(created.loadURL).toHaveBeenCalledWith('http://127.0.0.1:5173/')
    const callback = vi.fn()
    deny({}, 'media', callback)
    expect(callback).toHaveBeenCalledWith(false)
  })

  it('blocks navigation, popups, and webview attachment', async () => {
    await createSecureWindow({
      BrowserWindow: FakeBrowserWindow as unknown as BrowserWindowConstructor,
      session: { setPermissionRequestHandler: vi.fn() },
      preloadPath: '/app/preload.js',
      rendererTarget: { kind: 'production', filePath: '/app/renderer/index.html' },
    })
    const created = FakeBrowserWindow.last!
    const navigate = created.webContentsListeners.get('will-navigate')!
    const attach = created.webContentsListeners.get('will-attach-webview')!
    const navigationEvent = { preventDefault: vi.fn() }
    const webviewEvent = { preventDefault: vi.fn() }

    navigate(navigationEvent, 'https://attacker.invalid/')
    attach(webviewEvent)
    expect(navigationEvent.preventDefault).toHaveBeenCalled()
    expect(webviewEvent.preventDefault).toHaveBeenCalled()
    expect(created.openHandler?.({ url: 'https://example.com/' })).toEqual({ action: 'deny' })
    expect(created.loadFile).toHaveBeenCalledWith('/app/renderer/index.html')
  })

  it('accepts only hash changes on the exact production file URL', async () => {
    const filePath = '/app/renderer/index.html'
    await createSecureWindow({
      BrowserWindow: FakeBrowserWindow as unknown as BrowserWindowConstructor,
      session: { setPermissionRequestHandler: vi.fn() },
      preloadPath: '/app/preload.js',
      rendererTarget: { kind: 'production', filePath },
    })
    const navigate = FakeBrowserWindow.last!.webContentsListeners.get('will-navigate')!
    const trusted = pathToFileURL(filePath).href
    const allowed = { preventDefault: vi.fn() }
    navigate(allowed, `${trusted}#/chat`)
    expect(allowed.preventDefault).not.toHaveBeenCalled()
    const encodedHash = { preventDefault: vi.fn() }
    navigate(encodedHash, `${trusted}#/%2Fdeveloper`)
    expect(encodedHash.preventDefault).not.toHaveBeenCalled()

    for (const url of [
      `file://attacker${new URL(trusted).pathname}`,
      `file://user:secret@attacker${new URL(trusted).pathname}`,
      `file://%61ttacker${new URL(trusted).pathname}`,
      `file:\\attacker${new URL(trusted).pathname}`,
      `${trusted}?authority=attacker`,
    ]) {
      const blocked = { preventDefault: vi.fn() }
      navigate(blocked, url)
      expect(blocked.preventDefault).toHaveBeenCalled()
    }
  })

  it('keeps OpenRouter network access out of the renderer CSP', async () => {
    const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8')
    expect(html).toContain("connect-src 'self'")
    expect(html).not.toContain('connect-src \'self\' https://openrouter.ai')
  })

  it('allows main to register the fixed bridge before renderer code loads', async () => {
    const order: string[] = []
    class OrderedWindow extends FakeBrowserWindow {
      override loadURL = vi.fn(async () => { order.push('load') })
    }
    await createSecureWindow({
      BrowserWindow: OrderedWindow as unknown as BrowserWindowConstructor,
      session: { setPermissionRequestHandler: vi.fn() },
      preloadPath: '/app/preload.js',
      rendererTarget: { kind: 'development', origin: 'http://127.0.0.1:5173' },
      beforeLoad: async () => { order.push('register') },
    })
    expect(order).toEqual(['register', 'load'])
  })

  it('allows only the live main window to request autoforge media', () => {
    let listener: ((details: { webContentsId?: number }, callback: (result: { cancel: boolean }) => void) => void) | undefined
    const session = {
      setPermissionRequestHandler: vi.fn(),
      webRequest: {
        onBeforeRequest: vi.fn((_filter, callback) => { listener = callback }),
      },
    }
    let main: { isDestroyed(): boolean; webContents: { id: number; isDestroyed(): boolean } } | null = {
      isDestroyed: () => false,
      webContents: { id: 7, isDestroyed: () => false },
    }

    installMediaProtocolRequestGuard(session, () => main)
    const decide = (webContentsId?: number) => {
      const callback = vi.fn()
      listener!({ webContentsId }, callback)
      return callback.mock.calls[0]![0]
    }

    expect(session.webRequest.onBeforeRequest).toHaveBeenCalledWith(
      { urls: ['autoforge-media://*/*'] }, expect.any(Function),
    )
    expect(decide(7)).toEqual({ cancel: false })
    expect(decide(8)).toEqual({ cancel: true })
    main = { isDestroyed: () => true, webContents: { id: 7, isDestroyed: () => false } }
    expect(decide(7)).toEqual({ cancel: true })
    main = null
    expect(decide(7)).toEqual({ cancel: true })
  })

  it('updates a shared session guard without registering duplicate listeners', () => {
    let listener: ((details: { webContentsId?: number }, callback: (result: { cancel: boolean }) => void) => void) | undefined
    const session = {
      setPermissionRequestHandler: vi.fn(),
      webRequest: { onBeforeRequest: vi.fn((_filter, callback) => { listener = callback }) },
    }
    const destroyed = { isDestroyed: () => true, webContents: { id: 7, isDestroyed: () => false } }
    const replacement = { isDestroyed: () => false, webContents: { id: 9, isDestroyed: () => false } }

    installMediaProtocolRequestGuard(session, () => destroyed)
    installMediaProtocolRequestGuard(session, () => replacement)
    const callback = vi.fn()
    listener!({ webContentsId: 9 }, callback)

    expect(session.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith({ cancel: false })
  })
})
