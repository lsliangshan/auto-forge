import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { pathToFileURL, URL } from 'node:url'
import {
  canonicalBytes,
  compareUtf8,
  fail,
  parseArguments,
  readCanonicalJson,
  readStableRegularFile,
  requireAbsolutePath,
  requireDirectory,
  safeEntryPath,
  sha256,
} from './pack-tooling-lib.mjs'

const familyNames = Object.freeze(['image-icon', 'document', 'pdf', 'media'])
const sourceNames = new Set(['libvips', 'libreoffice', 'poppler', 'ffmpeg'])
const sha256Pattern = /^[a-f0-9]{64}$/u
const teamPattern = /^[A-Z0-9]{10}$/u

function plainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value, keys) {
  return plainRecord(value)
    && Object.keys(value).sort(compareUtf8).join('\0') === [...keys].sort(compareUtf8).join('\0')
}

function validIso(value) {
  if (typeof value !== 'string') return false
  try { return new Date(value).toISOString() === value } catch { return false }
}

function validHttps(value) {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' && parsed.href === value
  } catch { return false }
}

function validateEvidenceSchema(value, expectedTeamId) {
  if (!exactKeys(value, [
    'schemaVersion', 'target', 'generatedAt', 'teamId', 'notarization', 'toolVersions', 'sourceOffers', 'files',
  ])) fail('Release evidence has an invalid schema.')
  if (
    value.schemaVersion !== 1
    || (value.target !== 'darwin-arm64' && value.target !== 'darwin-x64')
    || !validIso(value.generatedAt)
    || !teamPattern.test(value.teamId)
    || value.teamId !== expectedTeamId
    || !exactKeys(value.notarization, ['id', 'status'])
    || typeof value.notarization.id !== 'string'
    || value.notarization.id.length < 1
    || value.notarization.id.length > 256
    || value.notarization.status !== 'Accepted'
    || !exactKeys(value.toolVersions, ['codesign', 'notarytool'])
    || Object.values(value.toolVersions).some((version) => typeof version !== 'string' || version.length < 1 || version.length > 256)
    || !Array.isArray(value.sourceOffers)
    || !Array.isArray(value.files)
  ) fail('Release evidence is invalid.')
  const sources = new Set()
  for (const source of value.sourceOffers) {
    if (
      !exactKeys(source, ['name', 'version', 'license', 'url', 'sha256'])
      || !sourceNames.has(source.name)
      || sources.has(source.name)
      || typeof source.version !== 'string'
      || source.version.length < 1
      || typeof source.license !== 'string'
      || source.license.length < 1
      || !validHttps(source.url)
      || !sha256Pattern.test(source.sha256)
    ) fail('Release source offer evidence is invalid.')
    sources.add(source.name)
  }
  if (sources.size !== sourceNames.size) fail('Release source offer evidence is incomplete.')
  if (/PRIVATE[-_ ]?(?:KEY|SENTINEL)/iu.test(canonicalBytes(value).toString('utf8'))) {
    fail('Release evidence contains forbidden private material.')
  }
  return value.target.slice('darwin-'.length) === 'x64' ? 'x64' : 'arm64'
}

async function stagedInventory(stagingRoot, target) {
  await requireDirectory(stagingRoot, 'Staging root')
  const packsRoot = join(stagingRoot, 'packs')
  await requireDirectory(packsRoot, 'Staging packs root')
  const directories = await readdir(packsRoot, { withFileTypes: true })
  const expectedDirectories = familyNames.map((name) => `${name}-${target}`).sort(compareUtf8)
  if (
    directories.some((entry) => !entry.isDirectory() || entry.isSymbolicLink())
    || directories.map(({ name }) => name).sort(compareUtf8).join('\0') !== expectedDirectories.join('\0')
  ) fail('Staging root does not contain the exact target inventory.')
  const inventory = new Map()
  for (const name of familyNames) {
    const packRoot = join(packsRoot, `${name}-${target}`)
    const manifest = (await readCanonicalJson(join(packRoot, 'pack.json'), 'Staged pack manifest')).value
    if (
      !plainRecord(manifest)
      || manifest.name !== name
      || `${manifest.platform}-${manifest.arch}` !== target
      || !Array.isArray(manifest.files)
    ) fail('Staged pack manifest is invalid.')
    for (const file of manifest.files) {
      if (
        !exactKeys(file, ['path', 'role'])
        || !safeEntryPath(file.path)
        || !['executable', 'code', 'data', 'license'].includes(file.role)
      ) fail('Staged pack file inventory is invalid.')
      const key = `${name}\0${file.path}`
      if (inventory.has(key)) fail('Staged pack file inventory collides.')
      const bytes = await readStableRegularFile(join(packRoot, 'payload', ...file.path.split('/')), 'Staged pack file')
      inventory.set(key, { pack: name, path: file.path, role: file.role, bytes: bytes.byteLength, sha256: sha256(bytes) })
    }
  }
  return inventory
}

export async function verifyReleaseEvidence({ stagingRoot, evidencePath, expectedTeamId }) {
  requireAbsolutePath(stagingRoot, 'Staging root')
  requireAbsolutePath(evidencePath, 'Release evidence')
  if (typeof expectedTeamId !== 'string' || !teamPattern.test(expectedTeamId)) fail('Expected Team ID is invalid.')
  const { bytes, value } = await readCanonicalJson(evidencePath, 'Release evidence')
  if (!bytes.equals(canonicalBytes(value))) fail('Release evidence must use canonical JSON.')
  const architecture = validateEvidenceSchema(value, expectedTeamId)
  const inventory = await stagedInventory(stagingRoot, value.target)
  const seen = new Set()
  const licensedFamilies = new Set()
  for (const file of value.files) {
    const code = file?.role === 'code' || file?.role === 'executable'
    const keys = code
      ? ['pack', 'path', 'role', 'bytes', 'sha256', 'architecture', 'signed', 'hardenedRuntime']
      : ['pack', 'path', 'role', 'bytes', 'sha256']
    if (!exactKeys(file, keys)) fail('Release file evidence has an invalid schema.')
    const key = `${file.pack}\0${file.path}`
    const expected = inventory.get(key)
    if (
      expected === undefined
      || seen.has(key)
      || file.role !== expected.role
      || file.bytes !== expected.bytes
      || file.sha256 !== expected.sha256
      || (code && (file.architecture !== architecture || file.signed !== true || file.hardenedRuntime !== true))
    ) fail('Release file evidence does not match staging.')
    seen.add(key)
    if (file.role === 'license' && file.bytes > 0) licensedFamilies.add(file.pack)
  }
  if (seen.size !== inventory.size || licensedFamilies.size !== familyNames.length) {
    fail('Release file or license evidence is incomplete.')
  }
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const args = parseArguments(process.argv.slice(2), ['--staging', '--evidence', '--team-id'])
  await verifyReleaseEvidence({
    stagingRoot: args['--staging'], evidencePath: args['--evidence'], expectedTeamId: args['--team-id'],
  })
  process.stdout.write('verified converter pack release evidence\n')
}
