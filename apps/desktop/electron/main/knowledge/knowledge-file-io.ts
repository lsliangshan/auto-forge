import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, open, rename, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const READ_CHUNK_BYTES = 64 * 1024

interface StableFileStat {
  readonly size: number
  readonly dev: number
  readonly ino: number
  readonly mtimeMs: number
  readonly ctimeMs: number
  isFile(): boolean
}

export interface KnowledgeImportFileHandle {
  stat(): Promise<StableFileStat>
  read(buffer: Buffer, offset: number, length: number, position: number | null): Promise<{ bytesRead: number }>
  close(): Promise<void>
}

function changed(before: StableFileStat, after: StableFileStat): boolean {
  return before.size !== after.size
    || before.dev !== after.dev
    || before.ino !== after.ino
    || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs
}

/** Reads one already-open file descriptor, revalidating that same descriptor at EOF. */
export async function readOpenedKnowledgeImport(
  handle: KnowledgeImportFileHandle,
  maxBytes: number,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Knowledge import limit is invalid')
  const chunks: Buffer[] = []
  const scratch = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes + 1))
  let result: Buffer | undefined
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size < 1 || before.size > maxBytes) {
      throw new Error('Knowledge import file is invalid')
    }
    let total = 0
    while (true) {
      const { bytesRead } = await handle.read(scratch, 0, scratch.length, null)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > maxBytes) throw new Error('Knowledge import exceeds its limit')
      chunks.push(Buffer.from(scratch.subarray(0, bytesRead)))
    }
    const after = await handle.stat()
    if (changed(before, after) || total !== after.size) {
      throw new Error('Knowledge import file changed while reading')
    }
    result = Buffer.concat(chunks, total)
    return result
  } catch (error) {
    result?.fill(0)
    throw error
  } finally {
    scratch.fill(0)
    for (const chunk of chunks) chunk.fill(0)
  }
}

export async function readKnowledgeImportFile(path: string, maxBytes: number): Promise<Buffer> {
  const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW
  const handle = await open(path, constants.O_RDONLY | noFollow) as unknown as KnowledgeImportFileHandle
  let contents: Buffer | undefined
  let failure: unknown
  let failed = false
  try {
    contents = await readOpenedKnowledgeImport(handle, maxBytes)
  } catch (error) {
    failure = error
    failed = true
  }
  try {
    await handle.close()
  } catch (error) {
    if (!failed) {
      failure = error
      failed = true
    }
  }
  if (failed) {
    contents?.fill(0)
    throw failure
  }
  return contents!
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function rejectSymbolicTarget(path: string): Promise<void> {
  try {
    const existing = await lstat(path)
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error('Knowledge export target is unsafe')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** Publishes a private archive atomically while preserving regular-file overwrite behavior. */
export async function writeKnowledgeExportFile(path: string, contents: Buffer): Promise<void> {
  const directory = dirname(path)
  const temporaryPath = join(directory, `.autoforge-knowledge-${randomUUID()}.tmp`)
  const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW
  const handle = await open(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
    0o600,
  ) as FileHandle
  try {
    await handle.writeFile(contents)
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => undefined)
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
  try {
    await handle.close()
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
  try {
    await rejectSymbolicTarget(path)
    await rename(temporaryPath, path)
    if (process.platform !== 'win32') await chmod(path, 0o600)
    await syncDirectory(directory)
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
}
