import { createHash, randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { constants, lstatSync, realpathSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import {
  canonicalBytes,
  fail,
  isPathInsideRoot,
  PACK_NAMES,
  requireAbsolutePath,
  requireDirectory,
  safeEntryPath,
  withStableRegularFile,
} from './pack-tooling-lib.mjs'
import { scanVerifiedBottleEntries } from './bottle-archive.mjs'

const formulaPattern = /^[a-z0-9][a-z0-9+_.@-]*$/u
const versionPattern = /^[A-Za-z0-9._+-]+$/u
const sha256Pattern = /^[a-f0-9]{64}$/u
const roles = new Set(['executable', 'code', 'data', 'license'])
const targets = new Set(['darwin-arm64', 'darwin-x64'])

function invalid() {
  fail('Bottle universe inventory is invalid.')
}

function validFormula(value) {
  return typeof value === 'string' && value.length <= 128 && formulaPattern.test(value)
}

function validVersion(value) {
  return typeof value === 'string'
    && value.length <= 128
    && value !== '.'
    && value !== '..'
    && value.normalize('NFC') === value
    && versionPattern.test(value)
}

function regularMode(entry) {
  return entry.executable ? 0o755 : 0o644
}

function validLockedBottleMode(entry, mode) {
  if (entry.role === 'executable') return mode === 0o555
  if (entry.role === 'code') return mode === 0o444
  if (entry.role === 'license') return mode === 0o644
  return entry.role === 'data' && (mode === 0o444 || mode === 0o644) && (mode & 0o111) === 0
}

function validSelectedEntry(entry) {
  return entry
    && typeof entry === 'object'
    && safeEntryPath(entry.sourcePath)
    && sha256Pattern.test(entry.sha256)
    && Number.isSafeInteger(entry.bytes)
    && entry.bytes > 0
    && typeof entry.executable === 'boolean'
    && roles.has(entry.role)
    && (entry.role === 'executable' ? entry.executable : !entry.executable)
}

function validateCoordinate(coordinate) {
  if (
    !coordinate
    || typeof coordinate !== 'object'
    || !validFormula(coordinate.name)
    || !validVersion(coordinate.version)
    || !coordinate.acquisition
    || typeof coordinate.acquisition !== 'object'
    || coordinate.acquisition.kind !== 'homebrew-bottle'
    || !sha256Pattern.test(coordinate.acquisition.sha256)
    || !Number.isSafeInteger(coordinate.acquisition.bytes)
    || coordinate.acquisition.bytes <= 0
  ) invalid()
}

function expectedEntries(selectedEntries) {
  if (!Array.isArray(selectedEntries) || selectedEntries.length === 0) invalid()
  const selected = new Map()
  for (const entry of selectedEntries) {
    if (!validSelectedEntry(entry)) invalid()
    const folded = entry.sourcePath.toLocaleLowerCase('en-US')
    const previous = selected.get(folded)
    if (previous !== undefined) {
      if (
        previous.sourcePath !== entry.sourcePath
        || previous.sha256 !== entry.sha256
        || previous.bytes !== entry.bytes
        || previous.executable !== entry.executable
        || previous.role !== entry.role
      ) invalid()
      continue
    }
    selected.set(folded, Object.freeze({
      sourcePath: entry.sourcePath,
      sha256: entry.sha256,
      bytes: entry.bytes,
      executable: entry.executable,
      role: entry.role,
    }))
  }
  return [...selected.values()].sort((left, right) => Buffer.compare(Buffer.from(left.sourcePath), Buffer.from(right.sourcePath)))
}

function verifyArchiveLinks(entries, rootPrefix) {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]))
  const versionRoot = rootPrefix.slice(0, -1)
  const formulaRoot = versionRoot.slice(0, versionRoot.indexOf('/'))
  for (const entry of entries) {
    if (
      entry.path !== formulaRoot
      && entry.path !== versionRoot
      && !entry.path.startsWith(rootPrefix)
    ) invalid()
    if ((entry.path === formulaRoot || entry.path === versionRoot) && entry.type !== 'directory') invalid()
    if (entry.type === 'symlink') {
      if (!entry.linkTarget.startsWith(rootPrefix) || !byPath.has(entry.linkTarget)) invalid()
    }
  }
  const state = new Map()
  for (const start of entries) {
    if (start.type !== 'symlink' || state.get(start.path) === 'done') continue
    const stack = []
    let path = start.path
    while (true) {
      if (state.get(path) === 'visiting') invalid()
      if (state.get(path) === 'done') break
      const entry = byPath.get(path)
      if (entry?.type !== 'symlink') break
      state.set(path, 'visiting')
      stack.push(path)
      path = entry.linkTarget
    }
    while (stack.length > 0) state.set(stack.pop(), 'done')
  }
  return byPath
}

