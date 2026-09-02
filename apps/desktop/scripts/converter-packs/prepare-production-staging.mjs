import { Buffer } from 'node:buffer'
import { lstat, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { acquireLockedArtifacts } from './acquire-sources.mjs'
import { loadConverterClosureLock } from './closure-lock.mjs'
import { materializeBottleUniverse } from './bottle-universe.mjs'
import { materializeLockedEngineAssets } from './locked-engine-assets.mjs'
import {
  canonicalBytes,
  fail,
  isPathInsideRoot,
  parseArguments,
  requireAbsolutePath,
  requireDirectory,
} from './pack-tooling-lib.mjs'

const maximumSourceLicenseWrappers = 64
const maximumSourceLicenseCandidates = 32

export async function selectVerifiedSourceLicense(root, names, label) {
  const rootMetadata = await lstat(root).catch(() => undefined)
  const canonicalRoot = await realpath(root).catch(() => undefined)
  if (!rootMetadata?.isDirectory() || rootMetadata.isSymbolicLink() || canonicalRoot !== root) {
    fail(`${label} source root must be a canonical directory and symbolic links are forbidden.`)
  }
  const acceptedNames = new Set(names)
  const candidates = []
  const byUtf8Name = (left, right) => Buffer.from(left.name).compare(Buffer.from(right.name))
  const inspectEntries = async (directory, entries) => {
    for (const entry of entries) {
      if (!acceptedNames.has(entry.name)) continue
      const path = join(directory, entry.name)
      const metadata = await lstat(path)
      if (!entry.isFile() || !metadata.isFile()) {
        fail(`${label} license has an unsupported file type in the verified source archive.`)
      }
      candidates.push({ name: entry.name, path })
      if (candidates.length > maximumSourceLicenseCandidates) {
        fail(`${label} license has too many candidates in the verified source archive.`)
      }
    }
  }

  const rootEntries = (await readdir(root, { withFileTypes: true })).sort(byUtf8Name)
  await inspectEntries(root, rootEntries)
  if (rootEntries.some((entry) => entry.isSymbolicLink())) {
    fail(`${label} source wrappers must not use symbolic links.`)
  }
  const wrappers = rootEntries.filter((entry) => entry.isDirectory())
  if (wrappers.length > maximumSourceLicenseWrappers) {
    fail(`${label} license search has too many directories in the verified source archive.`)
  }
  for (const wrapper of wrappers) {
    const directory = join(root, wrapper.name)
    const metadata = await lstat(directory).catch(() => undefined)
    const resolved = await realpath(directory).catch(() => undefined)
    if (
      !metadata?.isDirectory()
      || metadata.isSymbolicLink()
      || resolved !== directory
      || !isPathInsideRoot(canonicalRoot, resolved)
    ) {
      fail(`${label} license search encountered an unsupported source wrapper.`)
    }
    const entries = (await readdir(directory, { withFileTypes: true })).sort(byUtf8Name)
    await inspectEntries(directory, entries)
  }

  for (const name of names) {
    const matches = candidates.filter((candidate) => candidate.name === name)
    if (matches.length === 0) continue
    matches.sort((left, right) => left.path.length - right.path.length || Buffer.from(left.path).compare(Buffer.from(right.path)))
    const selected = matches[0].path
    const metadata = await lstat(selected).catch(() => undefined)
    const resolved = await realpath(selected).catch(() => undefined)
    if (
      !metadata?.isFile()
      || metadata.isSymbolicLink()
      || resolved !== selected
      || !isPathInsideRoot(canonicalRoot, resolved)
    ) {
      fail(`${label} license must resolve to a canonical regular file inside the verified source root.`)
    }
    return resolved
  }
  fail(`${label} license is missing from the verified source archive.`)
}

const productionDependencies = Object.freeze({
  loadLocks: (request) => loadConverterClosureLock(request),
  acquireSources: (request) => acquireLockedArtifacts(request),
  materializeUniverse: (request) => materializeBottleUniverse(request),
  materializeEngineAssets: (request) => materializeLockedEngineAssets(request),
})

export async function prepareProductionStagingPlan(request, dependencies = productionDependencies) {
  for (const [value, label] of [
    [request.lockPath, 'Source lock'], [request.cacheRoot, 'Source cache'], [request.helpersRoot, 'Native helpers'],
    [request.workspace, 'Preparation workspace'], [request.staging, 'Staging output'], [request.planPath, 'Staging plan'],
  ]) requireAbsolutePath(value, label)
  if (request.target !== 'darwin-arm64' && request.target !== 'darwin-x64') fail('Staging preparation target is unsupported.')
  if (!Number.isSafeInteger(request.sequence) || request.sequence < 0) fail('Staging preparation sequence is invalid.')
  if (
    typeof dependencies?.loadLocks !== 'function'
    || typeof dependencies?.acquireSources !== 'function'
    || typeof dependencies?.materializeUniverse !== 'function'
    || typeof dependencies?.materializeEngineAssets !== 'function'
  ) {
    fail('Staging preparation dependencies are invalid.')
  }
  await Promise.all([
    requireDirectory(request.cacheRoot, 'Source cache'),
    requireDirectory(request.helpersRoot, 'Native helpers'),
  ])
  if (await realpath(dirname(request.workspace)).catch(() => undefined) !== dirname(request.workspace)) {
    fail('Preparation workspace parent must be canonical.')
  }
  await mkdir(request.workspace, { mode: 0o700 })
  try {
    const selected = await dependencies.loadLocks({ sourceLockPath: request.lockPath, target: request.target })
    if (selected?.target !== request.target || !selected.sourceLock || !selected.closureLock) {
      fail('Verified converter lock selection is invalid.')
    }
    const acquired = await dependencies.acquireSources({ selected, cacheRoot: request.cacheRoot })
    if (!(acquired?.blobs instanceof Map)) fail('Verified converter acquisition inventory is invalid.')
    const universeRoot = join(request.workspace, 'universe')
    const engineAssetsRoot = join(request.workspace, 'engine-assets')
    await dependencies.materializeUniverse({
      target: request.target,
      closureLock: selected.closureLock,
      formulae: selected.sourceLock.formulae,
      blobs: acquired.blobs,
      outputRoot: universeRoot,
    })
    await dependencies.materializeEngineAssets({
      target: request.target,
      sourceLock: selected.sourceLock,
      closureLock: selected.closureLock,
      blobs: acquired.blobs,
      outputRoot: engineAssetsRoot,
    })
    const value = {
      target: request.target,
      output: request.staging,
      version: request.version,
      sequence: request.sequence,
      generatedAt: request.generatedAt,
      archiveBaseUrl: request.archiveBaseUrl,
      sourceLockPath: request.lockPath,
      universeRoot,
      helpersRoot: request.helpersRoot,
      engineAssetsRoot,
    }
    if (isPathInsideRoot(request.staging, request.planPath)) fail('Staging plan must remain outside staging output.')
    await writeFile(request.planPath, canonicalBytes(value), { flag: 'wx', mode: 0o600 })
  } catch (error) {
    await rm(request.workspace, { recursive: true, force: true })
    throw error
  }
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const args = parseArguments(process.argv.slice(2), [
    '--lock', '--target', '--cache', '--helpers', '--workspace', '--staging', '--plan',
    '--version', '--sequence', '--generated-at', '--archive-base-url',
  ])
  if (!/^(?:0|[1-9]\d*)$/u.test(args['--sequence'])) fail('Staging preparation sequence is invalid.')
  await prepareProductionStagingPlan({
    lockPath: args['--lock'], target: args['--target'], cacheRoot: args['--cache'], helpersRoot: args['--helpers'],
    workspace: args['--workspace'], staging: args['--staging'], planPath: args['--plan'], version: args['--version'],
    sequence: Number(args['--sequence']), generatedAt: args['--generated-at'], archiveBaseUrl: args['--archive-base-url'],
  })
  process.stdout.write('prepared verified converter pack staging plan\n')
}
