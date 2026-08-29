import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, posix } from 'node:path'
import { URL } from 'node:url'

export const PACK_NAMES = Object.freeze(['image-icon', 'document', 'pdf', 'media'])
export const PACK_LIMITS = Object.freeze({
  maxArchiveBytes: 512 * 1024 * 1024,
  maxEntries: 256,
  maxEntryBytes: 1024 * 1024 * 1024,
  maxExpandedBytes: 2 * 1024 * 1024 * 1024,
})
const packNames = new Set(PACK_NAMES)
const sha256Pattern = /^[a-f0-9]{64}$/u
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
const portableSegment = /^[A-Za-z0-9._-]+$/u
const reservedWindowsName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu
const exactExecutablePaths = Object.freeze({
  'image-icon': Object.freeze({ darwin: ['bin/autoforge-image-converter'], win32: ['bin/autoforge-image-converter.exe'] }),
  document: Object.freeze({ darwin: ['program/soffice'], win32: ['program/soffice.exe'] }),
  pdf: Object.freeze({ darwin: ['bin/autoforge-pdf-raster', 'bin/pdfinfo'], win32: ['bin/autoforge-pdf-raster.exe', 'bin/pdfinfo.exe'] }),
  media: Object.freeze({ darwin: ['bin/ffmpeg', 'bin/ffprobe'], win32: ['bin/ffmpeg.exe', 'bin/ffprobe.exe'] }),
})
const requiredExecutablePaths = Object.freeze({
  'image-icon': Object.freeze({ darwin: 'bin/autoforge-image-converter', win32: 'bin/autoforge-image-converter.exe' }),
  document: Object.freeze({ darwin: 'program/soffice', win32: 'program/soffice.exe' }),
  pdf: Object.freeze({ darwin: 'bin/autoforge-pdf-raster', win32: 'bin/autoforge-pdf-raster.exe' }),
  media: Object.freeze({ darwin: 'bin/ffmpeg', win32: 'bin/ffmpeg.exe' }),
})

export function fail(message) {
  throw new Error(message)
}

export function parseArguments(argv, allowed) {
  if (argv.length % 2 !== 0) fail('Arguments must be flag/value pairs.')
  const result = Object.create(null)
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!allowed.includes(flag) || typeof value !== 'string' || value.length === 0 || result[flag] !== undefined) {
      fail('Invalid command arguments.')
    }
    result[flag] = value
  }
  if (allowed.some((flag) => result[flag] === undefined)) fail('All command arguments are required.')
  return result
}

export function requireAbsolutePath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value)) fail(`${label} must be an absolute path.`)
  if (value.includes('\0')) fail(`${label} is invalid.`)
  return value
}

export async function requireRegularFile(path, label) {
  const metadata = await lstat(path).catch(() => undefined)
  if (!metadata?.isFile() || metadata.isSymbolicLink()) fail(`${label} must be a regular file and symbolic links are forbidden.`)
  if (await realpath(path).catch(() => undefined) !== path) fail(`${label} path components must not use symbolic links.`)
  return metadata
}

export async function requireDirectory(path, label) {
  const metadata = await lstat(path).catch(() => undefined)
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) fail(`${label} must be a directory and symbolic links are forbidden.`)
  if (await realpath(path).catch(() => undefined) !== path) fail(`${label} path components must not use symbolic links.`)
  return metadata
}

export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('JSON contains a non-finite number.')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (!plainRecord(value)) fail('JSON must contain plain values only.')
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

export function canonicalBytes(value) {
  return Buffer.from(canonicalJson(value), 'utf8')
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function plainRecord(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value, expected) {
  if (!plainRecord(value)) return false
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index])
}

export function safeEntryPath(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || Buffer.byteLength(value, 'utf8') > 240
    || value.includes('\\')
    || value.includes('\0')
    || value.normalize('NFC') !== value
    || value.startsWith('/')
    || value.endsWith('/')
    || posix.normalize(value) !== value
  ) return false
  return value.split('/').every((segment) => (
    segment.length > 0
    && segment !== '.'
    && segment !== '..'
    && portableSegment.test(segment)
    && !segment.endsWith('.')
    && !segment.endsWith(' ')
    && !segment.includes(':')
    && !reservedWindowsName.test(segment)
  ))
}

export function approvedTarget(platform, arch) {
  return (platform === 'darwin' && (arch === 'arm64' || arch === 'x64'))
    || (platform === 'win32' && arch === 'x64')
}

