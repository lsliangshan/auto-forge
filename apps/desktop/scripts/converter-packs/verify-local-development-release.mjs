import { spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { verifyLocalDevelopmentReleaseIntegrity } from './build-local-development-release.mjs'
import { readActiveDevelopmentRelease } from './local-development-release-cache.mjs'

const MiB = 1024 * 1024
const maximumFileBytes = 64 * MiB
const maximumOutputs = 32
const timeouts = Object.freeze({ document: 5 * 60 * 1_000, image: 2 * 60 * 1_000, pdf: 5 * 60 * 1_000, media: 10 * 60 * 1_000 })
const executableEntries = Object.freeze({
  'image-icon': 'bin/autoforge-image-converter',
  document: 'program/soffice',
  pdf: 'bin/autoforge-pdf-raster',
  media: 'bin/ffmpeg',
})
const icoSizes = Object.freeze([16, 24, 32, 48, 64, 128, 256])
const icnsTypes = Object.freeze(['icp4', 'ic11', 'icp5', 'ic12', 'ic07', 'ic13', 'ic08', 'ic14', 'ic09', 'ic10'])
const pngFixture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLJYQAAAABJRU5ErkJggg==', 'base64')

function fail() {
  throw new Error('Local development converter release smoke verification failed')
}

function inside(root, candidate) {
  const path = relative(root, candidate)
  return path !== '..' && !path.startsWith('../') && !isAbsolute(path)
}

async function canonicalDirectory(path, label) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) fail()
  const metadata = await lstat(path).catch(() => undefined)
  if (!metadata?.isDirectory() || metadata.isSymbolicLink() || await realpath(path).catch(() => undefined) !== path) fail()
  return path
}

async function regularFile(path) {
  const metadata = await lstat(path).catch(() => undefined)
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size < 1 || metadata.size > maximumFileBytes) fail()
  if (await realpath(path).catch(() => undefined) !== path) fail()
  return metadata
}

function formatOf(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) return 'jpeg'
  if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') return 'pdf'
  if (bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) return 'doc'
  if (bytes.subarray(0, 4).equals(Buffer.from('504b0304', 'hex'))) return 'zip'
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WAVE') return 'wav'
  if (bytes.subarray(0, 3).toString('ascii') === 'ID3') return 'mp3'
  if (bytes.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex'))) return 'webm'
  if (bytes.subarray(4, 8).toString('ascii') === 'ftyp') return 'mp4'
  if (bytes.subarray(0, 4).toString('ascii') === 'icns') return 'icns'
  if (bytes.length >= 6 && bytes.readUInt16LE(0) === 0 && bytes.readUInt16LE(2) === 1) return 'ico'
  return undefined
}

async function verifyOutput(path, expectedFormat) {
  await regularFile(path)
  const bytes = await readFile(path)
  if (bytes.byteLength > maximumFileBytes || formatOf(bytes) !== expectedFormat) fail()
  return bytes
}

async function verifyOutputDirectory(root, expectedNames, allowedDirectories = []) {
  if (expectedNames.length === 0 || expectedNames.length > maximumOutputs) fail()
  const names = new Set(expectedNames)
  const allowed = new Set(allowedDirectories)
  const entries = await readdir(root, { withFileTypes: true })
  if (entries.length < names.size || entries.length > names.size + allowed.size) fail()
  for (const entry of entries) {
    if (entry.isSymbolicLink() || (entry.isFile() ? !names.has(entry.name) : !entry.isDirectory() || !allowed.has(entry.name))) fail()
  }
  for (const name of names) await regularFile(join(root, name))
}

function verifyIco(bytes) {
  if (bytes.length < 6 || bytes.readUInt16LE(4) !== icoSizes.length) fail()
  const sizes = []
  for (let index = 0; index < icoSizes.length; index += 1) {
    const offset = 6 + index * 16
    if (offset + 16 > bytes.length) fail()
    sizes.push(bytes[offset] || 256)
  }
  if (sizes.some((size, index) => size !== icoSizes[index])) fail()
}

