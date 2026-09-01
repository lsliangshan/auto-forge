import { generateKeyPairSync, verify } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

async function stagingFixture(root: string) {
  const stagingRoot = join(root, 'staging')
  await mkdir(join(stagingRoot, 'packs'), { recursive: true })
  writeFileSync(join(stagingRoot, 'release.json'), JSON.stringify({
    schemaVersion: 1,
    generatedAt: '2026-09-01T00:00:00.000Z',
    sequence: 1,
  }))
  for (const [family, paths] of Object.entries(executables)) {
    const pack = join(stagingRoot, 'packs', `${family}-darwin-arm64`)
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
      arch: 'arm64',
      archiveUrl: `https://packs.example.test/${family}-1.0.0-darwin-arm64.tar`,
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

it('builds and verifies a signed four-family darwin-arm64 installed development release', async () => {
  const root = temporaryRoot()
  const stagingRoot = await stagingFixture(root)
  const outputRoot = join(root, 'release')
  const keys = keyPair(root)

  await buildLocalDevelopmentRelease({ stagingRoot, outputRoot, ...keys })

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
