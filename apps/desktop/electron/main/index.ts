import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BaseWindow,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  net,
  nativeTheme,
  protocol,
  safeStorage,
  session,
  shell,
  WebContentsView,
  type Event,
  type OpenDialogOptions,
} from 'electron'
import { chatEventSchema, executionEventSchema, ipcChannels } from '@autoforge/shared'
import { createApplicationRuntime } from './application.js'
import { completeApplicationShutdown } from './application-shutdown-completion.js'
import { registerDesktopIpc, type RendererTarget } from './ipc/register-ipc.js'
import { startDesktopApplication } from './startup.js'
import {
  isProcessAlive,
  startDevelopmentParentWatchdog,
} from './development-parent-watchdog.js'
import { createMediaProtocolHandler } from './media/media-protocol.js'
import { NetworkProxyService } from './network/network-proxy-service.js'
import { ElectronBrowserWorkspace } from './browser/electron-browser-workspace.js'
import { UserDataStoreManager } from './database/user-data-client.js'
import { createSecureWindow } from './window.js'

type ApplicationRuntime = ReturnType<typeof createApplicationRuntime>

let mainWindow: BrowserWindow | null = null
let runtime: ApplicationRuntime | undefined
let disposeIpc: (() => void) | undefined
let disposeDevelopmentParentWatchdog: (() => void) | undefined
let userDataStores: UserDataStoreManager | undefined
let quitting = false
let mediaProtocolRegistered = false

protocol.registerSchemesAsPrivileged([{
  scheme: 'autoforge-media',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}])