function verifyIcns(bytes) {
  if (bytes.length < 8 || bytes.readUInt32BE(4) !== bytes.length) fail()
  const types = []
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 8 > bytes.length) fail()
    const length = bytes.readUInt32BE(offset + 4)
    if (length < 8 || offset + length > bytes.length) fail()
    types.push(bytes.subarray(offset, offset + 4).toString('ascii'))
    offset += length
  }
  if (types.length !== icnsTypes.length || types.some((type, index) => type !== icnsTypes[index])) fail()
}

async function defaultRun({ executable, args, cwd, env, timeoutMs }) {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: 'ignore' })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectRun(new Error('timeout'))
    }, timeoutMs)
    child.once('error', (error) => { clearTimeout(timer); rejectRun(error) })
    child.once('exit', (code, signal) => { clearTimeout(timer); resolveRun({ code, signal }) })
  })
}

async function runCommand(run, request, timeoutMs) {
  let timer
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs) })
  const outcome = await Promise.race([Promise.resolve(run({ ...request, timeoutMs })), timeout]).catch(() => fail()).finally(() => clearTimeout(timer))
  if (!outcome || outcome.code !== 0 || outcome.signal) fail()
}

function commandEnvironment(executable, workRoot) {
  return Object.freeze({ LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: dirname(executable), TEMP: workRoot, TMP: workRoot, TMPDIR: workRoot })
}

function documentArguments(input, target, outputRoot) {
  return [
    `-env:UserInstallation=${pathToFileURL(join(outputRoot, 'libreoffice-profile')).href}`,
    '--headless', '--invisible', '--nologo', '--nodefault', '--nolockcheck', '--norestore',
    '--convert-to', target, '--outdir', outputRoot, '--', input,
  ]
}

async function resolveExecutables(releaseRoot) {
  const index = JSON.parse((await readFile(join(releaseRoot, 'index.json'))).toString('utf8'))
  if (!Array.isArray(index?.packs)) fail()
  const result = Object.create(null)
  for (const [name, entry] of Object.entries(executableEntries)) {
    const descriptor = index.packs.find((candidate) => candidate?.name === name)
    if (!descriptor || descriptor.platform !== 'darwin' || (descriptor.arch !== 'arm64' && descriptor.arch !== 'x64')
      || !Array.isArray(descriptor.entries) || !descriptor.entries.some((candidate) => candidate?.path === entry && candidate.executable === true)) fail()
    const executable = join(releaseRoot, 'installed', name, descriptor.version, `${descriptor.platform}-${descriptor.arch}`, ...entry.split('/'))
    if (!inside(releaseRoot, executable)) fail()
    await regularFile(executable)
    result[name] = executable
  }
  return result
}

