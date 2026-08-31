import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import ElementPlus, { ElMessageBox } from 'element-plus'
import {
  toSafeAppError,
  type AuthSession,
  type DesktopAPI,
  type PrivacyConsentState,
} from '@autoforge/shared'
import App from '../../src/App.vue'
import AppRail from '../../src/components/AppRail.vue'
import { createAuthGuard, routes, safeRedirect } from '../../src/router'
import { useAuthStore } from '../../src/stores/auth'
import { useChatStore } from '../../src/stores/chat'
import { useDeveloperStore } from '../../src/stores/developer'
import { useExecutionStore } from '../../src/stores/execution'
import { useSettingsStore } from '../../src/stores/settings'

const authSession: AuthSession = {
  user: { id: 'user_1', account: 'Alice' },
  authenticatedAt: '2026-08-07T00:00:00.000Z',
}

const adminSession: AuthSession = {
  ...authSession,
  authorization: {
    role: 'super_admin', capabilities: ['manage_users'], version: 1,
    updatedAt: '2026-08-21T00:00:00.000Z', confirmed: true,
  },
}

const bobSession: AuthSession = {
  user: { id: 'user_2', account: 'Bob' },
  authenticatedAt: '2026-08-07T00:02:00.000Z',
}

const acceptedCloudConsent: PrivacyConsentState = {
  purpose: 'cloud_sync', documentVersion: 'cloud-sync-2026-08',
  consentedAt: '2026-08-28T00:00:00.000Z', clientVersion: '0.1.0',
  state: 'accepted', revision: 1,
}

const revokedCloudConsent: PrivacyConsentState = {
  purpose: 'cloud_sync', revokedAt: '2026-08-28T01:00:00.000Z',
  clientVersion: '0.1.0', state: 'revoked', revision: 2,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function bindSettingsOwner(
  settings: ReturnType<typeof useSettingsStore>,
  ownerId: string | undefined,
) {
  const attempt = settings.suspendAccountOperationAdmission()
  expect(settings.bindAccountOwner(ownerId, attempt)).toBe('applied')
}

function createApi(): DesktopAPI {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue(null),
      refreshAuthorization: vi.fn().mockResolvedValue(authSession),
      login: vi.fn().mockResolvedValue(authSession),
      register: vi.fn().mockResolvedValue(authSession),
      sendOtp: vi.fn(),
      verifyOtp: vi.fn(),
      cancelOtp: vi.fn().mockResolvedValue(undefined),
      loginWithPassword: vi.fn().mockResolvedValue(authSession),
      logout: vi.fn().mockResolvedValue({ status: 'logged_out' }),
    },
    userAdmin: {
      list: vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 }),
      updateRole: vi.fn(),
    },
    profile: {
      get: vi.fn().mockResolvedValue({ userId: 'user_1', account: 'Alice' }),
      update: vi.fn(),
      pickAndUploadAvatar: vi.fn().mockResolvedValue(null),
    },
    chat: {
      listConversations: vi.fn().mockResolvedValue([]),
      createConversation: vi.fn(),
      listMessages: vi.fn().mockResolvedValue([]),
      renameConversation: vi.fn(),
      deleteConversation: vi.fn(),
      send: vi.fn(),
      cancel: vi.fn(),
      onEvent: vi.fn(() => vi.fn()),
    },
    media: {},
    workflows: { list: vi.fn().mockResolvedValue([]) },
    developer: {},
    executions: { list: vi.fn().mockResolvedValue([]), onEvent: vi.fn(() => vi.fn()) },
    permissions: { listGrants: vi.fn().mockResolvedValue([]) },
    settings: {
      get: vi.fn().mockResolvedValue({
        theme: 'system', language: 'zh-CN', dataDirectory: '/data', logDirectory: '/logs',
        activeProvider: 'deepseek', defaultModels: {
          openrouter: { text: 'openai/gpt-4.1-mini' }, deepseek: { text: 'deepseek-v4-flash' },
        }, showCosts: false, developerMode: false, permissionDefault: 'ask',
        proxy: { enabled: false, bypassDomains: [] },
      }),
      validateProviderCredential: vi.fn().mockResolvedValue({
        provider: 'deepseek', configured: false, validation: 'unchecked',
      }),
      getRemoteUsage: vi.fn().mockResolvedValue(undefined),
      getAccountDataPreferences: vi.fn().mockResolvedValue(undefined),
      previewLegacyImport: vi.fn().mockResolvedValue(undefined),
      getCloudSyncConsentState: vi.fn().mockResolvedValue(null),
      revokeCloudSyncConsent: vi.fn().mockResolvedValue(revokedCloudConsent),
    },
    system: { getAppInfo: vi.fn().mockResolvedValue({ version: '0.1.0', platform: 'darwin' }) },
  } as unknown as DesktopAPI
}

async function mountAuthApp(path: string, api = createApi(), session: AuthSession | null = null) {
  vi.mocked(api.auth.getSession).mockResolvedValue(session)
  Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createRouter({ history: createMemoryHistory(), routes })
  router.beforeEach(createAuthGuard(useAuthStore(pinia), vi.fn()))
  await router.push(path)
  await router.isReady()
  const wrapper = mount(App, { global: { plugins: [pinia, router, ElementPlus] } })
  return { api, pinia, router, wrapper }
}

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => {
  vi.useRealTimers()
  Reflect.deleteProperty(window, 'autoForge')
})

