import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  authCredentialsSchema,
  authOtpRequestSchema,
  authOtpVerificationSchema,
  authUserSchema,
  toSafeAppError,
  userProfileUpdateSchema,
  type AppError,
  type AuthCredentials,
  type AuthOtpChallenge,
  type AuthOtpRequest,
  type AuthOtpVerification,
  type AuthSession,
  type AuthUser,
  type AuthUserProfileSnapshot,
} from '@autoforge/shared'
import type { AuthSecretStore, AuthService, AuthUserProfileUpdate } from './auth-service.js'
import {
  cloudBaseOtpTarget,
  cloudBasePasswordCredentials,
  type CloudBaseAuthPort,
} from './cloudbase-auth-port.js'

const SESSION_KEY = 'cloudbase_auth_session'
const CHALLENGE_TTL_MS = 300_000

interface PendingChallenge {
  verifyOtp(input: { token: string }): Promise<unknown>
  intent: AuthOtpRequest['intent']
  expiresAt: number
}

interface CloudBaseSession {
  accessToken: string
  refreshToken: string
  expiresIn: number
  user: AuthUser
}

interface StoredCloudBaseSession {
  accessToken: string
  refreshToken: string
  expiresAt: number
  authenticatedAt: string
  user: AuthUser
}

interface CloudBaseAuthDependencies {
  createId(): string
  now(): number
}

const storedCloudBaseSessionSchema: z.ZodType<StoredCloudBaseSession> = z.object({
  accessToken: z.string().trim().min(1),
  refreshToken: z.string().trim().min(1),
  expiresAt: z.number().finite().positive(),
  authenticatedAt: z.string().datetime(),
  user: authUserSchema,
}).strict()

const cloudBaseProfileUpdateSchema = userProfileUpdateSchema.pick({
  displayName: true,
  avatarUrl: true,
  gender: true,
})
const providerEmailSchema = z.string().email().max(254)
const providerPhoneSchema = z.string().regex(/^\+?\d{6,20}$/)

function failure(code: AppError['code']): AppError {
  return toSafeAppError({ code })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stableErrorText(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined
  return [error.code, error.message]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
}

function providerFailure(error: unknown): AppError {
  const fields = stableErrorText(error)
  if (fields === undefined) return failure('INTERNAL_ERROR')

  if (/(?:rate.?limit|too many)/.test(fields)) {
    return failure('AUTH_OTP_RATE_LIMITED')
  }
  if (/(?:verification|otp).*expired/.test(fields)) {
    return failure('AUTH_OTP_EXPIRED')
  }
  if (/(?:invalid).*(?:verification code|otp)|(?:verification code|otp).*invalid/.test(fields)) {
    return failure('AUTH_INVALID_OTP')
  }
  if (/(?:already exists|already registered)/.test(fields)) {
    return failure('AUTH_ACCOUNT_EXISTS')
  }
  if (/(?:user|account).*not found/.test(fields)) {
    return failure('AUTH_ACCOUNT_NOT_FOUND')
  }
  if (/(?:invalid).*(?:username or password|credentials)/.test(fields)) {
    return failure('AUTH_INVALID_CREDENTIALS')
  }
  if (/(?:invalid grant|invalid refresh token|refresh token not found|credentials not found)/.test(fields)) {
    return failure('AUTH_INVALID_CREDENTIALS')
  }
  return failure('INTERNAL_ERROR')
}

function responseError(response: unknown): unknown | undefined {
  return isRecord(response) && response.error !== null ? response.error : undefined
}

function isAnonymousSession(response: unknown): boolean {
  if (!isRecord(response) || !isRecord(response.data)) return false
  const sessionUser = isRecord(response.data.session) && isRecord(response.data.session.user)
    ? response.data.session.user
    : undefined
  const responseUser = isRecord(response.data.user) ? response.data.user : undefined
  return sessionUser?.is_anonymous === true || responseUser?.is_anonymous === true
}

function invalidStoredCredentials(error: unknown): boolean {
  const fields = stableErrorText(error)
  return fields !== undefined
    && /(?:invalid grant|invalid refresh token|refresh token not found|credentials not found|token expired|session expired|invalid credentials|user not found|unauthorized client.*refresh token.*(?:has been refresh|already (?:used|rotated)))/.test(fields)
}

function alreadySignedOut(error: unknown): boolean {
  const fields = stableErrorText(error)
  return fields !== undefined
    && /(?:not signed in|not authenticated|no session|session not found)/.test(fields)
}

function verifyOtpCallback(response: unknown): PendingChallenge['verifyOtp'] {
  if (!isRecord(response)) throw failure('INTERNAL_ERROR')
  if (response.error !== null) throw providerFailure(response.error)
  if (!isRecord(response.data)) throw failure('INTERNAL_ERROR')
  const data = response.data
  if (typeof data.verifyOtp !== 'function') throw failure('INTERNAL_ERROR')
  const verifyOtp = data.verifyOtp
  return (input) => verifyOtp.call(data, input) as Promise<unknown>
}

function providerText(
  fields: Array<{ source: Record<string, unknown> | undefined; key: string }>,
): string | null | undefined {
  for (const { source, key } of fields) {
    if (!source || !Object.prototype.hasOwnProperty.call(source, key)) continue
    const value = source[key]
    if (value === null) return null
    if (typeof value !== 'string') continue
    const normalized = value.trim()
    return normalized.length > 0 ? normalized : null
  }
  return undefined
}

function safeAccount(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined
  const bounded = Array.from(value).slice(0, 64).join('')
  return bounded.length > 0 ? bounded : undefined
}

function safeDisplayName(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value
  return Array.from(value).length <= 50 ? value : undefined
}

function safeAvatarUrl(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:'
      && parsed.username === ''
      && parsed.password === ''
      && parsed.port === ''
      && parsed.hash === ''
      && parsed.href === value
      ? value
      : undefined
  } catch {
    return undefined
  }
}

