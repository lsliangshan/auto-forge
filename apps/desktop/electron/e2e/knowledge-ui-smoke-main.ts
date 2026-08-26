import { access, writeFile } from 'node:fs/promises'
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
import type {
  AuthSession,
  ChatMessage,
  KnowledgeCitationReference,
  KnowledgeDocument,
  KnowledgeSelection,
} from '@autoforge/shared'
import { registerDesktopIpc, type DesktopIpcServices } from '../main/ipc/register-ipc.js'
import { KnowledgeService } from '../main/knowledge/knowledge-service.js'
import { createElectronParserSupervisor } from '../main/knowledge/parser-supervisor.js'
import { createSecureWindow } from '../main/window.js'

process.stderr.write('knowledge-ui-smoke: entry\n')

const rendererFile = fileURLToPath(new URL('../../out/renderer/index.html', import.meta.url))
const preloadFile = fileURLToPath(new URL('../../out/preload/index.cjs', import.meta.url))
const parserWorkerFile = fileURLToPath(new URL('../../out/renderer/electron/main/knowledge/parser-worker.html', import.meta.url))
const parserPreloadFile = fileURLToPath(new URL('../../out/preload/parser.cjs', import.meta.url))
const smokeRoot = process.env.AUTOFORGE_KNOWLEDGE_SMOKE_ROOT
if (!smokeRoot) throw new Error('Parent-owned knowledge smoke workspace is required')
const userData: string = smokeRoot
const sourceFile = join(userData, 'smoke-source.txt')
const exportFile = join(userData, 'knowledge-export.zip')
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
let chatMessages: ChatMessage[] = []
let expectedCitation: KnowledgeCitationReference | undefined
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
      if (property === 'searchSnapshot') {
        return async (...args: Parameters<KnowledgeService['searchSnapshot']>) => {
          calls.push('searchSnapshot')
          return target.searchSnapshot(...args)
        }
      }
      if (property === 'previewCitation') {
        return async (...args: Parameters<KnowledgeService['previewCitation']>) => {
          calls.push('previewCitation')
          return target.previewCitation(...args)
        }
      }
      if (property === 'exportBase') {
        return async (...args: Parameters<KnowledgeService['exportBase']>) => {
          calls.push('exportBase')
          return target.exportBase(...args)
        }
      }
      if (property === 'recycleDocument') {
        return async (...args: Parameters<KnowledgeService['recycleDocument']>) => {
          calls.push('recycleDocument')
          return target.recycleDocument(...args)
        }
      }
      if (property === 'purgeDocument') {
        return async (...args: Parameters<KnowledgeService['purgeDocument']>) => {
          calls.push('purgeDocument')
          return target.purgeDocument(...args)
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
    previewKnowledgeCitation: async (
      candidateOwner: Parameters<DesktopIpcServices['previewKnowledgeCitation']>[0],
      input: Parameters<DesktopIpcServices['previewKnowledgeCitation']>[1],
    ) => {
      if (candidateOwner.userId !== owner.userId
        || input.conversationId !== conversationId
        || input.messageId !== 'message_knowledge'
        || input.blockId !== 'block_knowledge'
        || input.citationIndex !== 0
        || !expectedCitation) throw new Error('Controlled smoke citation scope is invalid')
      return service.previewCitation(candidateOwner, expectedCitation)
    },
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
      listMessages: async () => chatMessages,
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
    knowledge: service,
    system: { getAppInfo: async () => ({ version: '0.1.0', platform: 'darwin' }) },
  } as unknown as DesktopIpcServices
}

