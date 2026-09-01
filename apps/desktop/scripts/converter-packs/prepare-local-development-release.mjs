import { Buffer } from 'node:buffer'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  activateDevelopmentRelease,
  developmentReleasePaths,
  fingerprintDevelopmentRelease,
} from './local-development-release-cache.mjs'
import { buildNativeHelpers } from './build-native-helpers.mjs'
import { prepareProductionStagingPlan } from './prepare-production-staging.mjs'
import { stageProductionPacks } from './stage-production-packs.mjs'
import {
  buildLocalDevelopmentRelease,
  verifyLocalDevelopmentReleaseIntegrity,
} from './build-local-development-release.mjs'

const fingerprintScriptPaths = Object.freeze([
  'scripts/converter-packs/source-lock.mjs',
  'scripts/converter-packs/acquire-sources.mjs',
  'scripts/converter-packs/build-native-helpers.mjs',
  'scripts/converter-packs/prepare-production-staging.mjs',
  'scripts/converter-packs/macho-closure.mjs',
  'scripts/converter-packs/stage-production-packs.mjs',
  'scripts/converter-packs/build-index.mjs',
  'scripts/converter-packs/sign-index.mjs',
  'scripts/converter-packs/pack-tooling-lib.mjs',
  'scripts/converter-packs/build-local-development-release.mjs',
])
const developmentPrivateKeyDer = Buffer.from(
  '302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
  'hex',
)
const requestKeys = Object.freeze(['desktopRoot', 'cacheRoot', 'platform', 'arch', 'compiler'])

const productionDependencies = Object.freeze({
  buildHelpers: (request) => buildNativeHelpers(request),
  preparePlan: (request) => prepareProductionStagingPlan(request),
  stagePacks: ({ plan }) => stageProductionPacks(plan),
  buildRelease: (request) => buildLocalDevelopmentRelease(request),
  verifyRelease: (request) => verifyLocalDevelopmentReleaseIntegrity(request),
  activateRelease: ({ cacheRoot, fingerprint }) => activateDevelopmentRelease({ cacheRoot, fingerprint }),
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
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink() || await realpath(path) !== path) {
    throw new Error('Development fingerprint input must be a non-symbolic regular file')
  }
  return { path: relativeInputPath(desktopRoot, path), bytes: await readFile(path) }
}

async function nativeInputs(desktopRoot) {
  const nativeRoot = join(desktopRoot, 'converter-packs', 'native')
  const metadata = await lstat(nativeRoot)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(nativeRoot) !== nativeRoot) {
    throw new Error('Development native helper tree must be a canonical non-symbolic directory')
  }
  const files = []
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const child = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Development native helper tree must not contain symbolic links')
      if (entry.isDirectory()) await visit(child)
      else if (entry.isFile()) files.push(await regularFileUnderRoot(desktopRoot, child))
      else throw new Error('Development native helper tree contains an unsupported entry')
    }
  }
  await visit(nativeRoot)
  return files
}

export async function developmentFingerprintInputs(desktopRoot) {
  await canonicalDirectory(desktopRoot, 'Desktop root')
  const inputs = [
    await regularFileUnderRoot(desktopRoot, join(desktopRoot, 'converter-packs', 'sources.lock.json')),
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
    'buildHelpers', 'preparePlan', 'stagePacks', 'buildRelease', 'verifyRelease', 'activateRelease',
  ].some((name) => typeof dependencies[name] !== 'function')) {
    throw new Error('Local development preparation dependencies are invalid')
  }
}

async function hasRelease(path) {
  return Boolean(await lstat(path).catch((error) => {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }))
}

export async function prepareLocalDevelopmentRelease(request, dependencies = productionDependencies) {
  requireRequest(request)
  validateDependencies(dependencies)
  const desktopRoot = await canonicalDirectory(request.desktopRoot, 'Desktop root')
  const cacheRoot = await canonicalDirectory(request.cacheRoot, 'Development cache root')
  const target = `${request.platform}-${request.arch}`
  const fingerprint = fingerprintDevelopmentRelease({ target, inputs: await developmentFingerprintInputs(desktopRoot) })
  const paths = developmentReleasePaths(cacheRoot, fingerprint)

  if (await hasRelease(paths.release)) {
    try {
      await dependencies.verifyRelease({ releaseRoot: paths.release, platform: request.platform, arch: request.arch })
      return { fingerprint, releaseRoot: paths.release, reused: true }
    } catch {
      await rm(paths.release, { recursive: true, force: true })
    }
  }

  const privateRoot = join(cacheRoot, `.local-development-preparation-${fingerprint.slice(0, 12)}`)
  await mkdir(privateRoot, { mode: 0o700 })
  try {
    const helpersRoot = join(privateRoot, 'helpers')
    const workspace = join(privateRoot, 'workspace')
    const stagingRoot = join(privateRoot, 'staging')
    const planPath = join(privateRoot, 'plan.json')
    const signingRoot = join(privateRoot, 'signing-key')
    const privateKeyPath = join(signingRoot, 'private.pem')
    const publicKeyPath = join(signingRoot, 'public.pem')
    await mkdir(join(cacheRoot, 'sources'), { recursive: true, mode: 0o700 })
    await mkdir(join(cacheRoot, 'releases'), { recursive: true, mode: 0o700 })
    await mkdir(signingRoot, { mode: 0o700 })
    const developmentPrivateKey = createPrivateKey({ key: developmentPrivateKeyDer, format: 'der', type: 'pkcs8' })
    await writeFile(privateKeyPath, developmentPrivateKey.export({ format: 'pem', type: 'pkcs8' }), { flag: 'wx', mode: 0o600 })
    await writeFile(publicKeyPath, createPublicKey(developmentPrivateKey).export({ format: 'pem', type: 'spki' }), { flag: 'wx', mode: 0o600 })
    const version = `0.0.0-dev+${fingerprint.slice(0, 12)}`
    const archiveBaseUrl = `https://local-development.invalid/converter-packs/${fingerprint}`
    await dependencies.buildHelpers({ target, output: helpersRoot, compiler: request.compiler })
    await dependencies.preparePlan({
      lockPath: join(desktopRoot, 'converter-packs', 'sources.lock.json'), cacheRoot: paths.sources, helpersRoot,
      workspace, staging: stagingRoot, planPath, target, version, sequence: 1,
      generatedAt: new Date().toISOString(), archiveBaseUrl,
    })
    const plan = JSON.parse(await readFile(planPath, 'utf8'))
    await dependencies.stagePacks({ plan, output: stagingRoot })
    await dependencies.buildRelease({
      stagingRoot, outputRoot: paths.release, privateKeyPath, publicKeyPath, platform: request.platform, arch: request.arch,
    })
    await dependencies.verifyRelease({ releaseRoot: paths.release, platform: request.platform, arch: request.arch })
    await dependencies.activateRelease({ cacheRoot, fingerprint, releaseRoot: paths.release })
    return { fingerprint, releaseRoot: paths.release, reused: false }
  } finally {
    await rm(privateRoot, { recursive: true, force: true })
  }
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

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  try {
    await runLocalDevelopmentReleasePreparation()
  } catch (error) {
    process.stderr.write(`Local development release preparation failed: ${error instanceof Error ? error.message : 'unknown error'}\n`)
    process.exitCode = 1
  }
}