function safeGender(value: string | null | undefined): AuthUserProfileSnapshot['gender'] {
  if (value === undefined || value === null) return value
  const normalized = value.trim().toUpperCase().replaceAll('-', '_')
  const genders = {
    MALE: 'male',
    FEMALE: 'female',
    OTHER: 'other',
    PREFER_NOT_TO_SAY: 'prefer_not_to_say',
  } as const
  return genders[normalized as keyof typeof genders]
}

function cloudBaseGender(
  value: NonNullable<AuthUserProfileUpdate['gender']>,
): 'MALE' | 'FEMALE' | 'OTHER' | 'PREFER_NOT_TO_SAY' {
  const genders = {
    male: 'MALE',
    female: 'FEMALE',
    other: 'OTHER',
    prefer_not_to_say: 'PREFER_NOT_TO_SAY',
  } as const
  return genders[value]
}

function domesticPhone(value: string): string | undefined {
  const compact = value.replace(/\s+/g, '')
  const normalized = compact.startsWith('+86') ? compact.slice(3) : compact
  return safeAccount(normalized)
}

function maskEmail(value: string): string | undefined {
  const normalized = value.trim()
  const at = normalized.lastIndexOf('@')
  if (at <= 0 || at === normalized.length - 1) return undefined
  return safeAccount(`${normalized[0]}***${normalized.slice(at)}`)
}

function providerUser(value: Record<string, unknown>, fallback?: AuthUser): AuthUser {
  if (typeof value.id !== 'string' || value.id.trim().length === 0) {
    if (fallback) return fallback
    throw failure('INTERNAL_ERROR')
  }
  const id = value.id.trim()
  const metadata = isRecord(value.user_metadata) ? value.user_metadata : undefined
  const username = providerText([
    { source: metadata, key: 'username' },
    { source: value, key: 'username' },
  ])
  const displayName = safeDisplayName(providerText([
    { source: metadata, key: 'nickname' },
    { source: metadata, key: 'nickName' },
    { source: value, key: 'nickName' },
    { source: metadata, key: 'name' },
    { source: value, key: 'name' },
  ]))
  const account = safeAccount(username)
    ?? fallback?.account
    ?? safeAccount(displayName)
    ?? (typeof value.phone === 'string' ? domesticPhone(value.phone) : undefined)
    ?? (typeof value.email === 'string' ? maskEmail(value.email) : undefined)
  if (!account) throw failure('INTERNAL_ERROR')

  const avatarUrl = safeAvatarUrl(providerText([
    { source: metadata, key: 'avatarUrl' },
    { source: metadata, key: 'avatar_url' },
    { source: metadata, key: 'picture' },
    { source: value, key: 'avatarUrl' },
    { source: value, key: 'avatar_url' },
    { source: value, key: 'picture' },
  ]))
  const gender = safeGender(providerText([
    { source: metadata, key: 'gender' },
    { source: value, key: 'gender' },
  ]))
  const emailValue = providerText([{ source: value, key: 'email' }])
  const emailConfirmed = safeAccount(providerText([
    { source: value, key: 'email_confirmed_at' },
  ]))
  const email = emailValue === null
    ? null
    : emailValue !== undefined && emailConfirmed && providerEmailSchema.safeParse(emailValue).success
      ? emailValue
      : undefined
  const phoneValue = providerText([{ source: value, key: 'phone' }])
  const phoneConfirmed = safeAccount(providerText([
    { source: value, key: 'phone_confirmed_at' },
  ]))
  const phone = phoneValue === null
    ? null
    : phoneValue !== undefined && phoneConfirmed && providerPhoneSchema.safeParse(phoneValue).success
      ? phoneValue
      : undefined
  const providedProfile = {
    ...(displayName !== undefined ? { displayName } : {}),
    ...(avatarUrl !== undefined ? { avatarUrl } : {}),
    ...(gender !== undefined ? { gender } : {}),
    ...(email !== undefined ? { email } : {}),
    ...(phone !== undefined ? { phone } : {}),
  }
  const profile = { ...fallback?.profile, ...providedProfile }
  return authUserSchema.parse({
    id,
    account,
    ...(Object.keys(profile).length > 0 ? { profile } : {}),
  })
}

