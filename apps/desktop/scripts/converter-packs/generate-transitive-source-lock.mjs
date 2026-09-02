import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { pathToFileURL, URL } from 'node:url'
import { loadConverterClosureLock, validateTargetClosureLock } from './closure-lock.mjs'
import {
  canonicalBytes,
  compareUtf8,
  fail,
  parseArguments,
  readStableRegularFile,
  requireAbsolutePath,
  sha256,
} from './pack-tooling-lib.mjs'

const maximumCaptureBytes = 64 * 1024 * 1024
const sha256Pattern = /^[a-f0-9]{64}$/u
const revisionPattern = /^[a-f0-9]{40}$/u
const formulaPattern = /^[a-z0-9][a-z0-9+_.@-]*$/u
const targets = ['darwin-arm64', 'darwin-x64']
const engineNames = ['ffmpeg', 'libreoffice', 'libvips', 'poppler']
const familyNames = ['image-icon', 'document', 'pdf', 'media']

function invalid(message = 'Converter capture fragment is invalid.') {
  fail(message)
}

function plainRecord(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value, keys) {
  return plainRecord(value)
    && Object.keys(value).sort(compareUtf8).join('\0') === [...keys].sort(compareUtf8).join('\0')
}

function hasUrlControlOrSpace(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0)
    return code <= 0x20 || code === 0x7f
  })
}

function validHttpsUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048 || value.includes('\\') || hasUrlControlOrSpace(value)) return false
  try {
    const url = new URL(value)
    return url.href === value && url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password && !url.hash
  } catch {
    return false
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function validCoordinate(value, target, kind) {
  return exactKeys(value, ['kind', 'url', 'sha256', 'bytes', 'cellar'])
    && value.kind === kind
    && validHttpsUrl(value.url)
    && sha256Pattern.test(value.sha256)
    && Number.isSafeInteger(value.bytes)
    && value.bytes > 0
    && (kind === 'dmg'
      ? value.cellar === null
      : value.cellar === (target === 'darwin-arm64' ? '/opt/homebrew/Cellar' : '/usr/local/Cellar'))
}

function validLicense(value, target) {
  if (value?.kind === 'bottle-entry') {
    return exactKeys(value, ['kind', 'target', 'path', 'sha256', 'bytes', 'destination'])
      && value.target === target
      && typeof value.path === 'string'
      && typeof value.destination === 'string'
      && sha256Pattern.test(value.sha256)
      && Number.isSafeInteger(value.bytes)
      && value.bytes > 0
  }
  return value?.kind === 'download'
    && exactKeys(value, ['kind', 'url', 'sha256', 'bytes', 'destination'])
    && validHttpsUrl(value.url)
    && typeof value.destination === 'string'
    && sha256Pattern.test(value.sha256)
    && Number.isSafeInteger(value.bytes)
    && value.bytes > 0
}

function licenseSortKey(value) {
  return value.kind === 'download'
    ? `download\0${value.destination}\0${value.url}`
    : `bottle-entry\0${value.target}\0${value.destination}\0${value.path}`
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

function requireReachable(formulae, roots) {
  const byName = new Map(formulae.map((formula) => [formula.name, formula]))
  const reached = new Set()
  const pending = [...roots]
  while (pending.length > 0) {
    const name = pending.pop()
    if (reached.has(name)) continue
    const formula = byName.get(name)
    if (!formula) invalid('Capture root formula is missing.')
    reached.add(name)
    pending.push(...formula.dependencies)
  }
  if (reached.size !== formulae.length) invalid('Capture contains a formula unreachable from its roots.')
}

function validateFormula(formula, target) {
  if (
    !exactKeys(formula, ['name', 'version', 'revision', 'license', 'dependencies', 'acquisition', 'licenses'])
    || !formulaPattern.test(formula.name)
    || typeof formula.version !== 'string'
    || formula.version.length === 0
    || !Number.isSafeInteger(formula.revision)
    || formula.revision < 0
    || typeof formula.license !== 'string'
    || formula.license.length === 0
    || !Array.isArray(formula.dependencies)
    || formula.dependencies.some((dependency) => !formulaPattern.test(dependency))
    || !sortedUnique(formula.dependencies, (dependency) => dependency)
    || !validCoordinate(formula.acquisition, target, 'homebrew-bottle')
    || !Array.isArray(formula.licenses)
    || formula.licenses.length === 0
    || formula.licenses.some((license) => !validLicense(license, target))
    || !sortedUnique(formula.licenses, licenseSortKey)
  ) invalid('Captured formula is invalid.')
}

function validateEngine(engine, expectedName, target, formulae) {
  if (
    !exactKeys(engine, ['name', 'version', 'license', 'rootFormula', 'acquisition', 'licenses'])
    || engine.name !== expectedName
    || typeof engine.version !== 'string'
    || typeof engine.license !== 'string'
    || !Array.isArray(engine.licenses)
    || engine.licenses.some((license) => license.kind !== 'download' || !validLicense(license, target))
    || !sortedUnique(engine.licenses, licenseSortKey)
  ) invalid('Captured engine is invalid.')
  if (engine.name === 'libreoffice') {
    if (engine.rootFormula !== null || engine.licenses.length === 0 || !validCoordinate(engine.acquisition, target, 'dmg')) invalid('Captured LibreOffice engine is invalid.')
    return
  }
  if (engine.licenses.length !== 0) invalid('Formula-backed engine licenses must be empty.')
  const formula = formulae.get(engine.rootFormula)
  if (
    !formula
    || formula.version !== engine.version
    || formula.license !== engine.license
    || !canonicalBytes(formula.acquisition).equals(canonicalBytes(engine.acquisition))
  ) invalid('Captured engine identity differs from its root formula.')
}

function validateClosureFormulae(closure, formulae) {
  if (closure.formulae.length !== formulae.size) invalid('Capture closure formula set differs from its formula catalog.')
  for (const selected of closure.formulae) {
    const formula = formulae.get(selected.name)
    if (!formula || formula.version !== selected.version || !canonicalBytes(formula.dependencies).equals(canonicalBytes(selected.dependencies))) {
      invalid('Capture closure formula identity differs from its formula catalog.')
    }
  }
}

async function readCapture(path, target) {
  requireAbsolutePath(path, 'Capture fragment')
  const bytes = await readStableRegularFile(path, 'Capture fragment', maximumCaptureBytes)
  let value
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    invalid()
  }
  if (!bytes.equals(canonicalBytes(value))) invalid('Capture fragment is not canonical JSON.')
  if (!exactKeys(value, ['payloadSha256', 'payload']) || !sha256Pattern.test(value.payloadSha256) || !plainRecord(value.payload)) invalid()
  if (sha256(canonicalBytes(value.payload)) !== value.payloadSha256) invalid('Capture fragment hash does not match its payload.')
  const payload = value.payload
  if (
    !exactKeys(payload, [
      'schemaVersion', 'target', 'repositoryRevision', 'homebrewCoreRevision', 'homebrewCaskRevision', 'roots', 'engines', 'formulae', 'probes', 'closure',
    ])
    || payload.schemaVersion !== 1
    || payload.target !== target
    || !revisionPattern.test(payload.repositoryRevision)
    || !revisionPattern.test(payload.homebrewCoreRevision)
    || !revisionPattern.test(payload.homebrewCaskRevision)
    || !Array.isArray(payload.roots)
    || payload.roots.length === 0
    || !sortedUnique(payload.roots, (root) => root)
    || !Array.isArray(payload.formulae)
    || payload.formulae.length === 0
    || !sortedUnique(payload.formulae, (formula) => formula.name)
    || !exactKeys(payload.probes, familyNames)
    || familyNames.some((family) => !sha256Pattern.test(payload.probes[family]) || /^0+$/u.test(payload.probes[family]))
  ) invalid()
  for (const formula of payload.formulae) validateFormula(formula, target)
  const formulae = new Map(payload.formulae.map((formula) => [formula.name, formula]))
  if (formulae.size !== payload.formulae.length) invalid('Capture contains duplicate formulae.')
  for (const formula of formulae.values()) {
    if (formula.dependencies.some((dependency) => !formulae.has(dependency))) invalid('Capture formula dependency is missing.')
  }
  requireReachable(payload.formulae, payload.roots)
  if (!Array.isArray(payload.engines) || payload.engines.length !== engineNames.length) invalid()
  payload.engines.forEach((engine, index) => validateEngine(engine, engineNames[index], target, formulae))
  const closure = validateTargetClosureLock(payload.closure, target)
  validateClosureFormulae(closure, formulae)
  return { ...payload, closure, captureSha256: sha256(bytes) }
}

async function readProvenanceManifest(path) {
  requireAbsolutePath(path, 'Capture provenance manifest')
  const bytes = await readStableRegularFile(path, 'Capture provenance manifest', 1024 * 1024)
  let value
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    invalid('Capture provenance manifest is invalid.')
  }
  if (
    !bytes.equals(canonicalBytes(value))
    || !exactKeys(value, ['schemaVersion', 'repositoryRevision', 'homebrewCoreRevision', 'homebrewCaskRevision', 'captures'])
    || value.schemaVersion !== 1
    || !revisionPattern.test(value.repositoryRevision)
    || !revisionPattern.test(value.homebrewCoreRevision)
    || !revisionPattern.test(value.homebrewCaskRevision)
    || !exactKeys(value.captures, targets)
    || targets.some((target) => !exactKeys(value.captures[target], ['sha256']) || !sha256Pattern.test(value.captures[target].sha256))
  ) invalid('Capture provenance manifest is invalid.')
  return value
}

