import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import {
  app,
  BrowserWindow,
  ipcMain,
  nativeTheme,
  protocol,
  session,
  type Event,
} from 'electron'
import {
  chatEventSchema,
  executionEventSchema,
  ipcChannels,
  knowledgeEventSchema,
  toSafeAppError,
  type AuthSession,
  type ChatEvent,
  type KnowledgeEntitlementState,
} from '@autoforge/shared'
import { createApplicationRuntime, type ApplicationModelProviderPort } from '../main/application.js'
import type { AuthService } from '../main/auth/auth-service.js'
import { CloudBaseUserDataPort } from '../main/cloud/cloudbase-user-data-port.js'
import { openAppDatabase } from '../main/database/client.js'
import { UserDataStoreManager } from '../main/database/user-data-client.js'
import type {
  ApplicationBrowserWorkspacePort,
  BrowserWorkspaceTab,
} from '../main/browser/electron-browser-workspace.js'
import { registerDesktopIpc } from '../main/ipc/register-ipc.js'
import { createMediaProtocolHandler } from '../main/media/media-protocol.js'
import type { NetworkProxyPort } from '../main/network/network-proxy-service.js'
import { createSecureWindow } from '../main/window.js'
import { KnowledgeStoreFactory } from '../main/knowledge/encrypted-database.js'
import { createLocalKnowledgeService, type LocalKnowledgeService } from '../main/knowledge/knowledge-service.js'
import type { CloudKnowledgeRemote } from '../main/knowledge/sync-service.js'
import type { ModelStreamRequest } from '../main/chat/model-provider.js'

