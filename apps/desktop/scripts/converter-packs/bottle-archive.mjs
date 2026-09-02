import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { TextDecoder } from 'node:util'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { posix } from 'node:path'
import { fail, requireAbsolutePath, withStableRegularFile } from './pack-tooling-lib.mjs'

const maximumExpandedBytes = 4 * 1024 * 1024 * 1024
const maximumPaxBytes = 64 * 1024
const maximumPathBytes = 4 * 1024
const maximumEntries = 100_000
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
  const field = header.subarray(offset, offset + length)
  if (!field.every((byte) => byte === 0 || byte === 0x20 || (byte >= 0x30 && byte <= 0x37))) invalid()
  const match = /^[ \0]*([0-7]+)[ \0]*$/u.exec(field.toString('ascii'))
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
  if (copy.reduce((sum, byte) => sum + byte, 0) !== expected) invalid()
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
    const keyBytes = record.subarray(0, separator)
    if (!keyBytes.every((byte) => byte >= 0x61 && byte <= 0x7a)) invalid()
    const key = keyBytes.toString('ascii')
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

class StreamBytes {
  constructor(readable) {
    this.iterator = readable[Symbol.asyncIterator]()
    this.chunk = Buffer.alloc(0)
    this.offset = 0
    this.expandedBytes = 0
    this.done = false
  }

  async nextChunk() {
    while (this.offset >= this.chunk.byteLength && !this.done) {
      const next = await this.iterator.next()
      this.done = Boolean(next.done)
      if (this.done) break
      if (!(next.value instanceof Uint8Array) || next.value.byteLength === 0) invalid()
      this.chunk = Buffer.isBuffer(next.value)
        ? next.value
        : Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength)
      this.offset = 0
      this.expandedBytes += this.chunk.byteLength
      if (!Number.isSafeInteger(this.expandedBytes) || this.expandedBytes > maximumExpandedBytes) invalid()
    }
    return this.offset < this.chunk.byteLength
  }

  async consume(length, consumer) {
    let remaining = length
    while (remaining > 0) {
      if (!await this.nextChunk()) invalid()
      const available = Math.min(remaining, this.chunk.byteLength - this.offset)
      const value = this.chunk.subarray(this.offset, this.offset + available)
      await consumer?.(value)
      this.offset += available
      remaining -= available
    }
  }

  async collect(length) {
    const result = Buffer.alloc(length)
    let offset = 0
    await this.consume(length, (chunk) => {
      chunk.copy(result, offset)
      offset += chunk.byteLength
    })
    return result
  }

  async blockOrEnd() {
    if (!await this.nextChunk()) return undefined
    return this.collect(512)
  }

  async finish() {
    if (await this.nextChunk()) invalid()
  }
}

async function scanTar(readable, onFile) {
  const stream = new StreamBytes(readable)
  const entries = []
  const seen = new Set()
  let zeroBlocks = 0
  let pax
  while (true) {
    const header = await stream.blockOrEnd()
    if (header === undefined) break
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

    if (type === 'x') {
      if (pax !== undefined || headerSize !== size || size > maximumPaxBytes) invalid()
      pax = parsePax(await stream.collect(size))
    } else {
      const name = tarString(header, 0, 100)
      const prefix = tarString(header, 345, 155)
      const headerPath = prefix ? `${prefix}/${name}` : name
      const path = safeArchivePath(pax?.path ?? headerPath, type === '5')
      const folded = path.toLocaleLowerCase('en-US')
      if (seen.has(folded) || entries.length >= maximumEntries) invalid()
      seen.add(folded)
      const mode = tarNumber(header, 100, 8)
      if (mode > 0o777 || ((type === '2' || type === '5') && size !== 0)) invalid()
      if (type !== '2' && pax?.linkpath !== undefined) invalid()
      const kind = type === '0' ? 'file' : type === '2' ? 'symlink' : 'directory'
      const linkpath = type === '2' ? (pax?.linkpath ?? tarString(header, 157, 100)) : undefined
      const digest = type === '0' ? createHash('sha256') : undefined
      const sink = type === '0' ? await onFile?.({ path, type: kind, mode, size }) : undefined
      await stream.consume(size, async (chunk) => {
        digest?.update(chunk)
        await sink?.write(chunk)
      })
      const sha256 = digest?.digest('hex')
      await sink?.finish({ path, type: kind, mode, size, sha256 })
      entries.push(Object.freeze({
        path,
        type: kind,
        mode,
        size,
        sha256,
        linkTarget: type === '2' ? safeLinkTarget(path, linkpath) : undefined,
      }))
      pax = undefined
    }
    const padding = (512 - (size % 512)) % 512
    if (padding > 0 && !(await stream.collect(padding)).every((byte) => byte === 0)) invalid()
  }
  await stream.finish()
  if (zeroBlocks < 2 || pax !== undefined) invalid()
  return Object.freeze(entries)
}

