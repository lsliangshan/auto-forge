import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { lstat, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import process from 'node:process'
import { pathToFileURL, URL } from 'node:url'
import { validateTargetClosureLock } from './closure-lock.mjs'
import { materializeBottleUniverse } from './bottle-universe.mjs'
import { extractVerifiedBottleForDiscovery } from './bottle-archive.mjs'
import { adhocSignMachOClosure, discoverMachOClosure, inspectMachO, planMachOClosure, relocateMachOClosure } from './macho-closure.mjs'
import { probeConverterFamily, stageProductionPacks } from './stage-production-packs.mjs'
import { buildConverterPackIndex } from './build-index.mjs'
import { buildNativeHelpers } from './build-native-helpers.mjs'
import { materializeLockedEngineAssets } from './locked-engine-assets.mjs'
import { publishDurableLockFile } from './durable-lock-publication.mjs'
import {
  canonicalBytes,
  compareUtf8,
  fail,
  parseArguments,
  readCanonicalJson,
  readStableRegularFile,
  requireAbsolutePath,
  sha256,
} from './pack-tooling-lib.mjs'

const maximumCommandBytes = 64 * 1024 * 1024
const revisionPattern = /^[a-f0-9]{40}$/u
const sha256Pattern = /^[a-f0-9]{64}$/u
const formulaPattern = /^[a-z0-9][a-z0-9+_.@-]*$/u
const targets = new Set(['darwin-arm64', 'darwin-x64'])
const familyNames = ['image-icon', 'document', 'pdf', 'media']
const engineNames = ['ffmpeg', 'libreoffice', 'libvips', 'poppler']
const maintainerEnv = Object.freeze({
  LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin',
  HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ANALYTICS: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1',
  HOMEBREW_NO_INSTALL_FROM_API: '1',
})

function invalid(message = 'Converter target capture is invalid.') {
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

function asBytes(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (typeof value === 'string') return Buffer.from(value)
  invalid('Maintainer command output is invalid.')
}

function defaultRun(executable, args, options) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd, env: options.env, encoding: null, maxBuffer: maximumCommandBytes + 1,
  })
  return { status: result.status, stdout: result.stdout ?? Buffer.alloc(0), stderr: result.stderr ?? Buffer.alloc(0) }
}

async function runChecked(run, executable, args, options, label) {
  const result = await run(executable, args, options)
  const stdout = asBytes(result?.stdout)
  const stderr = asBytes(result?.stderr)
  if (stdout.byteLength > maximumCommandBytes || stderr.byteLength > maximumCommandBytes) {
    invalid('Maintainer command output exceeds 64 MiB.')
  }
  if (result?.status !== 0) invalid(`${label} failed.`)
  return stdout
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    invalid(`${label} is invalid.`)
  }
}

function expectedHostTarget() {
  if (process.platform !== 'darwin') invalid('Homebrew capture requires macOS.')
  if (process.arch === 'arm64') return 'darwin-arm64'
  if (process.arch === 'x64') return 'darwin-x64'
  invalid('Homebrew capture host architecture is unsupported.')
}

function validateRoots(roots) {
  const formulaEngines = new Map([
    ['ffmpeg', 'ffmpeg'],
    ['libvips', 'vips'],
    ['poppler', 'poppler'],
  ])
  if (
    !exactKeys(roots, ['schemaVersion', 'formulaRoots', 'engines'])
    || roots.schemaVersion !== 1
    || !Array.isArray(roots.formulaRoots)
    || roots.formulaRoots.length === 0
    || roots.formulaRoots.some((name) => typeof name !== 'string' || !formulaPattern.test(name))
    || new Set(roots.formulaRoots).size !== roots.formulaRoots.length
    || roots.formulaRoots.some((name, index) => index > 0 && compareUtf8(roots.formulaRoots[index - 1], name) >= 0)
    || !Array.isArray(roots.engines)
    || roots.engines.length !== engineNames.length
    || roots.engines.some((engine, index) => !plainRecord(engine) || engine.name !== engineNames[index])
  ) invalid('Capture roots are invalid.')
  for (const engine of roots.engines) {
    if (engine.name === 'libreoffice') {
      if (
        !exactKeys(engine, ['name', 'cask', 'expectedLicense', 'directLicenses'])
        || engine.cask !== 'libreoffice'
        || typeof engine.expectedLicense !== 'string'
        || engine.expectedLicense.length === 0
        || !Array.isArray(engine.directLicenses)
        || engine.directLicenses.length !== 1
        || engine.directLicenses.some((license) => (
          !exactKeys(license, ['url', 'sha256', 'bytes', 'destination'])
          || !validHttpsUrl(license.url)
          || !sha256Pattern.test(license.sha256)
          || !Number.isSafeInteger(license.bytes)
          || license.bytes <= 0
          || license.destination !== 'LICENSES/libreoffice.LICENSE'
        ))
      ) invalid('Capture LibreOffice candidate is invalid.')
      continue
    }
    if (
      !exactKeys(engine, ['name', 'formula', 'expectedLicense'])
      || engine.formula !== formulaEngines.get(engine.name)
      || typeof engine.expectedLicense !== 'string'
      || engine.expectedLicense.length === 0
      || !roots.formulaRoots.includes(engine.formula)
    ) invalid('Capture formula engine candidate is invalid.')
  }
  return cloneJson(roots)
}