type FixtureUser = 'alice' | 'bob'

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing E2E environment variable: ${name}`)
  return value
}

function fixtureUser(value: string): FixtureUser {
  if (value === 'alice' || value === 'bob') return value
  throw new Error(`Unsupported E2E fixture user: ${value}`)
}

const desktopRoot = requiredEnvironment('AUTOFORGE_E2E_DESKTOP_ROOT')
const userData = requiredEnvironment('AUTOFORGE_E2E_USER_DATA')
const fixtureOrigin = new URL(requiredEnvironment('AUTOFORGE_E2E_USER_DATA_FIXTURE')).origin
const knowledgeReleaseSmoke = process.env.AUTOFORGE_E2E_KNOWLEDGE_RELEASE === '1'
const databasePath = join(userData, 'autoforge.sqlite')
const password = 'password-e2e'

protocol.registerSchemesAsPrivileged([{
  scheme: 'autoforge-media',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}])
app.setPath('userData', userData)

function sessionFor(user: FixtureUser): AuthSession {
  return {
    user: { id: user, account: user === 'alice' ? 'Alice' : 'Bob' },
    authenticatedAt: '2026-08-25T00:00:00.000Z',
    authorization: {
      role: 'user',
      capabilities: [],
      version: 1,
      updatedAt: '2026-08-25T00:00:00.000Z',
      confirmed: true,
    },
  }
}

function testAuthService(initialUser: FixtureUser): AuthService & { currentUser(): FixtureUser | undefined } {
  let current: FixtureUser | undefined = initialUser
  const requireCurrent = (): FixtureUser => {
    if (!current) throw toSafeAppError({ code: 'AUTH_REQUIRED' })
    return current
  }
  return {
    currentUser: () => current,
    async getSession() { return current ? sessionFor(current) : null },
    async sendOtp() { return { challengeId: 'e2e_challenge', expiresIn: 300 } },
    async verifyOtp() { return sessionFor(requireCurrent()) },
    async cancelOtp() { /* deterministic no-op */ },
    async loginWithPassword(input) {
      const user = input.account.toLocaleLowerCase()
      if ((user !== 'alice' && user !== 'bob') || input.password !== password) {
        throw toSafeAppError({ code: 'AUTH_INVALID_CREDENTIALS' })
      }
      current = user
      return sessionFor(current)
    },
    async updateUserProfile(input) {
      const session = sessionFor(requireCurrent())
      return { ...session.user, profile: { ...session.user.profile, ...input } }
    },
    async discardSession() { current = undefined },
    async logout() { current = undefined },
    async requireSession() { return sessionFor(requireCurrent()) },
  }
}

function createBrowserWorkspace(): ApplicationBrowserWorkspacePort {
  let currentUrl = 'https://fixture.invalid/'
  const tab: BrowserWorkspaceTab = {
    id: 'cloud-user-data-e2e-tab',
    navigationEpoch: 0,
    async open(url) { currentUrl = url },
    async fill() { /* unused by this fixture */ },
    async click() { /* unused by this fixture */ },
    async url() { return currentUrl },
    async currentOrigin() { return new URL(currentUrl).origin },
    async focus() { /* unused by this fixture */ },
    async close() { /* unused by this fixture */ },
  }
  return {
    setSessionStorageStore() { /* no browser session is opened */ },
    async acquire() { return tab },
    async releaseExecution() { /* no browser execution is opened */ },
    setContinuationRegistry() { /* no continuation is bound */ },
    markContinuationBound() { /* no continuation is bound */ },
    async updateProxy() { /* local fixture does not use a browser proxy */ },
    async reset() { /* no browser state is retained */ },
    async shutdown() { /* no browser state is retained */ },
    async acquireContinuation() { /* no continuation is bound */ },
    async releaseContinuation() { /* no continuation is bound */ },
    async suspendContinuation() { /* no continuation is bound */ },
    async resumeContinuation() { /* no continuation is bound */ },
    onContinuationActivity() { return () => undefined },
    async closeContinuation() { /* no continuation is bound */ },
    async getContinuationState() {
      return {
        origin: 'https://fixture.invalid',
        url: currentUrl,
        navigationEpoch: 0,
        activityRevision: 0,
      }
    },
    async focusContinuation() { /* no continuation is bound */ },
    async highlightContinuationTarget() { /* no continuation is bound */ },
    async clearContinuationHighlight() { /* no continuation is bound */ },
    async performContinuationAction() { /* no continuation is bound */ },
    async describeContinuation() { return undefined },
    async clearUserData() { /* profiles are deleted by Playwright */ },
    setContinuationCommandHandlers() { /* no continuation is bound */ },
    async readAccessibilitySnapshot(input) {
      return {
        tabId: input.tabId,
        navigationEpoch: input.expectedNavigationEpoch,
        origin: input.expectedOrigin,
        url: input.expectedOrigin,
        title: 'Unused fixture page',
        frameId: 'frame_unused',
        viewportWidth: 1,
        viewportHeight: 1,
        nodes: [],
        locatorMatches: [],
      }
    },
    async readNode() { return undefined },
    async getNodeBox() {
      return { x: 0, y: 0, width: 1, height: 1, viewportWidth: 1, viewportHeight: 1 }
    },
    async captureNodeScreenshot() { return '' },
    async capturePageScreenshot() { return '' },
    onPageInvalidated() { return () => undefined },
  }
}

let providerRequestCount = 0
let knowledgeSnippetDisclosureCount = 0
let knowledgeCloudCallCount = 0
const recordedChatEvents: ChatEvent[] = []

function countedCloudRemote(): CloudKnowledgeRemote {
  const count = <T>(result: T): Promise<T> => {
    knowledgeCloudCallCount += 1
    return Promise.resolve(result)
  }
  return {
    beginSync: input => count({
      knowledgeBaseId: input.knowledgeBaseId, generationId: input.generationId, status: 'staging',
    }),
    pushMutation: input => count({
      mutationId: input.mutationId, status: 'applied', sequence: 1, revision: 'e2e-cloud-revision',
    }),
    pullChanges: () => count({ kind: 'incremental', nextSequence: 0, hasMore: false, changes: [] }),
    fullResync: () => count({ kind: 'snapshot', nextSequence: 0, changes: [] }),
    publishGeneration: input => count({
      generationId: input.generationId, previousGenerationId: null, sequence: 1,
    }),
    deleteKnowledgeBase: () => count({ deletionJobId: 'e2e-delete-job' }),
    getJob: input => count({ jobId: input.jobId, state: 'completed', errorCode: null }),
    cancelJob: () => count(undefined),
    cleanupOrphans: () => count({ removed: 0 }),
  }
}

const deterministicProvider: ApplicationModelProviderPort = {
  async listModels() {
    return [{
      id: 'e2e-knowledge-model', name: 'E2E Knowledge',
      inputModalities: ['text'], outputModalities: ['text'], supportsTools: true,
      generation: {},
    }]
  },
  async validateCredential() { return { valid: true } },
  async *stream(request: ModelStreamRequest) {
    providerRequestCount += 1
    const hasKnowledgeResult = request.messages.some(message => (
      message.role === 'tool'
      && typeof message.content === 'string'
      && message.content.includes('UNTRUSTED_KNOWLEDGE_EVIDENCE')
    ))
    if (hasKnowledgeResult) {
      knowledgeSnippetDisclosureCount += 1
      const rawToolContent = request.messages.find(message => (
        message.role === 'tool'
        && typeof message.content === 'string'
        && message.content.includes('UNTRUSTED_KNOWLEDGE_EVIDENCE')
      ))?.content ?? ''
      const toolContent = typeof rawToolContent === 'string' ? rawToolContent : ''
      const evidenceId = /"evidenceId":"([^"]+)"/u.exec(toolContent)?.[1]
      if (!evidenceId) throw new Error('E2E knowledge evidence ID is missing')
      yield { type: 'text_delta' as const, choiceIndex: 0, text: `AutoForge knowledge smoke [[kb:${evidenceId}]]` }
      yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
      return
    }
    const consentRequired = request.messages.some(message => (
      message.role === 'tool' && typeof message.content === 'string' && message.content.includes('consent_required')
    ))
    if (consentRequired) {
      yield { type: 'text_delta' as const, choiceIndex: 0, text: '等待知识库授权。' }
      yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
      return
    }
    if (request.tools?.some(tool => tool.function.name === 'knowledge_search')) {
      yield {
        type: 'tool_call' as const, choiceIndex: 0, index: 0, id: 'e2e_knowledge_search',
        name: 'knowledge_search', arguments: { query: 'AutoForge knowledge smoke' },
      }
      yield { type: 'finish' as const, choiceIndex: 0, reason: 'tool_calls' }
      return
    }
    yield { type: 'text_delta' as const, choiceIndex: 0, text: '知识库问答' }
    yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
  },
  async acquireSnapshot() {
    return { providerId: 'openrouter', provider: deterministicProvider, apiKeyFingerprint: 'e2e' }
  },
}

const deterministicDeepseekProvider: ApplicationModelProviderPort = {
  ...deterministicProvider,
  async listModels() {
    return [{
      id: 'deepseek-chat', name: 'E2E DeepSeek',
      inputModalities: ['text'], outputModalities: ['text'], supportsTools: true,
      generation: {},
    }]
  },
  async acquireSnapshot() {
    return { providerId: 'deepseek', provider: deterministicDeepseekProvider, apiKeyFingerprint: 'e2e-deepseek' }
  },
}

const networkProxy: NetworkProxyPort = {
  async initialize() { /* local-only */ },
  async transition() { /* local-only */ },
  async transitionOrFailClosed() { /* local-only */ },
  async snapshot() { return { enabled: false, bypassRules: '<local>', playwrightArgs: [] } },
  async withTransportLease(operation) {
    return operation({ settings: { enabled: false, bypassDomains: [] } })
  },
  async fetch() {
    providerRequestCount += 1
    throw toSafeAppError({ code: 'MODEL_PROVIDER_UNAVAILABLE' })
  },
}

let mainWindow: BrowserWindow | null = null
let runtime: ReturnType<typeof createApplicationRuntime> | undefined
let disposeIpc: (() => void) | undefined
let userDataStores: UserDataStoreManager | undefined
let e2eKnowledgeNow = Date.parse('2026-08-28T00:00:00.000Z')
const e2eKnowledgeEntitlement: KnowledgeEntitlementState = {
  tier: 'member', status: 'active', localEnabled: true, betaEnabled: true, cloudEnabled: true,
  expiresAt: '2026-08-29T00:00:00.000Z', graceEndsAt: '2026-08-31T00:00:00.000Z',
}

function emit(channel: string, value: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
  mainWindow.webContents.send(channel, value)
}

function seedLegacyData(): void {
  openAppDatabase(databasePath).close()
  const database = new Database(databasePath)
  try {
    database.prepare(`
      INSERT INTO conversations (id, title, title_state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      'legacy_unowned_conversation',
      '本机未归属历史',
      'user_named',
      Date.UTC(2026, 7, 20),
      Date.UTC(2026, 7, 20),
    )
    const insertMessage = database.prepare(`
      INSERT INTO messages (
        id, conversation_id, role, blocks_json, ordinal, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `)
    const insertMessages = database.transaction(() => {
      for (let index = 1; index <= 99; index += 1) {
        const createdAt = Date.UTC(2026, 7, 20, 0, 0, index)
        insertMessage.run(
          `legacy_unowned_message_${String(index).padStart(3, '0')}`,
          'legacy_unowned_conversation',
          index % 2 === 0 ? 'assistant' : 'user',
          JSON.stringify([{ type: 'text', text: `历史消息 ${index}` }]),
          index,
          createdAt,
        )
      }
    })
    insertMessages()
  } finally {
    database.close()
  }
}