async function hashOpenFile(handle, expectedBytes) {
  const digest = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let position = 0
  while (position < expectedBytes) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, expectedBytes - position), position)
    if (bytesRead <= 0) invalid()
    digest.update(buffer.subarray(0, bytesRead))
    position += bytesRead
  }
  return digest.digest('hex')
}

export async function scanVerifiedBottleEntries({
  archive,
  expectedBytes,
  expectedSha256,
  onFile,
  beforeStreamForTest,
  authenticateChunkForTest,
}) {
  requireAbsolutePath(archive, 'Bottle archive path')
  if (
    !Number.isSafeInteger(expectedBytes)
    || expectedBytes <= 0
    || expectedBytes > maximumExpandedBytes
    || !sha256Pattern.test(expectedSha256)
    || (onFile !== undefined && typeof onFile !== 'function')
    || (beforeStreamForTest !== undefined && typeof beforeStreamForTest !== 'function')
    || (authenticateChunkForTest !== undefined && typeof authenticateChunkForTest !== 'function')
  ) invalid()
  return withStableRegularFile(archive, 'Bottle archive', async (handle, metadata) => {
    if (metadata.size !== expectedBytes) invalid()
    if (await hashOpenFile(handle, expectedBytes) !== expectedSha256) invalid()
    const compressed = handle.createReadStream({
      autoClose: false,
      autoDestroy: false,
      start: 0,
      end: expectedBytes - 1,
    })
    const streamedDigest = createHash('sha256')
    let streamedBytes = 0
    const authenticated = new Transform({
      transform(chunk, _encoding, callback) {
        streamedBytes += chunk.byteLength
        if (!Number.isSafeInteger(streamedBytes) || streamedBytes > expectedBytes) {
          callback(new Error('Bottle archive is invalid.'))
          return
        }
        streamedDigest.update(chunk)
        try {
          authenticateChunkForTest?.({ chunk, streamedBytes })
          callback(null, chunk)
        } catch (error) {
          callback(error)
        }
      },
    })
    const gunzip = createGunzip()
    let scanPromise
    let pipelinePromise
    let compressedPromise
    let failed = false
    const forwardCompressedError = (error) => authenticated.destroy(error)
    try {
      await beforeStreamForTest?.({ archive, compressed })
      compressed.once('error', forwardCompressedError)
      pipelinePromise = pipeline(authenticated, gunzip)
      compressedPromise = new Promise((resolvePromise, rejectPromise) => {
        const cleanup = () => {
          compressed.off('end', onEnd)
          compressed.off('error', onError)
          compressed.off('close', onClose)
        }
        const onEnd = () => {
          cleanup()
          resolvePromise()
        }
        const onError = (error) => {
          cleanup()
          rejectPromise(error)
        }
        const onClose = () => {
          cleanup()
          if (compressed.readableEnded) resolvePromise()
          else rejectPromise(new Error('Compressed bottle stream closed early.'))
        }
        compressed.once('end', onEnd)
        compressed.once('error', onError)
        compressed.once('close', onClose)
      })
      compressed.pipe(authenticated)
      scanPromise = scanTar(gunzip, onFile)
      const [entries] = await Promise.all([scanPromise, pipelinePromise, compressedPromise])
      if (streamedBytes !== expectedBytes || streamedDigest.digest('hex') !== expectedSha256) invalid()
      return entries
    } catch (error) {
      failed = true
      if (
        error instanceof Error
        && ['Bottle archive is invalid.', 'Bottle universe inventory is invalid.'].includes(error.message)
      ) throw error
      invalid()
    } finally {
      compressed.off('error', forwardCompressedError)
      compressed.unpipe(authenticated)
      if (failed) compressed.destroy()
      else if (!compressed.readableEnded && !compressed.destroyed) compressed.resume()
      authenticated.destroy()
      gunzip.destroy()
      await Promise.allSettled([scanPromise, pipelinePromise, compressedPromise].filter(Boolean))
    }
  })
}

export async function readVerifiedBottleEntries(options) {
  return scanVerifiedBottleEntries(options)
}
