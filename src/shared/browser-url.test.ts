import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeBrowserUrl } from './browser-url.ts'

describe('normalizeBrowserUrl', () => {
  it('keeps http and https URLs unchanged', () => {
    assert.equal(normalizeBrowserUrl('https://example.com/path'), 'https://example.com/path')
    assert.equal(normalizeBrowserUrl('http://example.com'), 'http://example.com')
  })

  it('adds https to host-like input', () => {
    assert.equal(normalizeBrowserUrl('example.com'), 'https://example.com/')
  })

  it('adds http to localhost input', () => {
    assert.equal(normalizeBrowserUrl('localhost:5173'), 'http://localhost:5173/')
  })

  it('turns search text into a DuckDuckGo query URL', () => {
    assert.equal(
      normalizeBrowserUrl('auto forge docs'),
      'https://duckduckgo.com/?q=auto+forge+docs'
    )
  })
})
