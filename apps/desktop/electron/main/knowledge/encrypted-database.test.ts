import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { chmod, mkdtemp, rm, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createRequire } from 'node:module'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import type { SafeStoragePort } from '../security/secret-store.js'
import {
  KnowledgeStoreFactory,
  openEncryptedKnowledgeDatabase,
  probeKnowledgeNativeAvailability,
  rekeyEncryptedKnowledgeDatabase,
} from './encrypted-database.js'
import { KnowledgeKeyStore } from './key-store.js'

const CipherDatabase = createRequire(import.meta.url)('better-sqlite3-multiple-ciphers') as {
  new(filename?: string, options?: Database.Options): Database.Database
}

const roots: string[] = []
const wrappingMask = Buffer.from('51a91a9db5b71dd3410dd82f39e33886', 'hex')

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(release => { resolve = release })
  return { promise, resolve }
}

function fakeSafeStorage(available = true): SafeStoragePort {
  return {
    isAvailable: async () => available,
    encrypt: async (value) => Buffer.from(
      Buffer.from(value, 'utf8').map((byte, index) => byte ^ wrappingMask[index % wrappingMask.length]!),
    ),
    decrypt: async (value) => ({
      value: Buffer.from(
        value.map((byte, index) => byte ^ wrappingMask[index % wrappingMask.length]!),
      ).toString('utf8'),
      shouldReEncrypt: false,
    }),
  }
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'autoforge-encrypted-knowledge-'))
  roots.push(root)
  return root
}

function collectFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? collectFiles(path) : [path]
  })
}

