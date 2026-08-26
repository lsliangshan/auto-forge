import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
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
import {
  chatEventSchema,
  ipcChannels,
  type AuthSession,
  type KnowledgeDocument,
  type KnowledgeEntitlementState,
  type KnowledgeSelection,
} from '@autoforge/shared'
import { createApplicationRuntime } from '../main/application.js'
import type { AuthService } from '../main/auth/auth-service.js'
import type { ApplicationBrowserWorkspacePort } from '../main/browser/electron-browser-workspace.js'
import type { ModelStreamRequest } from '../main/chat/model-provider.js'
import type { CredentialBoundModelProvider } from '../main/chat/model-provider-registry.js'
import type { CloudBaseFunctionPort } from '../main/knowledge/cloudbase-knowledge-client.js'
import { createElectronParserSupervisor } from '../main/knowledge/parser-supervisor.js'
import type { KnowledgeReleaseEvidence } from '../main/knowledge/release-gates.js'
import { registerDesktopIpc } from '../main/ipc/register-ipc.js'
import type { NetworkProxyPort } from '../main/network/network-proxy-service.js'
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
const sessionSnapshot: AuthSession = {
  user: { id: owner.userId, account: 'SmokeUser' },
  authenticatedAt: '2026-08-26T00:00:00.000Z',
}
const releaseEvidence: KnowledgeReleaseEvidence = Object.freeze({
  approvedEvaluationCorpus: true,
  approvedRecallAt8: 0.9,
  approvedCitationSupportRate: 0.95,
  approvedGroundedAnswerRate: 0.95,
  approvedNoEvidenceRate: 0.95,
  approvedProcessingSuccessRate: 0.99,
  approvedPerformanceProfile: true,
  cloudBasePreproduction: true,
  cloudBaseAuthorization: true,
  tokenHubConsentAndRevocation: true,
  chatProviderDisclosure: true,
  productionEntitlementKey: true,
  productionEntitlementSigner: true,
  internalTelemetryReview: true,
  packagedNative: Object.freeze({ darwinArm64: true, darwinX64: true, windowsX64: true }),
})

let mainWindow: BrowserWindow | null = null
let disposeIpc: (() => void) | undefined
let runtime: ReturnType<typeof createApplicationRuntime> | undefined
let providerCalls = 0
let killSwitchEnabled = false
let chatFailureCode = ''
let providerStage = 'not-started'

function testAuthService(): AuthService {
  const unavailable = (): never => { throw new Error('Authentication mutation is unavailable in smoke') }
  return {
    getSession: async () => sessionSnapshot,
    sendOtp: async () => unavailable(),
    verifyOtp: async () => unavailable(),
    cancelOtp: async () => unavailable(),
    loginWithPassword: async () => unavailable(),
    updateUserProfile: async () => unavailable(),
    discardSession: async () => unavailable(),
    logout: async () => unavailable(),
    requireSession: async () => sessionSnapshot,
  }
}

const networkProxy: NetworkProxyPort = {
  initialize: async () => undefined,
  transition: async () => undefined,
  transitionOrFailClosed: async () => undefined,
  fetch: async () => { throw new Error('External network is disabled in knowledge smoke') },
  snapshot: async () => ({ enabled: false, bypassRules: '<local>' }),
  withTransportLease: async operation => operation({
    settings: { enabled: false, bypassDomains: [] },
  }),
}

function noopBrowserWorkspace(): ApplicationBrowserWorkspacePort {
  return new Proxy({}, {
    get(_target, property) {
      if (property === 'onContinuationActivity' || property === 'onPageInvalidated') {
        return () => () => undefined
      }
      if (property === 'setSessionStorageStore'
        || property === 'setContinuationRegistry'
        || property === 'setContinuationCommandHandlers') return () => undefined
      return async () => undefined
    },
  }) as ApplicationBrowserWorkspacePort
}

