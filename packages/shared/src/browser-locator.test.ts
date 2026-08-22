import { describe, expect, it } from 'vitest'
import { isBrowserLocator, parseBrowserLocator } from './browser-locator.js'

describe('browser locators', () => {
  it.each([
    'css=form#login',
    'role=main',
    'role=button[name="正式提交"]',
    'role=button[name="提交\\"确认"]',
  ])('accepts the supported locator grammar %s', (locator) => {
    expect(isBrowserLocator(locator)).toBe(true)
    expect(parseBrowserLocator(locator)).toBeDefined()
  })

  it.each([
    '',
    'text=提交',
    'css=',
    'css=form >> button',
    'role=',
    'role=not-a-real-role',
    'role=button[name=提交]',
    'role=button[name="提交"][exact=true]',
  ])('rejects locators outside the supported grammar %s', (locator) => {
    expect(isBrowserLocator(locator)).toBe(false)
    expect(parseBrowserLocator(locator)).toBeUndefined()
  })
})
