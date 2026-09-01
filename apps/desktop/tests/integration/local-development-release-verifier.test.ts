import { generateKeyPairSync } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, open, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { buildLocalDevelopmentRelease } from '../../scripts/converter-packs/build-local-development-release.mjs'
import { smokeTestLocalDevelopmentRelease } from '../../scripts/converter-packs/verify-local-development-release.mjs'

const roots: string[] = []
const executablePaths = {
  'image-icon': ['bin/autoforge-image-converter', 'bin/vips'],
  document: ['program/soffice'],
  pdf: ['bin/autoforge-pdf-raster', 'bin/pdfinfo', 'bin/pdftocairo'],
  media: ['bin/ffmpeg', 'bin/ffprobe'],
} as const

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'autoforge-development-verifier-')))
  roots.push(root)
  return root
}

async function releaseFixture(root: string) {
  const stagingRoot = join(root, 'staging')
  await mkdir(join(stagingRoot, 'packs'), { recursive: true })
  writeFileSync(join(stagingRoot, 'release.json'), '{"schemaVersion":1,"generatedAt":"2026-09-01T00:00:00.000Z","sequence":1}')
  for (const [family, paths] of Object.entries(executablePaths)) {
    const pack = join(stagingRoot, 'packs', `${family}-darwin-arm64`)
    const payload = join(pack, 'payload')
    for (const path of paths) {
      const executable = join(payload, ...path.split('/'))
      await mkdir(join(executable, '..'), { recursive: true })
      writeFileSync(executable, '#!/bin/sh\nexit 0\n')
      chmodSync(executable, 0o755)
    }
    await mkdir(join(payload, 'LICENSES'), { recursive: true })
    writeFileSync(join(payload, 'LICENSES', `${family}.txt`), `${family} license\n`)
    writeFileSync(join(pack, 'pack.json'), JSON.stringify({
      schemaVersion: 1, name: family, version: '1.0.0', platform: 'darwin', arch: 'arm64',
      archiveUrl: `https://packs.example.test/${family}.tar`,
      files: [...paths.map((path) => ({ path, role: 'executable' })), { path: `LICENSES/${family}.txt`, role: 'license' }],
    }))
  }
  const pair = generateKeyPairSync('ed25519')
  const privateKeyPath = join(root, 'private.pem')
  const publicKeyPath = join(root, 'public.pem')
  writeFileSync(privateKeyPath, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }))
  writeFileSync(publicKeyPath, pair.publicKey.export({ format: 'pem', type: 'spki' }))
  chmodSync(privateKeyPath, 0o600)
  const releaseRoot = join(root, 'release')
  await buildLocalDevelopmentRelease({ stagingRoot, outputRoot: releaseRoot, privateKeyPath, publicKeyPath, platform: 'darwin', arch: 'arm64' })
  return releaseRoot
}

function crc32(bytes: Buffer) { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1 } return (value ^ 0xffffffff) >>> 0 }
function pngChunk(type: string, bytes: Buffer) {
  const value = Buffer.alloc(12 + bytes.length)
  value.writeUInt32BE(bytes.length)
  value.write(type, 4)
  bytes.copy(value, 8)
  value.writeUInt32BE(crc32(value.subarray(4, 8 + bytes.length)), 8 + bytes.length)
  return value
}

function png(size = 1, {
  bitDepth = 8,
  colorType = 6,
  compression = 0,
  filter = 0,
  interlace = 0,
  corruptDeflate = false,
}: {
  bitDepth?: number
  colorType?: 2 | 6
  compression?: number
  filter?: number
  interlace?: number
  corruptDeflate?: boolean
} = {}) {
  const channels = colorType === 2 ? 3 : 4
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size)
  header.writeUInt32BE(size, 4)
  header[8] = bitDepth
  header[9] = colorType
  header[10] = compression
  header[11] = filter
  header[12] = interlace
  const scanlines = Buffer.alloc(size * (1 + size * channels))
  for (let row = 0; row < size; row += 1) scanlines[row * (1 + size * channels)] = row % 5
  const compressed = Buffer.from(deflateSync(scanlines))
  if (corruptDeflate) compressed[compressed.length - 1] ^= 0xff
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

const decodableJpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYyLjAuMTAxAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAEwAAQEAAAAAAAAAAAAAAAAAAAAGAQEBAAAAAAAAAAAAAAAAAAAGBxABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAEAAQMBIgACEQADEQD/2gAMAwEAAhEDEQA/AIsATX9//9k=',
  'base64',
)
const markerOnlyJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 3, 0, 0xff, 0xc4, 0, 3, 0, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 1, 0xff, 0xd9])

