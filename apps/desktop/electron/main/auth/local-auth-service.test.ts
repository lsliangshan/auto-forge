import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openAppDatabase } from '../database/client.js'
import { LocalAuthService } from './local-auth-service.js'
import type { PasswordHasher } from './password-hasher.js'

const directories: string[] = []

function harness() {
  const directory = mkdtempSync(join(tmpdir(), 'autoforge-local-auth-'))
  directories.push(directory)
  const database = openAppDatabase(join(directory, 'autoforge.sqlite'))
  const hasher: PasswordHasher = {
    hash: vi.fn(async (password) => `digest:${password}`),
    verify: vi.fn(async (password, digest) => digest === `digest:${password}`),
  }
  let id = 0
  const service = new LocalAuthService(database.localAuth, {
    hasher,
    createId: () => `user_${++id}`,
    now: () => 1_786_060_800_000,
  })
  return { database, hasher, service }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('LocalAuthService', () => {
  it('registers a normalized account and restores its persistent session', async () => {
    const app = harness()

    await expect(app.service.register({ account: ' Alice ', password: 'password' })).resolves.toEqual({
      user: { id: 'user_1', account: 'Alice' },
      authenticatedAt: '2026-08-07T00:00:00.000Z',
    })
    expect(app.database.localAuth.findUserByNormalizedAccount('alice')).toMatchObject({
      account: 'Alice', accountNormalized: 'alice', passwordDigest: 'digest:password',
    })

    const restarted = new LocalAuthService(app.database.localAuth, {
      hasher: app.hasher,
      createId: () => 'unused',
      now: () => 1_786_060_800_001,
    })
    await expect(restarted.getSession()).resolves.toMatchObject({ user: { account: 'Alice' } })
    expect(restarted.isAuthenticated()).toBe(true)
  })

  it('rejects a case-insensitive duplicate without replacing the current session', async () => {
    const app = harness()
    await app.service.register({ account: 'Alice', password: 'password' })

    await expect(app.service.register({ account: 'ALICE', password: 'different' }))
      .rejects.toMatchObject({ code: 'AUTH_ACCOUNT_EXISTS' })
    await expect(app.service.getSession()).resolves.toMatchObject({ user: { id: 'user_1' } })
  })

  it('logs in case-insensitively and replaces the current session', async () => {
    const app = harness()
    await app.service.register({ account: 'Alice', password: 'password' })
    await app.service.logout()

    await expect(app.service.login({ account: 'ALICE', password: 'password' })).resolves.toMatchObject({
      user: { id: 'user_1', account: 'Alice' },
    })
    expect(app.hasher.verify).toHaveBeenCalledWith('password', 'digest:password')
  })

  it('uses the same credential error and dummy verification for an unknown account', async () => {
    const app = harness()
    await app.service.register({ account: 'Alice', password: 'password' })

    await expect(app.service.login({ account: 'Alice', password: 'incorrect' }))
      .rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' })
    await expect(app.service.login({ account: 'Missing', password: 'incorrect' }))
      .rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' })
    expect(app.hasher.verify).toHaveBeenLastCalledWith('incorrect', undefined)
  })

  it('rejects invalid direct-service inputs before persistence', async () => {
    const app = harness()

    await expect(app.service.register({ account: 'bad account', password: 'password' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(app.service.login({ account: 'Alice', password: 'short' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(app.database.localAuth.findUserByNormalizedAccount('bad account')).toBeUndefined()
  })

  it('requires a session and logs out idempotently', async () => {
    const app = harness()

    await expect(app.service.requireSession()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    await app.service.register({ account: 'Alice', password: 'password' })
    await expect(app.service.requireSession()).resolves.toMatchObject({ user: { account: 'Alice' } })
    await app.service.logout()
    await app.service.logout()
    expect(app.service.isAuthenticated()).toBe(false)
    await expect(app.service.getSession()).resolves.toBeNull()
  })
})
