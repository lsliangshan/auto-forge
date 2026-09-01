import { Buffer } from 'node:buffer'
import { createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { createRequire } from 'node:module'
import { chmod, lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL, URL } from 'node:url'
import {
  canonicalBytes,
  createRestrictedUstar,
  sha256,
  validateIndex,
} from './pack-tooling-lib.mjs'

const desktopRoot = fileURLToPath(new URL('../..', import.meta.url))
const require = createRequire(import.meta.url)
const electronPath = require('electron')
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
  png|jpeg|tiff|bmp|gif|pdf) ;;
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

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

const documentRenderer = Buffer.from(`'use strict'
const { app, BrowserWindow } = require('electron')
const { writeFile } = require('node:fs/promises')
const { pathToFileURL } = require('node:url')

const [inputPath, outputPath, profilePath] = process.argv.slice(2)
if (!inputPath || !outputPath || !profilePath) process.exit(64)
app.setPath('userData', profilePath)
app.commandLine.appendSwitch('disable-gpu')

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  })
  const inputUrl = pathToFileURL(inputPath).href
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: details.url !== inputUrl && !details.url.startsWith('data:') })
  })
  await window.loadURL(inputUrl)
  await window.webContents.executeJavaScript('document.fonts.ready.then(() => true)', true)
  const pdf = await window.webContents.printToPDF({
    printBackground: true,
    pageSize: 'A4',
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
  })
  await writeFile(outputPath, pdf, { flag: 'wx', mode: 0o600 })
  window.destroy()
  app.quit()
}).catch((error) => {
  process.stderr.write(String(error?.message ?? error) + '\\n')
  app.exit(1)
})
`, 'utf8')

const documentConverter = Buffer.from(`#!/bin/sh
set -eu
electron_path=${shellQuote(electronPath)}
output_format=
output_dir=
input_path=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -env:UserInstallation=*|--headless|--invisible|--nologo|--nodefault|--nolockcheck|--norestore) shift ;;
    --convert-to) [ "$#" -ge 2 ] || exit 64; output_format=$2; shift 2 ;;
    --outdir) [ "$#" -ge 2 ] || exit 64; output_dir=$2; shift 2 ;;
    --) shift; [ "$#" -eq 1 ] || exit 64; input_path=$1; shift ;;
    *) exit 64 ;;
  esac
done
[ "$output_format" = "pdf" ] && [ -n "$output_dir" ] && [ -n "$input_path" ] || exit 64
input_name=\${input_path##*/}
case "$input_name" in
  *.html) input_kind=html ;;
  *.txt) input_kind=text ;;
  *) exit 65 ;;
esac
output_name=\${input_name%.*}.pdf
umask 077
if [ "$input_kind" = html ]; then
  script_dir=\${0%/*}
  "$electron_path" "$script_dir/render-html-to-pdf.cjs" "$input_path" "$output_dir/$output_name" "$output_dir/electron-profile"
else
  /usr/sbin/cupsfilter -i text/plain -m application/pdf "$input_path" > "$output_dir/$output_name"
fi
`, 'utf8')

const imageLicense = Buffer.from(
  'Development-only adapter invoking /usr/bin/sips, a component of macOS. Not for production distribution.\n',
  'utf8',
)

const documentLicense = Buffer.from(
  'Development-only adapter invoking bundled Electron or /usr/sbin/cupsfilter. Not for production distribution.\n',
  'utf8',
)

function localPacks() {
  return [
    {
      name: 'image-icon',
      entries: [
        { path: 'bin/autoforge-image-converter', bytes: converter, executable: true, role: 'executable' },
        { path: 'bin/vips', bytes: vipsProbe, executable: true, role: 'executable' },
        { path: 'LICENSES/local-development.txt', bytes: imageLicense, executable: false, role: 'license' },
      ],
    },
    {
      name: 'document',
      entries: [
        { path: 'program/soffice', bytes: documentConverter, executable: true, role: 'executable' },
        { path: 'program/render-html-to-pdf.cjs', bytes: documentRenderer, executable: false, role: 'code' },
        { path: 'LICENSES/local-development.txt', bytes: documentLicense, executable: false, role: 'license' },
      ],
    },
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
  if (await lstat(output).catch(() => undefined) !== undefined) {
    throw new Error('Local development release output already exists.')
  }
  const temporary = await realpath(await mkdtemp(join(parent, '.local-converter-release-')))
  try {
    const version = '0.0.0-dev'
    const packs = localPacks()
    const descriptors = packs.map(({ name, entries }) => {
      const archive = createRestrictedUstar(entries)
      return {
        name,
        version,
        platform,
        arch,
        archiveUrl: `https://local-development.invalid/${name}-${version}-${platform}-${arch}.tar`,
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
    })
    const index = validateIndex({
      schemaVersion: 1,
      generatedAt: '2026-08-31T00:00:00.000Z',
      sequence: 1,
      packs: descriptors,
    }, 'test')
    const indexBytes = canonicalBytes(index)
    const signature = sign(null, indexBytes, developmentPrivateKey).toString('base64')
    const publicKey = createPublicKey(developmentPrivateKey).export({ format: 'pem', type: 'spki' })
    await Promise.all(packs.flatMap(({ name, entries }) => {
      const installedRoot = join(temporary, 'installed', name, version, `${platform}-${arch}`)
      return entries.map((entry) => writeInstalledEntry(installedRoot, entry))
    }))
    await Promise.all([
      writeFile(join(temporary, 'index.json'), indexBytes, { flag: 'wx', mode: 0o600 }),
      writeFile(join(temporary, 'index.sig'), `${signature}\n`, { flag: 'wx', mode: 0o600 }),
      writeFile(join(temporary, 'root-public-key.pem'), publicKey, { flag: 'wx', mode: 0o600 }),
    ])
    await rename(temporary, output)
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
}

async function requireCanonicalDirectory(path, label) {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute.`)
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || await realpath(path) !== path) {
    throw new Error(`${label} must be a canonical directory without symbolic components.`)
  }
}

export async function replaceLocalDevelopmentImageRelease({ cacheParent, platform, arch }) {
  await mkdir(cacheParent, { recursive: true, mode: 0o700 })
  await requireCanonicalDirectory(cacheParent, 'Local development cache parent')
  const cacheRoot = join(cacheParent, 'autoforge-converter-packs')
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 })
  await requireCanonicalDirectory(cacheRoot, 'Local development converter cache root')
  const output = join(cacheRoot, 'release')
  const existing = await lstat(output).catch(() => undefined)
  if (existing?.isSymbolicLink()) throw new Error('Local development converter release cache must not be symbolic.')
  await rm(output, { recursive: true, force: true })
  await createLocalDevelopmentImageRelease({ output, platform, arch })
  return output
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  await replaceLocalDevelopmentImageRelease({
    cacheParent: join(desktopRoot, 'node_modules', '.cache'),
    platform: process.platform,
    arch: process.arch,
  })
  process.stdout.write('created signed local development image converter release\n')
}
