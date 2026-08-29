import { createPublicKey, verify as verifySignature } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL, URL } from 'node:url'
import {
  archiveFilename,
  canonicalBytes,
  fail,
  parseArguments,
  requireAbsolutePath,
  requireDirectory,
  requireRegularFile,
  sha256,
  validateIndex,
  verifyRestrictedUstar,
} from './converter-packs/pack-tooling-lib.mjs'

function decodeAsarHeader(path) {
  const bytes = readFileSync(path)
  if (bytes.byteLength < 16 || bytes.readUInt32LE(0) !== 4) fail('Packaged app.asar header is invalid.')
  const headerSize = bytes.readUInt32LE(4)
  if (headerSize < 8 || 8 + headerSize > bytes.byteLength) fail('Packaged app.asar header is invalid.')
  const payloadSize = bytes.readUInt32LE(8)
  const jsonBytes = bytes.readUInt32LE(12)
  if (payloadSize + 4 !== headerSize || jsonBytes > payloadSize - 4 || 16 + jsonBytes > bytes.byteLength) {
    fail('Packaged app.asar header is invalid.')
  }
  let header
  try { header = JSON.parse(bytes.subarray(16, 16 + jsonBytes).toString('utf8')) } catch { fail('Packaged app.asar header is invalid.') }
  return header
}

function flattenAsar(node, prefix = '', result = []) {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) fail('Packaged app.asar file tree is invalid.')
  const files = node.files
  if (typeof files !== 'object' || files === null || Array.isArray(files)) return result
  for (const [name, value] of Object.entries(files)) {
    const path = prefix ? `${prefix}/${name}` : name
    result.push(path)
    flattenAsar(value, path, result)
  }
  return result
}

function validateBootstrap(root) {
  const allowed = ['bootstrap.json', 'index.schema.json', 'root-public-key.pem']
  const names = readdirSync(root).sort()
  if (names.some((name) => !allowed.includes(name))) fail('Packaged converter metadata contains an unexpected file.')
  if (!names.includes('bootstrap.json') || !names.includes('index.schema.json')) fail('Packaged converter metadata is incomplete.')
  const bootstrap = JSON.parse(readFileSync(join(root, 'bootstrap.json'), 'utf8'))
  const keys = Object.keys(bootstrap).sort()
  if (
    keys.join('\0') !== ['downloadsEnabled', 'indexUrl', 'requiredPackFamilies', 'rootPublicKeyFile', 'schemaVersion', 'supportedTargets'].sort().join('\0')
    || bootstrap.schemaVersion !== 1
    || bootstrap.downloadsEnabled !== false
    || bootstrap.indexUrl !== null
    || bootstrap.rootPublicKeyFile !== null
    || JSON.stringify(bootstrap.requiredPackFamilies) !== JSON.stringify(['image-icon', 'document', 'pdf', 'media'])
    || JSON.stringify(bootstrap.supportedTargets) !== JSON.stringify(['darwin-arm64', 'darwin-x64', 'win32-x64'])
  ) fail('Packaged converter bootstrap must remain fail-closed.')
  if (names.includes('root-public-key.pem')) {
    let key
    try { key = createPublicKey(readFileSync(join(root, 'root-public-key.pem'))) } catch { fail('Packaged converter root key is invalid.') }
    if (key.asymmetricKeyType !== 'ed25519') fail('Packaged converter root key is invalid.')
    fail('Packaged root key is present while the converter download kill switch is disabled.')
  }
}

function packagedResources(app) {
  if (process.platform === 'darwin') return join(app, 'Contents', 'Resources')
  if (process.platform === 'win32') return join(app, 'resources')
  fail('Packaged converter verification supports macOS and Windows only.')
}

export function verifyPackagedConverterBoundary(appPath) {
  requireAbsolutePath(appPath, 'Packaged app path')
  const metadata = lstatSync(appPath)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(appPath) !== appPath) fail('Packaged app path is invalid.')
  const resources = packagedResources(appPath)
  const appAsar = join(resources, 'app.asar')
  const converterMetadata = join(resources, 'converter-packs')
  if (!existsSync(appAsar) || !statSync(appAsar).isFile()) fail('Packaged app.asar is missing.')
  if (!existsSync(converterMetadata) || !statSync(converterMetadata).isDirectory()) fail('Packaged converter metadata is missing.')
  validateBootstrap(converterMetadata)

  const forbidden = /(?:^|\/)(?:[^/]*(?:private[-_]?key|test-converter-root)[^/]*|[^/]+\.pem|[^/]+\.tar|index\.sig|ffmpeg(?:\.exe)?|ffprobe(?:\.exe)?|soffice(?:\.exe)?|autoforge-image-converter(?:\.exe)?|autoforge-pdf-raster(?:\.exe)?)$/iu
  const asarPaths = flattenAsar(decodeAsarHeader(appAsar))
  if (asarPaths.some((path) => forbidden.test(path))) fail('Packaged app.asar contains forbidden converter trust or engine material.')

  const visit = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolute = join(directory, entry.name)
      const node = lstatSync(absolute)
      if (node.isSymbolicLink()) fail('Packaged resources contain a symbolic link.')
      if (entry.isDirectory()) visit(absolute, path)
      else if (path !== 'app.asar' && !path.startsWith('converter-packs/') && forbidden.test(path)) {
        fail('Packaged resources contain forbidden converter trust or engine material.')
      }
    }
  }
  visit(resources)
  process.stdout.write('verified packaged converter boundary: kill switch off, no private key, unsigned engine, archive, or fixture root\n')
}