function optionalCloudBaseUserResponse(response: unknown, fallback?: AuthUser): AuthUser | undefined {
  if (!isRecord(response)) throw failure('INTERNAL_ERROR')
  if (response.error !== null) throw providerFailure(response.error)
  if (!isRecord(response.data) || !isRecord(response.data.user)) return undefined
  if (response.data.user.is_anonymous === true) throw failure('INTERNAL_ERROR')
  return providerUser(response.data.user, fallback)
}

function cloudBaseUserResponse(response: unknown, fallback?: AuthUser): AuthUser {
  const user = optionalCloudBaseUserResponse(response, fallback)
  if (!user) throw failure('INTERNAL_ERROR')
  return user
}

function cloudBaseSession(
  response: unknown,
  allowMissing = false,
  fallbackUser?: AuthUser,
): CloudBaseSession | null {
  if (!isRecord(response)) throw failure('INTERNAL_ERROR')
  if (response.error !== null) throw providerFailure(response.error)
  if (!isRecord(response.data)) throw failure('INTERNAL_ERROR')
  if (isAnonymousSession(response)) throw failure('INTERNAL_ERROR')
  const { session, user } = response.data
  if (allowMissing && session === null && user === null) return null
  if (!isRecord(session)
    || typeof session.access_token !== 'string'
    || session.access_token.trim().length === 0
    || typeof session.refresh_token !== 'string'
    || session.refresh_token.trim().length === 0
    || typeof session.expires_in !== 'number'
    || !Number.isFinite(session.expires_in)
    || !Number.isSafeInteger(session.expires_in)
    || session.expires_in <= 0) {
    throw failure('INTERNAL_ERROR')
  }
  const providerRecord: (Record<string, unknown> & { id: string }) | undefined =
    isRecord(user) && typeof user.id === 'string' && user.id.trim().length > 0
    ? { ...user, id: user.id.trim() }
    : undefined
  if (providerRecord === undefined && fallbackUser === undefined) {
    throw failure('INTERNAL_ERROR')
  }
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresIn: session.expires_in,
    user: providerRecord ? providerUser(providerRecord, fallbackUser) : fallbackUser!,
  }
}

