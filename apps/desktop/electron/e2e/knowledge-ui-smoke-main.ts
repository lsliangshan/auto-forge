import { mkdtempSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  ipcMain,
  nativeTheme,
  protocol,
  safeStorage,
  session,
} from 'electron'
import type { AuthSession, KnowledgeDocument, KnowledgeSelection } from '@autoforge/shared'
import { registerDesktopIpc, type DesktopIpcServices } from '../main/ipc/register-ipc.js'
import { KnowledgeService } from '../main/knowledge/knowledge-service.js'
import { createElectronParserSupervisor } from '../main/knowledge/parser-supervisor.js'
import { createSecureWindow } from '../main/window.js'

process.stderr.write('knowledge-ui-smoke: entry\n')

const rendererFile = fileURLToPath(new URL('../../out/renderer/index.html', import.meta.url))
const preloadFile = fileURLToPath(new URL('../../out/preload/index.cjs', import.meta.url))
const parserWorkerFile = fileURLToPath(new URL('../../out/renderer/electron/main/knowledge/parser-worker.html', import.meta.url))
const parserPreloadFile = fileURLToPath(new URL('../../out/preload/parser.cjs', import.meta.url))
const userData = mkdtempSync(join(tmpdir(), 'autoforge-knowledge-ui-smoke-'))
const sourceFile = join(userData, 'smoke-source.txt')
app.setPath('userData', userData)
protocol.registerSchemesAsPrivileged([{
  scheme: 'autoforge-media',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}])

const owner = { userId: 'smoke_user' }
const conversationId = 'conversation_smoke'
const sessionSnapshot: AuthSession = {
  user: { id: owner.userId, account: 'SmokeUser' },
  authenticatedAt: '2026-08-26T00:00:00.000Z',
}
let mainWindow: BrowserWindow | null = null
let disposeIpc: (() => void) | undefined
let knowledge: KnowledgeService | undefined
let importAcknowledgement: KnowledgeDocument | undefined
const calls: string[] = []

