import { createHash, randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { constants, lstatSync, realpathSync } from 'node:fs'
import { link, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { canonicalBytes, withStableRegularFile } from './pack-tooling-lib.mjs'

const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/
const TARGETS = new Set(['darwin-arm64', 'darwin-x64'])
const MUTATION_CLAIM = '.cache-mutation.claim'
const CLAIM_LEASE_MS = 30_000
const CLAIM_HEARTBEAT_MS = 5_000
const CLAIM_GRACE_MS = 250
const CLAIM_MAXIMUM_BYTES = 4096
const NONCE_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const METADATA_TEMP_PATTERN = /^\.release-metadata-([a-f0-9]{64})-([a-f0-9-]{36})\.tmp$/u
const CLAIM_PREDECESSOR_PATTERN = /^\.cache-mutation\.claim\.([a-f0-9-]+)\.predecessor$/u
const ACTIVE_MARKER_TEMP_PATTERN = /^\.active-release-([a-f0-9-]{36})\.tmp$/u
const PREPARATION_WORKSPACE_LIMIT = 8

function missing(error) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

async function sha256FromHandle(handle, size, label) {
  const digest = createHash('sha256')
  const buffer = Buffer.alloc(Math.min(1024 * 1024, Math.max(size, 1)))
  let offset = 0
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, size - offset), offset)
    if (bytesRead === 0) throw new Error(`${label} changed while hashing`)
    digest.update(buffer.subarray(0, bytesRead))
    offset += bytesRead
  }
  return digest.digest('hex')
}

function ownerAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EPERM')
  }
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0))
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function readClaim(path, allowedLinks = [1]) {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
  try {
    const [opened, current] = await Promise.all([handle.stat(), lstat(path).catch(() => undefined)])
    if (!current?.isFile() || current.isSymbolicLink() || !opened.isFile()
      || !allowedLinks.includes(current.nlink) || !allowedLinks.includes(opened.nlink)
      || current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new Error('Development converter cache mutation claim is unsafe.')
    }
    if (opened.size > CLAIM_MAXIMUM_BYTES) return { stat: opened }
    const bytes = await handle.readFile()
    let value
    try {
      value = JSON.parse(bytes.toString('utf8'))
    } catch {
      return { stat: opened }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !bytes.equals(canonicalBytes(value))
      || Object.keys(value).length !== 3
      || !Object.hasOwn(value, 'createdAtMs') || !Object.hasOwn(value, 'nonce') || !Object.hasOwn(value, 'pid')
      || !Number.isSafeInteger(value.createdAtMs) || value.createdAtMs <= 0
      || !NONCE_PATTERN.test(value.nonce) || !Number.isSafeInteger(value.pid) || value.pid <= 0) {
      return { stat: opened }
    }
    return { bytes, stat: opened, value }
  } finally {
    await handle.close()
  }
}

function sameIdentity(current, expected) {
  return Boolean(current && current.dev === expected.dev && current.ino === expected.ino)
}

async function unlinkIdentity(path, expected, allowedLinks = [1]) {
  const current = await lstat(path).catch((error) => missing(error) ? undefined : Promise.reject(error))
  if (!current?.isFile() || current.isSymbolicLink() || !allowedLinks.includes(current.nlink) || !sameIdentity(current, expected)) return false
  await unlink(path).catch((error) => { if (!missing(error)) throw error })
  return true
}

async function fenceClaim(path, current) {
  const suffix = current.value?.nonce ?? `${current.stat.dev}-${current.stat.ino}`
  const predecessor = `${path}.${suffix}.predecessor`
  try {
    await link(path, predecessor)
  } catch (error) {
    if (missing(error)) return false
    if (error?.code !== 'EEXIST') throw error
  }
  const [active, preserved] = await Promise.all([lstat(path).catch(() => undefined), lstat(predecessor).catch(() => undefined)])
  if (!sameIdentity(active, current.stat) || !sameIdentity(preserved, current.stat) || active.nlink !== 2 || preserved.nlink !== 2) {
    throw new Error('Development converter cache mutation claim changed during recovery.')
  }
  if (!await unlinkIdentity(path, current.stat, [2])) return false
  await syncDirectory(dirname(path))
  await unlinkIdentity(predecessor, current.stat)
  await syncDirectory(dirname(path))
  return true
}

