import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

const SCRYPT_N = 32_768
const SCRYPT_R = 8
const SCRYPT_P = 3
const KEY_LENGTH = 32
const MAX_MEMORY = 64 * 1024 * 1024
const PREFIX = 'scrypt$v=1$N=32768,r=8,p=3'
const DUMMY_DIGEST = 'scrypt$v=1$N=32768,r=8,p=3$QXV0b0ZvcmdlRHVtbXkwMQ==$KNgMTZnBehAtPZG00687u03IWPUrCJhqLAtJqtFH2zg='

export interface PasswordHasher {
  hash(password: string): Promise<string>
  verify(password: string, digest: string | undefined): Promise<boolean>
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: MAX_MEMORY,
    }, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })
}

function decodeDigest(digest: string): { salt: Buffer; key: Buffer } {
  const [algorithm, version, parameters, saltBase64, keyBase64, extra] = digest.split('$')
  if (
    algorithm !== 'scrypt'
    || version !== 'v=1'
    || parameters !== 'N=32768,r=8,p=3'
    || !saltBase64
    || !keyBase64
    || extra !== undefined
  ) throw new Error('Invalid password digest')

  const salt = Buffer.from(saltBase64, 'base64')
  const key = Buffer.from(keyBase64, 'base64')
  if (
    salt.length !== 16
    || key.length !== KEY_LENGTH
    || salt.toString('base64') !== saltBase64
    || key.toString('base64') !== keyBase64
  ) throw new Error('Invalid password digest')
  return { salt, key }
}

export class ScryptPasswordHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16)
    const key = await derive(password, salt)
    return `${PREFIX}$${salt.toString('base64')}$${key.toString('base64')}`
  }

  async verify(password: string, digest: string | undefined): Promise<boolean> {
    const stored = decodeDigest(digest ?? DUMMY_DIGEST)
    const candidate = await derive(password, stored.salt)
    const matches = timingSafeEqual(candidate, stored.key)
    return digest !== undefined && matches
  }
}