function formulaIdentity(formula) {
  return canonicalBytes({
    name: formula.name, version: formula.version, revision: formula.revision,
    license: formula.license,
  })
}

function engineIdentity(engine) {
  return canonicalBytes({
    name: engine.name, version: engine.version, license: engine.license,
    rootFormula: engine.rootFormula, licenses: engine.licenses,
  })
}

function mergeLicenses(arm, x64) {
  const armDownloads = arm.filter((license) => license.kind === 'download')
  const x64Downloads = x64.filter((license) => license.kind === 'download')
  if (!canonicalBytes(armDownloads).equals(canonicalBytes(x64Downloads))) invalid('Downloaded license identities differ between targets.')
  const merged = [
    ...arm.filter((license) => license.kind === 'bottle-entry'),
    ...x64.filter((license) => license.kind === 'bottle-entry'),
    ...armDownloads,
  ].sort((left, right) => compareUtf8(licenseSortKey(left), licenseSortKey(right)))
  if (!sortedUnique(merged, licenseSortKey)) invalid('Merged license inventory contains duplicates.')
  return merged
}

function buildSourceLock(arm64, x64, closureCoordinates, manifest) {
  if (
    arm64.homebrewCoreRevision !== x64.homebrewCoreRevision
    || arm64.homebrewCaskRevision !== x64.homebrewCaskRevision
    || !canonicalBytes(arm64.roots).equals(canonicalBytes(x64.roots))
  ) invalid('Capture revision or root identities differ between targets.')
  if (arm64.formulae.length !== x64.formulae.length) invalid('Formula identities differ between targets.')
  const formulae = arm64.formulae.map((armFormula, index) => {
    const x64Formula = x64.formulae[index]
    if (!x64Formula || !formulaIdentity(armFormula).equals(formulaIdentity(x64Formula))) invalid('Formula identities differ between targets.')
    return {
      name: armFormula.name,
      version: armFormula.version,
      revision: armFormula.revision,
      license: armFormula.license,
      acquisitions: {
        'darwin-arm64': cloneJson(armFormula.acquisition),
        'darwin-x64': cloneJson(x64Formula.acquisition),
      },
      licenses: mergeLicenses(armFormula.licenses, x64Formula.licenses),
    }
  })
  const engines = arm64.engines.map((armEngine, index) => {
    const x64Engine = x64.engines[index]
    if (!x64Engine || !engineIdentity(armEngine).equals(engineIdentity(x64Engine))) invalid('Engine identities differ between targets.')
    return {
      name: armEngine.name, version: armEngine.version, license: armEngine.license, rootFormula: armEngine.rootFormula,
      acquisitions: {
        'darwin-arm64': cloneJson(armEngine.acquisition),
        'darwin-x64': cloneJson(x64Engine.acquisition),
      },
      licenses: cloneJson(armEngine.licenses),
    }
  })
  return {
    schemaVersion: 2,
    homebrewCoreRevision: arm64.homebrewCoreRevision,
    homebrewCaskRevision: arm64.homebrewCaskRevision,
    targets: [...targets],
    engines,
    formulae,
    closureLocks: closureCoordinates,
    provenance: {
      repositoryRevision: manifest.repositoryRevision,
      captures: Object.fromEntries(targets.map((target) => {
        const capture = target === 'darwin-arm64' ? arm64 : x64
        return [target, {
          captureSha256: capture.captureSha256,
          probesSha256: sha256(canonicalBytes(capture.probes)),
        }]
      })),
    },
  }
}

async function existingBytes(path) {
  const metadata = await lstat(path).catch(() => undefined)
  if (!metadata) return undefined
  if (!metadata.isFile() || metadata.isSymbolicLink() || await realpath(path).catch(() => undefined) !== path) {
    invalid('Existing generated lock is unsafe.')
  }
  return readStableRegularFile(path, 'Existing generated lock', maximumCaptureBytes)
}

async function requireIdenticalOrMissing(path, wanted) {
  const existing = await existingBytes(path)
  if (existing !== undefined && !existing.equals(wanted)) invalid('Existing generated lock differs; refusing to overwrite it.')
  return existing !== undefined
}

