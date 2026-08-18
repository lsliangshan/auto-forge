import type Database from 'better-sqlite3'

export interface UserProfileRecord {
  userId: string
  avatarUrl: string | null
  displayName: string | null
  gender: string | null
  birthDate: string | null
  email: string | null
  phone: string | null
  updatedAt: number
}

export interface UserProfileRepository {
  findByUserId(userId: string): UserProfileRecord | undefined
  upsert(profile: UserProfileRecord): UserProfileRecord
}

export function createUserProfileRepository(database: Database.Database): UserProfileRepository {
  const findByUserId = (userId: string) => database.prepare(`
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
  `).get(userId) as UserProfileRecord | undefined

  return {
    findByUserId,
    upsert(profile) {
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
      const stored = findByUserId(profile.userId)
      if (!stored) throw new Error('User profile was not persisted')
      return stored
    },
  }
}
