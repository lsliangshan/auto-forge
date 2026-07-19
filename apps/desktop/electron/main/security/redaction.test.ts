import { describe, expect, it } from 'vitest'
import { redact } from './redaction.js'

describe('redact', () => {
  it('redacts authorization, cookies, token and API-key fields recursively', () => {
    expect(redact({
      headers: { Authorization: 'Bearer secret', Cookie: 'session=secret', 'X-Api-Key': 'secret' },
      nested: [{ accessToken: 'secret' }],
    })).toEqual({
      headers: { Authorization: '[REDACTED]', Cookie: '[REDACTED]', 'X-Api-Key': '[REDACTED]' },
      nested: [{ accessToken: '[REDACTED]' }],
    })
  })

  it('redacts manifest-declared sensitive input paths without mutating the value', () => {
    const value = { credentials: { password: 'secret' }, query: 'safe' }

    expect(redact(value, ['credentials.password'])).toEqual({
      credentials: { password: '[REDACTED]' },
      query: 'safe',
    })
    expect(value.credentials.password).toBe('secret')
  })
})
