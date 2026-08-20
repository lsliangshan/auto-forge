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

function storedSession(overrides: Partial<{
  accessToken: string
  refreshToken: string
  expiresAt: number
  authenticatedAt: string
}> = {}) {
  return JSON.stringify({
    accessToken: 'stored-access-token',
    refreshToken: 'stored-refresh-token',
    expiresAt: NOW + 60_000,
    authenticatedAt: '2026-08-17T00:00:00.000Z',
    ...overrides,
  })
}

function harness() {
  const port: CloudBaseAuthPort = {
    signInWithOtp: vi.fn(),
    signUp: vi.fn(),
    signInWithPassword: vi.fn(),
    getSession: vi.fn(),
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
    [{ user_metadata: { nickname: ' Metadata Nick ' }, username: 'username' }, 'Metadata Nick'],
    [{ nickName: ' Camel Nick ', username: 'username' }, 'Camel Nick'],
    [{ username: ' normalized_user ', name: 'Friendly Name' }, 'normalized_user'],
    [{ name: ' Friendly Name ' }, 'Friendly Name'],
  ] as const)('uses the first safe display field from %o', async (user, expected) => {
    const app = harness()
    vi.mocked(app.port.signInWithPassword).mockResolvedValue(authResponse(cloudSessionForUser(user)))

    await expect(app.service.loginWithPassword({
      account: 'alice_1', password: 'password',
    })).resolves.toMatchObject({ user: { account: expected } })
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
      user: { id: 'cloud_uid', account: 'Memory User' },
      authenticatedAt: AUTHENTICATED_AT,
    })
    expect(app.secrets.get).not.toHaveBeenCalled()
    expect(JSON.parse(app.stored.get(SESSION_KEY) ?? '')).toMatchObject({
      refreshToken: 'memory-refresh-token',
      authenticatedAt: AUTHENTICATED_AT,
    })
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
      user: { id: 'cloud_uid', account: 'Restored User' },
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
    })
  })

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

  it('requires a real CloudBase session', async () => {
    const app = harness()
    vi.mocked(app.port.getSession).mockResolvedValue(noSessionResponse())

    await expect(app.service.requireSession())
      .rejects.toEqual(toSafeAppError({ code: 'AUTH_REQUIRED' }))
  })
})
