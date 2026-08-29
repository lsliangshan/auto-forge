import { describe, expect, it } from 'vitest'
import { isAbsoluteConverterPackTestRoot } from './converter-pack-test-root.js'

describe('signed converter integration root paths', () => {
  it('uses POSIX absolute paths on macOS and rejects normalized escapes', () => {
    expect(isAbsoluteConverterPackTestRoot('/fixtures/converter-pack', 'darwin')).toBe(true)
    expect(isAbsoluteConverterPackTestRoot('fixtures/converter-pack', 'darwin')).toBe(false)
    expect(isAbsoluteConverterPackTestRoot('/fixtures/../converter-pack', 'darwin')).toBe(false)
    expect(isAbsoluteConverterPackTestRoot('C:\\fixtures\\converter-pack', 'darwin')).toBe(false)
  })

  it('accepts native Windows drive and UNC roots while rejecting drive-relative and device paths', () => {
    expect(isAbsoluteConverterPackTestRoot('C:\\fixtures\\converter-pack', 'win32')).toBe(true)
    expect(isAbsoluteConverterPackTestRoot('\\\\server\\share\\converter-pack', 'win32')).toBe(true)
    expect(isAbsoluteConverterPackTestRoot('C:fixtures\\converter-pack', 'win32')).toBe(false)
    expect(isAbsoluteConverterPackTestRoot('\\rooted-without-volume', 'win32')).toBe(false)
    expect(isAbsoluteConverterPackTestRoot('\\\\?\\C:\\device', 'win32')).toBe(false)
  })
})
