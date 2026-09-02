import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, open, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { pathToFileURL, URL } from 'node:url'
import {
  canonicalBytes,
  fail,
  parseArguments,
  readStableRegularFile,
  requireAbsolutePath,
  requireDirectory,
  withStableRegularFile,
} from './pack-tooling-lib.mjs'
import { loadConverterClosureLock } from './closure-lock.mjs'

const sha256Pattern = /^[a-f0-9]{64}$/u
const noncePattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const partialMetadataLimit = 4 * 1024
const checkpointBytes = 16 * 1024 * 1024
const ownerHeartbeatMs = 5 * 1_000
const ownerLeaseTimeoutMs = 30 * 1_000
const downloadFailed = 'Converter source download failed.'
const partialInvalid = 'Converter source partial cache is invalid.'
const activeAcquisitionsKey = Symbol.for('autoforge.converter-source-active-acquisitions')
const activeAcquisitions = globalThis[activeAcquisitionsKey] instanceof Map
  ? globalThis[activeAcquisitionsKey]
  : new Map()
globalThis[activeAcquisitionsKey] = activeAcquisitions

function plainRecord(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value, expected) {
  if (!plainRecord(value)) return false
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function validHttpsUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048 || value !== value.trim()) return false
  try {
    const url = new URL(value)
    return url.href === value
      && url.protocol === 'https:'
      && Boolean(url.hostname)
      && !url.username
      && !url.password
      && !value.includes('#')
  } catch {
    return false
  }
}

function validArchiveIdentity(value) {
  return exactKeys(value, ['url', 'sha256', 'bytes'])
    && validHttpsUrl(value.url)
    && sha256Pattern.test(value.sha256)
    && Number.isSafeInteger(value.bytes)
    && value.bytes > 0
}

function acquisitionFailure(message, discardPartial = false) {
  const error = new Error(message)
  Object.defineProperty(error, 'discardPartial', { value: discardPartial })
  return error
}

function isMissing(error) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
}

async function boundedToken(response, signal) {
  if (!response.ok || response.status !== 200 || !response.body || (response.url && !validHttpsUrl(response.url))) {
    await response.body?.cancel().catch(() => undefined)
    throw acquisitionFailure('Converter source authentication failed.')
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  let cancelling
  let consumed = false
  const abort = () => { cancelling = reader.cancel().catch(() => undefined) }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  try {
    while (true) {
      if (signal.aborted) throw acquisitionFailure('Converter source authentication failed.')
      const { done, value } = await reader.read()
      if (done) {
        consumed = true
        break
      }
      total += value.byteLength
      if (total > 16 * 1024) {
        await reader.cancel().catch(() => undefined)
        throw acquisitionFailure('Converter source authentication failed.')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    signal.removeEventListener('abort', abort)
    await cancelling
    if (!consumed) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  let value
  try {
    value = JSON.parse(Buffer.concat(chunks, total).toString('utf8'))
  } catch {
    throw acquisitionFailure('Converter source authentication failed.')
  }
  if (!exactKeys(value, ['token']) || typeof value.token !== 'string' || value.token.length < 1 || value.token.length > 8_192) {
    throw acquisitionFailure('Converter source authentication failed.')
  }
  return value.token
}

function expectedGhcrScope(archiveUrl, expectedSha256) {
  const url = new URL(archiveUrl)
  const match = /^\/v2\/(homebrew\/core\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*)\/blobs\/sha256:([a-f0-9]{64})$/u.exec(url.pathname)
  if (!match || match[2] !== expectedSha256 || url.search.length !== 0) {
    throw acquisitionFailure('Converter source authentication failed.')
  }
  return `repository:${match[1]}:pull`
}

function parseBearerChallenge(value) {
  if (typeof value !== 'string') throw acquisitionFailure('Converter source authentication failed.')
  const scheme = /^([A-Za-z]+)[ \t]+/u.exec(value)
  if (!scheme || scheme[1].toLocaleLowerCase('en-US') !== 'bearer') {
    throw acquisitionFailure('Converter source authentication failed.')
  }
  let offset = scheme[0].length
  const parameters = new Map()
  while (offset < value.length) {
    while (value[offset] === ' ' || value[offset] === '\t') offset += 1
    const rest = value.slice(offset)
    const parameter = /^([A-Za-z][A-Za-z0-9_-]*)[ \t]*=[ \t]*"([^"\\]*)"/u.exec(rest)
    if (!parameter || [...parameter[2]].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 0x1f || code === 0x7f
    })) throw acquisitionFailure('Converter source authentication failed.')
    const name = parameter[1].toLocaleLowerCase('en-US')
    if (!['realm', 'service', 'scope'].includes(name) || parameters.has(name)) {
      throw acquisitionFailure('Converter source authentication failed.')
    }
    parameters.set(name, parameter[2])
    offset += parameter[0].length
    while (value[offset] === ' ' || value[offset] === '\t') offset += 1
    if (offset === value.length) break
    if (value[offset] !== ',') throw acquisitionFailure('Converter source authentication failed.')
    offset += 1
    if (offset === value.length) throw acquisitionFailure('Converter source authentication failed.')
  }
  if (parameters.size !== 3) throw acquisitionFailure('Converter source authentication failed.')
  return parameters
}

