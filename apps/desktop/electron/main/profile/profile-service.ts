import {
  toSafeAppError,
  userProfileSchema,
  userProfileUpdateSchema,
  type AuthUser,
  type UserProfile,
  type UserProfileUpdate,
} from '@autoforge/shared'
import type { AuthService } from '../auth/auth-service.js'
import type { AuthUserProfileUpdate } from '../auth/auth-service.js'
import type { UserProfileRecord, UserProfileRepository } from '../database/user-profile-repository.js'

export interface ProfileServiceDependencies {
  now(): number
  today(): string
}

function normalizeProfileInput(input: UserProfileUpdate): UserProfileUpdate {
  return {
    ...(input.avatarUrl === undefined ? {} : { avatarUrl: input.avatarUrl }),
    ...(input.displayName === undefined ? {} : { displayName: input.displayName.trim() }),
    ...(input.gender === undefined ? {} : { gender: input.gender }),
    ...(input.birthDate === undefined ? {} : { birthDate: input.birthDate.trim() }),
  }
}

function validBirthDate(value: string | undefined, today: string): boolean {
  if (value === undefined || value === '') return true
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

function mergeCloudField<T>(value: T | null | undefined, stored: T | null | undefined): T | null {
  return value === undefined ? stored ?? null : value
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
    private readonly auth: Pick<AuthService, 'requireSession' | 'updateUserProfile'>,
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
    const existing = this.repository.findByUserId(session.user.id)
    const cloudInput: AuthUserProfileUpdate = {
      ...(parsed.data.avatarUrl === undefined ? {} : { avatarUrl: parsed.data.avatarUrl }),
      ...(parsed.data.displayName === undefined ? {} : { displayName: parsed.data.displayName }),
      ...(parsed.data.gender === undefined ? {} : { gender: parsed.data.gender }),
    }
    let user = session.user
    if (Object.keys(cloudInput).length > 0) {
      try {
        user = await this.auth.updateUserProfile(cloudInput)
      } catch (error) {
        throw toSafeAppError(error)
      }
    }
    const cloudProfile = user.profile
    const stored = this.repository.upsert({
      userId: session.user.id,
      avatarUrl: mergeCloudField(cloudProfile?.avatarUrl, existing?.avatarUrl),
      displayName: mergeCloudField(cloudProfile?.displayName, existing?.displayName),
      gender: mergeCloudField(cloudProfile?.gender, existing?.gender),
      birthDate: parsed.data.birthDate === undefined
        ? existing?.birthDate ?? null
        : parsed.data.birthDate || null,
      email: mergeCloudField(cloudProfile?.email, existing?.email),
      phone: mergeCloudField(cloudProfile?.phone, existing?.phone),
      updatedAt: this.dependencies.now(),
    })
    return composeProfile(user, stored)
  }
}