async function createOutputHandle(root, relativePath, mode) {
  const segments = relativePath.split('/')
  let directory = root
  for (const segment of segments.slice(0, -1)) {
    directory = join(directory, segment)
    const metadata = await lstat(directory).catch(() => undefined)
    if (metadata === undefined) await mkdir(directory, { mode: 0o755 })
    await requireDirectory(directory, 'Bottle extraction directory')
    if (!isPathInsideRoot(root, await realpath(directory))) invalid()
  }
  const output = join(directory, segments.at(-1))
  const handle = await open(
    output,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    mode,
  ).catch(() => undefined)
  if (!handle) invalid()
  return { handle, path: output }
}

async function createPrivateDirectory(parent, prefix) {
  const root = await realpath(await mkdtemp(join(parent, prefix)))
  if (!isPathInsideRoot(parent, root)) {
    await rm(root, { recursive: true, force: true })
    invalid()
  }
  return root
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0))
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function acquireDestinationClaim(destination) {
  const path = `${destination}.claim`
  const nonce = randomUUID()
  const pid = process.pid
  const bytes = canonicalBytes({ nonce, pid })
  const handle = await open(
    path,
    constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  ).catch(() => undefined)
  if (!handle) fail('Bottle extraction destination is already claimed.')
  try {
    await handle.writeFile(bytes)
    await handle.sync()
    await syncDirectory(dirname(path))
    const metadata = await handle.stat()
    return { path, handle, dev: metadata.dev, ino: metadata.ino, bytes, nonce }
  } catch (error) {
    await handle.close().catch(() => undefined)
    await unlink(path).catch(() => undefined)
    throw error
  }
}

async function verifyDestinationClaim(claim) {
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
    || current.dev !== claim.dev
    || current.ino !== claim.ino
    || opened.dev !== claim.dev
    || opened.ino !== claim.ino
    || opened.size !== claim.bytes.byteLength
    || read.bytesRead !== claim.bytes.byteLength
    || !content.equals(claim.bytes)
  ) invalid()
}

async function releaseDestinationClaim(claim) {
  await claim.handle.close().catch(() => undefined)
  const current = await lstat(claim.path).catch(() => undefined)
  if (current?.dev === claim.dev && current.ino === claim.ino) await unlink(claim.path)
  await syncDirectory(dirname(claim.path))
}

async function writeAll(handle, bytes, position) {
  let offset = 0
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, position + offset)
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) invalid()
    offset += bytesWritten
  }
  return offset
}

async function copyVerifiedRegularFile({ source, destinationRoot, destinationPath, expected, openHandles }) {
  return withStableRegularFile(source, 'Bottle selected link target', async (sourceHandle, metadata) => {
    if (metadata.size !== expected.bytes) invalid()
    const output = await createOutputHandle(destinationRoot, destinationPath, regularMode(expected))
    openHandles.add(output.handle)
    const digest = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let position = 0
    try {
      while (position < metadata.size) {
        const { bytesRead } = await sourceHandle.read(buffer, 0, Math.min(buffer.byteLength, metadata.size - position), position)
        if (bytesRead <= 0) invalid()
        const chunk = buffer.subarray(0, bytesRead)
        digest.update(chunk)
        await writeAll(output.handle, chunk, position)
        position += bytesRead
      }
      if (digest.digest('hex') !== expected.sha256) invalid()
      await output.handle.chmod(regularMode(expected))
      await output.handle.sync()
    } finally {
      openHandles.delete(output.handle)
      await output.handle.close()
    }
  })
}

