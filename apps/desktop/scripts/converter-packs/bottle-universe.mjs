import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  fail,
  isPathInsideRoot,
  PACK_NAMES,
  requireAbsolutePath,
  requireDirectory,
  safeEntryPath,
} from './pack-tooling-lib.mjs'
import { readVerifiedBottleEntries } from './bottle-archive.mjs'

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

function lockedBottleMode(entry) {
  return entry.executable ? 0o555 : 0o444
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
  const visiting = new Set()
  const done = new Set()
  function visit(path) {
    if (done.has(path)) return
    if (visiting.has(path)) invalid()
    visiting.add(path)
    const entry = byPath.get(path)
    if (entry?.type === 'symlink') visit(entry.linkTarget)
    visiting.delete(path)
    done.add(path)
  }
  for (const entry of entries) {
    if (entry.type === 'symlink') visit(entry.path)
  }
  return byPath
}

function verifiedBytes(entry, selected, selectedByArchivePath, archiveByPath) {
  if (entry.type === 'file') {
    if (entry.mode !== lockedBottleMode(selected)) invalid()
    if (entry.bytes.byteLength !== selected.bytes) invalid()
    if (createHash('sha256').update(entry.bytes).digest('hex') !== selected.sha256) invalid()
    return entry.bytes
  }
  if (entry.type !== 'symlink') invalid()
  const targetSelected = selectedByArchivePath.get(entry.linkTarget)
  const target = archiveByPath.get(entry.linkTarget)
  if (!targetSelected || target?.type !== 'file') invalid()
  const bytes = verifiedBytes(target, targetSelected, selectedByArchivePath, archiveByPath)
  if (
    targetSelected.sha256 !== selected.sha256
    || targetSelected.bytes !== selected.bytes
    || bytes.byteLength !== selected.bytes
    || createHash('sha256').update(bytes).digest('hex') !== selected.sha256
  ) invalid()
  return bytes
}

async function createOutputFile(root, relativePath, bytes, mode) {
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
  try {
    await handle.writeFile(bytes)
    await handle.chmod(mode)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function createPrivateDirectory(parent, prefix) {
  const root = await realpath(await mkdtemp(join(parent, prefix)))
  if (!isPathInsideRoot(parent, root)) {
    await rm(root, { recursive: true, force: true })
    invalid()
  }
  return root
}

export async function extractVerifiedBottle({ archive, coordinate, selectedEntries, destination }) {
  validateCoordinate(coordinate)
  requireAbsolutePath(destination, 'Bottle extraction destination')
  const parent = dirname(destination)
  await requireDirectory(parent, 'Bottle extraction parent')
  if (await lstat(destination).catch(() => undefined)) invalid()
  const selected = expectedEntries(selectedEntries)
  const acquisition = coordinate.acquisition
  const archiveEntries = await readVerifiedBottleEntries({
    archive,
    expectedBytes: acquisition.bytes,
    expectedSha256: acquisition.sha256,
  })
  const rootPrefix = `${coordinate.name}/${coordinate.version}/`
  const archiveByPath = verifyArchiveLinks(archiveEntries, rootPrefix)
  const selectedByArchivePath = new Map(selected.map((entry) => [`${rootPrefix}${entry.sourcePath}`, entry]))
  const materialized = selected.map((entry) => {
    const archivePath = `${rootPrefix}${entry.sourcePath}`
    const archiveEntry = archiveByPath.get(archivePath)
    if (!archiveEntry) invalid()
    return { entry, bytes: verifiedBytes(archiveEntry, entry, selectedByArchivePath, archiveByPath) }
  })

  const privateRoot = await createPrivateDirectory(parent, '.bottle-extract-')
  try {
    for (const item of materialized) {
      await createOutputFile(privateRoot, item.entry.sourcePath, item.bytes, regularMode(item.entry))
    }
    await requireDirectory(parent, 'Bottle extraction parent')
    await requireDirectory(privateRoot, 'Bottle private extraction root')
    if (await lstat(destination).catch(() => undefined)) invalid()
    await rename(privateRoot, destination)
  } catch (error) {
    await rm(privateRoot, { recursive: true, force: true })
    throw error
  }
  return Object.freeze(materialized.map(({ entry }) => Object.freeze({
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
  const roots = new Set([outputRoot, join(outputRoot, 'Cellar'), ...records.map((record) => record.root)])
  const allPaths = new Set([...roots, ...lockedPaths])
  return Object.freeze({
    target,
    cellar(formula, version) {
      const record = formulae.get(formula)
      if (!record || record.version !== version) fail('Bottle universe formula is not locked.')
      return record.root
    },
    opt(formula) {
      const record = formulae.get(formula)
      if (!record) fail('Bottle universe formula is not locked.')
      return record.root
    },
    resolveLockedFile(formula, sourcePath) {
      const record = formulae.get(formula)
      const path = record?.files.get(sourcePath)
      if (!path) fail('Bottle universe file is not locked.')
      return path
    },
    contains(path) {
      return typeof path === 'string'
        && isPathInsideRoot(outputRoot, path)
        && allPaths.has(path)
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
  const privateRoot = await createPrivateDirectory(parent, '.bottle-universe-')
  try {
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
    await requireDirectory(parent, 'Bottle universe parent')
    await requireDirectory(privateRoot, 'Bottle private universe root')
    if (await lstat(outputRoot).catch(() => undefined)) invalid()
    await rename(privateRoot, outputRoot)
  } catch (error) {
    await rm(privateRoot, { recursive: true, force: true })
    throw error
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
