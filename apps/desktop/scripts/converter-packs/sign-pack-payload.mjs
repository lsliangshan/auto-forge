import { spawnSync } from 'node:child_process'
import { lstat, readdir, realpath, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import {
  canonicalBytes,
  compareUtf8,
  fail,
  isPathInsideRoot,
  parseArguments,
  readCanonicalJson,
  readStableRegularFile,
  requireAbsolutePath,
  requireDirectory,
  safeEntryPath,
  sha256,
} from './pack-tooling-lib.mjs'
import { loadConverterSourceLock } from './source-lock.mjs'

const familyNames = Object.freeze(['image-icon', 'document', 'pdf', 'media'])
const teamPattern = /^[A-Z0-9]{10}$/u

async function defaultRun(executable, args) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' },
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

async function requireRun(run, executable, args, label) {
  const result = await run(executable, args)
  if (!result || result.status !== 0 || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') {
    fail(`${label} failed.`)
  }
  return result
}

async function normalizeWrapperTimes(path, timestamp) {
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink()) fail('Notarization input contains a symbolic link.')
  if (metadata.isDirectory()) {
    const children = (await readdir(path)).sort(compareUtf8)
    for (const child of children) await normalizeWrapperTimes(join(path, child), timestamp)
  } else if (!metadata.isFile()) {
    fail('Notarization input contains an unsupported file type.')
  }
  await utimes(path, timestamp, timestamp)
}

async function defaultCreateWrapper({ stagingRoot, evidencePath, generatedAt, run }) {
  const wrapper = `${evidencePath}.notarization.zip`
  if (await lstat(wrapper).catch(() => undefined) !== undefined) fail('Notarization wrapper output already exists.')
  await normalizeWrapperTimes(stagingRoot, new Date(generatedAt))
  await requireRun(run, '/usr/bin/ditto', [
    '-c', '-k', '--norsrc', '--noextattr', '--keepParent', stagingRoot, wrapper,
  ], 'Notarization wrapper creation')
  return wrapper
}

async function defaultNotarize({ wrapper, keychainProfile, run }) {
  const result = await requireRun(run, '/usr/bin/xcrun', [
    'notarytool', 'submit', wrapper, '--keychain-profile', keychainProfile, '--wait', '--output-format', 'json',
  ], 'Notarization submission')
  let parsed
  try { parsed = JSON.parse(result.stdout) } catch { fail('Notarization response is invalid.') }
  return { id: parsed.id, status: parsed.status }
}

async function defaultInspectSignature({ path, run }) {
  const result = await requireRun(run, '/usr/bin/codesign', ['-d', '--verbose=4', path], 'Code signature inspection')
  const output = `${result.stdout}\n${result.stderr}`
  const team = /^TeamIdentifier=([A-Z0-9]{10})$/mu.exec(output)?.[1]
  return {
    teamId: team,
    hardenedRuntime: /(?:^|\W)runtime(?:\W|$)/iu.test(output),
    signed: team !== undefined,
  }
}

async function defaultToolVersions({ run }) {
  const [codesign, notarytool] = await Promise.all([
    requireRun(run, '/usr/bin/xcodebuild', ['-version'], 'codesign toolchain version'),
    requireRun(run, '/usr/bin/xcrun', ['notarytool', '--version'], 'notarytool version'),
  ])
  return { codesign: codesign.stdout.trim(), notarytool: notarytool.stdout.trim() }
}

const productionDependencies = Object.freeze({
  run: defaultRun,
  createWrapper: defaultCreateWrapper,
  notarize: defaultNotarize,
  inspectSignature: defaultInspectSignature,
  toolVersions: defaultToolVersions,
})

function validateRequest(request) {
  if (
    typeof request !== 'object'
    || request === null
    || typeof request.identity !== 'string'
    || request.identity.length < 1
    || request.identity.length > 512
    || typeof request.teamId !== 'string'
    || !teamPattern.test(request.teamId)
    || typeof request.keychainProfile !== 'string'
    || request.keychainProfile.length < 1
    || request.keychainProfile.length > 256
  ) fail('Signing credentials are required.')
  requireAbsolutePath(request.stagingRoot, 'Staging root')
  requireAbsolutePath(request.evidencePath, 'Evidence output')
  requireAbsolutePath(request.sourceLockPath, 'Source lock')
  if (request.target !== 'darwin-arm64' && request.target !== 'darwin-x64') fail('Signing target is invalid.')
  try {
    if (new Date(request.generatedAt).toISOString() !== request.generatedAt) fail('Signing generatedAt is invalid.')
  } catch { fail('Signing generatedAt is invalid.') }
}

async function collectStagedFiles(stagingRoot, target) {
  await requireDirectory(stagingRoot, 'Staging root')
  const resolvedStaging = await realpath(stagingRoot)
  const packsRoot = join(resolvedStaging, 'packs')
  const directories = await readdir(packsRoot, { withFileTypes: true })
  const expected = familyNames.map((name) => `${name}-${target}`).sort(compareUtf8)
  if (directories.map(({ name }) => name).sort(compareUtf8).join('\0') !== expected.join('\0')) {
    fail('Signing requires exactly four staged target packs.')
  }
  const files = []
  for (const pack of familyNames) {
    const packRoot = join(packsRoot, `${pack}-${target}`)
    const manifest = (await readCanonicalJson(join(packRoot, 'pack.json'), 'Staged pack manifest')).value
    if (manifest?.name !== pack || `${manifest.platform}-${manifest.arch}` !== target || !Array.isArray(manifest.files)) {
      fail('Staged pack manifest is invalid.')
    }
    for (const file of manifest.files) {
      if (!safeEntryPath(file?.path) || !['executable', 'code', 'data', 'license'].includes(file?.role)) {
        fail('Staged pack file inventory is invalid.')
      }
      const path = join(packRoot, 'payload', ...file.path.split('/'))
      if (!isPathInsideRoot(resolvedStaging, path)) fail('Staged pack path is unsafe.')
      files.push({ pack, path: file.path, role: file.role, absolutePath: path })
    }
  }
  return files
}

