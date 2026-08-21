import { isTrustedRendererUrl, type RendererTarget } from './renderer-trust.js'

interface NavigationEventPort { preventDefault(): void }
interface WebContentsPort {
  id?: number
  isDestroyed?(): boolean
  on(event: 'will-navigate' | 'will-redirect', listener: (event: NavigationEventPort, url: string) => void): void
  on(event: 'will-attach-webview', listener: (event: NavigationEventPort) => void): void
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void
}
export interface BrowserWindowPort {
  webContents: WebContentsPort
  isDestroyed?(): boolean
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
  webRequest?: {
    onBeforeRequest(
      filter: { urls: string[] },
      listener: (details: { webContentsId?: number }, callback: (result: { cancel: boolean }) => void) => void,
    ): void
  }
}

interface MediaRequestSessionPort extends SessionPort {
  webRequest: NonNullable<SessionPort['webRequest']>
}

interface MediaGuardWindow {
  isDestroyed?(): boolean
  webContents: Pick<WebContentsPort, 'id' | 'isDestroyed'>
}

type MainWindowGetter = () => MediaGuardWindow | null

const mediaRequestGuards = new WeakMap<object, { getMainWindow: MainWindowGetter }>()

export function installMediaProtocolRequestGuard(session: MediaRequestSessionPort, getMainWindow: MainWindowGetter): void {
  const existing = mediaRequestGuards.get(session)
  if (existing) {
    existing.getMainWindow = getMainWindow
    return
  }
  const state = { getMainWindow }
  mediaRequestGuards.set(session, state)
  session.webRequest.onBeforeRequest({ urls: ['autoforge-media://*/*'] }, (details, callback) => {
    const mainWindow = state.getMainWindow()
    const trusted = mainWindow
      && !mainWindow.isDestroyed?.()
      && !mainWindow.webContents.isDestroyed?.()
      && typeof mainWindow.webContents.id === 'number'
      && details.webContentsId === mainWindow.webContents.id
    callback({ cancel: !trusted })
  })
}

export interface SecureWindowOptions {
  BrowserWindow: BrowserWindowConstructor
  session: SessionPort
  preloadPath: string
  rendererTarget: RendererTarget
  backgroundColor?: string
  beforeLoad?(window: BrowserWindowPort): void | Promise<void>
  getMainWindow?(): BrowserWindowPort | null
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
    backgroundColor: options.backgroundColor ?? '#0b0d12',
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
  if (options.session.webRequest) {
    installMediaProtocolRequestGuard(options.session as MediaRequestSessionPort, options.getMainWindow ?? (() => window))
  }

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
