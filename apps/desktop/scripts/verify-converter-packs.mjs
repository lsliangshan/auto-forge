import { createPrivateKey, createPublicKey, verify as verifySignature } from 'node:crypto'
import { Buffer } from 'node:buffer'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs'
import { readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL, URL } from 'node:url'
import {
  approvedTarget,
  archiveFilename,
  canonicalBytes,
  compareUtf8,
  fail,
  parseArguments,
  readStableRegularFile,
  releaseMode,
  requireAbsolutePath,
  requireDirectory,
  sha256,
  validateIndex,
  verifyRestrictedUstar,
} from './converter-packs/pack-tooling-lib.mjs'

const desktopRoot = fileURLToPath(new URL('..', import.meta.url))
// Electron's Node runtime otherwise treats every `.asar` path as a virtual
// filesystem. Boundary verification must inspect the regular archive itself.
process.noAsar = true
const privateKeyPattern = /-----BEGIN [^-\r\n]*PRIVATE KEY-----/u
const privateKeyScanLimit = 1024 * 1024
const forbiddenSegments = new Set([
  'test', 'tests', '__tests__', 'spec', 'fixtures', 'e2e', '.e2e', 'stale', 'test-results', 'playwright-report',
])
const forbiddenEngineNames = new Set([
  'ffmpeg', 'ffmpeg.exe', 'ffprobe', 'ffprobe.exe', 'soffice', 'soffice.exe',
  'autoforge-image-converter', 'autoforge-image-converter.exe',
  'autoforge-pdf-raster', 'autoforge-pdf-raster.exe', 'pdfinfo', 'pdfinfo.exe',
])

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
}

function readStableRegularFileSync(path, label, maximumBytes = Number.MAX_SAFE_INTEGER) {
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || realpathSync(path) !== path) {
    fail(`${label} must be one regular, non-linked file without symbolic path components.`)
  }
  let descriptor
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(descriptor)
    if (!opened.isFile() || opened.nlink !== 1 || !sameFile(before, opened)) fail(`${label} changed while opening.`)
    const bytes = opened.size <= maximumBytes ? readFileSync(descriptor) : undefined
    const afterHandle = fstatSync(descriptor)
    const afterPath = lstatSync(path)
    if (
      (bytes !== undefined && bytes.byteLength !== opened.size)
      || afterHandle.nlink !== 1
      || afterPath.nlink !== 1
      || !sameFile(opened, afterHandle)
      || !sameFile(opened, afterPath)
    ) fail(`${label} changed while reading.`)
    return bytes
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function requireStableDirectorySync(path, label) {
  const metadata = lstatSync(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(path) !== path) {
    fail(`${label} must be a directory without symbolic path components.`)
  }
}

function pathIsWithin(root, candidate) {
  const path = relative(root, candidate)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

function decodeAsar(path) {
  const bytes = readStableRegularFileSync(path, 'Packaged app.asar')
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
  return { bytes, header, contentOffset: 8 + headerSize }
}

function forbiddenPackagedPath(path) {
  const lowerSegments = path.split('/').map((segment) => segment.toLowerCase())
  const name = lowerSegments.at(-1) ?? ''
  if (lowerSegments.some((segment) => forbiddenSegments.has(segment))) return 'stale/test/e2e'
  if (lowerSegments.some((segment) => segment === 'converter-engines' || segment === 'converter-packs')) return 'converter pack'
  if (forbiddenEngineNames.has(name)) return 'engine'
  if (
    /(?:^|[-_.])(?:private[-_]?key|test-converter-root)(?:[-_.]|$)/iu.test(name)
    || /\.(?:pem|key|p12|pfx|tar|tgz|tar\.gz|zip|7z|rar|sig|asc)$/iu.test(name)
    || /(?:^|\.)index\.sig$/iu.test(name)
  ) return 'trust/archive/signature'
  if (/\.(?:test|spec)\.(?:[cm]?[jt]sx?|vue)$/iu.test(name)) return 'test'
  return undefined
}

function rejectPrivateKey(bytes, label) {
  if (bytes === undefined) return
  if (privateKeyPattern.test(bytes.toString('utf8'))) fail(`${label} contains private key material.`)
  if (bytes.byteLength === 0 || bytes.byteLength > privateKeyScanLimit || bytes[0] !== 0x30) return
  for (const type of ['pkcs8', 'pkcs1', 'sec1']) {
    let parsed = false
    try { createPrivateKey({ key: bytes, format: 'der', type }); parsed = true } catch { /* not this DER private-key encoding */ }
    if (parsed) fail(`${label} contains private key material.`)
  }
}

function collectAsarEntries(node, prefix = '', entries = []) {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) fail('Packaged app.asar file tree is invalid.')
  const files = node.files
  if (typeof files !== 'object' || files === null || Array.isArray(files)) return entries
  for (const name of Object.keys(files).sort(compareUtf8)) {
    const value = files[name]
    if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('Packaged app.asar file tree is invalid.')
    const path = prefix ? `${prefix}/${name}` : name
    const reason = forbiddenPackagedPath(path)
    if (reason) fail(`Packaged app.asar contains forbidden ${reason} path: ${path}`)
    if (value.files !== undefined) {
      collectAsarEntries(value, path, entries)
      continue
    }
    if (value.unpacked === true) continue
    const size = value.size
    const offsetText = value.offset
    if (!Number.isSafeInteger(size) || size < 0 || typeof offsetText !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(offsetText)) {
      fail('Packaged app.asar file tree is invalid.')
    }
    const offset = Number(offsetText)
    if (!Number.isSafeInteger(offset)) {
      fail('Packaged app.asar file tree is invalid.')
    }
    entries.push({ path, offset, size })
  }
  return entries
}