async function fetchArchive(fetchImpl, archive, init) {
  const archiveUrl = archive.url
  let response = await fetchImpl(archiveUrl, init)
  const url = new URL(archiveUrl)
  if (response.status !== 401 || url.hostname !== 'ghcr.io') return response
  await response.body?.cancel().catch(() => undefined)
  const expectedScope = expectedGhcrScope(archiveUrl, archive.sha256)
  const challenge = parseBearerChallenge(response.headers.get('www-authenticate'))
  if (
    challenge.get('realm') !== 'https://ghcr.io/token'
    || challenge.get('service') !== 'ghcr.io'
    || challenge.get('scope') !== expectedScope
  ) throw acquisitionFailure('Converter source authentication failed.')
  const tokenUrl = new URL(challenge.get('realm'))
  tokenUrl.searchParams.set('service', challenge.get('service'))
  tokenUrl.searchParams.set('scope', expectedScope)
  const token = await boundedToken(await fetchImpl(tokenUrl.href, { ...init, headers: undefined }), init.signal)
  const headers = new globalThis.Headers(init.headers)
  headers.set('authorization', `Bearer ${token}`)
  response = await fetchImpl(archiveUrl, { ...init, headers })
  return response
}

async function hashRegularFile(path, label, expectedBytes) {
  return withStableRegularFile(path, label, async (handle, metadata) => {
    if (metadata.size !== expectedBytes) return undefined
    const digest = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let position = 0
    while (position < metadata.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, metadata.size - position), position)
      if (bytesRead === 0) throw acquisitionFailure(`${label} changed while reading.`)
      digest.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    return digest.digest('hex')
  })
}

async function cachedArchive(path, archive) {
  const metadata = await lstat(path).catch((error) => isMissing(error) ? undefined : Promise.reject(error))
  if (metadata === undefined) return undefined
  if (metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 2) return undefined
  let digest
  try {
    digest = await hashRegularFile(path, 'Cached converter archive', archive.bytes)
  } catch {
    fail('Cached converter archive is invalid.')
  }
  if (digest === undefined) fail('Cached converter archive size does not match the source lock.')
  if (digest !== archive.sha256) fail('Cached converter archive hash does not match the source lock.')
  return { path, sha256: archive.sha256, bytes: archive.bytes, networkBytes: 0 }
}

function metadataValue(archive, partialBytes) {
  return { bytes: archive.bytes, partialBytes, sha256: archive.sha256, url: archive.url }
}

async function writePartialMetadata(path, archive, partialBytes) {
  const temporary = `${path}.${randomUUID()}.tmp`
  let handle
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    await handle.writeFile(canonicalBytes(metadataValue(archive, partialBytes)))
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, path)
    await syncDirectory(dirname(path))
  } finally {
    await handle?.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
  }
}

async function removePartial(partialPath, metadataPath) {
  await Promise.all([unlink(partialPath).catch(() => undefined), unlink(metadataPath).catch(() => undefined)])
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0))
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function ownerValue(archive, nonce) {
  return { bytes: archive.bytes, nonce, pid: process.pid, sha256: archive.sha256, url: archive.url }
}

async function readOwnerLock(path) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch((error) => {
    if (isMissing(error)) return undefined
    throw error
  })
  if (!handle) return undefined
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > partialMetadataLimit) return { stat }
    const bytes = await handle.readFile()
    let value
    try {
      value = JSON.parse(bytes.toString('utf8'))
    } catch {
      return { stat }
    }
    if (
      !bytes.equals(canonicalBytes(value))
      || !exactKeys(value, ['bytes', 'nonce', 'pid', 'sha256', 'url'])
      || !Number.isSafeInteger(value.bytes)
      || value.bytes <= 0
      || !noncePattern.test(value.nonce)
      || !Number.isSafeInteger(value.pid)
      || value.pid <= 0
      || !sha256Pattern.test(value.sha256)
      || !validHttpsUrl(value.url)
    ) return { stat }
    return { stat, value }
  } finally {
    await handle.close()
  }
}

function ownerAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EPERM')
  }
}

async function unlinkMatchingOwner(path, expected) {
  const current = await readOwnerLock(path)
  if (
    !current
    || current.stat.dev !== expected.stat.dev
    || current.stat.ino !== expected.stat.ino
    || (expected.value && current.value?.nonce !== expected.value.nonce)
  ) return false
  await unlink(path).catch((error) => {
    if (!isMissing(error)) throw error
  })
  return true
}

function matchingOwner(current, expected) {
  return Boolean(
    current?.value
    && current.stat.dev === expected.stat.dev
    && current.stat.ino === expected.stat.ino
    && current.value.nonce === expected.value.nonce,
  )
}

function freshOwnerLease(owner) {
  return Date.now() - owner.stat.mtimeMs <= ownerLeaseTimeoutMs
}

async function assertOwnerLease(path, owner) {
  const [current, opened] = await Promise.all([readOwnerLock(path), owner.handle.stat()])
  if (
    !matchingOwner(current, owner)
    || opened.dev !== owner.stat.dev
    || opened.ino !== owner.stat.ino
    || !freshOwnerLease(current)
  ) throw acquisitionFailure(downloadFailed)
  return current
}

async function renewOwnerLease(path, owner) {
  await assertOwnerLease(path, owner)
  const now = new Date()
  await owner.handle.utimes(now, now)
  const current = await assertOwnerLease(path, owner)
  owner.stat = current.stat
}

function startOwnerHeartbeat(path, owner, loseLease) {
  let pending = Promise.resolve()
  let stopped = false
  const heartbeat = () => {
    if (stopped) return
    pending = pending.then(() => renewOwnerLease(path, owner)).catch(() => {
      stopped = true
      loseLease()
    })
  }
  const timer = globalThis.setInterval(heartbeat, ownerHeartbeatMs)
  timer.unref?.()
  return async () => {
    stopped = true
    globalThis.clearInterval(timer)
    await pending
  }
}

async function reclaimOwner({ path, cacheRoot, partialPath, metadataPath, owner }) {
  if (!await unlinkMatchingOwner(path, owner)) return false
  await removePartial(partialPath, metadataPath)
  await syncDirectory(cacheRoot)
  return true
}

