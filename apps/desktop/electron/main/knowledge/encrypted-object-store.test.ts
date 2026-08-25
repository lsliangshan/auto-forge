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
import type { DurableFileHandlePort, DurableFileSystemPort } from './key-store.js'

const directories: string[] = []

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(release => { resolve = release })
  return { promise, resolve }
}

function durableObjectFileSystem(options: { directorySyncError?: Error } = {}): {
  calls: string[]
  directorySyncStarted: Promise<void>
  releaseDirectorySync: () => void
  fileSystem: DurableFileSystemPort
} {
  const calls: string[] = []
  const started = deferred<void>()
  const release = deferred<void>()
  const temporary: DurableFileHandlePort = {
    writeFile: async () => { calls.push('write:temporary') },
    sync: async () => { calls.push('sync:temporary') },
    close: async () => { calls.push('close:temporary') },
  }
  const directory: DurableFileHandlePort = {
    writeFile: async () => { throw new Error('directory write is invalid') },
    sync: async () => {
      calls.push('sync:directory')
      started.resolve()
      await release.promise
      if (options.directorySyncError) throw options.directorySyncError
    },
    close: async () => { calls.push('close:directory') },
  }
  return {
    calls,
    directorySyncStarted: started.promise,
    releaseDirectorySync: () => release.resolve(),
    fileSystem: {
      mkdir: async () => { calls.push('mkdir') },
      open: async (_path, flags, mode) => {
        calls.push(`open:${flags}:${mode ?? 'none'}`)
        return flags === 'wx' ? temporary : directory
      },
      rename: async () => { calls.push('rename') },
      unlink: async () => { calls.push('unlink') },
    },
  }
}

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

  it('publishes a snapshot only after file sync, rename, and parent-directory sync in order', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'autoforge-object-durable-'))
    directories.push(directory)
    const sourcePath = join(directory, 'source.txt')
    await writeFile(sourcePath, 'durable encrypted source')
    const durable = durableObjectFileSystem()
    const input = {
      sourcePath,
      objectPath: join(directory, 'objects', 'snapshot.object'),
      userKey: randomBytes(32),
      fileSystem: durable.fileSystem,
    }
    let acknowledged = false
    const snapshot = createEncryptedObjectSnapshot(input).then(result => {
      acknowledged = true
      return result
    })
    const reachedDirectorySync = await Promise.race([
      durable.directorySyncStarted.then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 250)),
    ])
    const acknowledgedBeforeDirectorySync = acknowledged
    durable.releaseDirectorySync()
    await snapshot

    expect(reachedDirectorySync).toBe(true)
    expect(acknowledgedBeforeDirectorySync).toBe(false)
    expect(durable.calls).toEqual([
      'mkdir', 'open:wx:384', 'write:temporary', 'sync:temporary', 'close:temporary',
      'rename', 'open:r:none', 'sync:directory', 'close:directory',
    ])
    input.userKey.fill(0)
  })

  it('fails closed when parent-directory sync fails after rename', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'autoforge-object-durable-'))
    directories.push(directory)
    const sourcePath = join(directory, 'source.txt')
    await writeFile(sourcePath, 'directory sync failure')
    const failure = Object.assign(new Error('object directory sync failed'), { code: 'EIO' })
    const durable = durableObjectFileSystem({ directorySyncError: failure })
    const input = {
      sourcePath,
      objectPath: join(directory, 'objects', 'snapshot.object'),
      userKey: randomBytes(32),
      fileSystem: durable.fileSystem,
    }
    const snapshot = createEncryptedObjectSnapshot(input)
      .then(value => ({ value }), error => ({ error }))
    const reachedDirectorySync = await Promise.race([
      durable.directorySyncStarted.then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 250)),
    ])
    durable.releaseDirectorySync()
    const outcome = await snapshot

    expect(reachedDirectorySync).toBe(true)
    expect(outcome).toEqual({ error: failure })
    expect(durable.calls.indexOf('rename')).toBeLessThan(durable.calls.indexOf('sync:directory'))
    input.userKey.fill(0)
  })
})