async function waitFor(check: () => Promise<boolean>, description: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const matched = await Promise.race([
      check(),
      new Promise<false>((resolve) => globalThis.setTimeout(() => resolve(false), 2_000)),
    ])
    if (matched) return
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
  let exitCode = 0
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
      chooseExportPath: async () => exportFile,
      ownsConversation: async (candidate, candidateConversationId) => (
        candidate.userId === owner.userId && candidateConversationId === conversationId
      ),
      entitlement: {
        getEntitlement: async () => ({
          tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: false,
          knowledgeToolEnabled: true, killSwitchEnabled: false,
        }),
      },
      platform: process.platform,
      arch: process.arch,
      runtimeAvailable: true,
    })
    const ipcKnowledge = trackedKnowledge(knowledge)
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
          services: createServices(ipcKnowledge),
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
      () => rendererMatches(`document.querySelector('[data-testid="knowledge-base-${knowledgeBaseId}"]')?.disabled === false`),
      'enabled conversation knowledge selector from refreshed Main catalog',
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

    const searchSnapshot = await ipcKnowledge.captureSearchSnapshot(owner, conversationId)
    const searchOutcome = await ipcKnowledge.searchSnapshot(owner, searchSnapshot, 'Electron knowledge')
    const evidence = searchOutcome.results[0]
    if (!evidence) throw new Error('Real local chat retrieval returned no evidence')
    expectedCitation = evidence.citation
    chatMessages = [{
      id: 'message_knowledge', conversationId, role: 'assistant',
      blocks: [{
        type: 'knowledge_answer', blockId: 'block_knowledge', mode: 'strict',
        claims: [{ text: evidence.snippet, support: 'knowledge', citations: [evidence.citation] }],
      }],
      createdAt: '2026-08-26T00:00:01.000Z',
    }]
    process.stderr.write('knowledge-ui-smoke: local-retrieval-completed\n')

    await mainWindow.reload()
    await waitFor(
      () => rendererMatches(`document.querySelector('[data-testid="knowledge-base-${knowledgeBaseId}"]')?.getAttribute('aria-checked') === 'true'
        && document.querySelector('[data-testid="knowledge-base-${knowledgeBaseId}"]')?.textContent?.includes('我的知识库') === true
        && document.querySelector('[data-testid="knowledge-base-${knowledgeBaseId}"]')?.textContent?.includes('已删除或不可用') === false
        && document.querySelector('[data-testid="knowledge-mode-strict"]')?.getAttribute('aria-checked') === 'true'`),
      'selection restored through built preload and validated IPC after Renderer reload',
    )
    process.stderr.write('knowledge-ui-smoke: selection-restored\n')
    await waitFor(
      () => rendererMatches(`document.querySelector('[data-testid="knowledge-answer"]') !== null
        && document.querySelector('[data-testid="knowledge-citation-0"]') !== null`),
      'visible grounded chat answer and citation',
    )
    await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-testid="knowledge-citation-0"]')?.click(); true`)
    await waitFor(
      () => rendererMatches(`document.querySelector('[data-testid="knowledge-citation-preview"] blockquote')?.textContent?.includes('Electron knowledge') === true`),
      'controlled citation preview through Renderer, Preload, IPC, Main, and encrypted source',
    )
    process.stderr.write('knowledge-ui-smoke: citation-preview-visible\n')

    await mainWindow.webContents.executeJavaScript(`window.autoForge.knowledge.exportBase(${JSON.stringify(knowledgeBaseId)})`)
    await access(exportFile)
    process.stderr.write('knowledge-ui-smoke: export-completed\n')
    const availability = await mainWindow.webContents.executeJavaScript(`window.autoForge.knowledge.getFeatureAvailability()`)
    if (availability.local.available !== true
      || availability.cloud.available !== false
      || !availability.cloud.reasons.includes('kill_switch_enabled')) {
      throw new Error(`Cloud-disabled degradation was not fail-closed: ${JSON.stringify(availability)}`)
    }
    const documentId = importAcknowledgement.id
    await mainWindow.webContents.executeJavaScript(`window.autoForge.knowledge.recycleDocument(${JSON.stringify(documentId)})`)
    await mainWindow.webContents.executeJavaScript(`window.autoForge.knowledge.purgeDocument(${JSON.stringify(documentId)})`)
    if ((await knowledge.listDocuments(owner, knowledgeBaseId)).length !== 0) {
      throw new Error('Permanent delete retained the smoke document')
    }
    await mainWindow.loadFile(rendererFile, { hash: '/knowledge' })
    await waitFor(
      () => rendererMatches(`document.body.innerText.includes('还没有文件')`),
      'visible empty library after recycle and permanent delete',
    )
    process.stderr.write('knowledge-ui-smoke: delete-visible\n')
    const requiredFullFlowCalls = [
      'importDocument', 'updateConversationSelection', 'searchSnapshot',
      'previewCitation', 'exportBase', 'recycleDocument', 'purgeDocument',
    ]
    if (requiredFullFlowCalls.some(call => !calls.includes(call))
      || calls.filter((call) => call === 'updateConversationSelection').length < 2) {
      throw new Error(`IPC mutation path incomplete: ${JSON.stringify(calls)}`)
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      importedStatus: importAcknowledgement.status,
      persistedSelectionCount: (await knowledge.getConversationSelection(owner, conversationId)).knowledgeBaseIds.length,
      persistedKnowledgeMode: (await knowledge.getConversationSelection(owner, conversationId)).knowledgeMode,
      calls,
      citationPreview: 'available',
      exportCompleted: true,
      deleteCompleted: true,
      cloudAvailable: availability.cloud.available,
    })}\n`)
    await writeFile(join(userData, '.knowledge-smoke-complete'), 'ok')
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    exitCode = 1
  } finally {
    disposeIpc?.()
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy()
    await knowledge?.close().catch(() => undefined)
    await session.defaultSession.clearStorageData().catch(() => undefined)
    app.exit(exitCode)
  }
}

void app.whenReady().then(run).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  app.exit(1)
})