function scanCanonicalAsarEntries(archive) {
  const entries = collectAsarEntries(archive.header)
  const nonempty = entries.filter(({ size }) => size > 0).sort((left, right) =>
    left.offset - right.offset || compareUtf8(left.path, right.path),
  )
  let extent = 0
  for (const entry of nonempty) {
    if (entry.offset !== extent) fail('Packaged app.asar payload extent is not canonical.')
    extent += entry.size
    if (!Number.isSafeInteger(extent)) fail('Packaged app.asar file tree is invalid.')
  }
  if (archive.contentOffset + extent !== archive.bytes.byteLength) {
    fail('Packaged app.asar payload extent does not match its raw file size.')
  }
  for (const entry of entries) {
    if (entry.offset > extent || entry.size > extent - entry.offset) fail('Packaged app.asar file tree is invalid.')
    rejectPrivateKey(
      archive.bytes.subarray(archive.contentOffset + entry.offset, archive.contentOffset + entry.offset + entry.size),
      `Packaged app.asar ${entry.path}`,
    )
  }
}

function expectedMetadataBytes(name) {
  const path = join(desktopRoot, 'resources', 'converter-packs', name)
  const bytes = readStableRegularFileSync(path, `Pinned ${name}`)
  let parsed
  try { parsed = JSON.parse(bytes.toString('utf8')) } catch { fail(`Pinned ${name} is invalid.`) }
  if (!bytes.equals(canonicalBytes(parsed))) fail(`Pinned ${name} is not canonical.`)
  return bytes
}

function validateBootstrap(root) {
  requireStableDirectorySync(root, 'Packaged converter metadata')
  const allowed = ['bootstrap.json', 'index.schema.json', 'root-public-key.pem']
  const names = readdirSync(root).sort(compareUtf8)
  if (names.some((name) => !allowed.includes(name))) fail('Packaged converter metadata contains an unexpected file.')
  if (!names.includes('bootstrap.json') || !names.includes('index.schema.json')) fail('Packaged converter metadata is incomplete.')
  for (const name of ['bootstrap.json', 'index.schema.json']) {
    const packaged = readStableRegularFileSync(join(root, name), `Packaged ${name}`)
    if (!packaged.equals(expectedMetadataBytes(name))) fail(`Packaged ${name} does not have exact canonical content.`)
  }
  const bootstrap = JSON.parse(readStableRegularFileSync(join(root, 'bootstrap.json'), 'Packaged bootstrap.json').toString('utf8'))
  if (
    bootstrap.schemaVersion !== 1
    || bootstrap.downloadsEnabled !== false
    || bootstrap.indexUrl !== null
    || bootstrap.rootPublicKeyFile !== null
    || JSON.stringify(bootstrap.requiredPackFamilies) !== JSON.stringify(['image-icon', 'document', 'pdf', 'media'])
    || JSON.stringify(bootstrap.supportedTargets) !== JSON.stringify(['darwin-arm64', 'darwin-x64', 'win32-x64'])
  ) fail('Packaged converter bootstrap must remain fail-closed.')
  if (names.includes('root-public-key.pem')) fail('Packaged root key is present while the converter download kill switch is disabled.')
}

function packagedResources(app, platform) {
  if (platform === 'darwin') return join(app, 'Contents', 'Resources')
  if (platform === 'win32') return join(app, 'resources')
  fail('Packaged converter verification supports macOS and Windows only.')
}

