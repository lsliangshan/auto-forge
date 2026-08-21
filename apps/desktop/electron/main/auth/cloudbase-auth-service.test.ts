import { describe, expect, it, vi } from 'vitest'
import { toSafeAppError } from '@autoforge/shared'
import type { CloudBaseAuthPort } from './cloudbase-auth-port.js'
import { CloudBaseAuthService } from './cloudbase-auth-service.js'
import type { AuthSecretStore } from './auth-service.js'

const SESSION_KEY = 'cloudbase_auth_session'
const NOW = 1_787_011_200_000
const AUTHENTICATED_AT = '2026-08-18T00:00:00.000Z'

interface FakeCloudSession {
  access_token: string
  refresh_token: string
  expires_in: number
  user: { id: string } & Record<string, unknown>
}

function cloudSession(
  account = 'Alice_1',
  tokens: { accessToken?: string; refreshToken?: string; expiresIn?: number } = {},
): FakeCloudSession {
  return {
    access_token: tokens.accessToken ?? 'access-token',
    refresh_token: tokens.refreshToken ?? 'refresh-token',
    expires_in: tokens.expiresIn ?? 3_600,
    user: {
      id: 'cloud_uid',
      username: account,
      user_metadata: { nickname: account },
    },
  }
}

function cloudSessionForUser(user: Record<string, unknown>): FakeCloudSession {
  return {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expires_in: 3_600,
    user: { id: 'cloud_uid', ...user },
  }
}

function anonymousCloudSession(account = 'Alice_1'): FakeCloudSession {
  const session = cloudSession(account, {
    accessToken: 'provider-secret-access-token',
    refreshToken: 'provider-secret-refresh-token',
  })
  session.user.is_anonymous = true
  return session
}

function authResponse(session: FakeCloudSession = cloudSession()) {
  return {
    data: { session, user: session.user },
    error: null,
  }
}

function otpResponse(verifyOtp: (input: { token: string }) => Promise<unknown>) {
  return { data: { verifyOtp }, error: null }
}

function noSessionResponse() {
  return { data: { session: null, user: null }, error: null }
}

