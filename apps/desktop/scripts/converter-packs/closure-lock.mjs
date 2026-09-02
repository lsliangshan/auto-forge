import { Buffer } from 'node:buffer'
import { dirname, posix, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL, URL } from 'node:url'
import {
  canonicalBytes,
  compareUtf8,
  fail,
  PACK_NAMES,
  parseArguments,
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
const versionSegmentPattern = /^[A-Za-z0-9._+-]+$/u
const reservedWindowsName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu
const maximumClosureLockBytes = 64 * 1024 * 1024
const maximumDownloadBytes = 1_800_000_000
const defaultSourceLockPath = fileURLToPath(new URL('../../converter-packs/sources.lock.json', import.meta.url))

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
    && !value.includes(String.fromCharCode(0))
}

function validFormulaName(value) {
  return validText(value, 128) && formulaNamePattern.test(value)
}

function validVersionSegment(value) {
  return validText(value, 128)
    && value.normalize('NFC') === value
    && value !== '.'
    && value !== '..'
    && versionSegmentPattern.test(value)
    && !value.endsWith('.')
    && !reservedWindowsName.test(value)
}

function validHttpsUrl(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || Buffer.byteLength(value, 'utf8') > 2_048
    || [...value].some((character) => {
      const code = character.codePointAt(0)
      return code <= 0x20 || code === 0x7f
    })
    || /\s/u.test(value)
    || value.includes('\\')
  ) return false
  try {
    const url = new URL(value)
    return url.href === value
      && url.protocol === 'https:'
      && Boolean(url.hostname)
      && !url.username
      && !url.password
      && !value.includes('#')
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
    && validVersionSegment(value.version)
    && Array.isArray(value.dependencies)
    && value.dependencies.every(validFormulaName)
    && sortedUnique(value.dependencies, (dependency) => dependency)
}

function validFile(value, formulae) {
  return exactKeys(value, ['formula', 'sourcePath', 'destination', 'sha256', 'bytes', 'executable', 'role', 'runtimeRoot'])
    && formulae.has(value.formula)
    && safeEntryPath(value.sourcePath)
    && safeEntryPath(value.destination)
    && sha256Pattern.test(value.sha256)
    && positiveInteger(value.bytes)
    && typeof value.executable === 'boolean'
    && typeof value.runtimeRoot === 'boolean'
    && roles.has(value.role)
    && (value.role === 'executable' ? value.executable : !value.executable)
    && (value.role === 'code' ? true : !value.runtimeRoot)
}

function validNativeHelper(value) {
  return exactKeys(value, ['helper', 'destination'])
    && validFormulaName(value.helper)
    && safeEntryPath(value.destination)
}

function validEngineAsset(value) {
  return exactKeys(value, ['engine', 'source', 'destination', 'sha256', 'bytes', 'executable', 'role'])
    && validFormulaName(value.engine)
    && value.source === 'acquisition'
    && safeEntryPath(value.destination)
    && sha256Pattern.test(value.sha256)
    && positiveInteger(value.bytes)
    && value.executable === false
    && value.role === 'data'
}

function validEngineLicense(value) {
  return exactKeys(value, ['engine', 'source', 'destination', 'sha256', 'bytes'])
    && validFormulaName(value.engine)
    && validHttpsUrl(value.source)
    && safeEntryPath(value.destination)
    && sha256Pattern.test(value.sha256)
    && positiveInteger(value.bytes)
}

function validLicense(value, formulae) {
  return exactKeys(value, ['formula', 'source', 'destination', 'sha256', 'bytes'])
    && formulae.has(value.formula)
    && (safeEntryPath(value.source) || validHttpsUrl(value.source))
    && safeEntryPath(value.destination)
    && sha256Pattern.test(value.sha256)
    && positiveInteger(value.bytes)
}

function rewriteDestination(destination, replacement) {
  if (!validText(replacement) || !replacement.startsWith('@loader_path/')) return undefined
  const suffix = replacement.slice('@loader_path/'.length)
  if (suffix.length === 0 || suffix.includes('\\') || suffix.includes('\0') || posix.isAbsolute(suffix)) return undefined
  const resolved = posix.normalize(posix.join(posix.dirname(destination), suffix))
  return safeEntryPath(resolved) ? resolved : undefined
}

function validRewrite(value, files) {
  return exactKeys(value, ['destination', 'dependency', 'replacement'])
    && safeEntryPath(value.destination)
    && files.has(value.destination)
    && validText(value.dependency)
    && files.has(rewriteDestination(value.destination, value.replacement))
}