async function acquireMutationClaim(cacheRoot, afterClaimOpenForTest) {
  const path = join(cacheRoot, MUTATION_CLAIM)
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const value = { createdAtMs: Date.now(), nonce: randomUUID(), pid: process.pid }
    const bytes = canonicalBytes(value)
    let handle
    try {
      handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      await afterClaimOpenForTest?.({ claimPath: path })
      await handle.writeFile(bytes)
      await handle.sync()
      await syncDirectory(cacheRoot)
      const stat = await handle.stat()
      const claim = { bytes, dev: stat.dev, handle, ino: stat.ino, path }
      await verifyClaim(claim)
      return claim
    } catch (error) {
      if (handle) {
        const stat = await handle.stat().catch(() => undefined)
        await handle.close().catch(() => undefined)
        if (stat) await unlinkIdentity(path, stat).catch(() => undefined)
        await syncDirectory(cacheRoot).catch(() => undefined)
      }
      if (error?.code !== 'EEXIST') throw error
    }
    const claimDetails = await lstat(path).catch((error) => missing(error) ? undefined : Promise.reject(error))
    if (!claimDetails) continue
    const current = await readClaim(path, claimDetails.nlink === 2 ? [2] : [1])
    if (!current) continue
    if (!current.value) {
      if (Date.now() - current.stat.mtimeMs <= CLAIM_GRACE_MS) {
        throw new Error('Development converter cache mutation is already claimed.')
      }
    } else if (Date.now() - current.stat.mtimeMs <= CLAIM_LEASE_MS && ownerAlive(current.value.pid)) {
      throw new Error('Development converter cache mutation is already claimed.')
    }
    await fenceClaim(path, current)
  }
  throw new Error('Development converter cache mutation is already claimed.')
}

async function removeOrphanedClaimPredecessors(cacheRoot, activeClaim, heartbeat) {
  for (const name of await readdir(cacheRoot)) {
    const match = CLAIM_PREDECESSOR_PATTERN.exec(name)
    if (!match || (!NONCE_PATTERN.test(match[1]) && !/^\d+-\d+$/u.test(match[1]))) continue
    const path = join(cacheRoot, name)
    const details = await lstat(path).catch(() => undefined)
    if (!details) continue
    if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1 || sameIdentity(details, activeClaim)) {
      throw new Error('Development converter cache mutation predecessor is unsafe.')
    }
    await heartbeat.pulse()
    await unlinkIdentity(path, details)
  }
  await syncDirectory(cacheRoot)
}

async function removeOrphanedActiveMarkerTemporaries(cacheRoot, heartbeat) {
  for (const name of await readdir(cacheRoot)) {
    const match = ACTIVE_MARKER_TEMP_PATTERN.exec(name)
    if (!match || !NONCE_PATTERN.test(match[1])) continue
    const path = join(cacheRoot, name)
    const details = await lstat(path).catch(() => undefined)
    if (!details?.isFile() || details.isSymbolicLink() || details.nlink !== 1
      || await realpath(path).catch(() => undefined) !== path) {
      throw new Error('Development release marker temporary is unsafe.')
    }
    await heartbeat.pulse()
    await unlink(path)
  }
  await syncDirectory(cacheRoot)
}

async function verifyClaim(claim) {
  const content = Buffer.alloc(claim.bytes.byteLength)
  const [opened, current, read] = await Promise.all([
    claim.handle.stat(), lstat(claim.path).catch(() => undefined), claim.handle.read(content, 0, content.byteLength, 0),
  ])
  if (!current?.isFile() || current.isSymbolicLink() || current.nlink !== 1 || opened.nlink !== 1
    || !sameIdentity(current, claim) || !sameIdentity(opened, claim)
    || opened.size !== claim.bytes.byteLength || read.bytesRead !== claim.bytes.byteLength || !content.equals(claim.bytes)) {
    throw new Error('Development converter cache mutation claim was lost.')
  }
}

