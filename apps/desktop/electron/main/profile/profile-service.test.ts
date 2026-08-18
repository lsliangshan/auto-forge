import { describe, expect, it, vi } from 'vitest'
import type { AuthSession } from '@autoforge/shared'
import type { UserProfileRecord, UserProfileRepository } from '../database/user-profile-repository.js'
import { ProfileService } from './profile-service.js'

const session: AuthSession = {
  user: { id: 'user_1', account: 'Alice' },
  authenticatedAt: '2026-08-18T00:00:00.000Z',
}

function harness(record?: UserProfileRecord) {
  let stored = record
  const repository: UserProfileRepository = {
    findByUserId: vi.fn(() => stored),
    upsert: vi.fn((profile) => {
      stored = profile
      return profile
    }),
  }
  const auth = { requireSession: vi.fn(async () => session) }
  const service = new ProfileService(auth, repository, {
    now: () => 1_787_011_200_000,
    today: () => '2026-08-18',
  })
  return { auth, repository, service }
}

describe('ProfileService', () => {
  it('returns an empty profile without creating a row', async () => {
    const app = harness()

    await expect(app.service.get()).resolves.toEqual({ userId: 'user_1', account: 'Alice' })
    expect(app.repository.findByUserId).toHaveBeenCalledWith('user_1')
    expect(app.repository.upsert).not.toHaveBeenCalled()
  })

  it('normalizes optional fields and always writes the session user', async () => {
    const app = harness()

    await expect(app.service.update({
      avatarUrl: 'https://cdn.example.com/profiles/user_1/a.webp',
      displayName: '  Alice Zhang  ',
      email: '  alice@example.com  ',
      phone: '+86 138-0013-8000',
    })).resolves.toMatchObject({
      userId: 'user_1',
      account: 'Alice',
      displayName: 'Alice Zhang',
      email: 'alice@example.com',
      phone: '+8613800138000',
      updatedAt: '2026-08-18T00:00:00.000Z',
    })
    expect(app.repository.upsert).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user_1' }))
  })

  it('stores blank editable values as null', async () => {
    const app = harness()

    await app.service.update({ displayName: ' ', birthDate: '', email: '', phone: ' - ' })

    expect(app.repository.upsert).toHaveBeenCalledWith({
      userId: 'user_1',
      avatarUrl: null,
      displayName: null,
      gender: null,
      birthDate: null,
      email: null,
      phone: null,
      updatedAt: 1_787_011_200_000,
    })
  })

  it('rejects impossible and future local dates', async () => {
    const app = harness()

    await expect(app.service.update({ birthDate: '2026-02-30' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(app.service.update({ birthDate: '2026-08-19' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(app.repository.upsert).not.toHaveBeenCalled()
  })
})
