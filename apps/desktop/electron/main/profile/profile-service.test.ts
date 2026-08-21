import { describe, expect, it, vi } from 'vitest'
import { toSafeAppError, type AuthSession, type AuthUser } from '@autoforge/shared'
import type { UserProfileRecord, UserProfileRepository } from '../database/user-profile-repository.js'
import { ProfileService } from './profile-service.js'

const session: AuthSession = {
  user: {
    id: 'user_1',
    account: 'Alice',
    profile: {
      displayName: 'Alice Cloud',
      avatarUrl: 'https://cdn.example.com/profiles/user_1/original.webp',
      gender: 'female',
      email: 'alice@example.com',
      phone: '+8613800138000',
    },
  },
  authenticatedAt: '2026-08-18T00:00:00.000Z',
}

const existingProfile: UserProfileRecord = {
  userId: 'user_1',
  avatarUrl: 'https://cdn.example.com/profiles/user_1/original.webp',
  displayName: 'Alice Cloud',
  gender: 'female',
  birthDate: '1990-01-02',
  email: 'alice@example.com',
  phone: '+8613800138000',
  updatedAt: 1,
}

function harness(record?: UserProfileRecord) {
  let stored = record
  const callOrder: string[] = []
  const repository: UserProfileRepository = {
    findByUserId: vi.fn(() => stored),
    upsert: vi.fn((profile) => {
      callOrder.push('local')
      stored = profile
      return profile
    }),
  }
  const auth = {
    requireSession: vi.fn(async () => session),
    updateUserProfile: vi.fn(async (input): Promise<AuthUser> => {
      callOrder.push('cloud')
      return {
        ...session.user,
        profile: { ...session.user.profile, ...input },
      }
    }),
  }
  const service = new ProfileService(auth, repository, {
    now: () => 1_787_011_200_000,
    today: () => '2026-08-18',
  })
  return { auth, callOrder, repository, service }
}

describe('ProfileService', () => {
  it('returns an empty profile without creating a row', async () => {
    const app = harness()

    await expect(app.service.get()).resolves.toEqual({ userId: 'user_1', account: 'Alice' })
    expect(app.repository.findByUserId).toHaveBeenCalledWith('user_1')
    expect(app.repository.upsert).not.toHaveBeenCalled()
  })

  it('updates CloudBase before persisting shared profile fields locally', async () => {
    const app = harness(existingProfile)
    vi.mocked(app.auth.updateUserProfile).mockImplementationOnce(async (input) => {
      app.callOrder.push('cloud')
      expect(input).toEqual({
        avatarUrl: 'https://cdn.example.com/profiles/user_1/new.webp',
        displayName: 'Alice Zhang',
        gender: 'other',
      })
      return {
        id: 'user_1',
        account: 'Alice',
        profile: {
          displayName: 'Alice Zhang',
          avatarUrl: 'https://cdn.example.com/profiles/user_1/new.webp',
          gender: 'other',
          email: 'alice@example.com',
          phone: '+8613800138000',
        },
      }
    })

    await expect(app.service.update({
      avatarUrl: 'https://cdn.example.com/profiles/user_1/new.webp',
      displayName: '  Alice Zhang  ',
      gender: 'other',
      birthDate: '2000-03-04',
    })).resolves.toMatchObject({
      userId: 'user_1',
      displayName: 'Alice Zhang',
      birthDate: '2000-03-04',
      email: 'alice@example.com',
      phone: '+8613800138000',
    })
    expect(app.callOrder).toEqual(['cloud', 'local'])
  })

  it('does not write the local profile when the CloudBase update fails', async () => {
    const app = harness(existingProfile)
    vi.mocked(app.auth.updateUserProfile).mockRejectedValueOnce(
      toSafeAppError({ code: 'INTERNAL_ERROR' }),
    )

    await expect(app.service.update({ displayName: 'Blocked' }))
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(app.repository.upsert).not.toHaveBeenCalled()
  })

  it('updates only birth date locally without calling CloudBase', async () => {
    const app = harness(existingProfile)

    await expect(app.service.update({ birthDate: '2001-02-03' })).resolves.toMatchObject({
      birthDate: '2001-02-03',
      displayName: 'Alice Cloud',
      email: 'alice@example.com',
    })
    expect(app.auth.updateUserProfile).not.toHaveBeenCalled()
    expect(app.callOrder).toEqual(['local'])
  })

  it('uses the refreshed CloudBase snapshot and preserves omitted contacts locally', async () => {
    const app = harness(existingProfile)
    vi.mocked(app.auth.updateUserProfile).mockResolvedValueOnce({
      id: 'user_1',
      account: 'Alice',
      profile: {
        displayName: 'Provider Canonical',
        avatarUrl: null,
        gender: 'prefer_not_to_say',
        email: null,
      },
    })

    await app.service.update({ displayName: 'Requested Name' })

    expect(app.repository.upsert).toHaveBeenCalledWith({
      userId: 'user_1',
      avatarUrl: null,
      displayName: 'Provider Canonical',
      gender: 'prefer_not_to_say',
      birthDate: '1990-01-02',
      email: null,
      phone: '+8613800138000',
      updatedAt: 1_787_011_200_000,
    })
  })

  it('clears blank editable values through the CloudBase snapshot', async () => {
    const app = harness(existingProfile)
    vi.mocked(app.auth.updateUserProfile).mockResolvedValueOnce({
      ...session.user,
      profile: { ...session.user.profile, displayName: null },
    })

    await app.service.update({ displayName: ' ', birthDate: '' })

    expect(app.auth.updateUserProfile).toHaveBeenCalledWith({ displayName: '' })
    expect(app.repository.upsert).toHaveBeenCalledWith(expect.objectContaining({
      displayName: null,
      birthDate: null,
    }))
  })

  it('rejects impossible and future local dates', async () => {
    const app = harness(existingProfile)

    await expect(app.service.update({ birthDate: '2026-02-30' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(app.service.update({ birthDate: '2026-08-19' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(app.auth.updateUserProfile).not.toHaveBeenCalled()
    expect(app.repository.upsert).not.toHaveBeenCalled()
  })
})
