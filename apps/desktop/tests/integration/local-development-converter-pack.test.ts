import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmod, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConversionTargetFormat } from '@autoforge/shared'
import type { ProbedConversionInput } from '../../electron/main/conversion/conversion-catalog.js'
import {
  createLocalDevelopmentConversionRuntimeFactory,
  selectConversionRuntimeFactory,
} from '../../electron/main/conversion/local-development-conversion-runtime.js'
import { buildLocalDevelopmentRelease } from '../../scripts/converter-packs/build-local-development-release.mjs'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const packExecutables = {
  'image-icon': ['bin/autoforge-image-converter', 'bin/vips'],
  document: ['program/soffice'],
  pdf: ['bin/autoforge-pdf-raster', 'bin/pdfinfo', 'bin/pdftocairo'],
  media: ['bin/ffmpeg', 'bin/ffprobe'],
} as const

async function createSignedFourFamilyRelease(root: string): Promise<string> {
  const stagingRoot = join(root, 'staging')
  await mkdir(join(stagingRoot, 'packs'), { recursive: true })
  await writeFile(join(stagingRoot, 'release.json'), JSON.stringify({
    schemaVersion: 1,
    generatedAt: '2026-09-01T00:00:00.000Z',
    sequence: 1,
  }))
  for (const [family, paths] of Object.entries(packExecutables)) {
    const pack = join(stagingRoot, 'packs', `${family}-darwin-arm64`)
    const payload = join(pack, 'payload')
    const licensePath = `LICENSES/${family}.txt`
    for (const path of paths) {
      const executable = join(payload, ...path.split('/'))
      await mkdir(join(executable, '..'), { recursive: true })
      await writeFile(executable, '#!/bin/sh\nexit 0\n')
      await chmod(executable, 0o755)
    }
    await mkdir(join(payload, 'LICENSES'), { recursive: true })
    await writeFile(join(payload, licensePath), `${family} fixture license\n`)
    await writeFile(join(pack, 'pack.json'), JSON.stringify({
      schemaVersion: 1,
      name: family,
      version: '1.0.0',
      platform: 'darwin',
      arch: 'arm64',
      archiveUrl: `https://packs.example.test/${family}-1.0.0-darwin-arm64.tar`,
      files: [...paths.map((path) => ({ path, role: 'executable' })), { path: licensePath, role: 'license' }],
    }))
  }
  const pair = generateKeyPairSync('ed25519')
  const privateKeyPath = join(root, 'private.pem')
  const publicKeyPath = join(root, 'public.pem')
  await writeFile(privateKeyPath, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }))
  await chmod(privateKeyPath, 0o600)
  await writeFile(publicKeyPath, pair.publicKey.export({ format: 'pem', type: 'spki' }))
  const releaseRoot = join(root, 'release')
  await buildLocalDevelopmentRelease({
    stagingRoot,
    outputRoot: releaseRoot,
    platform: 'darwin',
    arch: 'arm64',
    privateKeyPath,
    publicKeyPath,
  })
  return releaseRoot
}

const probes = {
  doc: { format: 'doc', mimeType: 'application/msword', kind: 'file', byteSize: 1, frameCount: 1 },
  csv: { format: 'csv', mimeType: 'text/csv', kind: 'file', byteSize: 1, frameCount: 1 },
  pdf: { format: 'pdf', mimeType: 'application/pdf', kind: 'file', byteSize: 1, frameCount: 1, pageCount: 1 },
  png: { format: 'png', mimeType: 'image/png', kind: 'image', byteSize: 1, frameCount: 1, width: 1, height: 1 },
  wav: { format: 'wav', mimeType: 'audio/wav', kind: 'audio', byteSize: 1, frameCount: 1 },
  mp4: { format: 'mp4', mimeType: 'video/mp4', kind: 'video', byteSize: 1, frameCount: 1 },
} as const satisfies Record<string, ProbedConversionInput>

describe.skipIf(process.platform !== 'darwin')('local development converter packs', () => {
  it('keeps the production trust root when a packaged app receives a development release root', () => {
    const production = async () => { throw new Error('production sentinel') }
    const development = async () => { throw new Error('development sentinel') }
    let developmentFactoryCalls = 0

    const selected = selectConversionRuntimeFactory({
      packaged: true,
      developmentReleaseRoot: '/tmp/untrusted-development-release',
      productionFactory: production,
      createDevelopmentFactory: () => {
        developmentFactoryCalls += 1
        return development
      },
    })

    expect(selected).toBe(production)
    expect(developmentFactoryCalls).toBe(0)
  })

  it('selects all four signed local converter packs for their owned routes', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'autoforge-local-converter-pack-')))
    roots.push(root)
    const releaseRoot = await createSignedFourFamilyRelease(root)
    const inputPath = join(root, 'source')
    const inputBytes = Buffer.from('fixture input')
    await writeFile(inputPath, inputBytes)
    const factory = createLocalDevelopmentConversionRuntimeFactory({
      releaseRoot,
      platform: 'darwin',
      arch: 'arm64',
    })
    const binding = await factory({
      ownerUserId: 'alice',
      dataRoot: root,
      packsRoot: join(root, 'unused-production-packs'),
      database: {
        conversionArtifacts: {
          getOwned: (id: string) => ({
            id,
            ownerUserId: 'alice',
            executionId: 'execution',
            conversionJobId: null,
            role: 'input' as const,
            displayName: `${id}.fixture`,
            detectedFormat: probes[id as keyof typeof probes].format,
            mimeType: probes[id as keyof typeof probes].mimeType,
            byteSize: inputBytes.byteLength,
            sha256: createHash('sha256').update(inputBytes).digest('hex'),
            relativePath: 'source',
            status: 'ready' as const,
            metadata: null,
            createdAt: 0,
          }),
        },
      } as never,
      artifacts: {
        resolveOwnedInput: async ({ displayName }: { displayName: string }) => {
          const id = displayName.split('.')[0] as keyof typeof probes
          const handle = await open(inputPath, 'r')
          return {
            handle,
            mainPath: inputPath,
            probe: probes[id],
            close: async () => { await handle.close() },
          }
        },
      } as never,
    })
    const controller = new AbortController()
    const acquire = async (input: keyof typeof probes, targetFormat: ConversionTargetFormat) => {
      const lease = await binding.runtime.acquirePack({
        id: `${input}-${targetFormat}`,
        ownerUserId: 'alice',
        executionId: 'execution',
        sourceKind: 'artifact',
        sourceId: input,
        targetFormat,
        preset: undefined,
        status: 'queued',
        progress: 0,
        epoch: 0,
        errorCode: null,
        createdAt: 0,
        startedAt: null,
        endedAt: null,
      }, controller.signal)
      lease.release()
      return lease
    }

    expect(await acquire('doc', 'pdf')).toMatchObject({ name: 'document' })
    expect(await acquire('csv', 'xlsx')).toMatchObject({ name: 'document' })
    expect(await acquire('pdf', 'png')).toMatchObject({ name: 'pdf' })
    expect(await acquire('png', 'ico')).toMatchObject({ name: 'image-icon' })
    expect(await acquire('wav', 'mp3')).toMatchObject({ name: 'media' })
    expect(await acquire('mp4', 'webm')).toMatchObject({ name: 'media' })
  })
})
