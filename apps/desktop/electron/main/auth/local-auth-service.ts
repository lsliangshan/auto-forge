import { randomUUID } from 'node:crypto'
import {
  authCredentialsSchema,
  toSafeAppError,
  type AppError,
  type AuthCredentials,
  type AuthSession,
} from '@autoforge/shared'
import type { LocalAuthRepository, LocalAuthSessionRecord } from '../database/local-auth-repository.js'
import { ScryptPasswordHasher, type PasswordHasher } from './password-hasher.js'

export interface AuthService {
  getSession(): Promise<AuthSession | null>
  login(input: AuthCredentials): Promise<AuthSession>
  register(input: AuthCredentials): Promise<AuthSession>
  logout(): Promise<void>
  requireSession(): Promise<AuthSession>
}

interface LocalAuthDependencies {
  hasher: PasswordHasher
  createId(): string
  now(): number
}

function failure(code: AppError['code']): AppError {
  return toSafeAppError({ code })
}

function session(record: LocalAuthSessionRecord): AuthSession {
  return {
    user: record.user,
    authenticatedAt: new Date(record.authenticatedAt).toISOString(),
  }
}

export class LocalAuthService implements AuthService {
  constructor(
    private readonly repository: LocalAuthRepository,
    private readonly dependencies: LocalAuthDependencies = {
      hasher: new ScryptPasswordHasher(),
      createId: randomUUID,
      now: Date.now,
    },
  ) {}

  async getSession(): Promise<AuthSession | null> {
    const current = this.repository.getCurrentSession()
    return current ? session(current) : null
  }

  async login(input: AuthCredentials): Promise<AuthSession> {
    const parsed = authCredentialsSchema.safeParse(input)
    if (!parsed.success) throw failure('INVALID_INPUT')
    const accountNormalized = parsed.data.account.toLowerCase()
    const user = this.repository.findUserByNormalizedAccount(accountNormalized)
    const valid = await this.dependencies.hasher.verify(parsed.data.password, user?.passwordDigest)
    if (!user || !valid) throw failure('AUTH_INVALID_CREDENTIALS')
    return session(this.repository.replaceSession(user.id, this.dependencies.now()))
  }

  async register(input: AuthCredentials): Promise<AuthSession> {
    const parsed = authCredentialsSchema.safeParse(input)
    if (!parsed.success) throw failure('INVALID_INPUT')
    const timestamp = this.dependencies.now()
    const created = this.repository.createUserAndSession({
      id: this.dependencies.createId(),
      account: parsed.data.account,
      accountNormalized: parsed.data.account.toLowerCase(),
      passwordDigest: await this.dependencies.hasher.hash(parsed.data.password),
      createdAt: timestamp,
      updatedAt: timestamp,
    }, timestamp)
    if (!created) throw failure('AUTH_ACCOUNT_EXISTS')
    return session(created)
  }

  async logout(): Promise<void> {
    this.repository.clearSession()
  }

  async requireSession(): Promise<AuthSession> {
    const current = await this.getSession()
    if (!current) throw failure('AUTH_REQUIRED')
    return current
  }

  isAuthenticated(): boolean {
    return this.repository.getCurrentSession() !== undefined
  }
}
