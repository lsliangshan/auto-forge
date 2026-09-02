import { Buffer } from 'node:buffer'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'
import {
  activateDevelopmentRelease,
  createDevelopmentPreparationWorkspace,
  developmentReleasePaths,
  fingerprintDevelopmentRelease,
  readActiveDevelopmentRelease,
  recoverInterruptedActiveReplacement,
  removeInactiveDevelopmentRelease,
  replaceActiveDevelopmentRelease,
  writeDevelopmentReleaseMetadata,
} from './local-development-release-cache.mjs'
import { pruneDevelopmentCache } from './development-cache-budget.mjs'
import { buildNativeHelpers, nativeHelperSourceInventory } from './build-native-helpers.mjs'
import { prepareProductionStagingPlan } from './prepare-production-staging.mjs'
import { stageProductionPacks } from './stage-production-packs.mjs'
import {
  buildLocalDevelopmentRelease,
  verifyLocalDevelopmentReleaseIntegrity,
} from './build-local-development-release.mjs'
import { smokeTestLocalDevelopmentRelease } from './verify-local-development-release.mjs'
import { canonicalBytes, readStableRegularFile, safeEntryPath } from './pack-tooling-lib.mjs'
import { settleCleanup } from './private-directory-publication.mjs'

const fingerprintScriptPaths = Object.freeze([
  'scripts/converter-packs/source-lock.mjs',
  'scripts/converter-packs/closure-lock.mjs',
  'scripts/converter-packs/acquire-sources.mjs',
  'scripts/converter-packs/bottle-archive.mjs',
  'scripts/converter-packs/bottle-universe.mjs',
  'scripts/converter-packs/development-cache-budget.mjs',
  'scripts/converter-packs/build-native-helpers.mjs',
  'scripts/converter-packs/locked-engine-assets.mjs',
  'scripts/converter-packs/local-development-release-cache.mjs',
  'scripts/converter-packs/private-directory-publication.mjs',
  'scripts/converter-packs/prepare-local-development-release.mjs',
  'scripts/converter-packs/prepare-production-staging.mjs',
  'scripts/converter-packs/macho-closure.mjs',
  'scripts/converter-packs/stage-production-packs.mjs',
  'scripts/converter-packs/build-index.mjs',
  'scripts/converter-packs/sign-index.mjs',
  'scripts/converter-packs/pack-tooling-lib.mjs',
  'scripts/converter-packs/build-local-development-release.mjs',
  'scripts/converter-packs/verify-local-development-release.mjs',
])
const developmentPrivateKeyDer = Buffer.from(
  '302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
  'hex',
)
const requestKeys = Object.freeze(['desktopRoot', 'cacheRoot', 'platform', 'arch', 'compiler'])
const maximumNativeHelperSourceBytes = 1024 * 1024
const maximumNativeHelperInventoryBytes = 4 * 1024 * 1024

const productionDependencies = Object.freeze({
  buildHelpers: (request) => buildNativeHelpers(request),
  preparePlan: (request) => prepareProductionStagingPlan(request),
  stagePacks: ({ plan }) => stageProductionPacks(plan),
  buildRelease: (request) => buildLocalDevelopmentRelease(request),
  verifyRelease: (request) => verifyLocalDevelopmentReleaseIntegrity(request),
  smokeRelease: (request) => smokeTestLocalDevelopmentRelease(request),
  writeMetadata: (request) => writeDevelopmentReleaseMetadata(request),
  replaceActiveRelease: (request) => replaceActiveDevelopmentRelease(request),
  activateRelease: ({ cacheRoot, fingerprint }) => activateDevelopmentRelease({ cacheRoot, fingerprint }),
  pruneCache: (request) => pruneDevelopmentCache({ ...request, migrateLegacyReleases: true }),
})

function isPlainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function requireRequest(request) {
  if (!isPlainRecord(request) || Object.keys(request).sort().join('\0') !== [...requestKeys].sort().join('\0')) {
    throw new Error('Local development preparation request is invalid')
  }
  if (request.platform !== 'darwin' || (request.arch !== 'arm64' && request.arch !== 'x64')) {
    throw new Error('Local development preparation target is unsupported')
  }
  if (typeof request.compiler !== 'string' || !isAbsolute(request.compiler)) {
    throw new Error('Local development preparation compiler must be absolute')
  }
}

async function canonicalDirectory(path, label) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) throw new Error(`${label} must be canonical and absolute`)
  const metadata = await lstat(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(path) !== path) {
    throw new Error(`${label} must be a canonical non-symbolic directory`)
  }
  return path
}

function relativeInputPath(root, path) {
  const value = relative(root, path).split('\\').join('/')
  if (!value || value === '..' || value.startsWith('../') || value.includes('/../')) {
    throw new Error('Development fingerprint input is outside desktop root')
  }
  return value
}

async function regularFileUnderRoot(desktopRoot, path) {
  return {
    path: relativeInputPath(desktopRoot, path),
    bytes: await readStableRegularFile(path, 'Development fingerprint input'),
  }
}

async function nativeInputs(desktopRoot) {
  const nativeRoot = join(desktopRoot, 'converter-packs', 'native')
  const metadata = await lstat(nativeRoot)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(nativeRoot) !== nativeRoot) {
    throw new Error('Development native helper tree must be a canonical non-symbolic directory')
  }
  const files = []
  let totalBytes = 0
  for (const relativePath of nativeHelperSourceInventory()) {
    const input = await regularFileUnderRoot(desktopRoot, join(nativeRoot, ...relativePath.split('/')))
    if (input.bytes.byteLength > maximumNativeHelperSourceBytes) {
      throw new Error('Development native helper source exceeds its byte limit')
    }
    totalBytes += input.bytes.byteLength
    if (!Number.isSafeInteger(totalBytes) || totalBytes > maximumNativeHelperInventoryBytes) {
      throw new Error('Development native helper inventory exceeds its byte limit')
    }
    files.push(input)
  }
  return files
}

export async function developmentFingerprintInputs(desktopRoot) {
  await canonicalDirectory(desktopRoot, 'Desktop root')
  const sourcePath = join(desktopRoot, 'converter-packs', 'sources.lock.json')
  const sourceInput = await regularFileUnderRoot(desktopRoot, sourcePath)
  let sourceLock
  try {
    sourceLock = JSON.parse(sourceInput.bytes.toString('utf8'))
  } catch {
    throw new Error('Development source lock is not valid JSON')
  }
  if (!sourceInput.bytes.equals(canonicalBytes(sourceLock))) throw new Error('Development source lock is not canonical JSON')
  const closureLocks = sourceLock?.closureLocks
  const targets = ['darwin-arm64', 'darwin-x64']
  if (
    !isPlainRecord(closureLocks)
    || Object.keys(closureLocks).sort().join('\0') !== targets.join('\0')
    || targets.some((target) => !isPlainRecord(closureLocks[target]) || !safeEntryPath(closureLocks[target].path))
  ) throw new Error('Development source lock closure coordinates are invalid')
  const inputs = [
    sourceInput,
    ...await Promise.all(targets.map((target) => regularFileUnderRoot(
      desktopRoot,
      join(desktopRoot, 'converter-packs', ...closureLocks[target].path.split('/')),
    ))),
    ...await nativeInputs(desktopRoot),
  ]
  for (const path of fingerprintScriptPaths) {
    inputs.push(await regularFileUnderRoot(desktopRoot, join(desktopRoot, ...path.split('/'))))
  }
  inputs.sort((left, right) => Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8')))
  return inputs
}

function validateDependencies(dependencies) {
  if (!isPlainRecord(dependencies) || [
    'buildHelpers', 'preparePlan', 'stagePacks', 'buildRelease', 'verifyRelease', 'smokeRelease',
    'writeMetadata', 'replaceActiveRelease', 'activateRelease', 'pruneCache',
  ].some((name) => typeof dependencies[name] !== 'function')
    || (dependencies.removeRelease !== undefined && typeof dependencies.removeRelease !== 'function')
    || (dependencies.removePrivateRoot !== undefined && typeof dependencies.removePrivateRoot !== 'function')) {
    throw new Error('Local development preparation dependencies are invalid')
  }
}

async function hasRelease(path) {
  return Boolean(await lstat(path).catch((error) => {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }))
}

async function materializeLockSnapshot(privateRoot, inputs) {
  const sourceRelativePath = 'converter-packs/sources.lock.json'
  const sourceInput = inputs.find((input) => input.path === sourceRelativePath)
  if (!sourceInput) throw new Error('Development source lock fingerprint input is missing')
  let sourceLock
  try {
    sourceLock = JSON.parse(sourceInput.bytes.toString('utf8'))
  } catch {
    throw new Error('Development source lock fingerprint input is invalid')
  }
  const selected = [
    sourceInput,
    ...['darwin-arm64', 'darwin-x64'].map((target) => {
      const path = `converter-packs/${sourceLock.closureLocks[target].path}`
      const input = inputs.find((candidate) => candidate.path === path)
      if (!input) throw new Error('Development closure lock fingerprint input is missing')
      return input
    }),
  ]
  const snapshotRoot = join(privateRoot, 'input-locks')
  for (const input of selected) {
    const path = join(snapshotRoot, ...input.path.split('/'))
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, input.bytes, { flag: 'wx', mode: 0o444 })
  }
  return join(snapshotRoot, ...sourceRelativePath.split('/'))
}

