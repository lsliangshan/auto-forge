import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { constants } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { link, lstat, open, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { fail, requireAbsolutePath } from './pack-tooling-lib.mjs'

const maximumTemps = 32
const noncePattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u

function invalid(message = 'Durable lock publication failed.') {
  fail(message)
}

function missing(error) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0))
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function identical(path, wanted) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat()
    if (!before.isFile() || ![1, 2].includes(before.nlink) || before.size !== wanted.byteLength) return false
    const bytes = Buffer.alloc(wanted.byteLength)
    let offset = 0
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (!Number.isSafeInteger(result?.bytesRead) || result.bytesRead <= 0) return false
      offset += result.bytesRead
    }
    const extra = Buffer.alloc(1)
    if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0) return false
    const after = await handle.stat()
    return before.dev === after.dev
      && before.ino === after.ino
      && before.size === after.size
      && before.mtimeMs === after.mtimeMs
      && before.ctimeMs === after.ctimeMs
      && bytes.equals(wanted)
  } finally {
    await handle.close()
  }
}

async function requireTemp(path, mode, linked = false) {
  const metadata = await lstat(path).catch(() => undefined)
  if (
    !metadata?.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== (linked ? 2 : 1)
    || (metadata.mode & 0o777) !== mode
  ) invalid('Interrupted lock publication file is unsafe.')
  return metadata
}

async function recoverTemps(destination, wanted, mode, writingPrefix, readyPrefix) {
  const parent = dirname(destination)
  const names = (await readdir(parent)).filter((name) => (
    name.startsWith(writingPrefix) || name.startsWith(readyPrefix)
  ))
  if (names.length > maximumTemps) invalid('Too many interrupted lock publication files exist.')
  let changed = false
  for (const name of names.filter((candidate) => candidate.startsWith(writingPrefix))) {
    if (!noncePattern.test(name.slice(writingPrefix.length))) invalid('Interrupted lock publication file has an invalid name.')
    const path = join(parent, name)
    const metadata = await lstat(path).catch(() => undefined)
    if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      invalid('Interrupted lock publication file is unsafe.')
    }
    await unlink(path)
    changed = true
  }
  if (changed) await syncDirectory(parent)

  for (const name of names.filter((candidate) => candidate.startsWith(readyPrefix))) {
    if (!noncePattern.test(name.slice(readyPrefix.length))) invalid('Interrupted lock publication file has an invalid name.')
    const path = join(parent, name)
    const metadata = await lstat(path).catch(() => undefined)
    if (
      !metadata?.isFile()
      || metadata.isSymbolicLink()
      || ![1, 2].includes(metadata.nlink)
      || (metadata.mode & 0o777) !== mode
    ) invalid('Interrupted lock publication file is unsafe.')
    if (!await identical(path, wanted)) invalid('Interrupted ready lock publication differs.')
    const destinationMetadata = await lstat(destination).catch(() => undefined)
    if (destinationMetadata) {
      if (
        !destinationMetadata.isFile()
        || destinationMetadata.isSymbolicLink()
        || (destinationMetadata.mode & 0o777) !== mode
        || !await identical(destination, wanted)
      ) invalid('Existing generated lock differs; refusing to overwrite it.')
      if (metadata.nlink === 2 && (metadata.dev !== destinationMetadata.dev || metadata.ino !== destinationMetadata.ino)) {
        invalid('Interrupted lock publication hardlink is unsafe.')
      }
      await unlink(path)
      await syncDirectory(parent)
      return true
    }
    if (metadata.nlink !== 1) invalid('Interrupted lock publication hardlink is unsafe.')
    await link(path, destination)
    const linked = await requireTemp(path, mode, true)
    const published = await lstat(destination)
    if (linked.dev !== published.dev || linked.ino !== published.ino || !await identical(destination, wanted)) invalid()
    await unlink(path)
    await syncDirectory(parent)
    return true
  }
  return false
}

async function writeAll(handle, bytes, writeChunkForTest) {
  let offset = 0
  while (offset < bytes.byteLength) {
    const write = async (length = bytes.byteLength - offset) => handle.write(bytes, offset, length, offset)
    const result = writeChunkForTest
      ? await writeChunkForTest({ bytes, offset, write })
      : await write()
    if (!Number.isSafeInteger(result?.bytesWritten) || result.bytesWritten <= 0 || result.bytesWritten > bytes.byteLength - offset) invalid()
    offset += result.bytesWritten
  }
}

