import { describe, expect, it } from 'vitest'
import { ScryptPasswordHasher } from './password-hasher.js'

describe('ScryptPasswordHasher', () => {
  it('hashes with the fixed versioned scrypt envelope and verifies without plaintext storage', async () => {
    const hasher = new ScryptPasswordHasher()
    const password = 'correct horse battery staple'

    const digest = await hasher.hash(password)

    expect(digest).toMatch(/^scrypt\$v=1\$N=32768,r=8,p=3\$/)
    expect(digest).not.toContain(password)
    expect(Buffer.from(digest.split('$')[3]!, 'base64')).toHaveLength(16)
    await expect(hasher.verify(password, digest)).resolves.toBe(true)
    await expect(hasher.verify('incorrect password', digest)).resolves.toBe(false)
  })

  it('performs a dummy derivation for a missing account and returns false', async () => {
    const hasher = new ScryptPasswordHasher()

    await expect(hasher.verify('unregistered password', undefined)).resolves.toBe(false)
  })

  it('rejects malformed persisted digests as storage failures', async () => {
    const hasher = new ScryptPasswordHasher()

    await expect(hasher.verify('password', 'sha256$unsafe')).rejects.toThrow('password digest')
  })
})
