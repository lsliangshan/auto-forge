import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SafeStoragePort } from '../security/secret-store.js'
import { KnowledgeKeyStore } from './key-store.js'

const roots: string[] = []
const wrappingMask = Buffer.from('67f64f3eb4a85dedbce6132d63159fe1', 'hex')

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'autoforge-knowledge-keys-'))
  roots.push(root)
  return root
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

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('KnowledgeKeyStore', () => {
  it('creates one owner-bound active key under a hashed per-user root', async () => {
    const root = await temporaryRoot()
    const store = new KnowledgeKeyStore(root, fakeSafeStorage())

    const first = await store.loadOrCreate('user/alice@example.test')
    const second = await store.loadOrCreate('user/alice@example.test')

    expect(first.active.equals(second.active)).toBe(true)
    expect(first.active).toHaveLength(32)
    expect(first.ownerRoot).not.toContain('alice@example.test')
    expect(first.recordPath).not.toContain('alice@example.test')
    expect(JSON.parse(await readFile(first.recordPath, 'utf8'))).toMatchObject({ version: 1 })
    first.active.fill(0)
    first.objectKey.fill(0)
    second.active.fill(0)
    second.objectKey.fill(0)
  })

  it('fails closed without secure storage and rejects a wrapped key copied across owners', async () => {
    const root = await temporaryRoot()
    await expect(new KnowledgeKeyStore(root, fakeSafeStorage(false)).loadOrCreate('owner-a'))
      .rejects.toThrow(/secure storage.*unavailable/i)

    const store = new KnowledgeKeyStore(root, fakeSafeStorage())
    const alice = await store.loadOrCreate('owner-a')
    const bob = await store.loadOrCreate('owner-b')
    await copyFile(alice.recordPath, bob.recordPath)

    await expect(store.loadOrCreate('owner-b')).rejects.toThrow(/owner.*binding/i)
    alice.active.fill(0)
    alice.objectKey.fill(0)
    bob.active.fill(0)
    bob.objectKey.fill(0)
  })

  it('durably stages, promotes, and discards a pending key slot', async () => {
    const root = await temporaryRoot()
    const store = new KnowledgeKeyStore(root, fakeSafeStorage())
    const created = await store.loadOrCreate('owner-slots')
    const pending = Buffer.alloc(32, 0xa7)

    await store.stagePending('owner-slots', pending)
    const staged = await store.loadExisting('owner-slots')
    expect(staged?.active.equals(created.active)).toBe(true)
    expect(staged?.pending?.equals(pending)).toBe(true)

    await store.promotePending('owner-slots')
    const promoted = await store.loadExisting('owner-slots')
    expect(promoted?.active.equals(pending)).toBe(true)
    expect(promoted?.pending).toBeUndefined()

    await store.stagePending('owner-slots', Buffer.alloc(32, 0x4c))
    await store.discardPending('owner-slots')
    expect((await store.loadExisting('owner-slots'))?.pending).toBeUndefined()

    created.active.fill(0)
    created.objectKey.fill(0)
    staged?.active.fill(0)
    staged?.objectKey.fill(0)
    staged?.pending?.fill(0)
    promoted?.active.fill(0)
    promoted?.objectKey.fill(0)
    pending.fill(0)
  })

  it('atomically rewraps every key slot when secure storage requests migration', async () => {
    const root = await temporaryRoot()
    let encryptions = 0
    const safeStorage: SafeStoragePort = {
      isAvailable: async () => true,
      encrypt: async (value) => {
        encryptions += 1
        return Buffer.from(value, 'utf8')
      },
      decrypt: async value => ({ value: value.toString('utf8'), shouldReEncrypt: true }),
    }
    const store = new KnowledgeKeyStore(root, safeStorage)
    const created = await store.loadOrCreate('owner-rewrap')
    expect(encryptions).toBe(2)

    const loaded = await store.loadExisting('owner-rewrap')

    expect(encryptions).toBe(4)
    expect(loaded?.active.equals(created.active)).toBe(true)
    expect(loaded?.objectKey.equals(created.objectKey)).toBe(true)
    created.active.fill(0)
    created.objectKey.fill(0)
    loaded?.active.fill(0)
    loaded?.objectKey.fill(0)
  })
})
