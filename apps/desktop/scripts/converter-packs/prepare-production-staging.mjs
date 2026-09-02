import { mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { acquireLockedArtifacts } from './acquire-sources.mjs'
import { loadConverterClosureLock } from './closure-lock.mjs'
import { materializeBottleUniverse } from './bottle-universe.mjs'
import { materializeLockedEngineAssets } from './locked-engine-assets.mjs'
import { preflightDevelopmentCache } from './development-cache-budget.mjs'
import {
  canonicalBytes,
  fail,
  isPathInsideRoot,
  parseArguments,
  readStableRegularFile,
  requireAbsolutePath,
  requireDirectory,
  safeEntryPath,
  sha256,
} from './pack-tooling-lib.mjs'
import { settleCleanup } from './private-directory-publication.mjs'

async function materializeAuthenticatedLocks({ sourceLockPath, workspace, selected }) {
  const closureRelative = selected?.sourceLock?.closureLock?.path
  const expectedClosureBytes = selected?.sourceLock?.closureLock?.bytes
  const expectedClosureSha256 = selected?.sourceLock?.closureLock?.sha256
  if (
    !safeEntryPath(closureRelative)
    || !Number.isSafeInteger(expectedClosureBytes)
    || expectedClosureBytes <= 0
    || !/^[a-f0-9]{64}$/u.test(expectedClosureSha256)
  ) fail('Verified converter lock selection is invalid.')
  const sourceBytes = await readStableRegularFile(sourceLockPath, 'Source lock', 8 * 1024 * 1024)
  const closureBytes = await readStableRegularFile(
    resolve(dirname(sourceLockPath), closureRelative),
    'Target closure lock',
    expectedClosureBytes,
  )
  if (closureBytes.byteLength !== expectedClosureBytes || sha256(closureBytes) !== expectedClosureSha256) {
    fail('Target closure lock changed during private materialization.')
  }
  const locksRoot = join(workspace, 'locks')
  const privateSourceLock = join(locksRoot, 'sources.lock.json')
  const privateClosureLock = join(locksRoot, ...closureRelative.split('/'))
  await mkdir(dirname(privateClosureLock), { recursive: true, mode: 0o700 })
  await writeFile(privateSourceLock, sourceBytes, { flag: 'wx', mode: 0o400 })
  await writeFile(privateClosureLock, closureBytes, { flag: 'wx', mode: 0o400 })
  return {
    selected: await loadConverterClosureLock({ sourceLockPath: privateSourceLock, target: selected.target }),
    sourceLockPath: await realpath(privateSourceLock),
  }
}

const productionDependencies = Object.freeze({
  loadLocks: (request) => loadConverterClosureLock(request),
  materializeLocks: (request) => materializeAuthenticatedLocks(request),
  preflightCache: (request) => preflightDevelopmentCache(request),
  acquireSources: (request) => acquireLockedArtifacts(request),
  materializeUniverse: (request) => materializeBottleUniverse(request),
  materializeEngineAssets: (request) => materializeLockedEngineAssets(request),
})

function acquisitionSummary(acquired) {
  if (!(acquired?.blobs instanceof Map)) fail('Verified converter acquisition inventory is invalid.')
  let measuredNetworkBytes = 0
  const blobs = [...acquired.blobs.entries()].map(([key, blob]) => {
    if (
      typeof key !== 'string'
      || key !== blob?.sha256
      || !/^[a-f0-9]{64}$/u.test(key)
      || !Number.isSafeInteger(blob.bytes)
      || blob.bytes <= 0
      || !Number.isSafeInteger(blob.networkBytes)
      || blob.networkBytes < 0
    ) fail('Verified converter acquisition inventory is invalid.')
    measuredNetworkBytes += blob.networkBytes
    if (!Number.isSafeInteger(measuredNetworkBytes)) fail('Verified converter acquisition measurement is invalid.')
    return { bytes: blob.bytes, sha256: key }
  }).sort((left, right) => left.sha256 < right.sha256 ? -1 : left.sha256 > right.sha256 ? 1 : 0)
  if (acquired.networkBytes !== measuredNetworkBytes) fail('Verified converter acquisition measurement is invalid.')
  return { blobs, networkBytes: measuredNetworkBytes }
}

export async function prepareProductionStagingPlan(request, dependencies = productionDependencies) {
  for (const [value, label] of [
    [request.lockPath, 'Source lock'], [request.cacheRoot, 'Source cache'], [request.helpersRoot, 'Native helpers'],
    [request.workspace, 'Preparation workspace'], [request.staging, 'Staging output'], [request.planPath, 'Staging plan'],
  ]) requireAbsolutePath(value, label)
  if (request.target !== 'darwin-arm64' && request.target !== 'darwin-x64') fail('Staging preparation target is unsupported.')
  if (!Number.isSafeInteger(request.sequence) || request.sequence < 0) fail('Staging preparation sequence is invalid.')
  if (
    typeof dependencies?.loadLocks !== 'function'
    || typeof dependencies?.materializeLocks !== 'function'
    || typeof dependencies?.preflightCache !== 'function'
    || typeof dependencies?.acquireSources !== 'function'
    || typeof dependencies?.materializeUniverse !== 'function'
    || typeof dependencies?.materializeEngineAssets !== 'function'
    || (dependencies.removeWorkspace !== undefined && typeof dependencies.removeWorkspace !== 'function')
    || (request.afterMaterialize !== undefined && typeof request.afterMaterialize !== 'function')
  ) {
    fail('Staging preparation dependencies are invalid.')
  }
  await requireDirectory(request.cacheRoot, 'Source cache')
  if (request.afterMaterialize === undefined) await requireDirectory(request.helpersRoot, 'Native helpers')
  if (await realpath(dirname(request.workspace)).catch(() => undefined) !== dirname(request.workspace)) {
    fail('Preparation workspace parent must be canonical.')
  }
  await mkdir(request.workspace, { mode: 0o700 })
  try {
    const initial = await dependencies.loadLocks({ sourceLockPath: request.lockPath, target: request.target })
    if (initial?.target !== request.target || !initial.sourceLock || !initial.closureLock) {
      fail('Verified converter lock selection is invalid.')
    }
    const privateLocks = await dependencies.materializeLocks({
      sourceLockPath: request.lockPath,
      workspace: request.workspace,
      selected: initial,
    })
    const selected = privateLocks?.selected
    const privateSourceLock = privateLocks?.sourceLockPath
    if (
      selected?.target !== request.target
      || !selected.sourceLock
      || !selected.closureLock
      || typeof privateSourceLock !== 'string'
      || await realpath(privateSourceLock).catch(() => undefined) !== privateSourceLock
      || !isPathInsideRoot(request.workspace, privateSourceLock)
    ) fail('Private converter lock materialization is invalid.')
    await dependencies.preflightCache({
      cacheRoot: request.cacheRoot,
      requiredDownloadBytes: selected.closureLock?.measurements?.downloadBytes,
    })
    const acquired = await dependencies.acquireSources({ selected, cacheRoot: request.cacheRoot })
    const summary = acquisitionSummary(acquired)
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
    await request.afterMaterialize?.()
    await requireDirectory(request.helpersRoot, 'Native helpers')
    const canonicalUniverseRoot = await realpath(universeRoot)
    const canonicalEngineAssetsRoot = await realpath(engineAssetsRoot)
    const canonicalHelpersRoot = await realpath(request.helpersRoot)
    const value = {
      target: request.target,
      output: request.staging,
      version: request.version,
      sequence: request.sequence,
      generatedAt: request.generatedAt,
      archiveBaseUrl: request.archiveBaseUrl,
      sourceLockPath: privateSourceLock,
      universeRoot: canonicalUniverseRoot,
      helpersRoot: canonicalHelpersRoot,
      engineAssetsRoot: canonicalEngineAssetsRoot,
    }
    if (isPathInsideRoot(request.staging, request.planPath)) fail('Staging plan must remain outside staging output.')
    await writeFile(request.planPath, canonicalBytes(value), { flag: 'wx', mode: 0o600 })
    return summary
  } catch (error) {
    const removeWorkspace = dependencies.removeWorkspace ?? ((path) => rm(path, { recursive: true, force: true }))
    await settleCleanup(error, [() => removeWorkspace(request.workspace)], 'Staging preparation cleanup failed.')
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
