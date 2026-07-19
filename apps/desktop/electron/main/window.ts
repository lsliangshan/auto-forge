import { isTrustedRendererUrl, type RendererTarget } from './renderer-trust.js'

interface NavigationEventPort { preventDefault(): void }
interface WebContentsPort {
  on(event: 'will-navigate' | 'will-redirect', listener: (event: NavigationEventPort, url: string) => void): void
  on(event: 'will-attach-webview', listener: (event: NavigationEventPort) => void): void
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void
}
export interface BrowserWindowPort {
  webContents: WebContentsPort
  loadURL(url: string): Promise<void>
  loadFile(path: string): Promise<void>
  once?(event: 'ready-to-show', listener: () => void): void
  show?(): void
}
export type BrowserWindowConstructor = new (options: Record<string, unknown>) => BrowserWindowPort

interface SessionPort {
  setPermissionRequestHandler(handler: (
    webContents: unknown,
    permission: string,
    callback: (allowed: boolean) => void,
    details: unknown,
  ) => void): void
  setPermissionCheckHandler?(handler: () => boolean): void
}

export interface SecureWindowOptions {
  BrowserWindow: BrowserWindowConstructor
  session: SessionPort
  preloadPath: string
  rendererTarget: RendererTarget
  beforeLoad?(window: BrowserWindowPort): void | Promise<void>
}

export async function createSecureWindow(options: SecureWindowOptions): Promise<BrowserWindowPort> {
  options.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  options.session.setPermissionCheckHandler?.(() => false)

  const window = new options.BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    backgroundColor: '#0b0d12',
    webPreferences: {
      preload: options.preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
    },
  })

  const guardNavigation = (event: NavigationEventPort, url: string) => {
    if (!isTrustedRendererUrl(url, options.rendererTarget)) event.preventDefault()
  }
  window.webContents.on('will-navigate', guardNavigation)
  window.webContents.on('will-redirect', guardNavigation)
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.once?.('ready-to-show', () => window.show?.())
  await options.beforeLoad?.(window)

  if (options.rendererTarget.kind === 'development') {
    await window.loadURL(`${options.rendererTarget.origin}/`)
  } else {
    await window.loadFile(options.rendererTarget.filePath)
  }
  return window
}