function parseTapInfo(value, tap, revision) {
  if (!Array.isArray(value) || value.length !== 1 || !plainRecord(value[0])) invalid('Homebrew tap metadata is invalid.')
  if (value[0].name !== tap || value[0].installed !== true || value[0].HEAD !== revision) {
    invalid(`Homebrew ${tap} revision does not match the pinned revision.`)
  }
}

function parseCask(value, candidate) {
  if (!plainRecord(value) || !Array.isArray(value.formulae) || value.formulae.length !== 0 || !Array.isArray(value.casks) || value.casks.length !== 1) {
    invalid('Homebrew cask metadata is invalid.')
  }
  const cask = value.casks[0]
  if (
    !plainRecord(cask)
    || cask.token !== candidate.cask
    || typeof cask.version !== 'string'
    || cask.version.length === 0
    || !validHttpsUrl(cask.url)
    || !sha256Pattern.test(cask.sha256)
    || !Array.isArray(cask.artifacts)
    || !cask.artifacts.some((artifact) => plainRecord(artifact) && Array.isArray(artifact.app) && artifact.app.length === 1 && artifact.app[0] === 'LibreOffice.app')
  ) invalid('Homebrew LibreOffice cask metadata is invalid.')
  return { version: cask.version, url: cask.url, sha256: cask.sha256 }
}

function dependencyNames(bytes) {
  const text = bytes.toString('utf8')
  if (text.includes('\0')) invalid('Homebrew dependency output is invalid.')
  const values = text.split(/\r?\n/u).filter(Boolean)
  if (values.some((value) => !formulaPattern.test(value))) invalid('Homebrew dependency output is invalid.')
  return values
}

function bottleTag(target) {
  return target === 'darwin-arm64' ? 'arm64_sequoia' : 'sonoma'
}

function expectedCellar(target) {
  return target === 'darwin-arm64' ? '/opt/homebrew/Cellar' : '/usr/local/Cellar'
}

function parseFormulae(value, names, target) {
  if (!plainRecord(value) || !Array.isArray(value.formulae) || !Array.isArray(value.casks) || value.casks.length !== 0) {
    invalid('Homebrew formula metadata is invalid.')
  }
  const byName = new Map()
  for (const formula of value.formulae) {
    if (
      !plainRecord(formula) || !formulaPattern.test(formula.name) || formula.full_name !== formula.name
      || formula.tap !== 'homebrew/core' || typeof formula.versions?.stable !== 'string'
      || !Number.isSafeInteger(formula.revision) || formula.revision < 0
      || typeof formula.license !== 'string' || formula.license.length === 0
      || !Array.isArray(formula.dependencies)
      || formula.dependencies.some((dependency) => typeof dependency !== 'string' || !formulaPattern.test(dependency))
      || byName.has(formula.name)
    ) invalid('Homebrew formula metadata is invalid.')
    const bottle = formula.bottle?.stable?.files?.[bottleTag(target)]
    if (
      !plainRecord(bottle)
      || ![expectedCellar(target), ':any', ':any_skip_relocation'].includes(bottle.cellar)
      || !validHttpsUrl(bottle.url)
      || !sha256Pattern.test(bottle.sha256)
    ) {
      invalid('Homebrew formula bottle metadata is invalid for the selected target.')
    }
    const version = formula.revision === 0 ? formula.versions.stable : `${formula.versions.stable}_${formula.revision}`
    byName.set(formula.name, {
      name: formula.name, version, revision: formula.revision, license: formula.license,
      dependencies: [...formula.dependencies].sort(compareUtf8), bottle: { url: bottle.url, sha256: bottle.sha256 },
    })
  }
  if (byName.size !== names.length || names.some((name) => !byName.has(name))) invalid('Homebrew formula set differs from its dependency closure.')
  for (const formula of byName.values()) {
    if (formula.dependencies.some((dependency) => !byName.has(dependency))) invalid('Homebrew formula dependency is outside the selected closure.')
  }
  return byName
}

