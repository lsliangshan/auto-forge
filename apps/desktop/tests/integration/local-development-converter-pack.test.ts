import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConverterPackManager } from '../../electron/main/conversion/converter-pack-manager.js'
import {
  createLocalDevelopmentConversionRuntimeFactory,
  loadLocalDevelopmentConverterRelease,
  selectConversionRuntimeFactory,
} from '../../electron/main/conversion/local-development-conversion-runtime.js'
import { createLocalDevelopmentImageRelease } from '../../scripts/converter-packs/create-local-development-image-release.mjs'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe.skipIf(process.platform !== 'darwin')('local development image converter pack', () => {
  it('never selects a local release for a packaged application', () => {
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

  it('refuses to replace an existing output directory', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'autoforge-local-image-existing-')))
    roots.push(root)
    const sentinel = join(root, 'sentinel.txt')
    await writeFile(sentinel, 'preserve me')

    await expect(createLocalDevelopmentImageRelease({
      output: root,
      platform: 'darwin',
      arch: process.arch,
    })).rejects.toThrow(/exist|output/iu)
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('preserve me')
  })

  it('is signed, installed, and converts JPEG input to PNG through the pack executable', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'autoforge-local-image-pack-')))
    roots.push(root)
    const releaseRoot = join(root, 'release')
    await createLocalDevelopmentImageRelease({
      output: releaseRoot,
      platform: 'darwin',
      arch: process.arch,
    })

    const release = await loadLocalDevelopmentConverterRelease(releaseRoot)
    const manager = new ConverterPackManager({
      packsRoot: release.packsRoot,
      rootPublicKeyPem: release.rootPublicKeyPem,
      platform: 'darwin',
      arch: process.arch,
    })
    const lease = await manager.acquire({ signedIndex: release.signedIndex, name: 'image-icon' })
    const executable = lease.executables['bin/autoforge-image-converter']
    expect(executable).toBeTruthy()

    const sourcePng = join(root, 'source.png')
    const sourceJpeg = join(root, 'source.jpg')
    const outputPng = join(root, 'output.png')
    await writeFile(sourcePng, Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ))
    expect(spawnSync('/usr/bin/sips', ['-s', 'format', 'jpeg', sourcePng, '--out', sourceJpeg]).status).toBe(0)
    const converted = spawnSync(executable, [
      'convert', '--input-format', 'jpeg', '--output-format', 'png',
      '--output', outputPng, '--', sourceJpeg,
    ])

    expect(converted.status, converted.stderr.toString()).toBe(0)
    expect((await readFile(outputPng)).subarray(0, 8)).toEqual(Buffer.from('89504e470d0a1a0a', 'hex'))
    lease.release()
  })

  it('binds the workflow runtime to the signed local release', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'autoforge-local-runtime-')))
    roots.push(root)
    const releaseRoot = join(root, 'release')
    await createLocalDevelopmentImageRelease({ output: releaseRoot, platform: 'darwin', arch: process.arch })
    const sourcePng = join(root, 'source.png')
    const source = join(root, 'source.jpg')
    await writeFile(sourcePng, Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ))
    expect(spawnSync('/usr/bin/sips', ['-s', 'format', 'jpeg', sourcePng, '--out', source]).status).toBe(0)
    const sourceBytes = await readFile(source)
    const batchOutput = join(root, 'batch-output.png')
    await writeFile(batchOutput, Buffer.alloc(0), { mode: 0o600 })
    const factory = createLocalDevelopmentConversionRuntimeFactory({
      releaseRoot,
      platform: 'darwin',
      arch: process.arch,
    })
    const binding = await factory({
      ownerUserId: 'alice',
      dataRoot: root,
      packsRoot: join(root, 'unused-production-packs'),
      database: {
        conversations: { get: () => undefined },
        mediaAssets: { get: () => undefined },
        conversionArtifacts: {
          getOwned: () => ({
            id: 'source', ownerUserId: 'alice', executionId: 'execution', conversionJobId: null,
            role: 'input', displayName: 'source.jpg', detectedFormat: 'jpeg', mimeType: 'image/jpeg',
            byteSize: sourceBytes.byteLength, sha256: createHash('sha256').update(sourceBytes).digest('hex'),
            relativePath: 'source.jpg', status: 'ready',
            metadata: null, createdAt: 0,
          }),
          create: () => { throw new Error('unexpected create') },
          createBatch: () => { throw new Error('unexpected createBatch') },
        },
      },
      artifacts: {
        resolveOwnedInput: async () => {
          const sourceHandle = await open(source, 'r')
          return {
            handle: sourceHandle,
            mainPath: source,
            probe: { kind: 'image', format: 'jpeg', width: 1, height: 1, frameCount: 1 },
            close: async () => { await sourceHandle.close() },
          }
        },
        createOutputWriter: async () => { throw new Error('unexpected createOutputWriter') },
        createOutputBatch: async () => ({
          atomicJobCompletion: true,
          outputs: [{ tempPath: batchOutput }],
          commit: async () => [],
          abort: async () => undefined,
        }),
      },
    })
    const job = {
      id: 'job', ownerUserId: 'alice', executionId: 'execution', sourceKind: 'artifact', sourceId: 'source',
      targetFormat: 'png', preset: undefined, status: 'queued', progress: 0, epoch: 0,
      errorCode: null, createdAt: 0, startedAt: null, endedAt: null,
    } as const
    const controller = new AbortController()
    const lease = await binding.runtime.acquirePack(job, controller.signal)
    const attempt = await binding.runtime.prepare(job, lease, controller.signal)
    await attempt.execute({ signal: controller.signal, onProgress: () => true })

    expect(lease.name).toBe('image-icon')
    expect(lease.root.startsWith(join(releaseRoot, 'installed'))).toBe(true)
    expect((await readFile(batchOutput)).subarray(0, 8)).toEqual(Buffer.from('89504e470d0a1a0a', 'hex'))
    await attempt.abort()
    lease.release()
    await expect(binding.runtime.acquirePack(
      { ...job, id: 'unsupported-job', targetFormat: 'webp' },
      controller.signal,
    )).rejects.toMatchObject({ code: 'CONVERSION_FORMAT_UNSUPPORTED' })
    await expect(binding.runtime.acquirePack(
      { ...job, id: 'unsupported-direction-job', targetFormat: 'jpeg' },
      controller.signal,
    )).rejects.toMatchObject({ code: 'CONVERSION_FORMAT_UNSUPPORTED' })
  })
})