function methodUserAuthResponse(session: FakeCloudSession = cloudSession('Ignored Provider User')) {
  const methodValue = () => 'ignored-provider-value'
  const user = {
    ...session.user,
    id: methodValue,
    phone: methodValue,
    email: methodValue,
    user_metadata: {
      nickname: methodValue,
      nickName: methodValue,
      username: methodValue,
      name: methodValue,
    },
  }
  return {
    data: {
      session: { ...session, sub: methodValue, user },
      user,
    },
    error: null,
  }
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

function storedSession(overrides: Partial<{
  accessToken: string
  refreshToken: string
  expiresAt: number
  authenticatedAt: string
  user: { id: string; account: string; profile?: Record<string, unknown> }
}> = {}) {
  return JSON.stringify({
    accessToken: 'stored-access-token',
    refreshToken: 'stored-refresh-token',
    expiresAt: NOW + 60_000,
    authenticatedAt: '2026-08-17T00:00:00.000Z',
    user: { id: 'stored_uid', account: 'Stored User' },
    ...overrides,
  })
}

function harness() {
  const port: CloudBaseAuthPort = {
    signInWithOtp: vi.fn(),
    signUp: vi.fn(),
    signInWithPassword: vi.fn(),
    getSession: vi.fn(),
    getUser: vi.fn(),
    refreshUser: vi.fn(),
    updateUser: vi.fn(),
    setSession: vi.fn(),
    refreshSession: vi.fn(),
    signOut: vi.fn(),
  }
  const stored = new Map<string, string>()
  const secrets: AuthSecretStore = {
    set: vi.fn(async (key, value) => { stored.set(key, value) }),
    get: vi.fn(async (key) => stored.get(key)),
    delete: vi.fn((key) => { stored.delete(key) }),
  }
  const verifyOtp = vi.fn<(input: { token: string }) => Promise<unknown>>()
  let nextId = 0
  let now = NOW
  const service = new CloudBaseAuthService(port, secrets, {
    createId: () => `challenge_${++nextId}`,
    now: () => now,
  })
  return {
    port,
    secrets,
    service,
    stored,
    verifyOtp,
    advanceTime: (milliseconds: number) => { now += milliseconds },
  }
}

describe('CloudBaseAuthService', () => {
  it.each([
    ['phone', '18311032722', { phone: '+8618311032722', options: { shouldCreateUser: false } }],
    ['email', 'USER@example.com', { email: 'user@example.com', options: { shouldCreateUser: false } }],
  ] as const)('sends %s login OTP without creating users', async (channel, target, expected) => {
    const app = harness()
    vi.mocked(app.port.signInWithOtp).mockResolvedValue(otpResponse(app.verifyOtp))

    await expect(app.service.sendOtp({ intent: 'login', channel, target }))
      .resolves.toEqual({ challengeId: 'challenge_1', expiresIn: 300 })
    expect(app.port.signInWithOtp).toHaveBeenCalledWith(expected)
  })

  it.each(['phone', 'email'] as const)('registers through %s with username and password', async (channel) => {
    const app = harness()
    vi.mocked(app.port.signUp).mockResolvedValue(otpResponse(app.verifyOtp))
    const target = channel === 'phone' ? '18311032722' : 'User@example.com'
    const challenge = await app.service.sendOtp({
      intent: 'register',
      channel,
      target,
      account: ' Alice_1 ',
      password: 'password',
    })

    expect(app.port.signUp).toHaveBeenCalledWith(channel === 'phone' ? {
      phone: '+8618311032722',
      username: 'alice_1',
      password: 'password',
      nickname: 'Alice_1',
    } : {
      email: 'user@example.com',
      username: 'alice_1',
      password: 'password',
      nickname: 'Alice_1',
    })

    app.verifyOtp.mockResolvedValue(authResponse(cloudSession()))
    await expect(app.service.verifyOtp({ challengeId: challenge.challengeId, code: '123456' }))
      .resolves.toMatchObject({ user: { id: 'cloud_uid', account: 'Alice_1' } })
    expect(app.verifyOtp).toHaveBeenCalledWith({ token: '123456' })
    expect(app.secrets.set).toHaveBeenCalledWith('cloudbase_auth_session', expect.any(String))
  })

  it('replaces, cancels, expires, and consumes challenges once', async () => {
    const app = harness()
    vi.mocked(app.port.signInWithOtp).mockResolvedValue(otpResponse(app.verifyOtp))
    const first = await app.service.sendOtp({
      intent: 'login', channel: 'phone', target: '18311032722',
    })
    const second = await app.service.sendOtp({
      intent: 'login', channel: 'email', target: 'user@example.com',
    })
    await expect(app.service.verifyOtp({ challengeId: first.challengeId, code: '123456' }))
      .rejects.toMatchObject({ code: 'AUTH_OTP_EXPIRED' })
    await app.service.cancelOtp('unrelated_challenge')
    app.verifyOtp.mockResolvedValue(authResponse())
    await expect(app.service.verifyOtp({ challengeId: second.challengeId, code: '123456' }))
      .resolves.toMatchObject({ user: { id: 'cloud_uid' } })

    const cancelled = await app.service.sendOtp({
      intent: 'login', channel: 'email', target: 'user@example.com',
    })
    await app.service.cancelOtp(cancelled.challengeId)
    await expect(app.service.verifyOtp({ challengeId: cancelled.challengeId, code: '123456' }))
      .rejects.toMatchObject({ code: 'AUTH_OTP_EXPIRED' })

    const third = await app.service.sendOtp({
      intent: 'login', channel: 'phone', target: '18311032722',
    })
    app.advanceTime(300_000)
    await expect(app.service.verifyOtp({ challengeId: third.challengeId, code: '123456' }))
      .rejects.toMatchObject({ code: 'AUTH_OTP_EXPIRED' })
    expect(app.verifyOtp).toHaveBeenCalledTimes(1)

    const fourth = await app.service.sendOtp({
      intent: 'login', channel: 'email', target: 'user@example.com',
    })
    app.verifyOtp.mockResolvedValue(authResponse())
    await expect(app.service.verifyOtp({ challengeId: fourth.challengeId, code: '123456' }))
      .resolves.toMatchObject({ user: { id: 'cloud_uid' } })
    await expect(app.service.verifyOtp({ challengeId: fourth.challengeId, code: '123456' }))
      .rejects.toMatchObject({ code: 'AUTH_OTP_EXPIRED' })
    expect(app.verifyOtp).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['invalid verification code', 'AUTH_INVALID_OTP'],
    ['verification expired', 'AUTH_OTP_EXPIRED'],
    ['rate limit exceeded', 'AUTH_OTP_RATE_LIMITED'],
    ['user not found', 'AUTH_ACCOUNT_NOT_FOUND'],
    ['username already exists', 'AUTH_ACCOUNT_EXISTS'],
    ['invalid username or password', 'AUTH_INVALID_CREDENTIALS'],
  ] as const)('maps %s without exposing provider details', async (message, code) => {
    const app = harness()
    vi.mocked(app.port.signInWithPassword).mockResolvedValue({
      data: { user: null, session: null },
      error: { message, secret: 'provider-detail' },
    })

    await expect(app.service.loginWithPassword({
      account: 'alice_1', password: 'password',
    })).rejects.toEqual(toSafeAppError({ code }))
  })

  it('maps unknown provider failures to a fixed internal error', async () => {
    const app = harness()
    vi.mocked(app.port.signInWithPassword).mockRejectedValue({
      message: 'raw provider secret', debugToken: 'must-not-escape',
    })

    await expect(app.service.loginWithPassword({
      account: 'alice_1', password: 'password',
    })).rejects.toEqual(toSafeAppError({ code: 'INTERNAL_ERROR' }))
  })

  it('rejects an anonymous password session without persisting provider tokens', async () => {
    const app = harness()
    vi.mocked(app.port.signInWithPassword).mockResolvedValue(authResponse(anonymousCloudSession()))

    await expect(app.service.loginWithPassword({
      account: 'alice_1', password: 'password',
    })).rejects.toEqual(toSafeAppError({ code: 'INTERNAL_ERROR' }))
    expect(app.secrets.set).not.toHaveBeenCalled()
    expect(app.stored.has(SESSION_KEY)).toBe(false)
  })

  it('rejects an anonymous OTP session without persisting provider tokens', async () => {
    const app = harness()
    vi.mocked(app.port.signInWithOtp).mockResolvedValue(otpResponse(app.verifyOtp))
    app.verifyOtp.mockResolvedValue(authResponse(anonymousCloudSession()))
    const challenge = await app.service.sendOtp({
      intent: 'login', channel: 'phone', target: '18311032722',
    })

    await expect(app.service.verifyOtp({ challengeId: challenge.challengeId, code: '123456' }))
      .rejects.toEqual(toSafeAppError({ code: 'INTERNAL_ERROR' }))
    expect(app.secrets.set).not.toHaveBeenCalled()
    expect(app.stored.has(SESSION_KEY)).toBe(false)
  })

  it('validates every public input before invoking CloudBase', async () => {
    const app = harness()

    await expect(app.service.sendOtp({
      intent: 'login', channel: 'phone', target: '123',
    } as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(app.service.verifyOtp({
      challengeId: 'challenge_1', code: 'not-an-otp',
    } as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(app.service.cancelOtp('   ')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(app.service.loginWithPassword({
      account: 'bad', password: 'password',
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' })

    expect(app.port.signInWithOtp).not.toHaveBeenCalled()
    expect(app.port.signInWithPassword).not.toHaveBeenCalled()
    expect(app.verifyOtp).not.toHaveBeenCalled()
  })

  it('requires an error-free response with a callback and a real session', async () => {
    const app = harness()
    vi.mocked(app.port.signInWithOtp).mockResolvedValue({
      data: { verifyOtp: app.verifyOtp },
      error: { message: 'invalid verification code' },
    })
    await expect(app.service.sendOtp({
      intent: 'login', channel: 'email', target: 'user@example.com',
    })).rejects.toEqual(toSafeAppError({ code: 'AUTH_INVALID_OTP' }))

    vi.mocked(app.port.signInWithPassword).mockResolvedValue({
      data: { session: { access_token: 'access-token' }, user: { id: 'cloud_uid' } },
      error: null,
    })
    await expect(app.service.loginWithPassword({
      account: 'alice_1', password: 'password',
    })).rejects.toEqual(toSafeAppError({ code: 'INTERNAL_ERROR' }))
    expect(app.secrets.set).not.toHaveBeenCalled()
  })

  it.each([
    [{ user_metadata: { nickname: ' Metadata Nick ' }, username: 'username' }, 'username'],
    [{ nickName: ' Camel Nick ', username: 'username' }, 'username'],
    [{ username: ' normalized_user ', name: 'Friendly Name' }, 'normalized_user'],
    [{ name: ' Friendly Name ' }, 'Friendly Name'],
  ] as const)('uses the first safe display field from %o', async (user, expected) => {
    const app = harness()
    vi.mocked(app.port.signInWithPassword).mockResolvedValue(authResponse(cloudSessionForUser(user)))

    await expect(app.service.loginWithPassword({
      account: 'alice_1', password: 'password',
    })).resolves.toMatchObject({ user: { account: expected } })
  })

  it('normalizes CloudBase identity fields into the authenticated user snapshot', async () => {
    const app = harness()
    vi.mocked(app.port.signInWithPassword).mockResolvedValue(authResponse(cloudSessionForUser({
      username: 'alice_1',
      email: 'alice@example.com',
      email_confirmed_at: '2026-08-20T00:00:00.000Z',
      phone: '+8618311032722',
      phone_confirmed_at: '2026-08-20T00:00:00.000Z',
      user_metadata: {
        nickname: 'Alice Zhang',
        avatarUrl: 'https://cdn.example.com/profiles/cloud_uid/avatar.webp',
        gender: 'FEMALE',
      },
    })))

    await expect(app.service.loginWithPassword({
      account: 'alice_1', password: 'password',
    })).resolves.toEqual({
      user: {
        id: 'cloud_uid',
        account: 'alice_1',
        profile: {
          displayName: 'Alice Zhang',
          avatarUrl: 'https://cdn.example.com/profiles/cloud_uid/avatar.webp',
          gender: 'female',
          email: 'alice@example.com',
          phone: '+8618311032722',
        },
      },
      authenticatedAt: AUTHENTICATED_AT,
    })
  })

  it('omits unverified or malformed CloudBase profile fields without erasing local values', async () => {
    const app = harness()
    vi.mocked(app.port.signInWithPassword).mockResolvedValue(authResponse(cloudSessionForUser({
      username: 'alice_1',
      email: 'unverified@example.com',
      phone: '+8618311032722',
      confirmed_at: '2026-08-20T00:00:00.000Z',
      user_metadata: {
        avatarUrl: 'http://insecure.example.com/avatar.png',
        gender: 'UNKNOWN',
      },
    })))

    await expect(app.service.loginWithPassword({
      account: 'alice_1', password: 'password',
    })).resolves.toEqual({
      user: { id: 'cloud_uid', account: 'alice_1' },
      authenticatedAt: AUTHENTICATED_AT,
    })
  })

  it.each([
    [{
      email: 'verified@example.com',
      email_confirmed_at: '2026-08-20T00:00:00.000Z',
      phone: '+8618311032722',
      confirmed_at: '2026-08-20T00:00:00.000Z',
    }, { email: 'verified@example.com' }],
    [{
      email: 'unverified@example.com',
      phone: '+8618311032722',
      phone_confirmed_at: '2026-08-20T00:00:00.000Z',
      confirmed_at: '2026-08-20T00:00:00.000Z',
    }, { phone: '+8618311032722' }],
  ] as const)('projects only the contact with its matching confirmation timestamp', async (
    contacts,
    expectedProfile,
  ) => {
    const app = harness()
    vi.mocked(app.port.signInWithPassword).mockResolvedValue(authResponse(cloudSessionForUser({
      username: 'alice_1',
      ...contacts,
    })))

    const authenticated = await app.service.loginWithPassword({
      account: 'alice_1', password: 'password',
    })

    expect(authenticated.user.profile).toEqual(expectedProfile)
  })

  it('updates editable CloudBase profile fields and persists the returned identity snapshot', async () => {
    const app = harness()
    vi.mocked(app.port.signInWithPassword).mockResolvedValue(authResponse(cloudSessionForUser({
      username: 'alice_1', user_metadata: { nickname: 'Alice' },
    })))
    vi.mocked(app.port.updateUser).mockResolvedValue({
      data: {
        user: {
          id: 'cloud_uid',
          username: 'alice_1',
          user_metadata: {
            nickname: 'Alice Cloud',
            avatarUrl: 'https://cdn.example.com/profiles/cloud_uid/new.webp',
            gender: 'FEMALE',
          },
        },
      },
      error: null,
    })
    await app.service.loginWithPassword({ account: 'alice_1', password: 'password' })

    await expect(app.service.updateUserProfile({
      displayName: 'Alice Cloud',
      avatarUrl: 'https://cdn.example.com/profiles/cloud_uid/new.webp',
      gender: 'female',
    })).resolves.toEqual({
      id: 'cloud_uid',
      account: 'alice_1',
      profile: {
        displayName: 'Alice Cloud',
        avatarUrl: 'https://cdn.example.com/profiles/cloud_uid/new.webp',
        gender: 'female',
      },
    })
    expect(app.port.updateUser).toHaveBeenCalledWith({
      nickname: 'Alice Cloud',
      avatar_url: 'https://cdn.example.com/profiles/cloud_uid/new.webp',
      gender: 'FEMALE',
    })
    expect(JSON.parse(app.stored.get(SESSION_KEY) ?? '')).toMatchObject({
      user: {
        id: 'cloud_uid',
        account: 'alice_1',
        profile: { displayName: 'Alice Cloud', gender: 'female' },
      },
    })
  })

  it('refreshes the CloudBase user when updateUser omits the updated identity', async () => {
    const app = harness()
    vi.mocked(app.port.signInWithPassword).mockResolvedValue(authResponse(cloudSessionForUser({
      username: 'alice_1', user_metadata: { nickname: 'Alice' },
    })))
    vi.mocked(app.port.updateUser).mockResolvedValue({ data: {}, error: null })
    vi.mocked(app.port.refreshUser).mockResolvedValue({
      data: {
        user: {
          id: 'cloud_uid',
          username: 'alice_1',
          user_metadata: { nickname: 'Refreshed Name' },
        },
      },
      error: null,
    })
    await app.service.loginWithPassword({ account: 'alice_1', password: 'password' })

    await expect(app.service.updateUserProfile({ displayName: 'Requested Name' }))
      .resolves.toMatchObject({ profile: { displayName: 'Refreshed Name' } })
    expect(app.port.refreshUser).toHaveBeenCalledOnce()
    expect(app.port.getUser).not.toHaveBeenCalled()
  })

  it('gets the current CloudBase user when refreshUser also omits the identity', async () => {
    const app = harness()
    vi.mocked(app.port.signInWithPassword).mockResolvedValue(authResponse(cloudSessionForUser({
      username: 'alice_1', user_metadata: { nickname: 'Alice' },
    })))
    vi.mocked(app.port.updateUser).mockResolvedValue({ data: {}, error: null })
    vi.mocked(app.port.refreshUser).mockResolvedValue({ data: {}, error: null })
    vi.mocked(app.port.getUser).mockResolvedValue({
      data: {
        user: {
          id: 'cloud_uid',
          username: 'alice_1',
          user_metadata: { nickname: 'Current Name' },
        },
      },
      error: null,
    })
    await app.service.loginWithPassword({ account: 'alice_1', password: 'password' })

    await expect(app.service.updateUserProfile({ displayName: 'Requested Name' }))
      .resolves.toMatchObject({ profile: { displayName: 'Current Name' } })
    expect(app.port.refreshUser).toHaveBeenCalledOnce()
    expect(app.port.getUser).toHaveBeenCalledOnce()
  })

  it('discards local credentials even when remote signOut fails', async () => {
    const app = harness()
    vi.mocked(app.port.signInWithPassword).mockResolvedValue(authResponse())
    vi.mocked(app.port.signOut).mockRejectedValue({
      code: 'NETWORK_ERROR', message: 'provider infrastructure detail',
    })
    await app.service.loginWithPassword({ account: 'alice_1', password: 'password' })

    await expect(app.service.discardSession()).resolves.toBeUndefined()
    expect(app.secrets.delete).toHaveBeenCalledWith(SESSION_KEY)
    expect(app.stored.has(SESSION_KEY)).toBe(false)
    expect(app.port.signOut).toHaveBeenCalledOnce()
    await expect(app.service.getSession()).resolves.toBeNull()
    expect(app.port.getSession).not.toHaveBeenCalled()
  })

  it.each([
    [{ phone: '+8618311032722' }, '+8618311032722'],
    [{ email: 'user@example.com' }, 'user@example.com'],
  ] as const)('masks fallback identity %o', async (user, plaintext) => {
    const app = harness()
    vi.mocked(app.port.signInWithPassword).mockResolvedValue(authResponse(cloudSessionForUser(user)))

    const session = await app.service.loginWithPassword({
      account: 'alice_1', password: 'password',
    })
    expect(session.user.account).toContain('*')
    expect(session.user.account).not.toBe(plaintext)
    expect(session.user.account.length).toBeLessThanOrEqual(64)
  })

  it('deletes a challenge before invoking a failing verification callback', async () => {
    const app = harness()
    vi.mocked(app.port.signInWithOtp).mockResolvedValue(otpResponse(app.verifyOtp))
    app.verifyOtp.mockResolvedValue({
      data: { session: null, user: null },
      error: { code: 'invalid_verification_code', detail: 'do not expose' },
    })
    const challenge = await app.service.sendOtp({
      intent: 'login', channel: 'phone', target: '18311032722',
    })

    await expect(app.service.verifyOtp({ challengeId: challenge.challengeId, code: '123456' }))
      .rejects.toEqual(toSafeAppError({ code: 'AUTH_INVALID_OTP' }))
    await expect(app.service.verifyOtp({ challengeId: challenge.challengeId, code: '123456' }))
      .rejects.toEqual(toSafeAppError({ code: 'AUTH_OTP_EXPIRED' }))
    expect(app.verifyOtp).toHaveBeenCalledTimes(1)
  })

  it('publishes only the latest concurrent out-of-order OTP send', async () => {
    const app = harness()
    const firstResponse = deferred<unknown>()
    const latestResponse = deferred<unknown>()
    const staleVerify = vi.fn<(input: { token: string }) => Promise<unknown>>()
    const latestVerify = vi.fn<(input: { token: string }) => Promise<unknown>>()
    vi.mocked(app.port.signInWithOtp).mockImplementation((input) => (
      'phone' in input ? firstResponse.promise : latestResponse.promise
    ))

    const firstSend = app.service.sendOtp({
      intent: 'login', channel: 'phone', target: '18311032722',
    })
    const latestSend = app.service.sendOtp({
      intent: 'login', channel: 'email', target: 'user@example.com',
    })
    latestResponse.resolve(otpResponse(latestVerify))
    const latestChallenge = await latestSend
    firstResponse.resolve(otpResponse(staleVerify))

    await expect(firstSend).rejects.toEqual(toSafeAppError({ code: 'AUTH_OTP_EXPIRED' }))
    latestVerify.mockResolvedValue(authResponse())
    await expect(app.service.verifyOtp({
      challengeId: latestChallenge.challengeId,
      code: '123456',
    })).resolves.toMatchObject({ user: { id: 'cloud_uid' } })
    expect(staleVerify).not.toHaveBeenCalled()
  })

  it('does not publish an OTP challenge when its send resolves after logout', async () => {
    const app = harness()
    const response = deferred<unknown>()
    vi.mocked(app.port.signInWithOtp).mockReturnValue(response.promise)
    vi.mocked(app.port.signOut).mockResolvedValue(undefined)

    const send = app.service.sendOtp({
      intent: 'login', channel: 'phone', target: '18311032722',
    })
    await expect(app.service.logout()).resolves.toBeUndefined()
    response.resolve(otpResponse(app.verifyOtp))

    await expect(send).rejects.toEqual(toSafeAppError({ code: 'AUTH_OTP_EXPIRED' }))
    await expect(app.service.verifyOtp({ challengeId: 'challenge_1', code: '123456' }))
      .rejects.toEqual(toSafeAppError({ code: 'AUTH_OTP_EXPIRED' }))
    expect(app.verifyOtp).not.toHaveBeenCalled()
  })

  it('persists the complete internal session only through AuthSecretStore', async () => {
    const app = harness()
    vi.mocked(app.port.signInWithPassword).mockResolvedValue(authResponse(cloudSession('Alice_1', {
      accessToken: 'sample-access-token',
      refreshToken: 'sample-refresh-token',
      expiresIn: 120,
    })))

    await app.service.loginWithPassword({ account: 'alice_1', password: 'password' })

    expect(app.secrets.set).toHaveBeenCalledTimes(1)
    const encryptedBoundaryValue = vi.mocked(app.secrets.set).mock.calls[0]?.[1]
    expect(JSON.parse(encryptedBoundaryValue ?? '')).toEqual({
      accessToken: 'sample-access-token',
      refreshToken: 'sample-refresh-token',
      expiresAt: NOW + 120_000,
      authenticatedAt: AUTHENTICATED_AT,
      user: {
        id: 'cloud_uid',
        account: 'Alice_1',
        profile: { displayName: 'Alice_1' },
      },
    })
    expect(encryptedBoundaryValue).not.toContain('password')
    expect(encryptedBoundaryValue).not.toContain('123456')
  })

  it('accepts and persists a real SDK in-memory session before reading stored credentials', async () => {
    const app = harness()
    app.stored.set(SESSION_KEY, storedSession())
    vi.mocked(app.port.getSession).mockResolvedValue(authResponse(cloudSession('Memory User', {
      refreshToken: 'memory-refresh-token',
    })))

    await expect(app.service.getSession()).resolves.toEqual({
      user: {
        id: 'cloud_uid',
        account: 'Memory User',
        profile: { displayName: 'Memory User' },
      },
      authenticatedAt: AUTHENTICATED_AT,
    })
    expect(app.secrets.get).not.toHaveBeenCalled()
    expect(JSON.parse(app.stored.get(SESSION_KEY) ?? '')).toMatchObject({
      refreshToken: 'memory-refresh-token',
      authenticatedAt: AUTHENTICATED_AT,
    })
  })

  it('rejects a current anonymous SDK session without restoring or persisting credentials', async () => {
    const app = harness()
    app.stored.set(SESSION_KEY, storedSession())
    vi.mocked(app.port.getSession).mockResolvedValue(authResponse(anonymousCloudSession()))

    await expect(app.service.getSession()).resolves.toBeNull()
    expect(app.secrets.delete).toHaveBeenCalledWith(SESSION_KEY)
    expect(app.stored.has(SESSION_KEY)).toBe(false)
    expect(app.secrets.set).not.toHaveBeenCalled()
    expect(app.port.setSession).not.toHaveBeenCalled()
    expect(app.port.refreshSession).not.toHaveBeenCalled()
  })

  it('restores an encrypted session with setSession and persists rotated tokens', async () => {
    const app = harness()
    app.stored.set(SESSION_KEY, storedSession())
    vi.mocked(app.port.getSession).mockResolvedValue(noSessionResponse())
    vi.mocked(app.port.setSession).mockResolvedValue(authResponse(cloudSession('Restored User', {
      accessToken: 'rotated-access-token',
      refreshToken: 'rotated-refresh-token',
    })))

    await expect(app.service.getSession()).resolves.toEqual({
      user: {
        id: 'cloud_uid',
        account: 'Restored User',
        profile: { displayName: 'Restored User' },
      },
      authenticatedAt: '2026-08-17T00:00:00.000Z',
    })
    expect(app.port.setSession).toHaveBeenCalledWith({
      access_token: 'stored-access-token',
      refresh_token: 'stored-refresh-token',
    })
    expect(app.port.refreshSession).not.toHaveBeenCalled()
    expect(JSON.parse(app.stored.get(SESSION_KEY) ?? '')).toEqual({
      accessToken: 'rotated-access-token',
      refreshToken: 'rotated-refresh-token',
      expiresAt: NOW + 3_600_000,
      authenticatedAt: '2026-08-17T00:00:00.000Z',
      user: {
        id: 'cloud_uid',
        account: 'Restored User',
        profile: { displayName: 'Restored User' },
      },
    })
  })

  it('restores with the encrypted public identity when the SDK user fields become functions', async () => {
    const app = harness()
    const session = cloudSession('Ignored Provider User', {
      accessToken: 'rotated-access-token',
      refreshToken: 'rotated-refresh-token',
    })
    app.stored.set(SESSION_KEY, storedSession())
    vi.mocked(app.port.getSession).mockResolvedValue(noSessionResponse())
    vi.mocked(app.port.setSession).mockResolvedValue(methodUserAuthResponse(session))

    await expect(app.service.getSession()).resolves.toEqual({
      user: { id: 'stored_uid', account: 'Stored User' },
      authenticatedAt: '2026-08-17T00:00:00.000Z',
    })
    expect(app.secrets.delete).not.toHaveBeenCalled()
    expect(JSON.parse(app.stored.get(SESSION_KEY) ?? '')).toMatchObject({
      accessToken: 'rotated-access-token',
      refreshToken: 'rotated-refresh-token',
      user: { id: 'stored_uid', account: 'Stored User' },
    })
  })

  it('uses the encrypted public identity when refreshSession returns function-valued user fields', async () => {
    const app = harness()
    const response = methodUserAuthResponse(cloudSession('Ignored Provider User', {
      accessToken: 'refreshed-access-token',
      refreshToken: 'rotated-refresh-token',
    }))
    app.stored.set(SESSION_KEY, storedSession({ expiresAt: NOW - 1 }))
    vi.mocked(app.port.getSession).mockResolvedValue(noSessionResponse())
    vi.mocked(app.port.refreshSession).mockResolvedValue(response)

    await expect(app.service.getSession()).resolves.toMatchObject({
      user: { id: 'stored_uid', account: 'Stored User' },
    })
    expect(app.port.refreshSession).toHaveBeenCalledWith('stored-refresh-token')
    expect(JSON.parse(app.stored.get(SESSION_KEY) ?? '')).toMatchObject({
      accessToken: 'refreshed-access-token',
      refreshToken: 'rotated-refresh-token',
      user: { id: 'stored_uid', account: 'Stored User' },
    })
  })

  it('reuses the restored public identity for a later malformed in-memory SDK session', async () => {
    const app = harness()
    const restoredResponse = methodUserAuthResponse()
    app.stored.set(SESSION_KEY, storedSession())
    vi.mocked(app.port.getSession)
      .mockResolvedValueOnce(noSessionResponse())
      .mockResolvedValueOnce(restoredResponse)
    vi.mocked(app.port.setSession).mockResolvedValue(restoredResponse)

    await expect(app.service.getSession()).resolves.toMatchObject({
      user: { id: 'stored_uid', account: 'Stored User' },
    })
    await expect(app.service.getSession()).resolves.toMatchObject({
      user: { id: 'stored_uid', account: 'Stored User' },
    })
    expect(app.secrets.get).toHaveBeenCalledOnce()
  })

  it('deletes encrypted credentials when restoration returns an anonymous session', async () => {
    const app = harness()
    app.stored.set(SESSION_KEY, storedSession())
    vi.mocked(app.port.getSession).mockResolvedValue(noSessionResponse())
    vi.mocked(app.port.setSession).mockResolvedValue(authResponse(anonymousCloudSession()))

    await expect(app.service.getSession()).resolves.toBeNull()
    expect(app.secrets.delete).toHaveBeenCalledWith(SESSION_KEY)
    expect(app.stored.has(SESSION_KEY)).toBe(false)
    expect(app.secrets.set).not.toHaveBeenCalled()
  })

  it.each([undefined, false] as const)(
    'accepts a restored session when is_anonymous is %s',
    async (isAnonymous) => {
      const app = harness()
      const session = cloudSession('Restored User')
      if (isAnonymous !== undefined) session.user.is_anonymous = isAnonymous
      app.stored.set(SESSION_KEY, storedSession())
      vi.mocked(app.port.getSession).mockResolvedValue(noSessionResponse())
      vi.mocked(app.port.setSession).mockResolvedValue(authResponse(session))

      await expect(app.service.getSession()).resolves.toMatchObject({
        user: { id: 'cloud_uid', account: 'Restored User' },
      })
    },
  )

  it('refreshes an expired encrypted session and persists its rotated refresh token', async () => {
    const app = harness()
    app.stored.set(SESSION_KEY, storedSession({ expiresAt: NOW - 1 }))
    vi.mocked(app.port.getSession).mockResolvedValue(noSessionResponse())
    vi.mocked(app.port.refreshSession).mockResolvedValue(authResponse(cloudSession('Refreshed User', {
      accessToken: 'refreshed-access-token',
      refreshToken: 'rotated-refresh-token',
    })))

    await expect(app.service.getSession()).resolves.toMatchObject({
      user: { account: 'Refreshed User' },
      authenticatedAt: '2026-08-17T00:00:00.000Z',
    })
    expect(app.port.refreshSession).toHaveBeenCalledWith('stored-refresh-token')
    expect(app.port.setSession).not.toHaveBeenCalled()
    expect(JSON.parse(app.stored.get(SESSION_KEY) ?? '')).toMatchObject({
      accessToken: 'refreshed-access-token',
      refreshToken: 'rotated-refresh-token',
    })
  })

  it('serializes concurrent session restore so rotated credentials cannot be deleted as stale', async () => {
    const app = harness()
    const restoreStarted = deferred<void>()
    const restoreResponse = deferred<unknown>()
    app.stored.set(SESSION_KEY, storedSession())
    vi.mocked(app.port.getSession)
      .mockResolvedValueOnce(noSessionResponse())
      .mockResolvedValueOnce(authResponse(cloudSession('Rotated User', {
        accessToken: 'rotated-access-token',
        refreshToken: 'rotated-refresh-token',
      })))
    vi.mocked(app.port.setSession).mockImplementation(() => {
      restoreStarted.resolve()
      return restoreResponse.promise
    })

    const first = app.service.getSession()
    await restoreStarted.promise
    const second = app.service.getSession()

    expect(app.port.getSession).toHaveBeenCalledTimes(1)
    restoreResponse.resolve(authResponse(cloudSession('Rotated User', {
      accessToken: 'rotated-access-token',
      refreshToken: 'rotated-refresh-token',
    })))
    await expect(first).resolves.toMatchObject({ user: { account: 'Rotated User' } })
    await expect(second).resolves.toMatchObject({ user: { account: 'Rotated User' } })
    expect(app.secrets.delete).not.toHaveBeenCalled()
    expect(JSON.parse(app.stored.get(SESSION_KEY) ?? '')).toMatchObject({
      accessToken: 'rotated-access-token',
      refreshToken: 'rotated-refresh-token',
    })
  })

  it.each([
    ['not-json'],
    [JSON.stringify({ accessToken: 'access-only' })],
  ])('deletes malformed stored credentials and returns null', async (serialized) => {
    const app = harness()
    app.stored.set(SESSION_KEY, serialized)
    vi.mocked(app.port.getSession).mockResolvedValue(noSessionResponse())

    await expect(app.service.getSession()).resolves.toBeNull()
    expect(app.secrets.delete).toHaveBeenCalledWith(SESSION_KEY)
    expect(app.stored.has(SESSION_KEY)).toBe(false)
    expect(app.port.setSession).not.toHaveBeenCalled()
    expect(app.port.refreshSession).not.toHaveBeenCalled()
  })

  it('deletes a legacy stored session before CloudBase can rotate its refresh token', async () => {
    const app = harness()
    app.stored.set(SESSION_KEY, JSON.stringify({
      accessToken: 'legacy-access-token',
      refreshToken: 'legacy-refresh-token',
      expiresAt: NOW + 60_000,
      authenticatedAt: '2026-08-17T00:00:00.000Z',
    }))
    vi.mocked(app.port.getSession).mockResolvedValue(noSessionResponse())

    await expect(app.service.getSession()).resolves.toBeNull()
    expect(app.secrets.delete).toHaveBeenCalledWith(SESSION_KEY)
    expect(app.port.setSession).not.toHaveBeenCalled()
    expect(app.port.refreshSession).not.toHaveBeenCalled()
  })

  it.each([
    [{ code: 'invalid_grant', message: 'invalid refresh token' }],
    [{ code: 'token_expired', message: 'refresh token expired' }],
    [{ code: 'user_not_found', message: 'user not found' }],
  ])('deletes provider-invalid credentials and returns null for %o', async (providerError) => {
    const app = harness()
    app.stored.set(SESSION_KEY, storedSession())
    vi.mocked(app.port.getSession).mockResolvedValue(noSessionResponse())
    vi.mocked(app.port.setSession).mockResolvedValue({
      data: { session: null, user: null }, error: providerError,
    })

    await expect(app.service.getSession()).resolves.toBeNull()
    expect(app.secrets.delete).toHaveBeenCalledWith(SESSION_KEY)
    expect(app.stored.has(SESSION_KEY)).toBe(false)
  })

  it('deletes a stored session after CloudBase reports its refresh token was already rotated', async () => {
    const app = harness()
    app.stored.set(SESSION_KEY, storedSession())
    vi.mocked(app.port.getSession).mockResolvedValue(noSessionResponse())
    vi.mocked(app.port.setSession).mockResolvedValue({
      data: { session: null, user: null },
      error: { code: 'unauthorized_client', message: 'refresh token has been refresh' },
    })

    await expect(app.service.getSession()).resolves.toBeNull()
    expect(app.secrets.delete).toHaveBeenCalledWith(SESSION_KEY)
    expect(app.stored.has(SESSION_KEY)).toBe(false)
  })

  it('preserves encrypted credentials when session restoration has an infrastructure error', async () => {
    const app = harness()
    const encryptedValue = storedSession()
    app.stored.set(SESSION_KEY, encryptedValue)
    vi.mocked(app.port.getSession).mockResolvedValue(noSessionResponse())
    vi.mocked(app.port.setSession).mockResolvedValue({
      data: { session: null, user: null },
      error: { code: 'NETWORK_ERROR', message: 'provider infrastructure detail' },
    })

    await expect(app.service.getSession()).rejects.toEqual(toSafeAppError({ code: 'INTERNAL_ERROR' }))
    expect(app.secrets.delete).not.toHaveBeenCalled()
    expect(app.stored.get(SESSION_KEY)).toBe(encryptedValue)
  })

  it('deletes credentials when the SDK throws an invalid-session error from memory', async () => {
    const app = harness()
    app.stored.set(SESSION_KEY, storedSession())
    vi.mocked(app.port.getSession).mockRejectedValue({
      code: 'invalid_grant', message: 'invalid refresh token',
    })

    await expect(app.service.getSession()).resolves.toBeNull()
    expect(app.secrets.delete).toHaveBeenCalledWith(SESSION_KEY)
    expect(app.stored.has(SESSION_KEY)).toBe(false)
  })

  it('preserves credentials when encrypted storage cannot be read', async () => {
    const app = harness()
    const encryptedValue = storedSession()
    app.stored.set(SESSION_KEY, encryptedValue)
    vi.mocked(app.port.getSession).mockResolvedValue(noSessionResponse())
    vi.mocked(app.secrets.get).mockRejectedValue(new Error('secure storage unavailable'))

    await expect(app.service.getSession()).rejects.toEqual(toSafeAppError({ code: 'INTERNAL_ERROR' }))
    expect(app.secrets.delete).not.toHaveBeenCalled()
    expect(app.stored.get(SESSION_KEY)).toBe(encryptedValue)
  })

  it.each([
    ['successful', undefined],
    ['already-signed-out', { data: null, error: { code: 'session_not_found', message: 'not signed in' } }],
  ] as const)('deletes encrypted credentials after %s logout', async (_state, response) => {
    const app = harness()
    app.stored.set(SESSION_KEY, storedSession())
    vi.mocked(app.port.signOut).mockResolvedValue(response)

    await expect(app.service.logout()).resolves.toBeUndefined()
    expect(app.secrets.delete).toHaveBeenCalledWith(SESSION_KEY)
    expect(app.stored.has(SESSION_KEY)).toBe(false)
  })

  it('clears the restored public identity cache after logout', async () => {
    const app = harness()
    const malformedResponse = methodUserAuthResponse()
    app.stored.set(SESSION_KEY, storedSession())
    vi.mocked(app.port.getSession)
      .mockResolvedValueOnce(noSessionResponse())
      .mockResolvedValueOnce(malformedResponse)
    vi.mocked(app.port.setSession).mockResolvedValue(malformedResponse)

    await expect(app.service.getSession()).resolves.toMatchObject({
      user: { id: 'stored_uid', account: 'Stored User' },
    })
    await expect(app.service.logout()).resolves.toBeUndefined()
    await expect(app.service.getSession()).rejects.toEqual(toSafeAppError({ code: 'INTERNAL_ERROR' }))
  })

  it('deletes encrypted credentials when signOut rejects because there is no session', async () => {
    const app = harness()
    app.stored.set(SESSION_KEY, storedSession())
    vi.mocked(app.port.signOut).mockRejectedValue({
      code: 'session_not_found', message: 'not signed in',
    })

    await expect(app.service.logout()).resolves.toBeUndefined()
    expect(app.secrets.delete).toHaveBeenCalledWith(SESSION_KEY)
    expect(app.stored.has(SESSION_KEY)).toBe(false)
  })

  it('maps synchronous secret deletion failures to a fixed internal error', async () => {
    const app = harness()
    const encryptedValue = storedSession()
    app.stored.set(SESSION_KEY, encryptedValue)
    vi.mocked(app.port.signOut).mockResolvedValue(undefined)
    vi.mocked(app.secrets.delete).mockImplementation(() => {
      throw new Error('raw secure storage detail')
    })

    await expect(app.service.logout()).rejects.toEqual(toSafeAppError({ code: 'INTERNAL_ERROR' }))
    expect(app.stored.get(SESSION_KEY)).toBe(encryptedValue)
  })

  it('preserves credentials and consumes pending challenges when logout fails', async () => {
    const app = harness()
    const encryptedValue = storedSession()
    app.stored.set(SESSION_KEY, encryptedValue)
    vi.mocked(app.port.signInWithOtp).mockResolvedValue(otpResponse(app.verifyOtp))
    const challenge = await app.service.sendOtp({
      intent: 'login', channel: 'email', target: 'user@example.com',
    })
    vi.mocked(app.port.signOut).mockResolvedValue({
      data: null,
      error: { code: 'NETWORK_ERROR', message: 'provider infrastructure detail' },
    })

    await expect(app.service.logout()).rejects.toEqual(toSafeAppError({ code: 'INTERNAL_ERROR' }))
    expect(app.secrets.delete).not.toHaveBeenCalled()
    expect(app.stored.get(SESSION_KEY)).toBe(encryptedValue)
    await expect(app.service.verifyOtp({ challengeId: challenge.challengeId, code: '123456' }))
      .rejects.toEqual(toSafeAppError({ code: 'AUTH_OTP_EXPIRED' }))
  })

  it('runs logout after an in-flight password login and removes its persisted session', async () => {
    const app = harness()
    const started = deferred<void>()
    const response = deferred<unknown>()
    vi.mocked(app.port.signInWithPassword).mockImplementation(() => {
      started.resolve()
      return response.promise
    })
    vi.mocked(app.port.signOut).mockResolvedValue(undefined)

    const login = app.service.loginWithPassword({ account: 'alice_1', password: 'password' })
    await started.promise
    const logout = app.service.logout()

    expect(app.port.signOut).not.toHaveBeenCalled()
    response.resolve(authResponse())
    await expect(login).resolves.toMatchObject({ user: { id: 'cloud_uid' } })
    await expect(logout).resolves.toBeUndefined()
    expect(app.stored.has(SESSION_KEY)).toBe(false)
    expect(vi.mocked(app.secrets.set).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(app.port.signOut).mock.invocationCallOrder[0] ?? 0)
  })

  it('runs logout after an in-flight OTP verification and removes its persisted session', async () => {
    const app = harness()
    const started = deferred<void>()
    const response = deferred<unknown>()
    vi.mocked(app.port.signInWithOtp).mockResolvedValue(otpResponse(app.verifyOtp))
    app.verifyOtp.mockImplementation(() => {
      started.resolve()
      return response.promise
    })
    vi.mocked(app.port.signOut).mockResolvedValue(undefined)
    const challenge = await app.service.sendOtp({
      intent: 'login', channel: 'phone', target: '18311032722',
    })

    const verification = app.service.verifyOtp({ challengeId: challenge.challengeId, code: '123456' })
    await started.promise
    const logout = app.service.logout()

    expect(app.port.signOut).not.toHaveBeenCalled()
    response.resolve(authResponse())
    await expect(verification).resolves.toMatchObject({ user: { id: 'cloud_uid' } })
    await expect(logout).resolves.toBeUndefined()
    expect(app.stored.has(SESSION_KEY)).toBe(false)
    expect(vi.mocked(app.secrets.set).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(app.port.signOut).mock.invocationCallOrder[0] ?? 0)
  })

  it('expires an OTP verification while it waits behind an earlier session operation', async () => {
    const app = harness()
    const blockerStarted = deferred<void>()
    const blockerResponse = deferred<unknown>()
    vi.mocked(app.port.signInWithOtp).mockResolvedValue(otpResponse(app.verifyOtp))
    vi.mocked(app.port.signInWithPassword).mockImplementation(() => {
      blockerStarted.resolve()
      return blockerResponse.promise
    })
    app.verifyOtp.mockResolvedValue(authResponse())
    const challenge = await app.service.sendOtp({
      intent: 'login', channel: 'phone', target: '18311032722',
    })
    const blocker = app.service.loginWithPassword({ account: 'alice_1', password: 'password' })
    await blockerStarted.promise

    const verification = app.service.verifyOtp({
      challengeId: challenge.challengeId,
      code: '123456',
    })
    app.advanceTime(300_000)
    blockerResponse.resolve(authResponse())

    await expect(blocker).resolves.toMatchObject({ user: { id: 'cloud_uid' } })
    await expect(verification).rejects.toEqual(toSafeAppError({ code: 'AUTH_OTP_EXPIRED' }))
    expect(app.verifyOtp).not.toHaveBeenCalled()
  })

  it('requires a real CloudBase session', async () => {
    const app = harness()
    vi.mocked(app.port.getSession).mockResolvedValue(noSessionResponse())

    await expect(app.service.requireSession())
      .rejects.toEqual(toSafeAppError({ code: 'AUTH_REQUIRED' }))
  })
})
