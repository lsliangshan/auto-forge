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
const supportingEntries = Object.freeze({
  pdfinfo: Object.freeze({ family: 'pdf', entry: 'bin/pdfinfo' }),
  pdftocairo: Object.freeze({ family: 'pdf', entry: 'bin/pdftocairo' }),
  ffprobe: Object.freeze({ family: 'media', entry: 'bin/ffprobe' }),
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
  if (validPng(bytes)) return 'png'
  if (validJpeg(bytes)) return 'jpeg'
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

function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
  }
  return (value ^ 0xffffffff) >>> 0
}

function validPng(bytes, expectedSize) {
  if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return false
  let offset = 8
  let width
  let height
  let idat = false
  let ended = false
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.subarray(offset + 4, offset + 8)
    const end = offset + 12 + length
    if (end > bytes.length || bytes.readUInt32BE(offset + 8 + length) !== crc32(bytes.subarray(offset + 4, offset + 8 + length))) return false
    if (type.toString('ascii') === 'IHDR') {
      if (length !== 13 || width !== undefined) return false
      width = bytes.readUInt32BE(offset + 8); height = bytes.readUInt32BE(offset + 12)
      if (!width || !height) return false
    } else if (type.toString('ascii') === 'IDAT') idat ||= length > 0
    else if (type.toString('ascii') === 'IEND') { ended = length === 0 && end === bytes.length; break }
    offset = end
  }
  return Boolean(width && height && idat && ended && (expectedSize === undefined || (width === expectedSize && height === expectedSize)))
}

function validJpeg(bytes) {
  if (bytes.length < 20 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return false
  let offset = 2
  let frame = false
  let scan = false
  while (offset + 4 <= bytes.length - 2) {
    if (bytes[offset] !== 0xff) return false
    const marker = bytes[offset + 1]
    if (marker === 0xda) { scan = true; break }
    const length = bytes.readUInt16BE(offset + 2)
    if (length < 2 || offset + 2 + length > bytes.length) return false
    if (marker >= 0xc0 && marker <= 0xc3 && length >= 8 && bytes.readUInt16BE(offset + 5) > 0 && bytes.readUInt16BE(offset + 7) > 0) frame = true
    offset += 2 + length
  }
  return frame && scan
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
    const size = bytes[offset] || 256
    const payloadLength = bytes.readUInt32LE(offset + 8)
    const payloadOffset = bytes.readUInt32LE(offset + 12)
    if (!payloadLength || payloadOffset + payloadLength > bytes.length || !validPng(bytes.subarray(payloadOffset, payloadOffset + payloadLength))) fail()
    sizes.push(size)
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
    const index = types.length
    types.push(bytes.subarray(offset, offset + 4).toString('ascii'))
    if (!validPng(bytes.subarray(offset + 8, offset + length))) fail()
    offset += length
  }
  if (types.length !== icnsTypes.length || types.some((type, index) => type !== icnsTypes[index])) fail()
}

async function defaultRun({ executable, args, cwd, env, signal }) {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], detached: true })
    const stdout = []
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
    let aborted = false
    const abort = () => { aborted = true; if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL') }
    signal?.addEventListener('abort', abort, { once: true })
    child.once('error', rejectRun)
    child.once('close', (code, closeSignal) => { signal?.removeEventListener('abort', abort); if (aborted) rejectRun(new Error('timeout')); else resolveRun({ code, signal: closeSignal, stdout: Buffer.concat(stdout).toString('utf8') }) })
  })
}

async function runCommand(run, request, timeoutMs) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  const outcome = await Promise.resolve(run({ ...request, signal: controller.signal })).catch(() => fail()).finally(() => clearTimeout(timer))
  if (timedOut) fail()
  if (!outcome || outcome.code !== 0 || outcome.signal) fail()
  return outcome
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
  for (const [name, { family, entry }] of Object.entries(supportingEntries)) {
    const descriptor = index.packs.find((candidate) => candidate?.name === family)
    if (!descriptor?.entries.some((candidate) => candidate?.path === entry && candidate.executable === true)) fail()
    const executable = join(releaseRoot, 'installed', family, descriptor.version, `${descriptor.platform}-${descriptor.arch}`, ...entry.split('/'))
    if (!inside(releaseRoot, executable)) fail()
    await regularFile(executable)
    result[name] = executable
  }
  return result
}

