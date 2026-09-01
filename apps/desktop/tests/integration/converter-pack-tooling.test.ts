import { createHash, createPrivateKey, generateKeyPairSync, sign as signBytes } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createProductionBootstrap } from '../../scripts/converter-packs/create-production-bootstrap.mjs'
import { createRestrictedUstar, sha256, writeRestrictedUstarEntries } from '../../scripts/converter-packs/pack-tooling-lib.mjs'

const desktopRoot = fileURLToPath(new URL('../..', import.meta.url))
const buildScript = join(desktopRoot, 'scripts/converter-packs/build-index.mjs')
const signScript = join(desktopRoot, 'scripts/converter-packs/sign-index.mjs')
const verifyScript = join(desktopRoot, 'scripts/verify-converter-packs.mjs')
const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'autoforge-converter-tooling-')))
  temporaryRoots.push(root)
  return root
}

function run(script: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: desktopRoot, env })
}

function build(stage: string, output: string, mode: 'test' | 'production' = 'test', env?: NodeJS.ProcessEnv) {
  return run(buildScript, ['--input', stage, '--output', output, '--mode', mode], env)
}

function signIndex(index: string, privateKey: string, mode: 'test' | 'production' = 'test') {
  return run(signScript, ['--index', index, '--private-key', privateKey, '--mode', mode])
}

function verifyRelease(root: string, publicKey: string, mode: 'test' | 'production' = 'test') {
  return run(verifyScript, ['--root', root, '--public-key', publicKey, '--mode', mode])
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

function stagePack(root: string, overrides: Partial<Record<string, unknown>> = {}) {
  const stage = join(root, 'stage')
  const pack = join(stage, 'packs', 'media-darwin-arm64')
  const payload = join(pack, 'payload')
  mkdirSync(join(payload, 'bin'), { recursive: true })
  mkdirSync(join(payload, 'LICENSES'), { recursive: true })
  writeFileSync(join(stage, 'release.json'), JSON.stringify({
    schemaVersion: 1,
    generatedAt: '2026-08-29T00:00:00.000Z',
    sequence: 13,
  }))
  writeFileSync(join(payload, 'bin', 'ffmpeg'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(payload, 'bin', 'ffmpeg'), 0o755)
  writeFileSync(join(payload, 'LICENSES', 'ffmpeg.txt'), 'Fixture license notice\n')
  writeFileSync(join(pack, 'pack.json'), JSON.stringify({
    schemaVersion: 1,
    name: 'media',
    version: '1.0.0',
    platform: 'darwin',
    arch: 'arm64',
    archiveUrl: 'https://packs.example.test/media-1.0.0-darwin-arm64.tar',
    files: [
      { path: 'bin/ffmpeg', role: 'executable' },
      { path: 'LICENSES/ffmpeg.txt', role: 'license' },
    ],
    ...overrides,
  }))
  return stage
}

function stageWindowsPack(root: string): string {
  const stage = stagePack(root)
  const darwinPack = join(stage, 'packs', 'media-darwin-arm64')
  const windowsPack = join(stage, 'packs', 'media-win32-x64')
  renameSync(darwinPack, windowsPack)
  renameSync(join(windowsPack, 'payload/bin/ffmpeg'), join(windowsPack, 'payload/bin/ffmpeg.exe'))
  const manifestPath = join(windowsPack, 'pack.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    platform: string
    arch: string
    archiveUrl: string
    files: Array<{ path: string; role: string }>
  }
  manifest.platform = 'win32'
  manifest.arch = 'x64'
  manifest.archiveUrl = 'https://packs.example.test/media-1.0.0-win32-x64.tar'
  manifest.files = manifest.files.map((file) => (
    file.path === 'bin/ffmpeg' ? { ...file, path: 'bin/ffmpeg.exe' } : file
  ))
  writeFileSync(manifestPath, JSON.stringify(manifest))
  return stage
}

const targetExecutablePaths = {
  'image-icon': { darwin: ['bin/autoforge-image-converter', 'bin/vips'], win32: ['bin/autoforge-image-converter.exe', 'bin/vips.exe'] },
  document: { darwin: ['program/soffice'], win32: ['program/soffice.exe'] },
  pdf: { darwin: ['bin/autoforge-pdf-raster', 'bin/pdfinfo', 'bin/pdftocairo'], win32: ['bin/autoforge-pdf-raster.exe', 'bin/pdfinfo.exe', 'bin/pdftocairo.exe'] },
  media: { darwin: ['bin/ffmpeg', 'bin/ffprobe'], win32: ['bin/ffmpeg.exe', 'bin/ffprobe.exe'] },
} as const

function stageProduction(root: string): string {
  const stage = join(root, 'production-stage')
  mkdirSync(join(stage, 'packs'), { recursive: true })
  writeFileSync(join(stage, 'release.json'), JSON.stringify({
    schemaVersion: 1,
    generatedAt: '2026-08-29T00:00:00.000Z',
    sequence: 13,
  }))
  for (const [platform, arch] of [['darwin', 'arm64'], ['darwin', 'x64']] as const) {
    for (const name of ['image-icon', 'document', 'pdf', 'media'] as const) {
      const pack = join(stage, 'packs', `${name}-${platform}-${arch}`)
      const payload = join(pack, 'payload')
      const files = targetExecutablePaths[name][platform]
      mkdirSync(join(payload, 'LICENSES'), { recursive: true })
      for (const path of files) {
        const absolute = join(payload, ...path.split('/'))
        mkdirSync(join(absolute, '..'), { recursive: true })
        writeFileSync(absolute, `${name} ${platform}-${arch} fixture\n`)
        chmodSync(absolute, platform === 'darwin' ? 0o755 : 0o644)
      }
      const licensePath = `LICENSES/${name}.txt`
      writeFileSync(join(payload, licensePath), `${name} fixture license\n`)
      writeFileSync(join(pack, 'pack.json'), JSON.stringify({
        schemaVersion: 1,
        name,
        version: '1.0.0',
        platform,
        arch,
        archiveUrl: `https://packs.example.test/${name}-1.0.0-${platform}-${arch}.tar`,
        files: [
          ...files.map((path) => ({ path, role: 'executable' })),
          { path: licensePath, role: 'license' },
        ],
      }))
    }
  }
  return stage
}

function createAsar(
  path: string,
  files: Record<string, Buffer>,
  options: {
    unindexedPrefix?: Buffer
    unindexedTrailer?: Buffer
    headerSlack?: Buffer
    nonzeroPadding?: boolean
  } = {},
) {
  const header: { files: Record<string, unknown> } = { files: {} }
  const payloads: Buffer[] = []
  let offset = options.unindexedPrefix?.byteLength ?? 0
  for (const name of Object.keys(files).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))) {
    const segments = name.split('/')
    let directory = header
    for (const segment of segments.slice(0, -1)) {
      const node = (directory.files[segment] ??= { files: {} }) as { files: Record<string, unknown> }
      directory = node
    }
    const bytes = files[name]!
    directory.files[segments.at(-1)!] = { size: bytes.byteLength, offset: String(offset) }
    payloads.push(bytes)
    offset += bytes.byteLength
  }
  const json = Buffer.from(JSON.stringify(header))
  const alignedJsonBytes = Math.ceil(json.byteLength / 4) * 4
  const headerSlack = options.headerSlack ?? Buffer.alloc(0)
  if (headerSlack.byteLength % 4 !== 0) throw new Error('ASAR header slack fixture must be 4-byte aligned')
  const innerPayloadBytes = 4 + alignedJsonBytes + headerSlack.byteLength
  const inner = Buffer.alloc(4 + innerPayloadBytes)
  inner.writeUInt32LE(innerPayloadBytes, 0)
  inner.writeUInt32LE(json.byteLength, 4)
  json.copy(inner, 8)
  if (options.nonzeroPadding) {
    if (alignedJsonBytes === json.byteLength) throw new Error('ASAR fixture JSON has no alignment padding')
    inner[8 + json.byteLength] = 1
  }
  headerSlack.copy(inner, 8 + alignedJsonBytes)
  const outer = Buffer.alloc(8)
  outer.writeUInt32LE(4, 0)
  outer.writeUInt32LE(inner.byteLength, 4)
  const temporary = `${path}.building`
  writeFileSync(temporary, Buffer.concat([
    outer,
    inner,
    ...(options.unindexedPrefix === undefined ? [] : [options.unindexedPrefix]),
    ...payloads,
    ...(options.unindexedTrailer === undefined ? [] : [options.unindexedTrailer]),
  ]))
  renameSync(temporary, path)
}

