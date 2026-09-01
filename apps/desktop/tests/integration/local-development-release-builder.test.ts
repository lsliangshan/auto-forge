import { generateKeyPairSync, verify } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  buildLocalDevelopmentRelease,
  verifyLocalDevelopmentReleaseIntegrity,
} from '../../scripts/converter-packs/build-local-development-release.mjs'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'autoforge-local-release-')))
  temporaryRoots.push(root)
  return root
}

const executables = {
  'image-icon': ['bin/autoforge-image-converter', 'bin/vips'],
  document: ['program/soffice'],
  pdf: ['bin/autoforge-pdf-raster', 'bin/pdfinfo', 'bin/pdftocairo'],
  media: ['bin/ffmpeg', 'bin/ffprobe'],
} as const

async function stagingFixture(root: string, arch: 'arm64' | 'x64' = 'arm64') {
  const stagingRoot = join(root, 'staging')
  await mkdir(join(stagingRoot, 'packs'), { recursive: true })
  writeFileSync(join(stagingRoot, 'release.json'), JSON.stringify({
    schemaVersion: 1,
    generatedAt: '2026-09-01T00:00:00.000Z',
    sequence: 1,
  }))
  for (const [family, paths] of Object.entries(executables)) {
    const pack = join(stagingRoot, 'packs', `${family}-darwin-${arch}`)
    const payload = join(pack, 'payload')
    const licensePath = `LICENSES/${family}.txt`
    for (const path of paths) {
      const output = join(payload, ...path.split('/'))
      await mkdir(join(output, '..'), { recursive: true })
      writeFileSync(output, '#!/bin/sh\nexit 0\n')
      chmodSync(output, 0o755)
    }
    await mkdir(join(payload, 'LICENSES'), { recursive: true })
    writeFileSync(join(payload, licensePath), `${family} fixture license\n`)
    writeFileSync(join(pack, 'pack.json'), JSON.stringify({
      schemaVersion: 1,
      name: family,
      version: '1.0.0',
      platform: 'darwin',
      arch,
      archiveUrl: `https://packs.example.test/${family}-1.0.0-darwin-${arch}.tar`,
      files: [...paths.map((path) => ({ path, role: 'executable' })), { path: licensePath, role: 'license' }],
    }))
  }
  return stagingRoot
}

function keyPair(root: string) {
  const pair = generateKeyPairSync('ed25519')
  const privateKeyPath = join(root, 'private.pem')
  const publicKeyPath = join(root, 'public.pem')
  writeFileSync(privateKeyPath, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }))
  writeFileSync(publicKeyPath, pair.publicKey.export({ format: 'pem', type: 'spki' }))
  chmodSync(privateKeyPath, 0o600)
  return { privateKeyPath, publicKeyPath, publicKey: pair.publicKey }
}

function replaceDirectoryWithSymlink(path: string, root: string) {
  const target = join(root, `outside-${path.split('/').at(-1)}`)
  mkdirSync(target)
  rmSync(path, { recursive: true, force: true })
  symlinkSync(target, path)
}

it('builds and verifies a signed four-family darwin-arm64 installed development release', async () => {
  const root = temporaryRoot()
  const stagingRoot = await stagingFixture(root)
  const outputRoot = join(root, 'release')
  const keys = keyPair(root)

  await buildLocalDevelopmentRelease({ stagingRoot, outputRoot, platform: 'darwin', arch: 'arm64', ...keys })

  const index = JSON.parse(readFileSync(join(outputRoot, 'index.json'), 'utf8')) as { packs: Array<{ name: string; version: string }> }
  expect(index.packs).toHaveLength(4)
  expect(verify(null, readFileSync(join(outputRoot, 'index.json')), keys.publicKey, Buffer.from(readFileSync(join(outputRoot, 'index.sig'), 'utf8').trim(), 'base64'))).toBe(true)
  for (const descriptor of index.packs) {
    expect(existsSync(join(outputRoot, 'installed', descriptor.name, descriptor.version, 'darwin-arm64'))).toBe(true)
  }
  expect((await readdir(outputRoot)).sort()).toEqual(['index.json', 'index.sig', 'installed', 'root-public-key.pem'])
  expect(statSync(join(outputRoot, 'installed', 'media', '1.0.0', 'darwin-arm64', 'bin', 'ffmpeg')).mode & 0o777).toBe(0o755)
  await expect(verifyLocalDevelopmentReleaseIntegrity({ releaseRoot: outputRoot, platform: 'darwin', arch: 'arm64' })).resolves.toBeUndefined()
})

