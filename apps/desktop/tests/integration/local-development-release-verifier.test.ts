import { generateKeyPairSync } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

function ico(sizes = [16, 24, 32, 48, 64, 128, 256]) {
  const bytes = Buffer.alloc(6 + sizes.length * 16 + sizes.length)
  bytes.writeUInt16LE(1, 2)
  bytes.writeUInt16LE(sizes.length, 4)
  for (const [index, size] of sizes.entries()) {
    const entry = 6 + index * 16
    bytes[entry] = size === 256 ? 0 : size
    bytes[entry + 1] = size === 256 ? 0 : size
    bytes.writeUInt32LE(1, entry + 8)
    bytes.writeUInt32LE(6 + sizes.length * 16 + index, entry + 12)
    bytes[6 + sizes.length * 16 + index] = index + 1
  }
  return bytes
}

function icns(types = ['icp4', 'ic11', 'icp5', 'ic12', 'ic07', 'ic13', 'ic08', 'ic14', 'ic09', 'ic10']) {
  const bytes = Buffer.alloc(8 + types.length * 9)
  bytes.write('icns', 0)
  bytes.writeUInt32BE(bytes.length, 4)
  for (const [index, type] of types.entries()) {
    const offset = 8 + index * 9
    bytes.write(type, offset)
    bytes.writeUInt32BE(9, offset + 4)
    bytes[offset + 8] = index + 1
  }
  return bytes
}

function outputBytes(path: string) {
  if (path.endsWith('.png')) return Buffer.from('89504e470d0a1a0a', 'hex')
  if (path.endsWith('.jpeg')) return Buffer.from('ffd8ffd9', 'hex')
  if (path.endsWith('.pdf')) return Buffer.from('%PDF-1.4\n%%EOF\n')
  if (path.endsWith('.doc')) return Buffer.from('d0cf11e0a1b11ae1', 'hex')
  if (path.endsWith('.docx') || path.endsWith('.xlsx')) return Buffer.from('504b0304', 'hex')
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

function recordingRunner(calls: Array<{ executable: string, args: readonly string[] }>, mutate?: (path: string) => Buffer | undefined) {
  return async ({ executable, args }: { executable: string, args: readonly string[] }) => {
    calls.push({ executable, args })
    const output = args.at(-1)
    const outdir = args.indexOf('--outdir')
    const pattern = args.indexOf('--output-pattern')
    const direct = args.indexOf('--output')
    if (outdir >= 0) {
      const source = args.at(-1)!
      const target = args[args.indexOf('--convert-to') + 1]!
      await writeOutput(join(args[outdir + 1]!, `${source.split('/').at(-1)!.replace(/\.[^.]+$/u, '')}.${target}`))
    } else if (pattern >= 0) {
      const path = args[pattern + 1]!.replace('%03d', '001')
      await writeOutput(path, mutate?.(path))
    } else if (direct >= 0) {
      const path = args[direct + 1]!
      await writeOutput(path, mutate?.(path))
    } else if (output?.startsWith('/')) {
      await writeOutput(output, mutate?.(output))
    }
    return { code: 0 }
  }
}

it('runs the bounded four-family smoke contracts using only descriptor-declared executables', async () => {
  const root = temporaryRoot()
  const calls: Array<{ executable: string, args: readonly string[] }> = []
  const releaseRoot = await releaseFixture(root)
  const workRoot = join(root, 'work')
  await mkdir(workRoot)

  await smokeTestLocalDevelopmentRelease({ releaseRoot, workRoot, run: recordingRunner(calls) })

  expect(calls).toHaveLength(16)
  expect(calls.map(({ executable }) => executable.replace(`${releaseRoot}/installed/`, ''))).toEqual([
    'document/1.0.0/darwin-arm64/program/soffice', 'document/1.0.0/darwin-arm64/program/soffice',
    'document/1.0.0/darwin-arm64/program/soffice', 'document/1.0.0/darwin-arm64/program/soffice', 'document/1.0.0/darwin-arm64/program/soffice',
    'image-icon/1.0.0/darwin-arm64/bin/autoforge-image-converter', 'image-icon/1.0.0/darwin-arm64/bin/autoforge-image-converter', 'image-icon/1.0.0/darwin-arm64/bin/autoforge-image-converter', 'image-icon/1.0.0/darwin-arm64/bin/autoforge-image-converter',
    'pdf/1.0.0/darwin-arm64/bin/autoforge-pdf-raster', 'pdf/1.0.0/darwin-arm64/bin/autoforge-pdf-raster',
    'media/1.0.0/darwin-arm64/bin/ffmpeg', 'media/1.0.0/darwin-arm64/bin/ffmpeg', 'media/1.0.0/darwin-arm64/bin/ffmpeg', 'media/1.0.0/darwin-arm64/bin/ffmpeg', 'media/1.0.0/darwin-arm64/bin/ffmpeg',
  ])
  expect(calls[7]!.args).toContain('--sizes')
  expect(calls[8]!.args).toContain('--representations')
  expect(calls[13]!.args.slice(0, 5)).toEqual(['-nostdin', '-hide_banner', '-loglevel', 'error', '-nostats'])
  expect(existsSync(workRoot)).toBe(false)
})

it.each([
  ['wrong magic', () => Buffer.from('not an image')],
  ['wrong probed format', () => Buffer.from('%PDF-1.4\n%%EOF\n')],
  ['missing ordered ICO representations', () => ico([16, 32, 48])],
  ['missing ordered ICNS representations', () => icns(['icp4', 'icp5'])],
])('fails closed for %s and removes its work root', async (_name, mutate) => {
  const root = temporaryRoot()
  const releaseRoot = await releaseFixture(root)
  const workRoot = join(root, 'work')
  await mkdir(workRoot)

  await expect(smokeTestLocalDevelopmentRelease({ releaseRoot, workRoot, run: recordingRunner([], mutate) })).rejects.toThrow()
  expect(() => writeFileSync(join(workRoot, 'must-not-exist'), 'x')).toThrow()
})

it('fails closed when a runner escapes the canonical work root, exceeds the timeout, or reports a subprocess error', async () => {
  const root = temporaryRoot()
  const releaseRoot = await releaseFixture(root)
  for (const run of [
    async () => ({ code: 1 }),
    async () => { await new Promise((resolve) => setTimeout(resolve, 50)); return { code: 0 } },
  ]) {
    const workRoot = join(root, `work-${Math.random()}`)
    await mkdir(workRoot)
    await expect(smokeTestLocalDevelopmentRelease({ releaseRoot, workRoot, run, timeoutMs: 1 })).rejects.toThrow()
  }
})
