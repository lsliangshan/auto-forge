import { createHash, generateKeyPairSync, sign as signBytes } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

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

function run(script: string, args: readonly string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: desktopRoot })
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
    executables: ['bin/ffmpeg'],
    licenses: ['LICENSES/ffmpeg.txt'],
    ...overrides,
  }))
  return stage
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

describe('converter pack release tooling', () => {
  it('builds canonical archives and indexes byte-identically, signs with an explicit key, and verifies every hash', () => {
    const root = temporaryRoot()
    const stage = stagePack(root)
    const first = join(root, 'release-a')
    const second = join(root, 'release-b')
    const keys = keyPair(root)

    expect(run(buildScript, ['--input', stage, '--output', first])).toMatchObject({ status: 0 })
    expect(run(buildScript, ['--input', stage, '--output', second])).toMatchObject({ status: 0 })
    const firstIndex = readFileSync(join(first, 'index.json'))
    expect(firstIndex.equals(readFileSync(join(second, 'index.json')))).toBe(true)
    const index = JSON.parse(firstIndex.toString('utf8')) as { packs: Array<{ archiveUrl: string }> }
    expect(index.packs).toHaveLength(1)
    const archiveFile = basename(new URL(index.packs[0]!.archiveUrl).pathname)
    expect(readFileSync(join(first, archiveFile)).equals(readFileSync(join(second, archiveFile)))).toBe(true)

    const signed = run(signScript, ['--index', join(first, 'index.json'), '--private-key', keys.privateKey])
    expect(signed.status).toBe(0)
    expect(`${signed.stdout}${signed.stderr}`).not.toContain(keys.privateKey)
    const verified = run(verifyScript, ['--root', first, '--public-key', keys.publicKey])
    expect(verified.status).toBe(0)
    expect(verified.stdout).toContain('verified 1 signed converter pack')
  })

  it.each([
    [buildScript, ['--input', 'relative-stage', '--output', '/tmp/release']],
    [buildScript, ['--input', '/tmp/stage', '--output', 'relative-release']],
    [signScript, ['--index', 'relative-index.json', '--private-key', '/tmp/private.pem']],
    [signScript, ['--index', '/tmp/index.json', '--private-key', 'relative-private.pem']],
    [verifyScript, ['--root', 'relative-release', '--public-key', '/tmp/public.pem']],
    [verifyScript, ['--root', '/tmp/release', '--public-key', 'relative-public.pem']],
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
    const built = run(buildScript, ['--input', stage, '--output', join(root, 'release')])
    expect(built.status).not.toBe(0)
    expect(built.stderr).toContain('symbolic links')

    rmSync(join(stage, 'packs', 'media-darwin-arm64', 'payload', 'LICENSES', 'linked.txt'))
    const parentLink = join(root, 'linked-parent')
    symlinkSync(root, parentLink)
    const linkedParent = run(buildScript, [
      '--input', join(parentLink, 'stage'),
      '--output', join(root, 'release-linked-parent'),
    ])
    expect(linkedParent.status).not.toBe(0)
    expect(linkedParent.stderr).toContain('symbolic links')

    const output = join(root, 'release-valid')
    expect(run(buildScript, ['--input', stage, '--output', output]).status).toBe(0)
    const keys = keyPair(root)
    const keyLink = join(root, 'linked-private.pem')
    symlinkSync(keys.privateKey, keyLink)
    const signed = run(signScript, ['--index', join(output, 'index.json'), '--private-key', keyLink])
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
      const result = run(buildScript, ['--input', stage, '--output', join(root, 'release')])
      expect(result.status, item.name).not.toBe(0)
      expect(result.stderr.toLowerCase(), item.name).toContain(item.message)
    }
  })

  it('rejects unsigned releases, archive hash mismatches, and unknown release files', () => {
    const root = temporaryRoot()
    const stage = stagePack(root)
    const output = join(root, 'release')
    const keys = keyPair(root)
    expect(run(buildScript, ['--input', stage, '--output', output]).status).toBe(0)

    const unsigned = run(verifyScript, ['--root', output, '--public-key', keys.publicKey])
    expect(unsigned.status).not.toBe(0)
    expect(unsigned.stderr.toLowerCase()).toContain('signature')

    expect(run(signScript, ['--index', join(output, 'index.json'), '--private-key', keys.privateKey]).status).toBe(0)
    const cleanOutput = join(root, 'clean-release')
    expect(run(buildScript, ['--input', stage, '--output', cleanOutput]).status).toBe(0)
    expect(run(signScript, ['--index', join(cleanOutput, 'index.json'), '--private-key', keys.privateKey]).status).toBe(0)
    writeFileSync(join(cleanOutput, 'unexpected-engine'), 'unsigned engine')
    const unknown = run(verifyScript, ['--root', cleanOutput, '--public-key', keys.publicKey])
    expect(unknown.status).not.toBe(0)
    expect(unknown.stderr.toLowerCase()).toContain('unexpected')

    const index = JSON.parse(readFileSync(join(output, 'index.json'), 'utf8')) as { packs: Array<{ archiveUrl: string }> }
    const archiveFile = basename(new URL(index.packs[0]!.archiveUrl).pathname)
    const archive = readFileSync(join(output, archiveFile))
    archive[archive.byteLength - 1] ^= 1
    writeFileSync(join(output, archiveFile), archive)
    const mismatched = run(verifyScript, ['--root', output, '--public-key', keys.publicKey])
    expect(mismatched.status).not.toBe(0)
    expect(mismatched.stderr).toContain('hash')
    expect(basename(keys.privateKey)).not.toBe('index.sig')
  })

  it('rejects a correctly hashed and signed archive with an unsafe entry name', () => {
    const root = temporaryRoot()
    const stage = stagePack(root)
    const output = join(root, 'unsafe-release')
    const keys = keyPair(root)
    expect(run(buildScript, ['--input', stage, '--output', output]).status).toBe(0)
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
    expect(run(signScript, ['--index', indexPath, '--private-key', keys.privateKey]).status).toBe(0)

    const result = run(verifyScript, ['--root', output, '--public-key', keys.publicKey])
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
      expect(run(buildScript, ['--input', stage, '--output', output]).status).toBe(0)
      const indexPath = join(output, 'index.json')
      const index = JSON.parse(readFileSync(indexPath, 'utf8'))
      mutate(index)
      const canonical = canonicalJson(index)
      writeFileSync(indexPath, canonical)
      writeFileSync(join(output, 'index.sig'), signBytes(null, Buffer.from(canonical), readFileSync(keys.privateKey)).toString('base64'))

      const result = run(verifyScript, ['--root', output, '--public-key', keys.publicKey])
      expect(result.status).not.toBe(0)
      expect(result.stderr.toLowerCase()).toContain('signed index is invalid')
    }
  })
})
