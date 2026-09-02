import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { lstat, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import process from 'node:process'
import { pathToFileURL, URL } from 'node:url'
import { validateTargetClosureLock } from './closure-lock.mjs'
import { materializeBottleUniverse } from './bottle-universe.mjs'
import { adhocSignMachOClosure, inspectMachO, planMachOClosure, relocateMachOClosure } from './macho-closure.mjs'
import { probeConverterFamily, stageProductionPacks } from './stage-production-packs.mjs'
import { buildConverterPackIndex } from './build-index.mjs'
import { buildNativeHelpers } from './build-native-helpers.mjs'
import { materializeLockedEngineAssets } from './locked-engine-assets.mjs'
import {
  canonicalBytes,
  compareUtf8,
  fail,
  parseArguments,
  readCanonicalJson,
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

function validateRoots(roots, target) {
  if (
    !exactKeys(roots, ['formulae', 'homebrewCaskRevision', 'engines', 'closure'])
    || !Array.isArray(roots.formulae)
    || roots.formulae.length === 0
    || roots.formulae.some((name) => typeof name !== 'string' || !formulaPattern.test(name))
    || new Set(roots.formulae).size !== roots.formulae.length
    || roots.formulae.some((name, index) => index > 0 && compareUtf8(roots.formulae[index - 1], name) >= 0)
    || !revisionPattern.test(roots.homebrewCaskRevision)
    || !Array.isArray(roots.engines)
    || roots.engines.length !== engineNames.length
    || roots.engines.some((engine, index) => !plainRecord(engine) || engine.name !== engineNames[index])
  ) invalid('Capture roots are invalid.')
  return validateTargetClosureLock(roots.closure, target)
}

function parseTapInfo(value, revision) {
  if (!Array.isArray(value) || value.length !== 1 || !plainRecord(value[0])) invalid('Homebrew tap metadata is invalid.')
  if (value[0].name !== 'homebrew/core' || value[0].installed !== true || value[0].HEAD !== revision) {
    invalid('Homebrew core revision does not match the pinned revision.')
  }
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
    if (!plainRecord(bottle) || bottle.cellar !== expectedCellar(target) || !validHttpsUrl(bottle.url) || !sha256Pattern.test(bottle.sha256)) {
      invalid('Homebrew formula bottle metadata is invalid for the selected target.')
    }
    byName.set(formula.name, {
      name: formula.name, version: formula.versions.stable, revision: formula.revision, license: formula.license,
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

function licenseAssets(closure, formula, target) {
  const values = []
  const seen = new Set()
  for (const family of familyNames) {
    for (const license of closure.families[family].licenses) {
      if (license.formula !== formula) continue
      const asset = license.source.startsWith('https://')
        ? { kind: 'download', url: license.source, sha256: license.sha256, bytes: license.bytes, destination: license.destination }
        : { kind: 'bottle-entry', target, path: license.source, sha256: license.sha256, bytes: license.bytes, destination: license.destination }
      const key = canonicalBytes(asset).toString('utf8')
      if (!seen.has(key)) {
        seen.add(key)
        values.push(asset)
      }
    }
  }
  values.sort((left, right) => compareUtf8(
    left.kind === 'download' ? `download\0${left.destination}\0${left.url}` : `bottle-entry\0${left.target}\0${left.destination}\0${left.path}`,
    right.kind === 'download' ? `download\0${right.destination}\0${right.url}` : `bottle-entry\0${right.target}\0${right.destination}\0${right.path}`,
  ))
  if (values.length === 0 && familyNames.some((family) => closure.families[family].files.some((file) => file.formula === formula))) {
    invalid('Contributing formula is missing a captured license.')
  }
  return values
}

function validateClosureFormulae(closure, formulae, roots) {
  const selectedNames = new Set(closure.formulae.map(({ name }) => name))
  const contributingFormulae = new Set(familyNames.flatMap((family) => (
    closure.families[family].files.map(({ formula }) => formula)
  )))
  if (roots.some((name) => !selectedNames.has(name))) invalid('Captured closure omits a root formula.')
  for (const selected of closure.formulae) {
    const formula = formulae.get(selected.name)
    const selectedDependencies = formula?.dependencies.filter((dependency) => selectedNames.has(dependency))
    if (
      !formula
      || formula.version !== selected.version
      || !contributingFormulae.has(selected.name)
      || canonicalBytes(selectedDependencies).compare(canonicalBytes(selected.dependencies)) !== 0
    ) {
      invalid('Captured closure formula identity differs from Homebrew metadata.')
    }
  }
  return selectedNames
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
  await runChecked(run, '/usr/bin/curl', [
    '--fail', '--location', '--proto', '=https', '--proto-redir', '=https',
    '--silent', '--show-error', '--output', path, artifact.url,
  ], { cwd: workspace, env: maintainerEnv }, 'Capture artifact download')
  const metadata = await stat(path).catch(() => undefined)
  if (!metadata?.isFile() || metadata.size <= 0 || (artifact.bytes !== undefined && metadata.size !== artifact.bytes)) {
    invalid('Downloaded capture artifact byte length differs from metadata.')
  }
  const bytes = await readFile(path)
  if (sha256(bytes) !== artifact.sha256) invalid('Downloaded capture artifact hash differs from metadata.')
  verified.set(artifact.sha256, { url: artifact.url, bytes: metadata.size, path })
  return metadata.size
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
  const downloadBytes = [...verified.values()].reduce((sum, artifact) => sum + artifact.bytes, 0)
  if (!Number.isSafeInteger(downloadBytes) || downloadBytes <= 0 || installedReleaseBytes <= 0) invalid('Capture measurement is invalid.')
  return {
    probes: probeDigests,
    measurements: { downloadBytes, compressedPackBytes, installedReleaseBytes },
  }
}

function validEngineLicense(license) {
  return exactKeys(license, ['kind', 'url', 'sha256', 'bytes', 'destination'])
    && license.kind === 'download'
    && validHttpsUrl(license.url)
    && sha256Pattern.test(license.sha256)
    && Number.isSafeInteger(license.bytes)
    && license.bytes > 0
    && typeof license.destination === 'string'
}

function validateEngine(engine, formulae, target) {
  if (
    !exactKeys(engine, ['name', 'version', 'license', 'rootFormula', 'acquisition', 'licenses'])
    || typeof engine.version !== 'string'
    || typeof engine.license !== 'string'
    || !Array.isArray(engine.licenses)
    || engine.licenses.some((license) => !validEngineLicense(license))
  ) {
    invalid('Captured engine identity is invalid.')
  }
  if (engine.name === 'libreoffice') {
    if (
      engine.rootFormula !== null || !exactKeys(engine.acquisition, ['kind', 'url', 'sha256', 'bytes', 'cellar'])
      || engine.acquisition.kind !== 'dmg' || !validHttpsUrl(engine.acquisition.url)
      || !sha256Pattern.test(engine.acquisition.sha256) || !Number.isSafeInteger(engine.acquisition.bytes)
      || engine.acquisition.bytes <= 0 || engine.acquisition.cellar !== null
    ) invalid('Captured LibreOffice identity is invalid.')
    if (engine.licenses.length === 0) invalid('Captured LibreOffice license is invalid.')
    return cloneJson(engine)
  }
  if (engine.licenses.length !== 0) invalid('Formula-backed engine licenses must be empty.')
  const formula = formulae.get(engine.rootFormula)
  if (!formula || formula.version !== engine.version || formula.license !== engine.license) invalid('Captured engine differs from its root formula.')
  const acquisition = {
    kind: 'homebrew-bottle', url: formula.bottle.url, sha256: formula.bottle.sha256,
    bytes: formula.bytes, cellar: expectedCellar(target),
  }
  if (!canonicalBytes(engine.acquisition).equals(canonicalBytes(acquisition))) invalid('Captured engine acquisition differs from its root formula.')
  return {
    name: engine.name, version: engine.version, license: engine.license,
    rootFormula: engine.rootFormula, acquisition, licenses: [],
  }
}

export async function captureHomebrewTarget({ target, brew, coreRevision, roots, output, run = defaultRun }) {
  if (!targets.has(target) || target !== expectedHostTarget()) invalid('Capture target does not match the maintainer host.')
  if (typeof brew !== 'string' || !isAbsolute(brew)) invalid('Homebrew executable must be an absolute path.')
  if (!revisionPattern.test(coreRevision)) invalid('Homebrew core revision must be an exact lowercase 40-hex commit.')
  requireAbsolutePath(output, 'Capture output')
  if (typeof run !== 'function') invalid('Maintainer command runner is invalid.')
  const parent = dirname(output)
  const parentMetadata = await lstat(parent).catch(() => undefined)
  if (!parentMetadata?.isDirectory() || parentMetadata.isSymbolicLink() || await realpath(parent).catch(() => undefined) !== parent) {
    invalid('Capture output parent must be canonical and non-symbolic.')
  }
  const closure = validateRoots(roots, target)
  const workspace = await mkdtemp(join(parent, '.converter-lock-capture-'))
  try {
    parseTapInfo(parseJson(await runChecked(
      run, brew, ['tap-info', '--json=v1', 'homebrew/core'], { cwd: workspace, env: maintainerEnv }, 'Homebrew tap inspection',
    ), 'Homebrew tap metadata'), coreRevision)
    const dependencies = dependencyNames(await runChecked(
      run, brew, ['deps', '--union', '--formula', ...roots.formulae], { cwd: workspace, env: maintainerEnv }, 'Homebrew dependency discovery',
    ))
    const names = [...new Set([...roots.formulae, ...dependencies])].sort(compareUtf8)
    const formulae = parseFormulae(parseJson(await runChecked(
      run, brew, ['info', '--json=v2', '--formula', ...names], { cwd: workspace, env: maintainerEnv }, 'Homebrew formula inspection',
    ), 'Homebrew formula metadata'), names, target)
    requireReachable(formulae, roots.formulae)
    const selectedNames = validateClosureFormulae(closure, formulae, roots.formulae)

    const verified = new Map()
    for (const formula of formulae.values()) {
      if (!selectedNames.has(formula.name)) continue
      formula.bytes = await verifyDownload({ run, workspace, artifact: formula.bottle, verified })
    }
    const engines = roots.engines.map((engine) => validateEngine(engine, formulae, target))
    const capturedFormulae = closure.formulae.map((selected) => {
      const formula = formulae.get(selected.name)
      return {
        name: formula.name, version: formula.version, revision: formula.revision, license: formula.license,
        dependencies: [...selected.dependencies],
        acquisition: {
          kind: 'homebrew-bottle', url: formula.bottle.url, sha256: formula.bottle.sha256,
          bytes: formula.bytes, cellar: expectedCellar(target),
        },
        licenses: licenseAssets(closure, formula.name, target),
      }
    })
    const extras = [
      ...engines.filter((engine) => engine.rootFormula === null).map((engine) => engine.acquisition),
      ...engines.flatMap((engine) => engine.licenses.map((license) => ({
        url: license.url, sha256: license.sha256, bytes: license.bytes,
      }))),
      ...capturedFormulae.flatMap((formula) => formula.licenses.filter((license) => license.kind === 'download').map((license) => ({
        url: license.url, sha256: license.sha256, bytes: license.bytes,
      }))),
    ]
    for (const artifact of extras) await verifyDownload({ run, workspace, artifact, verified })
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
      schemaVersion: 1, target, homebrewCoreRevision: coreRevision,
      homebrewCaskRevision: roots.homebrewCaskRevision, roots: [...roots.formulae], engines,
      formulae: capturedFormulae, probes: measured.probes, closure: measuredClosure,
    }
    await writeFile(output, canonicalBytes({ payloadSha256: sha256(canonicalBytes(payload)), payload }), { flag: 'wx', mode: 0o600 })
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

export async function captureHomebrewTargetMain(argv) {
  try {
    const args = parseArguments(argv, ['--target', '--brew', '--core-revision', '--roots', '--output'])
    const roots = (await readCanonicalJson(args['--roots'], 'Capture roots')).value
    await captureHomebrewTarget({
      target: args['--target'], brew: args['--brew'], coreRevision: args['--core-revision'], roots, output: args['--output'],
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
