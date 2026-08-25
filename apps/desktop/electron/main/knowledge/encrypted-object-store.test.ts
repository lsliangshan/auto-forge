import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createEncryptedObjectSnapshot,
  readEncryptedObjectSnapshot,
  unwrapSnapshotFileKey,
} from './encrypted-object-store.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async path => (await import('node:fs/promises')).rm(path, { recursive: true, force: true })))
})

describe('encrypted object snapshots', () => {
  it('stores no source plaintext and wraps a random file key with the user key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'autoforge-object-'))
    directories.push(directory)
    const sourcePath = join(directory, 'source.txt')
    const objectPath = join(directory, 'snapshot.object')
    const sentinel = 'OBJECT_SENTINEL_知识库'
    const userKey = randomBytes(32)
    await writeFile(sourcePath, sentinel)

    const first = await createEncryptedObjectSnapshot({ sourcePath, objectPath, userKey })
    const encrypted = await readFile(objectPath)
    expect(encrypted.includes(Buffer.from(sentinel))).toBe(false)
    expect(first.wrappedFileKey.includes(Buffer.from(sentinel))).toBe(false)

    const fileKey = unwrapSnapshotFileKey(first.wrappedFileKey, userKey)
    expect(fileKey).toHaveLength(32)
    expect(await readEncryptedObjectSnapshot(objectPath)).toEqual(encrypted)
    fileKey.fill(0)
    userKey.fill(0)
  })

  it('fails closed for a wrong user key, tampered object, oversized source, and symlink source', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'autoforge-object-'))
    directories.push(directory)
    const sourcePath = join(directory, 'source.txt')
    const objectPath = join(directory, 'snapshot.object')
    const userKey = randomBytes(32)
    await writeFile(sourcePath, 'safe source')
    const snapshot = await createEncryptedObjectSnapshot({ sourcePath, objectPath, userKey })
    expect(() => unwrapSnapshotFileKey(snapshot.wrappedFileKey, randomBytes(32))).toThrow(/authenticate|key/i)

    const tampered = await readFile(objectPath)
    tampered[tampered.length - 1] ^= 1
    await writeFile(objectPath, tampered)
    expect(await readEncryptedObjectSnapshot(objectPath)).toEqual(tampered)

    await expect(createEncryptedObjectSnapshot({ sourcePath, objectPath, userKey, maxSourceBytes: 4 })).rejects.toThrow(/limit/i)
    const linkPath = join(directory, 'source-link.txt')
    await symlink(sourcePath, linkPath)
    await expect(createEncryptedObjectSnapshot({ sourcePath: linkPath, objectPath, userKey })).rejects.toThrow(/regular|symbolic/i)
    userKey.fill(0)
  })
})
