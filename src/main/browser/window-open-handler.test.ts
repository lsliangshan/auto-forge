import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createInlineWindowOpenHandler } from './window-open-handler.ts'

describe('createInlineWindowOpenHandler', () => {
  it('loads requested pop-up URLs in the current web contents and denies new windows', () => {
    const loadedUrls: string[] = []
    const handler = createInlineWindowOpenHandler((url) => {
      loadedUrls.push(url)
    })

    const result = handler({ url: 'https://example.com/docs' })

    assert.deepEqual(loadedUrls, ['https://example.com/docs'])
    assert.deepEqual(result, { action: 'deny' })
  })
})
