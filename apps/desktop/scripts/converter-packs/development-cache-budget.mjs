import { Buffer } from 'node:buffer'
import { constants } from 'node:fs'
import { lstat, mkdtemp, open, readdir, realpath, rename, rm, statfs } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { URL } from 'node:url'
import { canonicalBytes } from './pack-tooling-lib.mjs'

const GiB = 1024 * 1024 * 1024
const minimumFreeBytes = 10 * GiB
const defaultMaximumBlobBytes = 5 * GiB
const sha256Pattern = /^[a-f0-9]{64}$/u
const noncePattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const metadataLimit = 1024 * 1024

function fail(message) {
  throw new Error(message)
}

function exactKeys(value, keys) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key))
}

function validHttpsUrl(value) {
  try {
    const url = new URL(value)
    return typeof value === 'string'
      && value.length <= 2048
      && url.href === value
      && url.protocol === 'https:'
      && url.username === ''
      && url.password === ''
      && url.hash === ''
  } catch {
    return false
  }
}

async function canonicalRoot(cacheRoot) {
  if (typeof cacheRoot !== 'string' || !isAbsolute(cacheRoot) || resolve(cacheRoot) !== cacheRoot) {
    fail('Development converter cache root must be canonical and absolute.')
  }
  const details = await lstat(cacheRoot).catch(() => undefined)
  if (!details?.isDirectory() || details.isSymbolicLink() || await realpath(cacheRoot).catch(() => undefined) !== cacheRoot) {
    fail('Development converter cache root must be canonical and non-symbolic.')
  }
  return cacheRoot
}

function safeInteger(value, positive = false) {
  return Number.isSafeInteger(value) && (positive ? value > 0 : value >= 0)
}

function addBytes(total, value) {
  if (!safeInteger(value)) fail('Development converter cache contains an unsafe file size.')
  const result = total + value
  if (!Number.isSafeInteger(result)) fail('Development converter cache byte accounting overflowed.')
  return result
}

async function readRegular(path, maximumBytes = metadataLimit) {
  const before = await lstat(path).catch(() => undefined)
  if (
    !before?.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1
    || !safeInteger(before.size)
    || before.size > maximumBytes
    || await realpath(path).catch(() => undefined) !== path
  ) fail('Development converter cache contains an unsafe file.')
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      fail('Development converter cache changed while reading.')
    }
    const bytes = await handle.readFile()
    const after = await lstat(path).catch(() => undefined)
    if (
      bytes.byteLength !== before.size
      || after?.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
    ) fail('Development converter cache changed while reading.')
    return { bytes, stat: before }
  } finally {
    await handle.close()
  }
}

function parseCanonical(bytes, message) {
  let value
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    fail(message)
  }
  if (!bytes.equals(canonicalBytes(value))) fail(message)
  return value
}

function parseReleaseMetadata(bytes, fingerprint) {
  const value = parseCanonical(bytes, 'Development release metadata is invalid.')
  if (
    !exactKeys(value, ['blobs', 'fingerprint', 'release', 'schemaVersion'])
    || value.schemaVersion !== 1
    || value.fingerprint !== fingerprint
    || value.release !== `releases/${fingerprint}`
    || !Array.isArray(value.blobs)
  ) fail('Development release metadata is invalid.')
  let previous = ''
  for (const blob of value.blobs) {
    if (
      !exactKeys(blob, ['bytes', 'sha256'])
      || !sha256Pattern.test(blob.sha256)
      || !safeInteger(blob.bytes, true)
      || blob.sha256 <= previous
    ) fail('Development release metadata is invalid.')
    previous = blob.sha256
  }
  return value
}

function parseOwner(bytes, expectedSha) {
  const value = parseCanonical(bytes, 'Development converter acquisition owner is invalid.')
  if (
    !exactKeys(value, ['bytes', 'nonce', 'pid', 'sha256', 'state', 'url'])
    || !safeInteger(value.bytes, true)
    || !noncePattern.test(value.nonce)
    || !safeInteger(value.pid, true)
    || value.sha256 !== expectedSha
    || !['active', 'resume'].includes(value.state)
    || !validHttpsUrl(value.url)
  ) fail('Development converter acquisition owner is invalid.')
  return value
}

function parsePartialMetadata(bytes, expectedSha, expectedNonce) {
  const value = parseCanonical(bytes, 'Development converter partial metadata is invalid.')
  if (
    !exactKeys(value, ['bytes', 'nonce', 'partialBytes', 'sha256', 'url'])
    || !safeInteger(value.bytes, true)
    || value.nonce !== expectedNonce
    || !safeInteger(value.partialBytes)
    || value.partialBytes > value.bytes
    || value.sha256 !== expectedSha
    || !validHttpsUrl(value.url)
  ) fail('Development converter partial metadata is invalid.')
  return value
}

function ownerAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EPERM')
  }
}

async function validateDirectory(path, label) {
  const details = await lstat(path).catch(() => undefined)
  if (!details?.isDirectory() || details.isSymbolicLink() || await realpath(path).catch(() => undefined) !== path) fail(label)
  return details
}

async function filesystemFreeBytes(cacheRoot) {
  const details = await statfs(cacheRoot, { bigint: true })
  const value = details.bavail * details.bsize
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER
  return Number(value)
}

export async function preflightDevelopmentCache({ cacheRoot, requiredDownloadBytes, freeBytes }) {
  const root = await canonicalRoot(cacheRoot)
  if (!safeInteger(requiredDownloadBytes)) fail('Development converter required download bytes are invalid.')
  const available = typeof freeBytes === 'function'
    ? await freeBytes(root)
    : freeBytes === undefined ? await filesystemFreeBytes(root) : freeBytes
  if (!safeInteger(available) || available < minimumFreeBytes || available < requiredDownloadBytes) {
    fail('Development converter cache has insufficient free space.')
  }
}

async function collectCache(cacheRoot, activeFingerprint, keepPrevious, maximumBlobBytes) {
  if (!sha256Pattern.test(activeFingerprint) || !safeInteger(keepPrevious) || !safeInteger(maximumBlobBytes)) {
    fail('Development converter cache retention request is invalid.')
  }
  const rootNames = await readdir(cacheRoot)
  if (rootNames.some((name) => !['active-release.json', 'release-metadata', 'releases', 'sources'].includes(name))) {
    fail('Development converter cache contains an unknown entry.')
  }
  const releasesRoot = join(cacheRoot, 'releases')
  const metadataRoot = join(cacheRoot, 'release-metadata')
  const sourcesRoot = join(cacheRoot, 'sources')
  await validateDirectory(releasesRoot, 'Development converter releases root is unsafe.')
  await validateDirectory(metadataRoot, 'Development release metadata root is unsafe.')
  await validateDirectory(sourcesRoot, 'Development converter sources root is unsafe.')

  const marker = await readRegular(join(cacheRoot, 'active-release.json'), metadataLimit)
  const markerText = marker.bytes.toString('utf8')
  let markerValue
  try {
    markerValue = JSON.parse(markerText)
  } catch {
    fail('Development release marker is invalid.')
  }
  if (
    !exactKeys(markerValue, ['fingerprint', 'schemaVersion'])
    || markerValue.fingerprint !== activeFingerprint
    || markerValue.schemaVersion !== 1
    || markerText !== `{"fingerprint":"${activeFingerprint}","schemaVersion":1}\n`
  ) fail('Development release marker is invalid.')

  const releases = new Map()
  for (const name of await readdir(releasesRoot)) {
    if (!sha256Pattern.test(name) || releases.has(name)) fail('Development converter release entry is invalid.')
    const path = join(releasesRoot, name)
    const stat = await validateDirectory(path, 'Development converter release entry is unsafe.')
    releases.set(name, { fingerprint: name, path, stat })
  }
  if (!releases.has(activeFingerprint)) fail('Development active release is missing.')

  const metadata = new Map()
  for (const name of await readdir(metadataRoot)) {
    const match = /^([a-f0-9]{64})\.json$/u.exec(name)
    if (!match || metadata.has(match[1])) fail('Development release metadata entry is invalid.')
    const path = join(metadataRoot, name)
    const file = await readRegular(path)
    if ((file.stat.mode & 0o777) !== 0o444) fail('Development release metadata must be immutable.')
    const value = parseReleaseMetadata(file.bytes, match[1])
    if (!releases.has(value.fingerprint)) fail('Development release metadata references a missing release.')
    metadata.set(value.fingerprint, { path, stat: file.stat, value })
  }
  if (metadata.size !== releases.size || [...releases.keys()].some((fingerprint) => !metadata.has(fingerprint))) {
    fail('Development converter release metadata is incomplete.')
  }

  const owners = new Map()
  const partials = new Map()
  const complete = new Map()
  const sourceNames = await readdir(sourcesRoot)
  for (const name of sourceNames) {
    let match = /^([a-f0-9]{64})\.archive$/u.exec(name)
    if (match) {
      const path = join(sourcesRoot, name)
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !safeInteger(stat.size) || await realpath(path) !== path) {
        fail('Development converter complete blob is unsafe.')
      }
      complete.set(match[1], { path, stat })
      continue
    }
    match = /^\.([a-f0-9]{64})\.owner$/u.exec(name)
    if (match) {
      const file = await readRegular(join(sourcesRoot, name), 4096)
      owners.set(match[1], { ...file, value: parseOwner(file.bytes, match[1]) })
      continue
    }
    match = /^\.([a-f0-9]{64})\.([a-f0-9-]{36})\.partial$/u.exec(name)
    if (match && noncePattern.test(match[2])) {
      const path = join(sourcesRoot, name)
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !safeInteger(stat.size) || await realpath(path) !== path) {
        fail('Development converter partial is unsafe.')
      }
      partials.set(`${match[1]}\0${match[2]}`, { path, stat, sha256: match[1], nonce: match[2] })
      continue
    }
    if (/^\.[a-f0-9]{64}\.[a-f0-9-]{36}\.partial\.json$/u.test(name)) continue
    fail('Development converter sources contain an unknown entry.')
  }
  for (const partial of partials.values()) {
    const metadataPath = `${partial.path}.json`
    const file = await readRegular(metadataPath, 4096)
    const value = parsePartialMetadata(file.bytes, partial.sha256, partial.nonce)
    const owner = owners.get(partial.sha256)?.value
    if (
      !owner
      || owner.nonce !== partial.nonce
      || owner.bytes !== value.bytes
      || owner.url !== value.url
    ) fail('Development converter partial is not bound to its owner.')
    if (partial.stat.size < value.partialBytes || partial.stat.size > value.bytes) {
      fail('Development converter partial size is invalid.')
    }
  }
  for (const name of sourceNames.filter((value) => value.endsWith('.partial.json'))) {
    const partialName = name.slice(0, -'.json'.length)
    if (!sourceNames.includes(partialName)) fail('Development converter partial metadata is orphaned.')
  }

  for (const entry of metadata.values()) {
    for (const blob of entry.value.blobs) {
      const cached = complete.get(blob.sha256)
      if (!cached || cached.stat.size !== blob.bytes) fail('Development release metadata blob is missing or changed.')
    }
  }
  const previous = [...metadata.values()]
    .filter((entry) => entry.value.fingerprint !== activeFingerprint)
    .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs
      || Buffer.compare(Buffer.from(left.value.fingerprint), Buffer.from(right.value.fingerprint)))
    .slice(0, keepPrevious)
  const retained = new Set([activeFingerprint, ...previous.map((entry) => entry.value.fingerprint)])
  const protectedBlobs = new Set()
  for (const fingerprint of retained) {
    for (const blob of metadata.get(fingerprint).value.blobs) protectedBlobs.add(blob.sha256)
  }
  for (const [sha256, owner] of owners) {
    if (owner.value.state === 'active' && ownerAlive(owner.value.pid)) protectedBlobs.add(sha256)
  }

  let completeBytes = 0
  for (const blob of complete.values()) completeBytes = addBytes(completeBytes, blob.stat.size)
  const candidates = [...complete.entries()]
    .filter(([sha256]) => !protectedBlobs.has(sha256))
    .sort((left, right) => left[1].stat.mtimeMs - right[1].stat.mtimeMs
      || Buffer.compare(Buffer.from(left[0]), Buffer.from(right[0])))
  const removedBlobs = []
  for (const [sha256, blob] of candidates) {
    if (completeBytes <= maximumBlobBytes) break
    completeBytes -= blob.stat.size
    removedBlobs.push(sha256)
  }
  if (completeBytes > maximumBlobBytes) fail('Development converter cache cannot be pruned safely.')

  const removedReleases = [...releases.keys()].filter((fingerprint) => !retained.has(fingerprint)).sort()
  const targets = [
    ...removedReleases.flatMap((fingerprint) => [releases.get(fingerprint), metadata.get(fingerprint)]),
    ...removedBlobs.map((sha256) => complete.get(sha256)),
  ]
  return { removedBlobs, removedReleases, targets }
}