describe('authentication store', () => {
  it('allows only the latest account transition attempt to reopen admission', () => {
    const settings = useSettingsStore()
    const initialAttempt = settings.suspendAccountOperationAdmission()
    expect(settings.bindAccountOwner(authSession.user.id, initialAttempt)).toBe('applied')

    const firstAttempt = settings.suspendAccountOperationAdmission()
    const secondAttempt = settings.suspendAccountOperationAdmission()

    expect(settings.bindAccountOwner(bobSession.user.id, firstAttempt)).toBe('stale')
    expect(settings.isAccountGenerationCurrent(settings.captureAccountGeneration())).toBe(false)
    expect(settings.bindAccountOwner(bobSession.user.id, secondAttempt)).toBe('applied')
    expect(settings.isAccountGenerationCurrent(settings.captureAccountGeneration())).toBe(true)
  })

  it('keeps admission suspended until rejected login recovery fails closed', async () => {
    const api = createApi()
    const rejectedLogin = deferred<AuthSession>()
    const rejectedConsentLoad = deferred<PrivacyConsentState | null>()
    vi.mocked(api.auth.loginWithPassword).mockReturnValue(rejectedLogin.promise)
    vi.mocked(api.auth.getSession).mockResolvedValue(authSession)
    vi.mocked(api.settings.getCloudSyncConsentState).mockReturnValue(rejectedConsentLoad.promise)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const auth = useAuthStore()
    const settings = useSettingsStore()
    const initialAttempt = settings.suspendAccountOperationAdmission()
    expect(settings.bindAccountOwner(authSession.user.id, initialAttempt)).toBe('applied')
    auth.session = authSession
    settings.cloudSyncConsentState = acceptedCloudConsent
    const aliceGeneration = settings.captureAccountGeneration()

    const loggingIn = auth.loginWithPassword({ account: 'Bob', password: 'password' })
    expect(settings.isAccountGenerationCurrent(settings.captureAccountGeneration())).toBe(false)
    rejectedLogin.reject(toSafeAppError({ code: 'AUTH_INVALID_CREDENTIALS' }))
    await vi.waitFor(() => expect(api.settings.getCloudSyncConsentState).toHaveBeenCalledOnce())
    expect(settings.isAccountGenerationCurrent(settings.captureAccountGeneration())).toBe(false)

    rejectedConsentLoad.reject(toSafeAppError({ code: 'SERVICE_UNAVAILABLE' }))
    await expect(loggingIn).resolves.toBeUndefined()

    expect(settings.cloudSyncConsentState).toBeUndefined()
    expect(settings.isAccountGenerationCurrent(aliceGeneration)).toBe(false)
    expect(settings.isAccountGenerationCurrent(settings.captureAccountGeneration())).toBe(true)
  })

  it.each(['restore', 'password', 'otp', 'logout'] as const)(
    'invalidates account work before the first %s identity IPC settles',
    async (flow) => {
      const api = createApi()
      Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
      const auth = useAuthStore()
      const settings = useSettingsStore()
      auth.session = authSession
      bindSettingsOwner(settings, authSession.user.id)
      const aliceGeneration = settings.captureAccountGeneration()
      let operation: Promise<unknown>
      let settle: () => void

      if (flow === 'restore') {
        const request = deferred<AuthSession | null>()
        vi.mocked(api.auth.getSession).mockReturnValue(request.promise)
        operation = auth.restore()
        settle = () => request.resolve(authSession)
      } else if (flow === 'password') {
        const request = deferred<AuthSession>()
        vi.mocked(api.auth.loginWithPassword).mockReturnValue(request.promise)
        operation = auth.loginWithPassword({ account: 'Bob', password: 'password' })
        settle = () => request.resolve(bobSession)
      } else if (flow === 'otp') {
        const request = deferred<AuthSession>()
        vi.mocked(api.auth.verifyOtp).mockReturnValue(request.promise)
        auth.challenge = { challengeId: 'challenge_bob', expiresIn: 300 }
        operation = auth.verifyOtp('123456')
        settle = () => request.resolve(bobSession)
      } else {
        const request = deferred<Awaited<ReturnType<DesktopAPI['auth']['logout']>>>()
        vi.mocked(api.auth.logout).mockReturnValue(request.promise)
        operation = auth.logout()
        settle = () => request.resolve({ status: 'logged_out' })
      }

      expect(settings.isAccountGenerationCurrent(aliceGeneration)).toBe(false)
      settle()
      await operation
    },
  )

  it('keeps an old token stale and reloads Alice authoritative consent after login rejects', async () => {
    const api = createApi()
    const rejectedLogin = deferred<AuthSession>()
    vi.mocked(api.auth.loginWithPassword).mockReturnValue(rejectedLogin.promise)
    vi.mocked(api.auth.getSession).mockResolvedValue(authSession)
    vi.mocked(api.settings.getCloudSyncConsentState).mockResolvedValue(revokedCloudConsent)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const auth = useAuthStore()
    const settings = useSettingsStore()
    auth.session = authSession
    bindSettingsOwner(settings, authSession.user.id)
    settings.cloudSyncConsentState = acceptedCloudConsent
    const aliceGeneration = settings.captureAccountGeneration()

    const loggingIn = auth.loginWithPassword({ account: 'Bob', password: 'password' })
    expect(settings.isAccountGenerationCurrent(aliceGeneration)).toBe(false)
    rejectedLogin.reject(toSafeAppError({ code: 'AUTH_INVALID_CREDENTIALS' }))
    await expect(loggingIn).resolves.toBeUndefined()

    expect(settings.isAccountGenerationCurrent(aliceGeneration)).toBe(false)
    expect(settings.cloudSyncConsentState).toEqual(revokedCloudConsent)
    expect(api.settings.getCloudSyncConsentState).toHaveBeenCalledOnce()
  })

  it('reconciles a rejected login to the authoritative Main owner before reopening admission', async () => {
    const api = createApi()
    vi.mocked(api.auth.loginWithPassword)
      .mockRejectedValue(toSafeAppError({ code: 'AUTH_INVALID_CREDENTIALS' }))
    vi.mocked(api.auth.getSession).mockResolvedValue(bobSession)
    vi.mocked(api.settings.getCloudSyncConsentState).mockResolvedValue(revokedCloudConsent)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const auth = useAuthStore()
    const settings = useSettingsStore()
    auth.session = authSession
    bindSettingsOwner(settings, authSession.user.id)
    settings.cloudSyncConsentState = acceptedCloudConsent
    const aliceGeneration = settings.captureAccountGeneration()

    await expect(auth.loginWithPassword({ account: 'Bob', password: 'password' }))
      .resolves.toBeUndefined()

    expect(api.auth.getSession).toHaveBeenCalledOnce()
    expect(api.auth.getSession.mock.invocationCallOrder[0]).toBeLessThan(
      api.settings.getCloudSyncConsentState.mock.invocationCallOrder[0]!,
    )
    expect(auth.session).toEqual(bobSession)
    expect(settings.cloudSyncConsentState).toEqual(revokedCloudConsent)
    expect(settings.isAccountGenerationCurrent(aliceGeneration)).toBe(false)
    expect(settings.isAccountGenerationCurrent(settings.captureAccountGeneration())).toBe(true)
  })

  it('closes the old Renderer owner when rejected login reconciles to no Main session', async () => {
    const api = createApi()
    vi.mocked(api.auth.loginWithPassword)
      .mockRejectedValue(toSafeAppError({ code: 'AUTH_INVALID_CREDENTIALS' }))
    vi.mocked(api.auth.getSession).mockResolvedValue(null)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const auth = useAuthStore()
    const settings = useSettingsStore()
    auth.session = authSession
    bindSettingsOwner(settings, authSession.user.id)
    settings.cloudSyncConsentState = acceptedCloudConsent

    await expect(auth.loginWithPassword({ account: 'Bob', password: 'password' }))
      .resolves.toBeUndefined()

    expect(api.auth.getSession).toHaveBeenCalledOnce()
    expect(api.settings.getCloudSyncConsentState).not.toHaveBeenCalled()
    expect(auth.session).toBeNull()
    expect(settings.cloudSyncConsentState).toBeUndefined()
    expect(settings.isAccountGenerationCurrent(settings.captureAccountGeneration())).toBe(false)
  })

  it('fails closed when rejected login cannot reconcile the authoritative Main session', async () => {
    const api = createApi()
    vi.mocked(api.auth.loginWithPassword)
      .mockRejectedValue(toSafeAppError({ code: 'AUTH_INVALID_CREDENTIALS' }))
    vi.mocked(api.auth.getSession).mockRejectedValue(toSafeAppError({ code: 'SERVICE_UNAVAILABLE' }))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const auth = useAuthStore()
    const settings = useSettingsStore()
    auth.session = authSession
    bindSettingsOwner(settings, authSession.user.id)
    settings.cloudSyncConsentState = acceptedCloudConsent

    await expect(auth.loginWithPassword({ account: 'Bob', password: 'password' }))
      .resolves.toBeUndefined()

    expect(api.auth.getSession).toHaveBeenCalledOnce()
    expect(auth.session).toBeNull()
    expect(settings.cloudSyncConsentState).toBeUndefined()
    expect(settings.isAccountGenerationCurrent(settings.captureAccountGeneration())).toBe(false)
  })

  it('does not retain or repopulate Alice cloud consent after switching to Bob', async () => {
    const api = createApi()
    const aliceLoad = deferred<PrivacyConsentState | null>()
    vi.mocked(api.auth.loginWithPassword)
      .mockResolvedValueOnce(authSession)
      .mockResolvedValueOnce(bobSession)
    vi.mocked(api.settings.getCloudSyncConsentState).mockReturnValueOnce(aliceLoad.promise)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const auth = useAuthStore()
    const settings = useSettingsStore()

    await auth.loginWithPassword({ account: 'Alice', password: 'password' })
    const loadingAlice = settings.loadCloudData()
    settings.saving = true
    await auth.loginWithPassword({ account: 'Bob', password: 'password' })

    expect(settings.cloudSyncConsentState).toBeUndefined()
    expect(settings.saving).toBe(false)
    await settings.revokeCloudSyncConsent()
    expect(api.settings.revokeCloudSyncConsent).not.toHaveBeenCalled()

    aliceLoad.resolve(acceptedCloudConsent)
    await loadingAlice
    expect(settings.cloudSyncConsentState).toBeUndefined()
  })

  it('keeps an authoritative revoke when an earlier consent load resolves later', async () => {
    const api = createApi()
    const staleLoad = deferred<PrivacyConsentState | null>()
    vi.mocked(api.auth.loginWithPassword).mockResolvedValue(authSession)
    vi.mocked(api.settings.getCloudSyncConsentState).mockReturnValueOnce(staleLoad.promise)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const auth = useAuthStore()
    const settings = useSettingsStore()

    await auth.loginWithPassword({ account: 'Alice', password: 'password' })
    settings.cloudSyncConsentState = acceptedCloudConsent
    const loading = settings.loadCloudData()
    await settings.revokeCloudSyncConsent()
    expect(settings.cloudSyncConsentState).toEqual(revokedCloudConsent)

    staleLoad.resolve(acceptedCloudConsent)
    await loading
    expect(settings.cloudSyncConsentState).toEqual(revokedCloudConsent)
  })

  it('keeps a pending revoke authoritative when a consent load starts and resolves afterward', async () => {
    const api = createApi()
    const pendingRevoke = deferred<PrivacyConsentState>()
    const staleLoad = deferred<PrivacyConsentState | null>()
    vi.mocked(api.auth.loginWithPassword).mockResolvedValue(authSession)
    vi.mocked(api.settings.revokeCloudSyncConsent).mockReturnValueOnce(pendingRevoke.promise)
    vi.mocked(api.settings.getCloudSyncConsentState).mockReturnValueOnce(staleLoad.promise)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const auth = useAuthStore()
    const settings = useSettingsStore()

    await auth.loginWithPassword({ account: 'Alice', password: 'password' })
    settings.cloudSyncConsentState = acceptedCloudConsent
    const revoking = settings.revokeCloudSyncConsent()
    expect(settings.saving).toBe(true)

    const loading = settings.loadCloudData()
    staleLoad.resolve(acceptedCloudConsent)
    await loading
    expect(settings.saving).toBe(true)

    pendingRevoke.resolve(revokedCloudConsent)
    await revoking
    expect(settings.cloudSyncConsentState).toEqual(revokedCloudConsent)
    expect(settings.saving).toBe(false)
  })

  it.each(['restore', 'password', 'otp'] as const)(
    'resets old-user chat before a direct UID replacement through %s',
    async (flow) => {
      const api = createApi()
      vi.mocked(api.auth.getSession).mockResolvedValue(bobSession)
      vi.mocked(api.auth.loginWithPassword).mockResolvedValue(bobSession)
      vi.mocked(api.auth.verifyOtp).mockResolvedValue(bobSession)
      Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
      const auth = useAuthStore()
      const chat = useChatStore()
      auth.session = authSession
      chat.conversations = [{
        id: 'alice_conversation', title: 'Alice', titleState: 'user_named', revision: 1,
        syncState: 'synced', createdAt: '2026-08-07T00:00:00.000Z',
        lastActivityAt: '2026-08-07T00:00:00.000Z',
        metadataUpdatedAt: '2026-08-07T00:00:00.000Z',
      }]
      chat.selectedConversationId = 'alice_conversation'
      const reset = vi.spyOn(chat, 'resetLocalData')
      reset.mockImplementationOnce(() => {
        expect(auth.session?.user.id).toBe(authSession.user.id)
        chat.$patch({ conversations: [], selectedConversationId: '' })
      })

      if (flow === 'restore') {
        await auth.restore()
      } else if (flow === 'password') {
        await auth.loginWithPassword({ account: 'Bob', password: 'password' })
      } else {
        auth.challenge = { challengeId: 'challenge_bob', expiresIn: 300 }
        await auth.verifyOtp('123456')
      }

      expect(reset).toHaveBeenCalledOnce()
      expect(auth.session).toEqual(bobSession)
      expect(chat.conversations).toEqual([])
      expect(chat.selectedConversationId).toBe('')
    },
  )

  it('clears execution state when the authenticated UID changes', async () => {
    const api = createApi()
    vi.mocked(api.auth.loginWithPassword).mockResolvedValue(bobSession)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const auth = useAuthStore()
    const execution = useExecutionStore()
    auth.session = authSession
    execution.items = [{
      id: 'alice_execution', workflowId: 'workflow.alice', workflowVersion: '1.0.0',
      status: 'completed', createdAt: '2026-08-25T00:00:00.000Z',
    }]
    execution.selectedId = 'alice_execution'
    execution.details.alice_execution = {
      ...execution.items[0]!, input: {}, steps: [], logs: [],
    }

    await auth.loginWithPassword({ account: 'Bob', password: 'password' })

    expect(execution.items).toEqual([])
    expect(execution.selectedId).toBe('')
    expect(execution.details).toEqual({})
  })

  it('invalidates the developer execution snapshot after logout succeeds', async () => {
    const api = createApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const auth = useAuthStore()
    const developer = useDeveloperStore()
    auth.session = authSession
    developer.debugExecutionId = 'exec_conversion'
    developer.debugExecutionConversionCapable = true
    developer.debugStatus = 'running'

    await expect(auth.logout()).resolves.toBe(true)

    expect(developer.debugExecutionId).toBe('')
    expect(developer.debugExecutionConversionCapable).toBe(false)
    expect(developer.debugStatus).toBe('idle')
  })

  it('deduplicates concurrent session restoration', async () => {
    const api = createApi()
    let resolveSession!: (value: AuthSession) => void
    vi.mocked(api.auth.getSession).mockReturnValue(new Promise((resolve) => { resolveSession = resolve }))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const auth = useAuthStore()

    const first = auth.restore()
    const second = auth.restore()
    expect(api.auth.getSession).toHaveBeenCalledOnce()
    resolveSession(authSession)
    await Promise.all([first, second])

    expect(auth.session).toEqual(authSession)
    expect(auth.initialized).toBe(true)
    expect(auth.restoring).toBe(false)
  })

  it('marks the Store initialized when the current session restoration fails', async () => {
    const api = createApi()
    vi.mocked(api.auth.getSession).mockRejectedValue(new Error('provider details'))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const auth = useAuthStore()

    await auth.restore()

    expect(auth.session).toBeNull()
    expect(auth.initialized).toBe(true)
    expect(auth.restoring).toBe(false)
    expect(auth.error).toBe('登录状态恢复失败')
  })

  it('stores only the current OTP challenge and authenticates after verification', async () => {
    const api = createApi()
    vi.mocked(api.auth.sendOtp).mockResolvedValue({
      challengeId: 'challenge_1',
      expiresIn: 300,
    })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const auth = useAuthStore()

    await expect(auth.sendOtp({
      intent: 'login', channel: 'phone', target: '18311032722',
    })).resolves.toEqual({ challengeId: 'challenge_1', expiresIn: 300 })
    expect(auth.challenge).toEqual({ challengeId: 'challenge_1', expiresIn: 300 })
    expect(auth.session).toBeNull()

    vi.mocked(api.auth.verifyOtp).mockResolvedValue(authSession)
    await expect(auth.verifyOtp('123456')).resolves.toEqual(authSession)
    expect(auth.challenge).toBeNull()
    expect(auth.session).toEqual(authSession)
  })

  it('clears a challenge locally before cancelling it in Main', async () => {
    const api = createApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const auth = useAuthStore()
    auth.challenge = { challengeId: 'challenge_1', expiresIn: 300 }

    const cancelling = auth.cancelOtp()
    expect(auth.challenge).toBeNull()
    await cancelling
    expect(api.auth.cancelOtp).toHaveBeenCalledWith('challenge_1')
  })

  it('cancels a prior challenge before sending a new OTP and suppresses duplicate sends', async () => {
    const api = createApi()
    let resolveOtp!: (value: { challengeId: string, expiresIn: number }) => void
    vi.mocked(api.auth.sendOtp).mockReturnValue(new Promise((resolve) => { resolveOtp = resolve }))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const auth = useAuthStore()
    auth.challenge = { challengeId: 'challenge_1', expiresIn: 300 }

    const sending = auth.sendOtp({ intent: 'login', channel: 'phone', target: '18311032722' })
    const duplicate = auth.sendOtp({ intent: 'login', channel: 'phone', target: '18311032722' })
    expect(auth.challenge).toBeNull()
    await vi.waitFor(() => expect(api.auth.cancelOtp).toHaveBeenCalledWith('challenge_1'))
    expect(api.auth.sendOtp).toHaveBeenCalledOnce()
    await expect(duplicate).resolves.toBeUndefined()

    resolveOtp({ challengeId: 'challenge_2', expiresIn: 300 })
    await expect(sending).resolves.toEqual({ challengeId: 'challenge_2', expiresIn: 300 })
    expect(auth.challenge).toEqual({ challengeId: 'challenge_2', expiresIn: 300 })
  })

  it('cancels a challenge returned after an explicit cancellation during OTP sending', async () => {
    const api = createApi()
    const pendingOtp = deferred<{ challengeId: string, expiresIn: number }>()
    vi.mocked(api.auth.sendOtp).mockReturnValue(pendingOtp.promise)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const auth = useAuthStore()

    const sending = auth.sendOtp({ intent: 'login', channel: 'phone', target: '18311032722' })
    expect(api.auth.sendOtp).toHaveBeenCalledOnce()
    await auth.cancelOtp()
    expect(auth.challenge).toBeNull()

    pendingOtp.resolve({ challengeId: 'challenge_1', expiresIn: 300 })
    await expect(sending).resolves.toBeUndefined()

    expect(auth.challenge).toBeNull()
    expect(api.auth.cancelOtp).toHaveBeenCalledWith('challenge_1')
  })

  it('does not let a stale OTP send error overwrite a newer local error', async () => {
    const api = createApi()
    const pendingOtp = deferred<{ challengeId: string, expiresIn: number }>()
    vi.mocked(api.auth.sendOtp).mockReturnValue(pendingOtp.promise)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const auth = useAuthStore()

    const sending = auth.sendOtp({ intent: 'login', channel: 'phone', target: '18311032722' })
    await auth.cancelOtp()
    await auth.verifyOtp('123456')
    expect(auth.error).toBe('请先发送验证码')

    pendingOtp.reject(toSafeAppError({ code: 'INTERNAL_ERROR' }))
    await expect(sending).resolves.toBeUndefined()

    expect(auth.error).toBe('请先发送验证码')
  })

  it('clears an OTP challenge when verification fails', async () => {
    const api = createApi()
    vi.mocked(api.auth.verifyOtp).mockRejectedValue(toSafeAppError({ code: 'AUTH_INVALID_OTP' }))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const auth = useAuthStore()
    auth.challenge = { challengeId: 'challenge_1', expiresIn: 300 }

    await expect(auth.verifyOtp('123456')).resolves.toBeUndefined()
    expect(api.auth.verifyOtp).toHaveBeenCalledWith({ challengeId: 'challenge_1', code: '123456' })
    expect(auth.challenge).toBeNull()
    expect(auth.session).toBeNull()
    expect(auth.error).toBe('验证码错误，请重新发送后再试')
  })

  it('does not let a cancelled verification overwrite a newer challenge and reconciles Main', async () => {
    const api = createApi()
    const pendingVerification = deferred<AuthSession>()
    vi.mocked(api.auth.verifyOtp).mockReturnValue(pendingVerification.promise)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const auth = useAuthStore()
    auth.challenge = { challengeId: 'challenge_1', expiresIn: 300 }

    const verifying = auth.verifyOtp('123456')
    await auth.cancelOtp()
    auth.challenge = { challengeId: 'challenge_2', expiresIn: 300 }

    pendingVerification.resolve(authSession)
    await expect(verifying).resolves.toBeUndefined()

    expect(auth.challenge).toEqual({ challengeId: 'challenge_2', expiresIn: 300 })
    expect(auth.session).toBeNull()
    expect(api.auth.logout).toHaveBeenCalledOnce()
  })

  it('suppresses sends, password login, and duplicate verification while verifying an OTP', async () => {
    const api = createApi()
    const pendingVerification = deferred<AuthSession>()
    vi.mocked(api.auth.verifyOtp).mockReturnValue(pendingVerification.promise)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const auth = useAuthStore()
    auth.challenge = { challengeId: 'challenge_1', expiresIn: 300 }

    const verifying = auth.verifyOtp('123456')

    await expect(auth.sendOtp({ intent: 'login', channel: 'phone', target: '18311032722' })).resolves.toBeUndefined()
    await expect(auth.loginWithPassword({ account: 'Alice', password: 'password' })).resolves.toBeUndefined()
    await expect(auth.verifyOtp('654321')).resolves.toBeUndefined()
    expect(api.auth.sendOtp).not.toHaveBeenCalled()
    expect(api.auth.loginWithPassword).not.toHaveBeenCalled()
    expect(api.auth.verifyOtp).toHaveBeenCalledOnce()

    await auth.cancelOtp()
    pendingVerification.resolve(authSession)
    await verifying
  })

  it('stores a password login session', async () => {
    const api = createApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const auth = useAuthStore()

    await expect(auth.loginWithPassword({ account: 'Alice', password: 'password' })).resolves.toEqual(authSession)
    expect(auth.session).toEqual(authSession)
    expect(auth.submitting).toBe(false)
  })

  it('keeps the Store logged out when a password login resolves after logout', async () => {
    const api = createApi()
    const pendingLogin = deferred<AuthSession>()
    vi.mocked(api.auth.loginWithPassword).mockReturnValue(pendingLogin.promise)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const auth = useAuthStore()

    const loggingIn = auth.loginWithPassword({ account: 'Alice', password: 'password' })
    const loggingOut = auth.logout()
    await expect(loggingOut).resolves.toBe(true)
    expect(auth.submitting).toBe(true)

    pendingLogin.resolve(authSession)
    await expect(loggingIn).resolves.toBeUndefined()

    expect(auth.session).toBeNull()
    expect(auth.initialized).toBe(true)
    expect(auth.submitting).toBe(false)
  })

  it('does not let a stale restore overwrite a newer password login', async () => {
    const api = createApi()
    const pendingSession = deferred<AuthSession | null>()
    const restoredSession: AuthSession = {
      user: { id: 'user_restored', account: 'Restored' },
      authenticatedAt: '2026-08-07T00:01:00.000Z',
    }
    vi.mocked(api.auth.getSession).mockReturnValue(pendingSession.promise)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const auth = useAuthStore()

    const restoring = auth.restore()
    await expect(auth.loginWithPassword({ account: 'Alice', password: 'password' })).resolves.toEqual(authSession)
    pendingSession.resolve(restoredSession)
    await restoring

    expect(auth.session).toEqual(authSession)
    expect(auth.initialized).toBe(true)
    expect(auth.restoring).toBe(false)
    expect(auth.submitting).toBe(false)
  })

  it('does not let a stale OTP cancellation error overwrite a later password login', async () => {
    const api = createApi()
    const pendingCancellation = deferred<void>()
    vi.mocked(api.auth.cancelOtp).mockReturnValue(pendingCancellation.promise)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const auth = useAuthStore()
    auth.challenge = { challengeId: 'challenge_1', expiresIn: 300 }

    const cancelling = auth.cancelOtp()
    await expect(auth.loginWithPassword({ account: 'Alice', password: 'password' })).resolves.toEqual(authSession)
    pendingCancellation.reject(new Error('provider cancellation details'))
    await cancelling

    expect(auth.session).toEqual(authSession)
    expect(auth.error).toBe('')
  })

  it('retains the verified public session when stale-verification cleanup logout fails', async () => {
    const api = createApi()
    const pendingVerification = deferred<AuthSession>()
    vi.mocked(api.auth.verifyOtp).mockReturnValue(pendingVerification.promise)
    vi.mocked(api.auth.logout).mockRejectedValue(new Error('provider logout details'))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const auth = useAuthStore()
    auth.challenge = { challengeId: 'challenge_1', expiresIn: 300 }

    const verifying = auth.verifyOtp('123456')
    await auth.cancelOtp()
    pendingVerification.resolve(authSession)
    await expect(verifying).resolves.toBeUndefined()

    expect(auth.session).toEqual(authSession)
    expect(auth.initialized).toBe(true)
    expect(auth.error).toBe('退出登录失败')
    expect(auth.error).not.toContain('provider logout details')
    expect(auth.submitting).toBe(false)
  })

  it('does not let verification cleanup overwrite a restore started during compensation', async () => {
    const api = createApi()
    const pendingVerification = deferred<AuthSession>()
    const compensationStarted = deferred<void>()
    const pendingLogout = deferred<Awaited<ReturnType<DesktopAPI['auth']['logout']>>>()
    vi.mocked(api.auth.verifyOtp).mockReturnValue(pendingVerification.promise)
    vi.mocked(api.auth.logout).mockImplementation(() => {
      compensationStarted.resolve()
      return pendingLogout.promise
    })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const auth = useAuthStore()
    auth.challenge = { challengeId: 'challenge_1', expiresIn: 300 }

    const verifying = auth.verifyOtp('123456')
    await auth.cancelOtp()
    pendingVerification.resolve(authSession)
    await compensationStarted.promise
    expect(api.auth.logout).toHaveBeenCalledWith({ preservePending: true })

    const restoring = auth.restore()
    await restoring
    pendingLogout.resolve({ status: 'logged_out' })
    await verifying

    expect(auth.session).toBeNull()
    expect(auth.initialized).toBe(true)
    expect(auth.restoring).toBe(false)
    expect(auth.submitting).toBe(false)
  })

  it('makes successful verification cleanup logout terminal after a restore reads the verified session', async () => {
    const api = createApi()
    const pendingVerification = deferred<AuthSession>()
    const compensationStarted = deferred<void>()
    const pendingLogout = deferred<Awaited<ReturnType<DesktopAPI['auth']['logout']>>>()
    const pendingRestore = deferred<AuthSession | null>()
    vi.mocked(api.auth.verifyOtp).mockReturnValue(pendingVerification.promise)
    vi.mocked(api.auth.logout).mockImplementation(() => {
      compensationStarted.resolve()
      return pendingLogout.promise
    })
    vi.mocked(api.auth.getSession).mockReturnValue(pendingRestore.promise)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const auth = useAuthStore()
    auth.challenge = { challengeId: 'challenge_1', expiresIn: 300 }

    const verifying = auth.verifyOtp('123456')
    await auth.cancelOtp()
    pendingVerification.resolve(authSession)
    await compensationStarted.promise
    expect(api.auth.logout).toHaveBeenCalledWith({ preservePending: true })

    const restoring = auth.restore()
    pendingRestore.resolve(authSession)
    await restoring
    expect(auth.session).toEqual(authSession)

    pendingLogout.resolve({ status: 'logged_out' })
    await verifying

    expect(auth.session).toBeNull()
    expect(auth.initialized).toBe(true)
    expect(auth.restoring).toBe(false)
    expect(auth.submitting).toBe(false)
  })

  it('keeps the current session when logout fails', async () => {
    const api = createApi()
    vi.mocked(api.auth.logout).mockRejectedValue(toSafeAppError({ code: 'INTERNAL_ERROR' }))
    vi.mocked(api.auth.getSession).mockResolvedValue(authSession)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const auth = useAuthStore()
    auth.session = authSession
    bindSettingsOwner(useSettingsStore(), authSession.user.id)

    await expect(auth.logout()).resolves.toBe(false)

    expect(auth.session).toEqual(authSession)
    expect(auth.error).toBe('操作失败，请稍后重试')
  })

  it('keeps the session until pending changes are explicitly discarded', async () => {
    const api = createApi()
    vi.mocked(api.auth.logout)
      .mockResolvedValueOnce({ status: 'pending_sync', pendingCount: 3 })
      .mockResolvedValueOnce({ status: 'logged_out' })
    vi.mocked(api.auth.getSession).mockResolvedValue(authSession)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const auth = useAuthStore()
    auth.session = authSession
    bindSettingsOwner(useSettingsStore(), authSession.user.id)

    await expect(auth.logout()).resolves.toBe(false)
    expect(auth.session).toEqual(authSession)
    expect(auth.pendingLogoutCount).toBe(3)
    expect(api.auth.logout).toHaveBeenLastCalledWith(undefined)

    await expect(auth.logout(true)).resolves.toBe(true)
    expect(api.auth.logout).toHaveBeenLastCalledWith({ discardPending: true })
    expect(auth.session).toBeNull()
    expect(auth.pendingLogoutCount).toBe(0)
  })

  it('keeps the session and reports an actionable sync-timeout logout result', async () => {
    const api = createApi()
    vi.mocked(api.auth.logout).mockResolvedValue({ status: 'sync_timeout' })
    vi.mocked(api.auth.getSession).mockResolvedValue(authSession)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const auth = useAuthStore()
    auth.session = authSession
    bindSettingsOwner(useSettingsStore(), authSession.user.id)

    await expect(auth.logout()).resolves.toBe(false)

    expect(auth.session).toEqual(authSession)
    expect(auth.error).toBe('同步仍在进行，请稍后重试退出登录')
  })

  it('clears the previous user chat state after logout succeeds', async () => {
    const api = createApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const auth = useAuthStore()
    const chat = useChatStore()
    auth.session = authSession
    chat.conversations = [{
      id: 'conversation_alice',
      title: 'Alice conversation',
      createdAt: '2026-08-21T00:00:00.000Z',
      updatedAt: '2026-08-21T00:00:00.000Z',
    }]
    chat.selectedConversationId = 'conversation_alice'
    chat.messagesByConversation.conversation_alice = []

    await expect(auth.logout()).resolves.toBe(true)

    expect(chat.conversations).toEqual([])
    expect(chat.selectedConversationId).toBe('')
    expect(chat.messagesByConversation).toEqual({})
  })

  it('clears the session after a pending logout succeeds despite a later OTP cancellation', async () => {
    const api = createApi()
    const logoutStarted = deferred<void>()
    const pendingLogout = deferred<Awaited<ReturnType<DesktopAPI['auth']['logout']>>>()
    vi.mocked(api.auth.logout).mockImplementation(() => {
      logoutStarted.resolve()
      return pendingLogout.promise
    })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const auth = useAuthStore()
    auth.session = authSession

    const loggingOut = auth.logout()
    await logoutStarted.promise
    await auth.cancelOtp()
    pendingLogout.resolve({ status: 'logged_out' })
    await expect(loggingOut).resolves.toBe(true)

    expect(auth.session).toBeNull()
    expect(auth.initialized).toBe(true)
    expect(auth.error).toBe('')
    expect(auth.submitting).toBe(false)
  })

  it('makes logout terminal when a restore starts before remote logout succeeds', async () => {
    const api = createApi()
    const logoutStarted = deferred<void>()
    const pendingLogout = deferred<Awaited<ReturnType<DesktopAPI['auth']['logout']>>>()
    const pendingRestore = deferred<AuthSession | null>()
    vi.mocked(api.auth.logout).mockImplementation(() => {
      logoutStarted.resolve()
      return pendingLogout.promise
    })
    vi.mocked(api.auth.getSession).mockReturnValue(pendingRestore.promise)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const auth = useAuthStore()
    auth.session = authSession

    const loggingOut = auth.logout()
    await logoutStarted.promise
    const restoring = auth.restore()
    expect(auth.restoring).toBe(true)

    pendingLogout.resolve({ status: 'logged_out' })
    await expect(loggingOut).resolves.toBe(true)
    expect(auth.session).toBeNull()
    expect(auth.initialized).toBe(true)
    expect(auth.submitting).toBe(false)

    pendingRestore.resolve(authSession)
    await restoring
    expect(auth.session).toBeNull()
    expect(auth.restoring).toBe(false)
  })

  it('still logs out remotely after challenge cancellation fails', async () => {
    const api = createApi()
    vi.mocked(api.auth.cancelOtp).mockRejectedValue(toSafeAppError({ code: 'INTERNAL_ERROR' }))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const auth = useAuthStore()
    auth.session = authSession
    auth.challenge = { challengeId: 'challenge_1', expiresIn: 300 }

    await expect(auth.logout()).resolves.toBe(true)

    expect(api.auth.cancelOtp).toHaveBeenCalledWith('challenge_1')
    expect(api.auth.logout).toHaveBeenCalledOnce()
    expect(auth.challenge).toBeNull()
    expect(auth.session).toBeNull()
  })

  it('clears the session only after logout succeeds', async () => {
    const api = createApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const auth = useAuthStore()
    auth.session = authSession

    await expect(auth.logout()).resolves.toBe(true)

    expect(auth.session).toBeNull()
    expect(auth.error).toBe('')
  })
})