function validateFamily(value, formulae) {
  if (
    !exactKeys(value, ['files', 'rewrites', 'licenses', 'nativeHelpers', 'engineAssets', 'engineLicenses'])
    || !Array.isArray(value.files)
    || !Array.isArray(value.rewrites)
    || !Array.isArray(value.licenses)
    || !Array.isArray(value.nativeHelpers)
    || !Array.isArray(value.engineAssets)
    || !Array.isArray(value.engineLicenses)
    || !value.files.every((file) => validFile(file, formulae))
    || !value.licenses.every((license) => validLicense(license, formulae))
    || !value.nativeHelpers.every(validNativeHelper)
    || !value.engineAssets.every(validEngineAsset)
    || !value.engineLicenses.every(validEngineLicense)
    || !sortedUnique(value.files, (file) => `${file.destination}\0${file.formula}\0${file.sourcePath}`)
    || !sortedUnique(value.licenses, (license) => `${license.destination}\0${license.formula}\0${license.source}`)
    || !sortedUnique(value.nativeHelpers, (helper) => `${helper.destination}\0${helper.helper}`)
    || !sortedUnique(value.engineAssets, (asset) => `${asset.destination}\0${asset.engine}`)
    || !sortedUnique(value.engineLicenses, (license) => `${license.destination}\0${license.engine}\0${license.source}`)
  ) return false

  const destinations = new Set()
  for (const entry of [
    ...value.files, ...value.licenses, ...value.nativeHelpers, ...value.engineAssets, ...value.engineLicenses,
  ]) {
    const destination = entry.destination.toLocaleLowerCase('en-US')
    if (destinations.has(destination)) return false
    destinations.add(destination)
  }

  const files = new Set(value.files.map((file) => file.destination))
  const rewritePairs = new Set()
  for (const rewrite of value.rewrites) {
    if (!validRewrite(rewrite, files)) return false
    const pair = `${rewrite.destination}\0${rewrite.dependency}`
    if (rewritePairs.has(pair)) return false
    rewritePairs.add(pair)
  }
  return sortedUnique(value.rewrites, (rewrite) => `${rewrite.destination}\0${rewrite.dependency}\0${rewrite.replacement}`)
}