export async function pruneDevelopmentCache({
  cacheRoot,
  activeFingerprint,
  keepPrevious = 1,
  maximumBlobBytes = defaultMaximumBlobBytes,
}) {
  const root = await canonicalRoot(cacheRoot)
  const plan = await collectCache(root, activeFingerprint, keepPrevious, maximumBlobBytes)
  if (plan.targets.length === 0) return Object.freeze({ removedReleases: [], removedBlobs: [] })
  const trash = await realpath(await mkdtemp(join(root, '.development-cache-trash-')))
  if (!trash.startsWith(`${root}/.development-cache-trash-`)) fail('Development converter cache trash is unsafe.')
  try {
    for (const [index, target] of plan.targets.entries()) {
      const current = await lstat(target.path).catch(() => undefined)
      if (
        !current
        || current.isSymbolicLink()
        || current.dev !== target.stat.dev
        || current.ino !== target.stat.ino
      ) fail('Development converter cache changed before pruning.')
      await rename(target.path, join(trash, `${index}-${basename(target.path)}`))
    }
  } finally {
    await rm(trash, { recursive: true, force: true })
  }
  return Object.freeze({
    removedReleases: Object.freeze(plan.removedReleases),
    removedBlobs: Object.freeze(plan.removedBlobs),
  })
}