function startClaimHeartbeat(claim) {
  let pending = Promise.resolve()
  let failure
  let stopped = false
  const pulse = () => {
    if (stopped || failure) return
    pending = pending.then(async () => {
      await verifyClaim(claim)
      const now = new Date()
      await claim.handle.utimes(now, now)
      await verifyClaim(claim)
    }).catch((error) => { failure = error })
  }
  const timer = globalThis.setInterval(pulse, CLAIM_HEARTBEAT_MS)
  timer.unref?.()
  return {
    async pulse() { pulse(); await pending; if (failure) throw failure },
    async stop() { stopped = true; globalThis.clearInterval(timer); await pending },
  }
}

export async function withDevelopmentCacheMutationClaim(cacheRoot, operation, claimOperations = {}) {
  const root = await canonicalCacheRoot(cacheRoot)
  const claim = await acquireMutationClaim(root, claimOperations.afterClaimOpenForTest)
  const heartbeat = startClaimHeartbeat(claim)
  let result
  let primary
  try {
    await heartbeat.pulse()
    await removeOrphanedClaimPredecessors(root, claim, heartbeat)
    await heartbeat.pulse()
    await removeOrphanedActiveMarkerTemporaries(root, heartbeat)
    await heartbeat.pulse()
    result = await operation(root, heartbeat)
    await heartbeat.pulse()
  } catch (error) {
    primary = error
  }
  const cleanup = []
  const cleanupActions = claimOperations.claimCleanupForTest === undefined
    ? []
    : [claimOperations.claimCleanupForTest]
  for (const action of [...cleanupActions, () => heartbeat.stop(), () => claim.handle.close(), () => unlinkIdentity(claim.path, claim), () => syncDirectory(root)]) {
    try { await action() } catch (error) { cleanup.push(error) }
  }
  if (primary) {
    if (cleanup.length > 0) throw new AggregateError([primary, ...cleanup], primary instanceof Error ? primary.message : 'Cache mutation failed.')
    throw primary
  }
  if (cleanup.length > 0) throw new AggregateError(cleanup, 'Development converter cache mutation cleanup failed.')
  return result
}

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

async function recoverPreparationWorkspaces(root, fingerprint, heartbeat) {
  const prefix = `.local-development-preparation-${fingerprint.slice(0, 12)}`
  const names = (await readdir(root)).filter((name) => name === prefix || new RegExp(`^${prefix}-[A-Za-z0-9]{6}$`, 'u').test(name))
  if (names.length > PREPARATION_WORKSPACE_LIMIT) throw new Error('Development preparation workspace recovery exceeds its limit')
  let recovered = false
  for (const name of names) {
    const path = join(root, name)
    const details = await lstat(path).catch((error) => missing(error) ? undefined : Promise.reject(error))
    if (!details?.isDirectory() || details.isSymbolicLink() || await realpath(path).catch(() => undefined) !== path) {
      throw new Error('Legacy development preparation workspace is unsafe')
    }
    let active = false
    const ownerPath = join(path, '.owner.json')
    const ownerDetails = await lstat(ownerPath).catch((error) => missing(error) ? undefined : Promise.reject(error))
    const owner = ownerDetails === undefined ? undefined : await withStableRegularFile(
      ownerPath,
      'Development preparation owner',
      async (handle, metadata) => {
        if (metadata.size > CLAIM_MAXIMUM_BYTES) throw new Error('Development preparation owner is invalid')
        return handle.readFile()
      },
    )
    if (owner !== undefined) {
      let value
      try { value = JSON.parse(owner.toString('utf8')) } catch { throw new Error('Development preparation owner is invalid') }
      const expected = canonicalBytes(value)
      if (!owner.equals(expected)
        || Object.keys(value).sort().join('\0') !== ['fingerprint', 'pid', 'schemaVersion'].join('\0')
        || value.fingerprint !== fingerprint
        || !Number.isSafeInteger(value.pid)
        || value.pid <= 0
        || value.schemaVersion !== 1) {
        throw new Error('Development preparation owner is invalid')
      }
      active = ownerAlive(value.pid)
    }
    if (active) continue
    await heartbeat.pulse()
    await rm(path, { recursive: true })
    recovered = true
  }
  if (recovered) await syncDirectory(root)
  return recovered
}