function validVersion(value) {
  if (typeof value !== 'string' || value.length > 128) return false
  const match = semverPattern.exec(value)
  if (!match) return false
  return match[4] === undefined || match[4].split('.').every((part) => !/^\d+$/u.test(part) || part === '0' || !part.startsWith('0'))
}

function validArchiveUrl(value) {
  if (
    typeof value !== 'string'
    || value.length > 2_048
    || value !== value.trim()
    || value.includes('\\')
    || [...value].some((character) => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f)
  ) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && Boolean(url.hostname)
  } catch {
    return false
  }
}

export function validatePackDescriptor(value) {
  if (!exactKeys(value, ['name', 'version', 'platform', 'arch', 'archiveUrl', 'archiveSha256', 'archiveBytes', 'entries'])) {
    fail('Converter pack descriptor has an invalid schema.')
  }
  if (
    !packNames.has(value.name)
    || !validVersion(value.version)
    || !approvedTarget(value.platform, value.arch)
    || !validArchiveUrl(value.archiveUrl)
    || typeof value.archiveSha256 !== 'string'
    || !sha256Pattern.test(value.archiveSha256)
    || !Number.isSafeInteger(value.archiveBytes)
    || value.archiveBytes <= 0
    || value.archiveBytes > PACK_LIMITS.maxArchiveBytes
    || !Array.isArray(value.entries)
    || value.entries.length === 0
    || value.entries.length > PACK_LIMITS.maxEntries
  ) fail('Converter pack descriptor is invalid.')
  const paths = new Set()
  let expandedBytes = 0
  for (const entry of value.entries) {
    if (!exactKeys(entry, ['path', 'sha256', 'bytes', 'executable'])) fail('Converter pack entry has an invalid schema.')
    if (
      !safeEntryPath(entry.path)
      || typeof entry.sha256 !== 'string'
      || !sha256Pattern.test(entry.sha256)
      || !Number.isSafeInteger(entry.bytes)
      || entry.bytes < 0
      || entry.bytes > PACK_LIMITS.maxEntryBytes
      || typeof entry.executable !== 'boolean'
    ) fail('Converter pack entry is invalid.')
    expandedBytes += entry.bytes
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > PACK_LIMITS.maxExpandedBytes) {
      fail('Converter pack expanded size is invalid.')
    }
    const key = entry.path.toLowerCase()
    if (paths.has(key)) fail('Converter pack contains colliding entry paths.')
    paths.add(key)
  }
  validateExecutableSet(value.name, value.platform, value.entries.filter((entry) => entry.executable).map((entry) => entry.path))
  const licenses = value.entries.filter((entry) => entry.path.startsWith('LICENSES/') && !entry.executable && entry.bytes > 0)
  if (licenses.length === 0) fail('Converter pack is missing a license notice.')
  return value
}

export function validateIndex(value) {
  if (!exactKeys(value, ['schemaVersion', 'generatedAt', 'sequence', 'packs'])) fail('Converter pack index has an invalid schema.')
  if (
    value.schemaVersion !== 1
    || typeof value.generatedAt !== 'string'
    || !Number.isSafeInteger(value.sequence)
    || value.sequence < 0
    || !Array.isArray(value.packs)
    || value.packs.length === 0
    || value.packs.length > 64
  ) fail('Converter pack index is invalid.')
  try {
    if (new Date(value.generatedAt).toISOString() !== value.generatedAt) fail('Converter pack generatedAt is invalid.')
  } catch {
    fail('Converter pack generatedAt is invalid.')
  }
  const coordinates = new Set()
  for (const pack of value.packs) {
    validatePackDescriptor(pack)
    const coordinate = `${pack.name}\0${pack.version}\0${pack.platform}\0${pack.arch}`
    if (coordinates.has(coordinate)) fail('Converter pack coordinates must be unique.')
    coordinates.add(coordinate)
  }
  return value
}

export function validateExecutableSet(name, platform, executables) {
  const allowed = exactExecutablePaths[name]?.[platform]
  const required = requiredExecutablePaths[name]?.[platform]
  if (!allowed || !required) fail('Converter pack platform is unsupported.')
  const unique = new Set(executables)
  if (unique.size !== executables.length || !unique.has(required) || [...unique].some((path) => !allowed.includes(path))) {
    fail('Converter pack declares an unknown or missing executable.')
  }
}

export async function readCanonicalJson(path, label) {
  await requireRegularFile(path, label)
  const bytes = await readFile(path)
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch { fail(`${label} is not valid JSON.`) }
  return { bytes, value }
}