function packagedApp(root: string, platform: 'darwin' | 'win32', files: Record<string, Buffer> = { 'package.json': Buffer.from('{}') }) {
  const app = join(root, platform === 'darwin' ? 'Fixture.app' : 'win-unpacked')
  const resources = platform === 'darwin' ? join(app, 'Contents', 'Resources') : join(app, 'resources')
  const converter = join(resources, 'converter-packs')
  mkdirSync(converter, { recursive: true })
  createAsar(join(resources, 'app.asar'), files)
  copyFileSync(join(desktopRoot, 'resources/converter-packs/bootstrap.json'), join(converter, 'bootstrap.json'))
  copyFileSync(join(desktopRoot, 'resources/converter-packs/index.schema.json'), join(converter, 'index.schema.json'))
  return { app, resources, converter }
}

function keyPair(root: string) {
  const pair = generateKeyPairSync('ed25519')
  const privateKey = join(root, 'fixture-private.pem')
  const publicKey = join(root, 'fixture-public.pem')
  writeFileSync(privateKey, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }))
  writeFileSync(publicKey, pair.publicKey.export({ format: 'pem', type: 'spki' }))
  chmodSync(privateKey, 0o600)
  return { privateKey, publicKey }
}

function restrictedDescriptor(entries: Array<{ path: string; bytes: Buffer; executable: boolean; role: string }>, archive: Buffer) {
  return {
    archiveBytes: archive.byteLength,
    entries: entries.map((entry) => ({
      path: entry.path,
      sha256: sha256(entry.bytes),
      bytes: entry.bytes.byteLength,
      executable: entry.executable,
      role: entry.role,
    })),
  }
}