function ico(sizes = [16, 24, 32, 48, 64, 128, 256]) {
  const payloads = sizes.map((size) => png(size))
  const bytes = Buffer.alloc(6 + sizes.length * 16 + payloads.reduce((total, payload) => total + payload.length, 0))
  bytes.writeUInt16LE(1, 2)
  bytes.writeUInt16LE(sizes.length, 4)
  for (const [index, size] of sizes.entries()) {
    const entry = 6 + index * 16
    bytes[entry] = size === 256 ? 0 : size
    bytes[entry + 1] = size === 256 ? 0 : size
    const offset = index === 0 ? 6 + sizes.length * 16 : bytes.readUInt32LE(entry - 4) + bytes.readUInt32LE(entry - 8)
    bytes.writeUInt32LE(payloads[index]!.length, entry + 8)
    bytes.writeUInt32LE(offset, entry + 12)
    payloads[index]!.copy(bytes, offset)
  }
  return bytes
}

function icoWithOverlappingPayloads() {
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const embedded = png(24)
  const header = Buffer.alloc(13)
  header.writeUInt32BE(16)
  header.writeUInt32BE(16, 4)
  header[8] = 8
  header[9] = 6
  const scanlines = Buffer.alloc(16 * (1 + 16 * 4))
  const headerChunk = pngChunk('IHDR', header)
  const dataChunk = pngChunk('IDAT', deflateSync(scanlines))
  const holderChunk = pngChunk('ruSt', embedded)
  const outer = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), headerChunk, dataChunk, holderChunk, pngChunk('IEND', Buffer.alloc(0))])
  const embeddedOffset = 8 + headerChunk.length + dataChunk.length + 8
  const payloads = [outer, ...sizes.slice(2).map((size) => png(size))]
  const directoryEnd = 6 + sizes.length * 16
  const bytes = Buffer.alloc(directoryEnd + payloads.reduce((total, payload) => total + payload.length, 0))
  bytes.writeUInt16LE(1, 2)
  bytes.writeUInt16LE(sizes.length, 4)
  let nextPayloadOffset = directoryEnd
  for (const [index, size] of sizes.entries()) {
    const entry = 6 + index * 16
    bytes[entry] = size === 256 ? 0 : size
    bytes[entry + 1] = size === 256 ? 0 : size
    const payload = index === 0 ? outer : index === 1 ? embedded : payloads[index - 1]!
    const payloadOffset = index === 0 ? directoryEnd : index === 1 ? directoryEnd + embeddedOffset : nextPayloadOffset
    bytes.writeUInt32LE(payload.length, entry + 8)
    bytes.writeUInt32LE(payloadOffset, entry + 12)
    if (index !== 1) {
      payload.copy(bytes, nextPayloadOffset)
      nextPayloadOffset += payload.length
    }
  }
  return bytes
}

function icns(
  types = ['icp4', 'ic11', 'icp5', 'ic12', 'ic07', 'ic13', 'ic08', 'ic14', 'ic09', 'ic10'],
  sizes = [16, 32, 32, 64, 128, 256, 256, 512, 512, 1024],
) {
  const payloads = types.map((_type, index) => png(sizes[index]!))
  const bytes = Buffer.alloc(8 + payloads.reduce((total, payload) => total + 8 + payload.length, 0))
  bytes.write('icns', 0)
  bytes.writeUInt32BE(bytes.length, 4)
  for (const [index, type] of types.entries()) {
    const offset = index === 0 ? 8 : 8 + payloads.slice(0, index).reduce((total, value) => total + 8 + value.length, 0)
    bytes.write(type, offset)
    bytes.writeUInt32BE(8 + payloads[index]!.length, offset + 4)
    payloads[index]!.copy(bytes, offset + 8)
  }
  return bytes
}