export async function collectPayloadEntries(root, declaredExecutables, declaredLicenses) {
  await requireDirectory(root, 'Pack payload')
  const resolvedRoot = await realpath(root)
  const executableSet = new Set(declaredExecutables)
  const licenseSet = new Set(declaredLicenses)
  const entries = []
  let expandedBytes = 0
  const visit = async (directory, prefix = '') => {
    const children = await readdir(directory, { withFileTypes: true })
    children.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)))
    for (const child of children) {
      const relativePath = prefix ? `${prefix}/${child.name}` : child.name
      if (!safeEntryPath(relativePath)) fail('Pack payload contains an unsafe name.')
      const absolutePath = join(directory, child.name)
      const metadata = await lstat(absolutePath)
      if (metadata.isSymbolicLink() || child.isSymbolicLink()) fail('Pack payload symbolic links are forbidden.')
      if (metadata.isDirectory() && child.isDirectory()) {
        await visit(absolutePath, relativePath)
        continue
      }
      if (!metadata.isFile() || !child.isFile()) fail('Pack payload may contain regular files only.')
      const resolved = await realpath(absolutePath)
      if (!resolved.startsWith(`${resolvedRoot}/`)) fail('Pack payload escapes its root.')
      if (metadata.size > PACK_LIMITS.maxEntryBytes || entries.length >= PACK_LIMITS.maxEntries) {
        fail('Pack payload exceeds converter pack limits.')
      }
      expandedBytes += metadata.size
      if (!Number.isSafeInteger(expandedBytes) || expandedBytes > PACK_LIMITS.maxExpandedBytes) {
        fail('Pack payload exceeds converter pack limits.')
      }
      const bytes = await readFile(absolutePath)
      const executable = executableSet.has(relativePath)
      const executableLike = (metadata.mode & 0o111) !== 0 || relativePath.toLowerCase().endsWith('.exe')
      if (executableLike !== executable) fail('Pack payload contains an unknown executable or incorrect executable mode.')
      if ((metadata.mode & 0o777) !== (executable ? 0o755 : 0o644)) fail('Pack payload file modes must be exactly 0755 or 0644.')
      entries.push({ path: relativePath, bytes, executable, sha256: sha256(bytes) })
    }
  }
  await visit(root)
  if (entries.length === 0) fail('Pack payload is empty.')
  for (const license of licenseSet) {
    const entry = entries.find((candidate) => candidate.path === license)
    if (!entry || entry.executable || entry.bytes.byteLength === 0 || !license.startsWith('LICENSES/')) {
      fail('Pack payload is missing a declared license notice.')
    }
  }
  if (licenseSet.size === 0) fail('Pack payload is missing a declared license notice.')
  return entries
}

function writeString(block, offset, length, value) {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.byteLength > length) fail('Archive path cannot be represented safely in USTAR.')
  bytes.copy(block, offset)
}

function writeOctal(block, offset, length, value) {
  writeString(block, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`)
}

function splitUstarPath(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' }
  for (let index = path.lastIndexOf('/'); index > 0; index = path.lastIndexOf('/', index - 1)) {
    const prefix = path.slice(0, index)
    const name = path.slice(index + 1)
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix }
  }
  fail('Archive path cannot be represented safely in USTAR.')
}

export function createRestrictedUstar(entries) {
  const archiveBytes = entries.reduce((total, entry) => total + 512 + entry.bytes.byteLength + ((512 - (entry.bytes.byteLength % 512)) % 512), 1_024)
  if (!Number.isSafeInteger(archiveBytes) || archiveBytes > PACK_LIMITS.maxArchiveBytes) fail('Pack archive exceeds converter pack limits.')
  const blocks = []
  for (const entry of entries) {
    const header = Buffer.alloc(512)
    const path = splitUstarPath(entry.path)
    writeString(header, 0, 100, path.name)
    writeOctal(header, 100, 8, entry.executable ? 0o755 : 0o644)
    writeOctal(header, 108, 8, 0)
    writeOctal(header, 116, 8, 0)
    writeOctal(header, 124, 12, entry.bytes.byteLength)
    writeOctal(header, 136, 12, 0)
    header.fill(0x20, 148, 156)
    writeString(header, 156, 1, '0')
    writeString(header, 257, 6, 'ustar\0')
    writeString(header, 263, 2, '00')
    writeString(header, 345, 155, path.prefix)
    const checksum = header.reduce((sum, value) => sum + value, 0)
    writeString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `)
    const padding = (512 - (entry.bytes.byteLength % 512)) % 512
    blocks.push(header, entry.bytes, Buffer.alloc(padding))
  }
  blocks.push(Buffer.alloc(1_024))
  return Buffer.concat(blocks)
}

