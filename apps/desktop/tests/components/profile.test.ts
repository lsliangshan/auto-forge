import { createPinia, setActivePinia } from 'pinia'
import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import ElementPlus from 'element-plus'
import {
  toSafeAppError,
  type AuthSession,
  type DesktopAPI,
  type UserProfile,
} from '@autoforge/shared'
import App from '../../src/App.vue'
import { createAuthGuard, routes } from '../../src/router'
import { useAuthStore } from '../../src/stores/auth'
import { useProfileStore } from '../../src/stores/profile'

const authSession: AuthSession = {
  user: { id: 'user_1', account: 'Alice' },
  authenticatedAt: '2026-08-18T00:00:00.000Z',
}

const savedProfile: UserProfile = {
  userId: 'user_1',
  account: 'Alice',
  displayName: 'Alice Zhang',
  avatarUrl: 'https://cdn.example.com/profiles/user_1/a.png',
  gender: 'female',
  birthDate: '2000-01-01',
  email: 'alice@example.com',
  phone: '+8613800138000',
  updatedAt: '2026-08-18T00:00:00.000Z',
}

function createApi(profile: UserProfile = savedProfile): DesktopAPI {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue(authSession),
      sendOtp: vi.fn(),
      verifyOtp: vi.fn(),
      cancelOtp: vi.fn().mockResolvedValue(undefined),
      loginWithPassword: vi.fn(),
      logout: vi.fn().mockResolvedValue(undefined),
    },
    profile: {
      get: vi.fn().mockResolvedValue(profile),
      update: vi.fn().mockImplementation(async (input) => ({ ...profile, ...input })),
      pickAndUploadAvatar: vi.fn().mockResolvedValue(null),
    },
    chat: {
      listConversations: vi.fn().mockResolvedValue([]),
      listMessages: vi.fn().mockResolvedValue([]),
      createConversation: vi.fn(), renameConversation: vi.fn(), deleteConversation: vi.fn(),
      send: vi.fn(), cancel: vi.fn(), getGenerationPreferences: vi.fn(), updateGenerationPreferences: vi.fn(),
      onEvent: vi.fn(() => vi.fn()),
    },
    media: {} as DesktopAPI['media'],
    workflows: { list: vi.fn().mockResolvedValue([]) } as unknown as DesktopAPI['workflows'],
    developer: {} as DesktopAPI['developer'],
    executions: { list: vi.fn().mockResolvedValue([]), onEvent: vi.fn(() => vi.fn()) } as unknown as DesktopAPI['executions'],
    permissions: { listGrants: vi.fn().mockResolvedValue([]) } as unknown as DesktopAPI['permissions'],
    settings: {} as DesktopAPI['settings'],
    system: {} as DesktopAPI['system'],
  }
}

const wrappers: VueWrapper[] = []

async function mountApp(path: string, api = createApi(), session: AuthSession | null = authSession) {
  Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore(pinia)
  auth.session = session
  auth.initialized = true
  const router = createRouter({ history: createMemoryHistory(), routes })
  router.beforeEach(createAuthGuard(auth))
  await router.push(path)
  await router.isReady()
  const wrapper = mount(App, {
    global: {
      plugins: [pinia, router, ElementPlus],
      stubs: {
        ContextSidebar: { template: '<aside />' },
        InspectorPanel: { template: '<aside />' },
      },
    },
  })
  wrappers.push(wrapper)
  return { api, auth, pinia, router, wrapper }
}

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  Reflect.deleteProperty(window, 'autoForge')
  vi.restoreAllMocks()
})

