import { posix, win32 } from 'node:path'

export function isAbsoluteConverterPackTestRoot(
  value: string,
  platform: NodeJS.Platform,
): boolean {
  if (value.length === 0 || value.includes('\0')) return false
  if (platform === 'win32') {
    if (/^\\\\[?.]\\/u.test(value)) return false
    const hasVolume = /^[A-Za-z]:\\/u.test(value) || /^\\\\[^\\]+\\[^\\]+(?:\\|$)/u.test(value)
    return hasVolume && win32.isAbsolute(value) && win32.normalize(value) === value
  }
  if (platform === 'darwin') return posix.isAbsolute(value) && posix.normalize(value) === value
  return false
}
