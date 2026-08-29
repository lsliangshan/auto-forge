import { randomBytes } from 'node:crypto'
import { constants, mkdtempSync, rmSync } from 'node:fs'
import { access, chmod } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import type Database from 'better-sqlite3'
import type { SafeStoragePort } from '../security/secret-store.js'
import { initializeKnowledgeSchema } from './knowledge-schema.js'
import {
  KnowledgeKeyStore,
  type KnowledgeKeyMaterial,
  type LockedKnowledgeKeyStore,
} from './key-store.js'
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
  close(): Promise<void>
}

interface SharedKnowledgeStore {
  database: CipherDatabaseInstance
  databasePath: string
  ownerRoot: string
  capabilities: KnowledgeNativeCapabilities
  objects: KnowledgeObjectStore
  referenceCount: number
  closed: boolean
}

const openKnowledgeStores = new Map<string, SharedKnowledgeStore>()

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function tightenExistingDatabaseArtifacts(databasePath: string): Promise<void> {
  if (process.platform === 'win32') return
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (await pathExists(path)) await chmod(path, 0o600)
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

    return this.#keyStore.withOwnerLock(ownerId, async keyStore => {
      const cacheKey = keyStore.paths.ownerRoot
      const current = openKnowledgeStores.get(cacheKey)
      if (current) {
        current.referenceCount += 1
        return this.#createLease(ownerId, cacheKey, current)
      }

      let material = await keyStore.loadExisting()
      const databasePath = join(keyStore.paths.ownerRoot, 'knowledge.sqlite')
      if (!material) {
        if (await pathExists(databasePath)) throw new Error('Knowledge database key is unavailable')
        material = await keyStore.loadOrCreate()
      }
      await tightenExistingDatabaseArtifacts(databasePath)

      let database: CipherDatabaseInstance | undefined
      let objects: KnowledgeObjectStore | undefined
      try {
        database = await this.#openRecoveringPending(databasePath, material, keyStore)
        configureAndProbe(database)
        initializeKnowledgeSchema(database)
        await tightenExistingDatabaseArtifacts(databasePath)
        objects = new KnowledgeObjectStore(join(keyStore.paths.ownerRoot, 'objects'), material.objectKey)
      } catch (error) {
        database?.close()
        objects?.close()
        throw error
      } finally {
        material.active.fill(0)
        material.objectKey.fill(0)
        material.pending?.fill(0)
      }

      const shared: SharedKnowledgeStore = {
        database,
        databasePath,
        ownerRoot: keyStore.paths.ownerRoot,
        capabilities,
        objects,
        referenceCount: 1,
        closed: false,
      }
      openKnowledgeStores.set(cacheKey, shared)
      return this.#createLease(ownerId, cacheKey, shared)
    })
  }

  #createLease(ownerId: string, cacheKey: string, shared: SharedKnowledgeStore): KnowledgeStore {
    let closed = false
    return {
      database: shared.database,
      databasePath: shared.databasePath,
      ownerRoot: shared.ownerRoot,
      capabilities: shared.capabilities,
      objects: shared.objects,
      rotateKey: () => this.#keyStore.withOwnerLock(ownerId, async lockedStore => {
        if (closed || shared.closed) throw new Error('Knowledge database is closed')
        const pending = randomBytes(KEY_BYTES)
        try {
          await lockedStore.stagePending(pending)
          rekeyEncryptedKnowledgeDatabase(shared.database, pending)
          await lockedStore.promotePending()
        } finally {
          pending.fill(0)
        }
      }),
      close: () => this.#keyStore.withOwnerLock(ownerId, async () => {
        if (closed) return
        closed = true
        shared.referenceCount -= 1
        if (shared.referenceCount > 0) return
        shared.closed = true
        if (openKnowledgeStores.get(cacheKey) === shared) openKnowledgeStores.delete(cacheKey)
        shared.objects.close()
        shared.database.close()
        await tightenExistingDatabaseArtifacts(shared.databasePath)
      }),
    }
  }

  async #openRecoveringPending(
    databasePath: string,
    material: KnowledgeKeyMaterial,
    keyStore: LockedKnowledgeKeyStore,
  ): Promise<CipherDatabaseInstance> {
    if (!material.pending) return openEncryptedKnowledgeDatabase(databasePath, material.active)

    try {
      const database = openEncryptedKnowledgeDatabase(databasePath, material.active)
      try {
        await keyStore.discardPending()
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
        await keyStore.promotePending()
        return database
      } catch (error) {
        database.close()
        throw error
      }
    }
  }
}
