import { Buffer } from 'node:buffer'
import { createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { chmod, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL, URL } from 'node:url'
import {
  canonicalBytes,
  createRestrictedUstar,
  sha256,
  validateIndex,
} from './pack-tooling-lib.mjs'

const desktopRoot = fileURLToPath(new URL('../..', import.meta.url))
const privatePkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex')
const developmentSeed = Buffer.from(
  '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
  'hex',
)
const developmentPrivateKey = createPrivateKey({
  key: Buffer.concat([privatePkcs8Prefix, developmentSeed]),
  format: 'der',
  type: 'pkcs8',
})

const converter = Buffer.from(`#!/bin/sh
set -eu
[ "\${1-}" = "convert" ] || exit 64
shift
output_format=
output_path=
input_path=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --input-format|--frame) [ "$#" -ge 2 ] || exit 64; shift 2 ;;
    --output-format) [ "$#" -ge 2 ] || exit 64; output_format=$2; shift 2 ;;
    --output) [ "$#" -ge 2 ] || exit 64; output_path=$2; shift 2 ;;
    --) shift; [ "$#" -eq 1 ] || exit 64; input_path=$1; shift ;;
    *) exit 64 ;;
  esac
done
[ -n "$output_format" ] && [ -n "$output_path" ] && [ -n "$input_path" ] || exit 64
case "$output_format" in
  png|jpeg|tiff|bmp|gif) ;;
  *) exit 65 ;;
esac
/usr/bin/sips -s format "$output_format" "$input_path" --out "$output_path" >/dev/null
`, 'utf8')

const vipsProbe = Buffer.from(`#!/bin/sh
if [ "\${1-}" = "--version" ]; then
  echo "vips-local-development-sips"
  exit 0
fi
exit 64
`, 'utf8')

const license = Buffer.from(
  'Development-only adapter invoking /usr/bin/sips, a component of macOS. Not for production distribution.\n',
  'utf8',
)

function localEntries() {
  return [
    { path: 'bin/autoforge-image-converter', bytes: converter, executable: true, role: 'executable' },
    { path: 'bin/vips', bytes: vipsProbe, executable: true, role: 'executable' },
    { path: 'LICENSES/local-development.txt', bytes: license, executable: false, role: 'license' },
  ]
}

async function writeInstalledEntry(root, entry) {
  const path = join(root, ...entry.path.split('/'))
  await mkdir(dirname(path), { recursive: true, mode: 0o755 })
  await writeFile(path, entry.bytes, { flag: 'wx', mode: entry.executable ? 0o755 : 0o644 })
  await chmod(path, entry.executable ? 0o755 : 0o644)
}

export async function createLocalDevelopmentImageRelease({ output, platform, arch }) {
  if (platform !== 'darwin' || (arch !== 'arm64' && arch !== 'x64')) {
    throw new Error('Local development image conversion supports darwin-arm64 and darwin-x64 only.')
  }
  if (typeof output !== 'string' || !output.startsWith('/')) throw new Error('Local development release output must be absolute.')
  const parent = await realpath(dirname(output))
  const temporary = join(parent, `.local-converter-release-${process.pid}`)
  await rm(temporary, { recursive: true, force: true })
  await mkdir(temporary, { mode: 0o700 })
  try {
    const entries = localEntries()
    const archive = createRestrictedUstar(entries)
    const version = '0.0.0-dev'
    const descriptor = {
      name: 'image-icon',
      version,
      platform,
      arch,
      archiveUrl: `https://local-development.invalid/image-icon-${version}-${platform}-${arch}.tar`,
      archiveSha256: sha256(archive),
      archiveBytes: archive.byteLength,
      entries: entries.map((entry) => ({
        path: entry.path,
        sha256: sha256(entry.bytes),
        bytes: entry.bytes.byteLength,
        executable: entry.executable,
        role: entry.role,
      })),
    }
    const index = validateIndex({
      schemaVersion: 1,
      generatedAt: '2026-08-31T00:00:00.000Z',
      sequence: 1,
      packs: [descriptor],
    }, 'test')
    const indexBytes = canonicalBytes(index)
    const signature = sign(null, indexBytes, developmentPrivateKey).toString('base64')
    const publicKey = createPublicKey(developmentPrivateKey).export({ format: 'pem', type: 'spki' })
    const installedRoot = join(temporary, 'installed', 'image-icon', version, `${platform}-${arch}`)
    await Promise.all(entries.map((entry) => writeInstalledEntry(installedRoot, entry)))
    await Promise.all([
      writeFile(join(temporary, 'index.json'), indexBytes, { flag: 'wx', mode: 0o600 }),
      writeFile(join(temporary, 'index.sig'), `${signature}\n`, { flag: 'wx', mode: 0o600 }),
      writeFile(join(temporary, 'root-public-key.pem'), publicKey, { flag: 'wx', mode: 0o600 }),
    ])
    await rm(output, { recursive: true, force: true })
    await rename(temporary, output)
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  await mkdir(join(desktopRoot, 'node_modules', '.cache', 'autoforge-converter-packs'), { recursive: true, mode: 0o700 })
  await createLocalDevelopmentImageRelease({
    output: join(desktopRoot, 'node_modules', '.cache', 'autoforge-converter-packs', 'release'),
    platform: process.platform,
    arch: process.arch,
  })
  process.stdout.write('created signed local development image converter release\n')
}
