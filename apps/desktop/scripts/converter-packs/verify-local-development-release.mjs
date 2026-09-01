import { spawn } from 'node:child_process'
import { inflateSync } from 'node:zlib'
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
const icnsSlots = Object.freeze([
  Object.freeze({ type: 'icp4', pixelSize: 16 }),
  Object.freeze({ type: 'ic11', pixelSize: 32 }),
  Object.freeze({ type: 'icp5', pixelSize: 32 }),
  Object.freeze({ type: 'ic12', pixelSize: 64 }),
  Object.freeze({ type: 'ic07', pixelSize: 128 }),
  Object.freeze({ type: 'ic13', pixelSize: 256 }),
  Object.freeze({ type: 'ic08', pixelSize: 256 }),
  Object.freeze({ type: 'ic14', pixelSize: 512 }),
  Object.freeze({ type: 'ic09', pixelSize: 512 }),
  Object.freeze({ type: 'ic10', pixelSize: 1024 }),
])
const pngFixture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLJYQAAAABJRU5ErkJggg==', 'base64')
const sourceFixtureFiles = new Set(['sources/source.txt', 'sources/source.csv', 'sources/source.png'])
const expectedRegularFiles = new Set([
  ...sourceFixtureFiles,
  'sources/source.wav', 'sources/source.mp4',
  'source-doc/source.doc', 'source-docx/source.docx', 'document/source.pdf', 'documentx/source.pdf',
  'spreadsheet/source.xlsx', 'xlsx-roundtrip/source.csv', 'jpeg/output.jpeg', 'image-pdf/output.pdf',
  'ico/output.ico', 'icns/output.icns', 'pdf-png/page-001.png', 'pdf-jpeg/page-001.jpeg',
  'pdf-probe/generated.png', 'pdf-probe/generated.jpeg', 'audio/output.mp3', 'video/output.webm', 'extract/output.mp3',
])
const allowedDirectories = new Set([
  'sources', 'source-doc', 'source-docx', 'document', 'documentx', 'spreadsheet', 'xlsx-roundtrip',
  'jpeg', 'image-pdf', 'ico', 'icns', 'pdf-png', 'pdf-jpeg', 'pdf-probe', 'audio', 'video', 'extract',
])

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

async function containedPath(root, candidate, { directory = false } = {}) {
  if (typeof candidate !== 'string' || !isAbsolute(candidate) || resolve(candidate) !== candidate || !inside(root, candidate)) fail()
  const segments = relative(root, candidate).split('/').filter(Boolean)
  let current = root
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment)
    const metadata = await lstat(current).catch(() => undefined)
    if (!metadata) {
      if (directory) fail()
      return candidate
    }
    if (metadata.isSymbolicLink() || (index < segments.length - 1 && !metadata.isDirectory())) fail()
    if (index === segments.length - 1 && directory && !metadata.isDirectory()) fail()
    if (await realpath(current).catch(() => undefined) !== current) fail()
  }
  return candidate
}

function argumentPaths(args) {
  const paths = []
  for (const argument of args) {
    if (isAbsolute(argument)) paths.push(argument)
    else if (argument.startsWith('-env:UserInstallation=')) {
      try { paths.push(fileURLToPath(argument.slice('-env:UserInstallation='.length))) } catch { fail() }
    }
  }
  return paths
}

