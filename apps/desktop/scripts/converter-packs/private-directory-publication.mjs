import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, opendir, readdir, realpath, rename, rm, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import process from 'node:process'
import { canonicalBytes, fail, isPathInsideRoot, requireDirectory } from './pack-tooling-lib.mjs'

const noncePattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const maximumClaimBytes = 2048
const initializationGraceMs = 250
const heartbeatMs = 5 * 1000
const leaseMs = 30 * 1000
const maximumPredecessors = 2
const maximumParentEntries = 4096
const activeRecoveryNonces = new Set()

function missing(error) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function ownerState(pid) {
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (error) {
    return error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH'
      ? 'dead'
      : 'unknown'
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
  return exactKeys(value, ['createdAtMs', 'leaseMs', 'nonce', 'partialName', 'pid'])
    && Number.isSafeInteger(value.createdAtMs)
    && value.createdAtMs > 0
    && value.leaseMs === leaseMs
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

function recoveryPath(path, token, recoveryNonce, kind) {
  return `${path}.${token}.${process.pid}.${recoveryNonce}.${kind}`
}

function validPredecessorToken(token, predecessor) {
  return token === predecessor.value?.nonce || token === `${predecessor.stat.dev}-${predecessor.stat.ino}`
}

async function takeRecoveryCandidate(candidate, destination, recoveryNonce) {
  const before = await readClaim(candidate.path, destination, [1, 2])
  if (!before) return undefined
  const path = recoveryPath(`${destination}.claim`, candidate.token, recoveryNonce, candidate.kind)
  try {
    await rename(candidate.path, path)
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
  const moved = await readClaim(path, destination, [1, 2])
  if (!moved || !sameIdentity(moved.stat, before.stat)) {
    fail('Private directory publication predecessor changed during recovery.')
  }
  return { ...candidate, path, pid: process.pid, recoveryNonce, record: moved }
}

async function runRecoveryMutation(recoveryMutationForTest, step, action) {
  return recoveryMutationForTest ? recoveryMutationForTest({ step, run: action }) : action()
}

async function finishRecovery(destination, candidates, afterFenceStepForTest, recoveryMutationForTest) {
  const claimPath = `${destination}.claim`
  const refreshed = []
  for (const candidate of candidates) {
    const record = await readClaim(candidate.path, destination, [1, 2])
    if (!record || !sameIdentity(record.stat, candidate.record.stat)) {
      fail('Private directory publication predecessor changed during recovery.')
    }
    refreshed.push({ ...candidate, record })
  }
  candidates = refreshed
  let preserved = candidates.find((candidate) => candidate.kind === 'recovering')
  let active = candidates.find((candidate) => candidate.kind === 'active')
  if (!preserved && !active) return false
  const record = preserved?.record ?? active.record
  if (!validPredecessorToken((preserved ?? active).token, record)) {
    fail('Private directory publication predecessor is invalid.')
  }
  if (preserved && active) {
    if (
      preserved.token !== active.token
      || !sameIdentity(preserved.record.stat, active.record.stat)
      || preserved.record.stat.nlink !== 2
      || active.record.stat.nlink !== 2
    ) fail('Private directory publication predecessor is invalid.')
  } else if (preserved?.record.stat.nlink === 2) {
    const current = await readClaim(claimPath, destination, [2])
    if (
      !current
      || !sameIdentity(current.stat, preserved.record.stat)
      || Boolean(current.value) !== Boolean(preserved.record.value)
      || (current.value && current.value.nonce !== preserved.record.value.nonce)
    ) fail('Private directory publication predecessor does not match the active claim.')
    const isolatedActive = recoveryPath(claimPath, preserved.token, preserved.recoveryNonce, 'active')
    await rename(claimPath, isolatedActive)
    const moved = await readClaim(isolatedActive, destination, [2])
    if (!moved || !sameIdentity(moved.stat, preserved.record.stat)) {
      fail('Private directory publication claim changed during recovery.')
    }
    active = { ...preserved, kind: 'active', path: isolatedActive, record: moved }
  } else if (preserved?.record.stat.nlink === 1) {
    active = { ...preserved, kind: 'active' }
    preserved = undefined
  } else if (active?.record.stat.nlink !== 1) {
    fail('Private directory publication predecessor has an invalid link count.')
  }
  if (preserved) {
    if (!await unlinkIdentity(preserved.path, preserved.record.stat, [2])) {
      fail('Private directory publication predecessor changed during cleanup.')
    }
    await runRecoveryMutation(
      recoveryMutationForTest,
      'sync-isolated-active',
      () => syncDirectory(dirname(claimPath)),
    )
  }
  await afterFenceStepForTest?.({ step: 'active-unlink', predecessor: active.path })
  if (record.value) {
    const partial = join(dirname(destination), record.value.partialName)
    if (!isPathInsideRoot(dirname(destination), partial)) fail('Private directory publication predecessor is invalid.')
    await runRecoveryMutation(
      recoveryMutationForTest,
      'remove-partial',
      () => rm(partial, { recursive: true, force: true }),
    )
  }
  await afterFenceStepForTest?.({ step: 'partial-cleanup', predecessor: active.path })
  if (!await unlinkIdentity(active.path, active.record.stat)) {
    fail('Private directory publication predecessor changed during cleanup.')
  }
  await syncDirectory(dirname(claimPath))
  return true
}

async function fenceClaim(path, destination, current, afterFenceStepForTest, recoveryMutationForTest) {
  const suffix = current.value?.nonce ?? `${current.stat.dev}-${current.stat.ino}`
  const predecessor = `${path}.${suffix}.predecessor`
  try {
    await link(path, predecessor)
  } catch (error) {
    if (missing(error)) return false
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') return false
    throw error
  }
  const recoveryNonce = randomUUID()
  activeRecoveryNonces.add(recoveryNonce)
  try {
    const owned = await takeRecoveryCandidate(
      { kind: 'recovering', path: predecessor, token: suffix },
      destination,
      recoveryNonce,
    )
    if (!owned) return false
    await afterFenceStepForTest?.({ step: 'predecessor-link', predecessor: owned.path })
    return finishRecovery(destination, [owned], afterFenceStepForTest, recoveryMutationForTest)
  } finally {
    activeRecoveryNonces.delete(recoveryNonce)
  }
}

async function predecessorPaths(destination) {
  const claimPath = `${destination}.claim`
  const prefix = `${basename(claimPath)}.`
  const paths = []
  let inspected = 0
  const directory = await opendir(dirname(claimPath))
  for await (const entry of directory) {
    inspected += 1
    if (inspected > maximumParentEntries) fail('Private directory publication parent inventory is too large.')
    if (!entry.name.startsWith(prefix)) continue
    if (!entry.isFile()) fail('Private directory publication predecessor is invalid.')
    const remainder = entry.name.slice(prefix.length)
    let token
    let kind = 'recovering'
    let pid
    let recoveryNonce
    if (remainder.endsWith('.predecessor')) {
      token = remainder.slice(0, -'.predecessor'.length)
    } else {
      const parts = remainder.split('.')
      kind = parts.at(-1)
      recoveryNonce = parts.at(-2)
      pid = Number(parts.at(-3))
      token = parts.slice(0, -3).join('.')
      if (!['recovering', 'active'].includes(kind) || !noncePattern.test(recoveryNonce) || !Number.isSafeInteger(pid) || pid <= 0) continue
    }
    if (!noncePattern.test(token) && !/^[1-9]\d*-[1-9]\d*$/u.test(token)) {
      fail('Private directory publication predecessor is invalid.')
    }
    paths.push({ kind, path: join(dirname(claimPath), entry.name), pid, recoveryNonce, token })
    if (paths.length > maximumPredecessors) fail('Private directory publication has too many predecessors.')
  }
  return paths
}

async function recoverPredecessors(destination, recoveryMutationForTest) {
  const candidates = await predecessorPaths(destination)
  if (candidates.length === 0) return
  for (const candidate of candidates) {
    if (
      candidate.pid
      && (candidate.pid !== process.pid || activeRecoveryNonces.has(candidate.recoveryNonce))
      && ownerState(candidate.pid) !== 'dead'
    ) {
      fail('Private directory publication is already claimed.')
    }
  }
  const recoveryNonce = randomUUID()
  const ordered = [...candidates].sort((left, right) => (
    (left.kind === 'recovering' ? 0 : left.kind === 'active' ? 1 : 2)
    - (right.kind === 'recovering' ? 0 : right.kind === 'active' ? 1 : 2)
  ))
  activeRecoveryNonces.add(recoveryNonce)
  try {
    const owned = []
    for (const candidate of ordered) {
      const claimed = await takeRecoveryCandidate(candidate, destination, recoveryNonce)
      if (!claimed) return
      owned.push(claimed)
    }
    await finishRecovery(destination, owned, undefined, recoveryMutationForTest)
  } finally {
    activeRecoveryNonces.delete(recoveryNonce)
  }
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

async function acquireClaim(
  destination,
  afterClaimOpenForTest,
  claimInitializationCleanupForTest,
  afterFenceStepForTest,
  recoveryMutationForTest,
) {
  const path = `${destination}.claim`
  for (let attempt = 0; attempt < 16; attempt += 1) {
    await recoverPredecessors(destination, recoveryMutationForTest)
    const nonce = randomUUID()
    const value = {
      createdAtMs: Date.now(),
      leaseMs,
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
      const claim = { path, handle, bytes, dev: metadata.dev, ino: metadata.ino, value }
      await verifyClaim(claim)
      return claim
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
    } else {
      const owner = ownerState(current.value.pid)
      if (owner !== 'dead') fail('Private directory publication is already claimed.')
      // ESRCH is a definitive local-owner death and safely revokes even a fresh lease.
    }
    await fenceClaim(path, destination, current, afterFenceStepForTest, recoveryMutationForTest)
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
  afterFenceStepForTest,
  recoveryMutationForTest,
}) {
  if (typeof populate !== 'function' || typeof verifyExisting !== 'function') {
    fail('Private directory publication request is invalid.')
  }
  const parent = dirname(destination)
  await requireDirectory(parent, 'Private directory publication parent')
  const claim = await acquireClaim(
    destination,
    afterClaimOpenForTest,
    claimInitializationCleanupForTest,
    afterFenceStepForTest,
    recoveryMutationForTest,
  )
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