function validateDependencyGraph(formulae) {
  const state = new Map()
  for (const start of formulae.keys()) {
    if (state.get(start) === 'done') continue
    state.set(start, 'visiting')
    const stack = [{ name: start, dependencyIndex: 0 }]
    while (stack.length > 0) {
      const frame = stack.at(-1)
      const dependencies = formulae.get(frame.name).dependencies
      if (frame.dependencyIndex >= dependencies.length) {
        state.set(frame.name, 'done')
        stack.pop()
        continue
      }
      const dependency = dependencies[frame.dependencyIndex]
      frame.dependencyIndex += 1
      if (state.get(dependency) === 'visiting') fail('Converter formula dependency graph contains a cycle.')
      if (state.get(dependency) === 'done') continue
      state.set(dependency, 'visiting')
      stack.push({ name: dependency, dependencyIndex: 0 })
    }
  }
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
    || value.measurements.downloadBytes > maximumDownloadBytes
    || !exactKeys(value.measurements.compressedPackBytes, PACK_NAMES)
    || !PACK_NAMES.every((family) => positiveInteger(value.measurements.compressedPackBytes[family]))
    || !positiveInteger(value.measurements.installedReleaseBytes)
  ) fail('Target closure lock has an invalid schema.')

  return deepFreeze(globalThis.structuredClone(value))
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

  const reachable = new Set()
  const seeds = new Set(sourceLock.engines.flatMap((engine) => engine.rootFormula === null ? [] : [engine.rootFormula]))
  for (const family of Object.values(closureLock.families)) {
    for (const file of family.files) seeds.add(file.formula)
  }
  const closureFormulae = new Map(closureLock.formulae.map((formula) => [formula.name, formula]))
  const pending = [...seeds]
  while (pending.length > 0) {
    const name = pending.pop()
    if (reachable.has(name)) continue
    const formula = closureFormulae.get(name)
    if (!formula) fail('Target closure lock references an undeclared formula.')
    reachable.add(name)
    for (const dependency of formula.dependencies) pending.push(dependency)
  }
  if (reachable.size !== closureFormulae.size) fail('Target closure lock contains an unreachable formula.')

  const sourceLicenseTuples = new Map(sourceLock.formulae.map((formula) => [
    formula.name,
    new Set(formula.licenses.map((asset) => canonicalBytes({
      formula: formula.name,
      source: asset.kind === 'bottle-entry' ? asset.path : asset.url,
      destination: asset.destination,
      sha256: asset.sha256,
      bytes: asset.bytes,
    }).toString('utf8'))),
  ]))
  const sourceEngines = new Map(sourceLock.engines.map((engine) => [engine.name, engine]))
  const sourceEngineLicenseTuples = new Map(sourceLock.engines.map((engine) => [
    engine.name,
    new Set(engine.licenses.map((asset) => canonicalBytes({
      engine: engine.name,
      source: asset.url,
      destination: asset.destination,
      sha256: asset.sha256,
      bytes: asset.bytes,
    }).toString('utf8'))),
  ]))
  for (const family of Object.values(closureLock.families)) {
    const contributed = new Set(family.files.map((file) => file.formula))
    const licensed = new Set()
    for (const license of family.licenses) {
      const tuple = canonicalBytes(license).toString('utf8')
      if (!sourceLicenseTuples.get(license.formula)?.has(tuple)) {
        fail('Target closure lock license inventory is inconsistent.')
      }
      licensed.add(license.formula)
    }
    if (
      licensed.size !== contributed.size
      || [...contributed].some((formula) => !licensed.has(formula))
    ) {
      fail('Target closure lock license inventory is inconsistent.')
    }

    const contributedEngines = new Set()
    for (const asset of family.engineAssets) {
      const engine = sourceEngines.get(asset.engine)
      if (
        !engine
        || asset.source !== 'acquisition'
        || asset.sha256 !== engine.acquisition.sha256
        || asset.bytes !== engine.acquisition.bytes
      ) fail('Target closure lock engine inventory is inconsistent.')
      contributedEngines.add(asset.engine)
    }
    const licensedEngines = new Set()
    for (const license of family.engineLicenses) {
      const tuple = canonicalBytes(license).toString('utf8')
      if (!sourceEngineLicenseTuples.get(license.engine)?.has(tuple)) {
        fail('Target closure lock engine license inventory is inconsistent.')
      }
      licensedEngines.add(license.engine)
    }
    if (
      licensedEngines.size !== contributedEngines.size
      || [...contributedEngines].some((engine) => !licensedEngines.has(engine))
    ) fail('Target closure lock engine license inventory is inconsistent.')
  }

  const coordinates = new Map()
  function add(coordinate) {
    const previous = coordinates.get(coordinate.sha256)
    if (previous && (previous.url !== coordinate.url || previous.bytes !== coordinate.bytes)) {
      fail('Selected network artifacts conflict for one SHA-256.')
    }
    coordinates.set(coordinate.sha256, { url: coordinate.url, bytes: coordinate.bytes })
  }
  for (const engine of sourceLock.engines) {
    add(engine.acquisition)
    for (const license of engine.licenses) add(license)
  }
  for (const closureFormula of closureLock.formulae) {
    const formula = selectedFormulae.get(closureFormula.name)
    if (formula.acquisition !== null) add(formula.acquisition)
    for (const license of formula.licenses) {
      if (license.kind === 'download') add(license)
    }
  }
  const downloadBytes = [...coordinates.values()].reduce((sum, coordinate) => sum + coordinate.bytes, 0)
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

export async function loadConverterSourceLockMain(argv, {
  stdout = process.stdout,
  stderr = process.stderr,
  load = loadConverterClosureLock,
  defaultLockPath = defaultSourceLockPath,
} = {}) {
  const defaultMode = argv.length === 0
  try {
    if (defaultMode) {
      for (const target of targets) await load({ sourceLockPath: defaultLockPath, target })
      stdout.write('verified converter source locks for darwin-arm64 and darwin-x64\n')
      return 0
    }
    const args = parseArguments(argv, ['--lock', '--target'])
    if (typeof args['--lock'] !== 'string' || typeof args['--target'] !== 'string') fail('Source lock arguments are incomplete.')
    await load({ sourceLockPath: args['--lock'], target: args['--target'] })
    stdout.write(`verified converter source lock for ${args['--target']}\n`)
    return 0
  } catch {
    stderr.write(defaultMode
      ? 'checked-in converter schema-v2 locks are not ready\n'
      : 'converter source lock verification failed\n')
    return 1
  }
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await loadConverterSourceLockMain(process.argv.slice(2))
}
