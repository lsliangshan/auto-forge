import { createHash, randomBytes } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { SafeStoragePort } from '../security/secret-store.js'
import { KnowledgeKeyStore, type KnowledgeKeyStorePort } from './key-store.js'
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

export interface KnowledgeDatabaseDependencies {
  createKeyStore(recordPath: string, safeStorage: SafeStoragePort): KnowledgeKeyStorePort
  openDatabase(path: string, key: Buffer): Database.Database
  rekeyDatabase(database: Database.Database, key: Buffer): void
  probeCapabilities(database: Database.Database): KnowledgeDatabaseCapabilities
  initializeSchema(database: Database.Database): void
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
  keyStore: KnowledgeKeyStorePort,
  dependencies: KnowledgeDatabaseDependencies,
): Promise<Database.Database> {
  const active = await keyStore.loadActiveKey()
  const pending = await keyStore.loadPendingKey()
  try {
    if (!pending) return dependencies.openDatabase(databasePath, active)

    let activeDatabase: Database.Database | undefined
    let activeError: unknown
    try {
      activeDatabase = dependencies.openDatabase(databasePath, active)
    } catch (error) {
      activeError = error
    }
    if (activeDatabase) {
      try {
        await keyStore.discardPendingKey()
      } catch (error) {
        closeSilently(activeDatabase)
        throw error
      }
      return activeDatabase
    }

    let pendingDatabase: Database.Database
    try {
      pendingDatabase = dependencies.openDatabase(databasePath, pending)
    } catch (pendingError) {
      throw new AggregateError(
        [activeError, pendingError],
        'Neither active nor pending knowledge database key could open the database',
        { cause: pendingError },
      )
    }
    try {
      await keyStore.promotePendingKey()
    } catch (error) {
      closeSilently(pendingDatabase)
      throw error
    }
    return pendingDatabase
  } finally {
    active.fill(0)
    pending?.fill(0)
  }
}

function closeSilently(database: Database.Database): void {
  try {
    database.close()
  } catch {
    // Preserve the initialization or recovery error that required fail-closed cleanup.
  }
}

const defaultDependencies: KnowledgeDatabaseDependencies = {
  createKeyStore: (recordPath, safeStorage) => new KnowledgeKeyStore(recordPath, safeStorage),
  openDatabase: openEncryptedDatabase,
  rekeyDatabase: rekeyEncryptedDatabase,
  probeCapabilities: probeKnowledgeCapabilities,
  initializeSchema: initializeKnowledgeSchema,
}

export async function openUserKnowledgeDatabase(
  options: OpenUserKnowledgeDatabaseOptions,
  dependencyOverrides: Partial<KnowledgeDatabaseDependencies> = {},
): Promise<OpenedUserKnowledgeDatabase> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides }
  const directory = ownerDirectory(options.rootDirectory, options.userId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const databasePath = join(directory, 'knowledge.sqlite')
  const keyRecordPath = join(directory, 'knowledge-key.json')
  const keyStore = dependencies.createKeyStore(keyRecordPath, options.safeStorage)

  if (!keyStore.exists()) {
    if (hasDatabaseFile(databasePath)) throw new Error('Knowledge database key is unavailable')
    const initialKey = await keyStore.createActiveKey()
    initialKey.fill(0)
  }

  const database = await openRecoverableDatabase(databasePath, keyStore, dependencies)
  let capabilities: KnowledgeDatabaseCapabilities
  try {
    capabilities = dependencies.probeCapabilities(database)
    dependencies.initializeSchema(database)
  } catch (error) {
    closeSilently(database)
    throw error
  }
  let currentDatabase = database
  let closed = false

  return {
    get database() {
      return currentDatabase
    },
    databasePath,
    keyRecordPath,
    capabilities,
    async rotateKey() {
      if (closed) throw new Error('Knowledge database is closed')
      const pending = randomBytes(DATABASE_KEY_BYTES)
      try {
        await keyStore.stagePendingKey(pending)
        dependencies.rekeyDatabase(currentDatabase, pending)
        currentDatabase.close()
        closed = true
        const reopened = dependencies.openDatabase(databasePath, pending)
        try {
          await keyStore.promotePendingKey()
        } catch (error) {
          closeSilently(reopened)
          throw error
        }
        currentDatabase = reopened
        closed = false
      } finally {
        pending.fill(0)
      }
    },
    close() {
      if (closed) return
      currentDatabase.close()
      closed = true
    },
  }
}