export async function recoverLegacyDevelopmentPreparation({ cacheRoot, fingerprint }) {
  const canonicalRoot = await canonicalCacheRoot(cacheRoot)
  assertFingerprint(fingerprint)
  return withDevelopmentCacheMutationClaim(canonicalRoot, (root, heartbeat) => (
    recoverPreparationWorkspaces(root, fingerprint, heartbeat)
  ))
}

export async function createDevelopmentPreparationWorkspace({ cacheRoot, fingerprint }) {
  const canonicalRoot = await canonicalCacheRoot(cacheRoot)
  assertFingerprint(fingerprint)
  return withDevelopmentCacheMutationClaim(canonicalRoot, async (root, heartbeat) => {
    await recoverPreparationWorkspaces(root, fingerprint, heartbeat)
    const privateRoot = await realpath(await mkdtemp(join(root, `.local-development-preparation-${fingerprint.slice(0, 12)}-`)))
    const ownerBytes = canonicalBytes({ fingerprint, pid: process.pid, schemaVersion: 1 })
    const ownerHandle = await open(
      join(privateRoot, '.owner.json'),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o400,
    )
    try {
      await ownerHandle.writeFile(ownerBytes)
      await ownerHandle.sync()
    } finally {
      await ownerHandle.close()
    }
    await Promise.all([syncDirectory(privateRoot), syncDirectory(root)])
    await heartbeat.pulse()
    return privateRoot
  })
}

export async function removeInactiveDevelopmentRelease({ cacheRoot, fingerprint }) {
  const canonicalRoot = await canonicalCacheRoot(cacheRoot)
  assertFingerprint(fingerprint)
  return withDevelopmentCacheMutationClaim(canonicalRoot, async (root, heartbeat) => {
    const paths = developmentReleasePaths(root, fingerprint)
    const markerDetails = await lstat(paths.activeMarker).catch((error) => missing(error) ? undefined : Promise.reject(error))
    const marker = markerDetails === undefined ? undefined : await withStableRegularFile(
      paths.activeMarker,
      'Development release marker',
      async (handle) => parseMarker(await handle.readFile({ encoding: 'utf8' })),
    )
    if (marker?.fingerprint === fingerprint) return false

    const release = await lstat(paths.release).catch((error) => missing(error) ? undefined : Promise.reject(error))
    if (release !== undefined && (
      !release.isDirectory()
      || release.isSymbolicLink()
      || await realpath(paths.release).catch(() => undefined) !== paths.release
    )) throw new Error('Inactive development release is unsafe')
    const metadataRoot = await lstat(paths.releaseMetadataRoot).catch((error) => missing(error) ? undefined : Promise.reject(error))
    if (metadataRoot !== undefined && (
      !metadataRoot.isDirectory()
      || metadataRoot.isSymbolicLink()
      || await realpath(paths.releaseMetadataRoot).catch(() => undefined) !== paths.releaseMetadataRoot
    )) throw new Error('Inactive development release metadata root is unsafe')
    const temporaryNames = metadataRoot === undefined ? [] : (await readdir(paths.releaseMetadataRoot)).filter((name) => {
      const match = METADATA_TEMP_PATTERN.exec(name)
      return Boolean(match && match[1] === fingerprint && NONCE_PATTERN.test(match[2]))
    })
    if (temporaryNames.length > 1) throw new Error('Inactive development release metadata recovery is ambiguous')
    const temporaryPath = temporaryNames.length === 1 ? join(paths.releaseMetadataRoot, temporaryNames[0]) : undefined
    const metadata = await lstat(paths.releaseMetadata).catch((error) => missing(error) ? undefined : Promise.reject(error))
    const temporary = temporaryPath === undefined ? undefined : await lstat(temporaryPath)
    for (const [path, details] of [[paths.releaseMetadata, metadata], [temporaryPath, temporary]]) {
      if (details !== undefined && (
        !details.isFile()
        || details.isSymbolicLink()
        || ![1, 2].includes(details.nlink)
        || await realpath(path).catch(() => undefined) !== path
      )) throw new Error('Inactive development release metadata is unsafe')
    }
    if (metadata?.nlink === 2 && (
      temporary?.nlink !== 2
      || !sameIdentity(metadata, temporary)
    )) throw new Error('Inactive development release metadata is unsafe')
    if (temporary?.nlink === 2 && (
      metadata?.nlink !== 2
      || !sameIdentity(metadata, temporary)
    )) throw new Error('Inactive development release metadata is unsafe')
    if (metadata !== undefined) {
      await heartbeat.pulse()
      await unlink(paths.releaseMetadata)
    }
    if (temporaryPath !== undefined) {
      await heartbeat.pulse()
      await unlink(temporaryPath)
    }
    if (metadata !== undefined || temporaryPath !== undefined) await syncDirectory(paths.releaseMetadataRoot)
    if (release !== undefined) {
      await heartbeat.pulse()
      await rm(paths.release, { recursive: true })
      await syncDirectory(dirname(paths.release))
    }
    return release !== undefined || metadata !== undefined || temporary !== undefined
  })
}