function sensitiveArtifacts(root: string): string[] {
  return collectFiles(root).filter(path => /(sqlite|wal|journal|shm|tmp|temp|recovery)/i.test(basename(path)))
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('encrypted personal knowledge database', () => {
  it.runIf(process.platform !== 'win32')(
    'tightens a pre-existing owner directory and encrypted database before reopening',
    async () => {
      const root = await temporaryRoot()
      const factory = new KnowledgeStoreFactory(root, fakeSafeStorage())
      const first = await factory.open('owner-loose-database-paths')
      await first.close()
      await chmod(first.ownerRoot, 0o777)
      await chmod(first.databasePath, 0o666)

      const reopened = await factory.open('owner-loose-database-paths')

      expect((await stat(reopened.ownerRoot)).mode & 0o777).toBe(0o700)
      expect((await stat(reopened.databasePath)).mode & 0o777).toBe(0o600)
      await reopened.close()
    },
  )

  it('single-flights concurrent first open for one owner', async () => {
    const root = await temporaryRoot()
    let encryptions = 0
    const safeStorage: SafeStoragePort = {
      isAvailable: async () => true,
      encrypt: async (value) => {
        encryptions += 1
        return Buffer.from(value, 'utf8')
      },
      decrypt: async value => ({ value: value.toString('utf8'), shouldReEncrypt: false }),
    }
    const factory = new KnowledgeStoreFactory(root, safeStorage)

    const opened = await Promise.all(
      Array.from({ length: 6 }, () => factory.open('owner-concurrent-open')),
    )

    expect(new Set(opened).size).toBe(6)
    expect(opened.every(store => store.database === opened[0]!.database)).toBe(true)
    expect(encryptions).toBe(2)
    for (const store of opened) await store.close()
  })

  it('keeps shared resources open until every completed open lease closes', async () => {
    const root = await temporaryRoot()
    const factory = new KnowledgeStoreFactory(root, fakeSafeStorage())
    const first = await factory.open('owner-leases')
    const second = await factory.open('owner-leases')
    const payload = Buffer.from('lease-owned-object')
    const stored = await first.objects.put(payload)

    await first.close()
    await first.close()

    expect(second.database.prepare('SELECT count(*) AS count FROM knowledge_bases').get())
      .toEqual({ count: 0 })
    expect(await second.objects.read(stored.objectId)).toEqual(payload)
    await second.rotateKey()

    await second.close()
    expect(() => second.database.prepare('SELECT 1').get()).toThrow(/not open|closed/i)
    await expect(second.objects.read(stored.objectId)).rejects.toThrow(/closed/i)
  })

  it('serializes concurrent rotations through pending rekey publication', async () => {
    const root = await temporaryRoot()
    const promotionBlocked = deferred()
    const releasePromotion = deferred()
    let encryptions = 0
    const safeStorage: SafeStoragePort = {
      isAvailable: async () => true,
      encrypt: async (value) => {
        encryptions += 1
        if (encryptions === 4) {
          promotionBlocked.resolve()
          await releasePromotion.promise
        }
        return Buffer.from(value, 'utf8')
      },
      decrypt: async value => ({ value: value.toString('utf8'), shouldReEncrypt: false }),
    }
    const factory = new KnowledgeStoreFactory(root, safeStorage)
    const opened = await factory.open('owner-concurrent-rotation')

    const first = opened.rotateKey()
    await promotionBlocked.promise
    const second = opened.rotateKey()
    const secondFinishedBeforeRelease = await Promise.race([
      second.then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 200)),
    ])
    releasePromotion.resolve()
    const rotations = await Promise.allSettled([first, second])
    await opened.close()

    expect(secondFinishedBeforeRelease).toBe(false)
    expect(rotations).toEqual([
      expect.objectContaining({ status: 'fulfilled' }),
      expect.objectContaining({ status: 'fulfilled' }),
    ])
    const reopened = await new KnowledgeStoreFactory(root, safeStorage).open('owner-concurrent-rotation')
    expect(reopened.database.prepare('SELECT count(*) AS count FROM knowledge_bases').get())
      .toEqual({ count: 0 })
    await reopened.close()
  })

  it('waits for an in-flight rotation before closing the last lease', async () => {
    const root = await temporaryRoot()
    const promotionBlocked = deferred()
    const releasePromotion = deferred()
    let encryptions = 0
    const safeStorage: SafeStoragePort = {
      isAvailable: async () => true,
      encrypt: async (value) => {
        encryptions += 1
        if (encryptions === 4) {
          promotionBlocked.resolve()
          await releasePromotion.promise
        }
        return Buffer.from(value, 'utf8')
      },
      decrypt: async value => ({ value: value.toString('utf8'), shouldReEncrypt: false }),
    }
    const opened = await new KnowledgeStoreFactory(root, safeStorage).open('owner-rotate-close')

    const rotation = opened.rotateKey()
    await promotionBlocked.promise
    const finalClose = Promise.resolve(opened.close())
    const closeFinishedBeforeRelease = await Promise.race([
      finalClose.then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 200)),
    ])

    expect(closeFinishedBeforeRelease).toBe(false)
    expect(opened.database.prepare('SELECT count(*) AS count FROM knowledge_bases').get())
      .toEqual({ count: 0 })
    releasePromotion.resolve()
    await rotation
    await finalClose
    expect(() => opened.database.prepare('SELECT 1').get()).toThrow(/not open|closed/i)
  })

  it('probes the current cipher binding and FTS5 trigram under Electron 43 on macOS arm64', () => {
    expect(process.versions.electron).toMatch(/^43\./)
    expect(probeKnowledgeNativeAvailability()).toEqual({
      available: true,
      platform: 'darwin',
      arch: 'arm64',
      tempStore: 'memory',
      fts5: true,
      trigram: true,
    })
    expect(probeKnowledgeNativeAvailability({ platform: 'darwin', arch: 'x64' }).available).toBe(false)
    expect(probeKnowledgeNativeAvailability({ platform: 'win32', arch: 'x64' }).available).toBe(false)
  })

  it('creates an owner-scoped encrypted database that only the correct key can open', async () => {
    const root = await temporaryRoot()
    const safeStorage = fakeSafeStorage()
    const factory = new KnowledgeStoreFactory(root, safeStorage)
    const opened = await factory.open('user/alice@example.test')
    const keyMaterial = await new KnowledgeKeyStore(root, safeStorage).loadExisting('user/alice@example.test')
    if (!keyMaterial) throw new Error('test key is missing')

    expect(opened.databasePath).not.toContain('alice@example.test')
    expect(opened.database.pragma('temp_store', { simple: true })).toBe(2)
    expect(opened.capabilities).toMatchObject({ tempStore: 'memory', fts5: true, trigram: true })
    await opened.close()

    const correct = openEncryptedKnowledgeDatabase(opened.databasePath, keyMaterial.active)
    expect(correct.prepare('SELECT count(*) AS count FROM knowledge_bases').get()).toEqual({ count: 0 })
    correct.close()
    expect(() => openEncryptedKnowledgeDatabase(opened.databasePath, randomBytes(32)))
      .toThrow(/encrypted|key|database/i)
    expect(() => {
      const noKey = new CipherDatabase(opened.databasePath, { readonly: true })
      try {
        noKey.prepare('SELECT count(*) FROM knowledge_bases').get()
      } finally {
        noKey.close()
      }
    }).toThrow(/encrypted|database|file/i)
    keyMaterial.active.fill(0)
  })

  it('fails closed when secure storage or an existing database key record is unavailable', async () => {
    const root = await temporaryRoot()
    await expect(new KnowledgeStoreFactory(root, fakeSafeStorage(false)).open('owner-no-storage'))
      .rejects.toThrow(/secure storage.*unavailable/i)

    const safeStorage = fakeSafeStorage()
    const factory = new KnowledgeStoreFactory(root, safeStorage)
    const opened = await factory.open('owner-missing-key')
    await opened.close()
    const material = await new KnowledgeKeyStore(root, safeStorage).loadExisting('owner-missing-key')
    if (!material) throw new Error('test key is missing')
    await unlink(material.recordPath)
    material.active.fill(0)

    await expect(factory.open('owner-missing-key')).rejects.toThrow(/key.*unavailable/i)
  })

  it('rolls back atomically, checkpoints WAL, and leaks no random sentinel to artifacts', async () => {
    const root = await temporaryRoot()
    const opened = await new KnowledgeStoreFactory(root, fakeSafeStorage()).open('owner-artifacts')
    const sentinel = `SENTINEL-${randomBytes(18).toString('hex')}`
    opened.database.pragma('wal_autocheckpoint = 0')

    expect(() => opened.database.transaction(() => {
      opened.database.prepare(`
        INSERT INTO knowledge_bases (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)
      `).run('kb_rollback', sentinel)
      throw new Error('rollback requested')
    })()).toThrow('rollback requested')
    expect(opened.database.prepare('SELECT count(*) AS count FROM knowledge_bases').get())
      .toEqual({ count: 0 })

    opened.database.prepare(`
      INSERT INTO knowledge_bases (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)
    `).run('kb_commit', sentinel)
    expect(existsSync(`${opened.databasePath}-wal`)).toBe(true)
    expect(sensitiveArtifacts(root).filter(path => readFileSync(path).includes(Buffer.from(sentinel))))
      .toEqual([])
    opened.database.pragma('wal_checkpoint(TRUNCATE)')
    await opened.close()

    expect(sensitiveArtifacts(root).filter(path => readFileSync(path).includes(Buffer.from(sentinel))))
      .toEqual([])
  })

  it('recovers active-before-rekey and pending-after-rekey crash points', async () => {
    const root = await temporaryRoot()
    const safeStorage = fakeSafeStorage()
    const factory = new KnowledgeStoreFactory(root, safeStorage)
    const keyStore = new KnowledgeKeyStore(root, safeStorage)

    const before = await factory.open('owner-before-rekey')
    const pendingBefore = randomBytes(32)
    await keyStore.stagePending('owner-before-rekey', pendingBefore)
    await before.close()
    const recoveredBefore = await factory.open('owner-before-rekey')
    expect((await keyStore.loadExisting('owner-before-rekey'))?.pending).toBeUndefined()
    await recoveredBefore.close()

    const after = await factory.open('owner-after-rekey')
    const pendingAfter = randomBytes(32)
    await keyStore.stagePending('owner-after-rekey', pendingAfter)
    rekeyEncryptedKnowledgeDatabase(after.database, pendingAfter)
    await after.close()
    const recoveredAfter = await factory.open('owner-after-rekey')
    const promoted = await keyStore.loadExisting('owner-after-rekey')
    expect(promoted?.active.equals(pendingAfter)).toBe(true)
    expect(promoted?.pending).toBeUndefined()
    await recoveredAfter.close()

    pendingBefore.fill(0)
    pendingAfter.fill(0)
    promoted?.active.fill(0)
  })

  it('binds an object store to the owner while database key rotation preserves existing objects', async () => {
    const root = await temporaryRoot()
    const opened = await new KnowledgeStoreFactory(root, fakeSafeStorage()).open('owner-objects')
    const sentinel = Buffer.from(`FACTORY-OBJECT-${randomBytes(12).toString('hex')}`)
    const stored = await opened.objects.put(sentinel)

    await opened.rotateKey()

    expect(await opened.objects.read(stored.objectId)).toEqual(sentinel)
    await opened.close()
  })
})