async function validateRunRequest({ executable, args, cwd, env }, { releaseRoot, workRoot }) {
  if (!inside(releaseRoot, executable)) fail()
  await regularFile(executable)
  await containedPath(workRoot, cwd, { directory: true })
  for (const path of argumentPaths(args)) await containedPath(workRoot, path)
  if (env?.TEMP !== workRoot || env?.TMP !== workRoot || env?.TMPDIR !== workRoot || env?.PATH !== dirname(executable)) fail()
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
  let channels
  let idat = false
  let idatEnded = false
  const payloads = []
  let ended = false
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.subarray(offset + 4, offset + 8)
    const end = offset + 12 + length
    if (end > bytes.length || bytes.readUInt32BE(offset + 8 + length) !== crc32(bytes.subarray(offset + 4, offset + 8 + length))) return false
    if (type.toString('ascii') === 'IHDR') {
      if (offset !== 8 || length !== 13 || width !== undefined) return false
      width = bytes.readUInt32BE(offset + 8); height = bytes.readUInt32BE(offset + 12)
      const bitDepth = bytes[offset + 16]; const colorType = bytes[offset + 17]
      const compression = bytes[offset + 18]; const filter = bytes[offset + 19]; const interlace = bytes[offset + 20]
      channels = colorType === 2 ? 3 : colorType === 6 ? 4 : undefined
      if (!width || !height || bitDepth !== 8 || channels === undefined || compression !== 0 || filter !== 0 || interlace !== 0) return false
    } else if (type.toString('ascii') === 'IDAT') {
      if (width === undefined || idatEnded) return false
      idat ||= length > 0
      payloads.push(bytes.subarray(offset + 8, offset + 8 + length))
    }
    else if (type.toString('ascii') === 'IEND') { ended = length === 0 && end === bytes.length; break }
    else if (idat) idatEnded = true
    offset = end
  }
  if (!width || !height || !idat || !ended || (expectedSize !== undefined && (width !== expectedSize || height !== expectedSize))) return false
  try {
    const decodedBytes = height * (1 + width * channels)
    if (!Number.isSafeInteger(decodedBytes) || decodedBytes > maximumFileBytes) return false
    const decoded = inflateSync(Buffer.concat(payloads), { maxOutputLength: maximumFileBytes + 1 })
    if (decoded.length !== decodedBytes) return false
    for (let offset = 0; offset < decoded.length; offset += 1 + width * channels) if (decoded[offset] > 4) return false
    return true
  } catch { return false }
}

