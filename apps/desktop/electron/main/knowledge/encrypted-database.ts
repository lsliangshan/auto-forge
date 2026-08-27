import { randomBytes } from 'node:crypto'
import { constants, mkdtempSync, rmSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import type Database from 'better-sqlite3'
import type { SafeStoragePort } from '../security/secret-store.js'
import { initializeKnowledgeSchema } from './knowledge-schema.js'
import { KnowledgeKeyStore, type KnowledgeKeyMaterial } from './key-store.js'
import { KnowledgeObjectStore } from './encrypted-object-store.js'

const KEY_BYTES = 32

type CipherDatabaseInstance = Database.Database & {
  key(key: Buffer): number
  rekey(key: Buffer): number
}

const CipherDatabase = createRequire(import.meta.url)('better-sqlite3-multiple-ciphers') as {
  new(filename?: string, options?: Database.Options): CipherDatabaseInstance
}

export interface KnowledgeNativeCapabilities {
  available: true
  platform: 'darwin'
  arch: 'arm64'
  tempStore: 'memory'
  fts5: true
  trigram: true
}

export interface KnowledgeNativeUnavailable {
  available: false
  platform: string
  arch: string
  reason: 'unsupported-platform' | 'native-capability-unavailable'
}

export type KnowledgeNativeAvailability = KnowledgeNativeCapabilities | KnowledgeNativeUnavailable

export interface KnowledgeStore {
  database: CipherDatabaseInstance
  databasePath: string
  ownerRoot: string
  capabilities: KnowledgeNativeCapabilities
  objects: KnowledgeObjectStore
  rotateKey(): Promise<void>
  close(): void
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function configureAndProbe(database: CipherDatabaseInstance): Omit<KnowledgeNativeCapabilities, 'available' | 'platform' | 'arch'> {
  database.pragma('temp_store = MEMORY')
  if (database.pragma('temp_store', { simple: true }) !== 2) {
    throw new Error('Knowledge database memory temp storage is unavailable')
  }
  database.exec(`
    CREATE VIRTUAL TABLE temp.__knowledge_trigram_probe USING fts5(
      body,
      tokenize='trigram'
    );
    DROP TABLE temp.__knowledge_trigram_probe;
  `)
  return { tempStore: 'memory', fts5: true, trigram: true }
}

export function probeKnowledgeNativeAvailability({
  platform = process.platform,
  arch = process.arch,
}: { platform?: NodeJS.Platform | string; arch?: string } = {}): KnowledgeNativeAvailability {
  if (platform !== 'darwin' || arch !== 'arm64') {
    return { available: false, platform, arch, reason: 'unsupported-platform' }
  }
  let database: CipherDatabaseInstance | undefined
  const probeRoot = mkdtempSync(join(tmpdir(), 'autoforge-knowledge-native-'))
  const key = randomBytes(KEY_BYTES)
  try {
    database = new CipherDatabase(join(probeRoot, 'probe.sqlite'))
    database.key(key)
    const capabilities = configureAndProbe(database)
    return { available: true, platform: 'darwin', arch: 'arm64', ...capabilities }
  } catch {
    return { available: false, platform, arch, reason: 'native-capability-unavailable' }
  } finally {
    database?.close()
    key.fill(0)
    rmSync(probeRoot, { recursive: true, force: true })
  }
}

export function openEncryptedKnowledgeDatabase(
  databasePath: string,
  key: Buffer,
): CipherDatabaseInstance {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error('Invalid knowledge database key')
  const database = new CipherDatabase(databasePath)
  try {
    database.key(key)
    database.prepare('SELECT count(*) AS count FROM sqlite_master').get()
    database.pragma('foreign_keys = ON')
    database.pragma('secure_delete = ON')
    database.pragma('temp_store = MEMORY')
    database.pragma('journal_mode = WAL')
    return database
  } catch {
    database.close()
    throw new Error('Encrypted knowledge database could not be opened with this key')
  }
}

export function rekeyEncryptedKnowledgeDatabase(
  database: CipherDatabaseInstance,
  key: Buffer,
): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error('Invalid knowledge database key')
  try {
    database.rekey(key)
    database.prepare('SELECT count(*) AS count FROM sqlite_master').get()
  } catch {
    throw new Error('Encrypted knowledge database rekey failed')
  }
}

export class KnowledgeStoreFactory {
  readonly #keyStore: KnowledgeKeyStore

  constructor(
    private readonly rootDirectory: string,
    safeStorage: SafeStoragePort,
  ) {
    this.#keyStore = new KnowledgeKeyStore(rootDirectory, safeStorage)
  }

  async open(ownerId: string): Promise<KnowledgeStore> {
    const capabilities = probeKnowledgeNativeAvailability()
    if (!capabilities.available) throw new Error('Encrypted knowledge storage is unavailable on this platform')

    const paths = this.#keyStore.pathsFor(ownerId)
    let material = await this.#keyStore.loadExisting(ownerId)
    const databasePath = join(paths.ownerRoot, 'knowledge.sqlite')
    if (!material) {
      if (await pathExists(databasePath)) throw new Error('Knowledge database key is unavailable')
      material = await this.#keyStore.loadOrCreate(ownerId)
    }

    let database: CipherDatabaseInstance | undefined
    let objects: KnowledgeObjectStore | undefined
    try {
      database = await this.#openRecoveringPending(ownerId, databasePath, material)
      configureAndProbe(database)
      initializeKnowledgeSchema(database)
      objects = new KnowledgeObjectStore(join(paths.ownerRoot, 'objects'), material.objectKey)
    } catch (error) {
      database?.close()
      objects?.close()
      throw error
    } finally {
      material.active.fill(0)
      material.objectKey.fill(0)
      material.pending?.fill(0)
    }

    let closed = false
    const activeDatabase = database
    return {
      database: activeDatabase,
      databasePath,
      ownerRoot: paths.ownerRoot,
      capabilities,
      objects,
      rotateKey: async () => {
        if (closed) throw new Error('Knowledge database is closed')
        const pending = randomBytes(KEY_BYTES)
        try {
          await this.#keyStore.stagePending(ownerId, pending)
          rekeyEncryptedKnowledgeDatabase(activeDatabase, pending)
          await this.#keyStore.promotePending(ownerId)
        } finally {
          pending.fill(0)
        }
      },
      close: () => {
        if (closed) return
        closed = true
        objects.close()
        activeDatabase.close()
      },
    }
  }

  async #openRecoveringPending(
    ownerId: string,
    databasePath: string,
    material: KnowledgeKeyMaterial,
  ): Promise<CipherDatabaseInstance> {
    if (!material.pending) return openEncryptedKnowledgeDatabase(databasePath, material.active)

    try {
      const database = openEncryptedKnowledgeDatabase(databasePath, material.active)
      try {
        await this.#keyStore.discardPending(ownerId)
        return database
      } catch (error) {
        database.close()
        throw error
      }
    } catch (activeError) {
      let database: CipherDatabaseInstance
      try {
        database = openEncryptedKnowledgeDatabase(databasePath, material.pending)
      } catch {
        throw activeError
      }
      try {
        await this.#keyStore.promotePending(ownerId)
        return database
      } catch (error) {
        database.close()
        throw error
      }
    }
  }
}
