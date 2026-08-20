import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { CloudBaseAuthPort } from './cloudbase-auth-port.js'
import { createCloudBaseAuthPort, readCloudBaseAuthConfig } from './cloudbase-auth-port.js'

describe('CloudBase auth port', () => {
  it('requires the publishable key without exposing it in the error', () => {
    expect(() => readCloudBaseAuthConfig({})).toThrow('CloudBase authentication is not configured')
    expect(() => readCloudBaseAuthConfig({
      AUTOFORGE_CLOUDBASE_PUBLISHABLE_KEY: 'publishable-test',
    })).not.toThrow()
  })

  it('initializes the canonical environment and forwards auth calls', async () => {
    const auth = {
      signInWithOtp: vi.fn(),
      signUp: vi.fn(),
      signInWithPassword: vi.fn(),
      getSession: vi.fn(),
      setSession: vi.fn(),
      refreshSession: vi.fn(),
      signOut: vi.fn(),
    }
    const init = vi.fn(() => ({ auth }))
    const port = createCloudBaseAuthPort({
      env: 'autoforge-d1gkhyfb419ba8455',
      region: 'ap-shanghai',
      accessKey: 'publishable-test',
    }, { init })

    await port.signInWithPassword({ username: 'alice', password: 'password' })
    await port.setSession({
      access_token: 'stored-access-token',
      refresh_token: 'stored-refresh-token',
    })
    expect(init).toHaveBeenCalledWith({
      env: 'autoforge-d1gkhyfb419ba8455',
      region: 'ap-shanghai',
      accessKey: 'publishable-test',
      auth: { detectSessionInUrl: false },
    })
    expect(auth.signInWithPassword).toHaveBeenCalledWith({
      username: 'alice', password: 'password',
    })
    expect(auth.setSession).toHaveBeenCalledWith({
      access_token: 'stored-access-token',
      refresh_token: 'stored-refresh-token',
    })
  })

  it('requires both encrypted tokens when restoring a session', () => {
    expectTypeOf<Parameters<CloudBaseAuthPort['setSession']>[0]>().toEqualTypeOf<{
      access_token: string
      refresh_token: string
    }>()
  })
})
