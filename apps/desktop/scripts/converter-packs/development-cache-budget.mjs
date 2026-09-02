import { Buffer } from 'node:buffer'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, realpath, rename, rm, statfs } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { URL } from 'node:url'
import { canonicalBytes } from './pack-tooling-lib.mjs'
import { withDevelopmentCacheMutationClaim } from './local-development-release-cache.mjs'

const GiB = 1024 * 1024 * 1024
const minimumFreeBytes = 10 * GiB
const defaultMaximumBlobBytes = 5 * GiB
const sha256Pattern = /^[a-f0-9]{64}$/u
const noncePattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const metadataLimit = 1024 * 1024
const trashPattern = /^\.development-cache-trash-([a-f0-9-]{36})$/u
const transactionTemporaryPattern = /^\.transaction-([a-f0-9-]{36})\.tmp$/u
const transactionTargetPattern = /^(?:releases\/[a-f0-9]{64}|release-metadata\/[a-f0-9]{64}\.json|sources\/[a-f0-9]{64}\.archive)$/u
const legacyMetadataTemporaryPattern = /^\.legacy-release-metadata-([a-f0-9]{64})-([a-f0-9-]{36})\.tmp$/u

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

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0))
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeLegacyReleaseMetadata(metadataRoot, fingerprint, heartbeat) {
  const bytes = canonicalBytes({
    blobs: [],
    fingerprint,
    release: `releases/${fingerprint}`,
    schemaVersion: 1,
  })
  const temporary = join(metadataRoot, `.legacy-release-metadata-${fingerprint}-${randomUUID()}.tmp`)
  const destination = join(metadataRoot, `${fingerprint}.json`)
  await heartbeat.pulse()
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  )
  try {
    await handle.writeFile(bytes)
    await handle.chmod(0o444)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await syncDirectory(metadataRoot)
  await heartbeat.pulse()
  await rename(temporary, destination)
  await syncDirectory(metadataRoot)
}