async function runStrictKnowledgeAsk(baseId: string, content: string): Promise<{
  consentRequired: boolean
  providerSnippetDisclosures: number
  providerSnippetDisclosureDelta: number
  terminalStatus: 'completed'
}> {
  if (!runtime) throw new Error('Cloud user-data E2E runtime is unavailable')
  const conversation = await runtime.services.chat.createConversation()
  const preferences = await runtime.services.chat.getGenerationPreferences(conversation.id)
  await runtime.services.chat.updateGenerationPreferences(conversation.id, {
    ...preferences,
    knowledgeBaseIds: [baseId],
    knowledgeMode: 'strict',
  })
  const beforeEvents = recordedChatEvents.length
  const beforeDisclosure = knowledgeSnippetDisclosureCount
  await runtime.services.chat.send({
    conversationId: conversation.id,
    content,
    assetIds: [],
    outputType: 'auto',
    generation: {
      image: { count: 1, resolution: '1K', aspectRatio: 'auto', format: 'png' },
      audio: { format: 'mp3' },
      video: { durationSeconds: 5, resolution: '720p', aspectRatio: 'auto', generateAudio: false },
    },
  })
  let terminalStatus: 'completed' | 'cancelled' | 'failed' | undefined
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const terminal = recordedChatEvents.slice(beforeEvents).find(event => (
      event.type === 'status'
      && event.conversationId === conversation.id
      && ['completed', 'cancelled', 'failed'].includes(event.status)
    ))
    if (terminal?.type === 'status' && terminal.status !== 'running') {
      terminalStatus = terminal.status
      break
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  if (terminalStatus !== 'completed') {
    throw new Error(`Knowledge consent ask did not complete: ${terminalStatus ?? 'timeout'}`)
  }
  const consentRequired = recordedChatEvents.slice(beforeEvents).some(event => (
    (event.type === 'block' || event.type === 'block_update')
    && event.conversationId === conversation.id
    && event.block.type === 'knowledge_status'
    && event.block.status === 'consent_required'
  ))
  return {
    consentRequired,
    providerSnippetDisclosures: knowledgeSnippetDisclosureCount,
    providerSnippetDisclosureDelta: knowledgeSnippetDisclosureCount - beforeDisclosure,
    terminalStatus,
  }
}

async function dispatch(name: string, input: Record<string, unknown>): Promise<unknown> {
  if (!runtime) throw new Error('Cloud user-data E2E runtime is unavailable')
  if (name === 'grantCloudSync') {
    return runtime.services.settings.recordPrivacyConsent({
      purpose: 'cloud_sync',
      documentVersion: 'cloud-sync-2026-08',
      consentedAt: new Date().toISOString(),
      clientVersion: '0.1.0-e2e',
    })
  }
  if (name === 'selectedConversation') {
    return (await runtime.services.chat.listConversations({ limit: 50 })).items[0]?.id ?? ''
  }
  if (name === 'switchUser') {
    const user = fixtureUser(String(input.user))
    return runtime.services.auth.loginWithPassword({ account: user, password })
  }
  if (name === 'refreshConversations') {
    await runtime.services.chat.listConversations({ limit: 50 })
    return true
  }
  if (name === 'pendingOutbox') return userDataStores?.current()?.outbox.countPending() ?? 0
  if (name === 'receiptEvidenceCount') {
    const session = await runtime.services.auth.getSession()
    if (!session) throw new Error('Cloud user-data E2E session is unavailable')
    const scope = createHash('sha256')
      .update('autoforge-user-cache-v1\0')
      .update(session.user.id)
      .digest('hex')
      .slice(0, 32)
    const database = new Database(join(userData, 'user-caches', `${scope}.sqlite`), {
      readonly: true,
    })
    try {
      return (database.prepare('SELECT COUNT(*) AS count FROM sync_receipt_evidence').get() as {
        count: number
      }).count
    } finally {
      database.close()
    }
  }
  if (name === 'providerRequestCount') return providerRequestCount
  if (name === 'knowledgeAvailability') {
    const session = await runtime.services.auth.getSession()
    if (!session) throw new Error('Knowledge release smoke session is unavailable')
    return runtime.services.knowledge.getAvailability({ userId: session.user.id })
  }
  if (name === 'knowledgeEntitlement') {
    const session = await runtime.services.auth.getSession()
    if (!session) throw new Error('Knowledge release smoke session is unavailable')
    return runtime.services.knowledge.getEntitlement({ userId: session.user.id })
  }
  if (name === 'providerSnippetConsentRevocation') {
    const session = await runtime.services.auth.getSession()
    if (!session) throw new Error('Knowledge release smoke session is unavailable')
    const owner = { userId: session.user.id }
    const knowledge = runtime.services.knowledge as LocalKnowledgeService
    const retainedBase = (await knowledge.list(owner)).find(base => base.readOnly !== true)
    if (!retainedBase) throw new Error('Retained knowledge base is unavailable before consent revocation')
    const consent = await knowledge.revokeConsent(owner, 'openrouter')
    return {
      provider: 'openrouter',
      consent,
      ...await runStrictKnowledgeAsk(retainedBase.id, 'Ask after Provider snippet consent revoke'),
    }
  }
  if (name === 'expireKnowledgeEntitlement') {
    const session = await runtime.services.auth.getSession()
    if (!session) throw new Error('Knowledge release smoke session is unavailable')
    const owner = { userId: session.user.id }
    const knowledge = runtime.services.knowledge as LocalKnowledgeService
    const retainedBase = (await knowledge.list(owner))
      .find(base => base.name === '发布门禁资料')
    if (!retainedBase) throw new Error('Retained knowledge base is unavailable')
    const retainedDocument = (await knowledge.listDocuments(owner, retainedBase.id))[0]
    if (!retainedDocument) throw new Error('Retained knowledge document is unavailable')

    const extraBase = await knowledge.create(owner, '到期后只读资料')
    const extraHandle = (await knowledge.pickImportFiles(owner))[0]
    if (!extraHandle) throw new Error('Extra knowledge import handle is unavailable')
    const extraDocument = await knowledge.importDocument(owner, extraBase.id, extraHandle.id)
    if (!extraDocument) throw new Error('Extra knowledge document was not queued')
    let extraReady = false
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const current = (await knowledge.listDocuments(owner, extraBase.id))[0]
      if (current?.status === 'ready') {
        extraReady = true
        break
      }
      if (current?.status === 'failed') throw new Error('Extra knowledge document failed to parse')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    if (!extraReady) throw new Error('Extra knowledge document did not become ready')

    e2eKnowledgeNow = Date.parse('2026-09-01T00:00:00.001Z')
    await knowledge.getEntitlement(owner)
    const entitlement = await knowledge.retainFreeAllowance(owner, {
      baseId: retainedBase.id,
      documentId: retainedDocument.id,
    })
    const retainedSearch = await knowledge.searchSelected(
      owner, 'AutoForge knowledge smoke', [retainedBase.id],
    )
    const extraSearch = await knowledge.searchSelected(
      owner, 'AutoForge knowledge smoke', [extraBase.id],
    )
    const blockedHandle = (await knowledge.pickImportFiles(owner))[0]
    if (!blockedHandle) throw new Error('Blocked import handle is unavailable')
    let extraImport: { blocked: boolean; code?: string } = { blocked: false }
    try {
      await knowledge.importDocument(owner, extraBase.id, blockedHandle.id)
    } catch (error) {
      extraImport = {
        blocked: true,
        code: typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code: unknown }).code)
          : 'UNKNOWN',
      }
    }
    const projected = await knowledge.list(owner)
    const availability = await knowledge.getAvailability(owner)
    return {
      entitlement,
      retainedSearch: {
        kind: retainedSearch.kind,
        evidenceCount: retainedSearch.kind === 'results' ? retainedSearch.evidence.length : 0,
      },
      extraSearch: {
        kind: extraSearch.kind,
        evidenceCount: extraSearch.kind === 'results' ? extraSearch.evidence.length : 0,
      },
      extraImport,
      cloud: { available: availability.cloud.available, calls: knowledgeCloudCallCount },
      extrasReadOnly: projected.find(base => base.id === extraBase.id)?.readOnly === true,
    }
  }
  if (name === 'switchKnowledgeProvider') {
    const settings = await runtime.services.settings.update({ activeProvider: 'deepseek' })
    const session = await runtime.services.auth.getSession()
    if (!session) throw new Error('Knowledge release smoke session is unavailable')
    const bases = await runtime.services.knowledge.list({ userId: session.user.id })
    const retainedBase = bases.find(base => base.readOnly !== true)
    if (!retainedBase) throw new Error('Retained knowledge base is unavailable after Provider switch')
    return {
      provider: settings.activeProvider,
      ...await runStrictKnowledgeAsk(retainedBase.id, 'Ask after Provider switch'),
    }
  }
  if (name === 'deepseekKnowledgeConsent') {
    const session = await runtime.services.auth.getSession()
    if (!session) throw new Error('Knowledge release smoke session is unavailable')
    return {
      ...await runtime.services.knowledge.getConsent({ userId: session.user.id }, 'deepseek'),
      providerSnippetDisclosures: knowledgeSnippetDisclosureCount,
    }
  }
  throw new Error(`Unknown cloud user-data E2E command: ${name}`)
}

