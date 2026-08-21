import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import type { AuthSession } from '@autoforge/shared'
import { openAppDatabase } from './client.js'

const temporaryDirectories: string[] = []

function openTestDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'autoforge-cloudbase-identity-'))
  const path = join(directory, 'autoforge.sqlite')
  temporaryDirectories.push(directory)
  return { database: openAppDatabase(path), path }
}

function cloudSession(profile: AuthSession['user']['profile'] = {
  displayName: 'Alice Cloud',
  avatarUrl: 'https://cdn.example.com/alice.webp',
  gender: 'female',
  email: 'alice@example.com',
  phone: '+8618311032722',
}): AuthSession {
  return {
    user: {
      id: 'cloud_uid',
      account: 'alice_1',
      ...(profile === undefined ? {} : { profile }),
    },
    authenticatedAt: '2026-08-21T01:02:03.000Z',
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('CloudBaseIdentityRepository', () => {
  it('atomically creates the CloudBase user, profile and current local session', () => {
    const { database } = openTestDatabase()

    expect(database.cloudBaseIdentities.sync(cloudSession(), 100)).toEqual({
      user: { id: 'cloud_uid', account: 'alice_1' },
      authenticatedAt: Date.parse('2026-08-21T01:02:03.000Z'),
    })
    expect(database.localAuth.findUserByNormalizedAccount('cloudbase:cloud_uid')).toMatchObject({
      id: 'cloud_uid',
      account: 'alice_1',
      passwordDigest: '!external-identity:cloud_uid',
      createdAt: 100,
      updatedAt: 100,
    })
    expect(database.userProfiles.findByUserId('cloud_uid')).toEqual({
      userId: 'cloud_uid',
      avatarUrl: 'https://cdn.example.com/alice.webp',
      displayName: 'Alice Cloud',
      gender: 'female',
      birthDate: null,
      email: 'alice@example.com',
      phone: '+8618311032722',
      updatedAt: 100,
    })
    expect(database.localAuth.getCurrentSession()).toEqual({
      user: { id: 'cloud_uid', account: 'alice_1' },
      authenticatedAt: Date.parse('2026-08-21T01:02:03.000Z'),
    })
    database.close()
  })

  it('updates CloudBase fields while preserving birth date and user creation time', () => {
    const { database } = openTestDatabase()
    database.cloudBaseIdentities.sync(cloudSession(), 100)
    database.userProfiles.upsert({
      ...database.userProfiles.findByUserId('cloud_uid')!,
      birthDate: '1990-01-02',
      updatedAt: 110,
    })

    database.cloudBaseIdentities.sync({
      ...cloudSession({ displayName: 'Alice Updated', email: 'new@example.com' }),
      user: {
        ...cloudSession().user,
        account: 'alice_updated',
        profile: { displayName: 'Alice Updated', email: 'new@example.com' },
      },
    }, 200)

    expect(database.localAuth.findUserByNormalizedAccount('cloudbase:cloud_uid')).toMatchObject({
      account: 'alice_updated',
      createdAt: 100,
      updatedAt: 200,
    })
    expect(database.userProfiles.findByUserId('cloud_uid')).toEqual({
      userId: 'cloud_uid',
      avatarUrl: 'https://cdn.example.com/alice.webp',
      displayName: 'Alice Updated',
      gender: 'female',
      birthDate: '1990-01-02',
      email: 'new@example.com',
      phone: '+8618311032722',
      updatedAt: 200,
    })
    database.close()
  })

  it('clears explicit null profile fields and preserves missing fields', () => {
    const { database } = openTestDatabase()
    database.cloudBaseIdentities.sync(cloudSession(), 100)

    database.cloudBaseIdentities.sync(cloudSession({
      displayName: null,
      avatarUrl: null,
      email: null,
    }), 200)

    expect(database.userProfiles.findByUserId('cloud_uid')).toEqual({
      userId: 'cloud_uid',
      avatarUrl: null,
      displayName: null,
      gender: 'female',
      birthDate: null,
      email: null,
      phone: '+8618311032722',
      updatedAt: 200,
    })
    database.close()
  })

  it('keeps a same-name historical local user separate', () => {
    const { database, path } = openTestDatabase()
    database.localAuth.createUserAndSession({
      id: 'legacy_user',
      account: 'alice_1',
      accountNormalized: 'alice_1',
      passwordDigest: 'legacy-digest',
      createdAt: 1,
      updatedAt: 1,
    }, 1)
    database.localAuth.clearSession()

    database.cloudBaseIdentities.sync(cloudSession(), 100)

    const inspect = new Database(path)
    expect(inspect.prepare(`
      SELECT id, account, account_normalized AS accountNormalized
      FROM local_users
      ORDER BY id
    `).all()).toEqual([
      { id: 'cloud_uid', account: 'alice_1', accountNormalized: 'cloudbase:cloud_uid' },
      { id: 'legacy_user', account: 'alice_1', accountNormalized: 'alice_1' },
    ])
    inspect.close()
    database.close()
  })

  it('rolls back all projection writes when the CloudBase UID belongs to a local identity', () => {
    const { database, path } = openTestDatabase()
    database.localAuth.createUserAndSession({
      id: 'cloud_uid',
      account: 'Legacy Alice',
      accountNormalized: 'legacy_alice',
      passwordDigest: 'legacy-digest',
      createdAt: 1,
      updatedAt: 1,
    }, 1)
    database.localAuth.clearSession()

    expect(() => database.cloudBaseIdentities.sync(cloudSession(), 100))
      .toThrow('CloudBase identity projection was not persisted')

    const inspect = new Database(path)
    expect(inspect.prepare(`
      SELECT account, account_normalized AS accountNormalized,
             password_digest AS passwordDigest, updated_at AS updatedAt
      FROM local_users WHERE id = 'cloud_uid'
    `).get()).toEqual({
      account: 'Legacy Alice',
      accountNormalized: 'legacy_alice',
      passwordDigest: 'legacy-digest',
      updatedAt: 1,
    })
    expect(inspect.prepare('SELECT COUNT(*) AS count FROM local_user_profiles').get())
      .toEqual({ count: 0 })
    expect(inspect.prepare('SELECT COUNT(*) AS count FROM local_auth_session').get())
      .toEqual({ count: 0 })
    inspect.close()
    database.close()
  })
})
