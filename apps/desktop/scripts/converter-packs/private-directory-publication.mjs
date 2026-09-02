import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readdir, realpath, rename, rm, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import process from 'node:process'
import { canonicalBytes, fail, isPathInsideRoot, requireDirectory } from './pack-tooling-lib.mjs'

const noncePattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const maximumClaimBytes = 2048
const initializationGraceMs = 250
const heartbeatMs = 5 * 1000

function missing(error) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function ownerAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EPERM')
  }
}

function exactKeys(value, expected) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === expected.length
    && expected.every((key) => Object.hasOwn(value, key))
}

function validClaim(value, destination) {
  const expectedPartial = `.${basename(destination)}.${value?.nonce}.partial`
  return exactKeys(value, ['createdAtMs', 'nonce', 'partialName', 'pid'])
    && Number.isSafeInteger(value.createdAtMs)
    && value.createdAtMs > 0
    && noncePattern.test(value.nonce)
    && value.partialName === expectedPartial
    && Number.isSafeInteger(value.pid)
    && value.pid > 0
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino
}

export async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0))
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function writeDurableFile(path, bytes, mode) {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    mode,
  )
  try {
    await handle.writeFile(bytes)
    await handle.chmod(mode)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function syncDirectoryTree(root) {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) await syncDirectoryTree(join(root, entry.name))
  }
  await syncDirectory(root)
}

export async function settleCleanup(primaryError, actions, cleanupMessage) {
  const errors = []
  for (const action of actions) {
    const [result] = await Promise.allSettled([Promise.resolve().then(action)])
    if (result.status === 'rejected') errors.push(result.reason)
  }
  if (primaryError !== undefined) {
    if (errors.length > 0) {
      const message = primaryError instanceof Error ? primaryError.message : cleanupMessage
      throw new AggregateError([primaryError, ...errors], message)
    }
    throw primaryError
  }
  if (errors.length > 0) throw new AggregateError(errors, cleanupMessage)
}

async function readClaim(path, destination, allowedLinks = [1]) {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    if (missing(error)) return undefined
    fail('Private directory publication claim is invalid.')
  }
  try {
    const [opened, current] = await Promise.all([handle.stat(), lstat(path).catch(() => undefined)])
    if (
      !opened.isFile()
      || !current?.isFile()
      || current.isSymbolicLink()
      || !allowedLinks.includes(opened.nlink)
      || !allowedLinks.includes(current.nlink)
      || !sameIdentity(opened, current)
    ) fail('Private directory publication claim is invalid.')
    if (opened.size > maximumClaimBytes) return { stat: opened }
    const bytes = await handle.readFile()
    let value
    try { value = JSON.parse(bytes.toString('utf8')) } catch { return { bytes, stat: opened } }
    if (!bytes.equals(canonicalBytes(value)) || !validClaim(value, destination)) return { bytes, stat: opened }
    return { bytes, stat: opened, value }
  } finally {
    await handle.close()
  }
}

async function unlinkIdentity(path, expected, allowedLinks = [1]) {
  const current = await lstat(path).catch((error) => missing(error) ? undefined : Promise.reject(error))
  if (
    !current?.isFile()
    || current.isSymbolicLink()
    || !allowedLinks.includes(current.nlink)
    || !sameIdentity(current, expected)
  ) return false
  await unlink(path).catch((error) => { if (!missing(error)) throw error })
  return true
}

async function fenceClaim(path, destination, current) {
  const suffix = current.value?.nonce ?? `${current.stat.dev}-${current.stat.ino}`
  const predecessor = `${path}.${suffix}.predecessor`
  try {
    await link(path, predecessor)
  } catch (error) {
    if (missing(error)) return false
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
  }
  const [active, preserved] = await Promise.all([
    lstat(path).catch(() => undefined),
    lstat(predecessor).catch(() => undefined),
  ])
  if (
    !active?.isFile()
    || active.isSymbolicLink()
    || active.nlink !== 2
    || !preserved?.isFile()
    || preserved.isSymbolicLink()
    || preserved.nlink !== 2
    || !sameIdentity(active, current.stat)
    || !sameIdentity(preserved, current.stat)
  ) fail('Private directory publication claim changed during recovery.')
  if (!await unlinkIdentity(path, current.stat, [2])) return false
  await syncDirectory(dirname(path))
  if (current.value) {
    const partial = join(dirname(destination), current.value.partialName)
    if (!isPathInsideRoot(dirname(destination), partial)) fail('Private directory publication claim is invalid.')
    await rm(partial, { recursive: true, force: true })
  }
  await unlinkIdentity(predecessor, current.stat)
  await syncDirectory(dirname(path))
  return true
}

async function verifyClaim(claim) {
  const content = Buffer.alloc(claim.bytes.byteLength)
  const [opened, current, read] = await Promise.all([
    claim.handle.stat(),
    lstat(claim.path).catch(() => undefined),
    claim.handle.read(content, 0, content.byteLength, 0),
  ])
  if (
    !current?.isFile()
    || current.isSymbolicLink()
    || current.nlink !== 1
    || opened.nlink !== 1
    || !sameIdentity(opened, claim)
    || !sameIdentity(current, claim)
    || opened.size !== claim.bytes.byteLength
    || read.bytesRead !== claim.bytes.byteLength
    || !content.equals(claim.bytes)
  ) fail('Private directory publication claim was lost.')
}