async function waitForOwner(signal) {
  if (signal.aborted) throw acquisitionFailure(downloadFailed)
  await new Promise((resolvePromise, rejectPromise) => {
    const finish = () => {
      signal.removeEventListener('abort', abort)
      resolvePromise()
    }
    const timer = globalThis.setTimeout(finish, 25)
    const abort = () => {
      globalThis.clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      rejectPromise(acquisitionFailure(downloadFailed))
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

async function acquireOwnerLock({ path, cacheRoot, partialPath, metadataPath, archive, signal }) {
  while (true) {
    if (signal.aborted) throw acquisitionFailure(downloadFailed)
    const nonce = randomUUID()
    let handle
    try {
      handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      const value = ownerValue(archive, nonce)
      await handle.writeFile(canonicalBytes(value))
      await handle.sync()
      const stat = await handle.stat()
      await syncDirectory(cacheRoot)
      return { handle, stat, value }
    } catch (error) {
      await handle?.close().catch(() => undefined)
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
    }

    const owner = await readOwnerLock(path)
    if (owner?.value && (
      owner.value.sha256 !== archive.sha256
      || owner.value.url !== archive.url
      || owner.value.bytes !== archive.bytes
    )) fail('Converter source artifact identities conflict.')
    if (owner?.value && ownerAlive(owner.value.pid) && freshOwnerLease(owner)) {
      await waitForOwner(signal)
      continue
    }
    if (owner && (!owner.value && Date.now() - owner.stat.mtimeMs < 250)) {
      await waitForOwner(signal)
      continue
    }
    if (owner && await reclaimOwner({ path, cacheRoot, partialPath, metadataPath, owner })) {
      continue
    }
    await waitForOwner(signal)
  }
}

async function releaseOwnerLock(path, cacheRoot, owner) {
  try {
    const released = await unlinkMatchingOwner(path, owner)
    if (!released) throw acquisitionFailure(downloadFailed)
    await syncDirectory(cacheRoot)
  } catch {
    throw acquisitionFailure(downloadFailed)
  } finally {
    await owner.handle.close().catch(() => undefined)
  }
}

async function createPartial(partialPath, metadataPath, archive) {
  let handle
  try {
    handle = await open(partialPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    await handle.sync()
    await writePartialMetadata(metadataPath, archive, 0)
    return { handle, partialBytes: 0 }
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await removePartial(partialPath, metadataPath)
    throw error
  }
}

async function openExistingPartial(partialPath, metadataPath, archive) {
  const [partialStat, metadataStat] = await Promise.all([
    lstat(partialPath).catch((error) => isMissing(error) ? undefined : Promise.reject(error)),
    lstat(metadataPath).catch((error) => isMissing(error) ? undefined : Promise.reject(error)),
  ])
  if (partialStat === undefined && metadataStat === undefined) return createPartial(partialPath, metadataPath, archive)
  if (partialStat === undefined || metadataStat === undefined) {
    await removePartial(partialPath, metadataPath)
    throw acquisitionFailure(partialInvalid, true)
  }

  let value
  try {
    const bytes = await readStableRegularFile(metadataPath, 'Converter source partial metadata', partialMetadataLimit)
    value = JSON.parse(bytes.toString('utf8'))
    if (!bytes.equals(canonicalBytes(value))) throw new Error('noncanonical')
  } catch {
    await removePartial(partialPath, metadataPath)
    throw acquisitionFailure(partialInvalid, true)
  }
  if (
    !exactKeys(value, ['bytes', 'partialBytes', 'sha256', 'url'])
    || value.bytes !== archive.bytes
    || value.sha256 !== archive.sha256
    || value.url !== archive.url
    || !Number.isSafeInteger(value.partialBytes)
    || value.partialBytes < 0
    || value.partialBytes > archive.bytes
  ) {
    await removePartial(partialPath, metadataPath)
    throw acquisitionFailure(partialInvalid, true)
  }
  if (
    !partialStat.isFile()
    || partialStat.isSymbolicLink()
    || partialStat.nlink !== 1
    || partialStat.size < value.partialBytes
    || partialStat.size > archive.bytes
    || await realpath(partialPath).catch(() => undefined) !== partialPath
  ) {
    await removePartial(partialPath, metadataPath)
    throw acquisitionFailure(partialInvalid, true)
  }

  const handle = await open(partialPath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0)).catch(() => undefined)
  if (!handle) {
    await removePartial(partialPath, metadataPath)
    throw acquisitionFailure(partialInvalid, true)
  }
  const opened = await handle.stat()
  if (!opened.isFile() || opened.nlink !== 1 || !sameFileIdentity(partialStat, opened)) {
    await handle.close()
    await removePartial(partialPath, metadataPath)
    throw acquisitionFailure(partialInvalid, true)
  }
  if (opened.size > value.partialBytes) {
    await handle.truncate(value.partialBytes)
    await handle.sync()
  }
  return { handle, partialBytes: value.partialBytes }
}

function contentLength(response) {
  const value = response.headers.get('content-length')
  if (value === null) return undefined
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) throw acquisitionFailure(downloadFailed, true)
  const bytes = Number(value)
  if (!Number.isSafeInteger(bytes)) throw acquisitionFailure(downloadFailed, true)
  return bytes
}

function validateResponse(response, start, archive) {
  if (!response.body || (response.url && !validHttpsUrl(response.url))) throw acquisitionFailure(downloadFailed, true)
  if (start === 0) {
    if (response.status !== 200) throw acquisitionFailure(downloadFailed, true)
  } else if (response.status === 200) {
    const declared = contentLength(response)
    if (declared !== undefined && declared !== archive.bytes) throw acquisitionFailure(downloadFailed, true)
    return { restart: true }
  } else if (response.status === 206) {
    const match = /^bytes (0|[1-9]\d*)-(0|[1-9]\d*)\/(0|[1-9]\d*)$/u.exec(response.headers.get('content-range') ?? '')
    if (!match) throw acquisitionFailure(downloadFailed, true)
    const rangeStart = Number(match[1])
    const rangeEnd = Number(match[2])
    const total = Number(match[3])
    if (rangeStart !== start || rangeEnd !== archive.bytes - 1 || total !== archive.bytes) {
      throw acquisitionFailure(downloadFailed, true)
    }
    const declared = contentLength(response)
    if (declared !== undefined && declared !== archive.bytes - start) throw acquisitionFailure(downloadFailed, true)
    return { restart: false }
  } else {
    throw acquisitionFailure(downloadFailed)
  }
  const declared = contentLength(response)
  if (declared !== undefined && declared !== archive.bytes) throw acquisitionFailure(downloadFailed, true)
  return { restart: false }
}

export async function writeAll(handle, bytes, position) {
  if (!handle || typeof handle.write !== 'function' || !(bytes instanceof Uint8Array) || !Number.isSafeInteger(position) || position < 0) {
    throw acquisitionFailure(downloadFailed)
  }
  let offset = 0
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, position + offset)
    if (!Number.isSafeInteger(result?.bytesWritten) || result.bytesWritten <= 0 || result.bytesWritten > bytes.byteLength - offset) {
      throw acquisitionFailure(downloadFailed)
    }
    offset += result.bytesWritten
  }
  return offset
}

async function streamResponse({ response, handle, archive, metadataPath, start, signal, assertLease }) {
  const reader = response.body.getReader()
  let total = start
  let networkBytes = 0
  let checkpoint = start
  let cancelling
  let consumed = false
  const abort = () => { cancelling = reader.cancel().catch(() => undefined) }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  try {
    while (true) {
      if (signal.aborted) throw acquisitionFailure(downloadFailed)
      const { done, value } = await reader.read()
      if (done) {
        consumed = true
        break
      }
      if (!(value instanceof Uint8Array) || value.byteLength === 0) throw acquisitionFailure(downloadFailed, true)
      networkBytes += value.byteLength
      if (!Number.isSafeInteger(total + value.byteLength) || total + value.byteLength > archive.bytes) {
        await reader.cancel().catch(() => undefined)
        throw acquisitionFailure(downloadFailed, true)
      }
      total += await writeAll(handle, value, total)
      if (total - checkpoint >= checkpointBytes) {
        await assertLease()
        await handle.sync()
        await writePartialMetadata(metadataPath, archive, total)
        await assertLease()
        checkpoint = total
      }
    }
  } catch (error) {
    if (signal.aborted) throw acquisitionFailure(downloadFailed)
    throw error
  } finally {
    signal.removeEventListener('abort', abort)
    await cancelling
    if (!consumed) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  if (total !== archive.bytes) throw acquisitionFailure(downloadFailed)
  await assertLease()
  await handle.sync()
  await writePartialMetadata(metadataPath, archive, total)
  await assertLease()
  return networkBytes
}

export async function hashOpenPartial(handle, partialPath, archive, expectedLinks) {
  const beforeHandle = await handle.stat()
  const beforePath = await lstat(partialPath).catch(() => undefined)
  if (
    !beforePath?.isFile()
    || beforePath.isSymbolicLink()
    || beforeHandle.dev !== beforePath.dev
    || beforeHandle.ino !== beforePath.ino
    || beforeHandle.size !== archive.bytes
    || beforePath.size !== archive.bytes
    || beforeHandle.nlink !== expectedLinks
    || beforePath.nlink !== expectedLinks
  ) throw acquisitionFailure(downloadFailed)
  const digest = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let position = 0
  while (position < archive.bytes) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, archive.bytes - position), position)
    if (bytesRead <= 0) throw acquisitionFailure(downloadFailed)
    digest.update(buffer.subarray(0, bytesRead))
    position += bytesRead
  }
  const [afterHandle, afterPath] = await Promise.all([handle.stat(), lstat(partialPath).catch(() => undefined)])
  if (
    !afterPath
    || afterHandle.dev !== beforeHandle.dev
    || afterHandle.ino !== beforeHandle.ino
    || afterHandle.size !== beforeHandle.size
    || afterHandle.nlink !== expectedLinks
    || afterPath.dev !== beforeHandle.dev
    || afterPath.ino !== beforeHandle.ino
    || afterPath.size !== beforeHandle.size
    || afterPath.nlink !== expectedLinks
  ) throw acquisitionFailure(downloadFailed)
  return { digest: digest.digest('hex'), stat: afterHandle }
}