function validJpeg(bytes) {
  if (bytes.length < 20 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false
  let offset = 2
  let frameMarker
  let frameComponents
  const quantizationTables = new Set()
  const dcTables = new Set()
  const acTables = new Set()
  let scans = 0
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return false
    let markerOffset = offset + 1
    while (bytes[markerOffset] === 0xff) markerOffset += 1
    const marker = bytes[markerOffset]
    if (marker === undefined || marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) return false
    const segmentOffset = markerOffset + 1
    if (marker === 0xd9) {
      if (segmentOffset !== bytes.length || !frameComponents || scans < 1 || quantizationTables.size < 1 || dcTables.size < 1 || acTables.size < 1) return false
      return [...frameComponents.values()].every(({ quantizationTable }) => quantizationTables.has(quantizationTable))
    }
    if (marker === 0x01) { offset = segmentOffset; continue }
    if (segmentOffset + 2 > bytes.length) return false
    const length = bytes.readUInt16BE(segmentOffset)
    const payloadOffset = segmentOffset + 2
    const end = segmentOffset + length
    if (length < 2 || end > bytes.length) return false
    if (marker === 0xdb) {
      for (let cursor = payloadOffset; cursor < end;) {
        const information = bytes[cursor++]
        const precision = information >>> 4
        const identifier = information & 0x0f
        const tableBytes = precision === 0 ? 64 : precision === 1 ? 128 : 0
        if (!tableBytes || identifier > 3 || cursor + tableBytes > end) return false
        quantizationTables.add(identifier)
        cursor += tableBytes
      }
    } else if (marker === 0xc4) {
      for (let cursor = payloadOffset; cursor < end;) {
        const information = bytes[cursor++]
        const tableClass = information >>> 4
        const identifier = information & 0x0f
        if (tableClass > 1 || identifier > 3 || cursor + 16 > end) return false
        let symbols = 0
        let availableCodes = 1
        for (let index = 0; index < 16; index += 1) {
          const count = bytes[cursor + index]
          symbols += count
          availableCodes = availableCodes * 2 - count
          if (availableCodes < 0) return false
        }
        cursor += 16
        if (symbols < 1 || cursor + symbols > end) return false
        cursor += symbols
        ;(tableClass === 0 ? dcTables : acTables).add(identifier)
      }
    } else {
      const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
      if (isFrame) {
        if (![0xc0, 0xc1, 0xc2].includes(marker) || frameComponents) return false
        const componentCount = bytes[payloadOffset + 5]
        if (bytes[payloadOffset] !== 8 || !bytes.readUInt16BE(payloadOffset + 1) || !bytes.readUInt16BE(payloadOffset + 3)
          || componentCount < 1 || componentCount > 4 || length !== 8 + 3 * componentCount) return false
        frameMarker = marker
        frameComponents = new Map()
        for (let index = 0; index < componentCount; index += 1) {
          const componentOffset = payloadOffset + 6 + index * 3
          const identifier = bytes[componentOffset]
          const sampling = bytes[componentOffset + 1]
          const horizontal = sampling >>> 4
          const vertical = sampling & 0x0f
          const quantizationTable = bytes[componentOffset + 2]
          if (frameComponents.has(identifier) || horizontal < 1 || horizontal > 4 || vertical < 1 || vertical > 4 || quantizationTable > 3) return false
          frameComponents.set(identifier, { quantizationTable })
        }
      } else if (marker === 0xda) {
        const scanComponents = bytes[payloadOffset]
        if (!frameComponents || scanComponents < 1 || scanComponents > frameComponents.size || length !== 6 + 2 * scanComponents) return false
        const identifiers = new Set()
        for (let index = 0; index < scanComponents; index += 1) {
          const selectorOffset = payloadOffset + 1 + index * 2
          const identifier = bytes[selectorOffset]
          const tables = bytes[selectorOffset + 1]
          if (!frameComponents.has(identifier) || identifiers.has(identifier) || !dcTables.has(tables >>> 4) || !acTables.has(tables & 0x0f)) return false
          identifiers.add(identifier)
        }
        const spectralStart = bytes[payloadOffset + 1 + 2 * scanComponents]
        const spectralEnd = bytes[payloadOffset + 2 + 2 * scanComponents]
        const approximation = bytes[payloadOffset + 3 + 2 * scanComponents]
        if (frameMarker !== 0xc2) {
          if (spectralStart !== 0 || spectralEnd !== 63 || approximation !== 0) return false
        } else if (spectralStart > spectralEnd || spectralEnd > 63 || approximation >>> 4 > 13 || (approximation & 0x0f) > 13 || (spectralStart > 0 && scanComponents !== 1)) return false
        let cursor = end
        let entropyBytes = 0
        while (cursor < bytes.length) {
          if (bytes[cursor] !== 0xff) { entropyBytes += 1; cursor += 1; continue }
          let codeOffset = cursor + 1
          while (bytes[codeOffset] === 0xff) codeOffset += 1
          const code = bytes[codeOffset]
          if (code === undefined) return false
          if (code === 0x00) { entropyBytes += 1; cursor = codeOffset + 1; continue }
          if (code >= 0xd0 && code <= 0xd7) { cursor = codeOffset + 1; continue }
          if (entropyBytes < 1) return false
          offset = cursor
          scans += 1
          break
        }
        if (cursor >= bytes.length) return false
        continue
      }
    }
    offset = end
  }
  return false
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

async function auditTree(root, prefix = '', result = { files: new Set(), directories: new Set() }) {
  const names = await readdir(root)
  if (prefix && names.length === 0) fail()
  for (const name of names) {
    const path = join(root, name)
    const relativePath = prefix ? `${prefix}/${name}` : name
    const metadata = await lstat(path).catch(() => undefined)
    if (!metadata || metadata.isSymbolicLink()) fail()
    if (metadata.isDirectory()) {
      result.directories.add(relativePath)
      await auditTree(path, relativePath, result)
    } else if (metadata.isFile()) {
      await regularFile(path)
      result.files.add(relativePath)
    } else fail()
  }
  return result
}

function sameSet(actual, expected) {
  return actual.size === expected.size && [...actual].every((value) => expected.has(value))
}

function verifyIco(bytes) {
  if (bytes.length < 6 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1 || bytes.readUInt16LE(4) !== icoSizes.length) fail()
  const directoryEnd = 6 + icoSizes.length * 16
  const sizes = []
  const payloads = []
  for (let index = 0; index < icoSizes.length; index += 1) {
    const offset = 6 + index * 16
    if (offset + 16 > bytes.length) fail()
    const size = bytes[offset] || 256
    const height = bytes[offset + 1] || 256
    const payloadLength = bytes.readUInt32LE(offset + 8)
    const payloadOffset = bytes.readUInt32LE(offset + 12)
    const payloadEnd = payloadOffset + payloadLength
    if (height !== size || !payloadLength || payloadOffset < directoryEnd || payloadEnd > bytes.length || payloadEnd < payloadOffset
      || !validPng(bytes.subarray(payloadOffset, payloadEnd), size)) fail()
    sizes.push(size)
    payloads.push({ start: payloadOffset, end: payloadEnd })
  }
  if (sizes.some((size, index) => size !== icoSizes[index])) fail()
  payloads.sort((left, right) => left.start - right.start)
  if (payloads.some((payload, index) => index > 0 && payload.start < payloads[index - 1].end)) fail()
}

function verifyIcns(bytes) {
  if (bytes.length < 8 || bytes.subarray(0, 4).toString('ascii') !== 'icns' || bytes.readUInt32BE(4) !== bytes.length) fail()
  const types = []
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 8 > bytes.length) fail()
    const length = bytes.readUInt32BE(offset + 4)
    if (length < 8 || offset + length > bytes.length) fail()
    const slot = icnsSlots[types.length]
    const type = bytes.subarray(offset, offset + 4).toString('ascii')
    if (!slot || type !== slot.type || !validPng(bytes.subarray(offset + 8, offset + length), slot.pixelSize)) fail()
    types.push(type)
    offset += length
  }
  if (types.length !== icnsSlots.length) fail()
}