function requireReachable(formulae, roots) {
  const reached = new Set()
  const pending = [...roots]
  while (pending.length > 0) {
    const name = pending.pop()
    if (reached.has(name)) continue
    const formula = formulae.get(name)
    if (!formula) invalid('Homebrew root formula is missing.')
    reached.add(name)
    pending.push(...formula.dependencies)
  }
  if (reached.size !== formulae.size) invalid('Homebrew formula is not reachable from a root.')
}

function ghcrScope(artifact) {
  const url = new URL(artifact.url)
  if (url.hostname !== 'ghcr.io') return undefined
  const match = /^\/v2\/(homebrew\/core\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*)\/blobs\/sha256:([a-f0-9]{64})$/u.exec(url.pathname)
  if (url.origin !== 'https://ghcr.io' || !match || match[2] !== artifact.sha256 || url.search.length !== 0) {
    invalid('Capture GHCR artifact coordinate is invalid.')
  }
  return `repository:${match[1]}:pull`
}

async function ghcrAuthorization(run, workspace, artifact) {
  const scope = ghcrScope(artifact)
  if (scope === undefined) return []
  const tokenUrl = new URL('https://ghcr.io/token')
  tokenUrl.searchParams.set('service', 'ghcr.io')
  tokenUrl.searchParams.set('scope', scope)
  const bytes = await runChecked(run, '/usr/bin/curl', [
    '--fail', '--proto', '=https', '--silent', '--show-error', tokenUrl.href,
  ], { cwd: workspace, env: maintainerEnv }, 'Capture GHCR token request')
  if (bytes.byteLength === 0 || bytes.byteLength > 16 * 1024) invalid('Capture GHCR token response is invalid.')
  const value = parseJson(bytes, 'Capture GHCR token response')
  if (
    !exactKeys(value, ['token'])
    || typeof value.token !== 'string'
    || value.token.length === 0
    || value.token.length > 8_192
    || [...value.token].some((character) => character.codePointAt(0) <= 0x20 || character.codePointAt(0) === 0x7f)
  ) invalid('Capture GHCR token response is invalid.')
  return ['--header', `Authorization: Bearer ${value.token}`]
}

async function verifyDownload({ run, workspace, artifact, verified }) {
  const previous = verified.get(artifact.sha256)
  if (previous) {
    if (previous.url !== artifact.url || (artifact.bytes !== undefined && previous.bytes !== artifact.bytes)) {
      invalid('Capture artifact identity conflicts for one SHA-256.')
    }
    return previous.bytes
  }
  if (!validHttpsUrl(artifact.url) || !sha256Pattern.test(artifact.sha256)) invalid('Capture artifact coordinate is invalid.')
  const path = join(workspace, artifact.sha256)
  const authorization = await ghcrAuthorization(run, workspace, artifact)
  await runChecked(run, '/usr/bin/curl', [
    '--fail', '--location', '--proto', '=https', '--proto-redir', '=https',
    '--silent', '--show-error', ...authorization, '--output', path, artifact.url,
  ], { cwd: workspace, env: maintainerEnv }, 'Capture artifact download')
  const bytes = await readStableRegularFile(path, 'Downloaded capture artifact')
  if (bytes.byteLength <= 0 || (artifact.bytes !== undefined && bytes.byteLength !== artifact.bytes)) {
    invalid('Downloaded capture artifact byte length differs from metadata.')
  }
  if (sha256(bytes) !== artifact.sha256) invalid('Downloaded capture artifact hash differs from metadata.')
  verified.set(artifact.sha256, { url: artifact.url, bytes: bytes.byteLength, path })
  return bytes.byteLength
}

