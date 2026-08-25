import { describe, expect, it } from 'vitest'
import {
  removeFileDurably,
  writeFileDurably,
  type DurableFileHandlePort,
  type DurableFileSystemPort,
} from './key-store.js'

function fakeFileSystem(options: {
  fileSyncError?: Error
  directorySyncError?: Error
} = {}): { calls: string[]; fileSystem: DurableFileSystemPort } {
  const calls: string[] = []
  const temporaryHandle: DurableFileHandlePort = {
    writeFile: async () => { calls.push('write:temporary') },
    sync: async () => {
      calls.push('sync:temporary')
      if (options.fileSyncError) throw options.fileSyncError
    },
    close: async () => { calls.push('close:temporary') },
  }
  const directoryHandle: DurableFileHandlePort = {
    writeFile: async () => { throw new Error('directory write is invalid') },
    sync: async () => {
      calls.push('sync:directory')
      if (options.directorySyncError) throw options.directorySyncError
    },
    close: async () => { calls.push('close:directory') },
  }

  return {
    calls,
    fileSystem: {
      mkdir: async () => { calls.push('mkdir') },
      open: async (_path, flags, mode) => {
        calls.push(`open:${flags}:${mode ?? 'none'}`)
        return flags === 'wx' ? temporaryHandle : directoryHandle
      },
      rename: async () => { calls.push('rename') },
      unlink: async () => { calls.push('unlink') },
    },
  }
}

describe('durable knowledge key records', () => {
  it('syncs the temporary file before rename and the parent directory after rename', async () => {
    const { calls, fileSystem } = fakeFileSystem()

    await writeFileDurably('/records/knowledge-key.json', '{"version":1}', fileSystem)

    expect(calls).toEqual([
      'mkdir',
      'open:wx:384',
      'write:temporary',
      'sync:temporary',
      'close:temporary',
      'rename',
      'open:r:none',
      'sync:directory',
      'close:directory',
    ])
  })

  it('does not rename a key record when the temporary-file sync fails', async () => {
    const failure = new Error('temporary sync failed')
    const { calls, fileSystem } = fakeFileSystem({ fileSyncError: failure })

    await expect(writeFileDurably('/records/knowledge-key.json', '{}', fileSystem))
      .rejects.toBe(failure)
    expect(calls).toEqual([
      'mkdir',
      'open:wx:384',
      'write:temporary',
      'sync:temporary',
      'close:temporary',
      'unlink',
    ])
  })

  it('propagates a parent-directory sync failure after rename', async () => {
    const failure = Object.assign(new Error('directory sync failed'), { code: 'EIO' })
    const { calls, fileSystem } = fakeFileSystem({ directorySyncError: failure })

    await expect(writeFileDurably('/records/knowledge-key.json', '{}', fileSystem))
      .rejects.toBe(failure)
    expect(calls).toContain('rename')
    expect(calls.indexOf('rename')).toBeLessThan(calls.indexOf('sync:directory'))
  })

  it('syncs the parent directory when retry observes an already-unlinked file', async () => {
    const { calls, fileSystem } = fakeFileSystem()
    fileSystem.unlink = async () => {
      calls.push('unlink')
      throw Object.assign(new Error('already removed'), { code: 'ENOENT' })
    }

    await removeFileDurably('/records/orphan.afobj', fileSystem)

    expect(calls).toEqual([
      'unlink',
      'open:r:none',
      'sync:directory',
      'close:directory',
    ])
  })
})