function parseStoredSession(value: string): StoredCloudBaseSession | undefined {
  try {
    const decoded: unknown = JSON.parse(value)
    const parsed = storedCloudBaseSessionSchema.safeParse(decoded)
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

function publicSession(session: CloudBaseSession, authenticatedAt: string): AuthSession {
  return {
    user: session.user,
    authenticatedAt,
  }
}

export class CloudBaseAuthService implements AuthService {
  private readonly challenges = new Map<string, PendingChallenge>()
  private challengeGeneration = 0
  private sessionOperationTail: Promise<void> = Promise.resolve()
  private sessionUser: AuthUser | undefined
  private sessionDiscarded = false
  constructor(
    private readonly auth: CloudBaseAuthPort,
    private readonly secrets: AuthSecretStore,
    private readonly dependencies: CloudBaseAuthDependencies = {
      createId: randomUUID,
      now: Date.now,
    },
  ) {}

  async sendOtp(input: AuthOtpRequest): Promise<AuthOtpChallenge> {
    const parsed = authOtpRequestSchema.safeParse(input)
    if (!parsed.success) throw failure('INVALID_INPUT')
    const generation = ++this.challengeGeneration
    this.challenges.clear()

    const target = cloudBaseOtpTarget(parsed.data.channel, parsed.data.target)
    let response: unknown
    try {
      response = parsed.data.intent === 'login'
        ? await this.auth.signInWithOtp({ ...target, options: { shouldCreateUser: false } })
        : await this.auth.signUp({
            ...target,
            username: parsed.data.account.toLowerCase(),
            password: parsed.data.password,
            nickname: parsed.data.account,
          })
    } catch (error) {
      if (generation !== this.challengeGeneration) throw failure('AUTH_OTP_EXPIRED')
      throw providerFailure(error)
    }

    if (generation !== this.challengeGeneration) throw failure('AUTH_OTP_EXPIRED')

    const challengeId = this.dependencies.createId()
    this.challenges.set(challengeId, {
      verifyOtp: verifyOtpCallback(response),
      intent: parsed.data.intent,
      expiresAt: this.dependencies.now() + CHALLENGE_TTL_MS,
    })
    return { challengeId, expiresIn: CHALLENGE_TTL_MS / 1_000 }
  }

  async verifyOtp(input: AuthOtpVerification): Promise<AuthSession> {
    const parsed = authOtpVerificationSchema.safeParse(input)
    if (!parsed.success) throw failure('INVALID_INPUT')
    const challenge = this.challenges.get(parsed.data.challengeId)
    if (!challenge || this.dependencies.now() >= challenge.expiresAt) {
      this.challenges.delete(parsed.data.challengeId)
      throw failure('AUTH_OTP_EXPIRED')
    }
    this.challenges.delete(parsed.data.challengeId)

    return this.runSessionOperation(async () => {
      if (this.dependencies.now() >= challenge.expiresAt) throw failure('AUTH_OTP_EXPIRED')
      let response: unknown
      try {
        response = await challenge.verifyOtp({ token: parsed.data.code })
      } catch (error) {
        throw providerFailure(error)
      }
      const session = cloudBaseSession(response)
      if (!session) throw failure('INTERNAL_ERROR')
      return this.persist(session, new Date(this.dependencies.now()).toISOString())
    })
  }

  async cancelOtp(challengeId: string): Promise<void> {
    const parsed = authOtpVerificationSchema.shape.challengeId.safeParse(challengeId)
    if (!parsed.success) throw failure('INVALID_INPUT')
    this.challenges.delete(parsed.data)
  }

  async loginWithPassword(input: AuthCredentials): Promise<AuthSession> {
    const parsed = authCredentialsSchema.safeParse(input)
    if (!parsed.success) throw failure('INVALID_INPUT')
    return this.runSessionOperation(async () => {
      let response: unknown
      try {
        response = await this.auth.signInWithPassword(cloudBasePasswordCredentials(parsed.data))
      } catch (error) {
        throw providerFailure(error)
      }
      const session = cloudBaseSession(response)
      if (!session) throw failure('INTERNAL_ERROR')
      return this.persist(session, new Date(this.dependencies.now()).toISOString())
    })
  }

  async getSession(): Promise<AuthSession | null> {
    return this.runSessionOperation(() => this.getSessionWithoutLock())
  }

  private async getSessionWithoutLock(): Promise<AuthSession | null> {
    if (this.sessionDiscarded) return null

    let currentResponse: unknown
    try {
      currentResponse = await this.auth.getSession()
    } catch (error) {
      if (invalidStoredCredentials(error)) {
        this.deleteStoredSession()
        return null
      }
      throw providerFailure(error)
    }

    const currentError = responseError(currentResponse)
    if (currentError !== undefined) {
      if (invalidStoredCredentials(currentError)) {
        this.deleteStoredSession()
        return null
      }
      throw providerFailure(currentError)
    }
    if (isAnonymousSession(currentResponse)) {
      this.deleteStoredSession()
      return null
    }
    const current = cloudBaseSession(currentResponse, true, this.sessionUser)
    if (current) {
      return this.persist(current, new Date(this.dependencies.now()).toISOString())
    }

    let serialized: string | undefined
    try {
      serialized = await this.secrets.get(SESSION_KEY)
    } catch {
      throw failure('INTERNAL_ERROR')
    }
    if (serialized === undefined) return null
    const stored = parseStoredSession(serialized)
    if (!stored) {
      this.deleteStoredSession()
      return null
    }

    let restoredResponse: unknown
    try {
      restoredResponse = stored.expiresAt <= this.dependencies.now()
        ? await this.auth.refreshSession(stored.refreshToken)
        : await this.auth.setSession({
            access_token: stored.accessToken,
            refresh_token: stored.refreshToken,
          })
    } catch (error) {
      if (invalidStoredCredentials(error)) {
        this.deleteStoredSession()
        return null
      }
      throw providerFailure(error)
    }

    const restoreError = responseError(restoredResponse)
    if (restoreError !== undefined) {
      if (invalidStoredCredentials(restoreError)) {
        this.deleteStoredSession()
        return null
      }
      throw providerFailure(restoreError)
    }
    if (isAnonymousSession(restoredResponse)) {
      this.deleteStoredSession()
      return null
    }
    const restored = cloudBaseSession(restoredResponse, true, stored.user)
    if (!restored) {
      this.deleteStoredSession()
      return null
    }
    return this.persist(restored, stored.authenticatedAt)
  }

  async logout(): Promise<void> {
    this.challengeGeneration++
    this.challenges.clear()
    return this.runSessionOperation(async () => {
      let response: unknown
      try {
        response = await this.auth.signOut()
      } catch (error) {
        if (!alreadySignedOut(error)) throw failure('INTERNAL_ERROR')
      }
      const error = responseError(response)
      if (error !== undefined && !alreadySignedOut(error)) throw failure('INTERNAL_ERROR')
      this.deleteStoredSession()
    })
  }

  async updateUserProfile(input: AuthUserProfileUpdate): Promise<AuthUser> {
    const parsed = cloudBaseProfileUpdateSchema.safeParse(input)
    if (!parsed.success) throw failure('INVALID_INPUT')

    return this.runSessionOperation(async () => {
      if (this.sessionDiscarded || !this.sessionUser) throw failure('AUTH_REQUIRED')
      if (Object.keys(parsed.data).length === 0) return this.sessionUser

      const response = await this.updateProviderUser(parsed.data)
      const user = await this.resolveUpdatedUser(response, this.sessionUser)
      await this.persistUser(user)
      return user
    })
  }

  async discardSession(): Promise<void> {
    this.challengeGeneration++
    this.challenges.clear()
    return this.runSessionOperation(async () => {
      this.sessionDiscarded = true
      this.deleteStoredSession()
      try {
        await this.auth.signOut()
      } catch {
        return
      }
    })
  }

  async requireSession(): Promise<AuthSession> {
    const session = await this.getSession()
    if (!session) throw failure('AUTH_REQUIRED')
    return session
  }

  private async persist(session: CloudBaseSession, authenticatedAt: string): Promise<AuthSession> {
    const result = publicSession(session, authenticatedAt)
    const stored: StoredCloudBaseSession = {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: this.dependencies.now() + session.expiresIn * 1_000,
      authenticatedAt,
      user: result.user,
    }
    try {
      await this.secrets.set(SESSION_KEY, JSON.stringify(stored))
    } catch {
      throw failure('INTERNAL_ERROR')
    }
    this.sessionUser = result.user
    this.sessionDiscarded = false
    return result
  }

  private async updateProviderUser(input: AuthUserProfileUpdate): Promise<unknown> {
    try {
      return await this.auth.updateUser({
        ...(input.displayName !== undefined ? { nickname: input.displayName } : {}),
        ...(input.avatarUrl !== undefined ? { avatar_url: input.avatarUrl } : {}),
        ...(input.gender !== undefined ? { gender: cloudBaseGender(input.gender) } : {}),
      })
    } catch (error) {
      throw providerFailure(error)
    }
  }

  private async resolveUpdatedUser(response: unknown, fallback: AuthUser): Promise<AuthUser> {
    const updated = optionalCloudBaseUserResponse(response, fallback)
    if (updated) return updated

    const refreshed = optionalCloudBaseUserResponse(
      await this.callProviderUser(() => this.auth.refreshUser()),
      fallback,
    )
    if (refreshed) return refreshed
    return cloudBaseUserResponse(
      await this.callProviderUser(() => this.auth.getUser()),
      fallback,
    )
  }

  private async callProviderUser(operation: () => Promise<unknown>): Promise<unknown> {
    try {
      return await operation()
    } catch (error) {
      throw providerFailure(error)
    }
  }

  private async persistUser(user: AuthUser): Promise<void> {
    let serialized: string | undefined
    try {
      serialized = await this.secrets.get(SESSION_KEY)
    } catch {
      throw failure('INTERNAL_ERROR')
    }
    if (serialized === undefined) throw failure('AUTH_REQUIRED')
    const stored = parseStoredSession(serialized)
    if (!stored) {
      this.deleteStoredSession()
      throw failure('AUTH_REQUIRED')
    }
    try {
      await this.secrets.set(SESSION_KEY, JSON.stringify({ ...stored, user }))
    } catch {
      throw failure('INTERNAL_ERROR')
    }
    this.sessionUser = user
  }

  private runSessionOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.sessionOperationTail.then(operation)
    this.sessionOperationTail = result.then(() => undefined, () => undefined)
    return result
  }

  private deleteStoredSession(): void {
    try {
      this.secrets.delete(SESSION_KEY)
    } catch {
      throw failure('INTERNAL_ERROR')
    }
    this.sessionUser = undefined
  }
}