export async function smokeTestLocalDevelopmentRelease({ releaseRoot, workRoot, run = defaultRun, timeoutMs } = {}) {
  await canonicalDirectory(releaseRoot, 'Release root')
  await canonicalDirectory(workRoot, 'Work root')
  if (typeof run !== 'function' || (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1))) fail()
  try {
    if ((await readdir(workRoot)).length !== 0) fail()
    await verifyLocalDevelopmentReleaseIntegrity({ releaseRoot, platform: 'darwin', arch: process.arch === 'x64' ? 'x64' : 'arm64' })
    const executables = await resolveExecutables(releaseRoot)
    const sources = join(workRoot, 'sources')
    await mkdir(sources)
    const text = join(sources, 'source.txt')
    const csv = join(sources, 'source.csv')
    const image = join(sources, 'source.png')
    await Promise.all([writeFile(text, 'AutoForge smoke fixture\n'), writeFile(csv, 'name,value\nauto-forge,1\n'), writeFile(image, pngFixture)])
    await Promise.all([regularFile(text), regularFile(csv), regularFile(image)])
    const invoke = (executable, args, cwd, kind) => runCommand(run, { executable, args, cwd, env: commandEnvironment(executable, workRoot) }, timeoutMs ?? timeouts[kind])

    const docSourceRoot = join(workRoot, 'source-doc')
    const docxSourceRoot = join(workRoot, 'source-docx')
    await Promise.all([mkdir(docSourceRoot), mkdir(docxSourceRoot)])
    await invoke(executables.document, documentArguments(text, 'doc', docSourceRoot), docSourceRoot, 'document')
    await invoke(executables.document, documentArguments(text, 'docx', docxSourceRoot), docxSourceRoot, 'document')
    const doc = join(docSourceRoot, 'source.doc')
    const docx = join(docxSourceRoot, 'source.docx')
    await Promise.all([verifyOutput(doc, 'doc'), verifyOutput(docx, 'zip')])

    const documentRoot = join(workRoot, 'document')
    const documentXRoot = join(workRoot, 'documentx')
    const spreadsheetRoot = join(workRoot, 'spreadsheet')
    await Promise.all([mkdir(documentRoot), mkdir(documentXRoot), mkdir(spreadsheetRoot)])
    await invoke(executables.document, documentArguments(doc, 'pdf', documentRoot), documentRoot, 'document')
    await invoke(executables.document, documentArguments(docx, 'pdf', documentXRoot), documentXRoot, 'document')
    await invoke(executables.document, documentArguments(csv, 'xlsx', spreadsheetRoot), spreadsheetRoot, 'document')
    await Promise.all([
      verifyOutputDirectory(documentRoot, ['source.pdf'], ['libreoffice-profile']), verifyOutput(join(documentRoot, 'source.pdf'), 'pdf'),
      verifyOutputDirectory(documentXRoot, ['source.pdf'], ['libreoffice-profile']), verifyOutput(join(documentXRoot, 'source.pdf'), 'pdf'),
      verifyOutputDirectory(spreadsheetRoot, ['source.xlsx'], ['libreoffice-profile']), verifyOutput(join(spreadsheetRoot, 'source.xlsx'), 'zip'),
    ])

    const jpegRoot = join(workRoot, 'jpeg')
    const imagePdfRoot = join(workRoot, 'image-pdf')
    const icoRoot = join(workRoot, 'ico')
    const icnsRoot = join(workRoot, 'icns')
    await Promise.all([mkdir(jpegRoot), mkdir(imagePdfRoot), mkdir(icoRoot), mkdir(icnsRoot)])
    const imageArguments = (target, output) => ['convert', '--input-format', 'png', '--output-format', target, '--output', output, '--', image]
    const jpeg = join(jpegRoot, 'output.jpeg')
    const generatedPdf = join(imagePdfRoot, 'output.pdf')
    const ico = join(icoRoot, 'output.ico')
    const icns = join(icnsRoot, 'output.icns')
    await invoke(executables['image-icon'], imageArguments('jpeg', jpeg), jpegRoot, 'image')
    await invoke(executables['image-icon'], imageArguments('pdf', generatedPdf), imagePdfRoot, 'image')
    await invoke(executables['image-icon'], ['create-icon', '--format', 'ico', '--sizes', icoSizes.join(','), '--fit', 'contain', '--canvas', 'square', '--background', 'transparent', '--crop', 'never', '--output', ico, '--', image], icoRoot, 'image')
    await invoke(executables['image-icon'], ['create-icon', '--format', 'icns', '--representations', 'icp4=16@1x,ic11=16@2x,icp5=32@1x,ic12=32@2x,ic07=128@1x,ic13=128@2x,ic08=256@1x,ic14=256@2x,ic09=512@1x,ic10=512@2x', '--fit', 'contain', '--canvas', 'square', '--background', 'transparent', '--crop', 'never', '--output', icns, '--', image], icnsRoot, 'image')
    const [icoBytes, icnsBytes] = await Promise.all([verifyOutput(ico, 'ico'), verifyOutput(icns, 'icns')])
    await Promise.all([verifyOutputDirectory(jpegRoot, ['output.jpeg']), verifyOutput(jpeg, 'jpeg'), verifyOutputDirectory(imagePdfRoot, ['output.pdf']), verifyOutput(generatedPdf, 'pdf'), verifyOutputDirectory(icoRoot, ['output.ico']), verifyOutputDirectory(icnsRoot, ['output.icns'])])
    verifyIco(icoBytes)
    verifyIcns(icnsBytes)

    const pdfPngRoot = join(workRoot, 'pdf-png')
    const pdfJpegRoot = join(workRoot, 'pdf-jpeg')
    await Promise.all([mkdir(pdfPngRoot), mkdir(pdfJpegRoot)])
    const pdfArguments = (format, root) => ['raster', '--format', format, '--pages', 'all', '--page-number-width', '3', '--output-pattern', join(root, `page-%03d.${format}`), '--', generatedPdf]
    await invoke(executables.pdf, pdfArguments('png', pdfPngRoot), pdfPngRoot, 'pdf')
    await invoke(executables.pdf, pdfArguments('jpeg', pdfJpegRoot), pdfJpegRoot, 'pdf')
    await Promise.all([verifyOutputDirectory(pdfPngRoot, ['page-001.png']), verifyOutput(join(pdfPngRoot, 'page-001.png'), 'png'), verifyOutputDirectory(pdfJpegRoot, ['page-001.jpeg']), verifyOutput(join(pdfJpegRoot, 'page-001.jpeg'), 'jpeg')])

    const wav = join(sources, 'source.wav')
    const mp4 = join(sources, 'source.mp4')
    await invoke(executables.media, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-nostats', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'pcm_s16le', '-f', 'wav', '-y', wav], sources, 'media')
    await invoke(executables.media, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-nostats', '-f', 'lavfi', '-i', 'color=c=black:s=16x16:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'mp4', '-y', mp4], sources, 'media')
    await Promise.all([verifyOutput(wav, 'wav'), verifyOutput(mp4, 'mp4')])
    const audioRoot = join(workRoot, 'audio')
    const videoRoot = join(workRoot, 'video')
    const extractRoot = join(workRoot, 'extract')
    await Promise.all([mkdir(audioRoot), mkdir(videoRoot), mkdir(extractRoot)])
    const audio = join(audioRoot, 'output.mp3')
    const video = join(videoRoot, 'output.webm')
    const extracted = join(extractRoot, 'output.mp3')
    const mediaArguments = (input, output, target) => ['-nostdin', '-hide_banner', '-loglevel', 'error', '-nostats', '-protocol_whitelist', 'file', '-i', input, '-map_metadata', '-1', '-map_chapters', '-1', ...(target === 'webm' ? ['-map', '0:v:0?', '-map', '0:a:0?', '-c:v', 'libvpx-vp9', '-c:a', 'libopus', '-f', 'webm'] : ['-vn', '-map', '0:a:0', '-c:a', 'libmp3lame', '-f', 'mp3']), '-y', output]
    await invoke(executables.media, mediaArguments(wav, audio, 'mp3'), audioRoot, 'media')
    await invoke(executables.media, mediaArguments(mp4, video, 'webm'), videoRoot, 'media')
    await invoke(executables.media, mediaArguments(mp4, extracted, 'mp3'), extractRoot, 'media')
    await Promise.all([verifyOutputDirectory(audioRoot, ['output.mp3']), verifyOutput(audio, 'mp3'), verifyOutputDirectory(videoRoot, ['output.webm']), verifyOutput(video, 'webm'), verifyOutputDirectory(extractRoot, ['output.mp3']), verifyOutput(extracted, 'mp3')])
    const roots = ['sources', 'source-doc', 'source-docx', 'document', 'documentx', 'spreadsheet', 'jpeg', 'image-pdf', 'ico', 'icns', 'pdf-png', 'pdf-jpeg', 'audio', 'video', 'extract']
    const entries = await readdir(workRoot, { withFileTypes: true })
    if (entries.length !== roots.length || entries.some((entry) => !entry.isDirectory() || entry.isSymbolicLink() || !roots.includes(entry.name))) fail()
  } catch {
    fail()
  } finally {
    await rm(workRoot, { recursive: true, force: true })
  }
}

export async function runLocalDevelopmentReleaseVerification({
  desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  verify = smokeTestLocalDevelopmentRelease,
  write = (line) => process.stdout.write(line),
} = {}) {
  const cacheRoot = join(desktopRoot, 'node_modules', '.cache', 'autoforge-converter-packs')
  await canonicalDirectory(cacheRoot, 'Development cache root')
  const releaseRoot = await readActiveDevelopmentRelease({ cacheRoot })
  const workRoot = await realpath(await mkdtemp(join(cacheRoot, '.local-development-verification-')))
  await verify({ releaseRoot, workRoot })
  write('converter development release verified\n')
}

export async function runLocalDevelopmentReleaseVerificationCli({ writeError = (line) => process.stderr.write(line), ...options } = {}) {
  try {
    await runLocalDevelopmentReleaseVerification(options)
    return 0
  } catch {
    writeError('converter development release verification failed\n')
    return 1
  }
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  process.exitCode = await runLocalDevelopmentReleaseVerificationCli()
}
