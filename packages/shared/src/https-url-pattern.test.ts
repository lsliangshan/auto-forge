import { describe, expect, it } from 'vitest'
import {
  isHttpsUrlPattern,
  matchesHttpsUrlPattern,
  matchesHttpsUrlPatternOrigin,
} from './https-url-pattern.js'

describe('HTTPS URL patterns', () => {
  it.each([
    'https://www.baidu.com',
    'baidu.com',
    '*.baidu.com',
    '*.baidu.com/*',
    'https://a*.baidu.com',
    '*.baidu.*',
    '*.baidu.com/api/*',
    '*.baidu.com:8443/api/*',
  ])('accepts %s', (pattern) => {
    expect(isHttpsUrlPattern(pattern)).toBe(true)
  })

  it.each([
    'http://www.baidu.com',
    'https://allowed.example@evil.example',
    '*.baidu.com?query=value',
    '*.baidu.com#fragment',
    '*',
    '*/*',
    'https://*/*',
    '*.baidu.com:*',
    '*.baidu.com:',
    '*.baidu.com:65536',
    'https:///evil.com',
    'https:////evil.com',
    '/evil.com',
    '//evil.com',
    'https://baidu.com:',
    'baidu.com:',
    'baidu..com',
    '127.0.*',
  ])('rejects %s', (pattern) => {
    expect(isHttpsUrlPattern(pattern)).toBe(false)
  })

  it.each([
    ['*.baidu.com', 'https://a.baidu.com/', true],
    ['*.baidu.com', 'https://a.b.baidu.com/deep/path', true],
    ['*.baidu.com', 'https://baidu.com/', false],
    ['*.baidu.com', 'https://evilbaidu.com/', false],
    ['*.baidu.com', 'https://a.baidu.com.evil.com/', false],
    ['a*.baidu.com', 'https://a.baidu.com/', true],
    ['a*.baidu.com', 'https://alpha.beta.baidu.com/', true],
    ['a*.baidu.com', 'https://beta.baidu.com/', false],
    ['*.baidu.*', 'https://demo.baidu.cn/', true],
    ['*.baidu.com/api/*', 'https://demo.baidu.com/api/a/b/c?query=1#result', true],
    ['*.baidu.com/api/*', 'https://demo.baidu.com/admin', false],
    ['https://www.baidu.com', 'https://www.baidu.com/any/path', true],
    ['https://www.baidu.com/api', 'https://www.baidu.com/api', true],
    ['https://www.baidu.com/api', 'https://www.baidu.com/api/child', false],
    ['*.baidu.com:8443/*', 'https://demo.baidu.com:8443/a', true],
    ['*.baidu.com:8443/*', 'https://demo.baidu.com/a', false],
    ['*.baidu.com/*', 'https://demo.baidu.com:8443/a', false],
    ['*.baidu.com', 'https://127.0.0.1/', false],
  ] satisfies Array<[string, string, boolean]>)('%s matches %s: %s', (pattern, target, expected) => {
    expect(matchesHttpsUrlPattern(pattern, target)).toBe(expected)
  })

  it('ignores the declared path only for same-origin follow-up checks', () => {
    expect(matchesHttpsUrlPatternOrigin('*.baidu.com/api/*', 'https://demo.baidu.com')).toBe(true)
    expect(matchesHttpsUrlPatternOrigin('*.baidu.com/api/*', 'https://demo.baidu.com:8443')).toBe(false)
    expect(matchesHttpsUrlPatternOrigin('*.baidu.com/api/*', 'https://baidu.com')).toBe(false)
  })
})
