import { createHash } from 'node:crypto'
import type { SecretStore } from '../security/secret-store.js'

const maxOriginsPerUser = 64
const maxKeysPerOrigin = 1_024
const maxBytesPerOrigin = 10 * 1024 * 1024
const maxBytesPerUser = 64 * 1024 * 1024

export type BrowserSessionStorageRecords = Readonly<Record<string, Readonly<Record<string, string>>>>

export type BrowserSessionStorageMutation =
  | { readonly type: 'set'; readonly origin: string; readonly key: string; readonly value: string }
  | { readonly type: 'remove'; readonly origin: string; readonly key: string }
  | { readonly type: 'clear'; readonly origin: string }

export interface BrowserSessionStorageStore {
  get(userId: string, allowedOrigins: readonly string[]): Promise<BrowserSessionStorageRecords>
  apply(userId: string, mutation: BrowserSessionStorageMutation): Promise<void>
  clear(userId: string): Promise<void>
  drain(): Promise<void>
}

type MutableRecords = Record<string, Record<string, string>>

/** @internal Exported for deterministic storage-boundary tests. */
export function browserSessionStorageSecretKey(userId: string): string {
  return `browser_session_storage_v1:${createHash('sha256').update(userId).digest('hex')}`
}

function httpsOrigin(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.origin !== value) return undefined
    return url.origin
  } catch {
    return undefined
  }
}

function recordBytes(items: Readonly<Record<string, string>>): number {
  return Object.entries(items).reduce(
    (total, [key, value]) => total + Buffer.byteLength(key) + Buffer.byteLength(value),
    0,
  )
}

function parsedRecords(value: string): MutableRecords {
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const envelope = parsed as { version?: unknown; origins?: unknown }
    if (envelope.version !== 1
      || typeof envelope.origins !== 'object'
      || envelope.origins === null
      || Array.isArray(envelope.origins)) return {}
    const entries = Object.entries(envelope.origins)
    if (entries.length > maxOriginsPerUser) return {}
    const records: MutableRecords = {}
    let totalBytes = 0
    for (const [candidateOrigin, candidateItems] of entries) {
      const origin = httpsOrigin(candidateOrigin)
      if (!origin
        || typeof candidateItems !== 'object'
        || candidateItems === null
        || Array.isArray(candidateItems)) return {}
      const itemEntries = Object.entries(candidateItems)
      if (itemEntries.length > maxKeysPerOrigin) return {}
      const items: Record<string, string> = {}
      for (const [key, candidateValue] of itemEntries) {
        if (typeof candidateValue !== 'string') return {}
        items[key] = candidateValue
      }
      const bytes = recordBytes(items)
      totalBytes += bytes
      if (bytes > maxBytesPerOrigin || totalBytes > maxBytesPerUser) return {}
      records[origin] = items
    }
    return records
  } catch {
    return {}
  }
}

function frozenSelection(records: MutableRecords, allowedOrigins: readonly string[]): BrowserSessionStorageRecords {
  const selected: Record<string, Readonly<Record<string, string>>> = {}
  for (const candidate of allowedOrigins) {
    const origin = httpsOrigin(candidate)
    const items = origin && records[origin]
    if (!origin || !items) continue
    selected[origin] = Object.freeze({ ...items })
  }
  return Object.freeze(selected)
}

export class EncryptedBrowserSessionStorageStore implements BrowserSessionStorageStore {
  private readonly records = new Map<string, Promise<MutableRecords>>()
  private readonly writes = new Map<string, Promise<void>>()

  constructor(private readonly secrets: Pick<SecretStore, 'get' | 'set' | 'delete'>) {}

  async get(userId: string, allowedOrigins: readonly string[]): Promise<BrowserSessionStorageRecords> {
    await this.writes.get(userId)
    return frozenSelection(await this.load(userId), allowedOrigins)
  }

  apply(userId: string, mutation: BrowserSessionStorageMutation): Promise<void> {
    const previous = this.writes.get(userId) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(async () => {
      const origin = httpsOrigin(mutation.origin)
      if (!origin) return
      const records = await this.load(userId)
      if (mutation.type === 'clear') {
        delete records[origin]
      } else if (mutation.type === 'remove') {
        const items = records[origin]
        if (!items) return
        delete items[mutation.key]
        if (Object.keys(items).length === 0) delete records[origin]
      } else {
        const items = records[origin] ?? {}
        items[mutation.key] = mutation.value
        if (Object.keys(items).length > maxKeysPerOrigin || recordBytes(items) > maxBytesPerOrigin) {
          throw new Error('Browser session storage quota exceeded')
        }
        records[origin] = items
      }
      if (Object.keys(records).length > maxOriginsPerUser
        || Object.values(records).reduce((total, items) => total + recordBytes(items), 0) > maxBytesPerUser) {
        throw new Error('Browser session storage quota exceeded')
      }
      await this.secrets.set(browserSessionStorageSecretKey(userId), JSON.stringify({
        version: 1,
        origins: records,
      }))
    })
    this.writes.set(userId, operation)
    void operation.finally(() => {
      if (this.writes.get(userId) === operation) this.writes.delete(userId)
    }).catch(() => undefined)
    return operation
  }

  async clear(userId: string): Promise<void> {
    await this.writes.get(userId)?.catch(() => undefined)
    this.records.delete(userId)
    this.secrets.delete(browserSessionStorageSecretKey(userId))
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.writes.values()])
  }

  private load(userId: string): Promise<MutableRecords> {
    const existing = this.records.get(userId)
    if (existing) return existing
    const loading = this.secrets.get(browserSessionStorageSecretKey(userId))
      .then((stored) => stored === undefined ? {} : parsedRecords(stored))
      .catch((error) => {
        this.records.delete(userId)
        throw error
      })
    this.records.set(userId, loading)
    return loading
  }
}
