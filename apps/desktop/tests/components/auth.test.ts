import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
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

function createApi(): DesktopAPI {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue(null),
      login: vi.fn().mockResolvedValue(authSession),
      register: vi.fn().mockResolvedValue(authSession),
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
afterEach(() => Reflect.deleteProperty(window, 'autoForge'))

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

  it('stores successful login and registration sessions', async () => {
    const api = createApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const auth = useAuthStore()

    await expect(auth.login({ account: 'Alice', password: 'password' })).resolves.toEqual(authSession)
    expect(auth.session).toEqual(authSession)
    auth.session = null
    await expect(auth.register({ account: 'Alice', password: 'password' })).resolves.toEqual(authSession)
    expect(auth.session).toEqual(authSession)
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

  it('logs in with normalized credentials and returns to a safe target', async () => {
    const { api, router, wrapper } = await mountAuthApp('/login?redirect=/settings')

    expect(wrapper.find('[data-testid="login-form"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('登录 AutoForge')
    expect(wrapper.get('label[for="login-account"]').text()).toBe('账号')
    expect(wrapper.get('label[for="login-password"]').text()).toBe('密码')
    expect(wrapper.get('[data-testid="login-account"]').attributes('autocomplete')).toBe('username')
    expect(wrapper.get('[data-testid="login-password"]').attributes('autocomplete')).toBe('current-password')

    await wrapper.get('[data-testid="login-account"]').setValue(' Alice ')
    await wrapper.get('[data-testid="login-password"]').setValue('password')
    await wrapper.get('[data-testid="login-form"]').trigger('submit')

    await vi.waitFor(() => expect(api.auth.login).toHaveBeenCalledWith({ account: 'Alice', password: 'password' }))
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/settings'))
  })

  it('validates login fields, maps credential errors and suppresses duplicate submission', async () => {
    const api = createApi()
    let rejectLogin!: (error: unknown) => void
    vi.mocked(api.auth.login).mockReturnValue(new Promise((_resolve, reject) => { rejectLogin = reject }))
    const { wrapper } = await mountAuthApp('/login', api)

    await wrapper.get('[data-testid="login-account"]').setValue('bad account')
    await wrapper.get('[data-testid="login-password"]').setValue('short')
    await wrapper.get('[data-testid="login-form"]').trigger('submit')
    expect(api.auth.login).not.toHaveBeenCalled()
    expect(wrapper.get('[role="alert"]').text()).toContain('账号')

    await wrapper.get('[data-testid="login-account"]').setValue('Alice')
    await wrapper.get('[data-testid="login-password"]').setValue('password')
    void wrapper.get('[data-testid="login-form"]').trigger('submit')
    void wrapper.get('[data-testid="login-form"]').trigger('submit')
    await vi.waitFor(() => expect(api.auth.login).toHaveBeenCalledTimes(1))
    rejectLogin(toSafeAppError({ code: 'AUTH_INVALID_CREDENTIALS' }))
    await vi.waitFor(() => expect(wrapper.get('[role="alert"]').text()).toContain('账号或密码错误'))
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
