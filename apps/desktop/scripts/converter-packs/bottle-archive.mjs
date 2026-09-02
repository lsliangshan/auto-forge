import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'
import { TextDecoder } from 'node:util'
import { createGunzip } from 'node:zlib'
import { posix } from 'node:path'
import { fail, readStableRegularFile, requireAbsolutePath } from './pack-tooling-lib.mjs'

const maximumExpandedBytes = 4 * 1024 * 1024 * 1024
const maximumPaxBytes = 64 * 1024
const maximumPathBytes = 4 * 1024
const maximumEntries = 1_000_000
const sha256Pattern = /^[a-f0-9]{64}$/u
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

function invalid() {
  fail('Bottle archive is invalid.')
}

function decodeUtf8(bytes) {
  try {
    return utf8Decoder.decode(bytes)
  } catch {
    invalid()
  }
}

function tarString(header, offset, length) {
  const field = header.subarray(offset, offset + length)
  const nul = field.indexOf(0)
  if (nul !== -1 && !field.subarray(nul + 1).every((byte) => byte === 0)) invalid()
  return decodeUtf8(nul === -1 ? field : field.subarray(0, nul))
}

function tarNumber(header, offset, length) {
  const value = header.subarray(offset, offset + length).toString('ascii')
  const match = /^[ \0]*([0-7]+)[ \0]*$/u.exec(value)
  if (!match) invalid()
  const number = Number.parseInt(match[1], 8)
  if (!Number.isSafeInteger(number) || number < 0) invalid()
  return number
}

function containsControlCharacter(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0)
    return code <= 0x1f || code === 0x7f
  })
}

function verifyHeader(header) {
  if (
    header.byteLength !== 512
    || !header.subarray(257, 263).equals(Buffer.from('ustar\0'))
    || !header.subarray(263, 265).equals(Buffer.from('00'))
  ) invalid()
  const expected = tarNumber(header, 148, 8)
  const copy = Buffer.from(header)
  copy.fill(0x20, 148, 156)
  const actual = copy.reduce((sum, byte) => sum + byte, 0)
  if (actual !== expected) invalid()
  for (const [offset, length] of [[100, 8], [108, 8], [116, 8], [124, 12], [136, 12]]) {
    tarNumber(header, offset, length)
  }
}

function safeArchivePath(value, directory = false) {
  if (directory && value.endsWith('/')) value = value.slice(0, -1)
  if (
    value.length === 0
    || Buffer.byteLength(value, 'utf8') > maximumPathBytes
    || value.includes('\\')
    || value.includes('\0')
    || containsControlCharacter(value)
    || value.normalize('NFC') !== value
    || posix.isAbsolute(value)
    || posix.normalize(value) !== value
  ) invalid()
  for (const segment of value.split('/')) {
    if (segment.length === 0 || segment === '.' || segment === '..') invalid()
  }
  return value
}

function safeLinkTarget(entryPath, linkpath) {
  if (
    linkpath.length === 0
    || Buffer.byteLength(linkpath, 'utf8') > maximumPathBytes
    || linkpath.includes('\0')
    || linkpath.includes('\\')
    || containsControlCharacter(linkpath)
    || linkpath.normalize('NFC') !== linkpath
    || posix.isAbsolute(linkpath)
  ) invalid()
  const target = posix.normalize(posix.join(posix.dirname(entryPath), linkpath))
  if (target === '..' || target.startsWith('../') || posix.isAbsolute(target)) invalid()
  return safeArchivePath(target)
}

function parsePax(bytes) {
  if (bytes.byteLength === 0 || bytes.byteLength > maximumPaxBytes) invalid()
  const values = Object.create(null)
  let offset = 0
  while (offset < bytes.byteLength) {
    let space = offset
    while (space < bytes.byteLength && bytes[space] >= 0x30 && bytes[space] <= 0x39) space += 1
    if (space === offset || bytes[space] !== 0x20) invalid()
    const lengthText = bytes.subarray(offset, space).toString('ascii')
    if (lengthText.length > 1 && lengthText.startsWith('0')) invalid()
    const length = Number.parseInt(lengthText, 10)
    if (!Number.isSafeInteger(length) || length <= space - offset + 2 || offset + length > bytes.byteLength) invalid()
    const record = bytes.subarray(space + 1, offset + length)
    if (record.at(-1) !== 0x0a) invalid()
    const separator = record.indexOf(0x3d)
    if (separator <= 0) invalid()
    const key = record.subarray(0, separator).toString('ascii')
    if (!['path', 'linkpath', 'size'].includes(key) || values[key] !== undefined) invalid()
    const value = decodeUtf8(record.subarray(separator + 1, -1))
    if (value.length === 0 || value.includes('\0')) invalid()
    values[key] = value
    offset += length
  }
  if (Object.keys(values).length === 0) invalid()
  if (values.path !== undefined && Buffer.byteLength(values.path, 'utf8') > maximumPathBytes) invalid()
  if (values.linkpath !== undefined && Buffer.byteLength(values.linkpath, 'utf8') > maximumPathBytes) invalid()
  if (values.size !== undefined) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(values.size)) invalid()
    const size = Number(values.size)
    if (!Number.isSafeInteger(size) || size < 0 || size > maximumExpandedBytes) invalid()
    values.size = size
  }
  return values
}