describe('converter pack release tooling', () => {
  const actualDarwinApp = join(desktopRoot, 'dist', 'mac-arm64', 'AutoForge.app')

  it('materializes only descriptor-authenticated USTAR entries beneath a new destination', async () => {
    const root = temporaryRoot()
    const entries = [
      { path: 'bin/converter', bytes: Buffer.from('#!/bin/sh\necho fixture\n'), executable: true, role: 'executable' },
      { path: 'LICENSES/notice.txt', bytes: Buffer.from('Fixture license\n'), executable: false, role: 'license' },
    ]
    const archive = createRestrictedUstar(entries)
    const descriptor = restrictedDescriptor(entries, archive)
    const destination = join(root, 'installed')

    await writeRestrictedUstarEntries({ archive, descriptor, destination })

    expect(readFileSync(join(destination, 'bin', 'converter'))).toEqual(entries[0]!.bytes)
    expect(readFileSync(join(destination, 'LICENSES', 'notice.txt'))).toEqual(entries[1]!.bytes)
    expect(statSync(join(destination, 'bin', 'converter')).mode & 0o777).toBe(0o755)
    expect(statSync(join(destination, 'LICENSES', 'notice.txt')).mode & 0o777).toBe(0o644)
  })

  it.each([
    ['traversal', (archive: Buffer) => { Buffer.from('../escape\0').copy(archive, 0) }],
    ['duplicate portable names', (archive: Buffer) => { Buffer.from('BIN/converter\0').copy(archive, 1024) }],
    ['symlink', (archive: Buffer) => { archive[156] = '2'.charCodeAt(0) }],
    ['undeclared entries', (archive: Buffer) => { Buffer.from('bin/other\0').copy(archive, 0) }],
  ])('rejects a %s archive entry without preserving output', async (_name, mutate) => {
    const root = temporaryRoot()
    const entries = [
      { path: 'bin/converter', bytes: Buffer.from('#!/bin/sh\n'), executable: true, role: 'executable' },
      { path: 'LICENSES/notice.txt', bytes: Buffer.from('license\n'), executable: false, role: 'license' },
    ]
    const archive = createRestrictedUstar(entries)
    mutate(archive)
    const destination = join(root, 'installed')

    await expect(writeRestrictedUstarEntries({ archive, descriptor: restrictedDescriptor(entries, archive), destination })).rejects.toThrow()
    expect(existsSync(destination)).toBe(false)
  })

  it('rejects hash mismatches, non-empty destinations, and malformed second entries without partial output', async () => {
    const root = temporaryRoot()
    const entries = [
      { path: 'bin/converter', bytes: Buffer.from('#!/bin/sh\n'), executable: true, role: 'executable' },
      { path: 'LICENSES/notice.txt', bytes: Buffer.from('license\n'), executable: false, role: 'license' },
    ]
    const archive = createRestrictedUstar(entries)
    const descriptor = restrictedDescriptor(entries, archive)
    const hashMismatch = { ...descriptor, entries: descriptor.entries.map((entry, index) => index === 0 ? { ...entry, sha256: '0'.repeat(64) } : entry) }
    await expect(writeRestrictedUstarEntries({ archive, descriptor: hashMismatch, destination: join(root, 'hash-mismatch') })).rejects.toThrow()

    const occupied = join(root, 'occupied')
    mkdirSync(occupied)
    writeFileSync(join(occupied, 'keep.txt'), 'keep')
    await expect(writeRestrictedUstarEntries({ archive, descriptor, destination: occupied })).rejects.toThrow()
    expect(readdirSync(occupied)).toEqual(['keep.txt'])

    const malformed = Buffer.from(archive)
    malformed[1024 + 156] = '2'.charCodeAt(0)
    const partial = join(root, 'partial')
    await expect(writeRestrictedUstarEntries({ archive: malformed, descriptor: restrictedDescriptor(entries, malformed), destination: partial })).rejects.toThrow()
    expect(existsSync(partial)).toBe(false)
  })

  it.skipIf(!existsSync(actualDarwinApp))('accepts the actual large electron-builder ASAR with canonical Pickle sizing', () => {
    const appAsar = join(actualDarwinApp, 'Contents', 'Resources', 'app.asar')
    const previousNoAsar = process.noAsar
    let rawSize: number
    try {
      process.noAsar = true
      rawSize = lstatSync(appAsar).size
    } finally {
      process.noAsar = previousNoAsar
    }
    expect(rawSize).toBeGreaterThan(100 * 1024 * 1024)
    const bootstrap = JSON.parse(readFileSync(join(actualDarwinApp, 'Contents', 'Resources', 'converter-packs', 'bootstrap.json'), 'utf8')) as { downloadsEnabled?: unknown }
    const metadataMode = bootstrap.downloadsEnabled === true ? 'production' : 'disabled'
    const result = run(verifyScript, [
      '--packaged-app', actualDarwinApp, '--platform', 'darwin', '--arch', 'arm64', '--metadata-mode', metadataMode,
    ])
    expect(result.status, result.stderr).toBe(0)
  })

  it('accepts enabled Ed25519 metadata only in explicit production metadata mode', async () => {
    const root = temporaryRoot()
    const fixture = packagedApp(root, 'darwin')
    const keys = keyPair(root)
    const generated = join(root, 'generated-metadata')
    await createProductionBootstrap({
      indexUrl: 'https://cdn.example.test/converter-packs/stable/index.json',
      publicKeyPath: keys.publicKey,
      output: generated,
    })
    rmSync(fixture.converter, { recursive: true, force: true })
    mkdirSync(fixture.converter)
    for (const name of ['bootstrap.json', 'index.schema.json', 'root-public-key.pem']) {
      copyFileSync(join(generated, name), join(fixture.converter, name))
    }

    const disabled = run(verifyScript, ['--packaged-app', fixture.app, '--platform', 'darwin', '--arch', 'arm64'])
    expect(disabled.status).not.toBe(0)
    const production = run(verifyScript, [
      '--packaged-app', fixture.app, '--platform', 'darwin', '--arch', 'arm64', '--metadata-mode', 'production',
    ])
    expect(production.status, production.stderr).toBe(0)

    copyFileSync(
      join(desktopRoot, 'electron/main/conversion/fixtures/test-converter-root-public-key.pem'),
      join(fixture.converter, 'root-public-key.pem'),
    )
    const developmentKey = run(verifyScript, [
      '--packaged-app', fixture.app, '--platform', 'darwin', '--arch', 'arm64', '--metadata-mode', 'production',
    ])
    expect(developmentKey.status).not.toBe(0)
    expect(developmentKey.stderr).toMatch(/development|test/iu)
  })

  it('builds canonical archives and indexes byte-identically, signs with an explicit key, and verifies every hash', () => {
    const root = temporaryRoot()
    const stage = stagePack(root)
    const first = join(root, 'release-a')
    const second = join(root, 'release-b')
    const keys = keyPair(root)

    expect(build(stage, first)).toMatchObject({ status: 0 })
    expect(build(stage, second)).toMatchObject({ status: 0 })
    const firstIndex = readFileSync(join(first, 'index.json'))
    expect(firstIndex.equals(readFileSync(join(second, 'index.json')))).toBe(true)
    const index = JSON.parse(firstIndex.toString('utf8')) as { packs: Array<{ archiveUrl: string }> }
    expect(index.packs).toHaveLength(1)
    const archiveFile = basename(new URL(index.packs[0]!.archiveUrl).pathname)
    expect(readFileSync(join(first, archiveFile)).equals(readFileSync(join(second, archiveFile)))).toBe(true)

    const signed = signIndex(join(first, 'index.json'), keys.privateKey)
    expect(signed.status).toBe(0)
    expect(`${signed.stdout}${signed.stderr}`).not.toContain(keys.privateKey)
    const repeatedSignature = signIndex(join(second, 'index.json'), keys.privateKey)
    expect(repeatedSignature.status).toBe(0)
    expect(readFileSync(join(first, 'index.sig'))).toEqual(readFileSync(join(second, 'index.sig')))
    const verified = verifyRelease(first, keys.publicKey)
    expect(verified.status).toBe(0)
    expect(verified.stdout).toContain('verified 1 signed converter pack')
  })

  it.each([
    [buildScript, ['--input', 'relative-stage', '--output', '/tmp/release', '--mode', 'test']],
    [buildScript, ['--input', '/tmp/stage', '--output', 'relative-release', '--mode', 'test']],
    [signScript, ['--index', 'relative-index.json', '--private-key', '/tmp/private.pem', '--mode', 'test']],
    [signScript, ['--index', '/tmp/index.json', '--private-key', 'relative-private.pem', '--mode', 'test']],
    [verifyScript, ['--root', 'relative-release', '--public-key', '/tmp/public.pem', '--mode', 'test']],
    [verifyScript, ['--root', '/tmp/release', '--public-key', 'relative-public.pem', '--mode', 'test']],
  ])('rejects relative paths before filesystem access: %s', (script, args) => {
    const result = run(script, args)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('absolute path')
  })

  it('rejects symlinks anywhere in staged input and signing-key paths', () => {
    const root = temporaryRoot()
    const stage = stagePack(root)
    symlinkSync(join(stage, 'packs', 'media-darwin-arm64', 'payload', 'LICENSES', 'ffmpeg.txt'),
      join(stage, 'packs', 'media-darwin-arm64', 'payload', 'LICENSES', 'linked.txt'))
    const built = build(stage, join(root, 'release'))
    expect(built.status).not.toBe(0)
    expect(built.stderr).toContain('symbolic links')

    rmSync(join(stage, 'packs', 'media-darwin-arm64', 'payload', 'LICENSES', 'linked.txt'))
    const parentLink = join(root, 'linked-parent')
    symlinkSync(root, parentLink)
    const linkedParent = build(join(parentLink, 'stage'), join(root, 'release-linked-parent'))
    expect(linkedParent.status).not.toBe(0)
    expect(linkedParent.stderr).toContain('symbolic links')

    const output = join(root, 'release-valid')
    expect(build(stage, output).status).toBe(0)
    const keys = keyPair(root)
    const keyLink = join(root, 'linked-private.pem')
    symlinkSync(keys.privateKey, keyLink)
    const signed = signIndex(join(output, 'index.json'), keyLink)
    expect(signed.status).not.toBe(0)
    expect(signed.stderr).toContain('symbolic links')
    expect(signed.stderr).not.toContain(keys.privateKey)
  })

  it('rejects missing licenses, unknown executables, unsafe names, and unsupported targets', () => {
    const cases: Array<{ name: string; prepare(stage: string): void; message: string }> = [
      {
        name: 'missing license',
        prepare(stage) { rmSync(join(stage, 'packs', 'media-darwin-arm64', 'payload', 'LICENSES', 'ffmpeg.txt')) },
        message: 'license',
      },
      {
        name: 'unknown executable',
        prepare(stage) {
          const path = join(stage, 'packs', 'media-darwin-arm64', 'payload', 'bin', 'surprise')
          writeFileSync(path, '#!/bin/sh\nexit 0\n')
          chmodSync(path, 0o755)
        },
        message: 'executable',
      },
      {
        name: 'unsafe name',
        prepare(stage) { writeFileSync(join(stage, 'packs', 'media-darwin-arm64', 'payload', 'bad name'), 'unsafe') },
        message: 'unsafe',
      },
      {
        name: 'unsupported target',
        prepare(stage) {
          const manifest = join(stage, 'packs', 'media-darwin-arm64', 'pack.json')
          const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>
          writeFileSync(manifest, JSON.stringify({ ...parsed, platform: 'linux' }))
        },
        message: 'platform',
      },
      {
        name: 'unsafe archive URL',
        prepare(stage) {
          const manifest = join(stage, 'packs', 'media-darwin-arm64', 'pack.json')
          const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>
          writeFileSync(manifest, JSON.stringify({ ...parsed, archiveUrl: 'https://packs.example.test/media\nunsafe.tar' }))
        },
        message: 'descriptor',
      },
    ]

    for (const item of cases) {
      const root = temporaryRoot()
      const stage = stagePack(root)
      item.prepare(stage)
      const result = build(stage, join(root, 'release'))
      expect(result.status, item.name).not.toBe(0)
      expect(result.stderr.toLowerCase(), item.name).toContain(item.message)
    }
  })

  it('rejects unsigned releases, archive hash mismatches, and unknown release files', () => {
    const root = temporaryRoot()
    const stage = stagePack(root)
    const output = join(root, 'release')
    const keys = keyPair(root)
    expect(build(stage, output).status).toBe(0)

    const unsigned = verifyRelease(output, keys.publicKey)
    expect(unsigned.status).not.toBe(0)
    expect(unsigned.stderr.toLowerCase()).toContain('signature')

    expect(signIndex(join(output, 'index.json'), keys.privateKey).status).toBe(0)
    const cleanOutput = join(root, 'clean-release')
    expect(build(stage, cleanOutput).status).toBe(0)
    expect(signIndex(join(cleanOutput, 'index.json'), keys.privateKey).status).toBe(0)
    writeFileSync(join(cleanOutput, 'unexpected-engine'), 'unsigned engine')
    const unknown = verifyRelease(cleanOutput, keys.publicKey)
    expect(unknown.status).not.toBe(0)
    expect(unknown.stderr.toLowerCase()).toContain('unexpected')

    const index = JSON.parse(readFileSync(join(output, 'index.json'), 'utf8')) as { packs: Array<{ archiveUrl: string }> }
    const archiveFile = basename(new URL(index.packs[0]!.archiveUrl).pathname)
    const archive = readFileSync(join(output, archiveFile))
    archive[archive.byteLength - 1] ^= 1
    writeFileSync(join(output, archiveFile), archive)
    const mismatched = verifyRelease(output, keys.publicKey)
    expect(mismatched.status).not.toBe(0)
    expect(mismatched.stderr).toContain('hash')
    expect(basename(keys.privateKey)).not.toBe('index.sig')
  })

  it('rejects a correctly hashed and signed archive with an unsafe entry name', () => {
    const root = temporaryRoot()
    const stage = stagePack(root)
    const output = join(root, 'unsafe-release')
    const keys = keyPair(root)
    expect(build(stage, output).status).toBe(0)
    const indexPath = join(output, 'index.json')
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as {
      packs: Array<{ archiveUrl: string; archiveSha256: string }>
    }
    const archivePath = join(output, basename(new URL(index.packs[0]!.archiveUrl).pathname))
    const archive = readFileSync(archivePath)
    archive.fill(0, 0, 100)
    Buffer.from('../escape').copy(archive, 0)
    archive.fill(0x20, 148, 156)
    const checksum = archive.subarray(0, 512).reduce((sum, value) => sum + value, 0)
    Buffer.from(`${checksum.toString(8).padStart(6, '0')}\0 `).copy(archive, 148)
    writeFileSync(archivePath, archive)
    index.packs[0]!.archiveSha256 = createHash('sha256').update(archive).digest('hex')
    writeFileSync(indexPath, canonicalJson(index))
    expect(signIndex(indexPath, keys.privateKey).status).toBe(0)

    const result = verifyRelease(output, keys.publicKey)
    expect(result.status).not.toBe(0)
    expect(result.stderr.toLowerCase()).toContain('unsafe')
  })

  it('rejects signed archive, entry, and expanded sizes beyond the runtime limits before reading payloads', () => {
    for (const mutate of [
      (index: { packs: Array<{ archiveBytes: number }> }) => { index.packs[0]!.archiveBytes = 512 * 1024 * 1024 + 1 },
      (index: { packs: Array<{ entries: Array<{ bytes: number }> }> }) => { index.packs[0]!.entries[0]!.bytes = 1024 * 1024 * 1024 + 1 },
    ]) {
      const root = temporaryRoot()
      const stage = stagePack(root)
      const output = join(root, 'oversized-release')
      const keys = keyPair(root)
      expect(build(stage, output).status).toBe(0)
      const indexPath = join(output, 'index.json')
      const index = JSON.parse(readFileSync(indexPath, 'utf8'))
      mutate(index)
      const canonical = canonicalJson(index)
      writeFileSync(indexPath, canonical)
      writeFileSync(join(output, 'index.sig'), signBytes(null, Buffer.from(canonical), readFileSync(keys.privateKey)).toString('base64'))

      const result = verifyRelease(output, keys.publicKey)
      expect(result.status).not.toBe(0)
      expect(result.stderr.toLowerCase()).toContain('signed index is invalid')
    }
  })

  it('defaults to the exact 8-coordinate first-release inventory and accepts subsets only in explicit test mode', () => {
    const subsetRoot = temporaryRoot()
    const subsetStage = stagePack(subsetRoot)
    const defaultProduction = run(buildScript, [
      '--input', subsetStage,
      '--output', join(subsetRoot, 'default-production'),
    ])
    expect(defaultProduction.status).not.toBe(0)
    expect(defaultProduction.stderr.toLowerCase()).toContain('production')
    const explicitProduction = build(subsetStage, join(subsetRoot, 'explicit-production'), 'production')
    expect(explicitProduction.status).not.toBe(0)
    expect(explicitProduction.stderr.toLowerCase()).toContain('production')

    const fixtureRelease = join(subsetRoot, 'test-release')
    const fixtureKeys = keyPair(subsetRoot)
    expect(build(subsetStage, fixtureRelease, 'test').status).toBe(0)
    expect(signIndex(join(fixtureRelease, 'index.json'), fixtureKeys.privateKey, 'test').status).toBe(0)
    expect(verifyRelease(fixtureRelease, fixtureKeys.publicKey, 'test').status).toBe(0)

    const productionRoot = temporaryRoot()
    const productionStage = stageProduction(productionRoot)
    const productionRelease = join(productionRoot, 'release')
    const productionKeys = keyPair(productionRoot)
    expect(run(buildScript, ['--input', productionStage, '--output', productionRelease]).status).toBe(0)
    const index = JSON.parse(readFileSync(join(productionRelease, 'index.json'), 'utf8')) as { packs: unknown[] }
    expect(index.packs).toHaveLength(8)
    expect(run(signScript, ['--index', join(productionRelease, 'index.json'), '--private-key', productionKeys.privateKey]).status).toBe(0)
    expect(run(verifyScript, ['--root', productionRelease, '--public-key', productionKeys.publicKey]).status).toBe(0)

    const developmentPrivateKey = createPrivateKey({
      key: Buffer.from(
        '302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
        'hex',
      ),
      format: 'der',
      type: 'pkcs8',
    })
    const developmentPrivateKeyPath = join(productionRoot, 'development-private.pem')
    const developmentPublicKeyPath = join(desktopRoot, 'electron/main/conversion/fixtures/test-converter-root-public-key.pem')
    writeFileSync(developmentPrivateKeyPath, developmentPrivateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
    rmSync(join(productionRelease, 'index.sig'))
    const rejectedSignature = run(signScript, [
      '--index', join(productionRelease, 'index.json'), '--private-key', developmentPrivateKeyPath,
    ])
    expect(rejectedSignature.status).not.toBe(0)
    expect(rejectedSignature.stderr).toMatch(/development|test/iu)
    expect(existsSync(join(productionRelease, 'index.sig'))).toBe(false)

    const indexBytes = readFileSync(join(productionRelease, 'index.json'))
    writeFileSync(join(productionRelease, 'index.sig'), `${signBytes(null, indexBytes, developmentPrivateKey).toString('base64')}\n`)
    const rejectedRelease = verifyRelease(productionRelease, developmentPublicKeyPath, 'production')
    expect(rejectedRelease.status).not.toBe(0)
    expect(rejectedRelease.stderr).toMatch(/development|test/iu)
  })

  it('uses UTF-8 byte ordering and produces identical bytes under en_US and tr_TR locales', () => {
    const source = [buildScript, signScript, verifyScript, join(desktopRoot, 'scripts/converter-packs/pack-tooling-lib.mjs')]
      .map((path) => readFileSync(path, 'utf8')).join('\n')
    expect(source).not.toContain('localeCompare')

    const root = temporaryRoot()
    const stage = stagePack(root)
    const english = join(root, 'release-en')
    const turkish = join(root, 'release-tr')
    expect(build(stage, english, 'test', { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }).status).toBe(0)
    expect(build(stage, turkish, 'test', { ...process.env, LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8' }).status).toBe(0)
    expect(readFileSync(join(english, 'index.json'))).toEqual(readFileSync(join(turkish, 'index.json')))
    expect(readFileSync(join(english, 'media-1.0.0-darwin-arm64.tar')))
      .toEqual(readFileSync(join(turkish, 'media-1.0.0-darwin-arm64.tar')))
  })

  it('rejects hard-linked payload, key, index, signature, public-key, and archive inputs', () => {
    for (const relativePath of [
      'release.json',
      'packs/media-darwin-arm64/pack.json',
      'packs/media-darwin-arm64/payload/bin/ffmpeg',
      'packs/media-darwin-arm64/payload/LICENSES/ffmpeg.txt',
    ]) {
      const payloadRoot = temporaryRoot()
      const payloadStage = stagePack(payloadRoot)
      linkSync(join(payloadStage, relativePath), join(payloadRoot, `external-${basename(relativePath)}`))
      expect(build(payloadStage, join(payloadRoot, 'release')).status, relativePath).not.toBe(0)
    }

    const root = temporaryRoot()
    const stage = stagePack(root)
    const release = join(root, 'release')
    const keys = keyPair(root)
    expect(build(stage, release).status).toBe(0)
    linkSync(keys.privateKey, join(root, 'private-hardlink'))
    expect(signIndex(join(release, 'index.json'), keys.privateKey).status).not.toBe(0)

    const indexRoot = temporaryRoot()
    const indexStage = stagePack(indexRoot)
    const indexRelease = join(indexRoot, 'release')
    const indexKeys = keyPair(indexRoot)
    expect(build(indexStage, indexRelease).status).toBe(0)
    linkSync(join(indexRelease, 'index.json'), join(indexRoot, 'index-hardlink'))
    expect(signIndex(join(indexRelease, 'index.json'), indexKeys.privateKey).status).not.toBe(0)

    const verifyRoot = temporaryRoot()
    const verifyStage = stagePack(verifyRoot)
    const verifyOutput = join(verifyRoot, 'release')
    const verifyKeys = keyPair(verifyRoot)
    expect(build(verifyStage, verifyOutput).status).toBe(0)
    expect(signIndex(join(verifyOutput, 'index.json'), verifyKeys.privateKey).status).toBe(0)
    const index = JSON.parse(readFileSync(join(verifyOutput, 'index.json'), 'utf8')) as { packs: Array<{ archiveUrl: string }> }
    const archive = join(verifyOutput, basename(new URL(index.packs[0]!.archiveUrl).pathname))
    linkSync(archive, join(verifyRoot, 'archive-hardlink'))
    expect(verifyRelease(verifyOutput, verifyKeys.publicKey).status).not.toBe(0)
    rmSync(join(verifyRoot, 'archive-hardlink'))
    linkSync(join(verifyOutput, 'index.sig'), join(verifyRoot, 'signature-hardlink'))
    expect(verifyRelease(verifyOutput, verifyKeys.publicKey).status).not.toBe(0)
    rmSync(join(verifyRoot, 'signature-hardlink'))
    linkSync(verifyKeys.publicKey, join(verifyRoot, 'public-hardlink'))
    expect(verifyRelease(verifyOutput, verifyKeys.publicKey).status).not.toBe(0)
  })

  it('detects a path swap after opening a no-follow regular-file handle', () => {
    const root = temporaryRoot()
    const path = join(root, 'input.txt')
    writeFileSync(path, 'original')
    const modulePath = join(desktopRoot, 'scripts/converter-packs/pack-tooling-lib.mjs')
    const program = `
      import { rename, writeFile } from 'node:fs/promises';
      import { withStableRegularFile } from ${JSON.stringify(`file://${modulePath}`)};
      const path = ${JSON.stringify(path)};
      await withStableRegularFile(path, 'Swap fixture', async (handle) => {
        await rename(path, path + '.original');
        await writeFile(path, 'replacement');
        return handle.readFile();
      });
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', program], { encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(result.stderr.toLowerCase()).toContain('changed while reading')
  })

  it('uses target-aware Windows paths/modes and rejects disguised launchable or library code', () => {
    const modulePath = join(desktopRoot, 'scripts/converter-packs/pack-tooling-lib.mjs')
    const program = `
      import { isPathInsideRoot, isSafeAbsolutePathForPlatform } from ${JSON.stringify(`file://${modulePath}`)};
      const result = [
        isSafeAbsolutePathForPlatform('C:\\\\packs\\\\release', 'win32'),
        isSafeAbsolutePathForPlatform('\\\\\\\\server\\\\share\\\\release', 'win32'),
        isSafeAbsolutePathForPlatform('C:relative', 'win32'),
        isSafeAbsolutePathForPlatform('\\\\rooted-without-volume', 'win32'),
        isSafeAbsolutePathForPlatform('\\\\\\\\?\\\\C:\\\\device', 'win32'),
        isPathInsideRoot('C:\\\\packs\\\\release', 'c:\\\\packs\\\\release\\\\media\\\\bin\\\\ffmpeg.exe', 'win32'),
        isPathInsideRoot('C:\\\\packs\\\\release', 'C:\\\\packs-escape\\\\ffmpeg.exe', 'win32'),
        isPathInsideRoot('C:\\\\packs\\\\release', 'D:\\\\packs\\\\release\\\\ffmpeg.exe', 'win32'),
        isPathInsideRoot('\\\\\\\\server\\\\share\\\\release', '\\\\\\\\SERVER\\\\SHARE\\\\release\\\\media\\\\ffmpeg.exe', 'win32'),
        isPathInsideRoot('\\\\\\\\server\\\\share\\\\release', '\\\\\\\\server\\\\other\\\\release\\\\ffmpeg.exe', 'win32'),
      ];
      if (JSON.stringify(result) !== JSON.stringify([true, true, false, false, false, true, false, false, true, false])) process.exit(2);
    `
    expect(spawnSync(process.execPath, ['--input-type=module', '--eval', program]).status).toBe(0)

    for (const [name, contents] of [
      ['hidden.exe', 'MZ unsafe executable'],
      ['hidden.com', 'unsafe executable'],
      ['hidden.cmd', '@echo unsafe\r\n'],
      ['hidden.bat', '@echo unsafe\r\n'],
      ['hidden.ps1', 'exit 0\r\n'],
      ['hidden.scr', 'MZ unsafe executable'],
      ['hidden.msi', 'unsafe installer'],
      ['hidden.dll', 'MZ unsafe library'],
      ['hidden.dylib', 'unsafe library'],
      ['hidden.so', 'unsafe library'],
      ['hidden.node', 'unsafe native library'],
      ['hidden.hta', '<script>unsafe</script>'],
      ['hidden.vbs', 'WScript.Quit 0\r\n'],
      ['hidden.vbe', 'encoded script'],
      ['hidden.js', 'process.exit(0)\n'],
      ['hidden.jse', 'encoded script'],
      ['hidden.wsf', '<job/>'],
      ['hidden.wsh', '[ScriptFile]\r\n'],
      ['hidden.cpl', 'MZ unsafe control panel'],
      ['hidden.lnk', 'unsafe shortcut'],
      ['hidden.reg', 'Windows Registry Editor Version 5.00\r\n'],
      ['hidden.url', '[InternetShortcut]\r\nURL=https://example.test\r\n'],
      ['hidden.sh', '#!/bin/sh\nexit 0\n'],
      ['hidden-script', '#!/bin/sh\nexit 0\n'],
    ] as const) {
      const root = temporaryRoot()
      const stage = stagePack(root)
      const payload = join(stage, 'packs/media-darwin-arm64/payload')
      writeFileSync(join(payload, name), contents)
      const manifestPath = join(stage, 'packs/media-darwin-arm64/pack.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files: Array<{ path: string; role: string }> }
      manifest.files.push({ path: name, role: 'data' })
      writeFileSync(manifestPath, JSON.stringify(manifest))
      const result = build(stage, join(root, 'release'))
      expect(result.status, name).not.toBe(0)
      expect(result.stderr.toLowerCase(), name).toContain('code')
    }

    const windowsRoot = temporaryRoot()
    const windows = stageWindowsPack(windowsRoot)
    chmodSync(join(windows, 'packs/media-win32-x64/payload/bin/ffmpeg.exe'), 0o755)
    chmodSync(join(windows, 'packs/media-win32-x64/payload/LICENSES/ffmpeg.txt'), 0o600)
    expect(build(windows, join(windowsRoot, 'release'), 'test').status).toBe(0)

    const unsafeWindowsRoot = temporaryRoot()
    const unsafeWindows = stageWindowsPack(unsafeWindowsRoot)
    writeFileSync(join(unsafeWindows, 'packs/media-win32-x64/payload/hidden.dll'), 'unsafe library')
    const manifestPath = join(unsafeWindows, 'packs/media-win32-x64/pack.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files: Array<{ path: string; role: string }> }
    manifest.files.push({ path: 'hidden.dll', role: 'data' })
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const unsafeWindowsResult = build(unsafeWindows, join(unsafeWindowsRoot, 'release'), 'test')
    expect(unsafeWindowsResult.status).not.toBe(0)
    expect(unsafeWindowsResult.stderr.toLowerCase()).toContain('code')
  })

  it('verifies canonical package metadata and recursively rejects engines, archives, signatures, tests, e2e, stale paths, or disguised private keys', () => {
    for (const [platform, arch] of [['darwin', 'arm64'], ['darwin', 'x64']] as const) {
      const root = temporaryRoot()
      const fixture = packagedApp(root, platform)
      const result = run(verifyScript, ['--packaged-app', fixture.app, '--platform', platform, '--arch', arch])
      expect(result.status, `${platform}-${arch}: ${result.stderr}`).toBe(0)
    }

    const excludedWindowsRoot = temporaryRoot()
    const excludedWindows = packagedApp(excludedWindowsRoot, 'win32')
    const excludedWindowsResult = run(verifyScript, [
      '--packaged-app', excludedWindows.app, '--platform', 'win32', '--arch', 'x64',
    ])
    expect(excludedWindowsResult.status).not.toBe(0)
    expect(excludedWindowsResult.stderr.toLowerCase()).toContain('first-release')

    const invalidTargetRoot = temporaryRoot()
    const invalidTarget = packagedApp(invalidTargetRoot, 'win32')
    expect(run(verifyScript, ['--packaged-app', invalidTarget.app, '--platform', 'win32', '--arch', 'arm64']).status).not.toBe(0)

    const alteredRoot = temporaryRoot()
    const altered = packagedApp(alteredRoot, 'darwin')
    writeFileSync(join(altered.converter, 'index.schema.json'), '{}')
    const alteredResult = run(verifyScript, ['--packaged-app', altered.app, '--platform', 'darwin', '--arch', 'arm64'])
    expect(alteredResult.status).not.toBe(0)
    expect(alteredResult.stderr.toLowerCase()).toContain('canonical')

    for (const [name, files, message] of [
      ['private material', { 'assets/harmless.dat': Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----\nsecret') }, 'private'],
      ['encrypted private material', { 'assets/also-harmless.dat': Buffer.from('-----BEGIN ENCRYPTED PRIVATE KEY-----\nsecret') }, 'private'],
      ['engine', { 'assets/ffmpeg': Buffer.from('unsigned engine') }, 'engine'],
      ['archive', { 'assets/old-pack.zip': Buffer.from('unsigned archive') }, 'archive'],
      ['signature', { 'assets/index.sig': Buffer.from('unsigned signature') }, 'signature'],
      ['test path', { 'tests/helper.js': Buffer.from('test') }, 'test'],
      ['e2e path', { 'e2e/run.js': Buffer.from('e2e') }, 'e2e'],
      ['stale path', { 'stale/old-output.js': Buffer.from('stale') }, 'stale'],
    ] as const) {
      const root = temporaryRoot()
      const fixture = packagedApp(root, 'darwin', files)
      const result = run(verifyScript, ['--packaged-app', fixture.app, '--platform', 'darwin', '--arch', 'arm64'])
      expect(result.status, name).not.toBe(0)
      expect(result.stderr.toLowerCase(), name).toContain(message)
    }

    const privateKey = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' })
    const derRoot = temporaryRoot()
    const derFixture = packagedApp(derRoot, 'darwin', { 'assets/harmless.dat': privateKey })
    const derResult = run(verifyScript, ['--packaged-app', derFixture.app, '--platform', 'darwin', '--arch', 'arm64'])
    expect(derResult.status).not.toBe(0)
    expect(derResult.stderr.toLowerCase()).toContain('private')
    expect(`${derResult.stdout}${derResult.stderr}`).not.toContain(privateKey.toString('hex'))

    for (const [name, relativePath, message] of [
      ['root engine', 'ffmpeg.exe', 'engine'],
      ['root archive', 'old-pack.tar', 'archive'],
      ['root signature', 'index.sig', 'signature'],
      ['root test', 'tests/helper.js', 'test'],
      ['root e2e', 'e2e/run.js', 'e2e'],
      ['root stale', 'stale/old-output.js', 'stale'],
    ] as const) {
      const root = temporaryRoot()
      const fixture = packagedApp(root, 'darwin')
      const segments = relativePath.split('/')
      if (segments.length > 1) mkdirSync(join(fixture.app, ...segments.slice(0, -1)), { recursive: true })
      writeFileSync(join(fixture.app, ...segments), 'forbidden material')
      const result = run(verifyScript, ['--packaged-app', fixture.app, '--platform', 'darwin', '--arch', 'arm64'])
      expect(result.status, name).not.toBe(0)
      expect(result.stderr.toLowerCase(), name).toContain(message)
    }

    const linkedRoot = temporaryRoot()
    const linkedFixture = packagedApp(linkedRoot, 'darwin')
    const outside = join(linkedRoot, 'outside-runtime.bin')
    writeFileSync(outside, 'external material')
    symlinkSync(outside, join(linkedFixture.app, 'harmless-runtime'))
    const linkedResult = run(verifyScript, ['--packaged-app', linkedFixture.app, '--platform', 'darwin', '--arch', 'arm64'])
    expect(linkedResult.status).not.toBe(0)
    expect(linkedResult.stderr.toLowerCase()).toContain('symbolic')
  })

  it.each(['prefix', 'trailer'] as const)('rejects unindexed ASAR %s bytes containing a DER private key', (placement) => {
    const root = temporaryRoot()
    const fixture = packagedApp(root, 'darwin')
    const privateKey = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' })
    createAsar(join(fixture.resources, 'app.asar'), { 'package.json': Buffer.from('{}') }, {
      ...(placement === 'prefix' ? { unindexedPrefix: privateKey } : { unindexedTrailer: privateKey }),
    })
    const result = run(verifyScript, [
      '--packaged-app', fixture.app, '--platform', 'darwin', '--arch', 'arm64',
    ])
    expect(result.status).not.toBe(0)
    expect(result.stderr.toLowerCase()).toContain('extent')
    expect(`${result.stdout}${result.stderr}`).not.toContain(privateKey.toString('hex'))
  })

  it.each([
    ['oversized zero header slack', { headerSlack: Buffer.alloc(4) }],
    ['nonzero alignment padding', { nonzeroPadding: true }],
  ] as const)('rejects noncanonical ASAR %s', (_label, options) => {
    const root = temporaryRoot()
    const fixture = packagedApp(root, 'darwin')
    createAsar(join(fixture.resources, 'app.asar'), { 'package.json': Buffer.from('{}') }, options)
    const result = run(verifyScript, [
      '--packaged-app', fixture.app, '--platform', 'darwin', '--arch', 'arm64',
    ])
    expect(result.status).not.toBe(0)
    expect(result.stderr.toLowerCase()).toContain('header')
  })

  it('rejects a DER private key hidden in oversized ASAR header slack', () => {
    const root = temporaryRoot()
    const fixture = packagedApp(root, 'darwin')
    const privateKey = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' })
    const aligned = Buffer.alloc(Math.ceil(privateKey.byteLength / 4) * 4)
    privateKey.copy(aligned)
    createAsar(join(fixture.resources, 'app.asar'), { 'package.json': Buffer.from('{}') }, { headerSlack: aligned })
    const result = run(verifyScript, [
      '--packaged-app', fixture.app, '--platform', 'darwin', '--arch', 'arm64',
    ])
    expect(result.status).not.toBe(0)
    expect(result.stderr.toLowerCase()).toContain('header')
    expect(`${result.stdout}${result.stderr}`).not.toContain(privateKey.toString('hex'))
  })
})
