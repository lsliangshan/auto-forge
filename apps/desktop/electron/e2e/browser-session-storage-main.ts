import { randomUUID, X509Certificate } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  app,
  BaseWindow,
  nativeTheme,
  session,
  WebContentsView,
  type Certificate,
} from 'electron'
import {
  EncryptedBrowserSessionStorageStore,
  type BrowserSessionStorageStore,
} from '../main/browser/browser-session-storage-store.js'
import { ElectronBrowserWorkspace } from '../main/browser/electron-browser-workspace.js'
import { openAppDatabase } from '../main/database/client.js'
import { SecretStore } from '../main/security/secret-store.js'

const certificateFingerprint = '0E:B3:8E:EE:8E:72:4A:4C:DF:82:A0:7E:70:A1:75:8E:3E:14:53:C8:DB:92:45:C2:C2:20:89:D4:47:EB:1E:AD'
const userId = 'e2e_browser_user'

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing E2E environment variable: ${name}`)
  return value
}

const userData = requiredEnvironment('AUTOFORGE_E2E_USER_DATA')
const fixtureOrigin = new URL(requiredEnvironment('AUTOFORGE_E2E_FIXTURE_ORIGIN')).origin
const disallowedOrigin = new URL(requiredEnvironment('AUTOFORGE_E2E_DISALLOWED_ORIGIN')).origin
const fixtureProxy = requiredEnvironment('AUTOFORGE_E2E_FIXTURE_PROXY')

app.setPath('userData', userData)

function certificateSha256(certificate: Certificate): string | undefined {
  const candidate = certificate as Certificate & { fingerprint256?: string }
  if (candidate.fingerprint256) return candidate.fingerprint256
  try { return new X509Certificate(candidate.data).fingerprint256 } catch { return undefined }
}

app.on('certificate-error', (event, _webContents, url, _error, certificate, callback) => {
  let origin: string
  try { origin = new URL(url).origin } catch { return callback(false) }
  const trustedOrigin = origin === fixtureOrigin || origin === disallowedOrigin
  if (!trustedOrigin || certificateSha256(certificate)?.toUpperCase() !== certificateFingerprint) {
    return callback(false)
  }
  event.preventDefault()
  callback(true)
})

const workspace = new ElectronBrowserWorkspace({
  BaseWindow: BaseWindow as never,
  WebContentsView: WebContentsView as never,
  fromPartition: (partition) => session.fromPartition(partition),
  proxySnapshot: async () => ({
    enabled: true,
    proxyRules: `http=${fixtureProxy};https=${fixtureProxy}`,
    bypassRules: '<local>',
  }),
  backgroundColor: () => nativeTheme.shouldUseDarkColors ? '#11151c' : '#f3f5f8',
})

type TargetState = {
  closed: boolean
  view: WebContentsView
}

function targets(): Map<string, TargetState> {
  return (workspace as unknown as { tabs: Map<string, TargetState> }).tabs
}

let database: ReturnType<typeof openAppDatabase> | undefined
let sessionStorageStore: EncryptedBrowserSessionStorageStore | undefined
let currentTabId: string | undefined
let ready = false
const bootstrapReads: Array<{ origins: string[]; hasLogin: boolean }> = []

function currentTarget(): TargetState {
  const target = currentTabId ? targets().get(currentTabId) : undefined
  if (!target || target.closed || target.view.webContents.isDestroyed()) {
    throw new Error('Session-storage fixture target is unavailable')
  }
  return target
}

async function pageState(): Promise<string> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      const state = await currentTarget().view.webContents.executeJavaScript(
        "document.querySelector('#session-state')?.textContent ?? ''",
        true,
      ) as string
      if (state === 'logged-in' || state === 'logged-out') return state
    } catch { /* The renderer can be between documents during reload. */ }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Session-storage fixture page did not settle')
}

async function openFixture(): Promise<string> {
  const executionId = `session_storage_${randomUUID()}`
  const tab = await workspace.acquire({ executionId, userId, workflowId: 'e2e.session-storage' })
  await tab.open(`${fixtureOrigin}/session-storage`, [fixtureOrigin])
  await workspace.releaseExecution(executionId)
  currentTabId = tab.id
  return pageState()
}

async function dispatch(name: string): Promise<unknown> {
  if (name === 'ready') return ready
  if (!ready) throw new Error('Session-storage E2E harness is not ready')
  if (name === 'flushPersistence') {
    await sessionStorageStore?.drain()
    return true
  }
  if (name === 'open') return openFixture()
  if (name === 'persistenceState') {
    const records = await sessionStorageStore?.get(userId, [fixtureOrigin])
    return {
      keys: Object.keys(records?.[fixtureOrigin] ?? {}).sort(),
      hasLogin: records?.[fixtureOrigin]?.fixture_login === 'authenticated',
    }
  }
  if (name === 'pageSessionState') {
    return currentTarget().view.webContents.executeJavaScript(`({
      keys: Object.keys(sessionStorage).sort(),
      hasLogin: sessionStorage.getItem('fixture_login') === 'authenticated',
    })`, true)
  }
  if (name === 'bootstrapReads') return structuredClone(bootstrapReads)
  if (name === 'login') {
    await currentTarget().view.webContents.executeJavaScript(
      "document.querySelector('#session-login')?.click()",
      true,
    )
    return pageState()
  }
  if (name === 'clearBrowserData') {
    await workspace.clearUserData(userId)
    currentTabId = undefined
    return
  }
  throw new Error(`Unknown browser session-storage E2E command: ${name}`)
}

async function initialize(): Promise<void> {
  await mkdir(userData, { recursive: true })
  database = openAppDatabase(join(userData, 'autoforge.sqlite'))
  const secrets = new SecretStore(database.encryptedSecrets, {
    isAvailable: async () => true,
    encrypt: async (value) => Buffer.from(value, 'utf8').reverse(),
    decrypt: async (value) => ({
      value: Buffer.from(value).reverse().toString('utf8'),
      shouldReEncrypt: false,
    }),
  })
  sessionStorageStore = new EncryptedBrowserSessionStorageStore(secrets)
  const observedStore: BrowserSessionStorageStore = {
    get: async (requestedUserId, allowedOrigins) => {
      const records = await sessionStorageStore!.get(requestedUserId, allowedOrigins)
      bootstrapReads.push({
        origins: [...allowedOrigins],
        hasLogin: records[fixtureOrigin]?.fixture_login === 'authenticated',
      })
      return records
    },
    apply: (requestedUserId, mutation) => sessionStorageStore!.apply(requestedUserId, mutation),
    clear: (requestedUserId) => sessionStorageStore!.clear(requestedUserId),
    drain: () => sessionStorageStore!.drain(),
  }
  workspace.setSessionStorageStore(observedStore)
  ;(globalThis as typeof globalThis & {
    __AUTOFORGE_BROWSER_CONTINUATION_E2E__?: {
      dispatch(name: string, input: Record<string, unknown>): Promise<unknown>
    }
  }).__AUTOFORGE_BROWSER_CONTINUATION_E2E__ = {
    dispatch: (name) => dispatch(name),
  }
  ready = true
}

void app.whenReady().then(initialize).catch((error) => {
  console.error(error)
  app.exit(1)
})

app.on('will-quit', () => {
  database?.close()
  database = undefined
})
