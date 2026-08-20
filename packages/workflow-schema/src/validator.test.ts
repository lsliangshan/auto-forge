import { describe, expect, it } from 'vitest'
import { validateManifest } from './validator.js'

function validManifest() {
  return {
    id: 'com.autoforge.browser.search',
    version: '1.2.3',
    name: '百度搜索',
    description: '在百度中搜索信息。',
    author: 'AutoForge',
    category: 'search',
    entryPath: 'dist/index.mjs',
    codeSha256: 'a'.repeat(64),
    permissions: [{
      capability: 'browser.open',
      scope: { origins: ['https://www.baidu.com'] },
    }],
    activationExamples: ['使用百度搜索今日天气'],
    activationNegativeExamples: [],
    timeoutMs: 30_000,
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
  }
}

describe('validateManifest', () => {
  it('requires activation examples and browser origin scopes', () => {
    const result = validateManifest({
      id: 'bad',
      permissions: [{ capability: 'browser.open' }],
    })

    expect(result.valid).toBe(false)
  })

  it('accepts a complete manifest and rejects unknown fields', () => {
    const manifest = {
      id: 'com.autoforge.browser.search',
      version: '1.2.3',
      name: '百度搜索',
      description: '在百度中搜索信息。',
      author: 'AutoForge',
      category: 'search',
      entryPath: 'dist/index.mjs',
      codeSha256: 'a'.repeat(64),
      permissions: [{
        capability: 'browser.open',
        scope: { origins: ['https://www.baidu.com'] },
      }],
      activationExamples: ['使用百度搜索今日天气'],
      activationNegativeExamples: ['回答今日天气'],
      timeoutMs: 30_000,
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    }

    expect(validateManifest(manifest).valid).toBe(true)
    expect(validateManifest({ ...manifest, unexpected: true }).valid).toBe(false)
    expect(validateManifest({
      ...manifest,
      permissions: [{ capability: 'browser.open', scope: { origins: ['http://www.baidu.com'] } }],
    }).valid).toBe(false)
  })

  it('enforces identifier, version, path, hash, and timeout constraints', () => {
    const manifest = {
      id: 'com.autoforge.browser.search',
      version: '1.2.3',
      name: '百度搜索',
      description: '在百度中搜索信息。',
      author: 'AutoForge',
      category: 'search',
      entryPath: 'dist/index.mjs',
      codeSha256: 'a'.repeat(64),
      permissions: [{
        capability: 'browser.open',
        scope: { origins: ['https://www.baidu.com'] },
      }],
      activationExamples: ['使用百度搜索今日天气'],
      activationNegativeExamples: [],
      timeoutMs: 30_000,
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    }

    for (const invalid of [
      { ...manifest, id: 'browser-search' },
      { ...manifest, version: 'v1.2.3' },
      { ...manifest, entryPath: '../index.mjs' },
      { ...manifest, codeSha256: 'a'.repeat(63) },
      { ...manifest, timeoutMs: 999 },
      { ...manifest, timeoutMs: 300_001 },
    ]) {
      expect(validateManifest(invalid).valid).toBe(false)
    }
  })

  it('rejects reverse-DNS labels ending in a hyphen', () => {
    expect(validateManifest({ ...validManifest(), id: 'com-.autoforge.browser.search' }).valid).toBe(false)
  })

  it('rejects SemVer numeric prerelease identifiers with leading zeroes', () => {
    expect(validateManifest({ ...validManifest(), version: '1.2.3-01' }).valid).toBe(false)
  })

  it.each([
    '*.baidu.com',
    '*.baidu.com/*',
    'a*.baidu.com',
    '*.baidu.*',
    '*.baidu.com/api/*',
    'https://*.baidu.com/api/*',
  ])('accepts HTTPS URL pattern %s', (origin) => {
    expect(validateManifest({
      ...validManifest(),
      permissions: [{ capability: 'browser.open', scope: { origins: [origin] } }],
    }).valid).toBe(true)
  })

  it('rejects unsafe or unrestricted HTTPS URL patterns', () => {
    for (const origin of [
      'https://allowed.example@evil.example',
      'https://allowed.example?query=value',
      'https://allowed.example#fragment',
      'http://allowed.example',
      '*',
      '*/*',
      '*.baidu.com:*',
      '127.0.*',
    ]) {
      expect(validateManifest({
        ...validManifest(),
        permissions: [{ capability: 'browser.open', scope: { origins: [origin] } }],
      }).valid).toBe(false)
    }
  })
})