export async function publishDurableLockFile({
  destination,
  bytes,
  mode,
  writeChunkForTest,
  afterWriteForTest,
  afterChmodForTest,
  afterTempSyncForTest,
  afterReadyRenameForTest,
  afterReadySyncForTest,
  afterLinkForTest,
  syncDirectoryForTest,
  cleanupForTest,
}) {
  requireAbsolutePath(destination, 'Durable lock destination')
  const hooks = [
    writeChunkForTest, afterWriteForTest, afterChmodForTest, afterTempSyncForTest,
    afterReadyRenameForTest, afterReadySyncForTest, afterLinkForTest, syncDirectoryForTest, cleanupForTest,
  ]
  if (
    !Buffer.isBuffer(bytes)
    || bytes.byteLength === 0
    || ![0o600, 0o644].includes(mode)
    || hooks.some((hook) => hook !== undefined && typeof hook !== 'function')
  ) invalid()
  const parent = dirname(destination)
  const parentMetadata = await lstat(parent).catch(() => undefined)
  if (!parentMetadata?.isDirectory() || parentMetadata.isSymbolicLink() || await realpath(parent).catch(() => undefined) !== parent) {
    invalid('Durable lock destination parent is unsafe.')
  }
  const stem = `.${basename(destination)}.autoforge-`
  const writingPrefix = `${stem}writing-`
  const readyPrefix = `${stem}ready-`
  if (await recoverTemps(destination, bytes, mode, writingPrefix, readyPrefix)) return
  const existing = await lstat(destination).catch(() => undefined)
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 || (existing.mode & 0o777) !== mode || !await identical(destination, bytes)) {
      invalid('Existing generated lock differs; refusing to overwrite it.')
    }
    return
  }

  const nonce = randomUUID()
  const writing = join(parent, `${writingPrefix}${nonce}`)
  const ready = join(parent, `${readyPrefix}${nonce}`)
  let handle
  let primaryError
  try {
    handle = await open(
      writing,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    )
    await writeAll(handle, bytes, writeChunkForTest)
    await afterWriteForTest?.({ destination, writing })
    await handle.chmod(mode)
    await afterChmodForTest?.({ destination, writing })
    await handle.sync()
    await handle.close()
    handle = undefined
    await afterTempSyncForTest?.({ destination, temporary: writing })
    await requireTemp(writing, mode)
    if (!await identical(writing, bytes)) invalid('Durable lock temporary file failed verification.')
    await rename(writing, ready)
    await afterReadyRenameForTest?.({ destination, ready })
    const syncReadyDirectory = () => syncDirectory(parent)
    await (syncDirectoryForTest
      ? syncDirectoryForTest({ stage: 'ready', run: syncReadyDirectory })
      : syncReadyDirectory())
    const readyIdentity = await requireTemp(ready, mode)
    await afterReadySyncForTest?.({ destination, ready })
    const readyAtLink = await lstat(ready).catch(() => undefined)
    if (
      !readyAtLink?.isFile()
      || readyAtLink.isSymbolicLink()
      || ![1, 2].includes(readyAtLink.nlink)
      || (readyAtLink.mode & 0o777) !== mode
      || readyAtLink.dev !== readyIdentity.dev
      || readyAtLink.ino !== readyIdentity.ino
      || !await identical(ready, bytes)
    ) invalid('Durable lock ready identity differs before publication.')
    let linked = true
    let publishedIdentity
    try {
      await link(ready, destination)
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
      const raced = await lstat(destination).catch(() => undefined)
      const isCurrentReady = raced?.dev === readyIdentity.dev && raced?.ino === readyIdentity.ino
      if (
        !raced?.isFile()
        || raced.isSymbolicLink()
        || (raced.mode & 0o777) !== mode
        || (isCurrentReady ? raced.nlink !== 2 : raced.nlink !== 1)
        || !await identical(destination, bytes)
      ) invalid('Destination EEXIST race has an unsafe hardlink identity.')
      publishedIdentity = raced
      linked = false
    }
    await afterLinkForTest?.({ destination, ready, linked })
    if (linked) {
      const readyMetadata = await requireTemp(ready, mode, true)
      const destinationMetadata = await lstat(destination)
      if (
        !destinationMetadata.isFile()
        || destinationMetadata.isSymbolicLink()
        || readyMetadata.dev !== destinationMetadata.dev
        || readyMetadata.ino !== destinationMetadata.ino
      ) invalid('Durable lock no-replace publication identity differs.')
      publishedIdentity = destinationMetadata
    } else {
      const published = await lstat(destination)
      if ((published.mode & 0o777) !== mode) invalid('Existing generated lock mode differs.')
    }
    await unlink(ready)
    const syncPublishedDirectory = () => syncDirectory(parent)
    await (syncDirectoryForTest
      ? syncDirectoryForTest({ stage: 'published', run: syncPublishedDirectory })
      : syncPublishedDirectory())
    const published = await lstat(destination)
    if (
      !published.isFile()
      || published.isSymbolicLink()
      || published.nlink !== 1
      || (published.mode & 0o777) !== mode
      || published.dev !== publishedIdentity.dev
      || published.ino !== publishedIdentity.ino
      || !await identical(destination, bytes)
    ) invalid('Durable lock publication failed verification.')
    return
  } catch (error) {
    primaryError = error
  }
  const actions = [
    ...(handle ? [() => handle.close()] : []),
    () => unlink(writing).catch((error) => { if (!missing(error)) throw error }),
    () => unlink(ready).catch((error) => { if (!missing(error)) throw error }),
    () => syncDirectory(parent),
  ]
  const settled = await Promise.allSettled(actions.map((action, index) => (
    cleanupForTest ? cleanupForTest({ index, run: action }) : action()
  )))
  const cleanupErrors = settled.filter((result) => result.status === 'rejected').map((result) => result.reason)
  if (cleanupErrors.length > 0) {
    throw new AggregateError([primaryError, ...cleanupErrors], primaryError?.message ?? 'Durable lock publication cleanup failed.', { cause: primaryError })
  }
  throw primaryError
}