export async function verifyConverterPackRelease({ root, publicKeyPath }) {
  requireAbsolutePath(root, 'Release root')
  requireAbsolutePath(publicKeyPath, 'Public key path')
  await requireDirectory(root, 'Release root')
  await requireRegularFile(publicKeyPath, 'Public key')
  const rootReal = await realpathSafe(root)
  const keyReal = await realpathSafe(publicKeyPath)
  if (rootReal === keyReal || !isAbsolute(rootReal) || !isAbsolute(keyReal)) fail('Release verification paths are invalid.')
  const indexPath = join(root, 'index.json')
  const signaturePath = join(root, 'index.sig')
  await requireRegularFile(indexPath, 'Index')
  await requireRegularFile(signaturePath, 'Signature')
  const indexBytes = await readFile(indexPath)
  let index
  try { index = validateIndex(JSON.parse(indexBytes.toString('utf8'))) } catch { fail('Signed index is invalid.') }
  if (!indexBytes.equals(canonicalBytes(index))) fail('Signed index is not canonical.')
  const signatureText = (await readFile(signaturePath, 'utf8')).trim()
  const signature = Buffer.from(signatureText, 'base64')
  if (signature.byteLength !== 64 || signature.toString('base64') !== signatureText) fail('Signed index signature is invalid.')
  let publicKey
  try { publicKey = createPublicKey(await readFile(publicKeyPath)) } catch { fail('Public key is invalid.') }
  if (publicKey.asymmetricKeyType !== 'ed25519' || !verifySignature(null, indexBytes, publicKey, signature)) {
    fail('Signed index signature is invalid.')
  }

  const expectedNames = new Set(['index.json', 'index.sig'])
  for (const descriptor of index.packs) {
    const archiveName = archiveFilename(descriptor)
    if (expectedNames.has(archiveName)) fail('Release contains duplicate archive names.')
    expectedNames.add(archiveName)
    const archivePath = join(root, archiveName)
    await requireRegularFile(archivePath, 'Pack archive')
    const archive = await readFile(archivePath)
    if (archive.byteLength !== descriptor.archiveBytes) fail('Pack archive size mismatch.')
    if (sha256(archive) !== descriptor.archiveSha256) fail('Pack archive hash mismatch.')
    verifyRestrictedUstar(archive, descriptor)
  }
  const actual = await readdir(root, { withFileTypes: true })
  for (const entry of actual) {
    if (entry.isSymbolicLink() || !entry.isFile() || !expectedNames.has(entry.name)) fail('Release root contains an unexpected file or directory.')
  }
  if (actual.length !== expectedNames.size) fail('Release root contents do not match the signed index.')
  process.stdout.write(`verified ${index.packs.length} signed converter pack${index.packs.length === 1 ? '' : 's'}\n`)
}

async function realpathSafe(path) {
  const metadata = await lstat(path).catch(() => undefined)
  if (!metadata || metadata.isSymbolicLink()) fail('Verification paths may not use symbolic links.')
  const resolved = await import('node:fs/promises').then(({ realpath }) => realpath(path))
  return resolved
}

function defaultPackagedApp() {
  const desktop = fileURLToPath(new URL('..', import.meta.url))
  if (process.platform === 'darwin' && process.arch === 'arm64') return join(desktop, 'dist', 'mac-arm64', 'AutoForge.app')
  if (process.platform === 'darwin' && process.arch === 'x64') return join(desktop, 'dist', 'mac', 'AutoForge.app')
  if (process.platform === 'win32' && process.arch === 'x64') return join(desktop, 'dist', 'win-unpacked')
  fail('Packaged converter verification supports darwin arm64/x64 and win32 x64 only.')
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  if (process.argv.length === 2) {
    verifyPackagedConverterBoundary(defaultPackagedApp())
  } else if (process.argv[2] === '--packaged-app') {
    const args = parseArguments(process.argv.slice(2), ['--packaged-app'])
    verifyPackagedConverterBoundary(args['--packaged-app'])
  } else {
    const args = parseArguments(process.argv.slice(2), ['--root', '--public-key'])
    await verifyConverterPackRelease({ root: args['--root'], publicKeyPath: args['--public-key'] })
  }
}