describe('personal profile page', () => {
  it('protects the profile route and renders the persisted fields', async () => {
    const anonymous = await mountApp('/profile', createApi(), null)
    expect(anonymous.router.currentRoute.value.fullPath).toBe('/login?redirect=/profile')
    anonymous.wrapper.unmount()

    const app = await mountApp('/profile')
    await vi.waitFor(() => expect(app.api.profile.get).toHaveBeenCalledOnce())
    expect(app.wrapper.get('[data-testid="profile-account"]').attributes('readonly')).toBeDefined()
    expect((app.wrapper.get('[data-testid="profile-display-name"]').element as HTMLInputElement).value).toBe('Alice Zhang')
    expect((app.wrapper.get('[data-testid="profile-birth-date"]').element as HTMLInputElement).value).toBe('2000-01-01')
    expect((app.wrapper.get('[data-testid="profile-email"]').element as HTMLInputElement).value).toBe('alice@example.com')
    expect((app.wrapper.get('[data-testid="profile-phone"]').element as HTMLInputElement).value).toBe('+8613800138000')
    expect(app.wrapper.get('[data-testid="profile-avatar"]').attributes('src')).toBe(savedProfile.avatarUrl)
    expect(app.wrapper.text()).toContain('联系方式')
  })

  it('uploads a new avatar into the draft and saves all fields', async () => {
    const api = createApi()
    vi.mocked(api.profile.pickAndUploadAvatar).mockResolvedValue({ url: 'https://cdn.example.com/new.png' })
    const app = await mountApp('/profile', api)
    await vi.waitFor(() => expect(api.profile.get).toHaveBeenCalledOnce())

    await app.wrapper.get('[data-testid="change-avatar"]').trigger('click')
    await app.wrapper.get('[data-testid="profile-display-name"]').setValue('New Name')
    await app.wrapper.get('form').trigger('submit')

    await vi.waitFor(() => expect(api.profile.update).toHaveBeenCalledWith({
      avatarUrl: 'https://cdn.example.com/new.png',
      displayName: 'New Name',
      gender: 'female',
      birthDate: '2000-01-01',
      email: 'alice@example.com',
      phone: '+8613800138000',
    }))
  })

  it('blocks invalid fields and preserves a failed save draft', async () => {
    const api = createApi()
    const app = await mountApp('/profile', api)
    await vi.waitFor(() => expect(api.profile.get).toHaveBeenCalledOnce())

    await app.wrapper.get('[data-testid="profile-birth-date"]').setValue('2999-01-01')
    await app.wrapper.get('[data-testid="profile-email"]').setValue('invalid')
    await app.wrapper.get('[data-testid="profile-phone"]').setValue('123')
    await app.wrapper.get('form').trigger('submit')
    expect(api.profile.update).not.toHaveBeenCalled()
    expect(app.wrapper.get('[role="alert"]').text()).toContain('请检查')

    await app.wrapper.get('[data-testid="profile-birth-date"]').setValue('2001-01-01')
    await app.wrapper.get('[data-testid="profile-email"]').setValue('new@example.com')
    await app.wrapper.get('[data-testid="profile-phone"]').setValue('+8613900139000')
    await app.wrapper.get('[data-testid="profile-display-name"]').setValue('Unsaved')
    vi.mocked(api.profile.update).mockRejectedValueOnce(toSafeAppError({ code: 'INTERNAL_ERROR' }))
    await app.wrapper.get('form').trigger('submit')

    await vi.waitFor(() => expect((app.wrapper.get('[data-testid="profile-display-name"]').element as HTMLInputElement).value)
      .toBe('Unsaved'))
    expect(app.wrapper.get('[role="alert"]').text()).toContain('保存')
  })

  it('synchronizes a saved display name with the rail and uses account fallbacks', async () => {
    const api = createApi({ userId: 'user_1', account: 'Alice' })
    const app = await mountApp('/profile', api)
    await vi.waitFor(() => expect(api.profile.get).toHaveBeenCalledOnce())
    expect(app.wrapper.get('[data-testid="profile-avatar-fallback"]').text()).toBe('A')
    expect(app.wrapper.get('[data-testid="current-account"]').text()).toBe('Alice')

    await app.wrapper.get('[data-testid="profile-display-name"]').setValue('Saved Name')
    vi.mocked(api.profile.update).mockResolvedValue({ userId: 'user_1', account: 'Alice', displayName: 'Saved Name' })
    await app.wrapper.get('form').trigger('submit')

    await vi.waitFor(() => expect(app.wrapper.get('[data-testid="current-account"]').text()).toBe('Saved Name'))
  })

  it('navigates from the rail and clears profile state only after successful logout', async () => {
    const app = await mountApp('/chat', createApi({ userId: 'user_1', account: 'Alice' }))
    await vi.waitFor(() => expect(app.api.profile.get).toHaveBeenCalledOnce())
    const profile = useProfileStore(app.pinia)
    expect(profile.profile?.account).toBe('Alice')

    await app.wrapper.get('[data-testid="profile-entry"]').trigger('click')
    await vi.waitFor(() => expect(app.router.currentRoute.value.fullPath).toBe('/profile'))
    await app.wrapper.get('[aria-label="退出登录"]').trigger('click')
    await vi.waitFor(() => expect(app.router.currentRoute.value.fullPath).toBe('/login'))
    expect(profile.profile).toBeNull()
  })
})
