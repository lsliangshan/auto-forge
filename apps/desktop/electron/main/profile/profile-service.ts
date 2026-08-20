import {
  toSafeAppError,
  userProfileSchema,
  userProfileUpdateSchema,
  type AuthUser,
  type UserProfile,
  type UserProfileUpdate,
} from '@autoforge/shared'
import type { AuthService } from '../auth/auth-service.js'
import type { UserProfileRecord, UserProfileRepository } from '../database/user-profile-repository.js'

export interface ProfileServiceDependencies {
  now(): number
  today(): string
}

function optional(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

function normalizeProfileInput(input: UserProfileUpdate): UserProfileUpdate {
  return {
    ...(input.avatarUrl === undefined ? {} : { avatarUrl: input.avatarUrl }),
    ...(optional(input.displayName) ? { displayName: optional(input.displayName) } : {}),
    ...(input.gender === undefined ? {} : { gender: input.gender }),
    ...(optional(input.birthDate) ? { birthDate: optional(input.birthDate) } : {}),
    ...(optional(input.email) ? { email: optional(input.email) } : {}),
    ...(optional(input.phone?.replace(/[ -]/g, ''))
      ? { phone: optional(input.phone?.replace(/[ -]/g, '')) }
      : {}),
  }
}

function validBirthDate(value: string | undefined, today: string): boolean {
  if (value === undefined) return true
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year
    && date.getMonth() === month - 1
    && date.getDate() === day
    && value <= today
}

function composeProfile(user: AuthUser, record?: UserProfileRecord): UserProfile {
  return userProfileSchema.parse({
    userId: user.id,
    account: user.account,
    ...(record?.avatarUrl ? { avatarUrl: record.avatarUrl } : {}),
    ...(record?.displayName ? { displayName: record.displayName } : {}),
    ...(record?.gender ? { gender: record.gender } : {}),
    ...(record?.birthDate ? { birthDate: record.birthDate } : {}),
    ...(record?.email ? { email: record.email } : {}),
    ...(record?.phone ? { phone: record.phone } : {}),
    ...(record ? { updatedAt: new Date(record.updatedAt).toISOString() } : {}),
  })
}

export class ProfileService {
  constructor(
    private readonly auth: Pick<AuthService, 'requireSession'>,
    private readonly repository: UserProfileRepository,
    private readonly dependencies: ProfileServiceDependencies = {
      now: Date.now,
      today: () => {
        const now = new Date()
        const year = String(now.getFullYear()).padStart(4, '0')
        const month = String(now.getMonth() + 1).padStart(2, '0')
        const day = String(now.getDate()).padStart(2, '0')
        return `${year}-${month}-${day}`
      },
    },
  ) {}

  async get(): Promise<UserProfile> {
    const session = await this.auth.requireSession()
    return composeProfile(session.user, this.repository.findByUserId(session.user.id))
  }

  async update(input: UserProfileUpdate): Promise<UserProfile> {
    const session = await this.auth.requireSession()
    const parsed = userProfileUpdateSchema.safeParse(normalizeProfileInput(input))
    if (!parsed.success || !validBirthDate(parsed.data.birthDate, this.dependencies.today())) {
      throw toSafeAppError({ code: 'INVALID_INPUT' })
    }
    const stored = this.repository.upsert({
      userId: session.user.id,
      avatarUrl: parsed.data.avatarUrl ?? null,
      displayName: parsed.data.displayName ?? null,
      gender: parsed.data.gender ?? null,
      birthDate: parsed.data.birthDate ?? null,
      email: parsed.data.email ?? null,
      phone: parsed.data.phone ?? null,
      updatedAt: this.dependencies.now(),
    })
    return composeProfile(session.user, stored)
  }
}