function asText(value) {
  return asBytes(value).toString('utf8')
}

function targetToolRunner(run, workspace) {
  return async (executable, args, options = {}) => {
    const result = await run(executable, args, {
      cwd: options.cwd ?? workspace,
      env: maintainerEnv,
    })
    const stdout = asBytes(result?.stdout)
    const stderr = asBytes(result?.stderr)
    if (stdout.byteLength > maximumCommandBytes || stderr.byteLength > maximumCommandBytes) {
      invalid('Maintainer command output exceeds 64 MiB.')
    }
    return { status: result?.status, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') }
  }
}

function lockedDiscoveryFile(file) {
  return {
    formula: file.formula,
    sourcePath: file.sourcePath,
    destination: file.destination,
    sha256: file.sha256,
    bytes: file.bytes,
    executable: file.executable,
    role: file.role,
    runtimeRoot: file.runtimeRoot,
  }
}

function lockedDiscoveryLicense(license) {
  return {
    formula: license.formula,
    source: license.sourcePath,
    destination: license.destination,
    sha256: license.sha256,
    bytes: license.bytes,
  }
}

function emptyFamily() {
  return { files: [], rewrites: [], licenses: [], nativeHelpers: [], engineAssets: [], engineLicenses: [] }
}

function deriveEngines(roots, cask, formulae, target, libreOfficeBytes) {
  return roots.engines.map((candidate) => {
    if (candidate.name === 'libreoffice') {
      return {
        name: 'libreoffice',
        version: cask.version,
        license: candidate.expectedLicense,
        rootFormula: null,
        acquisition: {
          kind: 'dmg', url: cask.url, sha256: cask.sha256, bytes: libreOfficeBytes, cellar: null,
        },
        licenses: candidate.directLicenses.map((license) => ({ kind: 'download', ...cloneJson(license) })),
      }
    }
    const formula = formulae.get(candidate.formula)
    if (!formula || formula.license !== candidate.expectedLicense || !Number.isSafeInteger(formula.bytes)) {
      invalid('Formula-backed engine identity differs from Homebrew metadata.')
    }
    return {
      name: candidate.name,
      version: formula.version,
      license: formula.license,
      rootFormula: formula.name,
      acquisition: {
        kind: 'homebrew-bottle', url: formula.bottle.url, sha256: formula.bottle.sha256,
        bytes: formula.bytes, cellar: expectedCellar(target),
      },
      licenses: [],
    }
  })
}

async function discoverTargetClosure({ target, formulae, engines, verified, workspace, run, roots }) {
  const candidates = []
  for (const formula of [...formulae.values()].sort((left, right) => compareUtf8(left.name, right.name))) {
    const artifact = verified.get(formula.bottle.sha256)
    if (!artifact) invalid('Formula bottle was not verified before closure discovery.')
    candidates.push(...await extractVerifiedBottleForDiscovery({
      archive: artifact.path,
      expectedBytes: artifact.bytes,
      expectedSha256: formula.bottle.sha256,
      formula: formula.name,
      version: formula.version,
      outputRoot: workspace,
    }))
  }
  const architecture = target === 'darwin-arm64' ? 'arm64' : 'x86_64'
  const toolRun = targetToolRunner(run, workspace)
  const inspect = (path) => inspectMachO(path, { run: toolRun })
  const image = await discoverMachOClosure({ family: 'image-icon', architecture, files: candidates, inspect })
  const pdf = await discoverMachOClosure({ family: 'pdf', architecture, files: candidates, inspect })
  const media = await discoverMachOClosure({ family: 'media', architecture, files: candidates, inspect })
  const libreOffice = engines.find((engine) => engine.name === 'libreoffice')
  if (!libreOffice) invalid('LibreOffice engine identity is missing.')
  const family = (discovered) => ({
    ...emptyFamily(),
    files: discovered.files.map(lockedDiscoveryFile),
    rewrites: cloneJson(discovered.rewrites),
    licenses: discovered.licenses.map(lockedDiscoveryLicense),
  })
  const families = {
    'image-icon': {
      ...family(image),
      nativeHelpers: [{ helper: 'autoforge-image-converter', destination: 'bin/autoforge-image-converter' }],
    },
    document: {
      ...emptyFamily(),
      nativeHelpers: [{ helper: 'autoforge-soffice-launcher', destination: 'program/soffice' }],
      engineAssets: [{
        engine: 'libreoffice', source: 'acquisition', destination: 'share/LibreOffice.dmg',
        sha256: libreOffice.acquisition.sha256, bytes: libreOffice.acquisition.bytes, executable: false, role: 'data',
      }],
      engineLicenses: libreOffice.licenses.map((license) => ({
        engine: 'libreoffice', source: license.url, destination: license.destination,
        sha256: license.sha256, bytes: license.bytes,
      })),
    },
    pdf: {
      ...family(pdf),
      nativeHelpers: [{ helper: 'autoforge-pdf-raster', destination: 'bin/autoforge-pdf-raster' }],
    },
    media: family(media),
  }
  const selectedNames = new Set(Object.values(families).flatMap((value) => value.files.map((file) => file.formula)))
  if (roots.formulaRoots.some((name) => !selectedNames.has(name))) invalid('Discovered closure omits a root formula.')
  const selectedFormulae = [...selectedNames].sort(compareUtf8).map((name) => {
    const formula = formulae.get(name)
    return {
      name,
      version: formula.version,
      dependencies: formula.dependencies.filter((dependency) => selectedNames.has(dependency)),
    }
  })
  const closure = {
    schemaVersion: 1,
    target,
    formulae: selectedFormulae,
    families,
    measurements: {
      downloadBytes: 1,
      compressedPackBytes: { 'image-icon': 1, document: 1, pdf: 1, media: 1 },
      installedReleaseBytes: 1,
    },
  }
  return validateTargetClosureLock(closure, target)
}

function capturedFormulaLicenseAssets(closure, formula, target) {
  const values = Object.values(closure.families).flatMap((family) => family.licenses)
    .filter((license) => license.formula === formula)
    .map((license) => ({
      kind: 'bottle-entry', target, path: license.source, sha256: license.sha256,
      bytes: license.bytes, destination: license.destination,
    }))
  return [...new Map(values.map((value) => [canonicalBytes(value).toString('utf8'), value])).values()]
    .sort((left, right) => compareUtf8(
      `${left.target}\0${left.destination}\0${left.path}`,
      `${right.target}\0${right.destination}\0${right.path}`,
    ))
}

async function sumRegularBytes(root) {
  let total = 0
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile()) total += (await stat(path)).size
      else invalid('Generated capture output contains an unsupported file type.')
      if (!Number.isSafeInteger(total)) invalid('Generated capture measurement overflows.')
    }
  }
  return total
}

