import { createHash, randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { constants, lstatSync, realpathSync } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { canonicalBytes, withStableRegularFile } from './pack-tooling-lib.mjs'

const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/
const TARGETS = new Set(['darwin-arm64', 'darwin-x64'])

function assertFingerprint(fingerprint) {
  if (typeof fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(fingerprint)) {
    throw new Error('Development release fingerprint must be 64 lowercase hexadecimal characters')
  }
}

function assertInputPath(path) {
  if (typeof path !== 'string' || path.length === 0 || isAbsolute(path)) throw new Error('Development release input path is unsafe')
  const segments = path.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error('Development release input path is unsafe')
  }
}

async function canonicalCacheRoot(cacheRoot) {
  if (typeof cacheRoot !== 'string' || !isAbsolute(cacheRoot) || resolve(cacheRoot) !== cacheRoot) {
    throw new Error('Development release cache root must be canonical and absolute')
  }
  const details = await lstat(cacheRoot)
  if (details.isSymbolicLink()) throw new Error('Development release cache root must not be symbolic')
  const canonical = await realpath(cacheRoot)
  if (canonical !== cacheRoot) throw new Error('Development release cache root must be canonical')
  return cacheRoot
}

function canonicalCacheRootSync(cacheRoot) {
  if (typeof cacheRoot !== 'string' || !isAbsolute(cacheRoot) || resolve(cacheRoot) !== cacheRoot) {
    throw new Error('Development release cache root must be canonical and absolute')
  }
  if (lstatSync(cacheRoot).isSymbolicLink() || realpathSync(cacheRoot) !== cacheRoot) {
    throw new Error('Development release cache root must be canonical and non-symbolic')
  }
  return cacheRoot
}

function releasePath(cacheRoot, fingerprint) {
  assertFingerprint(fingerprint)
  const releases = join(cacheRoot, 'releases')
  const release = join(releases, fingerprint)
  if (relative(releases, release) !== fingerprint) throw new Error('Development release is outside releases')
  return release
}

async function validateRelease(cacheRoot, fingerprint) {
  const release = releasePath(cacheRoot, fingerprint)
  const details = await lstat(release)
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('Development release must be a non-symbolic directory')
  const canonical = await realpath(release)
  const releases = join(cacheRoot, 'releases')
  if (canonical !== release || relative(releases, canonical) !== fingerprint) {
    throw new Error('Development release must remain inside releases')
  }
  return release
}

function parseMarker(bytes) {
  let marker
  try {
    marker = JSON.parse(bytes)
  } catch {
    throw new Error('Development release marker is invalid')
  }
  if (Object.getPrototypeOf(marker) !== Object.prototype || Object.keys(marker).length !== 2
    || marker.schemaVersion !== 1 || !Object.hasOwn(marker, 'fingerprint') || !Object.hasOwn(marker, 'schemaVersion')) {
    throw new Error('Development release marker schema is invalid')
  }
  assertFingerprint(marker.fingerprint)
  if (bytes !== `{"fingerprint":"${marker.fingerprint}","schemaVersion":1}\n`) {
    throw new Error('Development release marker must use the canonical schema')
  }
  return marker
}

export function fingerprintDevelopmentRelease({ target, inputs }) {
  if (!TARGETS.has(target)) throw new Error('Development release target is unsupported')
  if (!Array.isArray(inputs)) throw new Error('Development release inputs must be an array')
  const sortedInputs = inputs.map((input) => {
    if (!input || !Buffer.isBuffer(input.bytes)) throw new Error('Development release input bytes must be a Buffer')
    assertInputPath(input.path)
    return input
  }).sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
  for (let index = 1; index < sortedInputs.length; index += 1) {
    if (sortedInputs[index - 1].path === sortedInputs[index].path) throw new Error('Development release input paths must be unique')
  }

  const hash = createHash('sha256')
  hash.update('autoforge-development-converter-release-v1\0')
  hash.update(`${target}\0`)
  for (const input of sortedInputs) {
    hash.update(`${Buffer.byteLength(input.path)}\0${input.path}\0${input.bytes.byteLength}\0`)
    hash.update(input.bytes)
  }
  return hash.digest('hex')
}

export function developmentReleasePaths(cacheRoot, fingerprint) {
  const canonicalRoot = canonicalCacheRootSync(cacheRoot)
  return {
    sources: join(canonicalRoot, 'sources'),
    release: releasePath(canonicalRoot, fingerprint),
    releaseMetadata: join(canonicalRoot, 'release-metadata', `${fingerprint}.json`),
    releaseMetadataRoot: join(canonicalRoot, 'release-metadata'),
    activeMarker: join(canonicalRoot, 'active-release.json'),
    markerTemporaryRoot: join(canonicalRoot, '.active-release-'),
  }
}