async function unlinkMatchingInode(path, expected) {
  const current = await lstat(path).catch(() => undefined)
  if (!current || current.dev !== expected.dev || current.ino !== expected.ino) return false
  await unlink(path)
  return true
}

async function recoverPublishedLink({ partialPath, metadataPath, target, archive, cacheRoot, assertLease }) {
  const [partial, published] = await Promise.all([
    lstat(partialPath).catch(() => undefined),
    lstat(target).catch(() => undefined),
  ])
  if (published === undefined) return undefined
  if (
    !partial?.isFile()
    || partial.isSymbolicLink()
    || !published.isFile()
    || published.isSymbolicLink()
    || partial.dev !== published.dev
    || partial.ino !== published.ino
    || partial.nlink !== 2
    || published.nlink !== 2
  ) return cachedArchive(target, archive)
  const handle = await open(partialPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const verified = await hashOpenPartial(handle, partialPath, archive, 2)
    if (verified.digest !== archive.sha256) throw acquisitionFailure(downloadFailed)
    await assertLease()
    if (!await unlinkMatchingInode(partialPath, verified.stat)) throw acquisitionFailure(downloadFailed)
    await unlink(metadataPath).catch((error) => { if (!isMissing(error)) throw error })
    await syncDirectory(cacheRoot)
  } finally {
    await handle.close()
  }
  return cachedArchive(target, archive)
}

