import { describe, expect, it } from 'vitest'
import { addUsd, normalizeUsd } from './decimal-usd.js'

describe('normalizeUsd', () => {
  it.each([
    ['0', '0'],
    ['0.00000012', '0.00000012'],
    ['001.2300', '1.23'],
    ['1e-7', '0.0000001'],
    ['1.25E+3', '1250'],
    [0, '0'],
  ])('normalizes %p', (input, expected) => {
    expect(normalizeUsd(input)).toBe(expected)
  })

  it.each(['', ' 1', '+1', '-1', 'NaN', 'Infinity', '1.2.3'])('rejects %p', (input) => {
    expect(() => normalizeUsd(input)).toThrow()
  })

  it.each([
    ['an exponent outside the bounded range', '1e1000000000'],
    ['more than 1,024 digits', '1'.repeat(1_025)],
    ['a resulting scale above 1,024 places', '0.1e-1024'],
    ['a source above 4,096 characters', `0.${'0'.repeat(4_095)}`],
  ])('quickly rejects %s', (_description, input) => {
    const startedAt = performance.now()
    expect(() => normalizeUsd(input)).toThrow(TypeError)
    expect(performance.now() - startedAt).toBeLessThan(100)
  })

  it('accepts ordinary scientific notation within the bounded range', () => {
    expect(normalizeUsd('1e-7')).toBe('0.0000001')
  })
})

it('adds without binary floating-point loss', () => {
  expect(addUsd(['0.1', '0.2', '1e-7', '999999999999999999.9']))
    .toBe('1000000000000000000.2000001')
})
