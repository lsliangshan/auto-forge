import { Buffer } from 'node:buffer'
import { URL } from 'node:url'
import {
  canonicalBytes,
  compareUtf8,
  fail,
  readStableRegularFile,
  requireAbsolutePath,
  safeEntryPath,
} from './pack-tooling-lib.mjs'

const targets = Object.freeze(['darwin-arm64', 'darwin-x64'])
const engineNames = Object.freeze(['ffmpeg', 'libreoffice', 'libvips', 'poppler'])
const sha256Pattern = /^[a-f0-9]{64}$/u
const gitRevisionPattern = /^[a-f0-9]{40}$/u
const formulaNamePattern = /^[a-z0-9][a-z0-9+_.@-]*$/u
const versionSegmentPattern = /^[A-Za-z0-9._+-]+$/u
const reservedWindowsName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu
const maximumSourceLockBytes = 8 * 1024 * 1024
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

function positiveInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum
}

function validHttpsUrl(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 2_048
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

function validText(value, maximumBytes = 256) {
  return typeof value === 'string'
    && value.length > 0
    && value === value.trim()
    && Buffer.byteLength(value, 'utf8') <= maximumBytes
    && !value.includes(String.fromCharCode(0))
}

function validName(value) {
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

function validCoordinate(value, target, expectedKind) {
  if (!exactKeys(value, ['kind', 'url', 'sha256', 'bytes', 'cellar'])) return false
  if (
    value.kind !== expectedKind
    || !validHttpsUrl(value.url)
    || !sha256Pattern.test(value.sha256)
    || !positiveInteger(value.bytes)
  ) return false
  if (expectedKind === 'dmg') return value.cellar === null
  const expectedCellar = target === 'darwin-arm64' ? '/opt/homebrew/Cellar' : '/usr/local/Cellar'
  return value.cellar === expectedCellar
}

function validAcquisitions(value, expectedKind, nullable = false) {
  return exactKeys(value, targets) && targets.every((target) => (
    nullable && value[target] === null
      ? true
      : validCoordinate(value[target], target, expectedKind)
  ))
}

function licenseSortKey(value) {
  if (!plainRecord(value)) return ''
  return value.kind === 'bottle-entry'
    ? `bottle-entry\0${value.target ?? ''}\0${value.destination ?? ''}\0${value.path ?? ''}`
    : `download\0${value.destination ?? ''}\0${value.url ?? ''}`
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

function validLicense(value) {
  if (value?.kind === 'bottle-entry') {
    return exactKeys(value, ['kind', 'target', 'path', 'sha256', 'bytes', 'destination'])
      && targets.includes(value.target)
      && safeEntryPath(value.path)
      && sha256Pattern.test(value.sha256)
      && positiveInteger(value.bytes)
      && safeEntryPath(value.destination)
  }
  if (value?.kind === 'download') {
    return exactKeys(value, ['kind', 'url', 'sha256', 'bytes', 'destination'])
      && validHttpsUrl(value.url)
      && sha256Pattern.test(value.sha256)
      && positiveInteger(value.bytes)
      && safeEntryPath(value.destination)
  }
  return false
}

function validEngineLicense(value) {
  return value?.kind === 'download'
    && exactKeys(value, ['kind', 'url', 'sha256', 'bytes', 'destination'])
    && validHttpsUrl(value.url)
    && sha256Pattern.test(value.sha256)
    && positiveInteger(value.bytes)
    && safeEntryPath(value.destination)
}

function validFormula(value) {
  if (!exactKeys(value, ['name', 'version', 'revision', 'license', 'acquisitions', 'licenses'])) return false
  if (
    !validName(value.name)
    || !validVersionSegment(value.version)
    || !Number.isSafeInteger(value.revision)
    || value.revision < 0
    || !validText(value.license, 512)
    || !validAcquisitions(value.acquisitions, 'homebrew-bottle', true)
    || !Array.isArray(value.licenses)
    || value.licenses.length === 0
    || !value.licenses.every(validLicense)
    || !sortedUnique(value.licenses, licenseSortKey)
  ) return false

  const destinations = Object.fromEntries(targets.map((target) => [target, new Set()]))
  for (const license of value.licenses) {
    const selectedTargets = license.kind === 'download' ? targets : [license.target]
    for (const target of selectedTargets) {
      if (license.kind === 'bottle-entry' && value.acquisitions[target] === null) return false
      const destination = license.destination.toLocaleLowerCase('en-US')
      if (destinations[target].has(destination)) return false
      destinations[target].add(destination)
    }
  }
  return true
}

function validEngine(value, expectedName, formulae) {
  if (!exactKeys(value, ['name', 'version', 'license', 'rootFormula', 'acquisitions', 'licenses'])) return false
  if (
    value.name !== expectedName
    || !validVersionSegment(value.version)
    || !validText(value.license, 512)
    || !Array.isArray(value.licenses)
    || !value.licenses.every(validEngineLicense)
    || !sortedUnique(value.licenses, licenseSortKey)
  ) return false
  const licenseDestinations = new Set(value.licenses.map((license) => license.destination.toLocaleLowerCase('en-US')))
  if (licenseDestinations.size !== value.licenses.length) return false
  if (expectedName === 'libreoffice') {
    return value.rootFormula === null && value.licenses.length > 0 && validAcquisitions(value.acquisitions, 'dmg')
  }
  if (value.licenses.length !== 0 || !validName(value.rootFormula) || !validAcquisitions(value.acquisitions, 'homebrew-bottle')) return false
  const formula = formulae.get(value.rootFormula)
  return formula !== undefined
    && formula.version === value.version
    && targets.every((target) => (
      formula.acquisitions[target] !== null
      && canonicalBytes(formula.acquisitions[target]).equals(canonicalBytes(value.acquisitions[target]))
    ))
}

function validClosureCoordinate(value) {
  return exactKeys(value, ['path', 'sha256', 'bytes'])
    && safeEntryPath(value.path)
    && sha256Pattern.test(value.sha256)
    && positiveInteger(value.bytes, maximumClosureLockBytes)
}

function validProvenance(value) {
  return exactKeys(value, ['repositoryRevision', 'captures'])
    && gitRevisionPattern.test(value.repositoryRevision)
    && exactKeys(value.captures, targets)
    && targets.every((target) => (
      exactKeys(value.captures[target], ['captureSha256', 'probesSha256'])
      && sha256Pattern.test(value.captures[target].captureSha256)
      && sha256Pattern.test(value.captures[target].probesSha256)
    ))
}

function validateSourceLock(value) {
  if (
    !exactKeys(value, [
      'schemaVersion', 'homebrewCoreRevision', 'homebrewCaskRevision', 'targets', 'engines', 'formulae', 'closureLocks', 'provenance',
    ])
    || value.schemaVersion !== 2
    || !gitRevisionPattern.test(value.homebrewCoreRevision)
    || !gitRevisionPattern.test(value.homebrewCaskRevision)
    || !Array.isArray(value.targets)
    || value.targets.length !== targets.length
    || !value.targets.every((target, index) => target === targets[index])
    || !Array.isArray(value.formulae)
    || value.formulae.length === 0
    || !value.formulae.every(validFormula)
    || !sortedUnique(value.formulae, (formula) => formula.name)
    || !exactKeys(value.closureLocks, targets)
    || !targets.every((target) => validClosureCoordinate(value.closureLocks[target]))
    || !validProvenance(value.provenance)
  ) fail('Source lock has an invalid schema.')

  const formulae = new Map(value.formulae.map((formula) => [formula.name, formula]))
  if (
    !Array.isArray(value.engines)
    || value.engines.length !== engineNames.length
    || !value.engines.every((engine, index) => validEngine(engine, engineNames[index], formulae))
  ) fail('Source lock has an invalid schema.')
  return value
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

export async function loadConverterSourceLock({ path, target }) {
  requireAbsolutePath(path, 'Source lock path')
  const bytes = await readStableRegularFile(path, 'Source lock', maximumSourceLockBytes)
  let value
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    fail('Source lock is not valid JSON.')
  }
  if (!bytes.equals(canonicalBytes(value))) fail('Source lock is not canonical JSON.')
  validateSourceLock(value)
  if (!targets.includes(target)) fail('Source lock target is unsupported.')

  return deepFreeze({
    target,
    homebrewCoreRevision: value.homebrewCoreRevision,
    homebrewCaskRevision: value.homebrewCaskRevision,
    engines: value.engines.map((engine) => ({
      name: engine.name,
      version: engine.version,
      license: engine.license,
      rootFormula: engine.rootFormula,
      acquisition: globalThis.structuredClone(engine.acquisitions[target]),
      licenses: globalThis.structuredClone(engine.licenses),
    })),
    formulae: value.formulae.map((formula) => ({
      name: formula.name,
      version: formula.version,
      revision: formula.revision,
      license: formula.license,
      acquisition: globalThis.structuredClone(formula.acquisitions[target]),
      licenses: globalThis.structuredClone(formula.licenses.filter((license) => (
        license.kind === 'download' || license.target === target
      ))),
    })),
    closureLock: globalThis.structuredClone(value.closureLocks[target]),
  })
}