async function verifyMetadataFile(path, expectedBytes, allowedLinks) {
  const before = await lstat(path).catch((error) => missing(error) ? undefined : Promise.reject(error))
  if (!before?.isFile() || before.isSymbolicLink() || !allowedLinks.includes(before.nlink)
    || (before.mode & 0o777) !== 0o444 || await realpath(path).catch(() => undefined) !== path) {
    throw new Error('Development release metadata publication is unsafe')
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    const content = await handle.readFile()
    const after = await lstat(path).catch(() => undefined)
    if (!after?.isFile() || after.isSymbolicLink() || !allowedLinks.includes(opened.nlink)
      || !allowedLinks.includes(after.nlink) || !sameIdentity(opened, before) || !sameIdentity(after, before)
      || content.byteLength !== expectedBytes.byteLength || !content.equals(expectedBytes)) {
      throw new Error('Development release metadata publication does not match the requested release')
    }
    return before
  } finally {
    await handle.close()
  }
}

export async function replaceActiveDevelopmentRelease({
  cacheRoot,
  fingerprint,
  candidateRelease,
  afterOldReleaseRenameForTest,
}) {
  const canonicalRoot = await canonicalCacheRoot(cacheRoot)
  assertFingerprint(fingerprint)
  if (typeof candidateRelease !== 'string' || !isAbsolute(candidateRelease) || resolve(candidateRelease) !== candidateRelease) {
    throw new Error('Development replacement release must be canonical and absolute')
  }
  const candidateRelative = relative(canonicalRoot, candidateRelease)
  if (!candidateRelative || candidateRelative === '..' || candidateRelative.startsWith('../')) {
    throw new Error('Development replacement release must be inside the cache root')
  }
  const paths = developmentReleasePaths(canonicalRoot, fingerprint)
  return withDevelopmentCacheMutationClaim(canonicalRoot, async (root, heartbeat) => {
    if (await readActiveDevelopmentRelease({ cacheRoot: root }) !== paths.release) {
      throw new Error('Development replacement release is no longer active')
    }
    for (const [path, label] of [[paths.release, 'active'], [candidateRelease, 'candidate']]) {
      const details = await lstat(path).catch((error) => missing(error) ? undefined : Promise.reject(error))
      if (!details?.isDirectory() || details.isSymbolicLink() || await realpath(path).catch(() => undefined) !== path) {
        throw new Error(`Development ${label} release is unsafe`)
      }
    }
    const quarantine = join(root, `.replaced-active-release-${fingerprint}-${randomUUID()}`)
    let oldMoved = false
    let candidateMoved = false
    try {
      await heartbeat.pulse()
      await rename(paths.release, quarantine)
      oldMoved = true
      await syncDirectory(dirname(paths.release))
      await afterOldReleaseRenameForTest?.()
      await heartbeat.pulse()
      await rename(candidateRelease, paths.release)
      candidateMoved = true
      await Promise.all([syncDirectory(dirname(paths.release)), syncDirectory(dirname(candidateRelease))])
      await heartbeat.pulse()
      await rm(quarantine, { recursive: true })
      await syncDirectory(root)
      return paths.release
    } catch (primary) {
      const cleanup = []
      if (candidateMoved) {
        try { await rename(paths.release, candidateRelease) } catch (error) { cleanup.push(error) }
      }
      if (oldMoved) {
        try { await rename(quarantine, paths.release) } catch (error) { cleanup.push(error) }
      }
      try { await Promise.all([syncDirectory(dirname(paths.release)), syncDirectory(dirname(candidateRelease))]) } catch (error) { cleanup.push(error) }
      if (cleanup.length > 0) {
        throw new AggregateError([primary, ...cleanup], primary instanceof Error ? primary.message : 'Development active release replacement failed')
      }
      throw primary
    }
  })
}

