import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

const FILE_KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const OBJECT_MAGIC = Buffer.from('AFKBOBJ1')
const WRAP_MAGIC = Buffer.from('AFKBKEY1')
export const MAX_KNOWLEDGE_OBJECT_BYTES = 64 * 1024 * 1024

export interface EncryptedObjectSnapshot {
  readonly objectPath: string
  readonly wrappedFileKey: Buffer
  readonly encryptedBytes: number
}

function requireKey(key: Buffer, name: string): void {
  if (key.length !== FILE_KEY_BYTES) throw new Error(`${name} must be 32 bytes`)
}

function wrappingKey(userKey: Buffer): Buffer {
  requireKey(userKey, 'Knowledge user key')
  return Buffer.from(hkdfSync('sha256', userKey, Buffer.from('autoforge:knowledge:object-wrap:salt:v1'), Buffer.from('autoforge:knowledge:object-wrap:v1'), FILE_KEY_BYTES))
}

function seal(magic: Buffer, plaintext: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(magic)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([magic, iv, cipher.getAuthTag(), ciphertext])
}

function openEnvelope(envelope: Buffer, magic: Buffer, key: Buffer): Buffer {
  if (envelope.length < magic.length + IV_BYTES + TAG_BYTES || !envelope.subarray(0, magic.length).equals(magic)) {
    throw new Error('Encrypted knowledge object envelope is invalid')
  }
  const ivStart = magic.length
  const tagStart = ivStart + IV_BYTES
  const ciphertextStart = tagStart + TAG_BYTES
  const decipher = createDecipheriv('aes-256-gcm', key, envelope.subarray(ivStart, tagStart))
  decipher.setAAD(magic)
  decipher.setAuthTag(envelope.subarray(tagStart, ciphertextStart))
  try {
    return Buffer.concat([decipher.update(envelope.subarray(ciphertextStart)), decipher.final()])
  } catch (error) {
    throw new Error('Encrypted knowledge object key could not authenticate', { cause: error })
  }
}

async function readStableRegularFile(path: string, maxBytes: number): Promise<Buffer> {
  const before = await lstat(path, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Knowledge source must be a regular non-symbolic file')
  if (before.size > BigInt(maxBytes)) throw new Error('Knowledge source exceeds the parser size limit')
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const handle = await open(path, constants.O_RDONLY | noFollow)
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error('Knowledge source changed during snapshot validation')
    }
    const bytes = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    if (after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || BigInt(bytes.length) !== opened.size) {
      throw new Error('Knowledge source changed while being snapshotted')
    }
    return bytes
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error('Knowledge source must not be a symbolic link', { cause: error })
    }
    throw error
  } finally {
    await handle.close()
  }
}

export async function createEncryptedObjectSnapshot(input: {
  sourcePath: string
  objectPath: string
  userKey: Buffer
  maxSourceBytes?: number
}): Promise<EncryptedObjectSnapshot> {
  const plaintext = await readStableRegularFile(input.sourcePath, input.maxSourceBytes ?? MAX_KNOWLEDGE_OBJECT_BYTES)
  const fileKey = randomBytes(FILE_KEY_BYTES)
  const wrapKey = wrappingKey(input.userKey)
  try {
    const encrypted = seal(OBJECT_MAGIC, plaintext, fileKey)
    const wrappedFileKey = seal(WRAP_MAGIC, fileKey, wrapKey)
    await mkdir(dirname(input.objectPath), { recursive: true, mode: 0o700 })
    const temporaryPath = `${input.objectPath}.${randomBytes(12).toString('hex')}.tmp`
    const handle = await open(temporaryPath, 'wx', 0o600)
    try {
      await handle.writeFile(encrypted)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporaryPath, input.objectPath)
    return { objectPath: input.objectPath, wrappedFileKey, encryptedBytes: encrypted.length }
  } finally {
    plaintext.fill(0)
    fileKey.fill(0)
    wrapKey.fill(0)
  }
}

export function unwrapSnapshotFileKey(wrappedFileKey: Buffer, userKey: Buffer): Buffer {
  const wrapKey = wrappingKey(userKey)
  try {
    const fileKey = openEnvelope(wrappedFileKey, WRAP_MAGIC, wrapKey)
    requireKey(fileKey, 'Knowledge file key')
    return fileKey
  } finally {
    wrapKey.fill(0)
  }
}

export async function readEncryptedObjectSnapshot(path: string): Promise<Buffer> {
  return readStableRegularFile(path, MAX_KNOWLEDGE_OBJECT_BYTES + OBJECT_MAGIC.length + IV_BYTES + TAG_BYTES)
}

export const encryptedObjectEnvelope = Object.freeze({ magic: OBJECT_MAGIC.toString('ascii'), ivBytes: IV_BYTES, tagBytes: TAG_BYTES })