async function publishPartial({ handle, partialPath, metadataPath, target, archive, cacheRoot, assertLease }) {
  let verified
  try {
    await assertLease()
    verified = await hashOpenPartial(handle, partialPath, archive, 1)
  } catch {
    throw acquisitionFailure(downloadFailed)
  }
  if (verified.digest !== archive.sha256) {
    await unlinkMatchingInode(partialPath, verified.stat).catch(() => undefined)
    await unlink(metadataPath).catch(() => undefined)
    throw acquisitionFailure('Downloaded converter archive hash does not match the source lock.', true)
  }
  try {
    await assertLease()
    await link(partialPath, target)
    await assertLease()
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
    const existing = await cachedArchive(target, archive)
    if (existing === undefined) throw acquisitionFailure(downloadFailed)
    const owned = await handle.stat()
    if (await unlinkMatchingInode(partialPath, owned)) {
      await unlink(metadataPath).catch(() => undefined)
      await syncDirectory(cacheRoot)
    }
    return
  }
  const [published, partial] = await Promise.all([lstat(target), lstat(partialPath)])
  if (
    published.dev !== verified.stat.dev
    || published.ino !== verified.stat.ino
    || partial.dev !== verified.stat.dev
    || partial.ino !== verified.stat.ino
    || published.nlink !== 2
    || partial.nlink !== 2
  ) {
    if (published.dev === partial.dev && published.ino === partial.ino) {
      await unlinkMatchingInode(target, published).catch(() => undefined)
      await syncDirectory(cacheRoot).catch(() => undefined)
    }
    throw acquisitionFailure(downloadFailed)
  }
  await syncDirectory(cacheRoot)
  await assertLease()
  if (!await unlinkMatchingInode(partialPath, published)) throw acquisitionFailure(downloadFailed)
  await unlink(metadataPath).catch((error) => { if (!isMissing(error)) throw error })
  await syncDirectory(cacheRoot)
  const [finalHandle, finalTarget] = await Promise.all([handle.stat(), lstat(target)])
  if (
    finalHandle.dev !== published.dev
    || finalHandle.ino !== published.ino
    || finalHandle.nlink !== 1
    || finalTarget.dev !== published.dev
    || finalTarget.ino !== published.ino
    || finalTarget.nlink !== 1
  ) throw acquisitionFailure(downloadFailed)
}

async function acquireOwnedArchive({ archive, cacheRoot, fetchImpl, signal }) {
  const target = join(cacheRoot, `${archive.sha256}.archive`)
  const partialPath = join(cacheRoot, `.${archive.sha256}.partial`)
  const metadataPath = join(cacheRoot, `.${archive.sha256}.partial.json`)
  const ownerPath = join(cacheRoot, `.${archive.sha256}.owner`)
  let cached
  try {
    cached = await cachedArchive(target, archive)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Cached converter archive ')) throw error
    fail('Cached converter archive is invalid.')
  }
  if (cached !== undefined) return cached

  let owner
  try {
    owner = await acquireOwnerLock({ path: ownerPath, cacheRoot, partialPath, metadataPath, archive, signal })
  } catch (error) {
    if (error?.message === downloadFailed || error?.message === 'Converter source artifact identities conflict.') throw error
    throw acquisitionFailure(downloadFailed)
  }
  const operationController = new globalThis.AbortController()
  const upstreamAbort = () => operationController.abort()
  if (signal.aborted) upstreamAbort()
  else signal.addEventListener('abort', upstreamAbort, { once: true })
  const loseLease = () => operationController.abort()
  const stopHeartbeat = startOwnerHeartbeat(ownerPath, owner, loseLease)
  const operationSignal = operationController.signal
  const assertLease = () => assertOwnerLease(ownerPath, owner)
  let handle
  let networkBytes = 0
  try {
    await assertLease()
    cached = await cachedArchive(target, archive)
    if (cached !== undefined) {
      await assertLease()
      await removePartial(partialPath, metadataPath)
      return cached
    }
    cached = await recoverPublishedLink({ partialPath, metadataPath, target, archive, cacheRoot, assertLease })
    if (cached !== undefined) return cached
    const partial = await openExistingPartial(partialPath, metadataPath, archive)
    handle = partial.handle
    let start = partial.partialBytes
    if (start < archive.bytes) {
      if (operationSignal.aborted) throw acquisitionFailure(downloadFailed)
      const headers = new globalThis.Headers()
      if (start > 0) headers.set('range', `bytes=${start}-`)
      const requestInit = {
        method: 'GET', redirect: 'follow', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
        headers, signal: operationSignal,
      }
      let response
      try {
        response = await fetchArchive(fetchImpl, archive, requestInit)
      } catch (error) {
        if (error?.discardPartial === true || error?.message === 'Converter source authentication failed.') throw error
        throw acquisitionFailure(downloadFailed)
      }
      let validated
      try {
        validated = validateResponse(response, start, archive)
      } catch (error) {
        await response.body?.cancel().catch(() => undefined)
        throw error
      }
      if (validated.restart) {
        await assertLease()
        await handle.truncate(0)
        await handle.sync()
        await writePartialMetadata(metadataPath, archive, 0)
        await assertLease()
        start = 0
      }
      networkBytes = await streamResponse({
        response, handle, archive, metadataPath, start, signal: operationSignal, assertLease,
      })
    }
    await publishPartial({ handle, partialPath, metadataPath, target, archive, cacheRoot, assertLease })
    await handle.close()
    handle = undefined
    return { path: target, sha256: archive.sha256, bytes: archive.bytes, networkBytes }
  } catch (error) {
    if (error?.discardPartial === true && handle) {
      const owned = await handle.stat().catch(() => undefined)
      if (owned && await unlinkMatchingInode(partialPath, owned).catch(() => false)) {
        await unlink(metadataPath).catch(() => undefined)
      }
    } else if (error?.discardPartial === true) {
      await removePartial(partialPath, metadataPath)
    }
    await handle?.close().catch(() => undefined)
    if (error instanceof Error && [
      downloadFailed, partialInvalid, 'Converter source authentication failed.',
      'Downloaded converter archive hash does not match the source lock.',
    ].includes(error.message)) throw error
    throw acquisitionFailure(downloadFailed)
  } finally {
    await stopHeartbeat()
    signal.removeEventListener('abort', upstreamAbort)
    await releaseOwnerLock(ownerPath, cacheRoot, owner)
  }
}