async function authenticateAndMeasureClosure({ target, closure, engines, formulae, verified, workspace, run }) {
  const universeRoot = join(workspace, 'universe')
  const blobs = new Map([...verified].map(([digest, artifact]) => [digest, {
    path: artifact.path, sha256: digest, bytes: artifact.bytes, networkBytes: 0,
  }]))
  const universe = await materializeBottleUniverse({
    target,
    closureLock: closure,
    formulae: formulae.map((formula) => ({
      name: formula.name,
      version: formula.version,
      acquisition: formula.acquisition,
      licenses: formula.licenses,
    })),
    blobs,
    outputRoot: universeRoot,
  })
  const sourceLock = { target, engines, formulae }
  const engineAssetsRoot = join(workspace, 'engine-assets')
  const engineAssets = await materializeLockedEngineAssets({
    target, sourceLock, closureLock: closure, blobs, outputRoot: engineAssetsRoot,
  })
  const helpersRoot = join(workspace, 'helpers')
  const helperSet = await buildNativeHelpers({ target, output: helpersRoot, compiler: '/usr/bin/clang' })
  const staging = join(workspace, 'staging')
  const toolRun = targetToolRunner(run, workspace)
  const probeDigests = {}
  await stageProductionPacks({
    target,
    output: staging,
    version: '0.0.0-capture',
    sequence: 0,
    generatedAt: '1970-01-01T00:00:00.000Z',
    archiveBaseUrl: 'https://capture.invalid/converter-packs',
    sourceLockPath: join(workspace, 'candidate-source.json'),
    universeRoot,
    helpersRoot,
    engineAssetsRoot,
  }, {
    loadClosure: async () => ({ sourceLock, closureLock: closure, target }),
    openUniverse: async () => universe,
    openHelpers: async () => helperSet,
    openEngineAssets: async () => engineAssets,
    inspectHelper: (path) => inspectMachO(path, { run: toolRun }),
    planClosure: ({ entrypoints, architecture, expectedFiles, expectedRewrites }) => planMachOClosure({
      entrypoints,
      architecture,
      universe,
      expectedFiles,
      expectedRewrites,
      inspect: (path) => inspectMachO(path, { run: toolRun }),
    }),
    applyRelocation: async ({ payload, architecture, plan }) => {
      await relocateMachOClosure({ payload, architecture, plan, run: toolRun })
      await adhocSignMachOClosure({ payload, plan, run: toolRun })
    },
    probeFamily: async (request) => {
      const transcript = []
      await probeConverterFamily(request, {
        run: async (executable, args, options) => {
          const result = await toolRun(executable, args, options)
          transcript.push({
            executable: relative(request.payload, executable),
            args,
            status: result.status,
            stdoutSha256: sha256(Buffer.from(result.stdout)),
            stderrSha256: sha256(Buffer.from(result.stderr)),
          })
          return result
        },
      })
      probeDigests[request.name] = sha256(canonicalBytes(transcript))
    },
  })
  if (!exactKeys(probeDigests, familyNames)) invalid('All four converter families must be probed on the target runner.')
  const release = join(workspace, 'measured-release')
  await buildConverterPackIndex({ input: staging, output: release, mode: 'test' })
  const index = JSON.parse(asText(await readFile(join(release, 'index.json'))))
  const compressedPackBytes = Object.fromEntries(index.packs.map((pack) => [pack.name, pack.archiveBytes]))
  if (!exactKeys(compressedPackBytes, familyNames)) invalid('Measured capture packs are incomplete.')
  const installedReleaseBytes = await sumRegularBytes(release)
  const downloadable = new Map()
  for (const value of [
    ...formulae.map((formula) => formula.acquisition),
    ...formulae.flatMap((formula) => formula.licenses.filter((license) => license.kind === 'download')),
    ...engines.map((engine) => engine.acquisition),
    ...engines.flatMap((engine) => engine.licenses),
  ]) downloadable.set(value.sha256, value)
  const downloadBytes = [...downloadable.values()].reduce((sum, artifact) => sum + artifact.bytes, 0)
  if (!Number.isSafeInteger(downloadBytes) || downloadBytes <= 0 || installedReleaseBytes <= 0) invalid('Capture measurement is invalid.')
  return {
    probes: probeDigests,
    measurements: { downloadBytes, compressedPackBytes, installedReleaseBytes },
  }
}