function lastToolName(request: ModelStreamRequest): string | undefined {
  const message = [...request.messages].reverse().find(candidate => (
    candidate.role === 'assistant' && candidate.tool_calls?.length
  ))
  return message?.role === 'assistant' ? message.tool_calls?.at(-1)?.function.name : undefined
}

function findEvidence(value: unknown): { evidenceId: string; snippet: string } | undefined {
  if (!value || typeof value !== 'object') return undefined
  if ('evidenceId' in value && 'snippet' in value
    && typeof value.evidenceId === 'string' && typeof value.snippet === 'string') {
    return { evidenceId: value.evidenceId, snippet: value.snippet }
  }
  for (const candidate of Array.isArray(value) ? value : Object.values(value)) {
    const found = findEvidence(candidate)
    if (found) return found
  }
  return undefined
}

function evidenceFromRequest(request: ModelStreamRequest): { evidenceId: string; snippet: string } {
  providerStage = 'reading-tool-message'
  const toolMessages = [...request.messages].reverse().filter(candidate => candidate.role === 'tool')
  for (const toolMessage of toolMessages) {
    if (toolMessage.role !== 'tool') continue
    const jsonLine = toolMessage.content.split('\n').find(line => line.startsWith('{'))
    if (!jsonLine) continue
    let payload: unknown
    try { payload = JSON.parse(jsonLine) } catch { continue }
    const evidence = findEvidence(payload)
    if (evidence) {
      providerStage = 'evidence-found'
      return evidence
    }
  }
  providerStage = 'tool-json-evidence-missing'
  throw new Error('Knowledge evidence was not returned by the real retriever')
}

function groundedAnswer(name: string, text: string, evidenceId: string) {
  return {
    type: 'tool_call' as const,
    choiceIndex: 0,
    index: 0,
    id: `smoke_${name}_${providerCalls}`,
    name: 'knowledge_grounded_answer' as const,
    arguments: { claims: [{ text, support: 'knowledge', citationIds: [evidenceId] }] },
  }
}

const providerCore: CredentialBoundModelProvider = {
  async listModels() {
    return [{
      id: 'openrouter/knowledge-smoke', name: 'Knowledge Smoke',
      inputModalities: ['text'], outputModalities: ['text'], supportsTools: true,
      generation: {}, contextLength: 128_000,
    }]
  },
  async validateCredential() { return { valid: true } },
  async *stream(request) {
    providerCalls += 1
    providerStage = `call-${providerCalls}-entered`
    const tools = request.tools?.map(tool => tool.function.name) ?? []
    if (!tools.includes('knowledge_search') && !tools.includes('knowledge_grounded_answer')) {
      yield { type: 'text_delta' as const, choiceIndex: 0, text: '知识验证' }
      yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
      return
    }
    const previousTool = lastToolName(request)
    if (!previousTool) {
      yield {
        type: 'tool_call' as const, choiceIndex: 0, index: 0,
        id: `smoke_search_${providerCalls}`, name: 'knowledge_search' as const,
        arguments: { query: 'release evidence' },
      }
      yield { type: 'finish' as const, choiceIndex: 0, reason: 'tool_calls' }
      return
    }
    const evidence = evidenceFromRequest(request)
    if (previousTool === 'knowledge_search') {
      yield groundedAnswer(
        'unsupported',
        evidence.snippet.replace('2026', '2025'),
        evidence.evidenceId,
      )
      yield { type: 'finish' as const, choiceIndex: 0, reason: 'tool_calls' }
      return
    }
    yield groundedAnswer('repaired', evidence.snippet, evidence.evidenceId)
    yield { type: 'finish' as const, choiceIndex: 0, reason: 'tool_calls' }
  },
  async acquireSnapshot() {
    return { providerId: 'openrouter', provider: providerCore, apiKeyFingerprint: 'smoke' }
  },
}

function entitlement(): KnowledgeEntitlementState {
  return {
    tier: 'member', status: 'active', betaEnabled: !killSwitchEnabled,
    cloudEnabled: !killSwitchEnabled, knowledgeToolEnabled: !killSwitchEnabled,
    killSwitchEnabled,
  }
}

