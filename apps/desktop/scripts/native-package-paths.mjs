import { posix, win32 } from 'node:path'

export function isAbsoluteNativePackagePath(value, platform) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) return false
  if (platform === 'win32') {
    if (/^\\\\[?.]\\/u.test(value)) return false
    const hasVolume = /^[A-Za-z]:\\/u.test(value) || /^\\\\[^\\]+\\[^\\]+(?:\\|$)/u.test(value)
    return hasVolume && win32.isAbsolute(value) && win32.normalize(value) === value
  }
  if (platform === 'darwin') return posix.isAbsolute(value) && posix.normalize(value) === value
  return false
}
