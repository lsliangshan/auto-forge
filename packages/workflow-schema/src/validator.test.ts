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
  it('accepts only non-empty, unique approved format scopes for file conversion', () => {
    const conversionPermission = {
      capability: 'file.convert',
      scope: { formats: ['png', 'webp'] },
    }

    expect(validateManifest({ ...validManifest(), permissions: [conversionPermission] }).valid).toBe(true)
    for (const scope of [
      { formats: [] },
      { formats: ['png', 'png'] },
      { formats: ['docx'] },
      { formats: ['png'], origins: ['https://example.com'] },
      { formats: ['png'], paths: ['/tmp'] },
    ]) {
      expect(validateManifest({
        ...validManifest(), permissions: [{ capability: 'file.convert', scope }],
      }).valid).toBe(false)
    }
  })

  it('accepts omitted and bounded browser continuation metadata', () => {
    expect(validateManifest(validManifest()).valid).toBe(true)
    expect(validateManifest({
      ...validManifest(),
      browserContinuation: {
        auth: {
          loginUrls: ['https://sso.example.gov.cn/login/*'],
          loggedIn: ['role=button[name="退出"]'],
          loggedOut: ['css=form#login'],
        },
        readableRegions: ['role=main'],
        manualActions: [{ locator: 'role=button[name="正式提交"]', reason: '正式提交必须由用户完成' }],
      },
    }).valid).toBe(true)
  })

  it.each([
    { browserContinuation: { auth: { loginUrls: ['http://example.com/login'] } } },
    { browserContinuation: { manualActions: [{ locator: 'text=提交', reason: '提交' }] } },
    { browserContinuation: { manualActions: [{ locator: 'css=#submit', reason: '' }] } },
    { browserContinuation: { unknown: true } },
  ])('rejects unsafe continuation metadata %#', (patch) => {
    expect(validateManifest({ ...validManifest(), ...patch }).valid).toBe(false)
  })

  it.each([
    { browserContinuation: { auth: { loginUrls: Array.from({ length: 33 }, (_, index) => `https://sso.example.gov.cn/login/${index}`) } } },
    { browserContinuation: { auth: { loggedIn: Array.from({ length: 33 }, (_, index) => `css=#logged-in-${index}`) } } },
    { browserContinuation: { auth: { loggedOut: Array.from({ length: 33 }, (_, index) => `css=#logged-out-${index}`) } } },
    { browserContinuation: { readableRegions: Array.from({ length: 33 }, (_, index) => `css=#region-${index}`) } },
    {
      browserContinuation: {
        manualActions: Array.from({ length: 33 }, (_, index) => ({
          locator: `css=#manual-${index}`,
          reason: `manual ${index}`,
        })),
      },
    },
  ])('rejects continuation locator fan-out above the finite cap %#', (patch) => {
    expect(validateManifest({ ...validManifest(), ...patch }).valid).toBe(false)
  })

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

  it('accepts all-city and multi-city workflow manifests', () => {
    expect(validateManifest({ ...validManifest(), cities: [] }).valid).toBe(true)
    expect(validateManifest({ ...validManifest(), cities: ['上海', '杭州'] }).valid).toBe(true)
  })

  it('accepts omitted, empty, and HTTPS workflow logos', () => {
    expect(validateManifest(validManifest()).valid).toBe(true)
    expect(validateManifest({ ...validManifest(), logo: '' }).valid).toBe(true)
    expect(validateManifest({
      ...validManifest(), logo: 'https://img.liangqy.com/autoforge/workflows/manifold.png',
    }).valid).toBe(true)
  })

  it('rejects unsafe or blank workflow logos', () => {
    for (const logo of [
      ' ',
      'http://img.liangqy.com/logo.png',
      'https://example.com/logo.png',
      'HTTPS://img.liangqy.com/logo.png',
      'https://user:password@img.liangqy.com/logo.png',
      'https://img.liangqy.com:443/logo.png',
      'data:image/png;base64,AA==',
    ]) {
      expect(validateManifest({ ...validManifest(), logo }).valid).toBe(false)
    }
  })

  it('rejects malformed or duplicate workflow cities', () => {
    for (const cities of [
      [''],
      ['   '],
      ['上海', '上海'],
      '上海',
    ]) {
      expect(validateManifest({ ...validManifest(), cities }).valid).toBe(false)
    }
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
