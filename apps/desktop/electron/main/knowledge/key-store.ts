import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { SafeStoragePort } from '../security/secret-store.js'

const KNOWLEDGE_OWNER_DOMAIN = 'autoforge-knowledge-owner-v2\0'
const OWNER_SCOPE_PATTERN = /^[0-9a-f]{32}$/
const KEY_BYTES = 32
const KNOWLEDGE_LOCK_DOMAIN = 'autoforge-knowledge-owner-lock-v2\0'

class OwnerMutex {
  #locked = false
  readonly #waiters: Array<() => void> = []

  get idle(): boolean {
    return !this.#locked && this.#waiters.length === 0
  }

  async run<T>(operation: () => Promise<T>, onIdle: () => void): Promise<T> {
    await this.#acquire()
    try {
      return await operation()
    } finally {
      this.#release()
      if (this.idle) onIdle()
    }
  }

  async #acquire(): Promise<void> {
    if (!this.#locked) {
      this.#locked = true
      return
    }
    await new Promise<void>(resolve => this.#waiters.push(resolve))
  }

  #release(): void {
    const next = this.#waiters.shift()
    if (next) next()
    else this.#locked = false
  }
}

const ownerMutexes = new Map<string, OwnerMutex>()

interface KeyRecord {
  version: 1
  active: string
  object: string
  pending?: string
}

interface WrappedKeyEnvelope {
  version: 1
  ownerBindingToken: string
  key: string
}

export interface KnowledgeKeyMaterial {
  active: Buffer
  objectKey: Buffer
  pending?: Buffer
  ownerRoot: string
  recordPath: string
}

export interface KnowledgeOwnerPaths {
  ownerRoot: string
  recordPath: string
}

export interface LockedKnowledgeKeyStore {
  paths: KnowledgeOwnerPaths
  loadOrCreate(): Promise<KnowledgeKeyMaterial>
  loadExisting(): Promise<KnowledgeKeyMaterial | undefined>
  stagePending(pendingKey: Buffer): Promise<void>
  promotePending(): Promise<void>
  discardPending(): Promise<void>
}

function validateOwnerId(ownerId: string): void {
  if (
    typeof ownerId !== 'string'
    || ownerId.length < 1
    || ownerId.length > 512
    || ownerId.trim() !== ownerId
    || ownerId.includes('\0')
  ) throw new Error('Invalid knowledge owner')
}

function ownerBindingToken(ownerId: string): string {
  validateOwnerId(ownerId)
  return createHash('sha256').update(KNOWLEDGE_OWNER_DOMAIN).update(ownerId).digest('hex')
}

function ownerPaths(root: string, ownerId: string): { ownerRoot: string; recordPath: string; token: string } {
  const token = ownerBindingToken(ownerId)
  const scope = token.slice(0, 32)
  if (!OWNER_SCOPE_PATTERN.test(scope)) throw new Error('Invalid knowledge owner scope')
  const ownerRoot = resolve(join(root, scope))
  if (dirname(ownerRoot) !== root) throw new Error('Invalid knowledge owner root')
  return { ownerRoot, recordPath: join(ownerRoot, 'keys.json'), token }
}