it('builds and verifies a signed four-family darwin-x64 installed development release', async () => {
  const root = temporaryRoot()
  const outputRoot = join(root, 'release')
  const keys = keyPair(root)

  await buildLocalDevelopmentRelease({
    stagingRoot: await stagingFixture(root, 'x64'), outputRoot, platform: 'darwin', arch: 'x64', ...keys,
  })

  expect(existsSync(join(outputRoot, 'installed', 'media', '1.0.0', 'darwin-x64'))).toBe(true)
  await expect(verifyLocalDevelopmentReleaseIntegrity({ releaseRoot: outputRoot, platform: 'darwin', arch: 'x64' })).resolves.toBeUndefined()
})

it.each([
  ['an extra top-level file', (release: string) => writeFileSync(join(release, 'extra.txt'), 'extra'), { platform: 'darwin', arch: 'arm64' }],
  ['an extra installed file', (release: string) => writeFileSync(join(release, 'installed', 'media', '1.0.0', 'darwin-arm64', 'extra.txt'), 'extra'), { platform: 'darwin', arch: 'arm64' }],
  ['an installed-root symlink', (release: string, root: string) => replaceDirectoryWithSymlink(join(release, 'installed'), root), { platform: 'darwin', arch: 'arm64' }],
  ['an installed-family symlink', (release: string, root: string) => replaceDirectoryWithSymlink(join(release, 'installed', 'media'), root), { platform: 'darwin', arch: 'arm64' }],
  ['an installed-version symlink', (release: string, root: string) => replaceDirectoryWithSymlink(join(release, 'installed', 'media', '1.0.0'), root), { platform: 'darwin', arch: 'arm64' }],
  ['an installed-coordinate symlink', (release: string, root: string) => replaceDirectoryWithSymlink(join(release, 'installed', 'media', '1.0.0', 'darwin-arm64'), root), { platform: 'darwin', arch: 'arm64' }],
  ['a wrong target', () => undefined, { platform: 'darwin', arch: 'x64' }],
  ['a mismatched signature', (release: string) => writeFileSync(join(release, 'index.sig'), 'AAAA\n'), { platform: 'darwin', arch: 'arm64' }],
  ['a mismatched public key', (release: string, root: string) => writeFileSync(join(release, 'root-public-key.pem'), keyPair(root).publicKey.export({ format: 'pem', type: 'spki' })), { platform: 'darwin', arch: 'arm64' }],
  ['a tampered entry hash', (release: string) => writeFileSync(join(release, 'installed', 'media', '1.0.0', 'darwin-arm64', 'bin', 'ffmpeg'), 'tampered'), { platform: 'darwin', arch: 'arm64' }],
  ['a tampered entry mode', (release: string) => chmodSync(join(release, 'installed', 'media', '1.0.0', 'darwin-arm64', 'bin', 'ffmpeg'), 0o644), { platform: 'darwin', arch: 'arm64' }],
])('fails closed for %s', async (_name, mutate, target) => {
  const root = temporaryRoot()
  const keys = keyPair(root)
  const release = join(root, 'release')
  await buildLocalDevelopmentRelease({ stagingRoot: await stagingFixture(root), outputRoot: release, platform: 'darwin', arch: 'arm64', ...keys })
  mutate(release, root)
  await expect(verifyLocalDevelopmentReleaseIntegrity({ releaseRoot: release, ...target })).rejects.toThrow()
})
