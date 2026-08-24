/// <reference types="vite/client" />

import { createHash } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'
import userCacheMigration from '../../../resources/user-cache-migrations/0001_user_cache.sql?raw'
import outboxEnqueueSequenceMigration from '../../../resources/user-cache-migrations/0002_outbox_enqueue_sequence.sql?raw'
import syncReceiptEvidenceMigration from '../../../resources/user-cache-migrations/0003_sync_receipt_evidence.sql?raw'
import {
  createUserDataRepositories,
  type UserDataRepositories,
} from './user-data-repositories.js'

const USER_CACHE_DOMAIN = 'autoforge-user-cache-v1\0'
const USER_CACHE_FILE_PATTERN = /^[0-9a-f]{32}\.sqlite$/
const USER_CACHE_MIGRATIONS = [
  { version: 1, source: userCacheMigration },
  { version: 2, source: outboxEnqueueSequenceMigration },
  { version: 3, source: syncReceiptEvidenceMigration },
] as const

export type UserDataStore = UserDataRepositories

interface OpenStore {
  ownerUserId: string
  database: Database.Database
  repositories: UserDataStore
}

function validateUserId(userId: string): void {
  if (
    typeof userId !== 'string'
    || userId.length < 1
    || userId.length > 512
    || userId.trim() !== userId
    || userId.includes('\0')
  ) throw new Error('Invalid user data owner')
}

function cacheScope(userId: string): string {
  validateUserId(userId)
  return createHash('sha256')
    .update(USER_CACHE_DOMAIN)
    .update(userId)
    .digest('hex')
    .slice(0, 32)
}

function migrate(database: Database.Database): void {
  database.pragma('foreign_keys = ON')
  for (const migration of USER_CACHE_MIGRATIONS) {
    const hasMigrationTable = database.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'
    `).get()
    const applied = hasMigrationTable
      ? database.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(migration.version)
      : undefined
    if (applied) continue
    database.transaction(() => {
      database.exec(migration.source)
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(migration.version, Date.now())
    })()
  }
}

export class UserDataStoreManager {
  readonly #root: string
  #openStore?: OpenStore

  constructor(root: string) {
    if (typeof root !== 'string' || root.length === 0) throw new Error('User cache root is required')
    this.#root = resolve(root)
    mkdirSync(this.#root, { recursive: true })
  }

  open(userId: string): UserDataStore {
    validateUserId(userId)
    if (this.#openStore?.ownerUserId === userId) return this.#openStore.repositories
    this.close()
    const path = this.#databasePath(userId)
    const database = new Database(path)
    try {
      database.pragma('journal_mode = WAL')
      database.pragma('foreign_keys = ON')
      migrate(database)
      const repositories = createUserDataRepositories(database, userId)
      this.#openStore = { ownerUserId: userId, database, repositories }
      return repositories
    } catch (error) {
      database.close()
      throw error
    }
  }

  current(): UserDataStore | undefined {
    return this.#openStore?.repositories
  }

  closeAndDelete(userId: string): void {
    validateUserId(userId)
    const databasePath = this.#databasePath(userId)
    if (this.#openStore?.ownerUserId === userId) this.close()
    for (const exactPath of [
      databasePath,
      `${databasePath}-wal`,
      `${databasePath}-shm`,
      `${databasePath}-journal`,
    ]) rmSync(exactPath, { force: true })
  }

  close(): void {
    const store = this.#openStore
    this.#openStore = undefined
    store?.database.close()
  }

  #databasePath(userId: string): string {
    const fileName = `${cacheScope(userId)}.sqlite`
    if (!USER_CACHE_FILE_PATTERN.test(fileName)) throw new Error('Invalid user cache scope')
    const path = resolve(this.#root, fileName)
    if (dirname(path) !== this.#root) throw new Error('Invalid user cache path')
    return path
  }
}