async function acquireClaim(destination, afterClaimOpenForTest, claimInitializationCleanupForTest) {
  const path = `${destination}.claim`
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const nonce = randomUUID()
    const value = {
      createdAtMs: Date.now(),
      nonce,
      partialName: `.${basename(destination)}.${nonce}.partial`,
      pid: process.pid,
    }
    const bytes = canonicalBytes(value)
    let handle
    let created
    try {
      handle = await open(
        path,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      )
      created = await handle.stat()
      await afterClaimOpenForTest?.({ claimPath: path })
      await handle.writeFile(bytes)
      await handle.sync()
      await syncDirectory(dirname(path))
      const metadata = await handle.stat()
      return { path, handle, bytes, dev: metadata.dev, ino: metadata.ino, value }
    } catch (error) {
      if (handle) {
        const run = (step, action) => () => claimInitializationCleanupForTest
          ? claimInitializationCleanupForTest({ step, run: action })
          : action()
        await settleCleanup(error, [
          run('close', () => handle.close()),
          ...(created ? [run('unlink', () => unlinkIdentity(path, created))] : []),
          run('sync', () => syncDirectory(dirname(path))),
        ], 'Private directory claim initialization cleanup failed.')
      }
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
    }
    const current = await readClaim(path, destination)
    if (!current) continue
    if (!current.value) {
      if (Date.now() - current.stat.mtimeMs <= initializationGraceMs) {
        fail('Private directory publication is already claimed.')
      }
    } else if (ownerAlive(current.value.pid)) {
      fail('Private directory publication is already claimed.')
    }
    await fenceClaim(path, destination, current)
  }
  fail('Private directory publication is already claimed.')
}

function startHeartbeat(claim) {
  let pending = Promise.resolve()
  let failure
  let stopped = false
  const heartbeat = () => {
    if (stopped || failure) return
    pending = pending.then(async () => {
      await verifyClaim(claim)
      const now = new Date()
      await claim.handle.utimes(now, now)
      await verifyClaim(claim)
    }).catch((error) => { failure = error; stopped = true })
  }
  const timer = globalThis.setInterval(heartbeat, heartbeatMs)
  timer.unref?.()
  return {
    async pulse() {
      heartbeat()
      await pending
      if (failure) throw failure
    },
    async stop() {
      stopped = true
      globalThis.clearInterval(timer)
      await pending
    },
  }
}

async function releaseClaim(claim) {
  await settleCleanup(undefined, [
    () => verifyClaim(claim),
    () => claim.handle.close(),
    () => unlinkIdentity(claim.path, claim),
    () => syncDirectory(dirname(claim.path)),
  ], 'Private directory claim release failed.')
}

export async function publishPrivateDirectory({
  destination,
  populate,
  verifyExisting,
  beforePublishForTest,
  afterClaimOpenForTest,
  removePrivateRootForTest,
  claimInitializationCleanupForTest,
}) {
  if (typeof populate !== 'function' || typeof verifyExisting !== 'function') {
    fail('Private directory publication request is invalid.')
  }
  const parent = dirname(destination)
  await requireDirectory(parent, 'Private directory publication parent')
  const claim = await acquireClaim(destination, afterClaimOpenForTest, claimInitializationCleanupForTest)
  const heartbeat = startHeartbeat(claim)
  const privateRoot = join(parent, claim.value.partialName)
  let published = false
  let failed = false
  let primaryError
  try {
    if (await lstat(destination).catch(() => undefined)) {
      await verifyExisting(destination)
    } else {
      await mkdir(privateRoot, { mode: 0o700 })
      if (await realpath(privateRoot) !== privateRoot || !isPathInsideRoot(parent, privateRoot)) {
        fail('Private directory publication root is invalid.')
      }
      await populate(privateRoot, heartbeat)
      await syncDirectoryTree(privateRoot)
      await beforePublishForTest?.({ claimPath: claim.path, destination, privateRoot })
      await heartbeat.pulse()
      await verifyClaim(claim)
      await requireDirectory(parent, 'Private directory publication parent')
      if (await lstat(destination).catch(() => undefined)) fail('Private directory publication destination already exists.')
      await rename(privateRoot, destination)
      await syncDirectory(parent)
      published = true
    }
  } catch (error) {
    failed = true
    primaryError = error
  }
  await settleCleanup(failed ? primaryError : undefined, [
    ...(!published && await lstat(privateRoot).catch(() => undefined)
      ? [() => removePrivateRootForTest
          ? removePrivateRootForTest(privateRoot)
          : rm(privateRoot, { recursive: true, force: true })]
      : []),
    () => heartbeat.stop(),
    () => releaseClaim(claim),
  ], 'Private directory publication cleanup failed.')
  return destination
}
