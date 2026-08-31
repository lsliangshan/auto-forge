import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { pathToFileURL, URL } from 'node:url'
import {
  archiveFilename,
  canonicalBytes,
  compareUtf8,
  fail,
  parseArguments,
  readCanonicalJson,
  readStableRegularFile,
  releaseMode,
  requireAbsolutePath,
  requireDirectory,
  safeEntryPath,
  sha256,
  validateIndex,
} from './pack-tooling-lib.mjs'
import { verifyConverterPackRelease } from '../verify-converter-packs.mjs'

function validPublicBase(value) {
  let parsed
  try { parsed = new URL(value) } catch { fail('Public base URL must be HTTPS.') }
  if (
    parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
    || parsed.pathname.endsWith('/')
    || parsed.href !== value
  ) fail('Public base URL must be canonical HTTPS without credentials.')
  return value
}

function safeObjectKey(key) {
  return typeof key === 'string'
    && safeEntryPath(key)
    && key.split('/').every((segment) => !segment.startsWith('.'))
}

async function writeImmutable(path, bytes) {
  try {
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
    const existing = await readStableRegularFile(path, 'Existing immutable object')
    if (!existing.equals(bytes)) fail('Immutable object already exists with different bytes.')
  }
}

export function createFilesystemObjectStore({ root, beforePromote, afterRead } = {}) {
  requireAbsolutePath(root, 'Filesystem object store root')
  const resolveKey = (key) => {
    if (!safeObjectKey(key)) fail('Object key is unsafe.')
    return join(root, ...key.split('/'))
  }
  return Object.freeze({
    async putImmutable(key, bytes) {
      await requireDirectory(root, 'Filesystem object store root')
      const path = resolveKey(key)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeImmutable(path, bytes)
    },
    async read(key) {
      const bytes = await readStableRegularFile(resolveKey(key), 'Published object')
      return typeof afterRead === 'function' ? afterRead(key, bytes) : bytes
    },
    async promoteStable({ generation, indexBytes, signatureBytes }) {
      await requireDirectory(root, 'Filesystem object store root')
      if (!Number.isSafeInteger(generation) || generation < 0) fail('Stable generation is invalid.')
      const nonce = randomUUID()
      const staged = join(root, `.stable-${generation}-${nonce}`)
      const stable = join(root, 'stable')
      const backup = join(root, `.stable-backup-${nonce}`)
      await mkdir(staged, { mode: 0o700 })
      try {
        await Promise.all([
          writeFile(join(staged, 'index.json'), indexBytes, { flag: 'wx', mode: 0o600 }),
          writeFile(join(staged, 'index.sig'), signatureBytes, { flag: 'wx', mode: 0o600 }),
        ])
        if (typeof beforePromote === 'function') await beforePromote()
        const hasStable = await lstat(stable).then(() => true, () => false)
        if (hasStable) await rename(stable, backup)
        try {
          await rename(staged, stable)
        } catch (error) {
          if (hasStable) await rename(backup, stable).catch(() => undefined)
          throw error
        }
        if (hasStable) await rm(backup, { recursive: true, force: true })
      } catch (error) {
        await rm(staged, { recursive: true, force: true })
        throw error
      }
    },
  })
}

async function defaultCoscliRun(executable, args) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' },
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