export async function writeDevelopmentReleaseMetadata({ cacheRoot, fingerprint, blobs }) {
  const canonicalRoot = await canonicalCacheRoot(cacheRoot)
  assertFingerprint(fingerprint)
  if (!Array.isArray(blobs)) throw new Error('Development release metadata blobs are invalid')
  const selected = blobs.map((blob) => {
    if (
      !blob
      || typeof blob !== 'object'
      || Object.keys(blob).length !== 2
      || !Object.hasOwn(blob, 'sha256')
      || !Object.hasOwn(blob, 'bytes')
      || typeof blob.sha256 !== 'string'
      || !FINGERPRINT_PATTERN.test(blob.sha256)
      || !Number.isSafeInteger(blob.bytes)
      || blob.bytes <= 0
    ) throw new Error('Development release metadata blob is invalid')
    return { bytes: blob.bytes, sha256: blob.sha256 }
  }).sort((left, right) => Buffer.compare(Buffer.from(left.sha256), Buffer.from(right.sha256)))
  for (let index = 1; index < selected.length; index += 1) {
    if (selected[index - 1].sha256 === selected[index].sha256) {
      throw new Error('Development release metadata blobs must be unique')
    }
  }
  await validateRelease(canonicalRoot, fingerprint)
  const sources = join(canonicalRoot, 'sources')
  for (const blob of selected) {
    await withStableRegularFile(join(sources, `${blob.sha256}.archive`), 'Development release blob', async (_handle, details) => {
      if (details.size !== blob.bytes) throw new Error('Development release metadata blob size is invalid')
    })
  }

  const metadataRoot = join(canonicalRoot, 'release-metadata')
  await mkdir(metadataRoot, { recursive: true, mode: 0o755 })
  const metadataDetails = await lstat(metadataRoot)
  if (metadataDetails.isSymbolicLink() || !metadataDetails.isDirectory() || await realpath(metadataRoot) !== metadataRoot) {
    throw new Error('Development release metadata root is unsafe')
  }
  const path = join(metadataRoot, `${fingerprint}.json`)
  const bytes = canonicalBytes({
    blobs: selected,
    fingerprint,
    release: `releases/${fingerprint}`,
    schemaVersion: 1,
  })
  let handle
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    await handle.writeFile(bytes)
    await handle.chmod(0o444)
    await handle.sync()
    await handle.close()
    handle = undefined
    const directoryHandle = await open(metadataRoot, 'r')
    try {
      await directoryHandle.sync()
    } finally {
      await directoryHandle.close()
    }
  } catch (error) {
    await handle?.close().catch(() => undefined)
    throw error
  }
  return path
}

export async function readActiveDevelopmentRelease({ cacheRoot }) {
  const canonicalRoot = await canonicalCacheRoot(cacheRoot)
  const { activeMarker } = developmentReleasePaths(canonicalRoot, '0'.repeat(64))
  const markerDetails = await lstat(activeMarker)
  if (markerDetails.isSymbolicLink() || !markerDetails.isFile()) throw new Error('Development release marker must be a regular file')
  const handle = await open(activeMarker, 'r')
  let marker
  try {
    marker = parseMarker(await handle.readFile({ encoding: 'utf8' }))
  } finally {
    await handle.close()
  }
  return validateRelease(canonicalRoot, marker.fingerprint)
}

export async function activateDevelopmentRelease({ cacheRoot, fingerprint }, operations = {}) {
  const canonicalRoot = await canonicalCacheRoot(cacheRoot)
  const paths = developmentReleasePaths(canonicalRoot, fingerprint)
  const release = await validateRelease(canonicalRoot, fingerprint)
  try {
    const markerDetails = await lstat(paths.activeMarker)
    if (markerDetails.isSymbolicLink() || !markerDetails.isFile()) throw new Error('Development release marker must be a regular file')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  await mkdir(dirname(paths.activeMarker), { recursive: true })
  const temporaryMarker = `${paths.markerTemporaryRoot}${randomUUID()}.tmp`
  const contents = `{"fingerprint":"${fingerprint}","schemaVersion":1}\n`
  try {
    const markerHandle = await open(temporaryMarker, 'wx', 0o600)
    try {
      await markerHandle.writeFile(contents)
      await markerHandle.sync()
    } finally {
      await markerHandle.close()
    }
    await (operations.rename ?? rename)(temporaryMarker, paths.activeMarker)
    const directoryHandle = await open(canonicalRoot, 'r')
    try {
      await directoryHandle.sync()
    } finally {
      await directoryHandle.close()
    }
  } catch (error) {
    await unlink(temporaryMarker).catch(() => undefined)
    throw error
  }
  return release
}