function outputBytes(path: string) {
  if (path.endsWith('.png')) return png()
  if (path.endsWith('.jpeg')) return decodableJpeg
  if (path.endsWith('.pdf')) return Buffer.from('%PDF-1.4\n%%EOF\n')
  if (path.endsWith('.doc')) return Buffer.from('d0cf11e0a1b11ae1', 'hex')
  if (path.endsWith('.docx') || path.endsWith('.xlsx')) return Buffer.from('504b0304', 'hex')
  if (path.endsWith('.csv')) return Buffer.from('name,value\nauto-forge,1\n')
  if (path.endsWith('.wav')) return Buffer.from('524946460400000057415645', 'hex')
  if (path.endsWith('.mp4')) return Buffer.from('000000186674797069736f6d00000000', 'hex')
  if (path.endsWith('.webm')) return Buffer.from('1a45dfa3', 'hex')
  if (path.endsWith('.mp3')) return Buffer.from('49443304000000000000', 'hex')
  if (path.endsWith('.ico')) return ico()
  if (path.endsWith('.icns')) return icns()
  throw new Error(`Unhandled fixture output ${path}`)
}

async function writeOutput(path: string, bytes = outputBytes(path)) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, bytes)
}

type RunRequest = { executable: string, args: readonly string[], cwd: string, signal?: AbortSignal }
type RunOutcome = { code: number, stdout?: string }
type RunnerOptions = {
  mutate?: (path: string, bytes: Buffer) => Buffer | undefined
  override?: (request: RunRequest) => RunOutcome | undefined | Promise<RunOutcome | undefined>
  after?: (request: RunRequest) => void | Promise<void>
}