export async function writeDevelopmentReleaseMetadata({
  cacheRoot,
  fingerprint,
  blobs,
  afterClaimOpenForTest,
  afterTemporaryCreateForTest,
  afterMetadataLinkForTest,
  syncDirectoryForTest,
  claimCleanupForTest,
}) {
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
  const bytes = canonicalBytes({
    blobs: selected,
    fingerprint,
    release: `releases/${fingerprint}`,
    schemaVersion: 1,
  })
  const syncMetadataDirectory = syncDirectoryForTest ?? syncDirectory
  return withDevelopmentCacheMutationClaim(canonicalRoot, async (root, heartbeat) => {
    await validateRelease(root, fingerprint)
    const sources = join(root, 'sources')
    for (const blob of selected) {
      await withStableRegularFile(join(sources, `${blob.sha256}.archive`), 'Development release blob', async (handle, details) => {
        if (details.size !== blob.bytes) throw new Error('Development release metadata blob size is invalid')
        if (await sha256FromHandle(handle, details.size, 'Development release blob') !== blob.sha256) {
          throw new Error('Development release metadata blob hash is invalid')
        }
      })
    }

    const metadataRoot = join(root, 'release-metadata')
    await mkdir(metadataRoot, { recursive: true, mode: 0o755 })
    const metadataDetails = await lstat(metadataRoot)
    if (metadataDetails.isSymbolicLink() || !metadataDetails.isDirectory() || await realpath(metadataRoot) !== metadataRoot) {
      throw new Error('Development release metadata root is unsafe')
    }
    const path = join(metadataRoot, `${fingerprint}.json`)
    const metadataNames = await readdir(metadataRoot)
    const temporaryNames = metadataNames.filter((name) => name.startsWith('.release-metadata-'))
    if (temporaryNames.some((name) => !METADATA_TEMP_PATTERN.test(name))) {
      throw new Error('Development release metadata temporary is unsafe')
    }
    const matchingTemporaries = temporaryNames.filter((name) => {
      const match = METADATA_TEMP_PATTERN.exec(name)
      return Boolean(match && match[1] === fingerprint && NONCE_PATTERN.test(match[2]))
    })
    if (temporaryNames.length !== matchingTemporaries.length) {
      throw new Error('Development release metadata for another release is incomplete')
    }
    if (matchingTemporaries.length > 1) throw new Error('Development release metadata recovery is ambiguous')
    let temporary = matchingTemporaries.length === 1 ? join(metadataRoot, matchingTemporaries[0]) : undefined
    const published = await lstat(path).catch((error) => missing(error) ? undefined : Promise.reject(error))
    if (published) {
      const expectedLinks = temporary ? [2] : [1]
      const publishedIdentity = await verifyMetadataFile(path, bytes, expectedLinks)
      if (temporary) {
        const temporaryIdentity = await verifyMetadataFile(temporary, bytes, [2])
        if (!sameIdentity(publishedIdentity, temporaryIdentity)) {
          throw new Error('Development release metadata recovery does not match the published file')
        }
        await heartbeat.pulse()
        await unlink(temporary)
        await syncMetadataDirectory(metadataRoot)
      }
      await verifyMetadataFile(path, bytes, [1])
      return path
    }
    if (temporary) await verifyMetadataFile(temporary, bytes, [1])
    else temporary = join(metadataRoot, `.release-metadata-${fingerprint}-${randomUUID()}.tmp`)
    let handle
    let createdTemporary = false
    let linked = false
    try {
      if (matchingTemporaries.length === 0) {
        handle = await open(temporary, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
        createdTemporary = true
        await handle.writeFile(bytes)
        await handle.chmod(0o444)
        await handle.sync()
      } else {
        handle = await open(temporary, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      }
      const prepared = await handle.stat()
      if (!prepared.isFile() || prepared.size !== bytes.byteLength || (prepared.mode & 0o777) !== 0o444) {
        throw new Error('Development release metadata temporary verification failed')
      }
      const content = Buffer.alloc(bytes.byteLength)
      const read = await handle.read(content, 0, content.byteLength, 0)
      if (read.bytesRead !== bytes.byteLength || !content.equals(bytes)) {
        throw new Error('Development release metadata temporary verification failed')
      }
      await syncMetadataDirectory(metadataRoot)
      if (createdTemporary) await afterTemporaryCreateForTest?.({ temporary })
      const [openedAgain, temporaryAgain] = await Promise.all([handle.stat(), lstat(temporary).catch(() => undefined)])
      if (!temporaryAgain?.isFile() || temporaryAgain.isSymbolicLink() || temporaryAgain.nlink !== 1
        || openedAgain.nlink !== 1 || !sameIdentity(openedAgain, prepared) || !sameIdentity(temporaryAgain, prepared)
        || openedAgain.size !== bytes.byteLength || (openedAgain.mode & 0o777) !== 0o444) {
        throw new Error('Development release metadata temporary verification failed')
      }
      await heartbeat.pulse()
      await link(temporary, path)
      linked = true
      await syncMetadataDirectory(metadataRoot)
      await afterMetadataLinkForTest?.({ path, temporary })
      const [temporaryDetails, publishedDetails] = await Promise.all([lstat(temporary), lstat(path)])
      if (!sameIdentity(temporaryDetails, publishedDetails) || temporaryDetails.nlink !== 2 || publishedDetails.nlink !== 2) {
        throw new Error('Development release metadata publication failed')
      }
      await heartbeat.pulse()
      await unlink(temporary)
      await syncMetadataDirectory(metadataRoot)
      await withStableRegularFile(path, 'Development release metadata', async (publishedHandle, details) => {
        if (details.size !== bytes.byteLength || (details.mode & 0o777) !== 0o444) {
          throw new Error('Development release metadata publication failed')
        }
        const published = await publishedHandle.readFile()
        if (!published.equals(bytes)) throw new Error('Development release metadata publication failed')
      })
      return path
    } catch (error) {
      if (createdTemporary && !linked) {
        await heartbeat.pulse()
        await unlink(temporary).catch((cleanupError) => { if (!missing(cleanupError)) throw cleanupError })
        await syncMetadataDirectory(metadataRoot)
      }
      throw error
    } finally {
      await handle?.close()
    }
  }, { afterClaimOpenForTest, claimCleanupForTest })
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
  return withDevelopmentCacheMutationClaim(canonicalRoot, async (root, heartbeat) => {
    const paths = developmentReleasePaths(root, fingerprint)
    const release = await validateRelease(root, fingerprint)
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
      await operations.beforePublishForTest?.()
      await heartbeat.pulse()
      await (operations.rename ?? rename)(temporaryMarker, paths.activeMarker)
      await syncDirectory(root)
    } catch (error) {
      await heartbeat.pulse()
      await unlink(temporaryMarker).catch((cleanupError) => { if (!missing(cleanupError)) throw cleanupError })
      await syncDirectory(root)
      throw error
    }
    return release
  }, { afterClaimOpenForTest: operations.afterClaimOpenForTest })
}
