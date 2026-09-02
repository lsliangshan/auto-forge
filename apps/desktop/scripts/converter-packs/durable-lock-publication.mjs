import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { constants } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { link, lstat, open, readdir, realpath, unlink } from 'node:fs/promises'
import { fail, readStableRegularFile, requireAbsolutePath } from './pack-tooling-lib.mjs'

const staleMilliseconds = 24 * 60 * 60 * 1000
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
  const bytes = await readStableRegularFile(path, 'Published lock candidate', wanted.byteLength)
  return bytes.equals(wanted)
}

async function recoverTemps(destination, wanted, prefix) {
  const parent = dirname(destination)
  const names = (await readdir(parent)).filter((name) => name.startsWith(prefix))
  if (names.length > maximumTemps) invalid('Too many interrupted lock publication files exist.')
  for (const name of names) {
    const nonce = name.slice(prefix.length)
    if (!noncePattern.test(nonce)) invalid('Interrupted lock publication file has an invalid name.')
    const path = join(parent, name)
    const metadata = await lstat(path).catch(() => undefined)
    if (!metadata?.isFile() || metadata.isSymbolicLink() || ![1, 2].includes(metadata.nlink)) {
      invalid('Interrupted lock publication file is unsafe.')
    }
    const destinationMetadata = await lstat(destination).catch(() => undefined)
    if (
      metadata.nlink === 2
      && destinationMetadata?.isFile()
      && !destinationMetadata.isSymbolicLink()
      && destinationMetadata.dev === metadata.dev
      && destinationMetadata.ino === metadata.ino
    ) {
      await unlink(path)
      await syncDirectory(parent)
      continue
    }
    if (metadata.nlink !== 1) invalid('Interrupted lock publication hardlink is unsafe.')
    if (destinationMetadata?.isFile() && !destinationMetadata.isSymbolicLink() && await identical(path, wanted) && await identical(destination, wanted)) {
      await unlink(path)
      await syncDirectory(parent)
      continue
    }
    if (!destinationMetadata && await identical(path, wanted)) {
      await link(path, destination)
      await unlink(path)
      await syncDirectory(parent)
      if (!await identical(destination, wanted)) invalid()
      return true
    }
    if (Date.now() - metadata.mtimeMs < staleMilliseconds) {
      invalid('Another lock publication may still be active.')
    }
    await unlink(path)
    await syncDirectory(parent)
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
  afterTempSyncForTest,
  cleanupForTest,
}) {
  requireAbsolutePath(destination, 'Durable lock destination')
  if (
    !Buffer.isBuffer(bytes)
    || bytes.byteLength === 0
    || ![0o600, 0o644].includes(mode)
    || (writeChunkForTest !== undefined && typeof writeChunkForTest !== 'function')
    || (afterTempSyncForTest !== undefined && typeof afterTempSyncForTest !== 'function')
    || (cleanupForTest !== undefined && typeof cleanupForTest !== 'function')
  ) invalid()
  const parent = dirname(destination)
  const parentMetadata = await lstat(parent).catch(() => undefined)
  if (!parentMetadata?.isDirectory() || parentMetadata.isSymbolicLink() || await realpath(parent).catch(() => undefined) !== parent) {
    invalid('Durable lock destination parent is unsafe.')
  }
  const prefix = `.${basename(destination)}.autoforge-tmp-`
  if (await recoverTemps(destination, bytes, prefix)) {
    const recovered = await lstat(destination)
    if ((recovered.mode & 0o777) !== mode) invalid('Recovered lock publication mode differs.')
    return
  }
  const existing = await lstat(destination).catch(() => undefined)
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 || (existing.mode & 0o777) !== mode || !await identical(destination, bytes)) {
      invalid('Existing generated lock differs; refusing to overwrite it.')
    }
    return
  }

  const temporary = join(parent, `${prefix}${randomUUID()}`)
  let handle
  let primaryError
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    )
    await writeAll(handle, bytes, writeChunkForTest)
    await handle.chmod(mode)
    await handle.sync()
    await handle.close()
    handle = undefined
    if (!await identical(temporary, bytes)) invalid('Durable lock temporary file failed verification.')
    await afterTempSyncForTest?.({ destination, temporary })
    let linked = true
    try {
      await link(temporary, destination)
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
      if (!await identical(destination, bytes)) invalid('Existing generated lock differs; refusing to overwrite it.')
      linked = false
    }
    if (!linked) {
      const published = await lstat(destination)
      if ((published.mode & 0o777) !== mode) invalid('Existing generated lock mode differs.')
      await unlink(temporary)
      await syncDirectory(parent)
      return
    }
    const temporaryMetadata = await lstat(temporary)
    const destinationMetadata = await lstat(destination)
    if (
      !temporaryMetadata.isFile()
      || temporaryMetadata.isSymbolicLink()
      || !destinationMetadata.isFile()
      || destinationMetadata.isSymbolicLink()
      || temporaryMetadata.dev !== destinationMetadata.dev
      || temporaryMetadata.ino !== destinationMetadata.ino
      || temporaryMetadata.nlink !== 2
      || destinationMetadata.nlink !== 2
    ) invalid('Durable lock no-replace publication identity differs.')
    await unlink(temporary)
    await syncDirectory(parent)
    const published = await lstat(destination)
    if ((published.mode & 0o777) !== mode || !await identical(destination, bytes)) invalid('Durable lock publication failed verification.')
    return
  } catch (error) {
    primaryError = error
  }
  const actions = [
    ...(handle ? [() => handle.close()] : []),
    () => unlink(temporary).catch((error) => { if (!missing(error)) throw error }),
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
