import { describe, expect, it, vi } from 'vitest'
import { createSecureWindow, type BrowserWindowConstructor } from './window.js'

class FakeBrowserWindow {
  static last: FakeBrowserWindow | undefined
  readonly webContents = {
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
    await createSecureWindow({
      BrowserWindow: FakeBrowserWindow as unknown as BrowserWindowConstructor,
      session,
      preloadPath: '/app/preload.js',
      rendererTarget: { kind: 'development', origin: 'http://127.0.0.1:5173' },
    })
    const created = FakeBrowserWindow.last!

    expect(created.options.webPreferences as Record<string, unknown>).toMatchObject({
      contextIsolation: true, sandbox: true, webSecurity: true, nodeIntegration: false,
      preload: '/app/preload.js', webviewTag: false,
    })
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
})