export async function captureHomebrewTarget({ target, brew, repositoryRevision, coreRevision, caskRevision, roots, output, run = defaultRun }) {
  if (!targets.has(target) || target !== expectedHostTarget()) invalid('Capture target does not match the maintainer host.')
  if (typeof brew !== 'string' || !isAbsolute(brew)) invalid('Homebrew executable must be an absolute path.')
  if (!revisionPattern.test(repositoryRevision)) invalid('Repository revision must be an exact lowercase 40-hex commit.')
  if (!revisionPattern.test(coreRevision)) invalid('Homebrew core revision must be an exact lowercase 40-hex commit.')
  if (!revisionPattern.test(caskRevision)) invalid('Homebrew cask revision must be an exact lowercase 40-hex commit.')
  requireAbsolutePath(output, 'Capture output')
  if (typeof run !== 'function') invalid('Maintainer command runner is invalid.')
  const parent = dirname(output)
  const parentMetadata = await lstat(parent).catch(() => undefined)
  if (!parentMetadata?.isDirectory() || parentMetadata.isSymbolicLink() || await realpath(parent).catch(() => undefined) !== parent) {
    invalid('Capture output parent must be canonical and non-symbolic.')
  }
  roots = validateRoots(roots)
  const workspace = await mkdtemp(join(parent, '.converter-lock-capture-'))
  let primaryError
  try {
    parseTapInfo(parseJson(await runChecked(
      run, brew, ['tap-info', '--json=v1', 'homebrew/core'], { cwd: workspace, env: maintainerEnv }, 'Homebrew tap inspection',
    ), 'Homebrew tap metadata'), 'homebrew/core', coreRevision)
    parseTapInfo(parseJson(await runChecked(
      run, brew, ['tap-info', '--json=v1', 'homebrew/cask'], { cwd: workspace, env: maintainerEnv }, 'Homebrew tap inspection',
    ), 'Homebrew tap metadata'), 'homebrew/cask', caskRevision)
    const libreOfficeCandidate = roots.engines.find((engine) => engine.name === 'libreoffice')
    const cask = parseCask(parseJson(await runChecked(
      run, brew, ['info', '--json=v2', '--cask', libreOfficeCandidate.cask], { cwd: workspace, env: maintainerEnv }, 'Homebrew cask inspection',
    ), 'Homebrew cask metadata'), libreOfficeCandidate)
    const dependencies = dependencyNames(await runChecked(
      run, brew, ['deps', '--union', '--formula', ...roots.formulaRoots], { cwd: workspace, env: maintainerEnv }, 'Homebrew dependency discovery',
    ))
    const names = [...new Set([...roots.formulaRoots, ...dependencies])].sort(compareUtf8)
    const formulae = parseFormulae(parseJson(await runChecked(
      run, brew, ['info', '--json=v2', '--formula', ...names], { cwd: workspace, env: maintainerEnv }, 'Homebrew formula inspection',
    ), 'Homebrew formula metadata'), names, target)
    requireReachable(formulae, roots.formulaRoots)

    const verified = new Map()
    for (const formula of formulae.values()) {
      formula.bytes = await verifyDownload({ run, workspace, artifact: formula.bottle, verified })
    }
    const libreOfficeBytes = await verifyDownload({ run, workspace, artifact: cask, verified })
    for (const license of libreOfficeCandidate.directLicenses) {
      await verifyDownload({ run, workspace, artifact: license, verified })
    }
    const engines = deriveEngines(roots, cask, formulae, target, libreOfficeBytes)
    const closure = await discoverTargetClosure({ target, formulae, engines, verified, workspace, run, roots })
    const capturedFormulae = closure.formulae.map((selected) => {
      const formula = formulae.get(selected.name)
      return {
        name: formula.name, version: formula.version, revision: formula.revision, license: formula.license,
        dependencies: [...selected.dependencies],
        acquisition: {
          kind: 'homebrew-bottle', url: formula.bottle.url, sha256: formula.bottle.sha256,
          bytes: formula.bytes, cellar: expectedCellar(target),
        },
        licenses: capturedFormulaLicenseAssets(closure, formula.name, target),
      }
    })
    const measured = await authenticateAndMeasureClosure({
      target,
      closure,
      engines,
      formulae: capturedFormulae,
      verified,
      workspace,
      run,
    })
    const measuredClosure = { ...cloneJson(closure), measurements: measured.measurements }

    const payload = {
      schemaVersion: 1, target, repositoryRevision, homebrewCoreRevision: coreRevision,
      homebrewCaskRevision: caskRevision, roots: [...roots.formulaRoots], engines,
      formulae: capturedFormulae, probes: measured.probes, closure: measuredClosure,
    }
    await publishDurableLockFile({
      destination: output,
      bytes: canonicalBytes({ payloadSha256: sha256(canonicalBytes(payload)), payload }),
      mode: 0o600,
    })
  } catch (error) {
    primaryError = error
  }
  const cleanup = await Promise.allSettled([rm(workspace, { recursive: true, force: true })])
  const cleanupErrors = cleanup.filter((result) => result.status === 'rejected').map((result) => result.reason)
  if (primaryError !== undefined) {
    if (cleanupErrors.length > 0) throw new AggregateError([primaryError, ...cleanupErrors], primaryError?.message ?? 'Converter capture failed.', { cause: primaryError })
    throw primaryError
  }
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Converter capture cleanup failed.')
}

export async function captureHomebrewTargetMain(argv) {
  try {
    const args = parseArguments(argv, ['--target', '--brew', '--repository-revision', '--core-revision', '--cask-revision', '--roots', '--output'])
    const roots = (await readCanonicalJson(args['--roots'], 'Capture roots')).value
    await captureHomebrewTarget({
      target: args['--target'], brew: args['--brew'], repositoryRevision: args['--repository-revision'], coreRevision: args['--core-revision'], caskRevision: args['--cask-revision'], roots, output: args['--output'],
    })
    process.stdout.write('captured verified Homebrew converter target\n')
    return 0
  } catch {
    process.stderr.write('converter target capture failed\n')
    return 1
  }
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) process.exitCode = await captureHomebrewTargetMain(process.argv.slice(2))