export async function extractVerifiedBottle({
  archive,
  coordinate,
  selectedEntries,
  destination,
  beforePublishForTest,
}) {
  validateCoordinate(coordinate)
  if (beforePublishForTest !== undefined && typeof beforePublishForTest !== 'function') invalid()
  requireAbsolutePath(destination, 'Bottle extraction destination')
  const parent = dirname(destination)
  await requireDirectory(parent, 'Bottle extraction parent')
  if (await lstat(destination).catch(() => undefined)) invalid()
  const selected = expectedEntries(selectedEntries)
  const acquisition = coordinate.acquisition
  const rootPrefix = `${coordinate.name}/${coordinate.version}/`
  const selectedByArchivePath = new Map(selected.map((entry) => [`${rootPrefix}${entry.sourcePath}`, entry]))
  const claim = await acquireDestinationClaim(destination)
  let privateRoot
  let published = false
  const openHandles = new Set()
  try {
    if (await lstat(destination).catch(() => undefined)) invalid()
    privateRoot = await createPrivateDirectory(parent, '.bottle-extract-')
    const archiveEntries = await scanVerifiedBottleEntries({
      archive,
      expectedBytes: acquisition.bytes,
      expectedSha256: acquisition.sha256,
      onFile: async (metadata) => {
        const expected = selectedByArchivePath.get(metadata.path)
        if (!expected) return undefined
        if (!validLockedBottleMode(expected, metadata.mode) || metadata.size !== expected.bytes) invalid()
        const output = await createOutputHandle(privateRoot, expected.sourcePath, regularMode(expected))
        openHandles.add(output.handle)
        let position = 0
        return {
          async write(chunk) {
            position += await writeAll(output.handle, chunk, position)
          },
          async finish(entry) {
            try {
              if (entry.size !== expected.bytes || entry.sha256 !== expected.sha256 || position !== expected.bytes) invalid()
              await output.handle.chmod(regularMode(expected))
              await output.handle.sync()
            } finally {
              openHandles.delete(output.handle)
              await output.handle.close()
            }
          },
        }
      },
    })
    const archiveByPath = verifyArchiveLinks(archiveEntries, rootPrefix)
    for (const expected of selected) {
      const archiveEntry = archiveByPath.get(`${rootPrefix}${expected.sourcePath}`)
      if (!archiveEntry) invalid()
      if (archiveEntry.type === 'file') {
        if (
          !validLockedBottleMode(expected, archiveEntry.mode)
          || archiveEntry.size !== expected.bytes
          || archiveEntry.sha256 !== expected.sha256
        ) invalid()
        continue
      }
      if (archiveEntry.type !== 'symlink') invalid()
      const targetExpected = selectedByArchivePath.get(archiveEntry.linkTarget)
      const target = archiveByPath.get(archiveEntry.linkTarget)
      if (
        !targetExpected
        || target?.type !== 'file'
        || targetExpected.sha256 !== expected.sha256
        || targetExpected.bytes !== expected.bytes
        || targetExpected.executable !== expected.executable
        || targetExpected.role !== expected.role
        || target.sha256 !== expected.sha256
        || target.size !== expected.bytes
      ) invalid()
      await copyVerifiedRegularFile({
        source: join(privateRoot, ...targetExpected.sourcePath.split('/')),
        destinationRoot: privateRoot,
        destinationPath: expected.sourcePath,
        expected,
        openHandles,
      })
    }
    await beforePublishForTest?.({ claimPath: claim.path, destination })
    await verifyDestinationClaim(claim)
    await requireDirectory(parent, 'Bottle extraction parent')
    await requireDirectory(privateRoot, 'Bottle private extraction root')
    if (await lstat(destination).catch(() => undefined)) invalid()
    await rename(privateRoot, destination)
    await syncDirectory(parent)
    published = true
  } finally {
    await Promise.allSettled([...openHandles].map((handle) => handle.close()))
    if (!published && privateRoot !== undefined) await rm(privateRoot, { recursive: true, force: true })
    await releaseDestinationClaim(claim)
  }
  return Object.freeze(selected.map((entry) => Object.freeze({
    sourcePath: entry.sourcePath,
    path: join(destination, ...entry.sourcePath.split('/')),
  })))
}