export async function smokeTestLocalDevelopmentRelease({ releaseRoot, workRoot, run = defaultRun, timeoutMs } = {}) {
  const canonicalWorkRoot = await canonicalDirectory(workRoot, 'Work root')
  try {
    await canonicalDirectory(releaseRoot, 'Release root')
    if (typeof run !== 'function' || (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1))) fail()
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
    const probePdf = async (path) => {
      const result = await invoke(executables.pdfinfo, ['-f', '1', '-l', '1', path], workRoot, 'pdf')
      if (!/^Pages:\s+1$/mu.test(result.stdout ?? '')) fail()
    }
    const probeMedia = async (path, container, stream) => {
      const result = await invoke(executables.ffprobe, ['-v', 'error', '-show_entries', 'format=format_name:stream=codec_type,codec_name', '-of', 'json', path], workRoot, 'media')
      try {
        const parsed = JSON.parse(result.stdout)
        if (typeof parsed?.format?.format_name !== 'string' || !parsed.format.format_name.split(',').includes(container) || !parsed.streams?.some((value) => value.codec_type === stream && typeof value.codec_name === 'string')) fail()
      } catch { fail() }
    }

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
    await Promise.all([probePdf(join(documentRoot, 'source.pdf')), probePdf(join(documentXRoot, 'source.pdf'))])
    const roundtripRoot = join(workRoot, 'xlsx-roundtrip')
    await mkdir(roundtripRoot)
    const spreadsheet = join(spreadsheetRoot, 'source.xlsx')
    await invoke(executables.document, documentArguments(spreadsheet, 'csv', roundtripRoot), roundtripRoot, 'document')
    const roundtrip = join(roundtripRoot, 'source.csv')
    await regularFile(roundtrip)
    if ((await readFile(roundtrip, 'utf8')).replace(/^\ufeff/u, '').trim() !== 'name,value\nauto-forge,1') fail()

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
    await probePdf(generatedPdf)

    const pdfPngRoot = join(workRoot, 'pdf-png')
    const pdfJpegRoot = join(workRoot, 'pdf-jpeg')
    await Promise.all([mkdir(pdfPngRoot), mkdir(pdfJpegRoot)])
    const pdfArguments = (format, root) => ['raster', '--format', format, '--pages', 'all', '--page-number-width', '3', '--output-pattern', join(root, `page-%03d.${format}`), '--', generatedPdf]
    await invoke(executables.pdf, pdfArguments('png', pdfPngRoot), pdfPngRoot, 'pdf')
    await invoke(executables.pdf, pdfArguments('jpeg', pdfJpegRoot), pdfJpegRoot, 'pdf')
    await Promise.all([verifyOutputDirectory(pdfPngRoot, ['page-001.png']), verifyOutput(join(pdfPngRoot, 'page-001.png'), 'png'), verifyOutputDirectory(pdfJpegRoot, ['page-001.jpeg']), verifyOutput(join(pdfJpegRoot, 'page-001.jpeg'), 'jpeg')])
    const probeRoot = join(workRoot, 'pdf-probe')
    await mkdir(probeRoot)
    const probePng = join(probeRoot, 'generated.png')
    const probeJpeg = join(probeRoot, 'generated.jpeg')
    await invoke(executables.pdftocairo, ['-png', '-singlefile', generatedPdf, join(probeRoot, 'generated')], probeRoot, 'pdf')
    await invoke(executables.pdftocairo, ['-jpeg', '-singlefile', generatedPdf, join(probeRoot, 'generated')], probeRoot, 'pdf')
    await Promise.all([verifyOutput(probePng, 'png'), verifyOutput(probeJpeg, 'jpeg')])

    const wav = join(sources, 'source.wav')
    const mp4 = join(sources, 'source.mp4')
    await invoke(executables.media, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-nostats', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'pcm_s16le', '-f', 'wav', '-y', wav], sources, 'media')
    await invoke(executables.media, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-nostats', '-f', 'lavfi', '-i', 'color=c=black:s=16x16:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'mp4', '-y', mp4], sources, 'media')
    await Promise.all([verifyOutput(wav, 'wav'), verifyOutput(mp4, 'mp4')])
    await Promise.all([probeMedia(wav, 'wav', 'audio'), probeMedia(mp4, 'mov', 'video')])
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
    await Promise.all([probeMedia(audio, 'mp3', 'audio'), probeMedia(video, 'webm', 'video'), probeMedia(extracted, 'mp3', 'audio')])
    const roots = ['sources', 'source-doc', 'source-docx', 'document', 'documentx', 'spreadsheet', 'xlsx-roundtrip', 'jpeg', 'image-pdf', 'ico', 'icns', 'pdf-png', 'pdf-jpeg', 'pdf-probe', 'audio', 'video', 'extract']
    const entries = await readdir(workRoot, { withFileTypes: true })
    if (entries.length !== roots.length || entries.some((entry) => !entry.isDirectory() || entry.isSymbolicLink() || !roots.includes(entry.name))) fail()
  } catch {
    fail()
  } finally {
    await rm(canonicalWorkRoot, { recursive: true, force: true })
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
