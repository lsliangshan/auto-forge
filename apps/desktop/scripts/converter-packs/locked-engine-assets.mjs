import { lstat, mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import {
  canonicalBytes, compareUtf8, fail, isPathInsideRoot, readStableRegularFile, requireAbsolutePath, requireDirectory, sha256,
} from './pack-tooling-lib.mjs'
import { publishPrivateDirectory, writeDurableFile } from './private-directory-publication.mjs'

const targets = new Set(['darwin-arm64', 'darwin-x64'])
function invalid() {
  fail('Locked engine asset set is invalid.')
}

function exactKeys(value, keys) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort(compareUtf8).join('\0') === [...keys].sort(compareUtf8).join('\0')
}

function tupleKey(value) {
  return canonicalBytes(value).toString('utf8')
}

function expectedRecords({ target, sourceLock, closureLock }) {
  if (
    !targets.has(target)
    || sourceLock?.target !== target
    || closureLock?.target !== target
    || !Array.isArray(sourceLock.engines)
    || !closureLock.families
  ) invalid()
  const engines = new Map(sourceLock.engines.map((engine) => [engine?.name, engine]))
  if (engines.size !== sourceLock.engines.length) invalid()
  const assets = new Map()
  const licenses = new Map()
  for (const family of Object.values(closureLock.families)) {
    if (!Array.isArray(family?.engineAssets) || !Array.isArray(family?.engineLicenses)) invalid()
    for (const asset of family.engineAssets) {
      const engine = engines.get(asset?.engine)
      if (
        !exactKeys(asset, ['engine', 'source', 'destination', 'sha256', 'bytes', 'executable', 'role'])
        || asset.source !== 'acquisition'
        || asset.executable !== false
        || asset.role !== 'data'
        || !engine?.acquisition
        || asset.sha256 !== engine.acquisition.sha256
        || asset.bytes !== engine.acquisition.bytes
      ) invalid()
      const record = {
        kind: 'asset', engine: asset.engine, source: asset.source,
        sha256: asset.sha256, bytes: asset.bytes, mode: 0o444, relativePath: `Assets/${asset.sha256}`,
      }
      assets.set(tupleKey(asset), record)
    }
    for (const license of family.engineLicenses) {
      if (!exactKeys(license, ['engine', 'source', 'destination', 'sha256', 'bytes'])) invalid()
      const engine = engines.get(license.engine)
      const matches = engine?.licenses?.some((candidate) => (
        candidate.kind === 'download'
        && candidate.url === license.source
        && candidate.sha256 === license.sha256
        && candidate.bytes === license.bytes
        && candidate.destination === license.destination
      ))
      if (!matches) invalid()
      const record = {
        kind: 'license', engine: license.engine, source: license.source,
        sha256: license.sha256, bytes: license.bytes, mode: 0o444, relativePath: `Licenses/${license.sha256}`,
      }
      licenses.set(tupleKey(license), record)
    }
  }
  const sort = (left, right) => compareUtf8(`${left.engine}\0${left.source}\0${left.sha256}`, `${right.engine}\0${right.source}\0${right.sha256}`)
  return { assets, licenses, records: [...assets.values(), ...licenses.values()].sort(sort) }
}

async function verifyRecord(root, record) {
  const path = join(root, ...record.relativePath.split('/'))
  const metadata = await lstat(path).catch(() => undefined)
  if (
    !isPathInsideRoot(root, path)
    || !metadata?.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || (metadata.mode & 0o777) !== record.mode
    || await realpath(path).catch(() => undefined) !== path
  ) invalid()
  const bytes = await readStableRegularFile(path, 'Locked engine asset')
  if (bytes.byteLength !== record.bytes || sha256(bytes) !== record.sha256) invalid()
  return path
}

export async function openLockedEngineAssets({ root, target, sourceLock, closureLock }) {
  requireAbsolutePath(root, 'Locked engine asset root')
  await requireDirectory(root, 'Locked engine asset root')
  const expected = expectedRecords({ target, sourceLock, closureLock })
  const manifestPath = join(root, 'manifest.json')
  const manifestMetadata = await lstat(manifestPath).catch(() => undefined)
  if (!manifestMetadata?.isFile() || (manifestMetadata.mode & 0o777) !== 0o444) invalid()
  const bytes = await readStableRegularFile(manifestPath, 'Locked engine asset manifest', 1024 * 1024)
  let manifest
  try { manifest = JSON.parse(bytes.toString('utf8')) } catch { invalid() }
  if (
    !bytes.equals(canonicalBytes(manifest))
    || !exactKeys(manifest, ['schemaVersion', 'target', 'records'])
    || manifest.schemaVersion !== 1
    || manifest.target !== target
    || !canonicalBytes(manifest.records).equals(canonicalBytes(expected.records))
  ) invalid()
  for (const record of expected.records) await verifyRecord(root, record)
  return Object.freeze({
    target,
    root,
    async resolveEngineAsset(value) {
      const record = expected.assets.get(tupleKey(value))
      if (!record) invalid()
      return verifyRecord(root, record)
    },
    async resolveEngineLicense(value) {
      const record = expected.licenses.get(tupleKey(value))
      if (!record) invalid()
      return verifyRecord(root, record)
    },
    async contains(path) {
      if (typeof path !== 'string' || !isPathInsideRoot(root, path)) return false
      return expected.records.some((record) => join(root, ...record.relativePath.split('/')) === path)
        && Boolean(await lstat(path).catch(() => undefined))
    },
  })
}

export async function materializeLockedEngineAssets({
  target,
  sourceLock,
  closureLock,
  blobs,
  outputRoot,
  beforePublishForTest,
  afterClaimOpenForTest,
  removePrivateRootForTest,
  claimInitializationCleanupForTest,
}) {
  requireAbsolutePath(outputRoot, 'Locked engine asset root')
  if (!(blobs instanceof Map)) invalid()
  const expected = expectedRecords({ target, sourceLock, closureLock })
  await publishPrivateDirectory({
    destination: outputRoot,
    beforePublishForTest,
    afterClaimOpenForTest,
    removePrivateRootForTest,
    claimInitializationCleanupForTest,
    verifyExisting: (root) => openLockedEngineAssets({ root, target, sourceLock, closureLock }),
    populate: async (privateRoot, heartbeat) => {
    await mkdir(join(privateRoot, 'Assets'), { mode: 0o700 })
    await mkdir(join(privateRoot, 'Licenses'), { mode: 0o700 })
    const copied = new Set()
    for (const record of expected.records) {
      if (copied.has(record.relativePath)) continue
      copied.add(record.relativePath)
      const blob = blobs.get(record.sha256)
      if (!blob || blob.sha256 !== record.sha256 || blob.bytes !== record.bytes || typeof blob.path !== 'string') invalid()
      const source = await readStableRegularFile(blob.path, 'Locked engine blob')
      if (source.byteLength !== record.bytes || sha256(source) !== record.sha256) invalid()
      const destination = join(privateRoot, ...record.relativePath.split('/'))
      await writeDurableFile(destination, source, record.mode)
      await heartbeat.pulse()
    }
    const manifest = { schemaVersion: 1, target, records: expected.records }
      await writeDurableFile(join(privateRoot, 'manifest.json'), canonicalBytes(manifest), 0o444)
    },
  })
  return openLockedEngineAssets({ root: outputRoot, target, sourceLock, closureLock })
}
