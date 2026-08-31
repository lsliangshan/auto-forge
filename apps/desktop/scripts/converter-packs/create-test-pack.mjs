import { Buffer } from 'node:buffer'
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL, URL } from 'node:url'

// RFC 8032 test vector 1. This deterministic seed is fixture-only and must
// never be replaced with, reused as, or confused with a production key.
const TEST_ONLY_ED25519_SEED = Buffer.from(
  '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
  'hex',
)
const TEST_ONLY_PUBLIC_DER = Buffer.from(
  '302a300506032b6570032100d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
  'hex',
)
const PRIVATE_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
const TEST_ONLY_PRIVATE_KEY = createPrivateKey({
  key: Buffer.concat([PRIVATE_PKCS8_PREFIX, TEST_ONLY_ED25519_SEED]),
  format: 'der',
  type: 'pkcs8',
})

const packNames = new Set(['image-icon', 'document', 'pdf', 'media'])
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

function writeString(block, offset, length, value) {
  const bytes = Buffer.from(value)
  if (bytes.byteLength > length) throw new Error('Fixture TAR field is too long')
  bytes.copy(block, offset)
}

function writeOctal(block, offset, length, value) {
  writeString(block, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`)
}

function createTar(path, bytes) {
  const header = Buffer.alloc(512)
  writeString(header, 0, 100, path)
  writeOctal(header, 100, 8, 0o755)
  writeOctal(header, 108, 8, 0)
  writeOctal(header, 116, 8, 0)
  writeOctal(header, 124, 12, bytes.byteLength)
  writeOctal(header, 136, 12, 0)
  header.fill(0x20, 148, 156)
  writeString(header, 156, 1, '0')
  writeString(header, 257, 6, 'ustar\0')
  writeString(header, 263, 2, '00')
  const checksum = header.reduce((sum, value) => sum + value, 0)
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `)
  const padding = (512 - (bytes.byteLength % 512)) % 512
  return Buffer.concat([header, bytes, Buffer.alloc(padding), Buffer.alloc(1_024)])
}

function argumentsFrom(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!flag?.startsWith('--') || value === undefined || values.has(flag)) throw new Error('Invalid fixture arguments')
    values.set(flag, value)
  }
  const allowed = new Set(['--output', '--archive-url', '--name', '--version', '--platform', '--arch', '--sequence'])
  if ([...values.keys()].some((key) => !allowed.has(key)) || [...allowed].some((key) => !values.has(key))) {
    throw new Error('All fixture arguments are required')
  }
  return Object.fromEntries([...values].map(([key, value]) => [key.slice(2), value]))
}

function testOnlyArchiveUrl(value) {
  const url = new URL(value)
  const local = url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === 'localhost'
  if (url.protocol !== 'https:' || (!local && !url.hostname.endsWith('.test')) || url.username || url.password || url.hash) {
    throw new Error('Fixture archive URL must use HTTPS on loopback or a reserved .test host')
  }
  return value
}

function approvedTarget(platform, arch) {
  return (platform === 'darwin' && (arch === 'arm64' || arch === 'x64'))
    || (platform === 'win32' && arch === 'x64')
}

export async function createTestConverterPack(options) {
  if (!isAbsolute(options.output)) throw new Error('Fixture output must be an absolute path')
  if (!packNames.has(options.name) || !semverPattern.test(options.version)) throw new Error('Invalid fixture pack identity')
  if (!approvedTarget(options.platform, options.arch)) throw new Error('Invalid fixture platform target')
  if (!/^(?:0|[1-9]\d*)$/u.test(options.sequence) || !Number.isSafeInteger(Number(options.sequence))) {
    throw new Error('Invalid fixture sequence')
  }
  const archiveUrl = testOnlyArchiveUrl(options['archive-url'])
  const executablePath = `bin/${options.name}-fixture`
  const executable = Buffer.from(`AUTOFORGE TEST FIXTURE: ${options.name}\n`, 'utf8')
  const archive = createTar(executablePath, executable)
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
  const index = {
    schemaVersion: 1,
    generatedAt: '2026-08-29T00:00:00.000Z',
    sequence: Number(options.sequence),
    packs: [{
      name: options.name,
      version: options.version,
      platform: options.platform,
      arch: options.arch,
      archiveUrl,
      archiveSha256: digest(archive),
      archiveBytes: archive.byteLength,
      entries: [{ path: executablePath, sha256: digest(executable), bytes: executable.byteLength, executable: true, role: 'executable' }],
    }],
  }
  const indexBytes = Buffer.from(canonicalJson(index), 'utf8')
  const signature = sign(null, indexBytes, TEST_ONLY_PRIVATE_KEY).toString('base64')
  const derivedPublic = createPublicKey(TEST_ONLY_PRIVATE_KEY).export({ format: 'der', type: 'spki' })
  if (!derivedPublic.equals(TEST_ONLY_PUBLIC_DER)) throw new Error('Fixture key identity mismatch')

  await mkdir(options.output, { recursive: true, mode: 0o700 })
  await Promise.all([
    writeFile(resolve(options.output, 'pack.tar'), archive, { flag: 'wx', mode: 0o600 }),
    writeFile(resolve(options.output, 'index.json'), indexBytes, { flag: 'wx', mode: 0o600 }),
    writeFile(resolve(options.output, 'index.sig'), `${signature}\n`, { flag: 'wx', mode: 0o600 }),
  ])
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  await createTestConverterPack(argumentsFrom(process.argv.slice(2)))
}
