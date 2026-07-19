import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  session,
  shell,
  type Event,
  type OpenDialogOptions,
} from 'electron'
import { chatEventSchema, executionEventSchema, ipcChannels } from '@autoforge/shared'
import { createApplicationRuntime } from './application.js'
import { registerDesktopIpc, type RendererTarget } from './ipc/register-ipc.js'
import { startDesktopApplication } from './startup.js'
import { createSecureWindow } from './window.js'

type ApplicationRuntime = ReturnType<typeof createApplicationRuntime>

let mainWindow: BrowserWindow | null = null
let runtime: ApplicationRuntime | undefined
let disposeIpc: (() => void) | undefined
let quitting = false

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

function initialize(): ApplicationRuntime {
  const userData = app.getPath('userData')
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
    openExternal: (url) => shell.openExternal(url),
    emitChat: (event) => {
      const parsed = chatEventSchema.safeParse(event)
      if (parsed.success) emit(ipcChannels.chatEvent, parsed.data)
    },
    emitExecution: (event) => {
      const parsed = executionEventSchema.safeParse(event)
      if (parsed.success) emit(ipcChannels.executionsEvent, parsed.data)
    },
    browserRuntime: { packaged: app.isPackaged, ...(app.isPackaged ? { resourcesPath: process.resourcesPath } : {}) },
    appInfo: { version: app.getVersion(), platform: process.platform === 'win32' ? 'win32' : 'darwin' },
  })
}

async function createMainWindow(application: ApplicationRuntime): Promise<void> {
  const target = rendererTarget()
  const created = await createSecureWindow({
    BrowserWindow,
    session: session.defaultSession,
    preloadPath: fileURLToPath(new URL('../preload/index.mjs', import.meta.url)),
    rendererTarget: target,
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
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
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
    void shutdown().finally(() => app.quit())
  })
}