async function defaultRun({ executable, args, cwd, env, signal }) {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], detached: true })
    const stdout = []
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
    let aborted = false
    let spawnError
    let terminationError
    const abort = () => {
      aborted = true
      if (child.pid === undefined) return
      try {
        if (process.platform === 'win32') child.kill('SIGKILL')
        else process.kill(-child.pid, 'SIGKILL')
      } catch (error) {
        if (error?.code !== 'ESRCH') terminationError = error
      }
    }
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    child.once('error', (error) => { spawnError = error })
    child.once('close', (code, closeSignal) => {
      signal?.removeEventListener('abort', abort)
      if (spawnError) rejectRun(spawnError)
      else if (aborted) rejectRun(terminationError ?? new Error('timeout'))
      else resolveRun({ code, signal: closeSignal, stdout: Buffer.concat(stdout).toString('utf8') })
    })
  })
}

async function runCommand(run, request, timeoutMs) {
  // Injected runners have a cooperative contract: observe AbortSignal, finish
  // asynchronous cleanup, and settle. This single timer owns the deadline;
  // deliberately do not race a runner that ignores the signal forever.
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  const outcome = await Promise.resolve().then(() => run({ ...request, signal: controller.signal })).catch(() => fail()).finally(() => clearTimeout(timer))
  if (timedOut) fail()
  if (!outcome || outcome.code !== 0 || outcome.signal) fail()
  return outcome
}

export async function runDefaultCommandForTest({ timeoutMs, ...request } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) fail()
  return runCommand(defaultRun, request, timeoutMs)
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