export async function prepareLocalDevelopmentRelease(request, dependencies = productionDependencies) {
  requireRequest(request)
  validateDependencies(dependencies)
  const desktopRoot = await canonicalDirectory(request.desktopRoot, 'Desktop root')
  const cacheRoot = await canonicalDirectory(request.cacheRoot, 'Development cache root')
  const target = `${request.platform}-${request.arch}`
  const inputs = await developmentFingerprintInputs(desktopRoot)
  const fingerprint = fingerprintDevelopmentRelease({ target, inputs })
  const paths = developmentReleasePaths(cacheRoot, fingerprint)
  const removeRelease = dependencies.removeRelease ?? (() => removeInactiveDevelopmentRelease({ cacheRoot, fingerprint }))
  const removePrivateRoot = dependencies.removePrivateRoot ?? ((path) => rm(path, { recursive: true, force: true }))

  await recoverInterruptedActiveReplacement({ cacheRoot })
  const activeRelease = await readActiveDevelopmentRelease({ cacheRoot }).catch((error) => {
    if (error?.code === 'ENOENT') return undefined
    throw error
  })
  let replaceActive = false
  if (activeRelease === paths.release) {
    try {
      await dependencies.verifyRelease({ releaseRoot: paths.release, platform: request.platform, arch: request.arch })
    } catch {
      replaceActive = true
    }
    if (!replaceActive) {
      await dependencies.pruneCache({ cacheRoot, activeFingerprint: fingerprint })
      return { fingerprint, releaseRoot: paths.release, reused: true }
    }
  }
  if (!replaceActive && await hasRelease(paths.release)) await removeRelease(paths.release)

  const privateRoot = await createDevelopmentPreparationWorkspace({ cacheRoot, fingerprint })
  let primaryError
  try {
    const helpersRoot = join(privateRoot, 'helpers')
    const workspace = join(privateRoot, 'workspace')
    const stagingRoot = join(privateRoot, 'staging')
    const planPath = join(privateRoot, 'plan.json')
    const signingRoot = join(privateRoot, 'signing-key')
    const privateKeyPath = join(signingRoot, 'private.pem')
    const publicKeyPath = join(signingRoot, 'public.pem')
    const lockPath = await materializeLockSnapshot(privateRoot, inputs)
    const releaseOutput = replaceActive ? join(privateRoot, 'replacement-release') : paths.release
    await mkdir(join(cacheRoot, 'sources'), { recursive: true, mode: 0o700 })
    await mkdir(join(cacheRoot, 'releases'), { recursive: true, mode: 0o700 })
    await mkdir(signingRoot, { mode: 0o700 })
    const developmentPrivateKey = createPrivateKey({ key: developmentPrivateKeyDer, format: 'der', type: 'pkcs8' })
    await writeFile(privateKeyPath, developmentPrivateKey.export({ format: 'pem', type: 'pkcs8' }), { flag: 'wx', mode: 0o600 })
    await writeFile(publicKeyPath, createPublicKey(developmentPrivateKey).export({ format: 'pem', type: 'spki' }), { flag: 'wx', mode: 0o600 })
    const version = `0.0.0-dev.${fingerprint.slice(0, 12)}`
    const archiveBaseUrl = `https://local-development.invalid/converter-packs/${fingerprint}`
    const prepared = await dependencies.preparePlan({
      lockPath, cacheRoot: paths.sources, helpersRoot,
      workspace, staging: stagingRoot, planPath, target, version, sequence: 1,
      generatedAt: '1970-01-01T00:00:00.000Z', archiveBaseUrl,
      afterMaterialize: () => dependencies.buildHelpers({ target, output: helpersRoot, compiler: request.compiler }),
    })
    if (!isPlainRecord(prepared) || !Array.isArray(prepared.blobs)) {
      throw new Error('Local development preparation artifact inventory is invalid')
    }
    const plan = JSON.parse(await readFile(planPath, 'utf8'))
    await dependencies.stagePacks({ plan, output: stagingRoot })
    await dependencies.buildRelease({
      stagingRoot, outputRoot: releaseOutput, privateKeyPath, publicKeyPath, platform: request.platform, arch: request.arch,
    })
    await dependencies.verifyRelease({ releaseRoot: releaseOutput, platform: request.platform, arch: request.arch })
    const smokeWorkRoot = join(privateRoot, 'smoke')
    await mkdir(smokeWorkRoot, { mode: 0o700 })
    await dependencies.smokeRelease({ releaseRoot: releaseOutput, workRoot: smokeWorkRoot })
    await dependencies.writeMetadata({ cacheRoot, fingerprint, blobs: prepared.blobs })
    if (replaceActive) {
      await dependencies.replaceActiveRelease({ cacheRoot, fingerprint, candidateRelease: releaseOutput })
    }
    await removePrivateRoot(privateRoot)
  } catch (error) {
    primaryError = error
  }
  if (primaryError !== undefined) {
    await settleCleanup(primaryError, [
      () => removeRelease(paths.release),
      () => removePrivateRoot(privateRoot),
    ], 'Local development preparation cleanup failed.')
  }
  await dependencies.activateRelease({ cacheRoot, fingerprint, releaseRoot: paths.release })
  await dependencies.pruneCache({ cacheRoot, activeFingerprint: fingerprint })
  return { fingerprint, releaseRoot: paths.release, reused: false }
}

export async function runLocalDevelopmentReleasePreparation({
  desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  platform = process.platform,
  arch = process.arch,
  prepare = prepareLocalDevelopmentRelease,
  write = (line) => process.stdout.write(line),
} = {}) {
  const cacheRoot = join(desktopRoot, 'node_modules', '.cache', 'autoforge-converter-packs')
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 })
  const result = await prepare({
    desktopRoot,
    cacheRoot,
    platform,
    arch,
    compiler: '/usr/bin/clang',
  })
  write(`${result.reused ? 'reused' : 'prepared'} ${result.fingerprint}\n`)
  return result
}

export async function runLocalDevelopmentReleasePreparationCli({ writeError = (line) => process.stderr.write(line), ...options } = {}) {
  try {
    await runLocalDevelopmentReleasePreparation(options)
    return 0
  } catch {
    writeError('converter release preparation failed\n')
    return 1
  }
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  process.exitCode = await runLocalDevelopmentReleasePreparationCli()
}
