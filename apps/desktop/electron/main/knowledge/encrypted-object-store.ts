import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const OBJECT_ID_PATTERN = /^[0-9a-f]{32}$/
const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16
const WRAP_SALT = Buffer.from('autoforge-knowledge-object-wrap-salt-v2', 'utf8')
const WRAP_DOMAIN = 'autoforge-knowledge-object-file-key-v2\0'
const PAYLOAD_DOMAIN = 'autoforge-knowledge-object-payload-v2\0'

interface SerializedObject {
  version: 1
  wrapNonce: string
  wrappedFileKey: string
  payloadNonce: string
  ciphertext: string
}

export interface StoredKnowledgeObject {
  objectId: string
  byteLength: number
}

function validateObjectId(objectId: string): void {
  if (!OBJECT_ID_PATTERN.test(objectId)) throw new Error('Invalid object ID')
}

function objectAad(domain: string, objectId: string): Buffer {
  return Buffer.from(`${domain}${objectId}`, 'utf8')
}

function deriveWrappingKey(masterKey: Buffer, objectId: string): Buffer {
  return Buffer.from(hkdfSync(
    'sha256',
    masterKey,
    WRAP_SALT,
    objectAad(WRAP_DOMAIN, objectId),
    KEY_BYTES,
  ))
}

function seal(cleartext: Buffer, key: Buffer, nonce: Buffer, aad: Buffer): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(aad)
  return Buffer.concat([cipher.update(cleartext), cipher.final(), cipher.getAuthTag()])
}

function openSealed(sealed: Buffer, key: Buffer, nonce: Buffer, aad: Buffer): Buffer {
  if (sealed.length < TAG_BYTES) throw new Error('Knowledge object is invalid')
  const ciphertext = sealed.subarray(0, -TAG_BYTES)
  const tag = sealed.subarray(-TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAAD(aad)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

function decodeBase64(value: unknown): Buffer {
  if (typeof value !== 'string') throw new Error('Knowledge object is invalid')
  return Buffer.from(value, 'base64')
}

function parseObject(serialized: Buffer): {
  wrapNonce: Buffer
  wrappedFileKey: Buffer
  payloadNonce: Buffer
  ciphertext: Buffer
} {
  let object: Partial<SerializedObject>
  try {
    object = JSON.parse(serialized.toString('utf8')) as Partial<SerializedObject>
  } catch {
    throw new Error('Knowledge object is invalid')
  }
  if (object.version !== 1) throw new Error('Knowledge object is invalid')
  const wrapNonce = decodeBase64(object.wrapNonce)
  const wrappedFileKey = decodeBase64(object.wrappedFileKey)
  const payloadNonce = decodeBase64(object.payloadNonce)
  const ciphertext = decodeBase64(object.ciphertext)
  if (wrapNonce.length !== NONCE_BYTES || payloadNonce.length !== NONCE_BYTES) {
    throw new Error('Knowledge object is invalid')
  }
  return { wrapNonce, wrappedFileKey, payloadNonce, ciphertext }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(path, 0o700)
}

async function ensurePrivateFile(path: string): Promise<void> {
  if (process.platform !== 'win32') await chmod(path, 0o600)
}

async function publishDurably(path: string, contents: Buffer): Promise<void> {
  const directory = dirname(path)
  await ensurePrivateDirectory(directory)
  const temporaryPath = join(directory, `.object-${randomUUID()}.recovery`)
  const handle = await open(temporaryPath, 'wx', 0o600)
  try {
    await handle.writeFile(contents)
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => undefined)
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
  await handle.close()
  try {
    await rename(temporaryPath, path)
    await ensurePrivateFile(path)
    await syncDirectory(directory)
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
}

export class KnowledgeObjectStore {
  readonly #root: string
  readonly #masterKey: Buffer
  #closed = false

  constructor(rootDirectory: string, masterKey: Buffer) {
    if (typeof rootDirectory !== 'string' || rootDirectory.length === 0) {
      throw new Error('Knowledge object root is required')
    }
    if (!Buffer.isBuffer(masterKey) || masterKey.length !== KEY_BYTES) {
      throw new Error('Invalid knowledge object key')
    }
    this.#root = resolve(rootDirectory)
    this.#masterKey = Buffer.from(masterKey)
  }

  async put(contents: Buffer): Promise<StoredKnowledgeObject> {
    this.#requireOpen()
    if (!Buffer.isBuffer(contents)) throw new Error('Knowledge object contents must be bytes')
    const objectId = randomBytes(16).toString('hex')
    const fileKey = randomBytes(KEY_BYTES)
    const wrappingKey = deriveWrappingKey(this.#masterKey, objectId)
    const wrapNonce = randomBytes(NONCE_BYTES)
    const payloadNonce = randomBytes(NONCE_BYTES)
    try {
      const wrappedFileKey = seal(fileKey, wrappingKey, wrapNonce, objectAad(WRAP_DOMAIN, objectId))
      const ciphertext = seal(contents, fileKey, payloadNonce, objectAad(PAYLOAD_DOMAIN, objectId))
      const serialized = Buffer.from(JSON.stringify({
        version: 1,
        wrapNonce: wrapNonce.toString('base64'),
        wrappedFileKey: wrappedFileKey.toString('base64'),
        payloadNonce: payloadNonce.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      } satisfies SerializedObject), 'utf8')
      await publishDurably(this.#pathFor(objectId), serialized)
      serialized.fill(0)
      return { objectId, byteLength: contents.length }
    } finally {
      fileKey.fill(0)
      wrappingKey.fill(0)
      wrapNonce.fill(0)
      payloadNonce.fill(0)
    }
  }

  async read(objectId: string): Promise<Buffer> {
    this.#requireOpen()
    validateObjectId(objectId)
    let serialized: Buffer
    try {
      await ensurePrivateDirectory(this.#root)
      const path = this.#pathFor(objectId)
      await ensurePrivateFile(path)
      serialized = await readFile(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('Knowledge object is unavailable')
      }
      throw error
    }
    const wrappingKey = deriveWrappingKey(this.#masterKey, objectId)
    let fileKey: Buffer | undefined
    try {
      const object = parseObject(serialized)
      fileKey = openSealed(
        object.wrappedFileKey,
        wrappingKey,
        object.wrapNonce,
        objectAad(WRAP_DOMAIN, objectId),
      )
      if (fileKey.length !== KEY_BYTES) throw new Error('Knowledge object key is invalid')
      return openSealed(
        object.ciphertext,
        fileKey,
        object.payloadNonce,
        objectAad(PAYLOAD_DOMAIN, objectId),
      )
    } catch {
      throw new Error('Knowledge object could not authenticate')
    } finally {
      serialized.fill(0)
      wrappingKey.fill(0)
      fileKey?.fill(0)
    }
  }

  async delete(objectId: string): Promise<void> {
    this.#requireOpen()
    validateObjectId(objectId)
    await ensurePrivateDirectory(this.#root)
    try {
      await unlink(this.#pathFor(objectId))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await syncDirectory(this.#root)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#masterKey.fill(0)
  }

  #pathFor(objectId: string): string {
    validateObjectId(objectId)
    const path = resolve(join(this.#root, `${objectId}.afobj`))
    if (dirname(path) !== this.#root) throw new Error('Invalid knowledge object path')
    return path
  }

  #requireOpen(): void {
    if (this.#closed) throw new Error('Knowledge object store is closed')
  }
}
