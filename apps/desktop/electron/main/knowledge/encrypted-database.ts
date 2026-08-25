import { createHash, randomBytes } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { SafeStoragePort } from '../security/secret-store.js'
import { KnowledgeKeyStore } from './key-store.js'
import {
  configureKnowledgeConnection,
  initializeKnowledgeSchema,
  probeKnowledgeCapabilities,
  type KnowledgeDatabaseCapabilities,
} from './knowledge-schema.js'

const DATABASE_KEY_BYTES = 32

export interface OpenUserKnowledgeDatabaseOptions {
  readonly rootDirectory: string
  readonly userId: string
  readonly safeStorage: SafeStoragePort
}

export interface OpenedUserKnowledgeDatabase {
  readonly database: Database.Database
  readonly databasePath: string
  readonly keyRecordPath: string
  readonly capabilities: KnowledgeDatabaseCapabilities
  rotateKey(): Promise<void>
  close(): void
}

function validateKey(key: Buffer): void {
  if (key.length !== DATABASE_KEY_BYTES) throw new Error('Knowledge database key must be 32 bytes')
}

function hasDatabaseFile(path: string): boolean {
  return existsSync(path) && statSync(path).size > 0
}

export function openEncryptedDatabase(path: string, key: Buffer): Database.Database {
  validateKey(key)
  const existing = hasDatabaseFile(path)
  const database = new Database(path)
  const keyCopy = Buffer.from(key)
  try {
    if (existing) database.key(keyCopy)
    else database.rekey(keyCopy)
    database.prepare('SELECT count(*) FROM sqlite_master').get()
    configureKnowledgeConnection(database)
    database.pragma('journal_mode = WAL')
    return database
  } catch (error) {
    database.close()
    throw error
  } finally {
    keyCopy.fill(0)
  }
}

export function rekeyEncryptedDatabase(database: Database.Database, key: Buffer): void {
  validateKey(key)
  const keyCopy = Buffer.from(key)
  try {
    database.pragma('wal_checkpoint(TRUNCATE)')
    database.pragma('journal_mode = DELETE')
    database.rekey(keyCopy)
    database.prepare('SELECT count(*) FROM sqlite_master').get()
    database.pragma('journal_mode = WAL')
  } finally {
    keyCopy.fill(0)
  }
}

function ownerDirectory(rootDirectory: string, userId: string): string {
  if (!userId.trim()) throw new Error('Knowledge database owner is required')
  const digest = createHash('sha256')
    .update('autoforge:knowledge-owner:')
    .update(userId)
    .digest('hex')
  return join(rootDirectory, 'knowledge', digest)
}

async function openRecoverableDatabase(
  databasePath: string,
  keyStore: KnowledgeKeyStore,
): Promise<Database.Database> {
  const active = await keyStore.loadActiveKey()
  const pending = await keyStore.loadPendingKey()
  try {
    if (!pending) return openEncryptedDatabase(databasePath, active)

    try {
      const database = openEncryptedDatabase(databasePath, active)
      await keyStore.discardPendingKey()
      return database
    } catch (activeError) {
      try {
        const database = openEncryptedDatabase(databasePath, pending)
        await keyStore.promotePendingKey()
        return database
      } catch {
        throw activeError
      }
    }
  } finally {
    active.fill(0)
    pending?.fill(0)
  }
}

export async function openUserKnowledgeDatabase(
  options: OpenUserKnowledgeDatabaseOptions,
): Promise<OpenedUserKnowledgeDatabase> {
  const directory = ownerDirectory(options.rootDirectory, options.userId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const databasePath = join(directory, 'knowledge.sqlite')
  const keyRecordPath = join(directory, 'knowledge-key.json')
  const keyStore = new KnowledgeKeyStore(keyRecordPath, options.safeStorage)

  if (!keyStore.exists()) {
    if (hasDatabaseFile(databasePath)) throw new Error('Knowledge database key is unavailable')
    const initialKey = await keyStore.createActiveKey()
    initialKey.fill(0)
  }

  let database = await openRecoverableDatabase(databasePath, keyStore)
  const capabilities = probeKnowledgeCapabilities(database)
  initializeKnowledgeSchema(database)
  let closed = false

  return {
    get database() {
      return database
    },
    databasePath,
    keyRecordPath,
    capabilities,
    async rotateKey() {
      if (closed) throw new Error('Knowledge database is closed')
      const pending = randomBytes(DATABASE_KEY_BYTES)
      try {
        await keyStore.stagePendingKey(pending)
        rekeyEncryptedDatabase(database, pending)
        database.close()
        database = openEncryptedDatabase(databasePath, pending)
        await keyStore.promotePendingKey()
      } finally {
        pending.fill(0)
      }
    },
    close() {
      if (closed) return
      database.close()
      closed = true
    },
  }
}
