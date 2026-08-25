import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SafeStoragePort } from '../security/secret-store.js'

interface WrappedKeyRecord {
  readonly version: 1
  readonly active: string
  readonly pending?: string
}

const DATABASE_KEY_BYTES = 32

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

export class KnowledgeKeyStore {
  constructor(
    readonly recordPath: string,
    private readonly safeStorage: SafeStoragePort,
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
    const directory = dirname(this.recordPath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.recordPath}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, JSON.stringify(record), { mode: 0o600, flag: 'wx' })
    await rename(temporaryPath, this.recordPath)
  }
}