function parseRecord(serialized: string): KeyRecord {
  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch {
    throw new Error('Knowledge key record is invalid')
  }
  if (
    typeof value !== 'object'
    || value === null
    || (value as Partial<KeyRecord>).version !== 1
    || typeof (value as Partial<KeyRecord>).active !== 'string'
    || typeof (value as Partial<KeyRecord>).object !== 'string'
    || ((value as Partial<KeyRecord>).pending !== undefined
      && typeof (value as Partial<KeyRecord>).pending !== 'string')
  ) throw new Error('Knowledge key record is invalid')
  return value as KeyRecord
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function writeRecordDurably(
  path: string,
  record: KeyRecord,
  { createOnly = false }: { createOnly?: boolean } = {},
): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporaryPath = join(directory, `.keys-${randomUUID()}.recovery`)
  const handle = await open(temporaryPath, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(record), 'utf8')
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => undefined)
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
  await handle.close()
  try {
    if (createOnly) {
      await link(temporaryPath, path)
      await unlink(temporaryPath)
    } else {
      await rename(temporaryPath, path)
    }
    const directoryHandle = await open(directory, 'r')
    try {
      await directoryHandle.sync()
    } finally {
      await directoryHandle.close()
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
}

export class KnowledgeKeyStore {
  readonly #root: string

  constructor(rootDirectory: string, private readonly safeStorage: SafeStoragePort) {
    if (typeof rootDirectory !== 'string' || rootDirectory.length === 0) {
      throw new Error('Knowledge storage root is required')
    }
    this.#root = resolve(rootDirectory)
  }

  pathsFor(ownerId: string): KnowledgeOwnerPaths {
    const { ownerRoot, recordPath } = ownerPaths(this.#root, ownerId)
    return { ownerRoot, recordPath }
  }

  async loadOrCreate(ownerId: string): Promise<KnowledgeKeyMaterial> {
    return this.withOwnerLock(ownerId, store => store.loadOrCreate())
  }

  async loadExisting(ownerId: string): Promise<KnowledgeKeyMaterial | undefined> {
    return this.withOwnerLock(ownerId, store => store.loadExisting())
  }

  async stagePending(ownerId: string, pendingKey: Buffer): Promise<void> {
    return this.withOwnerLock(ownerId, store => store.stagePending(pendingKey))
  }

  async promotePending(ownerId: string): Promise<void> {
    return this.withOwnerLock(ownerId, store => store.promotePending())
  }

  async discardPending(ownerId: string): Promise<void> {
    return this.withOwnerLock(ownerId, store => store.discardPending())
  }

  async withOwnerLock<T>(
    ownerId: string,
    operation: (store: LockedKnowledgeKeyStore) => Promise<T>,
  ): Promise<T> {
    const paths = ownerPaths(this.#root, ownerId)
    const lockKey = createHash('sha256')
      .update(KNOWLEDGE_LOCK_DOMAIN)
      .update(this.#root)
      .update(paths.ownerRoot)
      .digest('hex')
    let mutex = ownerMutexes.get(lockKey)
    if (!mutex) {
      mutex = new OwnerMutex()
      ownerMutexes.set(lockKey, mutex)
    }
    const activeMutex = mutex
    return activeMutex.run(() => operation({
      paths,
      loadOrCreate: () => this.#loadOrCreateUnlocked(ownerId),
      loadExisting: () => this.#loadExistingUnlocked(ownerId),
      stagePending: pendingKey => this.#stagePendingUnlocked(ownerId, pendingKey),
      promotePending: () => this.#promotePendingUnlocked(ownerId),
      discardPending: () => this.#discardPendingUnlocked(ownerId),
    }), () => {
      if (ownerMutexes.get(lockKey) === activeMutex) ownerMutexes.delete(lockKey)
    })
  }

  async #loadOrCreateUnlocked(ownerId: string): Promise<KnowledgeKeyMaterial> {
    const existing = await this.#loadExistingUnlocked(ownerId)
    if (existing) return existing
    await this.#requireSecureStorage()
    const paths = ownerPaths(this.#root, ownerId)
    const key = randomBytes(KEY_BYTES)
    const objectKey = randomBytes(KEY_BYTES)
    try {
      const active = await this.#wrapKey(key, paths.token)
      const object = await this.#wrapKey(objectKey, paths.token)
      try {
        await writeRecordDurably(
          paths.recordPath,
          { version: 1, active, object },
          { createOnly: true },
        )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const committed = await this.#loadExistingUnlocked(ownerId)
        if (!committed) throw new Error('Knowledge key is unavailable')
        return committed
      }
      return {
        active: Buffer.from(key),
        objectKey: Buffer.from(objectKey),
        ownerRoot: paths.ownerRoot,
        recordPath: paths.recordPath,
      }
    } finally {
      key.fill(0)
      objectKey.fill(0)
    }
  }

  async #loadExistingUnlocked(ownerId: string): Promise<KnowledgeKeyMaterial | undefined> {
    const paths = ownerPaths(this.#root, ownerId)
    if (!await pathExists(paths.recordPath)) return undefined
    await this.#requireSecureStorage()
    const record = parseRecord(await readFile(paths.recordPath, 'utf8'))
    const activeResult = await this.#unwrapKey(record.active, paths.token)
    const active = activeResult.key
    let objectKey: Buffer | undefined
    let pending: Buffer | undefined
    try {
      const objectResult = await this.#unwrapKey(record.object, paths.token)
      objectKey = objectResult.key
      const pendingResult = record.pending === undefined
        ? undefined
        : await this.#unwrapKey(record.pending, paths.token)
      pending = pendingResult?.key
      if (activeResult.shouldReEncrypt || objectResult.shouldReEncrypt || pendingResult?.shouldReEncrypt) {
        const rewrapped: KeyRecord = {
          version: 1,
          active: await this.#wrapKey(active, paths.token),
          object: await this.#wrapKey(objectKey, paths.token),
        }
        if (pending) rewrapped.pending = await this.#wrapKey(pending, paths.token)
        await writeRecordDurably(paths.recordPath, rewrapped)
      }
      return { active, objectKey, pending, ownerRoot: paths.ownerRoot, recordPath: paths.recordPath }
    } catch (error) {
      active.fill(0)
      objectKey?.fill(0)
      pending?.fill(0)
      throw error
    }
  }

  async #stagePendingUnlocked(ownerId: string, pendingKey: Buffer): Promise<void> {
    if (!Buffer.isBuffer(pendingKey) || pendingKey.length !== KEY_BYTES) {
      throw new Error('Invalid pending knowledge key')
    }
    const material = await this.#requireExistingUnlocked(ownerId)
    const paths = ownerPaths(this.#root, ownerId)
    try {
      const record = parseRecord(await readFile(paths.recordPath, 'utf8'))
      record.pending = await this.#wrapKey(pendingKey, paths.token)
      await writeRecordDurably(paths.recordPath, record)
    } finally {
      material.active.fill(0)
      material.objectKey.fill(0)
      material.pending?.fill(0)
    }
  }

  async #promotePendingUnlocked(ownerId: string): Promise<void> {
    const material = await this.#requireExistingUnlocked(ownerId)
    const paths = ownerPaths(this.#root, ownerId)
    try {
      if (!material.pending) throw new Error('Pending knowledge key is unavailable')
      const active = await this.#wrapKey(material.pending, paths.token)
      const object = await this.#wrapKey(material.objectKey, paths.token)
      await writeRecordDurably(paths.recordPath, { version: 1, active, object })
    } finally {
      material.active.fill(0)
      material.objectKey.fill(0)
      material.pending?.fill(0)
    }
  }

  async #discardPendingUnlocked(ownerId: string): Promise<void> {
    const material = await this.#requireExistingUnlocked(ownerId)
    const paths = ownerPaths(this.#root, ownerId)
    try {
      const active = await this.#wrapKey(material.active, paths.token)
      const object = await this.#wrapKey(material.objectKey, paths.token)
      await writeRecordDurably(paths.recordPath, { version: 1, active, object })
    } finally {
      material.active.fill(0)
      material.objectKey.fill(0)
      material.pending?.fill(0)
    }
  }

  async #requireExistingUnlocked(ownerId: string): Promise<KnowledgeKeyMaterial> {
    const material = await this.#loadExistingUnlocked(ownerId)
    if (!material) throw new Error('Knowledge key is unavailable')
    return material
  }

  async #requireSecureStorage(): Promise<void> {
    if (!await this.safeStorage.isAvailable()) {
      throw new Error('Secure storage encryption is unavailable')
    }
  }

  async #wrapKey(key: Buffer, token: string): Promise<string> {
    const envelope: WrappedKeyEnvelope = {
      version: 1,
      ownerBindingToken: token,
      key: key.toString('base64'),
    }
    return (await this.safeStorage.encrypt(JSON.stringify(envelope))).toString('base64')
  }

  async #unwrapKey(wrapped: string, token: string): Promise<{ key: Buffer; shouldReEncrypt: boolean }> {
    let envelope: Partial<WrappedKeyEnvelope>
    let shouldReEncrypt = false
    try {
      const decrypted = await this.safeStorage.decrypt(Buffer.from(wrapped, 'base64'))
      shouldReEncrypt = decrypted.shouldReEncrypt
      envelope = JSON.parse(decrypted.value) as Partial<WrappedKeyEnvelope>
    } catch {
      throw new Error('Knowledge key could not be unwrapped')
    }
    if (envelope.version !== 1 || envelope.ownerBindingToken !== token) {
      throw new Error('Knowledge key owner binding is invalid')
    }
    if (typeof envelope.key !== 'string') throw new Error('Knowledge key is invalid')
    const key = Buffer.from(envelope.key, 'base64')
    if (key.length !== KEY_BYTES) {
      key.fill(0)
      throw new Error('Knowledge key is invalid')
    }
    return { key, shouldReEncrypt }
  }
}