function parseTar(archive) {
  if (archive.byteLength === 0 || archive.byteLength % 512 !== 0) invalid()
  const entries = []
  const seen = new Set()
  let offset = 0
  let zeroBlocks = 0
  let pax
  while (offset < archive.byteLength) {
    const header = archive.subarray(offset, offset + 512)
    offset += 512
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1
      continue
    }
    if (zeroBlocks !== 0) invalid()
    verifyHeader(header)
    const typeByte = header[156]
    const type = typeByte === 0 ? '0' : String.fromCharCode(typeByte)
    if (type === 'g' || !['0', '2', '5', 'x'].includes(type)) invalid()

    const headerSize = tarNumber(header, 124, 12)
    const size = pax?.size ?? headerSize
    if (!Number.isSafeInteger(size) || size < 0 || size > maximumExpandedBytes) invalid()
    const bytes = archive.subarray(offset, offset + size)
    if (bytes.byteLength !== size) invalid()
    offset += size
    const padding = (512 - (size % 512)) % 512
    if (offset + padding > archive.byteLength || !archive.subarray(offset, offset + padding).every((byte) => byte === 0)) invalid()
    offset += padding

    if (type === 'x') {
      if (pax !== undefined || headerSize !== size || size > maximumPaxBytes) invalid()
      pax = parsePax(bytes)
      continue
    }

    const name = tarString(header, 0, 100)
    const prefix = tarString(header, 345, 155)
    const headerPath = prefix ? `${prefix}/${name}` : name
    const path = safeArchivePath(pax?.path ?? headerPath, type === '5')
    const folded = path.toLocaleLowerCase('en-US')
    if (seen.has(folded) || entries.length >= maximumEntries) invalid()
    seen.add(folded)

    const mode = tarNumber(header, 100, 8)
    if (mode > 0o777) invalid()
    if ((type === '2' || type === '5') && size !== 0) invalid()
    if (type !== '2' && pax?.linkpath !== undefined) invalid()
    const linkpath = type === '2' ? (pax?.linkpath ?? tarString(header, 157, 100)) : undefined
    entries.push(Object.freeze({
      path,
      type: type === '0' ? 'file' : type === '2' ? 'symlink' : 'directory',
      mode,
      bytes: type === '0' ? Buffer.from(bytes) : undefined,
      linkTarget: type === '2' ? safeLinkTarget(path, linkpath) : undefined,
    }))
    pax = undefined
  }
  if (zeroBlocks < 2 || pax !== undefined) invalid()
  return Object.freeze(entries)
}

async function gunzipBounded(compressed) {
  const gunzip = createGunzip()
  const chunks = []
  let total = 0
  try {
    Readable.from([compressed]).pipe(gunzip)
    for await (const chunk of gunzip) {
      total += chunk.byteLength
      if (!Number.isSafeInteger(total) || total > maximumExpandedBytes) {
        gunzip.destroy()
        invalid()
      }
      chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks, total)
  } catch (error) {
    if (error instanceof Error && error.message === 'Bottle archive is invalid.') throw error
    invalid()
  }
}

export async function readVerifiedBottleEntries({ archive, expectedBytes, expectedSha256 }) {
  requireAbsolutePath(archive, 'Bottle archive path')
  if (
    !Number.isSafeInteger(expectedBytes)
    || expectedBytes <= 0
    || expectedBytes > maximumExpandedBytes
    || !sha256Pattern.test(expectedSha256)
  ) invalid()
  const compressed = await readStableRegularFile(archive, 'Bottle archive', expectedBytes)
  if (compressed.byteLength !== expectedBytes) invalid()
  if (createHash('sha256').update(compressed).digest('hex') !== expectedSha256) invalid()
  return parseTar(await gunzipBounded(compressed))
}