function waitForSharedAcquisition(shared, signal) {
  shared.waiters += 1
  let abort
  const abortError = acquisitionFailure(downloadFailed)
  const aborted = signal === undefined ? undefined : new Promise((_resolvePromise, rejectPromise) => {
    abort = () => rejectPromise(abortError)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
  let released = false
  const release = () => {
    if (released) return false
    released = true
    signal?.removeEventListener('abort', abort)
    shared.waiters -= 1
    const last = shared.waiters === 0 && !shared.settled
    if (last) shared.controller.abort()
    return last
  }
  return (async () => {
    try {
      return await (aborted === undefined ? shared.promise : Promise.race([shared.promise, aborted]))
    } catch (error) {
      if (error === abortError && release()) await shared.promise.catch(() => undefined)
      throw error
    } finally {
      release()
    }
  })()
}

export async function acquireVerifiedArchive({ archive, cacheRoot, fetchImpl = globalThis.fetch, signal }) {
  if (!validArchiveIdentity(archive)) fail('Converter source archive identity is invalid.')
  requireAbsolutePath(cacheRoot, 'Converter source cache root')
  await requireDirectory(cacheRoot, 'Converter source cache root')
  if (typeof fetchImpl !== 'function' || (signal !== undefined && !(signal instanceof globalThis.AbortSignal))) {
    fail('Converter source acquisition options are invalid.')
  }
  const key = `${cacheRoot}\0${archive.sha256}`
  let shared = activeAcquisitions.get(key)
  if (shared === undefined) {
    const controller = new globalThis.AbortController()
    const identity = Object.freeze({ ...archive })
    shared = {
      archive: identity,
      controller,
      waiters: 0,
      settled: false,
      promise: acquireOwnedArchive({ archive: identity, cacheRoot, fetchImpl, signal: controller.signal }),
    }
    activeAcquisitions.set(key, shared)
    shared.promise.then(
      () => {
        shared.settled = true
        if (activeAcquisitions.get(key) === shared) activeAcquisitions.delete(key)
      },
      () => {
        shared.settled = true
        if (activeAcquisitions.get(key) === shared) activeAcquisitions.delete(key)
      },
    )
  } else if (shared.archive.url !== archive.url || shared.archive.bytes !== archive.bytes) {
    fail('Converter source artifact identities conflict.')
  }
  return waitForSharedAcquisition(shared, signal)
}

function lockedArtifact(value) {
  if (!value || typeof value !== 'object') return undefined
  return { url: value.url, sha256: value.sha256, bytes: value.bytes }
}

function selectedArtifacts(selected) {
  if (
    !exactKeys(selected, ['sourceLock', 'closureLock', 'target'])
    || !plainRecord(selected.sourceLock)
    || !plainRecord(selected.closureLock)
    || selected.sourceLock.target !== selected.target
    || selected.closureLock.target !== selected.target
    || !Array.isArray(selected.sourceLock.engines)
    || !Array.isArray(selected.sourceLock.formulae)
    || !Array.isArray(selected.closureLock.formulae)
  ) {
    fail('Converter source acquisition inventory is invalid.')
  }
  const values = []
  for (const engine of selected.sourceLock.engines) values.push(lockedArtifact(engine?.acquisition))
  const sourceFormulae = new Map()
  for (const formula of selected.sourceLock.formulae) {
    if (typeof formula?.name !== 'string' || sourceFormulae.has(formula.name)) {
      fail('Converter source acquisition inventory is invalid.')
    }
    sourceFormulae.set(formula.name, formula)
  }
  const closureFormulae = new Set()
  for (const closureFormula of selected.closureLock.formulae) {
    if (typeof closureFormula?.name !== 'string' || closureFormulae.has(closureFormula.name)) {
      fail('Converter source acquisition inventory is invalid.')
    }
    closureFormulae.add(closureFormula.name)
    const formula = sourceFormulae.get(closureFormula.name)
    if (formula === undefined) fail('Converter source closure references an unknown formula.')
    if (formula?.acquisition !== null) values.push(lockedArtifact(formula?.acquisition))
    if (!Array.isArray(formula?.licenses)) fail('Converter source acquisition inventory is invalid.')
    for (const license of formula.licenses) {
      if (license?.kind === 'download') values.push(lockedArtifact(license))
    }
  }
  if (values.some((value) => !validArchiveIdentity(value))) {
    fail('Converter source acquisition inventory is invalid.')
  }
  const unique = new Map()
  for (const archive of values) {
    const previous = unique.get(archive.sha256)
    if (previous !== undefined && (previous.url !== archive.url || previous.bytes !== archive.bytes)) {
      fail('Converter source artifact identities conflict.')
    }
    unique.set(archive.sha256, archive)
  }
  return [...unique.values()].sort((left, right) => left.sha256 < right.sha256 ? -1 : left.sha256 > right.sha256 ? 1 : 0)
}

export async function acquireLockedArtifacts({
  selected,
  cacheRoot,
  fetchImpl = globalThis.fetch,
  concurrency = 3,
  signal,
}) {
  if (concurrency !== 3 || typeof fetchImpl !== 'function' || (signal !== undefined && !(signal instanceof globalThis.AbortSignal))) {
    fail('Converter source acquisition options are invalid.')
  }
  const artifacts = selectedArtifacts(selected)
  const controller = new globalThis.AbortController()
  const callerAbort = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', callerAbort, { once: true })
  if (signal?.aborted) callerAbort()
  let cursor = 0
  let firstError
  const results = new Map()

  const worker = async () => {
    while (firstError === undefined && !controller.signal.aborted) {
      const index = cursor
      cursor += 1
      if (index >= artifacts.length) return
      const archive = artifacts[index]
      try {
        const acquired = await acquireVerifiedArchive({
          archive,
          cacheRoot,
          fetchImpl,
          signal: controller.signal,
        })
        results.set(archive.sha256, acquired)
      } catch (error) {
        if (firstError === undefined) {
          firstError = error instanceof Error ? error : acquisitionFailure(downloadFailed)
          controller.abort(firstError)
        }
        return
      }
    }
  }

  try {
    const workers = Array.from({ length: 3 }, () => worker())
    await Promise.allSettled(workers)
    if (firstError !== undefined) throw firstError
    if (controller.signal.aborted) throw acquisitionFailure(downloadFailed)
    const blobs = new Map(artifacts.map((archive) => [archive.sha256, results.get(archive.sha256)]))
    return {
      blobs,
      networkBytes: [...blobs.values()].reduce((total, blob) => total + blob.networkBytes, 0),
    }
  } finally {
    signal?.removeEventListener('abort', callerAbort)
  }
}

export async function acquireConverterSources({ lockPath, target, cacheRoot, fetchImpl = globalThis.fetch, signal }) {
  const selected = await loadConverterClosureLock({ sourceLockPath: lockPath, target })
  const acquired = await acquireLockedArtifacts({ selected, cacheRoot, fetchImpl, signal })
  return { target, ...acquired }
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const args = parseArguments(process.argv.slice(2), ['--lock', '--target', '--cache'])
  const acquired = await acquireConverterSources({ lockPath: args['--lock'], target: args['--target'], cacheRoot: args['--cache'] })
  process.stdout.write(`acquired ${acquired.blobs.size} converter source artifacts for ${acquired.target}\n`)
}