const cloudFunctions: CloudBaseFunctionPort = {
  async callFunction({ data }) {
    if (data.action !== 'getEntitlement') throw new Error('Smoke CloudBase mutation is forbidden')
    return { result: { ok: true, data: {
      tier: 'member', status: 'active', betaEnabled: !killSwitchEnabled,
      cloudEnabled: !killSwitchEnabled,
      killSwitchEnabled, version: 1, validUntil: null,
    } } }
  },
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

function zipEntryNames(archive: Buffer): string[] {
  let endOffset = -1
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65_557); offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      endOffset = offset
      break
    }
  }
  if (endOffset < 0) throw new Error('Export ZIP end record is missing')
  const entryCount = archive.readUInt16LE(endOffset + 10)
  const centralSize = archive.readUInt32LE(endOffset + 12)
  const centralOffset = archive.readUInt32LE(endOffset + 16)
  if (centralOffset + centralSize !== endOffset) throw new Error('Export ZIP central directory is inconsistent')
  const names: string[] = []
  let offset = centralOffset
  while (offset < endOffset) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error('Export ZIP central entry is invalid')
    const nameLength = archive.readUInt16LE(offset + 28)
    const extraLength = archive.readUInt16LE(offset + 30)
    const commentLength = archive.readUInt16LE(offset + 32)
    const localOffset = archive.readUInt32LE(offset + 42)
    if (archive.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Export ZIP local entry is invalid')
    names.push(archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'))
    offset += 46 + nameLength + extraLength + commentLength
  }
  if (names.length !== entryCount || offset !== endOffset) throw new Error('Export ZIP entry count is invalid')
  return names
}

