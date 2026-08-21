import type Database from 'better-sqlite3'
import type { AuthSession, AuthUserProfileSnapshot } from '@autoforge/shared'
import type { LocalAuthSessionRecord, LocalUserRecord } from './local-auth-repository.js'
import type { UserProfileRecord } from './user-profile-repository.js'

export interface CloudBaseIdentityRepository {
  sync(session: AuthSession, timestamp: number): LocalAuthSessionRecord
}

interface SessionRow {
  userId: string
  account: string
  authenticatedAt: number
}

function mergeCloudField<T>(value: T | null | undefined, stored: T | null | undefined): T | null {
  return value === undefined ? stored ?? null : value
}

export function createCloudBaseIdentityRepository(
  database: Database.Database,
): CloudBaseIdentityRepository {
  const findUserById = database.prepare(`
    SELECT
      id,
      account,
      account_normalized AS accountNormalized,
      password_digest AS passwordDigest,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM local_users
    WHERE id = ?
  `)
  const findProfileByUserId = database.prepare(`
    SELECT
      user_id AS userId,
      avatar_url AS avatarUrl,
      display_name AS displayName,
      gender,
      birth_date AS birthDate,
      email,
      phone,
      updated_at AS updatedAt
    FROM local_user_profiles
    WHERE user_id = ?
  `)
  const readSession = database.prepare(`
    SELECT
      users.id AS userId,
      users.account,
      session.authenticated_at AS authenticatedAt
    FROM local_auth_session session
    JOIN local_users users ON users.id = session.user_id
    WHERE session.id = 1
  `)

  const sync = database.transaction((session: AuthSession, timestamp: number) => {
    const authenticatedAt = Date.parse(session.authenticatedAt)
    if (!Number.isFinite(authenticatedAt) || !Number.isSafeInteger(timestamp)) {
      throw new Error('CloudBase identity session timestamps are invalid')
    }

    const accountNormalized = `cloudbase:${session.user.id}`
    const passwordDigest = `!external-identity:${session.user.id}`
    database.prepare(`
      INSERT INTO local_users
        (id, account, account_normalized, password_digest, created_at, updated_at)
      VALUES
        (@id, @account, @accountNormalized, @passwordDigest, @timestamp, @timestamp)
      ON CONFLICT(id) DO UPDATE SET
        account = excluded.account,
        updated_at = excluded.updated_at
      WHERE local_users.account_normalized = excluded.account_normalized
        AND local_users.password_digest = excluded.password_digest
    `).run({
      id: session.user.id,
      account: session.user.account,
      accountNormalized,
      passwordDigest,
      timestamp,
    })
    const user = findUserById.get(session.user.id) as LocalUserRecord | undefined
    if (!user
      || user.accountNormalized !== accountNormalized
      || user.passwordDigest !== passwordDigest) {
      throw new Error('CloudBase identity projection was not persisted')
    }

    const storedProfile = findProfileByUserId.get(session.user.id) as UserProfileRecord | undefined
    const cloudProfile: AuthUserProfileSnapshot | undefined = session.user.profile
    const profile: UserProfileRecord = {
      userId: session.user.id,
      avatarUrl: mergeCloudField(cloudProfile?.avatarUrl, storedProfile?.avatarUrl),
      displayName: mergeCloudField(cloudProfile?.displayName, storedProfile?.displayName),
      gender: mergeCloudField(cloudProfile?.gender, storedProfile?.gender),
      birthDate: storedProfile?.birthDate ?? null,
      email: mergeCloudField(cloudProfile?.email, storedProfile?.email),
      phone: mergeCloudField(cloudProfile?.phone, storedProfile?.phone),
      updatedAt: timestamp,
    }
    database.prepare(`
      INSERT INTO local_user_profiles
        (user_id, avatar_url, display_name, gender, birth_date, email, phone, updated_at)
      VALUES
        (@userId, @avatarUrl, @displayName, @gender, @birthDate, @email, @phone, @updatedAt)
      ON CONFLICT(user_id) DO UPDATE SET
        avatar_url = excluded.avatar_url,
        display_name = excluded.display_name,
        gender = excluded.gender,
        birth_date = excluded.birth_date,
        email = excluded.email,
        phone = excluded.phone,
        updated_at = excluded.updated_at
    `).run(profile)

    database.prepare(`
      INSERT INTO local_auth_session (id, user_id, authenticated_at)
      VALUES (1, @userId, @authenticatedAt)
      ON CONFLICT(id) DO UPDATE SET
        user_id = excluded.user_id,
        authenticated_at = excluded.authenticated_at
    `).run({ userId: session.user.id, authenticatedAt })
    const storedSession = readSession.get() as SessionRow | undefined
    if (!storedSession || storedSession.userId !== session.user.id) {
      throw new Error('CloudBase local authentication session was not persisted')
    }
    return {
      user: { id: storedSession.userId, account: storedSession.account },
      authenticatedAt: storedSession.authenticatedAt,
    }
  })

  return { sync }
}
