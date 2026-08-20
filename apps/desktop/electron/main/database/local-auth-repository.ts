import type Database from 'better-sqlite3'

export interface LocalUserRecord {
  id: string
  account: string
  accountNormalized: string
  passwordDigest: string
  createdAt: number
  updatedAt: number
}

export interface LocalAuthSessionRecord {
  user: Pick<LocalUserRecord, 'id' | 'account'>
  authenticatedAt: number
}

export interface LocalAuthRepository {
  findUserByNormalizedAccount(accountNormalized: string): LocalUserRecord | undefined
  ensureExternalIdentity(user: Pick<LocalUserRecord, 'id' | 'account'>, timestamp: number): LocalUserRecord
  createUserAndSession(user: LocalUserRecord, authenticatedAt: number): LocalAuthSessionRecord | undefined
  replaceSession(userId: string, authenticatedAt: number): LocalAuthSessionRecord
  getCurrentSession(): LocalAuthSessionRecord | undefined
  clearSession(): void
}

interface SessionRow {
  userId: string
  account: string
  authenticatedAt: number
}

function sessionFromRow(row: SessionRow): LocalAuthSessionRecord {
  return {
    user: { id: row.userId, account: row.account },
    authenticatedAt: row.authenticatedAt,
  }
}

export function createLocalAuthRepository(database: Database.Database): LocalAuthRepository {
  const findUserById = (id: string) => database.prepare(`
    SELECT
      id,
      account,
      account_normalized AS accountNormalized,
      password_digest AS passwordDigest,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM local_users
    WHERE id = ?
  `).get(id) as LocalUserRecord | undefined

  const findUserByNormalizedAccount = (accountNormalized: string) => database.prepare(`
    SELECT
      id,
      account,
      account_normalized AS accountNormalized,
      password_digest AS passwordDigest,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM local_users
    WHERE account_normalized = ?
  `).get(accountNormalized) as LocalUserRecord | undefined

  const readSession = () => database.prepare(`
    SELECT
      users.id AS userId,
      users.account,
      session.authenticated_at AS authenticatedAt
    FROM local_auth_session session
    JOIN local_users users ON users.id = session.user_id
    WHERE session.id = 1
  `).get() as SessionRow | undefined

  const writeSession = (userId: string, authenticatedAt: number) => {
    database.prepare(`
      INSERT INTO local_auth_session (id, user_id, authenticated_at)
      VALUES (1, @userId, @authenticatedAt)
      ON CONFLICT(id) DO UPDATE SET
        user_id = excluded.user_id,
        authenticated_at = excluded.authenticated_at
    `).run({ userId, authenticatedAt })
    const row = readSession()
    if (!row) throw new Error('Local authentication session was not persisted')
    return sessionFromRow(row)
  }

  const createUserAndSession = database.transaction((user: LocalUserRecord, authenticatedAt: number) => {
    const inserted = database.prepare(`
      INSERT OR IGNORE INTO local_users
        (id, account, account_normalized, password_digest, created_at, updated_at)
      VALUES
        (@id, @account, @accountNormalized, @passwordDigest, @createdAt, @updatedAt)
    `).run(user)
    if (inserted.changes !== 1) {
      if (findUserByNormalizedAccount(user.accountNormalized)) return undefined
      throw new Error('Local user was not persisted')
    }
    return writeSession(user.id, authenticatedAt)
  })

  const replaceSession = database.transaction((userId: string, authenticatedAt: number) => (
    writeSession(userId, authenticatedAt)
  ))

  const ensureExternalIdentity = database.transaction((
    user: Pick<LocalUserRecord, 'id' | 'account'>,
    timestamp: number,
  ) => {
    const accountNormalized = `cloudbase:${user.id}`
    const passwordDigest = `!external-identity:${user.id}`
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
    `).run({ ...user, accountNormalized, passwordDigest, timestamp })
    const stored = findUserById(user.id)
    if (!stored
      || stored.accountNormalized !== accountNormalized
      || stored.passwordDigest !== passwordDigest) {
      throw new Error('External identity projection was not persisted')
    }
    return stored
  })

  return {
    findUserByNormalizedAccount,
    ensureExternalIdentity,
    createUserAndSession,
    replaceSession,
    getCurrentSession() {
      const row = readSession()
      if (row) return sessionFromRow(row)
      const stale = database.prepare('SELECT 1 FROM local_auth_session WHERE id = 1').get()
      if (stale) database.prepare('DELETE FROM local_auth_session WHERE id = 1').run()
      return undefined
    },
    clearSession() {
      database.prepare('DELETE FROM local_auth_session WHERE id = 1').run()
    },
  }
}
