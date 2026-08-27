import { execFileSync } from 'node:child_process'
import { closeSync, constants, openSync } from 'node:fs'
import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  readKnowledgeImportFile,
  readOpenedKnowledgeImport,
  writeKnowledgeExportFile,
  type KnowledgeImportFileHandle,
} from './knowledge-file-io.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('knowledge file IO', () => {
  it.skipIf(process.platform === 'win32')('promptly rejects a FIFO without waiting for a writer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-knowledge-fifo-'))
    directories.push(root)
    const fifo = join(root, 'source.txt')
    execFileSync('mkfifo', [fifo])
    const reading = readKnowledgeImportFile(fifo, 1024)
    let timer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      reading.then(
        () => ({ type: 'resolved' as const }),
        error => ({ type: 'rejected' as const, error }),
      ),
      new Promise<{ type: 'timed-out' }>((resolvePromise) => {
        timer = setTimeout(() => resolvePromise({ type: 'timed-out' }), 100)
      }),
    ])
    if (timer) clearTimeout(timer)

    if (outcome.type === 'timed-out') {
      const writer = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK)
      closeSync(writer)
      await reading.catch(() => undefined)
    }
    expect(outcome.type).toBe('rejected')
  })

  it.skipIf(process.platform === 'win32')('uses nonblocking no-follow flags and closes a rejected special file', async () => {
    const close = vi.fn(async () => undefined)
    const read = vi.fn(async () => ({ bytesRead: 0 }))
    const openFile = vi.fn(async () => ({
      stat: async () => ({
        size: 0, dev: 1, ino: 2, mtimeMs: 1, ctimeMs: 1, isFile: () => false,
      }),
      read,
      close,
    }))

    await expect(readKnowledgeImportFile('/tmp/special', 1024, openFile)).rejects.toThrow(/invalid/i)
    expect(openFile).toHaveBeenCalledWith(
      '/tmp/special',
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    )
    expect(read).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it('reads through one no-follow descriptor and rejects symlinks and the incremental hard limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-knowledge-file-'))
    directories.push(root)
    const source = join(root, 'source.txt')
    const alias = join(root, 'alias.txt')
    await writeFile(source, '12345')
    await symlink(source, alias)

    await expect(readKnowledgeImportFile(source, 4)).rejects.toThrow(/limit|invalid/i)
    await expect(readKnowledgeImportFile(alias, 10)).rejects.toThrow()
    await expect(readKnowledgeImportFile(source, 5)).resolves.toEqual(Buffer.from('12345'))
  })

  it('rejects growth and same-size metadata changes observed on the opened descriptor at EOF', async () => {
    for (const after of [
      { size: 5, dev: 1, ino: 2, mtimeMs: 1, ctimeMs: 2 },
      { size: 4, dev: 1, ino: 2, mtimeMs: 2, ctimeMs: 2 },
    ]) {
      let statCalls = 0
      let readCalls = 0
      const handle: KnowledgeImportFileHandle = {
        stat: async () => ({
          ...(statCalls++ === 0
            ? { size: 4, dev: 1, ino: 2, mtimeMs: 1, ctimeMs: 2 }
            : after),
          isFile: () => true,
        }),
        read: async (buffer) => {
          if (readCalls++ > 0) return { bytesRead: 0 }
          Buffer.from('data').copy(buffer)
          return { bytesRead: 4 }
        },
        close: async () => undefined,
      }

      await expect(readOpenedKnowledgeImport(handle, 10)).rejects.toThrow(/changed/i)
    }
  })

  it('enforces the limit on incremental reads and clears its reusable read buffer on failure', async () => {
    let scratch: Buffer | undefined
    let reads = 0
    const handle: KnowledgeImportFileHandle = {
      stat: async () => ({
        size: 4, dev: 1, ino: 2, mtimeMs: 1, ctimeMs: 1, isFile: () => true,
      }),
      read: async (buffer) => {
        scratch = buffer
        if (reads++ > 0) return { bytesRead: 0 }
        Buffer.from('12345').copy(buffer)
        return { bytesRead: 5 }
      },
      close: async () => undefined,
    }

    await expect(readOpenedKnowledgeImport(handle, 4)).rejects.toThrow(/limit/i)
    expect(scratch?.every(byte => byte === 0)).toBe(true)
  })

  it('atomically overwrites regular targets with mode 0600 and rejects symbolic targets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-knowledge-export-'))
    directories.push(root)
    const target = join(root, 'export.zip')
    await writeFile(target, 'old', { mode: 0o644 })
    await writeKnowledgeExportFile(target, Buffer.from('new archive'))
    expect(await readFile(target, 'utf8')).toBe('new archive')
    if (process.platform !== 'win32') expect((await lstat(target)).mode & 0o777).toBe(0o600)

    const victim = join(root, 'victim.zip')
    const alias = join(root, 'alias.zip')
    await writeFile(victim, 'victim')
    await symlink(victim, alias)
    await expect(writeKnowledgeExportFile(alias, Buffer.from('attack'))).rejects.toThrow(/unsafe/i)
    expect(await readFile(victim, 'utf8')).toBe('victim')
    expect((await readdir(root)).some(name => name.startsWith('.autoforge-knowledge-'))).toBe(false)
  })
})
