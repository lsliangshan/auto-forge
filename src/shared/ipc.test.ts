import { describe, expect, it } from 'vitest'
import { toSafeError } from './ipc'

describe('toSafeError', () => {
  it('preserves the message from a standard Error', () => {
    expect(toSafeError(new Error('boom'))).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'boom'
    })
  })

  it('does not expose unknown thrown values', () => {
    expect(toSafeError('secret')).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Unexpected application error'
    })
  })
})
