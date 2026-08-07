import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toSafeAppError, type AuthSession, type DesktopAPI } from '@autoforge/shared'
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
    chat: {},
    media: {},
    workflows: {},
    developer: {},
    executions: {},
    permissions: {},
    settings: {},
    system: {},
  } as unknown as DesktopAPI
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
