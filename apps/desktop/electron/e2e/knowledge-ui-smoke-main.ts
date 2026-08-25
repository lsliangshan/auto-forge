import { rm } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  ipcMain,
  nativeTheme,
  protocol,
  session,
} from 'electron'
import type { AuthSession } from '@autoforge/shared'
import {
  registerDesktopIpc,
  type DesktopIpcServices,
} from '../main/ipc/register-ipc.js'
import { createSecureWindow } from '../main/window.js'

const rendererFile = fileURLToPath(new URL('../../out/renderer/index.html', import.meta.url))
const preloadFile = fileURLToPath(new URL('../../out/preload/index.cjs', import.meta.url))
const userData = mkdtempSync(join(tmpdir(), 'autoforge-knowledge-ui-smoke-'))
app.setPath('userData', userData)
protocol.registerSchemesAsPrivileged([{
  scheme: 'autoforge-media',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}])

const sessionSnapshot: AuthSession = {
  user: { id: 'smoke_user', account: 'SmokeUser' },
  authenticatedAt: '2026-08-26T00:00:00.000Z',
}
const calls: string[] = []
let mainWindow: BrowserWindow | null = null
let disposeIpc: (() => void) | undefined

const services = {
  knowledgeAdmission: { run: async <T>(operation: () => Promise<T>) => operation() },
  auth: {
    getSession: async () => sessionSnapshot,
    refreshAuthorization: async () => sessionSnapshot,
    requireSession: async () => sessionSnapshot,
  },
  profile: {
    get: async () => ({ userId: 'smoke_user', account: 'SmokeUser', displayName: '验证用户' }),
  },
  chat: {
    listConversations: async () => [],
  },
  userAdmin: {},
  media: {},
  workflows: {},
  developer: {},
  executions: {},
  permissions: { listGrants: async () => [] },
  settings: {
    get: async () => ({
      theme: 'system', language: 'zh-CN', dataDirectory: '/smoke/data', logDirectory: '/smoke/logs',
      activeProvider: 'deepseek',
      defaultModels: { openrouter: { text: 'openai/gpt-4.1-mini' }, deepseek: { text: 'deepseek-v4-flash' } },
      showCosts: false, developerMode: false, permissionDefault: 'ask',
      proxy: { enabled: false, bypassDomains: [] },
    }),
    validateProviderCredential: async () => ({
      provider: 'deepseek', configured: false, validation: 'unchecked',
    }),
  },
  knowledge: {
    async getFeatureAvailability() {
      calls.push('getFeatureAvailability')
      return {
        local: { available: true, reasons: [] },
        cloud: { available: false, reasons: ['kill_switch_enabled'] },
      }
    },
    async getEntitlement() {
      calls.push('getEntitlement')
      return { tier: 'free', status: 'active', betaEnabled: true, cloudEnabled: false }
    },
    async getConsent() {
      calls.push('getConsent')
      return { provider: 'openrouter', status: 'denied' }
    },
    async listBases() {
      calls.push('listBases')
      return [{
        id: 'kb_smoke', name: '我的知识库', kind: 'local', status: 'ready', documentCount: 1,
        updatedAt: '2026-08-26T00:00:00.000Z',
      }]
    },
    async listDocuments(_owner: unknown, knowledgeBaseId: string) {
      calls.push(`listDocuments:${knowledgeBaseId}`)
      return [{
        id: 'document_smoke', knowledgeBaseId, name: '可见知识.md', mimeType: 'text/markdown',
        status: 'ready', versionCount: 2, updatedAt: '2026-08-26T00:00:00.000Z',
      }]
    },
    async listVersions(_owner: unknown, documentId: string) {
      calls.push(`listVersions:${documentId}`)
      return [
        { id: 'version_2', documentId, number: 2, status: 'ready', createdAt: '2026-08-26T00:00:00.000Z' },
        { id: 'version_1', documentId, number: 1, status: 'retired', createdAt: '2026-08-25T00:00:00.000Z' },
      ]
    },
  },
  system: { getAppInfo: async () => ({ version: '0.1.0', platform: 'darwin' }) },
} as unknown as DesktopIpcServices

async function waitForVisibleState(script: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const visible = await Promise.race([
      mainWindow?.webContents.executeJavaScript(script) as Promise<boolean>,
      new Promise<never>((_, reject) => globalThis.setTimeout(
        () => reject(new Error('Renderer inspection stalled')),
        2_000,
      )),
    ])
    if (visible) return
    await new Promise((resolve) => globalThis.setTimeout(resolve, 50))
  }
  throw new Error(`Visible renderer state timed out: ${script}`)
}

async function run(): Promise<void> {
  try {
    process.stderr.write('knowledge-ui-smoke: app-ready\n')
    const target = { kind: 'production' as const, filePath: rendererFile }
    const created = await createSecureWindow({
      BrowserWindow,
      session: session.defaultSession,
      preloadPath: preloadFile,
      rendererTarget: target,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#11151c' : '#f3f5f8',
      getMainWindow: () => mainWindow,
      beforeLoad: (window) => {
        mainWindow = window as BrowserWindow
        disposeIpc = registerDesktopIpc({
          ipcMain,
          services,
          getMainWindow: () => mainWindow,
          rendererTarget: target,
        })
      },
    })
    mainWindow = created as BrowserWindow
    process.stderr.write('knowledge-ui-smoke: window-loaded\n')
    await mainWindow.webContents.executeJavaScript("location.hash = '#/knowledge'")
    process.stderr.write('knowledge-ui-smoke: route-requested\n')
    await waitForVisibleState(`document.body.innerText.includes('我的知识库') && document.body.innerText.includes('可见知识.md')`)
    process.stderr.write('knowledge-ui-smoke: workspace-visible\n')
    await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-testid="knowledge-document-document_smoke"]')?.click()`)
    await waitForVisibleState(`document.querySelector('[data-testid="inspector-panel"]')?.innerText.includes('版本 2') === true`)
    process.stderr.write('knowledge-ui-smoke: inspector-visible\n')
    const visible = await mainWindow.webContents.executeJavaScript(`({
      navigation: [...document.querySelectorAll('[data-testid="app-nav-item"]')].map((item) => item.textContent?.trim()),
      center: document.querySelector('[aria-label="知识库文件"]')?.innerText,
      inspector: document.querySelector('[data-testid="inspector-panel"]')?.innerText,
    })`)
    const expectedCalls = [
      'getFeatureAvailability', 'getEntitlement', 'getConsent', 'listBases',
      'listDocuments:kb_smoke', 'listVersions:document_smoke',
    ]
    if (!expectedCalls.every((call) => calls.includes(call))) {
      throw new Error(`IPC path incomplete: ${JSON.stringify(calls)}`)
    }
    process.stdout.write(`${JSON.stringify({ ok: true, calls, visible })}\n`)
  } finally {
    disposeIpc?.()
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy()
    await session.defaultSession.clearStorageData().catch(() => undefined)
    await rm(userData, { recursive: true, force: true })
    app.quit()
  }
}

void app.whenReady().then(run).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  app.exit(1)
})
