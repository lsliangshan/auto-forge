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
  toSafeAppError,
  type AuthSession,
} from '@autoforge/shared'
import { createApplicationRuntime } from '../main/application.js'
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
    onPageInvalidated() { return () => undefined },
  }
}

let providerRequestCount = 0

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
  if (name === 'providerRequestCount') return providerRequestCount
  throw new Error(`Unknown cloud user-data E2E command: ${name}`)
}

async function initialize(): Promise<void> {
  await mkdir(userData, { recursive: true })
  if (process.env.AUTOFORGE_E2E_SEED_LEGACY === '1') seedLegacyData()
  const authService = testAuthService(fixtureUser(requiredEnvironment('AUTOFORGE_E2E_USER')))
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
    safeStorage: {
      isAvailable: async () => true,
      encrypt: async (value) => Buffer.from(value, 'utf8'),
      decrypt: async (value) => ({ value: value.toString('utf8'), shouldReEncrypt: false }),
    },
    authService,
    userDataStores,
    userDataSyncPort: cloudPort,
    networkProxy,
    browserWorkspace: createBrowserWorkspace(),
    chooseProjectDirectory: async () => undefined,
    chooseMediaFiles: async () => [],
    chooseAvatarFile: async () => undefined,
    readClipboardImage: () => undefined,
    chooseMediaSavePath: async () => undefined,
    revealPath: () => undefined,
    openExternal: async () => undefined,
    emitChat: (event) => {
      const parsed = chatEventSchema.safeParse(event)
      if (parsed.success) emit(ipcChannels.chatEvent, parsed.data)
    },
    emitExecution: (event) => {
      const parsed = executionEventSchema.safeParse(event)
      if (parsed.success) emit(ipcChannels.executionsEvent, parsed.data)
    },
    applyTheme: (theme) => { nativeTheme.themeSource = theme },
    appInfo: { version: '0.1.0-e2e', platform: process.platform === 'win32' ? 'win32' : 'darwin' },
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