async function initialize(): Promise<void> {
  await mkdir(userData, { recursive: true })
  if (process.env.AUTOFORGE_E2E_SEED_LEGACY === '1') seedLegacyData()
  const authService = testAuthService(fixtureUser(requiredEnvironment('AUTOFORGE_E2E_USER')))
  const safeStoragePort = {
    isAvailable: async () => true,
    encrypt: async (value: string) => Buffer.from(value, 'utf8'),
    decrypt: async (value: Buffer) => ({ value: value.toString('utf8'), shouldReEncrypt: false }),
  }
  const knowledgeStoreFactory = new KnowledgeStoreFactory(join(userData, 'knowledge'), safeStoragePort)
  const knowledgeService = createLocalKnowledgeService({
    openStore: ownerId => knowledgeStoreFactory.open(ownerId),
    selectImportFiles: async () => [{
      name: 'e2e-guide.txt',
      mimeType: 'text/plain',
      bytes: Buffer.from('AutoForge knowledge smoke'),
    }],
    createParser: async () => ({
      parse: async () => ({
        mediaType: 'text/plain',
        text: 'AutoForge knowledge smoke',
        blocks: [{
          id: 'e2e-block-1',
          text: 'AutoForge knowledge smoke',
          coordinate: { kind: 'txt', lineStart: 1, lineEnd: 1, charStart: 0, charEnd: 25 },
        }],
      }),
      terminateAll: async () => undefined,
    }),
    saveExport: async () => undefined,
    isMember: () => knowledgeReleaseSmoke,
    ...(knowledgeReleaseSmoke ? {
      entitlement: () => e2eKnowledgeEntitlement,
      now: () => e2eKnowledgeNow,
      cloudKillSwitchEnabled: () => true,
    } : {}),
    emit: event => {
      const parsed = knowledgeEventSchema.safeParse(event)
      if (parsed.success) emit(ipcChannels.knowledgeEvent, parsed.data)
    },
  })
  knowledgeService.configureCloudRemote!(countedCloudRemote())
  userDataStores = new UserDataStoreManager(join(userData, 'user-caches'))
  const cloudPort = new CloudBaseUserDataPort({
    async callFunction(input) {
      const user = authService.currentUser()
      if (!user) throw toSafeAppError({ code: 'AUTH_REQUIRED' })
      const response = await globalThis.fetch(`${fixtureOrigin}/call`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-autoforge-fixture-user': user,
        },
        body: JSON.stringify(input.data),
      })
      if (!response.ok) throw { status: response.status }
      const result = await response.json()
      return { result }
    },
  })
  runtime = createApplicationRuntime({
    paths: {
      database: databasePath,
      data: userData,
      logs: join(userData, 'logs'),
      projects: join(userData, 'workflow-projects'),
      installations: join(userData, 'installed-workflows'),
      workflowRunner: join(desktopRoot, 'out/workers/workflow-runner.cjs'),
      temporary: join(userData, 'temporary'),
    },
    safeStorage: safeStoragePort,
    authService,
    userDataStores,
    userDataSyncPort: cloudPort,
    networkProxy,
    browserWorkspace: createBrowserWorkspace(),
    knowledgeService,
    modelProviders: { openrouter: deterministicProvider, deepseek: deterministicDeepseekProvider },
    chooseProjectDirectory: async () => undefined,
    chooseMediaFiles: async () => [],
    chooseAvatarFile: async () => undefined,
    readClipboardImage: () => undefined,
    chooseMediaSavePath: async () => undefined,
    revealPath: () => undefined,
    openExternal: async () => undefined,
    emitChat: (event) => {
      const parsed = chatEventSchema.safeParse(event)
      if (parsed.success) {
        recordedChatEvents.push(parsed.data)
        emit(ipcChannels.chatEvent, parsed.data)
      }
    },
    emitExecution: (event) => {
      const parsed = executionEventSchema.safeParse(event)
      if (parsed.success) emit(ipcChannels.executionsEvent, parsed.data)
    },
    applyTheme: (theme) => { nativeTheme.themeSource = theme },
    appInfo: { version: '0.1.0-e2e', platform: process.platform === 'win32' ? 'win32' : 'darwin' },
  })
  await runtime.services.settings.saveProviderApiKey('openrouter', 'e2e-openrouter-key')
  await runtime.services.settings.saveProviderApiKey('deepseek', 'e2e-deepseek-key')
  await runtime.services.settings.update({
    activeProvider: 'openrouter',
    defaultModels: {
      openrouter: { text: 'e2e-knowledge-model' },
      deepseek: { text: 'deepseek-chat' },
    },
  })
  await runtime.recover()
  await protocol.handle('autoforge-media', createMediaProtocolHandler(runtime.mediaAssets))

  const rendererTarget = {
    kind: 'production' as const,
    filePath: join(desktopRoot, 'out/renderer/index.html'),
  }
  const created = await createSecureWindow({
    BrowserWindow,
    session: session.defaultSession,
    preloadPath: join(desktopRoot, 'out/preload/index.cjs'),
    rendererTarget,
    backgroundColor: '#f3f5f8',
    getMainWindow: () => mainWindow,
    beforeLoad: (window) => {
      mainWindow = window as BrowserWindow
      disposeIpc = registerDesktopIpc({
        ipcMain,
        services: runtime!.services,
        getMainWindow: () => mainWindow,
        rendererTarget,
      })
    },
  })
  mainWindow = created as BrowserWindow
  mainWindow.on('closed', () => { mainWindow = null })
  ;(globalThis as typeof globalThis & {
    __AUTOFORGE_CLOUD_USER_DATA_E2E__?: { dispatch: typeof dispatch }
  }).__AUTOFORGE_CLOUD_USER_DATA_E2E__ = { dispatch }
}

let shuttingDown = false
async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  disposeIpc?.()
  disposeIpc = undefined
  const current = runtime
  runtime = undefined
  userDataStores = undefined
  if (current) await current.close()
}

void app.whenReady().then(initialize).catch((error) => {
  console.error(error)
  app.exit(1)
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', (event: Event) => {
  if (shuttingDown) return
  event.preventDefault()
  void shutdown().finally(() => app.quit())
})
