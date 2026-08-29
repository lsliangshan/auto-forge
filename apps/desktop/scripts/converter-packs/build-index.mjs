import { Buffer } from 'node:buffer'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import {
  approvedTarget,
  archiveFilename,
  canonicalBytes,
  collectPayloadEntries,
  createRestrictedUstar,
  fail,
  parseArguments,
  requireAbsolutePath,
  requireDirectory,
  safeEntryPath,
  sha256,
  validateExecutableSet,
  validateIndex,
} from './pack-tooling-lib.mjs'

function exactKeys(value, expected) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0')
}

async function readJson(path, label) {
  let value
  try { value = JSON.parse(await readFile(path, 'utf8')) } catch { fail(`${label} is not valid JSON.`) }
  return value
}

function validateRelease(value) {
  if (!exactKeys(value, ['schemaVersion', 'generatedAt', 'sequence'])) fail('Release metadata has an invalid schema.')
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.sequence) || value.sequence < 0 || typeof value.generatedAt !== 'string') {
    fail('Release metadata is invalid.')
  }
  try {
    if (new Date(value.generatedAt).toISOString() !== value.generatedAt) fail('Release generatedAt is invalid.')
  } catch { fail('Release generatedAt is invalid.') }
  return value
}

function validateManifest(value) {
  if (!exactKeys(value, ['schemaVersion', 'name', 'version', 'platform', 'arch', 'archiveUrl', 'executables', 'licenses'])) {
    fail('Pack manifest has an invalid schema.')
  }
  if (
    value.schemaVersion !== 1
    || typeof value.name !== 'string'
    || typeof value.version !== 'string'
    || typeof value.platform !== 'string'
    || typeof value.arch !== 'string'
    || typeof value.archiveUrl !== 'string'
    || !Array.isArray(value.executables)
    || value.executables.length === 0
    || value.executables.some((path) => !safeEntryPath(path))
    || !Array.isArray(value.licenses)
    || value.licenses.length === 0
    || value.licenses.some((path) => !safeEntryPath(path) || !path.startsWith('LICENSES/'))
  ) fail('Pack manifest is invalid.')
  if (!approvedTarget(value.platform, value.arch)) fail('Pack manifest platform/architecture is unsupported.')
  validateExecutableSet(value.name, value.platform, value.executables)
  return value
}

export async function buildConverterPackIndex({ input, output }) {
  requireAbsolutePath(input, 'Input root')
  requireAbsolutePath(output, 'Output root')
  await requireDirectory(input, 'Input root')
  await requireDirectory(dirname(output), 'Output parent')
  const inputNames = (await readdir(input, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
  if (inputNames.map(({ name }) => name).join('\0') !== ['packs', 'release.json'].join('\0')) {
    fail('Input root must contain only packs and release.json.')
  }
  if (!inputNames[0]?.isDirectory() || !inputNames[1]?.isFile()) fail('Input root layout is invalid.')
  const release = validateRelease(await readJson(join(input, 'release.json'), 'Release metadata'))
  const packsRoot = join(input, 'packs')
  await requireDirectory(packsRoot, 'Packs root')
  const packDirectories = (await readdir(packsRoot, { withFileTypes: true })).sort((a, b) => Buffer.from(a.name).compare(Buffer.from(b.name)))
  if (packDirectories.length === 0) fail('At least one staged pack is required.')
  const built = []
  const archiveNames = new Set()
  for (const directory of packDirectories) {
    if (!directory.isDirectory() || directory.isSymbolicLink() || !safeEntryPath(directory.name)) fail('Packs root contains an unsafe name.')
    const packRoot = join(packsRoot, directory.name)
    await requireDirectory(packRoot, 'Pack root')
    const children = (await readdir(packRoot, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    if (children.map(({ name }) => name).join('\0') !== ['pack.json', 'payload'].join('\0')) fail('Pack root layout is invalid.')
    if (!children[0]?.isFile() || !children[1]?.isDirectory()) fail('Pack root layout is invalid.')
    const manifest = validateManifest(await readJson(join(packRoot, 'pack.json'), 'Pack manifest'))
    const entries = await collectPayloadEntries(join(packRoot, 'payload'), manifest.executables, manifest.licenses)
    for (const executable of manifest.executables) {
      if (!entries.some((entry) => entry.path === executable && entry.executable)) fail('Pack is missing a declared executable.')
    }
    const archive = createRestrictedUstar(entries)
    const descriptor = {
      name: manifest.name,
      version: manifest.version,
      platform: manifest.platform,
      arch: manifest.arch,
      archiveUrl: manifest.archiveUrl,
      archiveSha256: sha256(archive),
      archiveBytes: archive.byteLength,
      entries: entries.map(({ path, bytes, executable, sha256: digest }) => ({ path, sha256: digest, bytes: bytes.byteLength, executable })),
    }
    const archiveName = archiveFilename(descriptor)
    if (archiveNames.has(archiveName.toLowerCase())) fail('Archive filenames must be unique.')
    archiveNames.add(archiveName.toLowerCase())
    built.push({ descriptor, archiveName, archive })
  }
  built.sort((left, right) => [left.descriptor.name, left.descriptor.version, left.descriptor.platform, left.descriptor.arch]
    .join('\0').localeCompare([right.descriptor.name, right.descriptor.version, right.descriptor.platform, right.descriptor.arch].join('\0')))
  const index = validateIndex({ schemaVersion: 1, generatedAt: release.generatedAt, sequence: release.sequence, packs: built.map(({ descriptor }) => descriptor) })
  await mkdir(output, { recursive: false, mode: 0o700 })
  await Promise.all([
    writeFile(join(output, 'index.json'), canonicalBytes(index), { flag: 'wx', mode: 0o600 }),
    ...built.map(({ archiveName, archive }) => writeFile(join(output, archiveName), archive, { flag: 'wx', mode: 0o600 })),
  ])
  process.stdout.write(`built ${built.length} deterministic converter pack${built.length === 1 ? '' : 's'}\n`)
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const args = parseArguments(process.argv.slice(2), ['--input', '--output'])
  await buildConverterPackIndex({ input: args['--input'], output: args['--output'] })
}
