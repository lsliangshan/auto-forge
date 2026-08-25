import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SafeStoragePort } from '../security/secret-store.js'
import {
  openEncryptedDatabase,
  openUserKnowledgeDatabase,
  rekeyEncryptedDatabase,
} from './encrypted-database.js'
import { KnowledgeKeyStore } from './key-store.js'

const testDirectories: string[] = []
const wrappingMask = Buffer.from('f31a90c577924cdb82797021e9c0416b', 'hex')

function fakeSafeStorage(available = true, shouldReEncrypt = false): SafeStoragePort {
  let encryptionCount = 0
  return {
    isAvailable: async () => available,
    encrypt: async (value) => {
      const cleartext = Buffer.from(value, 'base64')
      const nonce = encryptionCount++ & 0xff
      return Buffer.from([
        nonce,
        ...cleartext.map((byte, index) => byte ^ wrappingMask[index % wrappingMask.length]! ^ nonce),
      ])
    },
    decrypt: async (value) => {
      const nonce = value[0]!
      const cleartext = Buffer.from(
        value.subarray(1).map((byte, index) => byte ^ wrappingMask[index % wrappingMask.length]! ^ nonce),
      )
      return { value: cleartext.toString('base64'), shouldReEncrypt }
    },
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'autoforge-knowledge-'))
  testDirectories.push(directory)
  return directory
}

function collectFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? collectFiles(path) : [path]
  })
}

function filesContaining(directory: string, value: string): string[] {
  return collectFiles(directory).filter((path) => readFileSync(path).includes(Buffer.from(value)))
}

