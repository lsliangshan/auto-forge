import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import ElementPlus from 'element-plus'
import { toSafeAppError, type AuthSession, type DesktopAPI } from '@autoforge/shared'
import App from '../../src/App.vue'
import AppRail from '../../src/components/AppRail.vue'
import { createAuthGuard, routes, safeRedirect } from '../../src/router'
import { useAuthStore } from '../../src/stores/auth'

const authSession: AuthSession = {
  user: { id: 'user_1', account: 'Alice' },
  authenticatedAt: '2026-08-07T00:00:00.000Z',
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

function createApi(): DesktopAPI {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue(null),
      login: vi.fn().mockResolvedValue(authSession),
      register: vi.fn().mockResolvedValue(authSession),
      sendOtp: vi.fn(),
      verifyOtp: vi.fn(),
      cancelOtp: vi.fn().mockResolvedValue(undefined),
      loginWithPassword: vi.fn().mockResolvedValue(authSession),
      logout: vi.fn().mockResolvedValue(undefined),
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
  router.beforeEach(createAuthGuard(useAuthStore(pinia)))
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
    const pendingLogout = deferred<void>()
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

    const restoring = auth.restore()
    await restoring
    pendingLogout.resolve()
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
    const pendingLogout = deferred<void>()
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

    const restoring = auth.restore()
    pendingRestore.resolve(authSession)
    await restoring
    expect(auth.session).toEqual(authSession)

    pendingLogout.resolve()
    await verifying

    expect(auth.session).toBeNull()
    expect(auth.initialized).toBe(true)
    expect(auth.restoring).toBe(false)
    expect(auth.submitting).toBe(false)
  })

  it('keeps the current session when logout fails', async () => {
    const api = createApi()
    vi.mocked(api.auth.logout).mockRejectedValue(toSafeAppError({ code: 'INTERNAL_ERROR' }))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const auth = useAuthStore()
    auth.session = authSession

    await expect(auth.logout()).resolves.toBe(false)

    expect(auth.session).toEqual(authSession)
    expect(auth.error).toBe('操作失败，请稍后重试')
  })

  it('clears the session after a pending logout succeeds despite a later OTP cancellation', async () => {
    const api = createApi()
    const logoutStarted = deferred<void>()
    const pendingLogout = deferred<void>()
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
    pendingLogout.resolve()
    await expect(loggingOut).resolves.toBe(true)

    expect(auth.session).toBeNull()
    expect(auth.initialized).toBe(true)
    expect(auth.error).toBe('')
    expect(auth.submitting).toBe(false)
  })

  it('makes logout terminal when a restore starts before remote logout succeeds', async () => {
    const api = createApi()
    const logoutStarted = deferred<void>()
    const pendingLogout = deferred<void>()
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

    pendingLogout.resolve()
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

  it('registers after confirmation validation and enters chat', async () => {
    const { api, router, wrapper } = await mountAuthApp('/register')

    expect(wrapper.get('[data-testid="register-account"]').attributes('autocomplete')).toBe('username')
    expect(wrapper.get('[data-testid="register-password"]').attributes('autocomplete')).toBe('new-password')
    expect(wrapper.get('[data-testid="register-confirm"]').attributes('autocomplete')).toBe('new-password')
    await wrapper.get('[data-testid="register-account"]').setValue(' Alice ')
    await wrapper.get('[data-testid="register-password"]').setValue('password')
    await wrapper.get('[data-testid="register-confirm"]').setValue('different')
    await wrapper.get('[data-testid="register-form"]').trigger('submit')
    expect(api.auth.register).not.toHaveBeenCalled()
    expect(wrapper.get('[role="alert"]').text()).toContain('两次输入的密码不一致')

    await wrapper.get('[data-testid="register-confirm"]').setValue('password')
    await wrapper.get('[data-testid="register-form"]').trigger('submit')
    await vi.waitFor(() => expect(api.auth.register).toHaveBeenCalledWith({ account: 'Alice', password: 'password' }))
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/chat'))
  })

  it('shows a duplicate-account error returned by registration', async () => {
    const api = createApi()
    vi.mocked(api.auth.register).mockRejectedValue(toSafeAppError({ code: 'AUTH_ACCOUNT_EXISTS' }))
    const { wrapper } = await mountAuthApp('/register', api)
    await wrapper.get('[data-testid="register-account"]').setValue('Alice')
    await wrapper.get('[data-testid="register-password"]').setValue('password')
    await wrapper.get('[data-testid="register-confirm"]').setValue('password')
    await wrapper.get('[data-testid="register-form"]').trigger('submit')
    await vi.waitFor(() => expect(wrapper.get('[role="alert"]').text()).toContain('该账号已存在'))
  })
})

describe('workbench authentication entry', () => {
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

  it('keeps the account visible on failed logout and navigates only after success', async () => {
    const api = createApi()
    vi.mocked(api.auth.logout).mockRejectedValueOnce(toSafeAppError({ code: 'INTERNAL_ERROR' }))
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
})