function addSelectedEntry(inventory, formula, entry) {
  const key = `${formula}\0${entry.sourcePath.toLocaleLowerCase('en-US')}`
  const selected = {
    sourcePath: entry.sourcePath,
    sha256: entry.sha256,
    bytes: entry.bytes,
    executable: entry.executable,
    role: entry.role,
  }
  const previous = inventory.get(key)
  if (previous !== undefined) {
    if (
      previous.sourcePath !== selected.sourcePath
      || previous.sha256 !== selected.sha256
      || previous.bytes !== selected.bytes
      || previous.executable !== selected.executable
      || previous.role !== selected.role
    ) invalid()
    return
  }
  inventory.set(key, selected)
}

function selectedInventory(closureLock) {
  const inventory = new Map()
  for (const family of PACK_NAMES) {
    const value = closureLock.families?.[family]
    if (!value || !Array.isArray(value.files) || !Array.isArray(value.licenses)) invalid()
    for (const file of value.files) {
      addSelectedEntry(inventory, file.formula, file)
    }
    for (const license of value.licenses) {
      if (typeof license.source !== 'string' || license.source.startsWith('https://')) continue
      addSelectedEntry(inventory, license.formula, {
        sourcePath: license.source,
        sha256: license.sha256,
        bytes: license.bytes,
        executable: false,
        role: 'license',
      })
    }
  }
  return inventory
}

function createUniverse({ target, outputRoot, records, lockedPaths }) {
  const formulae = new Map(records.map((record) => [record.name, record]))
  const pathTypes = new Map([
    [outputRoot, 'directory'],
    [join(outputRoot, 'Cellar'), 'directory'],
    ...records.map((record) => [record.root, 'directory']),
    ...lockedPaths.map((path) => [path, 'file']),
  ])
  for (const record of records) {
    for (const path of record.files.values()) {
      let directory = dirname(path)
      while (isPathInsideRoot(record.root, directory) && directory !== record.root) {
        pathTypes.set(directory, 'directory')
        directory = dirname(directory)
      }
    }
  }
  function currentPathIsSafe(path, expectedType) {
    try {
      const metadata = lstatSync(path)
      if (metadata.isSymbolicLink()) return false
      if (expectedType === 'file' ? !metadata.isFile() : !metadata.isDirectory()) return false
      if (expectedType === 'file' && metadata.nlink !== 1) return false
      const resolved = realpathSync(path)
      return resolved === path && isPathInsideRoot(outputRoot, resolved)
    } catch {
      return false
    }
  }
  function requireCurrentPath(path, expectedType) {
    if (!currentPathIsSafe(path, expectedType)) fail('Bottle universe path is no longer safe.')
    return path
  }
  return Object.freeze({
    target,
    cellar(formula, version) {
      const record = formulae.get(formula)
      if (!record || record.version !== version) fail('Bottle universe formula is not locked.')
      return requireCurrentPath(record.root, 'directory')
    },
    opt(formula) {
      const record = formulae.get(formula)
      if (!record) fail('Bottle universe formula is not locked.')
      return requireCurrentPath(record.root, 'directory')
    },
    resolveLockedFile(formula, sourcePath) {
      const record = formulae.get(formula)
      const path = record?.files.get(sourcePath)
      if (!path) fail('Bottle universe file is not locked.')
      return requireCurrentPath(path, 'file')
    },
    contains(path) {
      const expectedType = typeof path === 'string' ? pathTypes.get(path) : undefined
      return expectedType !== undefined && currentPathIsSafe(path, expectedType)
    },
  })
}