function tarString(block, offset, length) {
  const field = block.subarray(offset, offset + length)
  const end = field.indexOf(0)
  if (end !== -1 && !field.subarray(end + 1).every((value) => value === 0)) fail('Archive contains a malformed string field.')
  return (end === -1 ? field : field.subarray(0, end)).toString('utf8')
}

function tarOctal(block, offset, length) {
  const field = block.subarray(offset, offset + length)
  if (field[length - 1] !== 0 || !field.subarray(0, length - 1).every((value) => value >= 0x30 && value <= 0x37)) {
    fail('Archive contains a malformed numeric field.')
  }
  return Number.parseInt(field.subarray(0, length - 1).toString('ascii'), 8)
}

function verifyTarHeader(header) {
  const checksum = header.subarray(148, 156)
  const copy = Buffer.from(header)
  copy.fill(0x20, 148, 156)
  if (
    checksum[6] !== 0
    || checksum[7] !== 0x20
    || !checksum.subarray(0, 6).every((value) => value >= 0x30 && value <= 0x37)
    || Number.parseInt(checksum.subarray(0, 6).toString('ascii'), 8) !== copy.reduce((sum, value) => sum + value, 0)
    || !header.subarray(257, 263).equals(Buffer.from('ustar\0'))
    || !header.subarray(263, 265).equals(Buffer.from('00'))
    || header[156] !== 0x30
    || !header.subarray(157, 257).every((value) => value === 0)
    || tarOctal(header, 108, 8) !== 0
    || tarOctal(header, 116, 8) !== 0
    || tarOctal(header, 136, 12) !== 0
    || !header.subarray(265, 345).every((value) => value === 0)
    || !header.subarray(500, 512).every((value) => value === 0)
  ) fail('Archive header is unsafe or non-deterministic.')
}

export function verifyRestrictedUstar(archive, descriptor) {
  if (archive.byteLength !== descriptor.archiveBytes || archive.byteLength % 512 !== 0) fail('Archive size mismatch.')
  const expected = new Map(descriptor.entries.map((entry) => [entry.path, entry]))
  const seen = new Set()
  let offset = 0
  let zeroBlocks = 0
  while (offset < archive.byteLength) {
    const header = archive.subarray(offset, offset + 512)
    offset += 512
    if (header.every((value) => value === 0)) {
      zeroBlocks += 1
      continue
    }
    if (zeroBlocks !== 0) fail('Archive contains data after a terminator.')
    verifyTarHeader(header)
    const name = tarString(header, 0, 100)
    const prefix = tarString(header, 345, 155)
    const path = prefix ? `${prefix}/${name}` : name
    if (!safeEntryPath(path) || seen.has(path.toLowerCase())) fail('Archive contains an unsafe or duplicate path.')
    const entry = expected.get(path)
    if (!entry) fail('Archive contains an unexpected entry.')
    const size = tarOctal(header, 124, 12)
    const mode = tarOctal(header, 100, 8)
    if (size !== entry.bytes || mode !== (entry.executable ? 0o755 : 0o644)) fail('Archive entry metadata mismatch.')
    const bytes = archive.subarray(offset, offset + size)
    if (bytes.byteLength !== size || sha256(bytes) !== entry.sha256) fail('Archive entry hash mismatch.')
    offset += size
    const padding = (512 - (size % 512)) % 512
    if (!archive.subarray(offset, offset + padding).every((value) => value === 0)) fail('Archive padding is unsafe.')
    offset += padding
    seen.add(path.toLowerCase())
  }
  if (zeroBlocks < 2 || seen.size !== expected.size) fail('Archive entry set mismatch.')
}

export function archiveFilename(descriptor) {
  const url = new URL(descriptor.archiveUrl)
  const name = basename(url.pathname)
  if (!safeEntryPath(name) || name.includes('/') || !name.endsWith('.tar')) fail('Archive URL must end in a safe .tar filename.')
  return name
}

export async function listDirectoryNames(root) {
  return (await readdir(root, { withFileTypes: true })).map((entry) => ({ name: entry.name, entry }))
}

export function parentDirectory(path) {
  return dirname(path)
}
