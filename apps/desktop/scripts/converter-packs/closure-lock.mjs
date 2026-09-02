import { Buffer } from 'node:buffer'
import { dirname, posix, resolve } from 'node:path'
import { URL } from 'node:url'
import {
  canonicalBytes,
  compareUtf8,
  fail,
  PACK_NAMES,
  readStableRegularFile,
  requireAbsolutePath,
  safeEntryPath,
  sha256,
} from './pack-tooling-lib.mjs'
import { loadConverterSourceLock } from './source-lock.mjs'

const targets = Object.freeze(['darwin-arm64', 'darwin-x64'])
const roles = new Set(['executable', 'code', 'data'])
const sha256Pattern = /^[a-f0-9]{64}$/u
const formulaNamePattern = /^[a-z0-9][a-z0-9+_.@-]*$/u
const maximumClosureLockBytes = 64 * 1024 * 1024

function plainRecord(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value, expected) {
  if (!plainRecord(value)) return false
  const actual = Object.keys(value).sort(compareUtf8)
  const wanted = [...expected].sort(compareUtf8)
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

function validText(value, maximumBytes = 4_096) {
  return typeof value === 'string'
    && value.length > 0
    && value === value.trim()
    && Buffer.byteLength(value, 'utf8') <= maximumBytes
    && !value.includes('\0')
}

function validFormulaName(value) {
  return validText(value, 128) && formulaNamePattern.test(value)
}

function validHttpsUrl(value) {
  if (!validText(value, 2_048)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password && !url.hash
  } catch {
    return false
  }
}

function sortedUnique(values, key) {
  let previous
  for (const value of values) {
    const current = key(value)
    if (previous !== undefined && compareUtf8(previous, current) >= 0) return false
    previous = current
  }
  return true
}

function validFormula(value) {
  return exactKeys(value, ['name', 'version', 'dependencies'])
    && validFormulaName(value.name)
    && validText(value.version, 128)
    && Array.isArray(value.dependencies)
    && value.dependencies.every(validFormulaName)
    && sortedUnique(value.dependencies, (dependency) => dependency)
}

function validFile(value, formulae) {
  return exactKeys(value, ['formula', 'sourcePath', 'destination', 'sha256', 'bytes', 'executable', 'role'])
    && formulae.has(value.formula)
    && safeEntryPath(value.sourcePath)
    && safeEntryPath(value.destination)
    && sha256Pattern.test(value.sha256)
    && positiveInteger(value.bytes)
    && typeof value.executable === 'boolean'
    && roles.has(value.role)
    && (value.role === 'executable' ? value.executable : !value.executable)
}

function validLicense(value, formulae) {
  return exactKeys(value, ['formula', 'source', 'destination', 'sha256', 'bytes'])
    && formulae.has(value.formula)
    && (safeEntryPath(value.source) || validHttpsUrl(value.source))
    && safeEntryPath(value.destination)
    && sha256Pattern.test(value.sha256)
    && positiveInteger(value.bytes)
}

function rewriteReplacement(destination, replacement) {
  if (!validText(replacement) || !replacement.startsWith('@loader_path/')) return false
  const suffix = replacement.slice('@loader_path/'.length)
  if (suffix.length === 0 || suffix.includes('\\') || suffix.includes('\0') || posix.isAbsolute(suffix)) return false
  const resolved = posix.normalize(posix.join(posix.dirname(destination), suffix))
  return safeEntryPath(resolved)
}

function validRewrite(value, files) {
  return exactKeys(value, ['destination', 'dependency', 'replacement'])
    && safeEntryPath(value.destination)
    && files.has(value.destination)
    && validText(value.dependency)
    && rewriteReplacement(value.destination, value.replacement)
}

function validateFamily(value, formulae) {
  if (
    !exactKeys(value, ['files', 'rewrites', 'licenses'])
    || !Array.isArray(value.files)
    || !Array.isArray(value.rewrites)
    || !Array.isArray(value.licenses)
    || !value.files.every((file) => validFile(file, formulae))
    || !value.licenses.every((license) => validLicense(license, formulae))
    || !sortedUnique(value.files, (file) => `${file.destination}\0${file.formula}\0${file.sourcePath}`)
    || !sortedUnique(value.licenses, (license) => `${license.destination}\0${license.formula}\0${license.source}`)
  ) return false

  const destinations = new Set()
  for (const entry of [...value.files, ...value.licenses]) {
    const destination = entry.destination.toLocaleLowerCase('en-US')
    if (destinations.has(destination)) return false
    destinations.add(destination)
  }

  const files = new Set(value.files.map((file) => file.destination))
  return value.rewrites.every((rewrite) => validRewrite(rewrite, files))
    && sortedUnique(value.rewrites, (rewrite) => `${rewrite.destination}\0${rewrite.dependency}\0${rewrite.replacement}`)
}

function validateDependencyGraph(formulae) {
  const state = new Map()
  function visit(name) {
    if (state.get(name) === 'visiting') fail('Converter formula dependency graph contains a cycle.')
    if (state.get(name) === 'done') return
    state.set(name, 'visiting')
    for (const dependency of formulae.get(name).dependencies) visit(dependency)
    state.set(name, 'done')
  }
  for (const name of formulae.keys()) visit(name)
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

export function validateTargetClosureLock(value, target) {
  if (
    !targets.includes(target)
    || !exactKeys(value, ['schemaVersion', 'target', 'formulae', 'families', 'measurements'])
    || value.schemaVersion !== 1
    || value.target !== target
    || !Array.isArray(value.formulae)
    || value.formulae.length === 0
    || !value.formulae.every(validFormula)
    || !sortedUnique(value.formulae, (formula) => formula.name)
  ) fail('Target closure lock has an invalid schema.')

  const formulae = new Map(value.formulae.map((formula) => [formula.name, formula]))
  for (const formula of value.formulae) {
    if (formula.dependencies.some((dependency) => !formulae.has(dependency))) {
      fail('Target closure lock has an invalid schema.')
    }
  }
  try {
    validateDependencyGraph(formulae)
  } catch (error) {
    if (error instanceof Error && error.message === 'Converter formula dependency graph contains a cycle.') throw error
    fail('Target closure lock has an invalid schema.')
  }

  if (
    !exactKeys(value.families, PACK_NAMES)
    || !PACK_NAMES.every((family) => validateFamily(value.families[family], formulae))
    || !exactKeys(value.measurements, ['downloadBytes', 'compressedPackBytes', 'installedReleaseBytes'])
    || !positiveInteger(value.measurements.downloadBytes)
    || !exactKeys(value.measurements.compressedPackBytes, PACK_NAMES)
    || !PACK_NAMES.every((family) => positiveInteger(value.measurements.compressedPackBytes[family]))
    || !positiveInteger(value.measurements.installedReleaseBytes)
  ) fail('Target closure lock has an invalid schema.')

  return deepFreeze(structuredClone(value))
}

function validateSourceRelationship(sourceLock, closureLock) {
  const selectedFormulae = new Map(sourceLock.formulae.map((formula) => [formula.name, formula]))
  for (const formula of closureLock.formulae) {
    const selected = selectedFormulae.get(formula.name)
    if (!selected || selected.version !== formula.version || selected.acquisition === null) {
      fail('Target closure lock references an undeclared formula.')
    }
  }
  for (const engine of sourceLock.engines) {
    if (engine.rootFormula !== null && !closureLock.formulae.some((formula) => formula.name === engine.rootFormula)) {
      fail('Target closure lock omits a root engine formula.')
    }
  }

  const coordinates = new Map()
  function add(coordinate) {
    const identity = `${coordinate.url}\0${coordinate.sha256}\0${coordinate.bytes}`
    coordinates.set(identity, coordinate.bytes)
  }
  for (const engine of sourceLock.engines) add(engine.acquisition)
  for (const formula of closureLock.formulae) {
    const selected = selectedFormulae.get(formula.name)
    add(selected.acquisition)
    for (const license of selected.licenses) {
      if (license.kind === 'download') add(license)
    }
  }
  const downloadBytes = [...coordinates.values()].reduce((sum, bytes) => sum + bytes, 0)
  if (downloadBytes !== closureLock.measurements.downloadBytes) {
    fail('Target closure lock download measurement is inconsistent.')
  }
}

export async function loadConverterClosureLock({ sourceLockPath, target }) {
  requireAbsolutePath(sourceLockPath, 'Source lock path')
  const sourceLock = await loadConverterSourceLock({ path: sourceLockPath, target })
  const closurePath = resolve(dirname(sourceLockPath), sourceLock.closureLock.path)
  const bytes = await readStableRegularFile(closurePath, 'Target closure lock', maximumClosureLockBytes)
  if (bytes.byteLength !== sourceLock.closureLock.bytes) {
    fail('Target closure lock byte length does not match its source lock.')
  }
  if (sha256(bytes) !== sourceLock.closureLock.sha256) {
    fail('Target closure lock hash does not match its source lock.')
  }

  let value
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    fail('Target closure lock is not valid JSON.')
  }
  if (!bytes.equals(canonicalBytes(value))) fail('Target closure lock is not canonical JSON.')
  const closureLock = validateTargetClosureLock(value, target)
  validateSourceRelationship(sourceLock, closureLock)
  return deepFreeze({ sourceLock, closureLock, target })
}