export async function materializeBottleUniverse({ target, closureLock, formulae, blobs, outputRoot }) {
  if (!targets.has(target) || closureLock?.target !== target || !Array.isArray(closureLock.formulae) || !Array.isArray(formulae) || !(blobs instanceof Map)) invalid()
  requireAbsolutePath(outputRoot, 'Bottle universe root')
  const parent = dirname(outputRoot)
  await requireDirectory(parent, 'Bottle universe parent')
  if (await lstat(outputRoot).catch(() => undefined)) invalid()

  const selected = selectedInventory(closureLock)
  const sourceFormulae = new Map(formulae.map((formula) => [formula?.name, formula]))
  if (sourceFormulae.size !== formulae.length) invalid()
  const closureNames = new Set()
  const records = []
  const claim = await acquireDestinationClaim(outputRoot)
  let privateRoot
  let published = false
  try {
    if (await lstat(outputRoot).catch(() => undefined)) invalid()
    privateRoot = await createPrivateDirectory(parent, '.bottle-universe-')
    const cellarRoot = join(privateRoot, 'Cellar')
    await mkdir(cellarRoot, { mode: 0o755 })
    await requireDirectory(cellarRoot, 'Bottle universe Cellar')
    for (const closureFormula of closureLock.formulae) {
      if (!validFormula(closureFormula?.name) || !validVersion(closureFormula?.version) || closureNames.has(closureFormula.name)) invalid()
      closureNames.add(closureFormula.name)
      const formula = sourceFormulae.get(closureFormula.name)
      if (!formula || formula.version !== closureFormula.version || formula.acquisition === null) invalid()
      validateCoordinate(formula)
      const blob = blobs.get(formula.acquisition.sha256)
      if (
        !blob
        || blob.sha256 !== formula.acquisition.sha256
        || blob.bytes !== formula.acquisition.bytes
        || typeof blob.path !== 'string'
      ) invalid()
      const entries = [...selected.entries()]
        .filter(([key]) => key.startsWith(`${formula.name}\0`))
        .map(([, entry]) => entry)
      if (entries.length === 0) invalid()
      const formulaParent = join(cellarRoot, formula.name)
      await mkdir(formulaParent, { mode: 0o755 })
      await requireDirectory(formulaParent, 'Bottle formula directory')
      const destination = join(formulaParent, formula.version)
      const extracted = await extractVerifiedBottle({ archive: blob.path, coordinate: formula, selectedEntries: entries, destination })
      records.push({
        name: formula.name,
        version: formula.version,
        privateRoot: destination,
        files: new Map(extracted.map((entry) => [entry.sourcePath, entry.path])),
      })
    }
    if ([...selected.keys()].some((key) => !closureNames.has(key.slice(0, key.indexOf('\0'))))) invalid()
    await verifyDestinationClaim(claim)
    await requireDirectory(parent, 'Bottle universe parent')
    await requireDirectory(privateRoot, 'Bottle private universe root')
    if (await lstat(outputRoot).catch(() => undefined)) invalid()
    await rename(privateRoot, outputRoot)
    await syncDirectory(parent)
    published = true
  } finally {
    if (!published && privateRoot !== undefined) await rm(privateRoot, { recursive: true, force: true })
    await releaseDestinationClaim(claim)
  }

  const publishedRecords = records.map((record) => {
    const root = join(outputRoot, 'Cellar', record.name, record.version)
    return {
      name: record.name,
      version: record.version,
      root,
      files: new Map([...record.files.keys()].map((sourcePath) => [sourcePath, join(root, ...sourcePath.split('/'))])),
    }
  })
  const lockedPaths = publishedRecords.flatMap((record) => [...record.files.values()])
  return createUniverse({ target, outputRoot, records: publishedRecords, lockedPaths })
}