async function migrateLegacyReleaseMetadata(cacheRoot, activeFingerprint, heartbeat) {
  const releasesRoot = join(cacheRoot, 'releases')
  const metadataRoot = join(cacheRoot, 'release-metadata')
  await validateDirectory(releasesRoot, 'Development converter releases root is unsafe.')
  await validateDirectory(metadataRoot, 'Development release metadata root is unsafe.')
  const releases = new Set()
  for (const fingerprint of await readdir(releasesRoot)) {
    if (!sha256Pattern.test(fingerprint)) fail('Development converter release entry is invalid.')
    await validateDirectory(join(releasesRoot, fingerprint), 'Development converter release entry is unsafe.')
    releases.add(fingerprint)
  }
  const published = new Set()
  const temporaries = []
  for (const name of await readdir(metadataRoot)) {
    const final = /^([a-f0-9]{64})\.json$/u.exec(name)
    if (final) {
      published.add(final[1])
      continue
    }
    const temporary = legacyMetadataTemporaryPattern.exec(name)
    if (!temporary || !noncePattern.test(temporary[2])) {
      fail('Development release metadata entry is invalid.')
    }
    temporaries.push({ fingerprint: temporary[1], path: join(metadataRoot, name) })
  }
  for (const temporary of temporaries) {
    if (!releases.has(temporary.fingerprint) || temporary.fingerprint === activeFingerprint || published.has(temporary.fingerprint)) {
      fail('Development legacy release metadata recovery is invalid.')
    }
    const expected = canonicalBytes({
      blobs: [],
      fingerprint: temporary.fingerprint,
      release: `releases/${temporary.fingerprint}`,
      schemaVersion: 1,
    })
    const file = await readRegular(temporary.path)
    if ((file.stat.mode & 0o777) !== 0o444 || !file.bytes.equals(expected)) {
      fail('Development legacy release metadata recovery is invalid.')
    }
    await heartbeat.pulse()
    await rename(temporary.path, join(metadataRoot, `${temporary.fingerprint}.json`))
    await syncDirectory(metadataRoot)
    published.add(temporary.fingerprint)
  }
  if (!published.has(activeFingerprint)) {
    fail('Development active release metadata must not be migrated.')
  }
  for (const fingerprint of [...releases].sort()) {
    if (fingerprint !== activeFingerprint && !published.has(fingerprint)) {
      await writeLegacyReleaseMetadata(metadataRoot, fingerprint, heartbeat)
    }
  }
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
  if (rootNames.some((name) => !['.cache-mutation.claim', 'active-release.json', 'release-metadata', 'releases', 'sources'].includes(name))) {
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

function parseTransaction(bytes) {
  const value = parseCanonical(bytes, 'Development converter cache transaction is invalid.')
  if (!exactKeys(value, ['phase', 'schemaVersion', 'targets'])
    || !['committed', 'staging'].includes(value.phase)
    || value.schemaVersion !== 1
    || !Array.isArray(value.targets)
    || value.targets.length === 0) {
    fail('Development converter cache transaction is invalid.')
  }
  let previous = ''
  for (const target of value.targets) {
    if (!exactKeys(target, ['dev', 'ino', 'path', 'type'])
      || !safeInteger(target.dev)
      || !safeInteger(target.ino)
      || typeof target.path !== 'string'
      || !transactionTargetPattern.test(target.path)
      || !['directory', 'file'].includes(target.type)
      || (target.path.startsWith('releases/') ? target.type !== 'directory' : target.type !== 'file')
      || target.path <= previous) {
      fail('Development converter cache transaction is invalid.')
    }
    previous = target.path
  }
  return value
}

async function writeTransaction(trash, phase, targets, heartbeat) {
  const temporary = join(trash, `.transaction-${randomUUID()}.tmp`)
  const path = join(trash, 'transaction.json')
  const bytes = canonicalBytes({ phase, schemaVersion: 1, targets })
  await heartbeat.pulse()
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.chmod(0o444)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await heartbeat.pulse()
  await rename(temporary, path)
  await syncDirectory(trash)
  const published = await readRegular(path)
  if ((published.stat.mode & 0o777) !== 0o444 || !published.bytes.equals(bytes)) {
    fail('Development converter cache transaction publication failed.')
  }
}

async function validateTransactionContents(trash, targets, heartbeat) {
  const expected = new Set(targets.map((target) => target.path))
  for (const name of await readdir(trash)) {
    if (name === 'transaction.json') continue
    const temporaryMatch = transactionTemporaryPattern.exec(name)
    if (temporaryMatch && noncePattern.test(temporaryMatch[1])) {
      const path = join(trash, name)
      const details = await lstat(path).catch(() => undefined)
      if (!details?.isFile() || details.isSymbolicLink() || details.nlink !== 1) {
        fail('Development converter cache transaction temporary is unsafe.')
      }
      await heartbeat.pulse()
      await rm(path)
      continue
    }
    if (!['release-metadata', 'releases', 'sources'].includes(name)) {
      fail('Development converter cache trash is unsafe.')
    }
    const categoryRoot = join(trash, name)
    await validateDirectory(categoryRoot, 'Development converter cache trash is unsafe.')
    for (const entry of await readdir(categoryRoot)) {
      const target = `${name}/${entry}`
      if (!expected.has(target)) fail('Development converter cache trash is unsafe.')
      const details = await lstat(join(categoryRoot, entry)).catch(() => undefined)
      if (!details || details.isSymbolicLink()
        || (name === 'releases' ? !details.isDirectory() : !details.isFile())) {
        fail('Development converter cache trash is unsafe.')
      }
    }
  }
}

async function readTransaction(trash) {
  const manifest = await readRegular(join(trash, 'transaction.json'))
  if ((manifest.stat.mode & 0o777) !== 0o444) fail('Development converter cache transaction is invalid.')
  return parseTransaction(manifest.bytes)
}

function deletionOrder(targets) {
  return [...targets].sort((left, right) => {
    const leftRelease = left.path.startsWith('releases/') ? 0 : 1
    const rightRelease = right.path.startsWith('releases/') ? 0 : 1
    return leftRelease - rightRelease || Buffer.compare(Buffer.from(left.path), Buffer.from(right.path))
  })
}

async function deleteCommittedTransaction(trash, targets, heartbeat, remove = rm) {
  for (const target of deletionOrder(targets)) {
    await heartbeat.pulse()
    await remove(join(trash, target.path), { recursive: true, force: true })
  }
  for (const category of ['release-metadata', 'releases', 'sources']) {
    await heartbeat.pulse()
    await rm(join(trash, category), { recursive: true, force: true })
  }
  await heartbeat.pulse()
  await rm(join(trash, 'transaction.json'), { force: true })
  await heartbeat.pulse()
  await rm(trash, { recursive: true, force: true })
}

function matchesTransactionIdentity(details, target) {
  return Boolean(details
    && !details.isSymbolicLink()
    && details.dev === target.dev
    && details.ino === target.ino
    && (target.type === 'directory' ? details.isDirectory() : details.isFile()))
}

async function reconcileStagingTransaction(cacheRoot, trash, targets, heartbeat) {
  for (const target of [...targets].reverse()) {
    const source = join(cacheRoot, target.path)
    const destination = join(trash, target.path)
    const [sourceDetails, destinationDetails] = await Promise.all([
      lstat(source).catch(() => undefined), lstat(destination).catch(() => undefined),
    ])
    if (sourceDetails && !destinationDetails) {
      if (!matchesTransactionIdentity(sourceDetails, target)) {
        fail('Development converter cache staging source identity changed.')
      }
      continue
    }
    if (!sourceDetails && destinationDetails) {
      if (!matchesTransactionIdentity(destinationDetails, target)) {
        fail('Development converter cache staging destination identity changed.')
      }
      await heartbeat.pulse()
      await rename(destination, source)
      await Promise.all([syncDirectory(dirname(source)), syncDirectory(dirname(destination))])
      continue
    }
    fail('Development converter cache staging state is ambiguous.')
  }
  await heartbeat.pulse()
  await rm(trash, { recursive: true, force: true })
}

async function recoverTrash(cacheRoot, heartbeat) {
  for (const name of await readdir(cacheRoot)) {
    const match = trashPattern.exec(name)
    if (!match || !noncePattern.test(match[1])) continue
    const trash = join(cacheRoot, name)
    await validateDirectory(trash, 'Development converter cache trash is unsafe.')
    const trashNames = await readdir(trash)
    if (!trashNames.includes('transaction.json')) {
      for (const entry of trashNames) {
        const temporaryMatch = transactionTemporaryPattern.exec(entry)
        const details = await lstat(join(trash, entry)).catch(() => undefined)
        if (!temporaryMatch || !noncePattern.test(temporaryMatch[1])
          || !details?.isFile() || details.isSymbolicLink() || details.nlink !== 1) {
          fail('Development converter cache transaction is missing.')
        }
      }
      await heartbeat.pulse()
      await rm(trash, { recursive: true, force: true })
      continue
    }
    const transaction = await readTransaction(trash)
    await validateTransactionContents(trash, transaction.targets, heartbeat)
    if (transaction.phase === 'committed') {
      await deleteCommittedTransaction(trash, transaction.targets, heartbeat)
      continue
    }
    await reconcileStagingTransaction(cacheRoot, trash, transaction.targets, heartbeat)
  }
}

async function executePruneTransaction({
  root,
  plan,
  heartbeat,
  renameForTest = rename,
  rmForTest = rm,
  syncDirectoryForTest = syncDirectory,
}) {
  const trash = join(root, `.development-cache-trash-${randomUUID()}`)
  await heartbeat.pulse()
  await mkdir(trash, { mode: 0o700 })
  const targets = plan.targets.map((target) => ({
    dev: target.stat.dev,
    ino: target.stat.ino,
    path: relative(root, target.path),
    type: target.stat.isDirectory() ? 'directory' : 'file',
  })).sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
  try {
    await writeTransaction(trash, 'staging', targets, heartbeat)
  } catch (primary) {
    const cleanupErrors = []
    try {
      await heartbeat.pulse()
      await rm(trash, { recursive: true, force: true })
    } catch (error) { cleanupErrors.push(error) }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [primary, ...cleanupErrors],
        primary instanceof Error ? primary.message : 'Cache transaction initialization failed.',
        { cause: primary },
      )
    }
    throw primary
  }
  let primary
  let committed = false
  try {
    for (const target of plan.targets) {
      const current = await lstat(target.path).catch(() => undefined)
      if (!current || current.isSymbolicLink() || current.dev !== target.stat.dev || current.ino !== target.stat.ino) {
        fail('Development converter cache changed before pruning.')
      }
      const destination = join(trash, relative(root, target.path))
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      await heartbeat.pulse()
      await renameForTest(target.path, destination)
      await Promise.all([syncDirectoryForTest(dirname(target.path)), syncDirectoryForTest(dirname(destination))])
    }
    await writeTransaction(trash, 'committed', targets, heartbeat)
    committed = true
    await deleteCommittedTransaction(trash, targets, heartbeat, rmForTest)
  } catch (error) {
    primary = error
  }
  if (primary) {
    if (!committed) {
      try {
        committed = (await readTransaction(trash)).phase === 'committed'
      } catch (error) {
        throw new AggregateError(
          [primary, error],
          primary instanceof Error ? primary.message : 'Cache transaction phase could not be verified.',
          { cause: error },
        )
      }
    }
    if (committed) throw primary
    try {
      await reconcileStagingTransaction(root, trash, targets, heartbeat)
    } catch (error) {
      throw new AggregateError(
        [primary, error],
        primary instanceof Error ? primary.message : 'Development cache prune failed.',
        { cause: error },
      )
    }
    throw primary
  }
}

export async function pruneDevelopmentCache({
  cacheRoot,
  activeFingerprint,
  keepPrevious = 1,
  maximumBlobBytes = defaultMaximumBlobBytes,
  beforeMutationForTest,
  afterClaimOpenForTest,
  renameForTest,
  rmForTest,
  syncDirectoryForTest,
  migrateLegacyReleases = false,
}) {
  const root = await canonicalRoot(cacheRoot)
  return withDevelopmentCacheMutationClaim(root, async (claimedRoot, heartbeat) => {
    await recoverTrash(claimedRoot, heartbeat)
    if (migrateLegacyReleases) await migrateLegacyReleaseMetadata(claimedRoot, activeFingerprint, heartbeat)
    const plan = await collectCache(claimedRoot, activeFingerprint, keepPrevious, maximumBlobBytes)
    await beforeMutationForTest?.()
    if (plan.targets.length > 0) {
      await executePruneTransaction({
        root: claimedRoot,
        plan,
        heartbeat,
        renameForTest,
        rmForTest,
        syncDirectoryForTest,
      })
    }
    return Object.freeze({
      removedReleases: Object.freeze(plan.removedReleases),
      removedBlobs: Object.freeze(plan.removedBlobs),
    })
  }, { afterClaimOpenForTest })
}