async function run(): Promise<void> {
  let exitCode = 0
  try {
    process.stderr.write('knowledge-ui-smoke: app-ready\n')
    await writeFile(sourceFile, 'The release evidence is valid in 2026.')
    runtime = createApplicationRuntime({
      paths: {
        database: join(userData, 'autoforge.sqlite'), data: userData, logs: join(userData, 'logs'),
        projects: join(userData, 'projects'), installations: join(userData, 'workflows'),
        workflowRunner: join(userData, 'workflow-runner.cjs'), temporary: join(userData, 'temporary'),
      },
      safeStorage: {
        isAvailable: async () => safeStorage.isEncryptionAvailable(),
        encrypt: async value => safeStorage.encryptString(value),
        decrypt: async value => ({ value: safeStorage.decryptString(value), shouldReEncrypt: false }),
      },
      authService: testAuthService(),
      networkProxy,
      browserWorkspace: noopBrowserWorkspace(),
      modelProviders: { openrouter: providerCore },
      chooseProjectDirectory: async () => undefined,
      chooseMediaFiles: async () => [],
      chooseAvatarFile: async () => undefined,
      readClipboardImage: () => undefined,
      chooseMediaSavePath: async () => undefined,
      revealPath: () => undefined,
      openExternal: async () => undefined,
      emitChat: event => {
        const parsed = chatEventSchema.safeParse(event)
        if (parsed.success) {
          if (parsed.data.type === 'status' && parsed.data.status === 'failed') {
            chatFailureCode = parsed.data.error?.code ?? 'unknown'
          }
          mainWindow?.webContents.send(ipcChannels.chatEvent, parsed.data)
        }
      },
      emitExecution: () => undefined,
      createKnowledgeParser: () => createElectronParserSupervisor(parserWorkerFile, parserPreloadFile),
      chooseKnowledgeFile: async () => sourceFile,
      chooseKnowledgeExportPath: async () => exportFile,
      knowledgeEntitlement: { getEntitlement: async () => entitlement() },
      knowledgeCloudFunctions: cloudFunctions,
      knowledgePlatform: process.platform,
      knowledgeArch: process.arch,
      knowledgeReleaseEvidence: releaseEvidence,
      appInfo: { version: '0.1.0-smoke', platform: process.platform === 'win32' ? 'win32' : 'darwin' },
    })
    await runtime.recover()
    await runtime.services.settings.saveProviderApiKey('openrouter', 'smoke-only-key')
    const settings = await runtime.services.settings.get()
    await runtime.services.settings.update({
      activeProvider: 'openrouter',
      defaultModels: { ...settings.defaultModels, openrouter: { text: 'openrouter/knowledge-smoke' } },
    })
    const conversation = await runtime.services.chat.createConversation()
    const conversationId = conversation.id
    process.stderr.write('knowledge-ui-smoke: application-created\n')

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
          services: runtime!.services,
          getMainWindow: () => mainWindow,
          rendererTarget: target,
        })
      },
    })
    mainWindow = created as BrowserWindow
    process.stderr.write('knowledge-ui-smoke: window-created\n')
    await mainWindow.webContents.executeJavaScript(`location.hash = '#/knowledge'; true`)
    await waitFor(
      () => rendererMatches(`document.querySelector('[data-testid="knowledge-import"]')?.disabled === false`),
      'enabled knowledge import',
    )
    await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-testid="knowledge-import"]')?.click(); true`)
    await waitFor(
      () => rendererMatches(`document.body.innerText.includes(${JSON.stringify(basename(sourceFile))})`),
      'Renderer import acknowledgement',
    )
    const [base] = await runtime.services.knowledge.listBases(owner)
    const imported: KnowledgeDocument | undefined = base
      ? (await runtime.services.knowledge.listDocuments(owner, base.id))[0]
      : undefined
    if (!imported) throw new Error('Import acknowledgement is missing')
    const documentId = imported.id
    const knowledgeBaseId = imported.knowledgeBaseId
    await waitFor(async () => (
      (await runtime!.services.knowledge.listDocuments(owner, knowledgeBaseId))[0]?.status === 'ready'
    ), 'real parser ready-version publication')
    process.stderr.write('knowledge-ui-smoke: document-ready\n')

    await mainWindow.loadFile(rendererFile, { hash: '/chat' })
    await waitFor(
      () => rendererMatches(`document.querySelector('[data-testid="knowledge-base-${knowledgeBaseId}"]')?.disabled === false`),
      'enabled knowledge selector',
    )
    await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-testid="knowledge-base-${knowledgeBaseId}"]')?.click(); true`)
    await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-testid="knowledge-mode-strict"]')?.click(); true`)
    const expectedSelection: KnowledgeSelection = {
      knowledgeBaseIds: [knowledgeBaseId], knowledgeMode: 'strict',
    }
    await waitFor(async () => {
      const persisted = await runtime!.services.knowledge.getConversationSelection(owner, conversationId)
      return JSON.stringify(persisted) === JSON.stringify(expectedSelection)
    }, 'Main-persisted strict selection')

    await waitFor(
      () => rendererMatches(`document.querySelector('textarea[aria-label="消息内容"]') !== null`),
      'visible chat composer',
    )
    await mainWindow.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('textarea[aria-label="消息内容"]');
      if (!(input instanceof HTMLTextAreaElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(input, 'What year is supported by my library?');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`)
    await waitFor(
      () => rendererMatches(`document.querySelector('[data-testid="send-message"]')?.disabled === false`),
      'enabled chat send',
    )
    await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-testid="send-message"]')?.click(); true`)
    try {
      await waitFor(
        () => rendererMatches(`document.querySelector('[data-testid="grant-knowledge-consent"]') !== null
          || document.querySelector('[data-testid="knowledge-answer"]') !== null`),
        'knowledge provider consent or grounded answer',
        10_000,
      )
    } catch {
      const observed = await runtime.services.chat.listMessages(conversationId)
      const blockTypes = observed.flatMap(message => message.blocks.map(block => block.type))
      throw new Error(`Knowledge consent missing after ${providerCalls} provider calls at ${providerStage}, failure ${chatFailureCode || 'none'}, and block types ${JSON.stringify(blockTypes)}`)
    }
    await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-testid="grant-knowledge-consent"]')?.click(); true`)
    try {
      await waitFor(
        () => rendererMatches(`document.querySelector('[data-testid="knowledge-answer"]') !== null
          && document.querySelector('[data-testid="knowledge-citation-0"]') !== null
          && document.querySelector('[data-testid="response-loader"]') === null`),
        'durable grounded Agent answer',
        10_000,
      )
    } catch {
      const observed = await runtime.services.chat.listMessages(conversationId)
      const blockTypes = observed.flatMap(message => message.blocks.map(block => block.type))
      throw new Error(`Grounded answer missing after ${providerCalls} provider calls, ${observed.length} durable messages, and block types ${JSON.stringify(blockTypes)}`)
    }
    const messages = await runtime.services.chat.listMessages(conversationId)
    const assistant = [...messages].reverse().find(message => message.role === 'assistant')
    if (!assistant?.blocks.some(block => block.type === 'knowledge_answer') || providerCalls < 3) {
      throw new Error('Application did not persist a repaired grounded answer')
    }
    process.stderr.write('knowledge-ui-smoke: agent-repair-persisted\n')

    await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-testid="knowledge-citation-0"]')?.click(); true`)
    await waitFor(
      () => rendererMatches(`(document.querySelector('[data-testid="knowledge-citation-preview"] blockquote')?.textContent?.length ?? 0) > 0`),
      'Application-resolved citation preview',
    )
    process.stderr.write('knowledge-ui-smoke: citation-preview-visible\n')

    const beforeKill = await mainWindow.webContents.executeJavaScript(`window.autoForge.knowledge.getFeatureAvailability()`)
    if (beforeKill.cloud.available !== true) throw new Error('Cloud gate was not open before the controlled kill switch')
    killSwitchEnabled = true
    const availability = await mainWindow.webContents.executeJavaScript(`window.autoForge.knowledge.getFeatureAvailability()`)
    if (availability.local.available !== true
      || availability.cloud.available !== false
      || !availability.cloud.reasons.includes('kill_switch_enabled')) {
      throw new Error('Main-owned cloud kill switch did not fail closed')
    }

    await mainWindow.webContents.executeJavaScript(`window.autoForge.knowledge.exportBase(${JSON.stringify(knowledgeBaseId)})`)
    const archiveNames = zipEntryNames(await readFile(exportFile))
    const expectedOriginal = `originals/${documentId}/v1/${basename(sourceFile)}`
    if (!archiveNames.includes('manifest.json') || !archiveNames.includes(expectedOriginal)) {
      throw new Error('Export ZIP does not contain the required structural entries')
    }
    process.stderr.write('knowledge-ui-smoke: export-validated\n')

    await mainWindow.webContents.executeJavaScript(`window.autoForge.knowledge.recycleDocument(${JSON.stringify(documentId)})`)
    await mainWindow.webContents.executeJavaScript(`window.autoForge.knowledge.purgeDocument(${JSON.stringify(documentId)})`)
    if ((await runtime.services.knowledge.listDocuments(owner, knowledgeBaseId)).length !== 0) {
      throw new Error('Permanent delete retained the smoke document')
    }
    await mainWindow.loadFile(rendererFile, { hash: '/knowledge' })
    await waitFor(
      () => rendererMatches(`document.body.innerText.includes('还没有文件')`),
      'visible empty library after permanent delete',
    )
    process.stderr.write('knowledge-ui-smoke: delete-visible\n')
    process.stdout.write(`${JSON.stringify({
      ok: true,
      rendererChatSend: true,
      applicationAgentRepair: true,
      durableCitationPreview: true,
      exportZipValidated: true,
      deleteCompleted: true,
      cloudAvailableAfterKill: availability.cloud.available,
    })}\n`)
    await writeFile(join(userData, '.knowledge-smoke-complete'), 'ok')
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    exitCode = 1
  } finally {
    disposeIpc?.()
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy()
    await runtime?.close().catch(() => undefined)
    await session.defaultSession.clearStorageData().catch(() => undefined)
    app.exit(exitCode)
  }
}

void app.whenReady().then(run).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  app.exit(1)
})
