import { Buffer } from 'node:buffer'
import { pathToFileURL, URL } from 'node:url'
import process from 'node:process'
import {
  canonicalBytes,
  compareUtf8,
  fail,
  parseArguments,
  readStableRegularFile,
  requireAbsolutePath,
} from './pack-tooling-lib.mjs'

const targets = Object.freeze(['darwin-arm64', 'darwin-x64'])
const engineNames = Object.freeze(['ffmpeg', 'libreoffice', 'libvips', 'poppler'])
const sha256Pattern = /^[a-f0-9]{64}$/u
const gitRevisionPattern = /^[a-f0-9]{40}$/u

function exactKeys(value, expected) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const actual = Object.keys(value).sort(compareUtf8)
  const wanted = [...expected].sort(compareUtf8)
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function validHttpsUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048 || value !== value.trim()) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password && !url.hash
  } catch {
    return false
  }
}

function validText(value, maximumBytes = 256) {
  return typeof value === 'string'
    && value.length > 0
    && value === value.trim()
    && Buffer.byteLength(value, 'utf8') <= maximumBytes
    && !value.includes('\0')
}

function validDownload(value, target, expectedKind) {
  if (!exactKeys(value, ['kind', 'url', 'sha256', 'cellar'])) return false
  if (value.kind !== expectedKind || !validHttpsUrl(value.url) || !sha256Pattern.test(value.sha256)) return false
  if (expectedKind === 'dmg') return value.cellar === null
  const expectedCellar = target === 'darwin-arm64' ? '/opt/homebrew/Cellar' : '/usr/local/Cellar'
  return value.cellar === expectedCellar
}

function validEngine(value, expectedName) {
  if (!exactKeys(value, ['name', 'version', 'license', 'source', 'acquisitions'])) return false
  if (value.name !== expectedName || !validText(value.version, 128) || !validText(value.license, 256)) return false
  if (
    !exactKeys(value.source, ['url', 'sha256'])
    || !validHttpsUrl(value.source.url)
    || !sha256Pattern.test(value.source.sha256)
    || !exactKeys(value.acquisitions, targets)
  ) return false
  const expectedKind = expectedName === 'libreoffice' ? 'dmg' : 'homebrew-bottle'
  return targets.every((target) => validDownload(value.acquisitions[target], target, expectedKind))
}

function validateSourceLock(value) {
  if (
    !exactKeys(value, ['schemaVersion', 'homebrewCoreRevision', 'homebrewCaskRevision', 'targets', 'engines'])
    || value.schemaVersion !== 1
    || !gitRevisionPattern.test(value.homebrewCoreRevision)
    || !gitRevisionPattern.test(value.homebrewCaskRevision)
    || !Array.isArray(value.targets)
    || value.targets.length !== targets.length
    || !value.targets.every((target, index) => target === targets[index])
    || !Array.isArray(value.engines)
    || value.engines.length !== engineNames.length
    || !value.engines.every((engine, index) => validEngine(engine, engineNames[index]))
  ) fail('Source lock has an invalid schema.')
  return value
}

export async function loadConverterSourceLock({ path, target }) {
  requireAbsolutePath(path, 'Source lock path')
  const bytes = await readStableRegularFile(path, 'Source lock', 1024 * 1024)
  let value
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    fail('Source lock is not valid JSON.')
  }
  if (!bytes.equals(canonicalBytes(value))) fail('Source lock is not canonical JSON.')
  validateSourceLock(value)
  if (!targets.includes(target)) fail('Source lock target is unsupported.')
  return {
    target,
    homebrewCoreRevision: value.homebrewCoreRevision,
    homebrewCaskRevision: value.homebrewCaskRevision,
    engines: value.engines.map((engine) => ({
      name: engine.name,
      version: engine.version,
      license: engine.license,
      source: engine.source,
      acquisition: engine.acquisitions[target],
    })),
  }
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const args = parseArguments(process.argv.slice(2), ['--lock', '--target'])
  await loadConverterSourceLock({ path: args['--lock'], target: args['--target'] })
  process.stdout.write(`verified converter source lock for ${args['--target']}\n`)
}
