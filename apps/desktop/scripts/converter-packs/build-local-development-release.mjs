import { createPrivateKey, createPublicKey, verify } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import {
  archiveFilename,
  canonicalBytes,
  fail,
  readStableRegularFile,
  requireAbsolutePath,
  requireDirectory,
  sha256,
  validateIndex,
  writeRestrictedUstarEntries,
} from './pack-tooling-lib.mjs'
import { buildConverterPackIndex } from './build-index.mjs'
import { signConverterPackIndex } from './sign-index.mjs'

const families = Object.freeze(['image-icon', 'document', 'pdf', 'media'])

function releaseTarget(platform = process.platform, arch = process.arch) {
  if (platform !== 'darwin' || (arch !== 'arm64' && arch !== 'x64')) {
    fail('Local development converter releases support only current darwin-arm64 or darwin-x64 targets.')
  }
  return { platform, arch }
}

function expectedDescriptors(index, platform, arch) {
  if (index.packs.length !== families.length) fail('Development release must contain exactly four converter pack families.')
  const expected = new Set(families)
  for (const descriptor of index.packs) {
    if (descriptor.platform !== platform || descriptor.arch !== arch || !expected.delete(descriptor.name)) {
      fail('Development release has an unexpected converter pack coordinate.')
    }
  }
  if (expected.size !== 0) fail('Development release is missing a converter pack family.')
  return index.packs
}

async function exactDirectoryNames(root, expected, label) {
  const entries = await readdir(root, { withFileTypes: true })
  const names = entries.map((entry) => entry.name).sort()
  const sortedExpected = [...expected].sort()
  if (names.length !== sortedExpected.length || names.some((name, index) => name !== sortedExpected[index])) {
    fail(`${label} contains unexpected entries.`)
  }
  return entries
}

async function requireRegularEntry(path, label) {
  const metadata = await lstat(path).catch(() => undefined)
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) fail(`${label} must be a regular file.`)
  return metadata
}

async function verifyInstalledEntries(root, descriptor) {
  const allowedFiles = new Set(descriptor.entries.map((entry) => entry.path))
  const allowedDirectories = new Set([''])
  for (const entry of descriptor.entries) {
    const parts = entry.path.split('/')
    for (let index = 1; index < parts.length; index += 1) allowedDirectories.add(parts.slice(0, index).join('/'))
  }
  async function walk(directory, relative = '') {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) fail('Installed converter release contains a symbolic link.')
      if (entry.isDirectory()) {
        if (!allowedDirectories.has(child)) fail('Installed converter release contains an unexpected directory.')
        await requireDirectory(path, 'Installed converter release directory')
        await walk(path, child)
      } else if (!entry.isFile() || !allowedFiles.has(child)) {
        fail('Installed converter release contains an unexpected entry.')
      }
    }
  }
  await walk(root)
  for (const entry of descriptor.entries) {
    const path = join(root, ...entry.path.split('/'))
    const metadata = await requireRegularEntry(path, 'Installed converter release entry')
    if ((metadata.mode & 0o777) !== (entry.executable ? 0o755 : 0o644)) fail('Installed converter release entry mode mismatch.')
    const bytes = await readStableRegularFile(path, 'Installed converter release entry', entry.bytes)
    if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) fail('Installed converter release entry hash mismatch.')
  }
}

async function readVerifiedIndex(releaseRoot, platform, arch) {
  const indexBytes = await readStableRegularFile(join(releaseRoot, 'index.json'), 'Development release index')
  let index
  try { index = validateIndex(JSON.parse(indexBytes.toString('utf8')), 'test') } catch { fail('Development release index is invalid.') }
  if (!indexBytes.equals(canonicalBytes(index))) fail('Development release index is non-canonical.')
  expectedDescriptors(index, platform, arch)
  return { index, indexBytes }
}

