import { mkdir, realpath, rm, writeFile } from 'node:fs/promises'
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

export async function prepareProductionStagingPlanMain(argv, {
  stdout = process.stdout,
  stderr = process.stderr,
  prepare = prepareProductionStagingPlan,
} = {}) {
  try {
    const args = parseArguments(argv, [
      '--lock', '--target', '--cache', '--helpers', '--workspace', '--staging', '--plan',
      '--version', '--sequence', '--generated-at', '--archive-base-url',
    ])
    if (!/^(?:0|[1-9]\d*)$/u.test(args['--sequence'])) fail('Staging preparation sequence is invalid.')
    await prepare({
      lockPath: args['--lock'], target: args['--target'], cacheRoot: args['--cache'], helpersRoot: args['--helpers'],
      workspace: args['--workspace'], staging: args['--staging'], planPath: args['--plan'], version: args['--version'],
      sequence: Number(args['--sequence']), generatedAt: args['--generated-at'], archiveBaseUrl: args['--archive-base-url'],
    })
    stdout.write('prepared verified converter pack staging plan\n')
    return 0
  } catch {
    stderr.write('converter staging preparation failed\n')
    return 1
  }
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await prepareProductionStagingPlanMain(process.argv.slice(2))
}