export async function signPackPayloads(request, dependencies = productionDependencies) {
  validateRequest(request)
  if (
    typeof dependencies !== 'object'
    || dependencies === null
    || typeof dependencies.run !== 'function'
    || typeof dependencies.createWrapper !== 'function'
    || typeof dependencies.notarize !== 'function'
    || typeof dependencies.inspectSignature !== 'function'
    || typeof dependencies.toolVersions !== 'function'
  ) fail('Signing dependencies are invalid.')
  if (isPathInsideRoot(request.stagingRoot, request.evidencePath)) fail('Release evidence must be outside staging.')
  if (await realpath(dirname(request.evidencePath)).catch(() => undefined) !== dirname(request.evidencePath)) {
    fail('Evidence output parent must be a canonical directory.')
  }
  const staged = await collectStagedFiles(request.stagingRoot, request.target)
  const machos = staged.filter(({ role }) => role === 'code' || role === 'executable').sort((left, right) => (
    Number(left.role === 'executable') - Number(right.role === 'executable')
    || compareUtf8(`${left.pack}\0${left.path}`, `${right.pack}\0${right.path}`)
  ))
  for (const file of machos) {
    await requireRun(dependencies.run, '/usr/bin/codesign', [
      '--force', '--options', 'runtime', '--timestamp', '--sign', request.identity, file.absolutePath,
    ], 'Developer ID signing')
  }
  for (const file of machos) {
    await requireRun(dependencies.run, '/usr/bin/codesign', [
      '--verify', '--strict', '--verbose=2', file.absolutePath,
    ], 'Developer ID signature verification')
  }
  const wrapper = await dependencies.createWrapper({
    stagingRoot: request.stagingRoot, evidencePath: request.evidencePath,
    generatedAt: request.generatedAt, run: dependencies.run,
  })
  requireAbsolutePath(wrapper, 'Notarization wrapper')
  if (isPathInsideRoot(request.stagingRoot, wrapper)) fail('Notarization wrapper must be outside staging.')
  const notarization = await dependencies.notarize({ wrapper, keychainProfile: request.keychainProfile, run: dependencies.run })
  if (
    typeof notarization?.id !== 'string'
    || notarization.id.length < 1
    || notarization.id.length > 256
    || notarization.status !== 'Accepted'
  ) fail('Notarization was not accepted.')
  const toolVersions = await dependencies.toolVersions({ run: dependencies.run })
  if (
    typeof toolVersions?.codesign !== 'string'
    || toolVersions.codesign.length < 1
    || typeof toolVersions?.notarytool !== 'string'
    || toolVersions.notarytool.length < 1
  ) fail('Signing tool versions are invalid.')

  const architecture = request.target.endsWith('-x64') ? 'x64' : 'arm64'
  const signatureEvidence = new Map()
  for (const file of machos) {
    const signature = await dependencies.inspectSignature({ path: file.absolutePath, run: dependencies.run })
    if (signature?.teamId !== request.teamId || signature.signed !== true || signature.hardenedRuntime !== true) {
      fail(`Developer ID signature evidence is invalid: ${file.path}`)
    }
    signatureEvidence.set(`${file.pack}\0${file.path}`, signature)
  }
  const files = []
  for (const file of staged) {
    const bytes = await readStableRegularFile(file.absolutePath, 'Signed staged file')
    const signature = signatureEvidence.get(`${file.pack}\0${file.path}`)
    files.push({
      pack: file.pack, path: file.path, role: file.role, bytes: bytes.byteLength, sha256: sha256(bytes),
      ...(signature === undefined ? {} : { architecture, signed: true, hardenedRuntime: true }),
    })
  }
  files.sort((left, right) => compareUtf8(`${left.pack}\0${left.path}`, `${right.pack}\0${right.path}`))
  const selected = await loadConverterSourceLock({ path: request.sourceLockPath, target: request.target })
  const sourceOffers = selected.engines.map((engine) => ({
    name: engine.name,
    version: engine.version,
    license: engine.license,
    url: engine.acquisition.url,
    sha256: engine.acquisition.sha256,
  })).sort((left, right) => compareUtf8(left.name, right.name))
  await writeFile(request.evidencePath, canonicalBytes({
    schemaVersion: 1,
    target: request.target,
    generatedAt: request.generatedAt,
    teamId: request.teamId,
    notarization,
    toolVersions,
    sourceOffers,
    files,
  }), { flag: 'wx', mode: 0o600 })
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const args = parseArguments(process.argv.slice(2), [
    '--staging', '--evidence', '--source-lock', '--target', '--identity', '--team-id', '--keychain-profile', '--generated-at',
  ])
  await signPackPayloads({
    stagingRoot: args['--staging'], evidencePath: args['--evidence'], sourceLockPath: args['--source-lock'],
    target: args['--target'], identity: args['--identity'], teamId: args['--team-id'],
    keychainProfile: args['--keychain-profile'], generatedAt: args['--generated-at'],
  })
  process.stdout.write('signed and notarized converter pack payloads\n')
}
