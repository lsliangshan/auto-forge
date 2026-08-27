import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KnowledgeObjectStore } from './encrypted-object-store.js'

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'autoforge-knowledge-objects-'))
  roots.push(root)
  return root
}

function collectFiles(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? collectFiles(path) : [path]
  })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('KnowledgeObjectStore', () => {
  it('round-trips AEAD objects with random IDs and random file keys without plaintext artifacts', async () => {
    const root = await temporaryRoot()
    const masterKey = randomBytes(32)
    const store = new KnowledgeObjectStore(root, masterKey)
    const sentinel = Buffer.from(`OBJECT-SENTINEL-${randomBytes(18).toString('hex')}-知识库`)

    const first = await store.put(sentinel)
    const second = await store.put(sentinel)

    expect(first.objectId).not.toBe(second.objectId)
    expect(await store.read(first.objectId)).toEqual(sentinel)
    expect(await store.read(second.objectId)).toEqual(sentinel)
    const firstBytes = await readFile(join(root, `${first.objectId}.afobj`))
    const secondBytes = await readFile(join(root, `${second.objectId}.afobj`))
    expect(firstBytes.equals(secondBytes)).toBe(false)
    if (process.platform !== 'win32') {
      expect((await stat(root)).mode & 0o777).toBe(0o700)
      expect((await stat(join(root, `${first.objectId}.afobj`))).mode & 0o777).toBe(0o600)
    }
    expect(collectFiles(root).filter(path => readFileSync(path).includes(sentinel))).toEqual([])
    expect(collectFiles(root).filter(path => /(tmp|temp|recovery)/i.test(basename(path)))).toEqual([])

    store.close()
    masterKey.fill(0)
  })

  it('fails authentication for the wrong owner key, tampering, and an object renamed to another ID', async () => {
    const root = await temporaryRoot()
    const masterKey = randomBytes(32)
    const store = new KnowledgeObjectStore(root, masterKey)
    const stored = await store.put(Buffer.from('authenticated payload'))

    const wrongOwner = new KnowledgeObjectStore(root, randomBytes(32))
    await expect(wrongOwner.read(stored.objectId)).rejects.toThrow(/authenticate|object key/i)
    wrongOwner.close()

    const originalPath = join(root, `${stored.objectId}.afobj`)
    const tampered = await readFile(originalPath)
    tampered[tampered.length - 1] ^= 1
    await writeFile(originalPath, tampered)
    await expect(store.read(stored.objectId)).rejects.toThrow(/authenticate|object/i)

    const replacement = await store.put(Buffer.from('domain-bound payload'))
    const renamedId = randomBytes(16).toString('hex')
    await copyFile(join(root, `${replacement.objectId}.afobj`), join(root, `${renamedId}.afobj`))
    await expect(store.read(renamedId)).rejects.toThrow(/authenticate|object/i)

    store.close()
    masterKey.fill(0)
  })

  it('deletes only a validated object ID and makes repeated deletion idempotent', async () => {
    const root = await temporaryRoot()
    const store = new KnowledgeObjectStore(root, randomBytes(32))
    const stored = await store.put(Buffer.from('delete me'))

    await store.delete(stored.objectId)
    await store.delete(stored.objectId)
    await expect(store.read(stored.objectId)).rejects.toThrow(/unavailable/i)
    await expect(store.delete('../escape')).rejects.toThrow(/invalid object/i)

    store.close()
  })
})