function ffprobeFixture(path: string, codec = 'fixture') {
  if (path.endsWith('.webm')) return { format: { format_name: 'matroska,webm' }, streams: [{ codec_type: 'video', codec_name: codec === 'fixture' ? 'vp9' : codec }, { codec_type: 'audio', codec_name: codec === 'fixture' ? 'opus' : codec }] }
  if (path.endsWith('.mp4')) return { format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2' }, streams: [{ codec_type: 'video', codec_name: codec === 'fixture' ? 'h264' : codec }, { codec_type: 'audio', codec_name: codec === 'fixture' ? 'aac' : codec }] }
  if (path.endsWith('.wav')) return { format: { format_name: 'wav' }, streams: [{ codec_type: 'audio', codec_name: codec === 'fixture' ? 'pcm_s16le' : codec }] }
  return { format: { format_name: 'mp3' }, streams: [{ codec_type: 'audio', codec_name: codec === 'fixture' ? 'mp3' : codec }] }
}

function recordingRunner(calls: RunRequest[], options: RunnerOptions = {}) {
  const bytesFor = (path: string) => {
    const bytes = outputBytes(path)
    return options.mutate?.(path, bytes) ?? bytes
  }
  return async (request: RunRequest) => {
    const { executable, args } = request
    calls.push(request)
    const overridden = await options.override?.(request)
    if (overridden !== undefined) return overridden
    if (executable.endsWith('/pdfinfo')) return { code: 0, stdout: 'Pages:          1\nPDF version:     1.4\n' }
    if (executable.endsWith('/ffprobe')) {
      const path = args.at(-1)!
      return { code: 0, stdout: JSON.stringify(ffprobeFixture(path)) }
    }
    if (executable.endsWith('/pdftocairo')) {
      const path = `${args.at(-1)}${args.includes('-png') ? '.png' : '.jpeg'}`
      await writeOutput(path, bytesFor(path))
      await options.after?.(request)
      return { code: 0 }
    }
    const output = args.at(-1)
    const outdir = args.indexOf('--outdir')
    const pattern = args.indexOf('--output-pattern')
    const direct = args.indexOf('--output')
    if (outdir >= 0) {
      const source = args.at(-1)!
      const target = args[args.indexOf('--convert-to') + 1]!
      const path = join(args[outdir + 1]!, `${source.split('/').at(-1)!.replace(/\.[^.]+$/u, '')}.${target}`)
      await writeOutput(path, bytesFor(path))
    } else if (pattern >= 0) {
      const path = args[pattern + 1]!.replace('%03d', '001')
      await writeOutput(path, bytesFor(path))
    } else if (direct >= 0) {
      const path = args[direct + 1]!
      await writeOutput(path, bytesFor(path))
    } else if (output?.startsWith('/')) {
      await writeOutput(output, bytesFor(output))
    }
    await options.after?.(request)
    return { code: 0 }
  }
}

it('runs the bounded four-family smoke contracts using only descriptor-declared executables', async () => {
  const root = temporaryRoot()
  const calls: RunRequest[] = []
  const releaseRoot = await releaseFixture(root)
  const workRoot = join(root, 'work')
  await mkdir(workRoot)

  await smokeTestLocalDevelopmentRelease({
    releaseRoot,
    workRoot,
    run: recordingRunner(calls, {
      mutate: (path) => path === join(workRoot, 'pdf-png', 'page-001.png') ? png(1, { colorType: 2 }) : undefined,
    }),
  })

  expect(calls).toHaveLength(27)
  expect(calls.every(({ executable }) => executable.startsWith(`${releaseRoot}/installed/`))).toBe(true)
  expect(calls.some(({ args }) => args.includes('--sizes'))).toBe(true)
  expect(calls.some(({ args }) => args.includes('--representations'))).toBe(true)
  expect(calls.some(({ args }) => args.slice(0, 5).join('\0') === '-nostdin\0-hide_banner\0-loglevel\0error\0-nostats')).toBe(true)
  expect(calls.some(({ executable }) => executable.endsWith('/bin/pdfinfo'))).toBe(true)
  expect(calls.some(({ executable }) => executable.endsWith('/bin/pdftocairo'))).toBe(true)
  expect(calls.some(({ executable }) => executable.endsWith('/bin/ffprobe'))).toBe(true)
  const pathArguments = calls.flatMap(({ args }) => args.flatMap((argument) => {
    if (isAbsolute(argument)) return [argument]
    if (argument.startsWith('-env:UserInstallation=')) return [fileURLToPath(argument.slice('-env:UserInstallation='.length))]
    return []
  }))
  const isContained = (path: string) => { const value = relative(workRoot, path); return value !== '..' && !value.startsWith('../') && !isAbsolute(value) }
  expect(calls.every(({ cwd }) => isContained(cwd))).toBe(true)
  expect(pathArguments.every(isContained)).toBe(true)
  expect(existsSync(workRoot)).toBe(false)
})

it.each([
  ['invalid PNG compression method', 'pdf-png/page-001.png', () => png(1, { compression: 1 })],
  ['illegal PNG bit-depth/color-type combination', 'pdf-png/page-001.png', () => png(1, { bitDepth: 4, colorType: 2 })],
  ['invalid PNG interlace method', 'pdf-png/page-001.png', () => png(1, { interlace: 2 })],
  ['corrupt PNG deflate stream', 'pdf-png/page-001.png', () => png(1, { corruptDeflate: true })],
  ['marker-only pseudo JPEG', 'jpeg/output.jpeg', () => markerOnlyJpeg],
  ['mismatched ICO entry height', 'ico/output.ico', () => { const bytes = ico(); bytes[6 + 16 + 1] = 23; return bytes }],
  ['out-of-bounds ICO payload', 'ico/output.ico', () => { const bytes = ico(); bytes.writeUInt32LE(bytes.length, 6 + 8); return bytes }],
  ['overlapping ICO payloads', 'ico/output.ico', () => icoWithOverlappingPayloads()],
  ['missing ordered ICNS representations', 'icns/output.icns', () => icns(['icp4', 'icp5'])],
  ['wrong ICNS @2x payload geometry', 'icns/output.icns', () => icns(undefined, [16, 16, 32, 64, 128, 256, 256, 512, 512, 1024])],
])('fails closed for targeted %s and removes its work root', async (_name, relativeTarget, corrupt) => {
  const root = temporaryRoot()
  const releaseRoot = await releaseFixture(root)
  const workRoot = join(root, 'work')
  await mkdir(workRoot)

  const target = join(workRoot, ...relativeTarget.split('/'))
  await expect(smokeTestLocalDevelopmentRelease({
    releaseRoot,
    workRoot,
    run: recordingRunner([], { mutate: (path) => path === target ? corrupt() : undefined }),
  })).rejects.toThrow()
  expect(() => writeFileSync(join(workRoot, 'must-not-exist'), 'x')).toThrow()
})

it.each([
  ['wrong page count', 'Pages:          2\nPDF version:     1.4\n'],
  ['malformed format report', 'Pages:          1\nPDF version:     not-pdf\n'],
])('rejects exact descriptor pdfinfo %s', async (_name, stdout) => {
  const root = temporaryRoot()
  const releaseRoot = await releaseFixture(root)
  const workRoot = join(root, 'work')
  const pdfinfo = join(releaseRoot, 'installed', 'pdf', '1.0.0', 'darwin-arm64', 'bin', 'pdfinfo')
  await mkdir(workRoot)

  await expect(smokeTestLocalDevelopmentRelease({
    releaseRoot,
    workRoot,
    run: recordingRunner([], { override: ({ executable }) => executable === pdfinfo ? { code: 0, stdout } : undefined }),
  })).rejects.toThrow()
})

async function injectAfterLastProbe(workRoot: string, mutate: () => void | Promise<void>) {
  const target = join(workRoot, 'extract', 'output.mp3')
  return async ({ executable, args }: RunRequest) => {
    if (!executable.endsWith('/ffprobe') || args.at(-1) !== target) return undefined
    await mutate()
    return { code: 0, stdout: JSON.stringify(ffprobeFixture(target)) }
  }
}

it.each([
  ['zero-byte regular file', async (workRoot: string) => { await writeFile(join(workRoot, 'sources', 'source.txt'), Buffer.alloc(0)) }],
  ['regular file larger than 64 MiB', async (workRoot: string) => {
    const handle = await open(join(workRoot, 'sources', 'source.txt'), 'r+')
    try { await handle.truncate(64 * 1024 * 1024 + 1) } finally { await handle.close() }
  }],
  ['33 generated output files', async (workRoot: string) => {
    await Promise.all(Array.from({ length: 14 }, (_value, index) => writeFile(join(workRoot, 'sources', `unexpected-output-${index}.bin`), 'x')))
  }],
  ['one unexpected regular file', async (workRoot: string) => { await writeFile(join(workRoot, 'sources', 'unexpected.bin'), 'x') }],
  ['one unexpected empty directory', async (workRoot: string) => { await mkdir(join(workRoot, 'sources', 'unexpected-empty')) }],
  ['one nested symlink', async (workRoot: string) => { await symlink(join(workRoot, 'sources', 'source.txt'), join(workRoot, 'sources', 'unexpected-link')) }],
])('rejects the final recursive tree policy for %s without an earlier format failure', async (_name, mutate) => {
  const root = temporaryRoot()
  const releaseRoot = await releaseFixture(root)
  const workRoot = join(root, 'work')
  await mkdir(workRoot)

  await expect(smokeTestLocalDevelopmentRelease({
    releaseRoot,
    workRoot,
    run: recordingRunner([], { override: await injectAfterLastProbe(workRoot, () => mutate(workRoot)) }),
  })).rejects.toThrow()
  expect(existsSync(workRoot)).toBe(false)
})

it('rejects a declared output path replaced by an escaping symlink before invoking the runner again', async () => {
  const root = temporaryRoot()
  const releaseRoot = await releaseFixture(root)
  const workRoot = join(root, 'work')
  const outsideRoot = join(root, 'outside')
  const sentinel = join(outsideRoot, 'source.docx')
  const escapedOutputRoot = join(workRoot, 'source-docx')
  const calls: RunRequest[] = []
  await mkdir(workRoot)
  await mkdir(outsideRoot)
  await writeFile(sentinel, 'external sentinel')
  let swapped = false

  await expect(smokeTestLocalDevelopmentRelease({
    releaseRoot,
    workRoot,
    run: recordingRunner(calls, {
      after: async ({ args }) => {
        if (swapped || args[args.indexOf('--convert-to') + 1] !== 'doc') return
        swapped = true
        await rm(escapedOutputRoot, { recursive: true })
        await symlink(outsideRoot, escapedOutputRoot, 'dir')
      },
    }),
  })).rejects.toThrow()

  expect(calls.some(({ cwd }) => cwd === escapedOutputRoot)).toBe(false)
  expect(await readFile(sentinel, 'utf8')).toBe('external sentinel')
  expect(existsSync(workRoot)).toBe(false)
})

it.each([
  ['wrong container', (path: string) => ({ ...ffprobeFixture(path), format: { format_name: 'not-the-container' } })],
  ['wrong codec', (path: string) => ffprobeFixture(path, 'not-the-codec')],
  ['wrong stream type', (path: string) => ({ ...ffprobeFixture(path), streams: [{ codec_type: 'subtitle', codec_name: 'fixture' }] })],
])('rejects exact descriptor ffprobe %s', async (_name, probe) => {
  const root = temporaryRoot()
  const releaseRoot = await releaseFixture(root)
  const workRoot = join(root, 'work')
  const ffprobe = join(releaseRoot, 'installed', 'media', '1.0.0', 'darwin-arm64', 'bin', 'ffprobe')
  await mkdir(workRoot)

  await expect(smokeTestLocalDevelopmentRelease({
    releaseRoot,
    workRoot,
    run: recordingRunner([], {
      override: ({ executable, args }) => executable === ffprobe ? { code: 0, stdout: JSON.stringify(probe(args.at(-1)!)) } : undefined,
    }),
  })).rejects.toThrow()
})

it('awaits cooperative AbortSignal cleanup before rejecting and removing the work root', async () => {
  const root = temporaryRoot()
  const releaseRoot = await releaseFixture(root)
  const workRoot = join(root, 'cooperative-timeout')
  const events: string[] = []
  await mkdir(workRoot)

  const run = ({ signal }: RunRequest) => new Promise<RunOutcome>((_resolve, reject) => {
    expect(signal).toBeInstanceOf(AbortSignal)
    signal!.addEventListener('abort', () => {
      events.push('abort')
      setTimeout(() => {
        events.push('runner-cleanup')
        events.push('smoke-reject')
        reject(new Error('cooperative timeout'))
      }, 5)
    }, { once: true })
  })

  await expect(smokeTestLocalDevelopmentRelease({ releaseRoot, workRoot, run, timeoutMs: 10 })).rejects.toThrow()
  expect(existsSync(workRoot)).toBe(false)
  events.push('workroot-removed')
  expect(events).toEqual(['abort', 'runner-cleanup', 'smoke-reject', 'workroot-removed'])
})

it('fails closed when an injected runner reports a subprocess error', async () => {
  const root = temporaryRoot()
  const releaseRoot = await releaseFixture(root)
  const workRoot = join(root, 'subprocess-error')
  await mkdir(workRoot)

  await expect(smokeTestLocalDevelopmentRelease({ releaseRoot, workRoot, run: async () => ({ code: 1 }) })).rejects.toThrow()
  expect(existsSync(workRoot)).toBe(false)
})

it('clears the single timeout timer when an injected runner throws synchronously', async () => {
  const root = temporaryRoot()
  const releaseRoot = await releaseFixture(root)
  const workRoot = join(root, 'synchronous-runner-error')
  let aborts = 0
  await mkdir(workRoot)

  await expect(smokeTestLocalDevelopmentRelease({
    releaseRoot,
    workRoot,
    timeoutMs: 10,
    run: ({ signal }: RunRequest) => {
      signal!.addEventListener('abort', () => { aborts += 1 }, { once: true })
      throw new Error('synchronous runner failure')
    },
  })).rejects.toThrow()
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(aborts).toBe(0)
  expect(existsSync(workRoot)).toBe(false)
})

it('default runner timeout kills the detached process group and observes close before work-root cleanup', async () => {
  const root = temporaryRoot()
  const workRoot = join(root, 'default-runner')
  const sentinel = join(root, 'descendant-sentinel')
  const pidFile = join(workRoot, 'pids.json')
  await mkdir(workRoot)
  const verifier = await import('../../scripts/converter-packs/verify-local-development-release.mjs') as {
    runDefaultCommandForTest?: (request: {
      executable: string
      args: readonly string[]
      cwd: string
      env: NodeJS.ProcessEnv
      timeoutMs: number
    }) => Promise<RunOutcome>
  }
  expect(typeof verifier.runDefaultCommandForTest).toBe('function')
  const descendantScript = "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'escaped'), 300)"
  const parentScript = [
    "const { spawn } = require('node:child_process')",
    "const { writeFileSync } = require('node:fs')",
    "const [sentinel, pidFile, descendantScript] = process.argv.slice(1)",
    "const descendant = spawn(process.execPath, ['-e', descendantScript, sentinel], { stdio: ['ignore', 'inherit', 'inherit'] })",
    "writeFileSync(pidFile, JSON.stringify({ parent: process.pid, descendant: descendant.pid }))",
    "setInterval(() => {}, 1000)",
  ].join(';')
  const events: string[] = []

  await expect(verifier.runDefaultCommandForTest!({
    executable: process.execPath,
    args: ['-e', parentScript, sentinel, pidFile, descendantScript],
    cwd: workRoot,
    env: { ...process.env, TEMP: workRoot, TMP: workRoot, TMPDIR: workRoot },
    timeoutMs: 80,
  }).catch((error) => {
    events.push('child-close')
    throw error
  })).rejects.toThrow()
  const pids = JSON.parse(await readFile(pidFile, 'utf8')) as { parent: number, descendant: number }
  expect(pids.parent).toBeGreaterThan(0)
  expect(pids.descendant).toBeGreaterThan(0)
  events.push('workroot-cleanup-start')
  await rm(workRoot, { recursive: true })
  expect(events).toEqual(['child-close', 'workroot-cleanup-start'])
  await new Promise((resolve) => setTimeout(resolve, 350))
  expect(existsSync(sentinel)).toBe(false)
})