export function verifyPackagedConverterBoundary(appPath, { platform = process.platform, arch = process.arch } = {}) {
  requireAbsolutePath(appPath, 'Packaged app path')
  if (!approvedTarget(platform, arch)) fail('Packaged converter target is unsupported.')
  requireStableDirectorySync(appPath, 'Packaged app path')
  const resources = packagedResources(appPath, platform)
  requireStableDirectorySync(resources, 'Packaged resources')
  const appAsar = join(resources, 'app.asar')
  const converterMetadata = join(resources, 'converter-packs')
  if (!existsSync(appAsar) || !existsSync(converterMetadata)) fail('Packaged converter boundary is incomplete.')
  validateBootstrap(converterMetadata)
  const archive = decodeAsar(appAsar)
  scanCanonicalAsarEntries(archive)

  const metadataRelative = platform === 'darwin'
    ? 'Contents/Resources/converter-packs'
    : 'resources/converter-packs'
  const asarRelative = platform === 'darwin' ? 'Contents/Resources/app.asar' : 'resources/app.asar'
  const visit = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => compareUtf8(a.name, b.name))) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolute = join(directory, entry.name)
      const node = lstatSync(absolute)
      const metadata = path === metadataRelative || path.startsWith(`${metadataRelative}/`)
      if (!metadata && path !== asarRelative) {
        const reason = forbiddenPackagedPath(path)
        if (reason) fail(`Packaged app contains forbidden ${reason} path: ${path}`)
      }
      if (node.isSymbolicLink()) {
        if (!pathIsWithin(appPath, realpathSync(absolute))) {
          fail(`Packaged app contains a symbolic link outside its package root: ${path}`)
        }
        continue
      }
      if (entry.isDirectory()) {
        requireStableDirectorySync(absolute, `Packaged app ${path}`)
        visit(absolute, path)
      } else {
        const bytes = readStableRegularFileSync(absolute, `Packaged app ${path}`, privateKeyScanLimit)
        if (!metadata && path !== asarRelative) rejectPrivateKey(bytes, `Packaged app ${path}`)
      }
    }
  }
  visit(appPath)
  process.stdout.write(`verified ${platform}-${arch} packaged converter boundary: kill switch off, no private key, unsigned engine, archive, signature, test, e2e, or stale material\n`)
}

export async function verifyConverterPackRelease({ root, publicKeyPath, mode = 'production' }) {
  mode = releaseMode(mode)
  requireAbsolutePath(root, 'Release root')
  requireAbsolutePath(publicKeyPath, 'Public key path')
  await requireDirectory(root, 'Release root')
  const indexBytes = await readStableRegularFile(join(root, 'index.json'), 'Index')
  const signatureBytes = await readStableRegularFile(join(root, 'index.sig'), 'Signature')
  const publicKeyBytes = await readStableRegularFile(publicKeyPath, 'Public key')
  let index
  try { index = validateIndex(JSON.parse(indexBytes.toString('utf8')), mode) } catch { fail('Signed index is invalid.') }
  if (!indexBytes.equals(canonicalBytes(index))) fail('Signed index is not canonical.')
  const signatureText = signatureBytes.toString('utf8').trim()
  const signature = Buffer.from(signatureText, 'base64')
  if (signature.byteLength !== 64 || signature.toString('base64') !== signatureText) fail('Signed index signature is invalid.')
  let publicKey
  try { publicKey = createPublicKey(publicKeyBytes) } catch { fail('Public key is invalid.') }
  if (publicKey.asymmetricKeyType !== 'ed25519' || !verifySignature(null, indexBytes, publicKey, signature)) {
    fail('Signed index signature is invalid.')
  }

  const expectedNames = new Set(['index.json', 'index.sig'])
  for (const descriptor of index.packs) {
    const archiveName = archiveFilename(descriptor)
    if (expectedNames.has(archiveName)) fail('Release contains duplicate archive names.')
    expectedNames.add(archiveName)
    const archive = await readStableRegularFile(join(root, archiveName), 'Pack archive', descriptor.archiveBytes)
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

function defaultPackagedApp() {
  if (process.platform === 'darwin' && process.arch === 'arm64') return join(desktopRoot, 'dist', 'mac-arm64', 'AutoForge.app')
  if (process.platform === 'darwin' && process.arch === 'x64') return join(desktopRoot, 'dist', 'mac', 'AutoForge.app')
  if (process.platform === 'win32' && process.arch === 'x64') return join(desktopRoot, 'dist', 'win-unpacked')
  fail('Packaged converter verification supports darwin arm64/x64 and win32 x64 only.')
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  if (process.argv.length === 2) {
    verifyPackagedConverterBoundary(defaultPackagedApp())
  } else if (process.argv[2] === '--packaged-app') {
    const args = parseArguments(process.argv.slice(2), ['--packaged-app', '--platform', '--arch'], ['--packaged-app'])
    verifyPackagedConverterBoundary(args['--packaged-app'], { platform: args['--platform'] ?? process.platform, arch: args['--arch'] ?? process.arch })
  } else {
    const args = parseArguments(process.argv.slice(2), ['--root', '--public-key', '--mode'], ['--root', '--public-key'])
    await verifyConverterPackRelease({ root: args['--root'], publicKeyPath: args['--public-key'], mode: args['--mode'] })
  }
}