describe('authentication navigation', () => {
  it('redirects direct user-management access unless manage_users is confirmed', async () => {
    const ordinary = await mountAuthApp('/users', createApi(), authSession)
    expect(ordinary.router.currentRoute.value.fullPath).toBe('/chat')
    ordinary.wrapper.unmount()

    const admin = await mountAuthApp('/users', createApi(), adminSession)
    expect(admin.router.currentRoute.value.fullPath).toBe('/users')
    admin.wrapper.unmount()
  })
  it('accepts only internal redirect targets', () => {
    expect(safeRedirect('/settings?tab=general')).toBe('/settings?tab=general')
    expect(safeRedirect('//attacker.invalid')).toBe('/chat')
    expect(safeRedirect('https://attacker.invalid')).toBe('/chat')
    expect(safeRedirect(['settings'])).toBe('/chat')
  })

  it('redirects anonymous business routes and authenticated guest routes', async () => {
    const anonymous = await mountAuthApp('/settings')
    expect(anonymous.router.currentRoute.value.fullPath).toBe('/login?redirect=/settings')
    anonymous.wrapper.unmount()

    const authenticated = await mountAuthApp('/login', createApi(), authSession)
    expect(authenticated.router.currentRoute.value.fullPath).toBe('/chat')
    authenticated.wrapper.unmount()
  })
})

