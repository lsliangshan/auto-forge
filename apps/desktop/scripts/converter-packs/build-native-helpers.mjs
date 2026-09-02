import { spawnSync } from 'node:child_process'
import { chmod, lstat, mkdir, open, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL, URL } from 'node:url'
import {
  canonicalBytes, compareUtf8, parseArguments, readStableRegularFile, requireAbsolutePath, requireDirectory, sha256,
  withStableRegularFile,
} from './pack-tooling-lib.mjs'
import { publishPrivateDirectory, writeDurableFile } from './private-directory-publication.mjs'

const desktopRoot = fileURLToPath(new URL('../..', import.meta.url))
const nativeRoot = join(desktopRoot, 'converter-packs', 'native')
const targetArchitectures = Object.freeze({
  'darwin-arm64': 'arm64',
  'darwin-x64': 'x86_64',
})
const helpers = Object.freeze([
  Object.freeze({
    name: 'autoforge-image-converter',
    destination: 'bin/autoforge-image-converter',
    sources: [
      'common/arguments.c',
      'common/process.c',
      'image-converter/icon-container.c',
      'image-converter/main.c',
    ],
    includes: ['common', 'image-converter'],
  }),
  Object.freeze({
    name: 'autoforge-pdf-raster',
    destination: 'bin/autoforge-pdf-raster',
    sources: ['common/arguments.c', 'common/process.c', 'pdf-raster/main.c'],
    includes: ['common'],
  }),
  Object.freeze({
    name: 'autoforge-soffice-launcher',
    destination: 'program/soffice',
    sources: ['common/process.c', 'soffice-launcher/main.c'],
    includes: ['common'],
  }),
])
const helperByName = new Map(helpers.map((helper) => [helper.name, helper]))

function invalid() {
  throw new Error('Native helper set is invalid.')
}

function exactKeys(value, keys) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort(compareUtf8).join('\0') === [...keys].sort(compareUtf8).join('\0')
}

async function readModeLockedFile(path, label, maximumBytes, mode) {
  try {
    return await withStableRegularFile(path, label, async (handle, metadata) => {
      if (metadata.size > maximumBytes || (metadata.mode & 0o777) !== mode) invalid()
      const bytes = await handle.readFile()
      const after = await handle.stat()
      if (bytes.byteLength !== metadata.size || (after.mode & 0o777) !== mode) invalid()
      return bytes
    })
  } catch {
    invalid()
  }
}

async function verifiedHelper(root, record) {
  if (
    !exactKeys(record, ['helper', 'destination', 'sha256', 'bytes', 'mode'])
    || helperByName.get(record.helper)?.destination !== record.destination
    || !/^[a-f0-9]{64}$/u.test(record.sha256)
    || !Number.isSafeInteger(record.bytes)
    || record.bytes <= 0
    || record.mode !== 0o755
  ) invalid()
  const path = join(root, ...record.destination.split('/'))
  const bytes = await readModeLockedFile(path, 'Native helper', Number.MAX_SAFE_INTEGER, record.mode)
  if (bytes.byteLength !== record.bytes || sha256(bytes) !== record.sha256) invalid()
  return path
}

export async function openBuiltHelperSet({ root, target }) {
  if (!targetArchitectures[target]) invalid()
  requireAbsolutePath(root, 'Native helper root')
  await requireDirectory(root, 'Native helper root')
  const manifestPath = join(root, 'manifest.json')
  const manifestBytes = await readModeLockedFile(manifestPath, 'Native helper manifest', 64 * 1024, 0o444)
  let manifest
  try { manifest = JSON.parse(manifestBytes.toString('utf8')) } catch { invalid() }
  if (!manifestBytes.equals(canonicalBytes(manifest))) invalid()
  if (
    !exactKeys(manifest, ['schemaVersion', 'target', 'helpers'])
    || manifest.schemaVersion !== 1
    || manifest.target !== target
    || !Array.isArray(manifest.helpers)
    || manifest.helpers.length !== helpers.length
    || manifest.helpers.some((record, index) => record.helper !== helpers[index].name)
  ) invalid()
  const records = new Map()
  for (const record of manifest.helpers) {
    await verifiedHelper(root, record)
    records.set(record.helper, Object.freeze({ ...record }))
  }
  return Object.freeze({
    target,
    root,
    async resolveHelper(helper) {
      const record = records.get(helper)
      if (!record) invalid()
      return Object.freeze({ ...record, path: await verifiedHelper(root, record) })
    },
  })
}

async function requireExecutable(path) {
  const metadata = await lstat(path).catch(() => undefined)
  if (!metadata?.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o111) === 0 || await realpath(path) !== path) {
    throw new Error('Compiler must be one executable regular file without symbolic path components.')
  }
}

export async function buildNativeHelpers({
  target,
  output,
  compiler,
  beforePublishForTest,
  afterClaimOpenForTest,
  removePrivateRootForTest,
  claimInitializationCleanupForTest,
}) {
  const architecture = targetArchitectures[target]
  if (!architecture) throw new Error('Target must be darwin-arm64 or darwin-x64.')
  requireAbsolutePath(output, 'Output')
  requireAbsolutePath(compiler, 'Compiler')
  await requireExecutable(compiler)
  if (await realpath(dirname(output)).catch(() => undefined) !== dirname(output)) {
    throw new Error('Output parent must be one canonical directory without symbolic path components.')
  }

  await publishPrivateDirectory({
    destination: output,
    beforePublishForTest,
    afterClaimOpenForTest,
    removePrivateRootForTest,
    claimInitializationCleanupForTest,
    verifyExisting: (root) => openBuiltHelperSet({ root, target }),
    populate: async (privateRoot, heartbeat) => {
    const bin = join(privateRoot, 'bin')
    await mkdir(bin, { mode: 0o755 })
    for (const helper of helpers) {
      const executable = join(privateRoot, ...helper.destination.split('/'))
      await mkdir(dirname(executable), { recursive: true, mode: 0o755 })
      const args = [
        '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2',
        '-mmacosx-version-min=11.0', '-arch', architecture,
        ...helper.sources.map((source) => join(nativeRoot, source)),
        ...helper.includes.flatMap((include) => ['-I', join(nativeRoot, include)]),
        '-o', executable,
      ]
      const result = spawnSync(compiler, args, { encoding: 'utf8', env: Object.freeze({ PATH: '/usr/bin:/bin' }) })
      if (result.status !== 0) throw new Error(`Native helper build failed: ${result.stderr || 'compiler exited unsuccessfully'}`)
      const metadata = await lstat(executable)
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Compiler did not produce a regular helper executable.')
      await chmod(executable, 0o755)
      const handle = await open(executable, 'r+')
      try {
        await handle.chmod(0o755)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await heartbeat.pulse()
    }
    const manifest = {
      schemaVersion: 1,
      target,
      helpers: [],
    }
    for (const helper of helpers) {
      const path = join(privateRoot, ...helper.destination.split('/'))
      const bytes = await readStableRegularFile(path, 'Native helper')
      manifest.helpers.push({
        helper: helper.name,
        destination: helper.destination,
        sha256: sha256(bytes),
        bytes: bytes.byteLength,
        mode: 0o755,
      })
    }
      await writeDurableFile(join(privateRoot, 'manifest.json'), canonicalBytes(manifest), 0o444)
    },
  })
  return openBuiltHelperSet({ root: output, target })
}

async function main(argv) {
  const args = parseArguments(argv, ['--target', '--output', '--compiler'])
  await buildNativeHelpers({
    target: args['--target'],
    output: args['--output'],
    compiler: args['--compiler'],
  })
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