async function validateGenerated(sourceBytes, armBytes, x64Bytes, outputRoot) {
  const temporary = await mkdtemp(join(outputRoot, '.converter-lock-validation-'))
  try {
    await mkdir(join(temporary, 'closures'), { mode: 0o700 })
    await writeFile(join(temporary, 'closures', 'darwin-arm64.lock.json'), armBytes, { flag: 'wx', mode: 0o600 })
    await writeFile(join(temporary, 'closures', 'darwin-x64.lock.json'), x64Bytes, { flag: 'wx', mode: 0o600 })
    const sourcePath = join(temporary, 'sources.lock.json')
    await writeFile(sourcePath, sourceBytes, { flag: 'wx', mode: 0o600 })
    await loadConverterClosureLock({ sourceLockPath: sourcePath, target: 'darwin-arm64' })
    await loadConverterClosureLock({ sourceLockPath: sourcePath, target: 'darwin-x64' })
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export async function generateTransitiveSourceLock({ arm64Capture, x64Capture, provenanceManifest, outputRoot }) {
  for (const [path, label] of [[arm64Capture, 'arm64 capture'], [x64Capture, 'x64 capture'], [provenanceManifest, 'capture provenance manifest'], [outputRoot, 'lock output root']]) {
    requireAbsolutePath(path, label)
  }
  const metadata = await lstat(outputRoot).catch(() => undefined)
  if (!metadata?.isDirectory() || metadata.isSymbolicLink() || await realpath(outputRoot).catch(() => undefined) !== outputRoot) {
    invalid('Lock output root must be canonical and non-symbolic.')
  }
  const [arm64, x64, manifest] = await Promise.all([
    readCapture(arm64Capture, 'darwin-arm64'),
    readCapture(x64Capture, 'darwin-x64'),
    readProvenanceManifest(provenanceManifest),
  ])
  for (const capture of [arm64, x64]) {
    if (
      manifest.captures[capture.target].sha256 !== capture.captureSha256
      || manifest.repositoryRevision !== capture.repositoryRevision
      || manifest.homebrewCoreRevision !== capture.homebrewCoreRevision
      || manifest.homebrewCaskRevision !== capture.homebrewCaskRevision
    ) invalid('Capture differs from the protected-run provenance manifest.')
  }
  const armBytes = canonicalBytes(arm64.closure)
  const x64Bytes = canonicalBytes(x64.closure)
  const closureCoordinates = {
    'darwin-arm64': { path: 'closures/darwin-arm64.lock.json', sha256: sha256(armBytes), bytes: armBytes.byteLength },
    'darwin-x64': { path: 'closures/darwin-x64.lock.json', sha256: sha256(x64Bytes), bytes: x64Bytes.byteLength },
  }
  const sourceBytes = canonicalBytes(buildSourceLock(arm64, x64, closureCoordinates, manifest))
  await validateGenerated(sourceBytes, armBytes, x64Bytes, outputRoot)

  const closuresRoot = join(outputRoot, 'closures')
  const closuresMetadata = await lstat(closuresRoot).catch(() => undefined)
  if (closuresMetadata && (!closuresMetadata.isDirectory() || closuresMetadata.isSymbolicLink() || await realpath(closuresRoot) !== closuresRoot)) {
    invalid('Generated closure directory is unsafe.')
  }
  const paths = {
    arm64: join(closuresRoot, 'darwin-arm64.lock.json'),
    x64: join(closuresRoot, 'darwin-x64.lock.json'),
    source: join(outputRoot, 'sources.lock.json'),
  }
  const [armExists, x64Exists, sourceExists] = await Promise.all([
    requireIdenticalOrMissing(paths.arm64, armBytes),
    requireIdenticalOrMissing(paths.x64, x64Bytes),
    requireIdenticalOrMissing(paths.source, sourceBytes),
  ])
  if (!closuresMetadata) await mkdir(closuresRoot, { mode: 0o755 })
  if (!armExists) await writeFile(paths.arm64, armBytes, { flag: 'wx', mode: 0o644 })
  if (!x64Exists) await writeFile(paths.x64, x64Bytes, { flag: 'wx', mode: 0o644 })
  if (!sourceExists) await writeFile(paths.source, sourceBytes, { flag: 'wx', mode: 0o644 })
}

export async function generateTransitiveSourceLockMain(argv) {
  try {
    const args = parseArguments(argv, ['--arm64-capture', '--x64-capture', '--provenance-manifest', '--output-root'])
    await generateTransitiveSourceLock({
      arm64Capture: args['--arm64-capture'], x64Capture: args['--x64-capture'], provenanceManifest: args['--provenance-manifest'], outputRoot: args['--output-root'],
    })
    process.stdout.write('generated integrity-checked dual-target converter locks\n')
    return 0
  } catch {
    process.stderr.write('converter lock generation failed\n')
    return 1
  }
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) process.exitCode = await generateTransitiveSourceLockMain(process.argv.slice(2))