export function createCoscliObjectStore({ coscliPath, configPath, bucket, scratchRoot, run = defaultCoscliRun } = {}) {
  requireAbsolutePath(coscliPath, 'COSCLI executable')
  requireAbsolutePath(configPath, 'COSCLI config')
  requireAbsolutePath(scratchRoot, 'COSCLI scratch root')
  if (!/^[a-z0-9][a-z0-9-]{1,50}-[1-9]\d{4,19}$/u.test(bucket ?? '') || typeof run !== 'function') {
    fail('COSCLI object store configuration is invalid.')
  }
  let ready
  const ensureReady = async () => {
    if (ready !== undefined) return ready
    ready = Promise.all([
      lstat(coscliPath).then(async (metadata) => {
        if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o111) === 0 || await realpath(coscliPath) !== coscliPath) {
          fail('COSCLI executable is invalid.')
        }
      }),
      lstat(configPath).then(async (metadata) => {
        if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 || await realpath(configPath) !== configPath) {
          fail('COSCLI config must be a private regular file.')
        }
      }),
      requireDirectory(scratchRoot, 'COSCLI scratch root'),
    ])
    return ready
  }
  const execute = async (args) => {
    const result = await run(coscliPath, [
      ...args, '--config-path', configPath, '--disable-log', '--process-log=false',
    ], { env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' } })
    if (!result || result.status !== 0) fail('COSCLI object operation failed.')
  }
  const remote = (key) => {
    if (!safeObjectKey(key)) fail('Object key is unsafe.')
    return `cos://${bucket}/${key}`
  }
  const upload = async (key, bytes, immutable) => {
    await ensureReady()
    const temporary = await mkdtemp(join(scratchRoot, '.coscli-upload-'))
    try {
      const local = join(temporary, 'object')
      await writeFile(local, bytes, { flag: 'wx', mode: 0o600 })
      await execute(['cp', local, remote(key), ...(immutable ? ['--forbid-overwrite'] : [])])
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }
  const download = async (key) => {
    await ensureReady()
    const temporary = await mkdtemp(join(scratchRoot, '.coscli-download-'))
    try {
      const local = join(temporary, 'object')
      await execute(['cp', remote(key), local])
      return await readStableRegularFile(local, 'COSCLI downloaded object')
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }
  return Object.freeze({
    async putImmutable(key, bytes) {
      try {
        await upload(key, bytes, true)
      } catch (error) {
        const existing = await download(key).catch(() => undefined)
        if (existing === undefined || !existing.equals(bytes)) throw error
      }
    },
    read: download,
    async promoteStable({ generation, indexBytes, signatureBytes }) {
      if (!Number.isSafeInteger(generation) || generation < 0) fail('Stable generation is invalid.')
      await upload(`stable-generations/${generation}/index.json`, indexBytes, true)
      await upload(`stable-generations/${generation}/index.sig`, signatureBytes, true)
      let previousIndex
      let previousSignature
      try {
        [previousIndex, previousSignature] = await Promise.all([download('stable/index.json'), download('stable/index.sig')])
      } catch { /* first publication has no stable pair */ }
      try {
        await upload('stable/index.sig', signatureBytes, false)
        await upload('stable/index.json', indexBytes, false)
      } catch (error) {
        if (previousIndex !== undefined && previousSignature !== undefined) {
          await upload('stable/index.sig', previousSignature, false).catch(() => undefined)
          await upload('stable/index.json', previousIndex, false).catch(() => undefined)
        }
        throw error
      }
    },
  })
}

async function releaseObjects({ releaseRoot, publicBaseUrl, sequence, mode }) {
  const { bytes: indexBytes, value: parsed } = await readCanonicalJson(join(releaseRoot, 'index.json'), 'Release index')
  const index = validateIndex(parsed, mode)
  if (!indexBytes.equals(canonicalBytes(index))) fail('Release index must use canonical JSON.')
  if (index.sequence !== sequence) fail('Release sequence does not match publication sequence.')
  const signatureBytes = await readStableRegularFile(join(releaseRoot, 'index.sig'), 'Release index signature', 16 * 1024)
  const expectedNames = ['index.json', 'index.sig']
  const objects = []
  for (const descriptor of index.packs) {
    const filename = archiveFilename(descriptor)
    const expectedUrl = `${publicBaseUrl}/releases/${sequence}/${filename}`
    if (descriptor.archiveUrl !== expectedUrl) fail('Pack archive URL does not use the immutable release destination.')
    const bytes = await readStableRegularFile(join(releaseRoot, filename), 'Release pack archive', descriptor.archiveBytes)
    if (bytes.byteLength !== descriptor.archiveBytes || sha256(bytes) !== descriptor.archiveSha256) {
      fail('Release pack archive does not match its signed descriptor.')
    }
    expectedNames.push(filename)
    objects.push({ key: `releases/${sequence}/${filename}`, bytes })
  }
  const actualNames = (await readdir(releaseRoot)).sort(compareUtf8)
  expectedNames.sort(compareUtf8)
  if (actualNames.join('\0') !== expectedNames.join('\0')) fail('Release root contains an unknown or private file.')
  objects.sort((left, right) => compareUtf8(left.key, right.key))
  objects.push(
    { key: `releases/${sequence}/index.json`, bytes: indexBytes },
    { key: `releases/${sequence}/index.sig`, bytes: signatureBytes },
  )
  return { indexBytes, signatureBytes, objects }
}

export async function publishConverterPackRelease({
  releaseRoot,
  publicKeyPath,
  publicBaseUrl,
  sequence,
  store,
  mode = 'production',
}) {
  requireAbsolutePath(releaseRoot, 'Release root')
  requireAbsolutePath(publicKeyPath, 'Release public key')
  await requireDirectory(releaseRoot, 'Release root')
  validPublicBase(publicBaseUrl)
  mode = releaseMode(mode)
  if (!Number.isSafeInteger(sequence) || sequence < 0) fail('Publication sequence is invalid.')
  if (
    typeof store !== 'object'
    || store === null
    || typeof store.putImmutable !== 'function'
    || typeof store.read !== 'function'
    || typeof store.promoteStable !== 'function'
  ) fail('Object store adapter is invalid.')
  await verifyConverterPackRelease({ root: releaseRoot, publicKeyPath, mode })
  const release = await releaseObjects({ releaseRoot, publicBaseUrl, sequence, mode })
  for (const object of release.objects) {
    await store.putImmutable(object.key, object.bytes, {
      sha256: sha256(object.bytes), bytes: object.bytes.byteLength,
    })
    const readBack = await store.read(object.key)
    if (!Buffer.isBuffer(readBack) || !readBack.equals(object.bytes)) fail(`Published object read-back mismatch: ${object.key}`)
  }
  await store.promoteStable({
    generation: sequence,
    indexBytes: release.indexBytes,
    signatureBytes: release.signatureBytes,
  })
  const [stableIndex, stableSignature] = await Promise.all([
    store.read('stable/index.json'),
    store.read('stable/index.sig'),
  ])
  if (!stableIndex.equals(release.indexBytes) || !stableSignature.equals(release.signatureBytes)) {
    fail('Stable publication read-back mismatch.')
  }
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const args = parseArguments(process.argv.slice(2), [
    '--release', '--public-key', '--public-base-url', '--sequence', '--filesystem-root', '--mode',
    '--coscli', '--cos-config', '--cos-bucket', '--cos-scratch',
  ], ['--release', '--public-key', '--public-base-url', '--sequence'])
  if (!/^(?:0|[1-9]\d*)$/u.test(args['--sequence'])) fail('Publication sequence is invalid.')
  const filesystem = args['--filesystem-root'] !== undefined
  const cosValues = ['--coscli', '--cos-config', '--cos-bucket', '--cos-scratch'].map((flag) => args[flag])
  const cos = cosValues.every((value) => value !== undefined)
  if (filesystem === cos || (!cos && cosValues.some((value) => value !== undefined))) {
    fail('Choose exactly one complete publication adapter.')
  }
  await publishConverterPackRelease({
    releaseRoot: args['--release'], publicKeyPath: args['--public-key'], publicBaseUrl: args['--public-base-url'],
    sequence: Number(args['--sequence']), mode: args['--mode'],
    store: filesystem
      ? createFilesystemObjectStore({ root: args['--filesystem-root'] })
      : createCoscliObjectStore({
          coscliPath: args['--coscli'], configPath: args['--cos-config'],
          bucket: args['--cos-bucket'], scratchRoot: args['--cos-scratch'],
        }),
  })
  process.stdout.write('published immutable converter pack release\n')
}
