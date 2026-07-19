import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { is } from '@electron-toolkit/utils'
import { AppDatabase } from './database/app-database'
import { registerIpcHandlers } from './ipc/register-ipc'
import { SettingsService } from './settings/settings-service'
import { RegistryClient } from './registry/registry-client'
import { WorkflowProjectService } from './workflows/workflow-project-service'
import { WorkflowInstallationService } from './installations/workflow-installation-service'
import { WorkflowExecutionService } from './runtime/workflow-execution-service'

let database: AppDatabase | undefined; let projects: WorkflowProjectService | undefined; let executions: WorkflowExecutionService | undefined
function resourcePath(...segments: string[]): string { return join(app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources'), ...segments) }
function createWindow(): BrowserWindow {
  const window = new BrowserWindow({ width: 1440, height: 1024, minWidth: 1080, minHeight: 720, show: false, titleBarStyle: 'hiddenInset', backgroundColor: '#f8f7f3', webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: true, webSecurity: true, nodeIntegration: false } })
  window.once('ready-to-show', () => window.show()); window.webContents.setWindowOpenHandler(({ url }) => { if (url.startsWith('https://')) void shell.openExternal(url); return { action: 'deny' } })
  if (is.dev && process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL); else void window.loadFile(join(__dirname, '../renderer/index.html'))
  return window
}

app.whenReady().then(async () => {
  database = new AppDatabase(join(app.getPath('userData'), 'autoforge.db')); database.initialize()
  const productionApi = app.isPackaged ? process.env.AUTOFORGE_API_URL : undefined
  if (productionApi && new URL(productionApi).protocol !== 'https:') throw new Error('AUTOFORGE_API_URL must use HTTPS in production')
  const settings = new SettingsService(database, app.getPath('downloads'), productionApi)
  const registry = new RegistryClient(database, settings); await registry.restore()
  projects = new WorkflowProjectService(database)
  const trusted = JSON.parse(readFileSync(resourcePath('keys', 'trusted-release-keys.json'), 'utf8')) as Record<string, string>
  if (is.dev && process.env.AUTOFORGE_TRUSTED_KEYS_JSON) Object.assign(trusted, JSON.parse(process.env.AUTOFORGE_TRUSTED_KEYS_JSON))
  const installations = new WorkflowInstallationService(database, registry, join(app.getPath('userData'), 'workflows'), trusted)
  executions = new WorkflowExecutionService(resourcePath('runner'), join(__dirname, '../preload/workflowRunner.js'), app.getPath('downloads'))
  registerIpcHandlers({ settings, registry, projects, installations, executions })
  createWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => { projects?.close(); executions?.close(); database?.close(); projects = undefined; executions = undefined; database = undefined })
