import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from './password.js'

describe('password hashing', () => {
  it('uses a salted scrypt hash and verifies without preserving plaintext', async () => {
    const encoded = await hashPassword('correct horse battery staple')
    expect(encoded).toMatch(/^scrypt\$/)
    expect(encoded).not.toContain('correct horse')
    expect(await verifyPassword('correct horse battery staple', encoded)).toBe(true)
    expect(await verifyPassword('wrong password', encoded)).toBe(false)
  })
})
