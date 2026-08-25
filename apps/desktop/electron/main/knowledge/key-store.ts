import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import process from 'node:process'
import type { SafeStoragePort } from '../security/secret-store.js'

interface WrappedKeyRecord {
  readonly version: 1
  readonly active: string
  readonly pending?: string
}

const DATABASE_KEY_BYTES = 32

export interface DurableFileHandlePort {
  writeFile(value: string | Uint8Array): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}

export interface DurableFileSystemPort {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<void>
  open(path: string, flags: 'wx' | 'r', mode?: number): Promise<DurableFileHandlePort>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
}

export type DurableRecordWriter = (recordPath: string, serialized: string) => Promise<void>

export interface KnowledgeKeyStorePort {
  exists(): boolean
  createActiveKey(): Promise<Buffer>
  loadActiveKey(): Promise<Buffer>
  loadPendingKey(): Promise<Buffer | undefined>
  stagePendingKey(key: Buffer): Promise<void>
  promotePendingKey(): Promise<void>
  discardPendingKey(): Promise<void>
}

const nodeFileSystem: DurableFileSystemPort = {
  mkdir: async (path, options) => { await mkdir(path, options) },
  open,
  rename,
  unlink,
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EINVAL'
    || code === 'ENOSYS'
    || code === 'ENOTSUP'
    || (process.platform === 'win32' && (code === 'EPERM' || code === 'EISDIR'))
}

async function syncDirectory(directory: string, fileSystem: DurableFileSystemPort): Promise<void> {
  let handle: DurableFileHandlePort | undefined
  try {
    handle = await fileSystem.open(directory, 'r')
    await handle.sync()
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error
  } finally {
    await handle?.close()
  }
}

export async function writeFileDurably(
  recordPath: string,
  contents: string | Uint8Array,
  fileSystem: DurableFileSystemPort = nodeFileSystem,
): Promise<void> {
  const directory = dirname(recordPath)
  const temporaryPath = `${recordPath}.${randomUUID()}.tmp`
  await fileSystem.mkdir(directory, { recursive: true, mode: 0o700 })
  let renamed = false
  try {
    const handle = await fileSystem.open(temporaryPath, 'wx', 0o600)
    try {
      await handle.writeFile(contents)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fileSystem.rename(temporaryPath, recordPath)
    renamed = true
    await syncDirectory(directory, fileSystem)
  } catch (error) {
    if (!renamed) {
      try {
        await fileSystem.unlink(temporaryPath)
      } catch {
        // The original persistence error is authoritative.
      }
    }
    throw error
  }
}

export async function removeFileDurably(
  path: string,
  fileSystem: DurableFileSystemPort = nodeFileSystem,
): Promise<void> {
  try {
    await fileSystem.unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await syncDirectory(dirname(path), fileSystem)
}

function parseRecord(serialized: string): WrappedKeyRecord {
  const value: unknown = JSON.parse(serialized)
  if (!value || typeof value !== 'object') throw new Error('Knowledge key record is invalid')
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (
    record.version !== 1
    || typeof record.active !== 'string'
    || (record.pending !== undefined && typeof record.pending !== 'string')
    || keys.some((key) => !['version', 'active', 'pending'].includes(key))
  ) {
    throw new Error('Knowledge key record is invalid')
  }
  return record as unknown as WrappedKeyRecord
}

export class KnowledgeKeyStore implements KnowledgeKeyStorePort {
  constructor(
    readonly recordPath: string,
    private readonly safeStorage: SafeStoragePort,
    private readonly persistRecord: DurableRecordWriter = writeFileDurably,
  ) {}

  exists(): boolean {
    return existsSync(this.recordPath)
  }

  async createActiveKey(): Promise<Buffer> {
    if (this.exists()) throw new Error('Knowledge key record already exists')
    await this.requireSecureStorage()
    const key = randomBytes(DATABASE_KEY_BYTES)
    try {
      const active = await this.wrap(key)
      await this.writeRecord({ version: 1, active })
      return Buffer.from(key)
    } finally {
      key.fill(0)
    }
  }

  async loadActiveKey(): Promise<Buffer> {
    const record = await this.readRecord()
    const decrypted = await this.unwrap(record.active)
    if (decrypted.shouldReEncrypt) {
      try {
        await this.writeRecord({ ...record, active: await this.wrap(decrypted.key) })
      } catch (error) {
        decrypted.key.fill(0)
        throw error
      }
    }
    return decrypted.key
  }

  async loadPendingKey(): Promise<Buffer | undefined> {
    const record = await this.readRecord()
    if (record.pending === undefined) return undefined
    const decrypted = await this.unwrap(record.pending)
    if (decrypted.shouldReEncrypt) {
      try {
        await this.writeRecord({ ...record, pending: await this.wrap(decrypted.key) })
      } catch (error) {
        decrypted.key.fill(0)
        throw error
      }
    }
    return decrypted.key
  }

  async stagePendingKey(key: Buffer): Promise<void> {
    if (key.length !== DATABASE_KEY_BYTES) throw new Error('Knowledge database key must be 32 bytes')
    const record = await this.readRecord()
    await this.writeRecord({ ...record, pending: await this.wrap(key) })
  }

  async promotePendingKey(): Promise<void> {
    const record = await this.readRecord()
    if (!record.pending) throw new Error('Knowledge pending key is unavailable')
    await this.writeRecord({ version: 1, active: record.pending })
  }

  async discardPendingKey(): Promise<void> {
    const record = await this.readRecord()
    await this.writeRecord({ version: 1, active: record.active })
  }

  private async readRecord(): Promise<WrappedKeyRecord> {
    await this.requireSecureStorage()
    try {
      return parseRecord(await readFile(this.recordPath, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('Knowledge database key is unavailable', { cause: error })
      }
      throw error
    }
  }

  private async requireSecureStorage(): Promise<void> {
    if (!await this.safeStorage.isAvailable()) {
      throw new Error('Secure storage encryption is unavailable for the knowledge database')
    }
  }

  private async wrap(key: Buffer): Promise<string> {
    await this.requireSecureStorage()
    return (await this.safeStorage.encrypt(key.toString('base64'))).toString('base64')
  }

  private async unwrap(wrapped: string): Promise<{ key: Buffer; shouldReEncrypt: boolean }> {
    const encrypted = Buffer.from(wrapped, 'base64')
    const decrypted = await this.safeStorage.decrypt(encrypted)
    const key = Buffer.from(decrypted.value, 'base64')
    if (key.length !== DATABASE_KEY_BYTES) {
      key.fill(0)
      throw new Error('Knowledge database key is invalid')
    }
    return { key, shouldReEncrypt: decrypted.shouldReEncrypt }
  }

  private async writeRecord(record: WrappedKeyRecord): Promise<void> {
    await this.persistRecord(this.recordPath, JSON.stringify(record))
  }
}