function developmentRendererTarget(raw: string | undefined): RendererTarget {
  if (!raw) throw new Error('The trusted development renderer URL is unavailable')
  const parsed = new URL(raw)
  if (!['http:', 'https:'].includes(parsed.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    || parsed.username !== ''
    || parsed.password !== '') {
    throw new Error('The trusted development renderer URL is invalid')
  }
  return { kind: 'development', origin: parsed.origin }
}

function rendererTarget(): RendererTarget {
  return app.isPackaged
    ? { kind: 'production', filePath: fileURLToPath(new URL('../renderer/index.html', import.meta.url)) }
    : developmentRendererTarget(process.env.ELECTRON_RENDERER_URL)
}

function emit(channel: string, value: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
  mainWindow.webContents.send(channel, value)
}

async function initialize(): Promise<ApplicationRuntime> {
  try {
    process.loadEnvFile(join(app.getAppPath(), '..', '..', '.env'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const userData = app.getPath('userData')
  userDataStores ??= new UserDataStoreManager(join(userData, 'user-caches'))
  const networkProxy = new NetworkProxyService({
    setProxy: (config) => session.defaultSession.setProxy(config),
    closeAllConnections: () => session.defaultSession.closeAllConnections(),
    fetch: (input, init) => net.fetch(input, init),
  })
  const browserWorkspace = new ElectronBrowserWorkspace({
    BaseWindow: BaseWindow as never,
    WebContentsView: WebContentsView as never,
    fromPartition: (partition) => session.fromPartition(partition),
    proxySnapshot: () => networkProxy.snapshot(),
    backgroundColor: () => nativeTheme.shouldUseDarkColors ? '#11151c' : '#f3f5f8',
  })
  nativeTheme.on('updated', () => browserWorkspace.updateTheme())
  return createApplicationRuntime({
    paths: {
      database: join(userData, 'autoforge.sqlite'),
      data: userData,
      logs: app.getPath('logs'),
      projects: join(userData, 'workflow-projects'),
      installations: join(userData, 'installed-workflows'),
      workflowRunner: fileURLToPath(new URL('../workers/workflow-runner.cjs', import.meta.url)),
      temporary: app.getPath('temp'),
    },
    safeStorage: {
      isAvailable: async () => safeStorage.isEncryptionAvailable(),
      encrypt: async (value) => safeStorage.encryptString(value),
      decrypt: async (value) => ({ value: safeStorage.decryptString(value), shouldReEncrypt: false }),
    },
    networkProxy,
    browserWorkspace,
    applyTheme: (theme) => {
      nativeTheme.themeSource = theme
      browserWorkspace.updateTheme()
    },
    chooseProjectDirectory: async () => {
      const dialogOptions: OpenDialogOptions = {
        title: '注册本地工作流项目',
        properties: ['openDirectory'],
      }
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions)
      return result.canceled ? undefined : result.filePaths[0]
    },
    chooseMediaFiles: async (remainingSlots) => {
      const dialogOptions: OpenDialogOptions = {
        title: '选择媒体文件',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Media', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'svg', 'mp3', 'wav', 'ogg', 'flac', 'm4a', 'mp4', 'webm', 'mov'] }],
      }
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions)
      return result.canceled ? [] : result.filePaths.slice(0, remainingSlots)
    },
    chooseAvatarFile: async () => {
      const dialogOptions: OpenDialogOptions = {
        title: '选择头像',
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      }
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions)
      return result.canceled ? undefined : result.filePaths[0]
    },
    qiniuEnv: process.env,
    cloudbaseEnv: process.env,
    readClipboardImage: () => {
      const image = clipboard.readImage()
      if (image.isEmpty()) return undefined
      return { bytes: image.toPNG(), mimeType: 'image/png', name: 'clipboard.png' }
    },
    chooseMediaSavePath: async (defaultName) => {
      const result = mainWindow
        ? await dialog.showSaveDialog(mainWindow, { defaultPath: defaultName })
        : await dialog.showSaveDialog({ defaultPath: defaultName })
      return result.canceled ? undefined : result.filePath
    },
    revealPath: (path) => { shell.showItemInFolder(path) },
    openExternal: (url) => shell.openExternal(url),
    emitChat: (event) => {
      const parsed = chatEventSchema.safeParse(event)
      if (parsed.success) emit(ipcChannels.chatEvent, parsed.data)
    },
    emitExecution: (event) => {
      const parsed = executionEventSchema.safeParse(event)
      if (parsed.success) emit(ipcChannels.executionsEvent, parsed.data)
    },
    appInfo: { version: app.getVersion(), platform: process.platform === 'win32' ? 'win32' : 'darwin' },
  })
}

async function createMainWindow(application: ApplicationRuntime): Promise<void> {
  const target = rendererTarget()
  if (!mediaProtocolRegistered) {
    await protocol.handle('autoforge-media', createMediaProtocolHandler(application.mediaAssets))
    mediaProtocolRegistered = true
  }
  const created = await createSecureWindow({
    BrowserWindow,
    session: session.defaultSession,
    preloadPath: fileURLToPath(new URL('../preload/index.cjs', import.meta.url)),
    rendererTarget: target,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#11151c' : '#f3f5f8',
    getMainWindow: () => mainWindow,
    beforeLoad: (window) => {
      mainWindow = window as BrowserWindow
      disposeIpc = registerDesktopIpc({
        ipcMain,
        services: application.services,
        getMainWindow: () => mainWindow,
        rendererTarget: target,
      })
    },
  })
  mainWindow = created as BrowserWindow
  mainWindow.on('closed', () => { mainWindow = null })
}

async function shutdown(): Promise<void> {
  disposeIpc?.()
  disposeIpc = undefined
  const current = runtime
  runtime = undefined
  if (current) await current.close()
  userDataStores?.close()
  userDataStores = undefined
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  disposeDevelopmentParentWatchdog = startDevelopmentParentWatchdog({
    packaged: app.isPackaged,
    parentPid: process.ppid,
    isParentAlive: isProcessAlive,
    quit: () => app.quit(),
  })

  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  void startDesktopApplication({
    whenReady: () => app.whenReady(),
    initialize,
    createWindow: createMainWindow,
    showStartupError: async (message) => { dialog.showErrorBox('AutoForge', message) },
    quit: () => app.quit(),
  }).then((application) => { runtime = application })

  app.on('activate', () => {
    if (!mainWindow && runtime) void createMainWindow(runtime).catch(() => app.quit())
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', (event: Event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    disposeDevelopmentParentWatchdog?.()
    disposeDevelopmentParentWatchdog = undefined
    void completeApplicationShutdown({
      packaged: app.isPackaged,
      shutdown,
      quit: () => app.quit(),
    })
  })
}