export async function buildLocalDevelopmentRelease({ stagingRoot, outputRoot, privateKeyPath, publicKeyPath }) {
  const { platform, arch } = releaseTarget()
  requireAbsolutePath(stagingRoot, 'Staging root')
  requireAbsolutePath(outputRoot, 'Output root')
  requireAbsolutePath(privateKeyPath, 'Private key path')
  requireAbsolutePath(publicKeyPath, 'Public key path')
  await requireDirectory(stagingRoot, 'Staging root')
  await requireDirectory(dirname(outputRoot), 'Output parent')
  if (await lstat(outputRoot).catch(() => undefined)) fail('Output root already exists.')
  const privateBytes = await readStableRegularFile(privateKeyPath, 'Private key')
  const publicBytes = await readStableRegularFile(publicKeyPath, 'Public key')
  let privateKey
  let publicKey
  try {
    privateKey = createPrivateKey(privateBytes)
    publicKey = createPublicKey(publicBytes)
  } catch { fail('Development release signing keys are invalid.') }
  if (
    privateKey.asymmetricKeyType !== 'ed25519'
    || publicKey.asymmetricKeyType !== 'ed25519'
    || !createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).equals(publicKey.export({ format: 'der', type: 'spki' }))
  ) fail('Public key does not match the Ed25519 signing key.')

  const temporary = await realpath(await mkdtemp(join(dirname(outputRoot), '.local-development-release-')))
  try {
    const built = join(temporary, '.packs')
    await buildConverterPackIndex({ input: stagingRoot, output: built, mode: 'test' })
    await signConverterPackIndex({ indexPath: join(built, 'index.json'), privateKeyPath, mode: 'test' })
    const { index, indexBytes } = await readVerifiedIndex(built, platform, arch)
    const signature = await readStableRegularFile(join(built, 'index.sig'), 'Development release signature')
    if (!verify(null, indexBytes, publicKey, Buffer.from(signature.toString('utf8').trim(), 'base64'))) fail('Development release index signature is invalid.')
    for (const descriptor of index.packs) {
      const archive = await readStableRegularFile(join(built, archiveFilename(descriptor)), 'Development release archive', descriptor.archiveBytes)
      if (archive.byteLength !== descriptor.archiveBytes || sha256(archive) !== descriptor.archiveSha256) fail('Development release archive hash mismatch.')
      const destination = join(temporary, 'installed', descriptor.name, descriptor.version, `${platform}-${arch}`)
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      await writeRestrictedUstarEntries({
        archive,
        descriptor,
        destination,
      })
    }
    await Promise.all([
      writeFile(join(temporary, 'index.json'), indexBytes, { flag: 'wx', mode: 0o600 }),
      writeFile(join(temporary, 'index.sig'), signature, { flag: 'wx', mode: 0o600 }),
      writeFile(join(temporary, 'root-public-key.pem'), publicBytes, { flag: 'wx', mode: 0o600 }),
    ])
    await rm(built, { recursive: true, force: true })
    await rename(temporary, outputRoot)
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
}

export async function verifyLocalDevelopmentReleaseIntegrity({ releaseRoot, platform, arch }) {
  const target = releaseTarget(platform, arch)
  requireAbsolutePath(releaseRoot, 'Release root')
  await requireDirectory(releaseRoot, 'Release root')
  const rootEntries = await exactDirectoryNames(releaseRoot, ['index.json', 'index.sig', 'installed', 'root-public-key.pem'], 'Development release root')
  for (const entry of rootEntries) {
    if (entry.isSymbolicLink() || (entry.name === 'installed' ? !entry.isDirectory() : !entry.isFile())) fail('Development release root layout is invalid.')
  }
  const { index, indexBytes } = await readVerifiedIndex(releaseRoot, target.platform, target.arch)
  const publicKeyBytes = await readStableRegularFile(join(releaseRoot, 'root-public-key.pem'), 'Development release public key')
  const signature = await readStableRegularFile(join(releaseRoot, 'index.sig'), 'Development release signature')
  let publicKey
  try { publicKey = createPublicKey(publicKeyBytes) } catch { fail('Development release public key is invalid.') }
  if (publicKey.asymmetricKeyType !== 'ed25519' || !/^[A-Za-z0-9+/]+={0,2}\n$/u.test(signature.toString('utf8')) || !verify(null, indexBytes, publicKey, Buffer.from(signature.toString('utf8').trim(), 'base64'))) {
    fail('Development release index signature is invalid.')
  }
  const installedRoot = join(releaseRoot, 'installed')
  await requireDirectory(installedRoot, 'Installed converter release root')
  await exactDirectoryNames(installedRoot, families, 'Installed converter release root')
  for (const descriptor of index.packs) {
    const family = join(installedRoot, descriptor.name)
    const version = join(family, descriptor.version)
    const coordinate = join(version, `${target.platform}-${target.arch}`)
    await requireDirectory(family, 'Installed converter family')
    await exactDirectoryNames(family, [descriptor.version], 'Installed converter family')
    await requireDirectory(version, 'Installed converter version')
    await exactDirectoryNames(version, [`${target.platform}-${target.arch}`], 'Installed converter version')
    await requireDirectory(coordinate, 'Installed converter coordinate')
    await verifyInstalledEntries(coordinate, descriptor)
  }
}