function trackedKnowledge(service: KnowledgeService): KnowledgeService {
  return new Proxy(service, {
    get(target, property, receiver) {
      if (property === 'importDocument') {
        return async (...args: Parameters<KnowledgeService['importDocument']>) => {
          calls.push('importDocument')
          importAcknowledgement = await target.importDocument(...args)
          return importAcknowledgement
        }
      }
      if (property === 'updateConversationSelection') {
        return async (...args: Parameters<KnowledgeService['updateConversationSelection']>) => {
          calls.push('updateConversationSelection')
          return target.updateConversationSelection(...args)
        }
      }
      const value = Reflect.get(target, property, receiver) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function generationPreferences() {
  return {
    outputType: 'auto' as const,
    models: {},
    generation: {
      image: { count: 1 as const, resolution: '1K' as const, aspectRatio: 'auto' as const, format: 'png' as const },
      audio: { format: 'mp3' as const },
      video: { durationSeconds: 5 as const, resolution: '720p' as const, aspectRatio: 'auto' as const, generateAudio: false },
    },
  }
}

function createServices(service: KnowledgeService): DesktopIpcServices {
  return {
    knowledgeAdmission: { run: async <T>(operation: () => Promise<T>) => operation() },
    auth: {
      getSession: async () => sessionSnapshot,
      refreshAuthorization: async () => sessionSnapshot,
      requireSession: async () => sessionSnapshot,
    },
    profile: {
      get: async () => ({ userId: owner.userId, account: 'SmokeUser', displayName: '验证用户' }),
    },
    chat: {
      listConversations: async () => [{
        id: conversationId, title: '知识偏好验证',
        createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z',
      }],
      listMessages: async () => [],
      getGenerationPreferences: async () => generationPreferences(),
    },
    userAdmin: {},
    media: {},
    workflows: {},
    developer: {},
    executions: {},
    permissions: { listGrants: async () => [] },
    settings: {
      get: async () => ({
        theme: 'system', language: 'zh-CN', dataDirectory: userData, logDirectory: userData,
        activeProvider: 'deepseek',
        defaultModels: { openrouter: { text: 'openai/gpt-4.1-mini' }, deepseek: { text: 'deepseek-v4-flash' } },
        showCosts: false, developerMode: false, permissionDefault: 'ask',
        proxy: { enabled: false, bypassDomains: [] },
      }),
      validateProviderCredential: async () => ({
        provider: 'deepseek', configured: false, validation: 'unchecked',
      }),
    },
    knowledge: trackedKnowledge(service),
    system: { getAppInfo: async () => ({ version: '0.1.0', platform: 'darwin' }) },
  } as unknown as DesktopIpcServices
}

async function waitFor(check: () => Promise<boolean>, description: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => globalThis.setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function rendererMatches(script: string): Promise<boolean> {
  return Promise.race([
    mainWindow?.webContents.executeJavaScript(script) as Promise<boolean>,
    new Promise<never>((_, reject) => globalThis.setTimeout(
      () => reject(new Error('Renderer inspection stalled')),
      2_000,
    )),
  ])
}

async function navigate(hash: string): Promise<void> {
  await mainWindow?.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}; true`)
}

async function run(): Promise<void> {
  try {
    process.stderr.write('knowledge-ui-smoke: app-ready\n')
    await writeFile(sourceFile, 'AutoForge real Electron knowledge import acknowledgement smoke.')
    knowledge = new KnowledgeService({
      rootDirectory: join(userData, 'knowledge'),
      safeStorage: {
        isAvailable: async () => safeStorage.isEncryptionAvailable(),
        encrypt: async (value) => safeStorage.encryptString(value),
        decrypt: async (value) => ({ value: safeStorage.decryptString(value), shouldReEncrypt: false }),
      },
      createParser: () => createElectronParserSupervisor(parserWorkerFile, parserPreloadFile),
      chooseImportFile: async () => sourceFile,
      chooseExportPath: async () => undefined,
      ownsConversation: async (candidate, candidateConversationId) => (
        candidate.userId === owner.userId && candidateConversationId === conversationId
      ),
      entitlement: {
        getEntitlement: async () => ({
          tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: false,
        }),
      },
      platform: process.platform,
      arch: process.arch,
      runtimeAvailable: true,
    })
    process.stderr.write('knowledge-ui-smoke: service-created\n')
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
          services: createServices(knowledge!),
          getMainWindow: () => mainWindow,
          rendererTarget: target,
        })
      },
    })
    mainWindow = created as BrowserWindow
    process.stderr.write('knowledge-ui-smoke: window-created\n')
    await navigate('#/knowledge')
    await waitFor(
      () => rendererMatches(`document.body.innerText.includes('我的知识库') && document.querySelector('[data-testid="knowledge-import"]') !== null`),
      'visible knowledge workspace',
    )
    process.stderr.write('knowledge-ui-smoke: workspace-visible\n')
    await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-testid="knowledge-import"]')?.click()`)
    await waitFor(() => Promise.resolve(Boolean(importAcknowledgement)), 'real Main import acknowledgement')
    process.stderr.write('knowledge-ui-smoke: import-acknowledged\n')
    if (importAcknowledgement?.status !== 'parsing') {
      throw new Error(`Import was not durably acknowledged as parsing: ${JSON.stringify(importAcknowledgement)}`)
    }
    await waitFor(
      () => rendererMatches(`document.body.innerText.includes('smoke-source.txt')`),
      'acknowledged document in the visible Renderer',
    )
    process.stderr.write('knowledge-ui-smoke: document-visible\n')

    const knowledgeBaseId = importAcknowledgement.knowledgeBaseId
    await waitFor(async () => (
      (await knowledge!.listDocuments(owner, knowledgeBaseId))[0]?.status === 'ready'
    ), 'real parser ready-version publication')
    process.stderr.write('knowledge-ui-smoke: document-ready\n')
    await mainWindow.loadFile(rendererFile, { hash: '/chat' })
    await waitFor(
      () => rendererMatches(`document.querySelector('[data-testid="knowledge-base-${knowledgeBaseId}"]') !== null`),
      'conversation knowledge selector',
      10_000,
    )
    process.stderr.write('knowledge-ui-smoke: selector-visible\n')
    await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-testid="knowledge-base-${knowledgeBaseId}"]')?.click(); true`)
    await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-testid="knowledge-mode-strict"]')?.click(); true`)
    const expectedSelection: KnowledgeSelection = { knowledgeBaseIds: [knowledgeBaseId], knowledgeMode: 'strict' }
    await waitFor(async () => {
      const persisted = await knowledge!.getConversationSelection(owner, conversationId)
      return JSON.stringify(persisted) === JSON.stringify(expectedSelection)
    }, 'Main-persisted strict conversation selection', 10_000)
    process.stderr.write('knowledge-ui-smoke: selection-persisted\n')

    await mainWindow.reload()
    await waitFor(
      () => rendererMatches(`document.querySelector('[data-testid="knowledge-base-${knowledgeBaseId}"]')?.getAttribute('aria-checked') === 'true'
        && document.querySelector('[data-testid="knowledge-base-${knowledgeBaseId}"]')?.textContent?.includes('我的知识库') === true
        && document.querySelector('[data-testid="knowledge-base-${knowledgeBaseId}"]')?.textContent?.includes('已删除或不可用') === false
        && document.querySelector('[data-testid="knowledge-mode-strict"]')?.getAttribute('aria-checked') === 'true'`),
      'selection restored through built preload and validated IPC after Renderer reload',
    )
    process.stderr.write('knowledge-ui-smoke: selection-restored\n')
    const visible = await mainWindow.webContents.executeJavaScript(`({
      selectedBase: document.querySelector('[data-testid="knowledge-base-${knowledgeBaseId}"]')?.textContent,
      strict: document.querySelector('[data-testid="knowledge-mode-strict"]')?.getAttribute('aria-checked'),
    })`)
    if (!calls.includes('importDocument') || calls.filter((call) => call === 'updateConversationSelection').length < 2) {
      throw new Error(`IPC mutation path incomplete: ${JSON.stringify(calls)}`)
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      importAcknowledgement,
      persistedSelection: await knowledge.getConversationSelection(owner, conversationId),
      calls,
      visible,
    })}\n`)
  } finally {
    disposeIpc?.()
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy()
    await knowledge?.close().catch(() => undefined)
    await session.defaultSession.clearStorageData().catch(() => undefined)
    await rm(userData, { recursive: true, force: true })
    app.quit()
  }
}

void app.whenReady().then(run).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  app.exit(1)
})
