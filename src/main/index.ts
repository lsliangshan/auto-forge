import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { is } from '@electron-toolkit/utils'
import { CatalogService } from './catalog/catalog-service'
import { AppDatabase } from './database/app-database'
import { InstallationService } from './installations/installation-service'
import { registerIpcHandlers } from './ipc/register-ipc'
import { SettingsService } from './settings/settings-service'
import { TemplateService } from './templates/template-service'

let database: AppDatabase | undefined

function resourcePath(...segments: string[]): string {
  const root = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
  return join(root, ...segments)
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 1024,
    minWidth: 1080,
    minHeight: 720,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f8f7f3',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      nodeIntegration: false
    }
  })

  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

app.whenReady().then(() => {
  database = new AppDatabase(join(app.getPath('userData'), 'autoforge.db'))
  database.initialize()

  const catalog = new CatalogService(resourcePath('catalog', 'tools.json'))
  registerIpcHandlers({
    catalog,
    installations: new InstallationService(database, catalog),
    settings: new SettingsService(database, app.getPath('downloads')),
    templates: new TemplateService(resourcePath('templates', 'automation-tool-template'))
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  database?.close()
  database = undefined
})
