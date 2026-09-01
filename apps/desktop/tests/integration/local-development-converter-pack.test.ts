import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConverterPackManager } from '../../electron/main/conversion/converter-pack-manager.js'
import {
  createLocalDevelopmentConversionRuntimeFactory,
  loadLocalDevelopmentConverterRelease,
  selectConversionRuntimeFactory,
} from '../../electron/main/conversion/local-development-conversion-runtime.js'
import { renderMarkdownConversionDocument } from '../../electron/main/conversion/markdown-conversion-source.js'
import {
  createLocalDevelopmentImageRelease,
  replaceLocalDevelopmentImageRelease,
} from '../../scripts/converter-packs/create-local-development-image-release.mjs'

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

  it('does not follow a symbolic local cache root while replacing the generated release', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'autoforge-local-image-cache-')))
    roots.push(root)
    const cacheParent = join(root, 'node_modules', '.cache')
    const external = join(root, 'external')
    await mkdir(join(external, 'release'), { recursive: true })
    await mkdir(cacheParent, { recursive: true })
    const sentinel = join(external, 'release', 'sentinel.txt')
    await writeFile(sentinel, 'preserve me')
    await symlink(external, join(cacheParent, 'autoforge-converter-packs'))

    await expect(replaceLocalDevelopmentImageRelease({
      cacheParent,
      platform: 'darwin',
      arch: process.arch,
    })).rejects.toThrow(/symbolic|canonical|cache/iu)
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('preserve me')
  })

  it('rejects a symbolic installed directory', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'autoforge-local-image-installed-')))
    roots.push(root)
    const releaseRoot = join(root, 'release')
    const external = join(root, 'external-installed')
    await createLocalDevelopmentImageRelease({ output: releaseRoot, platform: 'darwin', arch: process.arch })
    await rm(join(releaseRoot, 'installed'), { recursive: true })
    await mkdir(external)
    await symlink(external, join(releaseRoot, 'installed'))

    await expect(loadLocalDevelopmentConverterRelease(releaseRoot)).rejects.toThrow(/installation/iu)
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

  it('converts PNG input to a single-page PDF through the pack executable', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'autoforge-local-image-pdf-pack-')))
    roots.push(root)
    const releaseRoot = join(root, 'release')
    await createLocalDevelopmentImageRelease({ output: releaseRoot, platform: 'darwin', arch: process.arch })
    const release = await loadLocalDevelopmentConverterRelease(releaseRoot)
    const manager = new ConverterPackManager({
      packsRoot: release.packsRoot,
      rootPublicKeyPem: release.rootPublicKeyPem,
      platform: 'darwin',
      arch: process.arch,
    })
    const lease = await manager.acquire({ signedIndex: release.signedIndex, name: 'image-icon' })
    const executable = lease.executables['bin/autoforge-image-converter']!
    const source = join(root, 'source.png')
    const output = join(root, 'output.pdf')
    await writeFile(source, Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ))

    const converted = spawnSync(executable, [
      'convert', '--input-format', 'png', '--output-format', 'pdf',
      '--output', output, '--', source,
    ])

    expect(converted.status, converted.stderr.toString()).toBe(0)
    expect((await readFile(output)).subarray(0, 5).toString('ascii')).toBe('%PDF-')
    lease.release()
  })

  it('converts rendered Markdown HTML to PDF through the signed document pack executable', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'autoforge-local-markdown-pdf-pack-')))
    roots.push(root)
    const releaseRoot = join(root, 'release')
    await createLocalDevelopmentImageRelease({ output: releaseRoot, platform: 'darwin', arch: process.arch })
    const release = await loadLocalDevelopmentConverterRelease(releaseRoot)
    const manager = new ConverterPackManager({
      packsRoot: release.packsRoot,
      rootPublicKeyPem: release.rootPublicKeyPem,
      platform: 'darwin',
      arch: process.arch,
    })
    const lease = await manager.acquire({ signedIndex: release.signedIndex, name: 'document' })
    const executable = lease.executables['program/soffice']!
    const source = join(root, 'source.html')
    const output = join(root, 'source.pdf')
    await writeFile(source, renderMarkdownConversionDocument('# AutoForge\n\n- Markdown to PDF\n- 中文内容\n'))
    const environment = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE

    const converted = spawnSync(executable, [
      `-env:UserInstallation=file://${join(root, 'profile')}`,
      '--headless', '--invisible', '--nologo', '--nodefault', '--nolockcheck', '--norestore',
      '--convert-to', 'pdf', '--outdir', root, '--', source,
    ], { env: environment })

    expect(converted.status, converted.stderr.toString()).toBe(0)
    expect((await readFile(output)).subarray(0, 5).toString('ascii')).toBe('%PDF-')
    lease.release()
  })

  it('binds the workflow runtime to the signed local release', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'autoforge-local-runtime-')))
    roots.push(root)
    const releaseRoot = join(root, 'release')
    await createLocalDevelopmentImageRelease({ output: releaseRoot, platform: 'darwin', arch: process.arch })
    const sourcePng = join(root, 'source.png')
    const source = join(root, 'source.jpg')
    const sourceMarkdown = join(root, 'source.markdown')
    await writeFile(sourcePng, Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ))
    expect(spawnSync('/usr/bin/sips', ['-s', 'format', 'jpeg', sourcePng, '--out', source]).status).toBe(0)
    const sourcePngBytes = await readFile(sourcePng)
    const sourceBytes = await readFile(source)
    await writeFile(sourceMarkdown, '# AutoForge\n\nMarkdown to PDF\n')
    const sourceMarkdownBytes = await readFile(sourceMarkdown)
    const batchOutput = join(root, 'batch-output.png')
    const batchPdfOutput = join(root, 'batch-output.pdf')
    await writeFile(batchOutput, Buffer.alloc(0), { mode: 0o600 })
    await writeFile(batchPdfOutput, Buffer.alloc(0), { mode: 0o600 })
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
          getOwned: (id) => {
            const png = id === 'source-png'
            const markdown = id === 'source-markdown'
            const bytes = markdown ? sourceMarkdownBytes : png ? sourcePngBytes : sourceBytes
            return {
              id, ownerUserId: 'alice', executionId: 'execution', conversionJobId: null,
              role: 'input' as const, displayName: markdown ? 'source.md' : png ? 'source.png' : 'source.jpg',
              detectedFormat: markdown ? 'markdown' as const : png ? 'png' as const : 'jpeg' as const,
              mimeType: markdown ? 'text/markdown' : png ? 'image/png' : 'image/jpeg', byteSize: bytes.byteLength,
              sha256: createHash('sha256').update(bytes).digest('hex'), relativePath: markdown
                ? 'source.markdown'
                : png ? 'source.png' : 'source.jpg', status: 'ready' as const,
              metadata: null, createdAt: 0,
            }
          },
          create: () => { throw new Error('unexpected create') },
          createBatch: () => { throw new Error('unexpected createBatch') },
        },
      },
      artifacts: {
        resolveOwnedInput: async (input) => {
          const png = input.displayName === 'source.png'
          const markdown = input.displayName === 'source.md'
          const selectedSource = markdown ? sourceMarkdown : png ? sourcePng : source
          const sourceHandle = await open(selectedSource, 'r')
          return {
            handle: sourceHandle,
            mainPath: selectedSource,
            probe: markdown
              ? { kind: 'file' as const, format: 'markdown' as const, frameCount: 1 }
              : { kind: 'image' as const, format: png ? 'png' as const : 'jpeg' as const, width: 1, height: 1, frameCount: 1 },
            close: async () => { await sourceHandle.close() },
          }
        },
        createOutputWriter: async () => { throw new Error('unexpected createOutputWriter') },
        createOutputBatch: async (outputs) => ({
          atomicJobCompletion: true,
          outputs: [{ tempPath: outputs[0]?.targetFormat === 'pdf' ? batchPdfOutput : batchOutput }],
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
    const markdownJob = {
      ...job, id: 'markdown-to-pdf-job', sourceId: 'source-markdown', targetFormat: 'pdf',
    } as const
    const documentLease = await binding.runtime.acquirePack(markdownJob, controller.signal)
    const documentAttempt = await binding.runtime.prepare(markdownJob, documentLease, controller.signal)
    await documentAttempt.execute({ signal: controller.signal, onProgress: () => true })
    expect(documentLease.name).toBe('document')
    expect((await readFile(batchPdfOutput)).subarray(0, 5).toString('ascii')).toBe('%PDF-')
    await documentAttempt.abort()
    documentLease.release()
    const pdfLease = await binding.runtime.acquirePack(
      { ...job, id: 'png-to-pdf-job', sourceId: 'source-png', targetFormat: 'pdf' },
      controller.signal,
    )
    expect(pdfLease.name).toBe('image-icon')
    pdfLease.release()
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
