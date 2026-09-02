import { spawnSync } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { chmod, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { pathToFileURL, URL } from 'node:url'
import {
  canonicalBytes,
  compareUtf8,
  fail,
  firstReleaseTarget,
  isPathInsideRoot,
  parseArguments,
  readCanonicalJson,
  readStableRegularFile,
  requireAbsolutePath,
  safeEntryPath,
  sha256,
  validateExecutableSet,
} from './pack-tooling-lib.mjs'
import { adhocSignMachOClosure, inspectMachO, planMachOClosure, relocateMachOClosure } from './macho-closure.mjs'
import { validateTargetClosureLock } from './closure-lock.mjs'

const familyNames = Object.freeze(['image-icon', 'document', 'pdf', 'media'])
const exactExecutables = Object.freeze({
  'image-icon': Object.freeze(['bin/autoforge-image-converter', 'bin/vips']),
  document: Object.freeze(['program/soffice']),
  pdf: Object.freeze(['bin/autoforge-pdf-raster', 'bin/pdfinfo', 'bin/pdftocairo']),
  media: Object.freeze(['bin/ffmpeg', 'bin/ffprobe']),
})
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u

function plainRecord(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value, keys) {
  return plainRecord(value)
    && Object.keys(value).sort(compareUtf8).join('\0') === [...keys].sort(compareUtf8).join('\0')
}

function validateArchiveBase(value) {
  let parsed
  try { parsed = new URL(value) } catch { fail('Archive base URL is invalid.') }
  if (
    parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
    || parsed.pathname.endsWith('/')
    || parsed.href !== value
  ) fail('Archive base URL is invalid.')
  return value
}

function validateRequest(request) {
  if (!exactKeys(request, [
    'target', 'output', 'version', 'sequence', 'generatedAt', 'archiveBaseUrl', 'closureLockPath', 'universeRoot',
  ])) fail('Pack staging request is invalid.')
  if (request.target !== 'darwin-arm64' && request.target !== 'darwin-x64') {
    fail('Pack staging target is unsupported.')
  }
  const [platform, targetArch] = request.target.split('-')
  const arch = targetArch === 'x64' ? 'x64' : targetArch
  if (!firstReleaseTarget(platform, arch)) fail('Pack staging target is unsupported.')
  requireAbsolutePath(request.output, 'Staging output')
  if (typeof request.version !== 'string' || !versionPattern.test(request.version)) fail('Pack version is invalid.')
  if (!Number.isSafeInteger(request.sequence) || request.sequence < 0) fail('Pack release sequence is invalid.')
  try {
    if (new Date(request.generatedAt).toISOString() !== request.generatedAt) fail('Pack generatedAt is invalid.')
  } catch { fail('Pack generatedAt is invalid.') }
  validateArchiveBase(request.archiveBaseUrl)
  requireAbsolutePath(request.closureLockPath, 'Target closure lock')
  requireAbsolutePath(request.universeRoot, 'Bottle universe root')
  return { platform, arch, machoArchitecture: arch === 'x64' ? 'x86_64' : arch }
}

async function defaultRun(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin', TMPDIR: options.cwd },
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

async function probeCommand(run, executable, args, payload) {
  const result = await run(executable, args, { cwd: payload })
  if (!result || result.status !== 0 || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') {
    fail(`Converter capability command failed: ${executable}`)
  }
  return `${result.stdout}\n${result.stderr}`
}

function requireTokens(output, tokens) {
  for (const token of tokens) {
    const pattern = new RegExp(`(?:^|[^A-Za-z0-9_-])${token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?:[^A-Za-z0-9_-]|$)`, 'iu')
    if (!pattern.test(output)) fail(`Converter capability is missing: ${token}`)
  }
}

function requireFragments(output, fragments) {
  for (const fragment of fragments) {
    if (!output.toLowerCase().includes(fragment)) fail(`Converter capability is missing: ${fragment}`)
  }
}

export async function probeConverterFamily({ name, payload, executables }, { run = defaultRun } = {}) {
  if (name === 'image-icon') {
    await probeCommand(run, executables['bin/vips'], ['--version'], payload)
    const formats = await probeCommand(run, executables['bin/vips'], ['-l', 'foreign'], payload)
    requireFragments(formats, [
      'jpegload', 'jpegsave', 'pngload', 'pngsave', 'webpload', 'webpsave',
      'heifload', 'heifsave', 'tiffload', 'tiffsave', 'gifload', 'svgload', 'magicksave',
    ])
    return
  }
  if (name === 'document') {
    await probeCommand(run, executables['program/soffice'], ['--headless', '--version'], payload)
    return
  }
  if (name === 'pdf') {
    await probeCommand(run, executables['bin/pdfinfo'], ['-v'], payload)
    await probeCommand(run, executables['bin/pdftocairo'], ['-v'], payload)
    return
  }
  if (name === 'media') {
    await probeCommand(run, executables['bin/ffprobe'], ['-version'], payload)
    const encoders = await probeCommand(run, executables['bin/ffmpeg'], ['-hide_banner', '-encoders'], payload)
    const muxers = await probeCommand(run, executables['bin/ffmpeg'], ['-hide_banner', '-muxers'], payload)
    requireTokens(encoders, ['libmp3lame', 'pcm_s16le', 'aac', 'flac', 'libvorbis', 'libopus', 'libx264', 'libvpx-vp9', 'gif'])
    requireTokens(muxers, ['mp3', 'wav', 'ipod', 'adts', 'flac', 'ogg', 'opus', 'mp4', 'webm', 'mov', 'gif'])
    return
  }
  fail('Converter pack family is unsupported.')
}

const productionDependencies = Object.freeze({
  loadClosure: async ({ closureLockPath, target }) => validateTargetClosureLock(
    (await readCanonicalJson(closureLockPath, 'Target closure lock')).value,
    target,
  ),
  openUniverse: ({ universeRoot, closureLock }) => openLockedUniverse({ universeRoot, closureLock }),
  planClosure: ({ entrypoints, architecture, universe, expectedFiles, expectedRewrites }) => planMachOClosure({
    entrypoints,
    architecture,
    universe,
    expectedFiles,
    expectedRewrites,
    inspect: (path) => inspectMachO(path),
  }),
  applyRelocation: async ({ payload, architecture, plan }) => {
    await relocateMachOClosure({ payload, architecture, plan })
    await adhocSignMachOClosure({ payload, plan })
  },
  probeFamily: (request) => probeConverterFamily(request),
})

function currentRegular(path) {
  try {
    const metadata = lstatSync(path)
    return metadata.isFile()
      && !metadata.isSymbolicLink()
      && metadata.nlink === 1
      && realpathSync(path) === path
  } catch {
    return false
  }
}

function currentDirectory(path) {
  try {
    const metadata = lstatSync(path)
    return metadata.isDirectory() && !metadata.isSymbolicLink() && realpathSync(path) === path
  } catch {
    return false
  }
}

function openLockedUniverse({ universeRoot, closureLock }) {
  if (!currentDirectory(universeRoot)) fail('Bottle universe root must be canonical and non-symbolic.')
  const formulae = new Map(closureLock.formulae.map((formula) => [formula.name, formula.version]))
  const selected = new Set()
  for (const family of Object.values(closureLock.families)) {
    for (const file of family.files) selected.add(`${file.formula}\0${file.sourcePath}`)
    for (const license of family.licenses) {
      if (!license.source.startsWith('https://')) selected.add(`${license.formula}\0${license.source}`)
    }
  }
  const formulaRoot = (formula, version) => {
    if (formulae.get(formula) !== version) fail('Bottle universe formula is not locked.')
    const root = join(universeRoot, 'Cellar', formula, version)
    if (!currentDirectory(root) || !isPathInsideRoot(universeRoot, root)) fail('Bottle universe formula root is unsafe.')
    return root
  }
  return Object.freeze({
    target: closureLock.target,
    cellar: formulaRoot,
    opt(formula) {
      const version = formulae.get(formula)
      if (!version) fail('Bottle universe formula is not locked.')
      return formulaRoot(formula, version)
    },
    resolveLockedFile(formula, sourcePath) {
      if (!selected.has(`${formula}\0${sourcePath}`)) fail('Bottle universe file is not locked.')
      const version = formulae.get(formula)
      if (!version) fail('Bottle universe formula is not locked.')
      const path = join(formulaRoot(formula, version), ...sourcePath.split('/'))
      if (!isPathInsideRoot(universeRoot, path) || !currentRegular(path)) fail('Bottle universe file is unsafe.')
      return path
    },
    contains(path) {
      return typeof path === 'string' && isPathInsideRoot(universeRoot, path) && (currentRegular(path) || currentDirectory(path))
    },
  })
}

async function copyDeclaredFile({ source, destination, role, payload, seen, expectedBytes, expectedSha256 }) {
  if (!safeEntryPath(destination) || (role !== 'executable' && role !== 'code' && role !== 'data' && role !== 'license')) {
    fail('Staged file declaration is invalid.')
  }
  const key = destination.toLowerCase()
  if (seen.has(key)) fail(`Staged file destination collision: ${destination}`)
  requireAbsolutePath(source, 'Staged file source')
  const bytes = await readStableRegularFile(source, 'Staged file source')
  if (expectedBytes !== undefined && (bytes.byteLength !== expectedBytes || sha256(bytes) !== expectedSha256)) {
    fail(`Staged file differs from its locked inventory: ${destination}`)
  }
  const target = join(payload, ...destination.split('/'))
  await mkdir(dirname(target), { recursive: true, mode: 0o755 })
  await writeFile(target, bytes, { flag: 'wx', mode: role === 'executable' ? 0o755 : 0o644 })
  if (role === 'executable') await chmod(target, 0o755)
  seen.add(key)
  return { path: destination, role }
}

function validateFamily(name, family) {
  if (!exactKeys(family, ['files', 'rewrites', 'licenses']) || !Array.isArray(family.files) || !Array.isArray(family.rewrites) || !Array.isArray(family.licenses)) {
    fail(`Pack family is invalid: ${name}`)
  }
  const destinations = family.files.filter((file) => file?.executable).map((file) => file.destination)
  if (
    destinations.length !== exactExecutables[name].length
    || [...destinations].sort(compareUtf8).join('\0') !== [...exactExecutables[name]].sort(compareUtf8).join('\0')
  ) fail(`Pack family executable inventory is invalid: ${name}`)
  validateExecutableSet(name, 'darwin', destinations)
  if (family.licenses.length === 0) fail(`Pack family is missing a license: ${name}`)
}

function planFileKey(file) {
  return `${file.destination}\0${file.formula}\0${file.role}\0${String(file.executable)}`
}

function rewriteKey(rewrite) {
  return `${rewrite.destination}\0${rewrite.dependency}\0${rewrite.replacement}`
}

function validateExactPlan(name, plan, family, universe) {
  if (!plainRecord(plan) || !Array.isArray(plan.files) || !Array.isArray(plan.rewrites)) {
    fail(`Mach-O closure plan is invalid: ${name}`)
  }
  const expectedFiles = [...family.files].sort((left, right) => compareUtf8(planFileKey(left), planFileKey(right)))
  const actualFiles = [...plan.files].sort((left, right) => compareUtf8(planFileKey(left), planFileKey(right)))
  if (actualFiles.length !== expectedFiles.length) fail(`Mach-O closure plan differs from its locked inventory: ${name}`)
  for (let index = 0; index < expectedFiles.length; index += 1) {
    const actual = actualFiles[index]
    const expected = expectedFiles[index]
    if (
      !exactKeys(actual, ['source', 'destination', 'executable', 'formula', 'role'])
      || planFileKey(actual) !== planFileKey(expected)
      || actual.source !== universe.resolveLockedFile(expected.formula, expected.sourcePath)
      || !universe.contains(actual.source)
    ) fail(`Mach-O closure plan differs from its locked inventory: ${name}`)
  }
  const expectedRewrites = [...family.rewrites].sort((left, right) => compareUtf8(rewriteKey(left), rewriteKey(right)))
  const actualRewrites = [...plan.rewrites].sort((left, right) => compareUtf8(rewriteKey(left), rewriteKey(right)))
  if (
    actualRewrites.length !== expectedRewrites.length
    || actualRewrites.some((rewrite, index) => rewriteKey(rewrite) !== rewriteKey(expectedRewrites[index]))
  ) fail(`Mach-O closure rewrites differ from their locked inventory: ${name}`)
}

export async function stageProductionPacks(request, dependencies = productionDependencies) {
  const target = validateRequest(request)
  if (
    !plainRecord(dependencies)
    || typeof dependencies.planClosure !== 'function'
    || typeof dependencies.applyRelocation !== 'function'
    || typeof dependencies.probeFamily !== 'function'
    || (dependencies.loadClosure !== undefined && typeof dependencies.loadClosure !== 'function')
    || (dependencies.openUniverse !== undefined && typeof dependencies.openUniverse !== 'function')
  ) fail('Pack staging dependencies are invalid.')
  if (await realpath(dirname(request.output)).catch(() => undefined) !== dirname(request.output)) {
    fail('Staging output parent must be a canonical directory.')
  }

  await mkdir(request.output, { mode: 0o700 })
  try {
    const loadClosure = dependencies.loadClosure ?? productionDependencies.loadClosure
    const openUniverse = dependencies.openUniverse ?? productionDependencies.openUniverse
    const closureLock = await loadClosure({ closureLockPath: request.closureLockPath, target: request.target })
    if (!plainRecord(closureLock) || closureLock.target !== request.target || !exactKeys(closureLock.families, familyNames)) {
      fail('Target closure lock does not match the staging request.')
    }
    const universe = await openUniverse({ universeRoot: request.universeRoot, closureLock })
    if (!universe || universe.target !== request.target || typeof universe.resolveLockedFile !== 'function') {
      fail('Bottle universe does not match the staging request.')
    }
    const packsRoot = join(request.output, 'packs')
    await mkdir(packsRoot, { mode: 0o755 })
    for (const name of familyNames) {
      const family = closureLock.families[name]
      validateFamily(name, family)
      const packRoot = join(packsRoot, `${name}-${request.target}`)
      const payload = join(packRoot, 'payload')
      await mkdir(payload, { recursive: true, mode: 0o755 })
      const entrypoints = family.files.filter((file) => file.executable).map((file) => ({
        source: universe.resolveLockedFile(file.formula, file.sourcePath),
        destination: file.destination,
      }))
      const plan = await dependencies.planClosure({
        entrypoints,
        architecture: target.machoArchitecture,
        universe,
        expectedFiles: family.files,
        expectedRewrites: family.rewrites,
      })
      validateExactPlan(name, plan, family, universe)
      const seen = new Set()
      const files = []
      for (const file of plan.files) {
        if (!exactKeys(file, ['source', 'destination', 'executable', 'formula', 'role'])) fail(`Mach-O closure file is invalid: ${name}`)
        files.push(await copyDeclaredFile({
          source: file.source,
          destination: file.destination,
          role: file.role,
          payload,
          seen,
          expectedBytes: family.files.find((expected) => expected.destination === file.destination)?.bytes,
          expectedSha256: family.files.find((expected) => expected.destination === file.destination)?.sha256,
        }))
      }
      for (const license of family.licenses) {
        if (license.source.startsWith('https://')) fail('Remote licenses must be materialized before pack staging.')
        files.push(await copyDeclaredFile({
          source: universe.resolveLockedFile(license.formula, license.source),
          destination: license.destination,
          role: 'license',
          payload,
          seen,
          expectedBytes: license.bytes,
          expectedSha256: license.sha256,
        }))
      }
      await dependencies.applyRelocation({ name, payload, plan, architecture: target.machoArchitecture })
      await dependencies.probeFamily({
        name,
        payload,
        executables: Object.fromEntries(exactExecutables[name].map((path) => [path, join(payload, ...path.split('/'))])),
      })
      files.sort((left, right) => compareUtf8(left.path, right.path))
      await writeFile(join(packRoot, 'pack.json'), canonicalBytes({
        schemaVersion: 1,
        name,
        version: request.version,
        platform: target.platform,
        arch: target.arch,
        archiveUrl: `${request.archiveBaseUrl}/${name}-${request.version}-${request.target}.tar`,
        files,
      }), { flag: 'wx', mode: 0o600 })
    }
    await writeFile(join(request.output, 'release.json'), canonicalBytes({
      schemaVersion: 1,
      generatedAt: request.generatedAt,
      sequence: request.sequence,
    }), { flag: 'wx', mode: 0o600 })
  } catch (error) {
    await rm(request.output, { recursive: true, force: true })
    throw error
  }
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const args = parseArguments(process.argv.slice(2), ['--plan'])
  const planPath = args['--plan']
  requireAbsolutePath(planPath, 'Staging plan')
  const request = (await readCanonicalJson(planPath, 'Staging plan')).value
  await stageProductionPacks(request)
  process.stdout.write('staged four production converter pack families\n')
}
