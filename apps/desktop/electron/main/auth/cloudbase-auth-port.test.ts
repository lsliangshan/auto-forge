import { describe, expect, it, vi } from 'vitest'
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
    expect(init).toHaveBeenCalledWith({
      env: 'autoforge-d1gkhyfb419ba8455',
      region: 'ap-shanghai',
      accessKey: 'publishable-test',
      auth: { detectSessionInUrl: false },
    })
    expect(auth.signInWithPassword).toHaveBeenCalledWith({
      username: 'alice', password: 'password',
    })
  })
})