describe('authentication pages', () => {
  it('renders the approved logo in the authentication brand', async () => {
    const { wrapper } = await mountAuthApp('/login')

    const logo = wrapper.get('[data-testid="auth-brand-logo"]')
    expect(logo.element.tagName).toBe('IMG')
    expect(logo.attributes('alt')).toBe('')
    expect(logo.attributes('src')).toContain('autoforge-logo.png')
  })

  it('prioritizes phone OTP, then email OTP, then username password login', async () => {
    const { wrapper } = await mountAuthApp('/login')

    const methods = wrapper.findAll('[data-testid^="login-method-"]')
    expect(methods.map((item) => item.text())).toEqual(['手机号', '邮箱', '用户名密码'])
    expect(wrapper.get('[data-testid="login-method-phone"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('[data-testid="login-phone"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="login-email"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="login-account"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('使用 AutoForge 云端账号继续。')
    expect(wrapper.get('.auth-switch').text().replace(/\s+/g, '')).toBe('还没有云端账号？去注册')
  })

  it('moves the login method background through all three selections', async () => {
    const { wrapper } = await mountAuthApp('/login')
    const indicator = wrapper.get('[data-testid="login-active-indicator"]').element as HTMLElement

    expect(indicator.style.transform).toBe('translateX(0px)')
    await wrapper.get('[data-testid="login-method-email"]').trigger('click')
    expect(indicator.style.transform).toBe('translateX(calc(100% + 4px))')
    await wrapper.get('[data-testid="login-method-password"]').trigger('click')
    expect(indicator.style.transform).toBe('translateX(calc(200% + 8px))')
  })

  it('validates phone and email destinations before sending an OTP', async () => {
    const { api, wrapper } = await mountAuthApp('/login')

    await wrapper.get('[data-testid="login-phone"]').setValue('123')
    await wrapper.get('[data-testid="login-send-code"]').trigger('click')
    expect(api.auth.sendOtp).not.toHaveBeenCalled()
    expect(wrapper.get('[role="alert"]').text()).toBe('请输入有效的手机号')

    await wrapper.get('[data-testid="login-method-email"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="login-email"]').setValue('not-an-email')
    await wrapper.get('[data-testid="login-send-code"]').trigger('click')
    expect(api.auth.sendOtp).not.toHaveBeenCalled()
    expect(wrapper.get('[role="alert"]').text()).toBe('请输入有效的邮箱地址')
  })

  it('sends phone OTP once and runs one 60-second countdown', async () => {
    vi.useFakeTimers()
    const api = createApi()
    vi.mocked(api.auth.sendOtp).mockResolvedValue({ challengeId: 'challenge_phone', expiresIn: 300 })
    const { wrapper } = await mountAuthApp('/login', api)

    await wrapper.get('[data-testid="login-phone"]').setValue(' 18311032722 ')
    void wrapper.get('[data-testid="login-send-code"]').trigger('click')
    void wrapper.get('[data-testid="login-send-code"]').trigger('click')
    await flushPromises()

    expect(api.auth.sendOtp).toHaveBeenCalledOnce()
    expect(api.auth.sendOtp).toHaveBeenCalledWith({
      intent: 'login', channel: 'phone', target: '18311032722',
    })
    expect(wrapper.get('[data-testid="login-send-code"]').text()).toBe('60 秒后重试')
    expect(wrapper.get('[data-testid="login-send-code"]').attributes()).toHaveProperty('disabled')
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(wrapper.get('[data-testid="login-send-code"]').text()).toBe('59 秒后重试')
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(59_000)
    expect(wrapper.get('[data-testid="login-send-code"]').text()).toBe('发送验证码')
    expect(wrapper.get('[data-testid="login-send-code"]').attributes()).not.toHaveProperty('disabled')
    expect(vi.getTimerCount()).toBe(0)
    wrapper.unmount()
  })

  it('sends a normalized email OTP for the email method', async () => {
    const api = createApi()
    vi.mocked(api.auth.sendOtp).mockResolvedValue({ challengeId: 'challenge_email', expiresIn: 300 })
    const { wrapper } = await mountAuthApp('/login', api)

    await wrapper.get('[data-testid="login-method-email"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="login-email"]').setValue(' Alice@Example.COM ')
    void wrapper.get('[data-testid="login-send-code"]').trigger('click')
    void wrapper.get('[data-testid="login-send-code"]').trigger('click')
    await vi.waitFor(() => expect(api.auth.sendOtp).toHaveBeenCalledWith({
      intent: 'login', channel: 'email', target: 'alice@example.com',
    }))
    await flushPromises()
    expect(api.auth.sendOtp).toHaveBeenCalledOnce()
    expect(wrapper.get('[data-testid="login-send-code"]').text()).toBe('60 秒后重试')
    wrapper.unmount()
  })

  it('verifies a six-digit OTP once and returns to the safe redirect', async () => {
    const api = createApi()
    const pendingVerification = deferred<AuthSession>()
    vi.mocked(api.auth.sendOtp).mockResolvedValue({ challengeId: 'challenge_1', expiresIn: 300 })
    vi.mocked(api.auth.verifyOtp).mockReturnValue(pendingVerification.promise)
    const { router, wrapper } = await mountAuthApp('/login?redirect=/settings', api)

    await wrapper.get('[data-testid="login-phone"]').setValue('18311032722')
    await wrapper.get('[data-testid="login-send-code"]').trigger('click')
    await vi.waitFor(() => expect(api.auth.sendOtp).toHaveBeenCalledOnce())

    await wrapper.get('[data-testid="login-code"]').setValue('123')
    await wrapper.get('[data-testid="login-form"]').trigger('submit')
    expect(api.auth.verifyOtp).not.toHaveBeenCalled()
    expect(wrapper.get('[role="alert"]').text()).toBe('请输入 6 位验证码')

    await wrapper.get('[data-testid="login-code"]').setValue('123456')
    void wrapper.get('[data-testid="login-form"]').trigger('submit')
    void wrapper.get('[data-testid="login-form"]').trigger('submit')
    await vi.waitFor(() => expect(api.auth.verifyOtp).toHaveBeenCalledOnce())
    expect(api.auth.verifyOtp).toHaveBeenCalledWith({ challengeId: 'challenge_1', code: '123456' })
    expect(wrapper.get('[data-testid="login-method-phone"]').attributes()).toHaveProperty('disabled')
    expect(wrapper.get('[data-testid="login-send-code"]').attributes()).toHaveProperty('disabled')

    pendingVerification.resolve(authSession)
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/settings'))
  })

  it('allows resending immediately after OTP verification fails', async () => {
    vi.useFakeTimers()
    const api = createApi()
    vi.mocked(api.auth.sendOtp).mockResolvedValue({ challengeId: 'challenge_1', expiresIn: 300 })
    vi.mocked(api.auth.verifyOtp).mockRejectedValue(toSafeAppError({ code: 'AUTH_INVALID_OTP' }))
    const { wrapper } = await mountAuthApp('/login', api)

    await wrapper.get('[data-testid="login-phone"]').setValue('18311032722')
    await wrapper.get('[data-testid="login-send-code"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="login-code"]').setValue('123456')
    await wrapper.get('[data-testid="login-form"]').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toBe('验证码错误，请重新发送后再试')
    expect(wrapper.get('[data-testid="login-send-code"]').text()).toBe('发送验证码')
    expect(wrapper.get('[data-testid="login-send-code"]').attributes()).not.toHaveProperty('disabled')
    wrapper.unmount()
  })

  it('verifies email OTP once and rejects an external redirect target', async () => {
    const api = createApi()
    const pendingVerification = deferred<AuthSession>()
    vi.mocked(api.auth.sendOtp).mockResolvedValue({ challengeId: 'challenge_email', expiresIn: 300 })
    vi.mocked(api.auth.verifyOtp).mockReturnValue(pendingVerification.promise)
    const { router, wrapper } = await mountAuthApp('/login?redirect=//attacker.invalid', api)

    await wrapper.get('[data-testid="login-method-email"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="login-email"]').setValue('alice@example.com')
    await wrapper.get('[data-testid="login-send-code"]').trigger('click')
    await vi.waitFor(() => expect(api.auth.sendOtp).toHaveBeenCalledOnce())
    await wrapper.get('[data-testid="login-code"]').setValue('654321')
    void wrapper.get('[data-testid="login-form"]').trigger('submit')
    void wrapper.get('[data-testid="login-form"]').trigger('submit')
    await vi.waitFor(() => expect(api.auth.verifyOtp).toHaveBeenCalledOnce())
    expect(api.auth.verifyOtp).toHaveBeenCalledWith({ challengeId: 'challenge_email', code: '654321' })

    pendingVerification.resolve(authSession)
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/chat'))
  })

  it('cancels and clears the OTP state when switching methods', async () => {
    vi.useFakeTimers()
    const api = createApi()
    vi.mocked(api.auth.sendOtp).mockResolvedValue({ challengeId: 'challenge_1', expiresIn: 300 })
    const { wrapper } = await mountAuthApp('/login', api)

    await wrapper.get('[data-testid="login-phone"]').setValue('18311032722')
    await wrapper.get('[data-testid="login-send-code"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="login-code"]').setValue('bad')
    await wrapper.get('[data-testid="login-form"]').trigger('submit')
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)

    await wrapper.get('[data-testid="login-method-email"]').trigger('click')
    await flushPromises()

    expect(api.auth.cancelOtp).toHaveBeenCalledWith('challenge_1')
    expect(wrapper.get('[data-testid="login-method-email"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('[data-testid="login-email"]').element).toHaveProperty('value', '')
    expect(wrapper.get('[data-testid="login-code"]').element).toHaveProperty('value', '')
    expect(wrapper.get('[data-testid="login-send-code"]').text()).toBe('发送验证码')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    wrapper.unmount()
  })

  it('cancels a current challenge when its destination changes', async () => {
    vi.useFakeTimers()
    const api = createApi()
    vi.mocked(api.auth.sendOtp).mockResolvedValue({ challengeId: 'challenge_1', expiresIn: 300 })
    const { wrapper } = await mountAuthApp('/login', api)

    await wrapper.get('[data-testid="login-phone"]').setValue('18311032722')
    await wrapper.get('[data-testid="login-send-code"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="login-code"]').setValue('123456')
    await wrapper.get('[data-testid="login-phone"]').setValue('18311032723')
    await flushPromises()

    expect(api.auth.cancelOtp).toHaveBeenCalledWith('challenge_1')
    expect(wrapper.get('[data-testid="login-code"]').element).toHaveProperty('value', '')
    expect(wrapper.get('[data-testid="login-send-code"]').text()).toBe('发送验证码')
    expect(vi.getTimerCount()).toBe(0)
    wrapper.unmount()
  })

  it('cancels an OTP that resolves after its destination becomes stale', async () => {
    vi.useFakeTimers()
    const api = createApi()
    const pendingOtp = deferred<{ challengeId: string, expiresIn: number }>()
    vi.mocked(api.auth.sendOtp).mockReturnValue(pendingOtp.promise)
    const { pinia, wrapper } = await mountAuthApp('/login', api)

    await wrapper.get('[data-testid="login-phone"]').setValue('18311032722')
    void wrapper.get('[data-testid="login-send-code"]').trigger('click')
    await vi.waitFor(() => expect(api.auth.sendOtp).toHaveBeenCalledOnce())
    await wrapper.get('[data-testid="login-phone"]').setValue('18311032723')
    pendingOtp.resolve({ challengeId: 'challenge_stale', expiresIn: 300 })
    await flushPromises()

    expect(api.auth.cancelOtp).toHaveBeenCalledWith('challenge_stale')
    expect(useAuthStore(pinia).challenge).toBeNull()
    expect(wrapper.get('[data-testid="login-send-code"]').text()).toBe('发送验证码')
    expect(vi.getTimerCount()).toBe(0)
    wrapper.unmount()
  })

  it('does not show a stale send error after its destination changes', async () => {
    const api = createApi()
    const pendingOtp = deferred<{ challengeId: string, expiresIn: number }>()
    vi.mocked(api.auth.sendOtp).mockReturnValue(pendingOtp.promise)
    const { pinia, wrapper } = await mountAuthApp('/login', api)

    await wrapper.get('[data-testid="login-phone"]').setValue('18311032722')
    void wrapper.get('[data-testid="login-send-code"]').trigger('click')
    await vi.waitFor(() => expect(api.auth.sendOtp).toHaveBeenCalledOnce())
    await wrapper.get('[data-testid="login-phone"]').setValue('18311032723')
    pendingOtp.reject(toSafeAppError({ code: 'INTERNAL_ERROR' }))
    await flushPromises()

    expect(useAuthStore(pinia).error).toBe('')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps the last method selected while an earlier cancellation is pending', async () => {
    const api = createApi()
    const pendingCancellation = deferred<void>()
    vi.mocked(api.auth.sendOtp).mockResolvedValue({ challengeId: 'challenge_1', expiresIn: 300 })
    vi.mocked(api.auth.cancelOtp)
      .mockReturnValueOnce(pendingCancellation.promise)
      .mockResolvedValue(undefined)
    const { wrapper } = await mountAuthApp('/login', api)

    await wrapper.get('[data-testid="login-phone"]').setValue('18311032722')
    await wrapper.get('[data-testid="login-send-code"]').trigger('click')
    await vi.waitFor(() => expect(api.auth.sendOtp).toHaveBeenCalledOnce())
    void wrapper.get('[data-testid="login-method-email"]').trigger('click')
    await vi.waitFor(() => expect(api.auth.cancelOtp).toHaveBeenCalledWith('challenge_1'))
    await wrapper.get('[data-testid="login-method-password"]').trigger('click')
    await flushPromises()

    pendingCancellation.resolve()
    await flushPromises()
    expect(wrapper.get('[data-testid="login-method-password"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('[data-testid="login-email"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="login-account"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('cleans up its countdown and challenge when unmounted', async () => {
    vi.useFakeTimers()
    const api = createApi()
    vi.mocked(api.auth.sendOtp).mockResolvedValue({ challengeId: 'challenge_1', expiresIn: 300 })
    const { wrapper } = await mountAuthApp('/login', api)

    await wrapper.get('[data-testid="login-phone"]').setValue('18311032722')
    await wrapper.get('[data-testid="login-send-code"]').trigger('click')
    await flushPromises()
    expect(vi.getTimerCount()).toBe(1)

    wrapper.unmount()
    await flushPromises()
    expect(vi.getTimerCount()).toBe(0)
    expect(api.auth.cancelOtp).toHaveBeenCalledWith('challenge_1')
  })

  it('logs in once with normalized account credentials and returns to a safe target', async () => {
    const api = createApi()
    const pendingLogin = deferred<AuthSession>()
    vi.mocked(api.auth.loginWithPassword).mockReturnValue(pendingLogin.promise)
    const { router, wrapper } = await mountAuthApp('/login?redirect=/settings', api)

    await wrapper.get('[data-testid="login-method-password"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('label[for="login-account"]').text()).toBe('账号')
    expect(wrapper.get('label[for="login-password"]').text()).toBe('密码')
    expect(wrapper.get('[data-testid="login-account"]').attributes('autocomplete')).toBe('username')
    expect(wrapper.get('[data-testid="login-password"]').attributes('autocomplete')).toBe('current-password')

    await wrapper.get('[data-testid="login-account"]').setValue(' Alice ')
    await wrapper.get('[data-testid="login-password"]').setValue('password')
    void wrapper.get('[data-testid="login-form"]').trigger('submit')
    void wrapper.get('[data-testid="login-form"]').trigger('submit')
    await vi.waitFor(() => expect(api.auth.loginWithPassword).toHaveBeenCalledOnce())
    expect(api.auth.loginWithPassword).toHaveBeenCalledWith({ account: 'Alice', password: 'password' })

    pendingLogin.resolve(authSession)
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/settings'))
  })

  it('validates password credentials and shows only the public credential error', async () => {
    const api = createApi()
    vi.mocked(api.auth.loginWithPassword).mockRejectedValue(
      toSafeAppError({ code: 'AUTH_INVALID_CREDENTIALS', message: 'provider details' }),
    )
    const { wrapper } = await mountAuthApp('/login', api)

    await wrapper.get('[data-testid="login-method-password"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="login-account"]').setValue('bad account')
    await wrapper.get('[data-testid="login-password"]').setValue('short')
    await wrapper.get('[data-testid="login-form"]').trigger('submit')
    expect(api.auth.loginWithPassword).not.toHaveBeenCalled()
    expect(wrapper.get('[role="alert"]').text()).toBe('账号需为 5–24 位字母、数字或下划线')

    await wrapper.get('[data-testid="login-account"]').setValue('Alice')
    await wrapper.get('[data-testid="login-password"]').setValue('password')
    await wrapper.get('[data-testid="login-form"]').trigger('submit')
    await vi.waitFor(() => expect(wrapper.get('[role="alert"]').text()).toBe('账号或密码错误'))
    expect(wrapper.get('[role="alert"]').text()).not.toContain('provider details')
  })

  it('prioritizes phone registration before email registration', async () => {
    const { wrapper } = await mountAuthApp('/register')

    const methods = wrapper.findAll('[data-testid^="register-method-"]')
    expect(methods.map((item) => item.text())).toEqual(['手机号', '邮箱'])
    expect(wrapper.get('[data-testid="register-method-phone"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('[data-testid="register-phone"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="register-email"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="register-phone"]').attributes('autocomplete')).toBe('tel')
    expect(wrapper.get('[data-testid="register-account"]').attributes('autocomplete')).toBe('username')
    expect(wrapper.get('[data-testid="register-password"]').attributes('autocomplete')).toBe('new-password')
    expect(wrapper.get('[data-testid="register-confirm"]').attributes('autocomplete')).toBe('new-password')
    expect(wrapper.get('[data-testid="register-code"]').attributes('autocomplete')).toBe('one-time-code')
    expect(wrapper.text()).toContain('通过手机号或邮箱验证，注册成功后将自动登录。')
    expect(wrapper.get('.auth-switch').text().replace(/\s+/g, '')).toBe('已有云端账号？返回登录')
  })

  it('moves the registration method background to the selected option', async () => {
    const { wrapper } = await mountAuthApp('/register')
    const indicator = wrapper.get('[data-testid="register-active-indicator"]').element as HTMLElement

    expect(indicator.style.transform).toBe('translateX(0px)')
    await wrapper.get('[data-testid="register-method-email"]').trigger('click')
    expect(indicator.style.transform).toBe('translateX(calc(100% + 4px))')
  })

  it('keeps the registration page scrollable at the minimum window height', async () => {
    const originalHeight = window.innerHeight
    window.innerHeight = 720

    const { wrapper } = await mountAuthApp('/register')
    try {
      const shellStyle = (wrapper.get('.auth-shell').element as HTMLElement).style
      expect(shellStyle.overflowY).toBe('auto')
      expect(shellStyle.placeItems).toBe('safe center')
    } finally {
      wrapper.unmount()
      window.innerHeight = originalHeight
    }
  })

  it('rejects mismatched or invalid registration fields before sending an OTP', async () => {
    const { api, wrapper } = await mountAuthApp('/register')

    await wrapper.get('[data-testid="register-phone"]').setValue('123')
    await wrapper.get('[data-testid="register-account"]').setValue('bad')
    await wrapper.get('[data-testid="register-password"]').setValue('short')
    await wrapper.get('[data-testid="register-confirm"]').setValue('different')
    await wrapper.get('[data-testid="register-send-code"]').trigger('click')
    expect(wrapper.get('[role="alert"]').text()).toBe('两次输入的密码不一致')

    await wrapper.get('[data-testid="register-confirm"]').setValue('short')
    await wrapper.get('[data-testid="register-send-code"]').trigger('click')
    expect(wrapper.get('[role="alert"]').text()).toBe('用户名需为 5–24 位字母、数字或下划线')

    await wrapper.get('[data-testid="register-account"]').setValue('Alice')
    await wrapper.get('[data-testid="register-send-code"]').trigger('click')
    expect(wrapper.get('[role="alert"]').text()).toBe('密码长度须为 8–72 个字符')

    await wrapper.get('[data-testid="register-password"]').setValue('password')
    await wrapper.get('[data-testid="register-confirm"]').setValue('password')
    await wrapper.get('[data-testid="register-send-code"]').trigger('click')
    expect(wrapper.get('[role="alert"]').text()).toBe('请输入有效的手机号')
    expect(api.auth.sendOtp).not.toHaveBeenCalled()
  })

  it('sends normalized phone registration credentials once without retaining secrets', async () => {
    vi.useFakeTimers()
    const api = createApi()
    vi.mocked(api.auth.sendOtp).mockResolvedValue({ challengeId: 'challenge_phone', expiresIn: 300 })
    const { pinia, wrapper } = await mountAuthApp('/register', api)
    const secret = '  password  '

    await wrapper.get('[data-testid="register-phone"]').setValue(' 18311032722 ')
    await wrapper.get('[data-testid="register-account"]').setValue(' Alice ')
    await wrapper.get('[data-testid="register-password"]').setValue(secret)
    await wrapper.get('[data-testid="register-confirm"]').setValue(secret)
    void wrapper.get('[data-testid="register-send-code"]').trigger('click')
    void wrapper.get('[data-testid="register-send-code"]').trigger('click')
    await flushPromises()

    expect(api.auth.sendOtp).toHaveBeenCalledOnce()
    expect(api.auth.sendOtp).toHaveBeenCalledWith({
      intent: 'register',
      channel: 'phone',
      target: '18311032722',
      account: 'Alice',
      password: secret,
    })
    expect(wrapper.text()).not.toContain(secret)
    expect(JSON.stringify(useAuthStore(pinia).$state)).not.toContain(secret)
    expect(wrapper.get('[data-testid="register-send-code"]').text()).toBe('60 秒后重试')
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(wrapper.get('[data-testid="register-send-code"]').text()).toBe('发送验证码')
    expect(vi.getTimerCount()).toBe(0)
    wrapper.unmount()
  })

  it('sends a lowercased email registration target', async () => {
    const api = createApi()
    vi.mocked(api.auth.sendOtp).mockResolvedValue({ challengeId: 'challenge_email', expiresIn: 300 })
    const { wrapper } = await mountAuthApp('/register', api)

    await wrapper.get('[data-testid="register-method-email"]').trigger('click')
    await wrapper.get('[data-testid="register-email"]').setValue(' Alice@Example.COM ')
    await wrapper.get('[data-testid="register-account"]').setValue(' Alice ')
    await wrapper.get('[data-testid="register-password"]').setValue('password')
    await wrapper.get('[data-testid="register-confirm"]').setValue('password')
    await wrapper.get('[data-testid="register-send-code"]').trigger('click')
    await vi.waitFor(() => expect(api.auth.sendOtp).toHaveBeenCalledWith({
      intent: 'register',
      channel: 'email',
      target: 'alice@example.com',
      account: 'Alice',
      password: 'password',
    }))
    wrapper.unmount()
  })

  it('verifies a six-digit registration OTP once and enters chat', async () => {
    const api = createApi()
    const pendingVerification = deferred<AuthSession>()
    vi.mocked(api.auth.sendOtp).mockResolvedValue({ challengeId: 'challenge_1', expiresIn: 300 })
    vi.mocked(api.auth.verifyOtp).mockReturnValue(pendingVerification.promise)
    const { router, wrapper } = await mountAuthApp('/register', api)

    await wrapper.get('[data-testid="register-phone"]').setValue('18311032722')
    await wrapper.get('[data-testid="register-account"]').setValue('Alice')
    await wrapper.get('[data-testid="register-password"]').setValue('password')
    await wrapper.get('[data-testid="register-confirm"]').setValue('password')
    await wrapper.get('[data-testid="register-send-code"]').trigger('click')
    await vi.waitFor(() => expect(api.auth.sendOtp).toHaveBeenCalledOnce())

    await wrapper.get('[data-testid="register-code"]').setValue('123')
    await wrapper.get('[data-testid="register-form"]').trigger('submit')
    expect(api.auth.verifyOtp).not.toHaveBeenCalled()
    expect(wrapper.get('[role="alert"]').text()).toBe('请输入 6 位验证码')

    await wrapper.get('[data-testid="register-code"]').setValue('123456')
    void wrapper.get('[data-testid="register-form"]').trigger('submit')
    void wrapper.get('[data-testid="register-form"]').trigger('submit')
    await vi.waitFor(() => expect(api.auth.verifyOtp).toHaveBeenCalledOnce())
    expect(api.auth.verifyOtp).toHaveBeenCalledWith({ challengeId: 'challenge_1', code: '123456' })

    pendingVerification.resolve(authSession)
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/chat'))
  })

  it.each([
    ['target', 'register-phone', '18311032723'],
    ['account', 'register-account', 'Alice_2'],
    ['password', 'register-password', 'password2'],
    ['confirmation', 'register-confirm', 'password2'],
  ])('cancels the registration challenge when the %s changes', async (_field, testId, nextValue) => {
    vi.useFakeTimers()
    const api = createApi()
    vi.mocked(api.auth.sendOtp).mockResolvedValue({ challengeId: 'challenge_1', expiresIn: 300 })
    const { wrapper } = await mountAuthApp('/register', api)

    await wrapper.get('[data-testid="register-phone"]').setValue('18311032722')
    await wrapper.get('[data-testid="register-account"]').setValue('Alice')
    await wrapper.get('[data-testid="register-password"]').setValue('password')
    await wrapper.get('[data-testid="register-confirm"]').setValue('password')
    await wrapper.get('[data-testid="register-send-code"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="register-code"]').setValue('123456')
    await wrapper.get(`[data-testid="${testId}"]`).setValue(nextValue)
    await flushPromises()

    expect(api.auth.cancelOtp).toHaveBeenCalledWith('challenge_1')
    expect(wrapper.get('[data-testid="register-code"]').element).toHaveProperty('value', '')
    expect(wrapper.get('[data-testid="register-send-code"]').text()).toBe('发送验证码')
    await wrapper.get('[data-testid="register-code"]').setValue('654321')
    await wrapper.get('[data-testid="register-form"]').trigger('submit')
    expect(api.auth.verifyOtp).not.toHaveBeenCalled()
    expect(wrapper.get('[role="alert"]').text()).toBe('请先发送验证码')
    expect(vi.getTimerCount()).toBe(0)
    wrapper.unmount()
  })

  it('switches registration methods by clearing challenge state but preserving credentials', async () => {
    vi.useFakeTimers()
    const api = createApi()
    vi.mocked(api.auth.sendOtp).mockResolvedValue({ challengeId: 'challenge_1', expiresIn: 300 })
    const { wrapper } = await mountAuthApp('/register', api)

    await wrapper.get('[data-testid="register-phone"]').setValue('18311032722')
    await wrapper.get('[data-testid="register-account"]').setValue('Alice')
    await wrapper.get('[data-testid="register-password"]').setValue('password')
    await wrapper.get('[data-testid="register-confirm"]').setValue('password')
    await wrapper.get('[data-testid="register-send-code"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="register-code"]').setValue('bad')
    await wrapper.get('[data-testid="register-form"]').trigger('submit')

    await wrapper.get('[data-testid="register-method-email"]').trigger('click')
    await flushPromises()

    expect(api.auth.cancelOtp).toHaveBeenCalledWith('challenge_1')
    expect(wrapper.get('[data-testid="register-method-email"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('[data-testid="register-email"]').element).toHaveProperty('value', '')
    expect(wrapper.get('[data-testid="register-account"]').element).toHaveProperty('value', 'Alice')
    expect(wrapper.get('[data-testid="register-password"]').element).toHaveProperty('value', 'password')
    expect(wrapper.get('[data-testid="register-confirm"]').element).toHaveProperty('value', 'password')
    expect(wrapper.get('[data-testid="register-code"]').element).toHaveProperty('value', '')
    expect(wrapper.get('[data-testid="register-send-code"]').text()).toBe('发送验证码')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    wrapper.unmount()
  })

  it('cancels a registration OTP that resolves after its credentials become stale', async () => {
    vi.useFakeTimers()
    const api = createApi()
    const pendingOtp = deferred<{ challengeId: string, expiresIn: number }>()
    vi.mocked(api.auth.sendOtp).mockReturnValue(pendingOtp.promise)
    const { pinia, wrapper } = await mountAuthApp('/register', api)

    await wrapper.get('[data-testid="register-phone"]').setValue('18311032722')
    await wrapper.get('[data-testid="register-account"]').setValue('Alice')
    await wrapper.get('[data-testid="register-password"]').setValue('password')
    await wrapper.get('[data-testid="register-confirm"]').setValue('password')
    void wrapper.get('[data-testid="register-send-code"]').trigger('click')
    await vi.waitFor(() => expect(api.auth.sendOtp).toHaveBeenCalledOnce())
    await wrapper.get('[data-testid="register-account"]').setValue('Alice_2')
    pendingOtp.resolve({ challengeId: 'challenge_stale', expiresIn: 300 })
    await flushPromises()

    expect(api.auth.cancelOtp).toHaveBeenCalledWith('challenge_stale')
    expect(useAuthStore(pinia).challenge).toBeNull()
    expect(wrapper.get('[data-testid="register-send-code"]').text()).toBe('发送验证码')
    expect(vi.getTimerCount()).toBe(0)
    wrapper.unmount()
  })

  it('cleans up the registration countdown and challenge when unmounted', async () => {
    vi.useFakeTimers()
    const api = createApi()
    vi.mocked(api.auth.sendOtp).mockResolvedValue({ challengeId: 'challenge_1', expiresIn: 300 })
    const { wrapper } = await mountAuthApp('/register', api)

    await wrapper.get('[data-testid="register-phone"]').setValue('18311032722')
    await wrapper.get('[data-testid="register-account"]').setValue('Alice')
    await wrapper.get('[data-testid="register-password"]').setValue('password')
    await wrapper.get('[data-testid="register-confirm"]').setValue('password')
    await wrapper.get('[data-testid="register-send-code"]').trigger('click')
    await flushPromises()
    expect(vi.getTimerCount()).toBe(1)

    wrapper.unmount()
    await flushPromises()
    expect(vi.getTimerCount()).toBe(0)
    expect(api.auth.cancelOtp).toHaveBeenCalledWith('challenge_1')
  })
})

describe('workbench authentication entry', () => {
  it('shows user management only for confirmed manage_users capability', async () => {
    const api = createApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const pinia = createPinia()
    setActivePinia(pinia)
    const auth = useAuthStore(pinia)
    auth.session = authSession
    auth.initialized = true
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/chat', component: { template: '<div />' } },
        { path: '/users', component: { template: '<div />' } },
      ],
    })
    await router.push('/chat')
    const wrapper = mount(AppRail, { global: { plugins: [pinia, router, ElementPlus] } })

    expect(wrapper.find('[aria-label="用户管理"]').exists()).toBe(false)
    auth.session = adminSession
    await flushPromises()
    expect(wrapper.find('[aria-label="用户管理"]').exists()).toBe(true)
    auth.session = {
      ...adminSession,
      authorization: { ...adminSession.authorization!, confirmed: false },
    }
    await flushPromises()
    expect(wrapper.find('[aria-label="用户管理"]').exists()).toBe(false)
    wrapper.unmount()
  })
  it('renders the approved logo in the application rail', async () => {
    const api = createApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const pinia = createPinia()
    setActivePinia(pinia)
    const auth = useAuthStore(pinia)
    auth.session = authSession
    auth.initialized = true
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/chat', component: { template: '<div />' } }],
    })
    await router.push('/chat')
    const wrapper = mount(AppRail, { global: { plugins: [pinia, router, ElementPlus] } })

    const logo = wrapper.get('[data-testid="app-brand-logo"]')
    expect(logo.element.tagName).toBe('IMG')
    expect(logo.attributes('alt')).toBe('')
    expect(logo.attributes('src')).toContain('autoforge-logo.png')
  })

  it('places the mixed-tone application logo on a light contrasting surface', async () => {
    const api = createApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const pinia = createPinia()
    setActivePinia(pinia)
    const auth = useAuthStore(pinia)
    auth.session = authSession
    auth.initialized = true
    const router = createRouter({
      history: createMemoryHistory(),
      routes: ['/chat', '/workflows', '/developer', '/executions', '/settings', '/profile'].map((path) => ({
        path,
        component: { template: '<div />' },
      })),
    })
    await router.push('/chat')
    const wrapper = mount(AppRail, {
      attachTo: document.body,
      global: { plugins: [pinia, router, ElementPlus] },
    })

    try {
      const surfaceColor = getComputedStyle(wrapper.get('.app-mark').element).backgroundColor
      const hexColor = /^#([\da-f]{6})$/i.exec(surfaceColor)
      const channels = hexColor
        ? hexColor[1].match(/../g)?.map((channel) => Number.parseInt(channel, 16)) ?? []
        : surfaceColor.match(/\d+/g)?.slice(0, 3).map(Number) ?? []
      expect(channels).toHaveLength(3)
      expect(Math.min(...channels)).toBeGreaterThanOrEqual(240)
    } finally {
      wrapper.unmount()
    }
  })

  it('separates account actions from primary navigation with hidden decoration', async () => {
    const api = createApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const pinia = createPinia()
    setActivePinia(pinia)
    const auth = useAuthStore(pinia)
    auth.session = authSession
    auth.initialized = true
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/chat', component: { template: '<div />' } }],
    })
    await router.push('/chat')
    const wrapper = mount(AppRail, { global: { plugins: [pinia, router, ElementPlus] } })

    const divider = wrapper.get('[data-testid="rail-account-divider"]')
    expect(divider.attributes('aria-hidden')).toBe('true')
    wrapper.unmount()
  })

  it('constrains every navigation icon with the shared icon wrapper', async () => {
    const api = createApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const pinia = createPinia()
    setActivePinia(pinia)
    const auth = useAuthStore(pinia)
    auth.session = authSession
    auth.initialized = true
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/chat', component: { template: '<div />' } }],
    })
    await router.push('/chat')
    const wrapper = mount(AppRail, { global: { plugins: [pinia, router, ElementPlus] } })

    const icons = wrapper.findAll('[data-testid="app-nav-item"] .rail-item-icon')
    expect(icons).toHaveLength(wrapper.findAll('[data-testid="app-nav-item"]').length)
    expect(icons.every((icon) => icon.element.tagName === 'I')).toBe(true)
    wrapper.unmount()
  })

  it('keeps the account visible on failed logout and navigates only after success', async () => {
    const api = createApi()
    vi.mocked(api.auth.logout).mockRejectedValueOnce(toSafeAppError({ code: 'INTERNAL_ERROR' }))
    vi.mocked(api.auth.getSession).mockResolvedValue(authSession)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const pinia = createPinia()
    setActivePinia(pinia)
    const auth = useAuthStore(pinia)
    auth.session = authSession
    auth.initialized = true
    bindSettingsOwner(useSettingsStore(pinia), authSession.user.id)
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/chat', component: { template: '<div />' } },
        { path: '/login', component: { template: '<div />' } },
      ],
    })
    await router.push('/chat')
    const wrapper = mount(AppRail, { global: { plugins: [pinia, router, ElementPlus] } })

    expect(wrapper.get('[data-testid="current-account"]').text()).toBe('Alice')
    await wrapper.get('[aria-label="退出登录"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('[role="alert"]').text()).toContain('操作失败，请稍后重试'))
    expect(router.currentRoute.value.fullPath).toBe('/chat')
    expect(auth.session).toEqual(authSession)

    await wrapper.get('[aria-label="退出登录"]').trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/login'))
    expect(auth.session).toBeNull()
  })

  it('requires visible confirmation before explicitly discarding pending sync on logout', async () => {
    const api = createApi()
    vi.mocked(api.auth.logout)
      .mockResolvedValueOnce({ status: 'pending_sync', pendingCount: 2 })
      .mockResolvedValueOnce({ status: 'logged_out' })
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm')
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const pinia = createPinia()
    setActivePinia(pinia)
    const auth = useAuthStore(pinia)
    auth.session = authSession
    auth.initialized = true
    bindSettingsOwner(useSettingsStore(pinia), authSession.user.id)
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/chat', component: { template: '<div />' } },
        { path: '/login', component: { template: '<div />' } },
      ],
    })
    await router.push('/chat')
    const wrapper = mount(AppRail, { global: { plugins: [pinia, router, ElementPlus] } })

    await wrapper.get('[aria-label="退出登录"]').trigger('click')
    await vi.waitFor(() => expect(api.auth.logout).toHaveBeenCalledTimes(2))
    expect(api.auth.logout).toHaveBeenNthCalledWith(1, undefined)
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining('2 条本地修改未同步'),
      '未同步修改',
      expect.any(Object),
    )
    expect(api.auth.logout).toHaveBeenNthCalledWith(2, { discardPending: true })
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/login'))
    expect(auth.session).toBeNull()
  })
})