async function readReleaseCoordinate(releaseRoot) {
  const indexPath = join(releaseRoot, 'index.json')
  const before = await regularFile(indexPath)
  const bytes = await readFile(indexPath)
  const after = await regularFile(indexPath)
  if (bytes.byteLength !== before.size || bytes.byteLength !== after.size || before.dev !== after.dev || before.ino !== after.ino
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail()
  let index
  try { index = JSON.parse(bytes.toString('utf8')) } catch { fail() }
  const families = new Set(Object.keys(executableEntries))
  if (!Array.isArray(index?.packs) || index.packs.length !== families.size) fail()
  let coordinate
  for (const descriptor of index.packs) {
    if (!descriptor || !families.delete(descriptor.name) || descriptor.platform !== 'darwin' || (descriptor.arch !== 'arm64' && descriptor.arch !== 'x64')) fail()
    const candidate = `${descriptor.platform}-${descriptor.arch}`
    if (coordinate !== undefined && coordinate !== candidate) fail()
    coordinate = candidate
  }
  if (families.size !== 0 || coordinate === undefined) fail()
  const [platform, arch] = coordinate.split('-')
  return Object.freeze({ platform, arch })
}

async function resolveExecutables(releaseRoot, target) {
  const index = JSON.parse((await readFile(join(releaseRoot, 'index.json'))).toString('utf8'))
  if (!Array.isArray(index?.packs)) fail()
  const result = Object.create(null)
  for (const [name, entry] of Object.entries(executableEntries)) {
    const descriptor = index.packs.find((candidate) => candidate?.name === name)
    if (!descriptor || descriptor.platform !== target.platform || descriptor.arch !== target.arch
      || !Array.isArray(descriptor.entries) || !descriptor.entries.some((candidate) => candidate?.path === entry && candidate.executable === true)) fail()
    const executable = join(releaseRoot, 'installed', name, descriptor.version, `${descriptor.platform}-${descriptor.arch}`, ...entry.split('/'))
    if (!inside(releaseRoot, executable)) fail()
    await regularFile(executable)
    result[name] = executable
  }
  for (const [name, { family, entry }] of Object.entries(supportingEntries)) {
    const descriptor = index.packs.find((candidate) => candidate?.name === family)
    if (descriptor?.platform !== target.platform || descriptor?.arch !== target.arch
      || !descriptor?.entries.some((candidate) => candidate?.path === entry && candidate.executable === true)) fail()
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
    const target = await readReleaseCoordinate(releaseRoot)
    await verifyLocalDevelopmentReleaseIntegrity({ releaseRoot, platform: target.platform, arch: target.arch })
    const executables = await resolveExecutables(releaseRoot, target)
    const sources = join(workRoot, 'sources')
    await mkdir(sources)
    const text = join(sources, 'source.txt')
    const csv = join(sources, 'source.csv')
    const image = join(sources, 'source.png')
    await Promise.all([writeFile(text, 'AutoForge smoke fixture\n'), writeFile(csv, 'name,value\nauto-forge,1\n'), writeFile(image, pngFixture)])
    await Promise.all([regularFile(text), regularFile(csv), regularFile(image)])
    const invoke = async (executable, args, cwd, kind) => {
      const request = { executable, args, cwd, env: commandEnvironment(executable, workRoot) }
      await validateRunRequest(request, { releaseRoot, workRoot })
      return runCommand(run, request, timeoutMs ?? timeouts[kind])
    }
    const invokeDocument = async (input, target, root) => {
      try {
        await invoke(executables.document, documentArguments(input, target, root), root, 'document')
      } finally {
        await rm(join(root, 'libreoffice-profile'), { recursive: true, force: true })
      }
    }
    const probePdf = async (path) => {
      const result = await invoke(executables.pdfinfo, ['-f', '1', '-l', '1', path], workRoot, 'pdf')
      if (!/^Pages:\s+1$/mu.test(result.stdout ?? '') || !/^PDF version:\s+\d+\.\d+$/mu.test(result.stdout ?? '')) fail()
    }
    const probeMedia = async (path, containers, streams) => {
      const result = await invoke(executables.ffprobe, ['-v', 'error', '-show_entries', 'format=format_name:stream=codec_type,codec_name', '-of', 'json', path], workRoot, 'media')
      try {
        const parsed = JSON.parse(result.stdout)
        const actualContainers = typeof parsed?.format?.format_name === 'string' ? parsed.format.format_name.split(',') : []
        if (!containers.every((container) => actualContainers.includes(container)) || !Array.isArray(parsed?.streams) || parsed.streams.length !== streams.length
          || streams.some((expected, index) => parsed.streams[index]?.codec_type !== expected.type || parsed.streams[index]?.codec_name !== expected.codec)) fail()
      } catch { fail() }
    }

    const docSourceRoot = join(workRoot, 'source-doc')
    const docxSourceRoot = join(workRoot, 'source-docx')
    await Promise.all([mkdir(docSourceRoot), mkdir(docxSourceRoot)])
    await invokeDocument(text, 'doc', docSourceRoot)
    await invokeDocument(text, 'docx', docxSourceRoot)
    const doc = join(docSourceRoot, 'source.doc')
    const docx = join(docxSourceRoot, 'source.docx')
    await Promise.all([verifyOutput(doc, 'doc'), verifyOutput(docx, 'zip')])

    const documentRoot = join(workRoot, 'document')
    const documentXRoot = join(workRoot, 'documentx')
    const spreadsheetRoot = join(workRoot, 'spreadsheet')
    await Promise.all([mkdir(documentRoot), mkdir(documentXRoot), mkdir(spreadsheetRoot)])
    await invokeDocument(doc, 'pdf', documentRoot)
    await invokeDocument(docx, 'pdf', documentXRoot)
    await invokeDocument(csv, 'xlsx', spreadsheetRoot)
    await Promise.all([
      verifyOutputDirectory(documentRoot, ['source.pdf']), verifyOutput(join(documentRoot, 'source.pdf'), 'pdf'),
      verifyOutputDirectory(documentXRoot, ['source.pdf']), verifyOutput(join(documentXRoot, 'source.pdf'), 'pdf'),
      verifyOutputDirectory(spreadsheetRoot, ['source.xlsx']), verifyOutput(join(spreadsheetRoot, 'source.xlsx'), 'zip'),
    ])
    await Promise.all([probePdf(join(documentRoot, 'source.pdf')), probePdf(join(documentXRoot, 'source.pdf'))])
    const roundtripRoot = join(workRoot, 'xlsx-roundtrip')
    await mkdir(roundtripRoot)
    const spreadsheet = join(spreadsheetRoot, 'source.xlsx')
    await invokeDocument(spreadsheet, 'csv', roundtripRoot)
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
    await Promise.all([
      probeMedia(wav, ['wav'], [{ type: 'audio', codec: 'pcm_s16le' }]),
      probeMedia(mp4, ['mov', 'mp4'], [{ type: 'video', codec: 'h264' }, { type: 'audio', codec: 'aac' }]),
    ])
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
    await Promise.all([
      probeMedia(audio, ['mp3'], [{ type: 'audio', codec: 'mp3' }]),
      probeMedia(video, ['webm'], [{ type: 'video', codec: 'vp9' }, { type: 'audio', codec: 'opus' }]),
      probeMedia(extracted, ['mp3'], [{ type: 'audio', codec: 'mp3' }]),
    ])
    const tree = await auditTree(workRoot)
    const outputCount = [...tree.files].filter((path) => !sourceFixtureFiles.has(path)).length
    if (outputCount > maximumOutputs || !sameSet(tree.files, expectedRegularFiles) || !sameSet(tree.directories, allowedDirectories)) fail()
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