afterEach(() => {
  for (const directory of testDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('encrypted knowledge database', () => {
  it('creates isolated per-user encrypted stores and reopens only with the correct key', async () => {
    const rootDirectory = await temporaryDirectory()
    const first = await openUserKnowledgeDatabase({
      rootDirectory,
      userId: 'user/alice@example.test',
      safeStorage: fakeSafeStorage(),
    })
    const databasePath = first.databasePath
    const keyRecordPath = first.keyRecordPath
    const key = await new KnowledgeKeyStore(keyRecordPath, fakeSafeStorage()).loadActiveKey()
    first.close()

    const reopened = openEncryptedDatabase(databasePath, key)
    expect(reopened.prepare('SELECT count(*) AS count FROM knowledge_bases').get()).toEqual({ count: 0 })
    reopened.close()

    expect(() => openEncryptedDatabase(databasePath, randomBytes(32))).toThrow(/encrypted|key|database/i)
    expect(databasePath).not.toContain('alice@example.test')
    expect(keyRecordPath).not.toContain('alice@example.test')
  })

  it('fails closed when secure storage or an existing database key is unavailable', async () => {
    const rootDirectory = await temporaryDirectory()

    await expect(openUserKnowledgeDatabase({
      rootDirectory,
      userId: 'user_secure_storage_missing',
      safeStorage: fakeSafeStorage(false),
    })).rejects.toThrow(/secure storage.*unavailable/i)

    const opened = await openUserKnowledgeDatabase({
      rootDirectory,
      userId: 'user_key_missing',
      safeStorage: fakeSafeStorage(),
    })
    const { keyRecordPath } = opened
    opened.close()
    unlinkSync(keyRecordPath)

    await expect(openUserKnowledgeDatabase({
      rootDirectory,
      userId: 'user_key_missing',
      safeStorage: fakeSafeStorage(),
    })).rejects.toThrow(/key.*unavailable/i)
  })

  it('rewraps an active key when secure storage requests migration', async () => {
    const directory = await temporaryDirectory()
    const recordPath = join(directory, 'knowledge-key.json')
    const keyStore = new KnowledgeKeyStore(recordPath, fakeSafeStorage(true, true))
    const created = await keyStore.createActiveKey()
    created.fill(0)
    const before = readFileSync(recordPath, 'utf8')

    const loaded = await keyStore.loadActiveKey()
    loaded.fill(0)

    expect(readFileSync(recordPath, 'utf8')).not.toBe(before)
  })

  it('sets memory-only temp storage and proves FTS5 trigram search against external content', async () => {
    const opened = await openUserKnowledgeDatabase({
      rootDirectory: await temporaryDirectory(),
      userId: 'user_fts',
      safeStorage: fakeSafeStorage(),
    })

    expect(opened.capabilities.tempStore).toBe('memory')
    expect(opened.capabilities.fts5).toBe(true)
    expect(opened.capabilities.trigram).toBe(true)
    expect(opened.database.pragma('temp_store', { simple: true })).toBe(2)

    opened.database.exec(`
      INSERT INTO knowledge_bases (id, name, created_at, updated_at)
      VALUES ('kb_fts', '测试知识库', 1, 1);
      INSERT INTO documents (id, knowledge_base_id, name, mime_type, created_at, updated_at)
      VALUES ('document_fts', 'kb_fts', 'source.txt', 'text/plain', 1, 1);
      INSERT INTO document_versions (id, document_id, version_number, status, content_hash, created_at)
      VALUES ('version_fts', 'document_fts', 1, 'ready', 'hash', 1);
      INSERT INTO knowledge_blocks (id, version_id, ordinal, kind, text, coordinates_json)
      VALUES ('block_fts', 'version_fts', 0, 'paragraph', '橙色星云测试标记', '{}');
      INSERT INTO kb_chunks (id, knowledge_base_id, document_id, version_id, block_id, ordinal, body, coordinates_json)
      VALUES ('chunk_fts', 'kb_fts', 'document_fts', 'version_fts', 'block_fts', 0, '橙色星云测试标记', '{}');
    `)

    expect(opened.database.prepare(`
      SELECT kb_chunks.id, kb_chunks.body
      FROM kb_chunks_fts
      JOIN kb_chunks ON kb_chunks.rowid = kb_chunks_fts.rowid
      WHERE kb_chunks_fts MATCH ?
    `).all('"橙色星云"')).toEqual([{ id: 'chunk_fts', body: '橙色星云测试标记' }])
    opened.close()
  })

  it('contains the complete local lifecycle schema', async () => {
    const opened = await openUserKnowledgeDatabase({
      rootDirectory: await temporaryDirectory(),
      userId: 'user_schema',
      safeStorage: fakeSafeStorage(),
    })
    const objects = opened.database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as Array<{ name: string }>

    expect(objects.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'conflicts',
      'document_versions',
      'documents',
      'jobs',
      'kb_chunks',
      'kb_chunks_fts',
      'knowledge_bases',
      'knowledge_blocks',
      'sync_cursors',
      'tombstones',
    ]))
    opened.close()
  })

  it('rolls back content and FTS rows atomically and checkpoints encrypted WAL state', async () => {
    const opened = await openUserKnowledgeDatabase({
      rootDirectory: await temporaryDirectory(),
      userId: 'user_transaction',
      safeStorage: fakeSafeStorage(),
    })
    expect(opened.database.pragma('journal_mode', { simple: true })).toBe('wal')
    opened.database.pragma('wal_autocheckpoint = 0')
    opened.database.exec(`
      INSERT INTO knowledge_bases (id, name, created_at, updated_at)
      VALUES ('kb_tx', '事务知识库', 1, 1);
      INSERT INTO documents (id, knowledge_base_id, name, mime_type, created_at, updated_at)
      VALUES ('document_tx', 'kb_tx', 'tx.txt', 'text/plain', 1, 1);
      INSERT INTO document_versions (id, document_id, version_number, status, content_hash, created_at)
      VALUES ('version_tx', 'document_tx', 1, 'ready', 'hash', 1);
      INSERT INTO knowledge_blocks (id, version_id, ordinal, kind, text, coordinates_json)
      VALUES ('block_tx', 'version_tx', 0, 'paragraph', 'rollback block', '{}');
    `)

    expect(() => opened.database.transaction(() => {
      opened.database.prepare(`
        INSERT INTO kb_chunks
          (id, knowledge_base_id, document_id, version_id, block_id, ordinal, body, coordinates_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('chunk_rollback', 'kb_tx', 'document_tx', 'version_tx', 'block_tx', 0, 'rollback sentinel', '{}')
      throw new Error('abort transaction')
    })()).toThrow('abort transaction')

    expect(opened.database.prepare('SELECT count(*) AS count FROM kb_chunks').get()).toEqual({ count: 0 })
    expect(opened.database.prepare('SELECT count(*) AS count FROM kb_chunks_fts').get()).toEqual({ count: 0 })

    opened.database.prepare(`
      INSERT INTO kb_chunks
        (id, knowledge_base_id, document_id, version_id, block_id, ordinal, body, coordinates_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('chunk_commit', 'kb_tx', 'document_tx', 'version_tx', 'block_tx', 0, 'checkpoint sentinel', '{}')
    expect(existsSync(`${opened.databasePath}-wal`)).toBe(true)
    const checkpoint = opened.database.pragma('wal_checkpoint(TRUNCATE)', { simple: false }) as Array<{
      busy: number
      log: number
      checkpointed: number
    }>
    expect(checkpoint).toEqual([{ busy: 0, log: 0, checkpointed: 0 }])
    opened.close()
  })

  it('recovers both crash points of the active/pending rekey protocol', async () => {
    const safeStorage = fakeSafeStorage()
    const rootDirectory = await temporaryDirectory()

    const beforeRekey = await openUserKnowledgeDatabase({ rootDirectory, userId: 'before_rekey', safeStorage })
    const stagedBefore = randomBytes(32)
    await new KnowledgeKeyStore(beforeRekey.keyRecordPath, safeStorage).stagePendingKey(stagedBefore)
    beforeRekey.close()
    const recoveredBefore = await openUserKnowledgeDatabase({ rootDirectory, userId: 'before_rekey', safeStorage })
    expect(await new KnowledgeKeyStore(recoveredBefore.keyRecordPath, safeStorage).loadPendingKey()).toBeUndefined()
    recoveredBefore.close()

    const afterRekey = await openUserKnowledgeDatabase({ rootDirectory, userId: 'after_rekey', safeStorage })
    const stagedAfter = randomBytes(32)
    await new KnowledgeKeyStore(afterRekey.keyRecordPath, safeStorage).stagePendingKey(stagedAfter)
    rekeyEncryptedDatabase(afterRekey.database, stagedAfter)
    afterRekey.close()
    const recoveredAfter = await openUserKnowledgeDatabase({ rootDirectory, userId: 'after_rekey', safeStorage })
    const activeAfter = await new KnowledgeKeyStore(recoveredAfter.keyRecordPath, safeStorage).loadActiveKey()
    expect(activeAfter.equals(stagedAfter)).toBe(true)
    expect(await new KnowledgeKeyStore(recoveredAfter.keyRecordPath, safeStorage).loadPendingKey()).toBeUndefined()
    recoveredAfter.close()
  })

  it('rotates through pending state and leaves no plaintext in database artifacts', async () => {
    const directory = await temporaryDirectory()
    const opened = await openUserKnowledgeDatabase({
      rootDirectory: directory,
      userId: 'user_plaintext_probe',
      safeStorage: fakeSafeStorage(),
    })
    const sentinel = 'SENTINEL-PLAIN-TEXT-7f4c9182'
    opened.database.pragma('wal_autocheckpoint = 0')
    opened.database.exec(`
      INSERT INTO knowledge_bases (id, name, created_at, updated_at)
      VALUES ('kb_sentinel', '${sentinel}', 1, 1);
    `)
    expect(existsSync(`${opened.databasePath}-wal`)).toBe(true)
    expect(filesContaining(directory, sentinel)).toEqual([])
    await opened.rotateKey()
    opened.database.pragma('wal_checkpoint(TRUNCATE)')
    opened.close()

    const leakedFiles = filesContaining(directory, sentinel).filter((path) => {
      return /(sqlite|wal|journal|shm|tmp|temp)/i.test(basename(path))
    })
    expect(leakedFiles).toEqual([])
  })
})
