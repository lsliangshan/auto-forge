import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openAppDatabase } from '../database/client.js'
import { resolveUserConversionRoot } from '../media/user-media-root.js'
import { createConversionArtifactService } from './conversion-artifact-service.js'
import { createConversionJobRunner } from './conversion-job-runner.js'
import type { ConversionProcessPlan, ConversionProcessRunner } from './conversion-process-runner.js'
import type { ConverterPackLease, ConverterPackName } from './converter-pack-types.js'
import {
  createProductionConversionJobRuntime,
  createProductionConversionRuntimeFactory,
} from './production-conversion-runtime.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data = Buffer.alloc(0)): Buffer {
  const typeBytes = Buffer.from(type)
  const header = Buffer.alloc(8)
  header.writeUInt32BE(data.byteLength)
  typeBytes.copy(header, 4)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])))
  return Buffer.concat([header, data, crc])
}

function png(width = 2, height = 3, fill = 0): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc((width * 4 + 1) * height, fill))),
    chunk('IEND'),
  ])
}

function pdf(pageCount: number): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pageCount} /Kids [${Array.from({ length: pageCount }, (_, index) => `${index + 3} 0 R`).join(' ')}] >>`,
    ...Array.from({ length: pageCount }, () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1 1] >>'),
  ]
  let body = '%PDF-1.7\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body))
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body)
}

function icns(): Buffer {
  const slots = [
    ['icp4', 16],
    ['ic11', 32],
    ['icp5', 32],
  ] as const
  const representations = slots.map(([type, size]) => {
    const image = png(size, size)
    const header = Buffer.alloc(8)
    header.write(type)
    header.writeUInt32BE(8 + image.byteLength, 4)
    return Buffer.concat([header, image])
  })
  const header = Buffer.alloc(8)
  header.write('icns')
  header.writeUInt32BE(8 + representations.reduce((total, value) => total + value.byteLength, 0), 4)
  return Buffer.concat([header, ...representations])
}

function icoWithDeduplicatedRepresentations(): Buffer {
  const first = png(16, 16)
  const payloads = [first, png(32, 32), Buffer.from(first), png(16, 16, 1)]
  const header = Buffer.alloc(6 + payloads.length * 16)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(payloads.length, 4)
  let offset = header.byteLength
  for (const [index, payload] of payloads.entries()) {
    const size = index === 1 ? 32 : 16
    const entry = 6 + index * 16
    header[entry] = size
    header[entry + 1] = size
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(payload.byteLength, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += payload.byteLength
  }
  return Buffer.concat([header, ...payloads])
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

async function fixture(input: {
  name: string
  mimeType: string
  format: 'pdf' | 'icns' | 'ico'
  bytes: Buffer
  invalidOutputIndex?: number
  processGate?: { started: { resolve(value: void): void }; release: Promise<void> }
  replaceInputBeforeProcess?: Buffer
}) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'autoforge-production-conversion-'))
  roots.push(dataRoot)
  const database = openAppDatabase(join(dataRoot, 'autoforge.sqlite'))
  database.executions.insert({
    id: 'execution', ownerUserId: 'alice', workflowId: 'file.convert.universal', workflowVersion: '1.0.0',
    status: 'running', createdAt: 1,
  })
  const ownerRoot = resolveUserConversionRoot(dataRoot, 'alice')
  await mkdir(join(ownerRoot, 'inputs'), { recursive: true })
  const relativePath = `inputs/source.${input.format}`
  await writeFile(join(ownerRoot, relativePath), input.bytes)
  database.conversionArtifacts.create({
    id: 'source', ownerUserId: 'alice', executionId: 'execution', role: 'input', displayName: input.name,
    detectedFormat: input.format, mimeType: input.mimeType, byteSize: input.bytes.byteLength,
    sha256: createHash('sha256').update(input.bytes).digest('hex'), relativePath,
  })
  const artifacts = createConversionArtifactService({
    dataRoot,
    database: {
      conversations: database.conversations,
      mediaAssets: database.mediaAssets,
      conversionArtifacts: database.conversionArtifacts,
      conversionJobs: database.conversionJobs,
    },
  })
  const packRoot = join(dataRoot, 'signed-pack')
  await mkdir(join(packRoot, 'bin'), { recursive: true })
  const executables = {
    pdf: join(packRoot, 'bin/autoforge-pdf-raster'),
    'image-icon': join(packRoot, 'bin/autoforge-image-converter'),
  } as const
  const observedProcessInputs: Buffer[] = []
  await Promise.all(Object.values(executables).map((path) => writeFile(path, 'signed executable')))
  const packManager = {
    async acquire({ name }: { name: ConverterPackName }): Promise<ConverterPackLease> {
      let leaseExecutables: Readonly<Record<string, string>>
      if (name === 'pdf') {
        leaseExecutables = Object.freeze({ 'bin/autoforge-pdf-raster': executables.pdf })
      } else {
        leaseExecutables = Object.freeze({ 'bin/autoforge-image-converter': executables['image-icon'] })
      }
      return {
        name, version: '1.0.0', platform: 'darwin', arch: 'arm64', root: packRoot,
        executables: leaseExecutables,
        release() {},
      }
    },
  }
  const processRunner: ConversionProcessRunner = {
    async run(plan: ConversionProcessPlan) {
      if (input.replaceInputBeforeProcess) {
        await rename(join(ownerRoot, relativePath), join(ownerRoot, `${relativePath}.validated`))
        await writeFile(join(ownerRoot, relativePath), input.replaceInputBeforeProcess)
        observedProcessInputs.push(await readFile(plan.args.at(-1)!))
      }
      for (const [index, output] of plan.outputs.entries()) {
        const representation = output.metadata?.iconRepresentation
        await writeFile(
          output.path,
          index === input.invalidOutputIndex
            ? Buffer.from('not a valid conversion output')
            : png(representation?.pixelWidth ?? index + 1, representation?.pixelHeight ?? index + 1),
        )
      }
      if (input.processGate) {
        input.processGate.started.resolve()
        await input.processGate.release
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  }
  const runtime = createProductionConversionJobRuntime({
    ownerUserId: 'alice', dataRoot, database: {
      conversations: database.conversations,
      mediaAssets: database.mediaAssets,
      conversionArtifacts: database.conversionArtifacts,
      conversionJobs: database.conversionJobs,
    }, artifacts, packManager,
    signedIndex: async () => ({ index: {}, signature: 'signed' }),
    processRunner,
  })
  const runner = createConversionJobRunner({
    ownerUserId: 'alice', jobs: database.conversionJobs, runtime, id: () => 'job', now: () => 100,
  })
  return { artifacts, dataRoot, database, observedProcessInputs, runner }
}

describe('production conversion runtime', () => {
  it('persists all three PDF pages in deterministic order through the real job runner', async () => {
    const { database, runner, dataRoot } = await fixture({
      name: 'annual-report.pdf', mimeType: 'application/pdf', format: 'pdf', bytes: pdf(3),
    })
    runner.start()
    const submitted = runner.submit({
      executionId: 'execution', sourceKind: 'artifact', sourceId: 'source', targetFormat: 'png',
    })
    await runner.idle()

    expect(database.conversionJobs.getOwned(submitted.jobId, 'alice')).toMatchObject({ status: 'completed', progress: 100 })
    const outputs = database.conversionArtifacts.listForJob(submitted.jobId, 'alice')
    expect(outputs.map(({ displayName, metadata }) => ({ displayName, metadata }))).toEqual([
      { displayName: 'annual-report-page-001.png', metadata: { pdfPage: 1 } },
      { displayName: 'annual-report-page-002.png', metadata: { pdfPage: 2 } },
      { displayName: 'annual-report-page-003.png', metadata: { pdfPage: 3 } },
    ])
    expect(await Promise.all(outputs.map((output) => readFile(join(resolveUserConversionRoot(dataRoot, 'alice'), output.relativePath)).catch(() => undefined))))
      .not.toContain(undefined)
    database.close()
  })

  it('runs the converter against an immutable private copy when the managed input path is replaced', async () => {
    const original = pdf(3)
    const replacement = pdf(1)
    const { database, observedProcessInputs, runner } = await fixture({
      name: 'annual-report.pdf', mimeType: 'application/pdf', format: 'pdf', bytes: original,
      replaceInputBeforeProcess: replacement,
    })
    runner.start()
    const submitted = runner.submit({
      executionId: 'execution', sourceKind: 'artifact', sourceId: 'source', targetFormat: 'png',
    })
    await runner.idle()

    expect(database.conversionJobs.getOwned(submitted.jobId, 'alice')).toMatchObject({ status: 'completed' })
    expect(observedProcessInputs).toEqual([original])
    database.close()
  })

  it('persists every ordered ICNS representation with its scale-specific metadata', async () => {
    const { database, runner, dataRoot } = await fixture({
      name: 'App Icon.icns', mimeType: 'image/icns', format: 'icns', bytes: icns(),
    })
    runner.start()
    const submitted = runner.submit({
      executionId: 'execution', sourceKind: 'artifact', sourceId: 'source', targetFormat: 'png',
    })
    await runner.idle()

    const outputs = database.conversionArtifacts.listForJob(submitted.jobId, 'alice')
    expect(outputs.map(({ displayName, metadata }) => ({ displayName, metadata }))).toEqual([
      {
        displayName: 'App Icon-16x16@1x.png',
        metadata: { iconRepresentation: { sourceType: 'icp4', logicalWidth: 16, logicalHeight: 16, pixelWidth: 16, pixelHeight: 16, scale: 1 } },
      },
      {
        displayName: 'App Icon-16x16@2x.png',
        metadata: { iconRepresentation: { sourceType: 'ic11', logicalWidth: 16, logicalHeight: 16, pixelWidth: 32, pixelHeight: 32, scale: 2 } },
      },
      {
        displayName: 'App Icon-32x32@1x.png',
        metadata: { iconRepresentation: { sourceType: 'icp5', logicalWidth: 32, logicalHeight: 32, pixelWidth: 32, pixelHeight: 32, scale: 1 } },
      },
    ])
    expect(await Promise.all(outputs.map((output) => readFile(join(resolveUserConversionRoot(dataRoot, 'alice'), output.relativePath)))))
      .toHaveLength(3)
    database.close()
  })

  it('persists three ordered ICO representations after stable dimension-and-hash deduplication', async () => {
    const { database, runner } = await fixture({
      name: 'App Icon.ico', mimeType: 'image/vnd.microsoft.icon', format: 'ico',
      bytes: icoWithDeduplicatedRepresentations(),
    })
    runner.start()
    const submitted = runner.submit({
      executionId: 'execution', sourceKind: 'artifact', sourceId: 'source', targetFormat: 'png',
    })
    await runner.idle()

    expect(database.conversionJobs.getOwned(submitted.jobId, 'alice')).toMatchObject({ status: 'completed' })
    const outputs = database.conversionArtifacts.listForJob(submitted.jobId, 'alice')
    expect(outputs.map(({ displayName, metadata }) => ({ displayName, metadata }))).toEqual([
      {
        displayName: 'App Icon-16x16-source-001.png',
        metadata: { iconRepresentation: {
          sourceType: 'ico', sourceIndex: 1, logicalWidth: 16, logicalHeight: 16,
          pixelWidth: 16, pixelHeight: 16, scale: 1,
        } },
      },
      {
        displayName: 'App Icon-32x32@1x.png',
        metadata: { iconRepresentation: {
          sourceType: 'ico', sourceIndex: 2, logicalWidth: 32, logicalHeight: 32,
          pixelWidth: 32, pixelHeight: 32, scale: 1,
        } },
      },
      {
        displayName: 'App Icon-16x16-source-004.png',
        metadata: { iconRepresentation: {
          sourceType: 'ico', sourceIndex: 4, logicalWidth: 16, logicalHeight: 16,
          pixelWidth: 16, pixelHeight: 16, scale: 1,
        } },
      },
    ])
    database.close()
  })

  it('leaves no ready subset when the second real multi-output result fails content verification', async () => {
    const { database, runner } = await fixture({
      name: 'annual-report.pdf', mimeType: 'application/pdf', format: 'pdf', bytes: pdf(3),
      invalidOutputIndex: 1,
    })
    runner.start()
    const submitted = runner.submit({
      executionId: 'execution', sourceKind: 'artifact', sourceId: 'source', targetFormat: 'png',
    })
    await runner.idle()

    expect(database.conversionJobs.getOwned(submitted.jobId, 'alice')).toMatchObject({
      status: 'failed', errorCode: 'CONVERSION_INPUT_INVALID',
    })
    expect(database.conversionArtifacts.listForJob(submitted.jobId, 'alice')).toEqual([])
    database.close()
  })

  it('keeps a cancelled production attempt terminal when its late three-page process result returns', async () => {
    const started = deferred<void>()
    const release = deferred<void>()
    const { database, runner } = await fixture({
      name: 'annual-report.pdf', mimeType: 'application/pdf', format: 'pdf', bytes: pdf(3),
      processGate: { started, release: release.promise },
    })
    runner.start()
    const submitted = runner.submit({
      executionId: 'execution', sourceKind: 'artifact', sourceId: 'source', targetFormat: 'png',
    })
    await started.promise
    const cancellation = runner.cancel(submitted.jobId)
    release.resolve()

    await expect(cancellation).resolves.toBe(true)
    await runner.idle()
    expect(database.conversionJobs.getOwned(submitted.jobId, 'alice')).toMatchObject({
      status: 'cancelled', errorCode: 'CONVERSION_CANCELLED',
    })
    expect(database.conversionArtifacts.listForJob(submitted.jobId, 'alice')).toEqual([])
    database.close()
  })

  it('keeps a disabled or invalid packaged release fail-closed without any network or PATH fallback', async () => {
    const app = await fixture({
      name: 'annual-report.pdf', mimeType: 'application/pdf', format: 'pdf', bytes: pdf(3),
    })
    const resourcesRoot = join(app.dataRoot, 'packaged-resources')
    await mkdir(resourcesRoot)
    const network = {
      fetch: vi.fn(),
      withTransportLease: vi.fn(async (operation: (value: { settings: { enabled: false; bypassDomains: [] } }) => Promise<unknown>) => (
        operation({ settings: { enabled: false, bypassDomains: [] } })
      )),
    }
    for (const bootstrap of [
      {
        schemaVersion: 1, downloadsEnabled: false, indexUrl: null, rootPublicKeyFile: null,
        requiredPackFamilies: ['image-icon', 'document', 'pdf', 'media'],
        supportedTargets: ['darwin-arm64', 'darwin-x64'],
      },
      {
        schemaVersion: 1, downloadsEnabled: true, indexUrl: 'http://packs.example.test/index.json',
        rootPublicKeyFile: '../outside.pem', requiredPackFamilies: ['image-icon', 'document', 'pdf', 'media'],
        supportedTargets: ['darwin-arm64'],
      },
    ]) {
      await writeFile(join(resourcesRoot, 'bootstrap.json'), JSON.stringify(bootstrap))
      const create = createProductionConversionRuntimeFactory({
        resourcesRoot, network: network as never, platform: 'darwin', arch: 'arm64',
      })
      const binding = await create({
        ownerUserId: 'alice', dataRoot: app.dataRoot, packsRoot: join(app.dataRoot, 'installed-packs'),
        database: {
          conversations: app.database.conversations,
          mediaAssets: app.database.mediaAssets,
          conversionArtifacts: app.database.conversionArtifacts,
          conversionJobs: app.database.conversionJobs,
        },
        artifacts: app.artifacts,
      })
      const job = app.database.conversionJobs.create({
        id: `bootstrap-job-${bootstrap.downloadsEnabled}`, ownerUserId: 'alice', executionId: 'execution',
        sourceKind: 'artifact', sourceId: 'source', targetFormat: 'png', status: 'queued', createdAt: 2,
      })
      await expect(binding.runtime.acquirePack(job, new AbortController().signal))
        .rejects.toMatchObject({ code: 'CONVERSION_COMPONENT_UNAVAILABLE' })
      await rm(join(resourcesRoot, 'bootstrap.json'))
    }
    expect(network.fetch).not.toHaveBeenCalled()
    app.database.close()
  })

  it('loads only the packaged root and fetches the HTTPS index and signature under one network lease', async () => {
    const app = await fixture({
      name: 'annual-report.pdf', mimeType: 'application/pdf', format: 'pdf', bytes: pdf(3),
    })
    const resourcesRoot = join(app.dataRoot, 'valid-packaged-resources')
    await mkdir(resourcesRoot)
    await writeFile(join(resourcesRoot, 'bootstrap.json'), JSON.stringify({
      schemaVersion: 1, downloadsEnabled: true,
      indexUrl: 'https://packs.example.test/releases/index.json', rootPublicKeyFile: 'root-public-key.pem',
      requiredPackFamilies: ['image-icon', 'document', 'pdf', 'media'],
      supportedTargets: ['darwin-arm64', 'darwin-x64'],
    }))
    await writeFile(
      join(resourcesRoot, 'root-public-key.pem'),
      await readFile(new URL('./fixtures/test-converter-root-public-key.pem', import.meta.url)),
    )
    const fetch = vi.fn(async (url: string) => {
      const body = url.endsWith('index.sig') ? 'AAAA\n' : '{}'
      return new Response(body, { status: 200, headers: { 'content-length': String(Buffer.byteLength(body)) } })
    })
    const withTransportLease = vi.fn(async (operation: () => Promise<unknown>) => operation())
    const create = createProductionConversionRuntimeFactory({
      resourcesRoot,
      network: { fetch, withTransportLease } as never,
      platform: 'darwin',
      arch: 'arm64',
    })
    const binding = await create({
      ownerUserId: 'alice', dataRoot: app.dataRoot, packsRoot: join(app.dataRoot, 'valid-installed-packs'),
      database: {
        conversations: app.database.conversations,
        mediaAssets: app.database.mediaAssets,
        conversionArtifacts: app.database.conversionArtifacts,
        conversionJobs: app.database.conversionJobs,
      },
      artifacts: app.artifacts,
    })
    const job = app.database.conversionJobs.create({
      id: 'valid-bootstrap-job', ownerUserId: 'alice', executionId: 'execution', sourceKind: 'artifact',
      sourceId: 'source', targetFormat: 'png', status: 'queued', createdAt: 3,
    })

    await expect(binding.runtime.acquirePack(job, new AbortController().signal))
      .rejects.toMatchObject({ code: 'CONVERSION_COMPONENT_UNAVAILABLE' })
    expect(withTransportLease).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://packs.example.test/releases/index.json',
      'https://packs.example.test/releases/index.sig',
    ])
    app.database.close()
  })

  it('stops reading an undeclared oversized index before buffering the full response', async () => {
    const app = await fixture({
      name: 'annual-report.pdf', mimeType: 'application/pdf', format: 'pdf', bytes: pdf(3),
    })
    const resourcesRoot = join(app.dataRoot, 'stream-limited-resources')
    await mkdir(resourcesRoot)
    await writeFile(join(resourcesRoot, 'bootstrap.json'), JSON.stringify({
      schemaVersion: 1, downloadsEnabled: true,
      indexUrl: 'https://packs.example.test/releases/index.json', rootPublicKeyFile: 'root-public-key.pem',
      requiredPackFamilies: ['image-icon', 'document', 'pdf', 'media'],
      supportedTargets: ['darwin-arm64', 'darwin-x64'],
    }))
    await writeFile(
      join(resourcesRoot, 'root-public-key.pem'),
      await readFile(new URL('./fixtures/test-converter-root-public-key.pem', import.meta.url)),
    )
    let pulls = 0
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls === 512) {
          controller.close()
          return
        }
        pulls += 1
        controller.enqueue(new Uint8Array(4 * 1024))
      },
      cancel() { cancelled = true },
    })
    const fetch = vi.fn(async () => new Response(body, { status: 200 }))
    const create = createProductionConversionRuntimeFactory({
      resourcesRoot,
      network: { fetch, withTransportLease: async (operation: () => Promise<unknown>) => operation() } as never,
      platform: 'darwin', arch: 'arm64',
    })
    const binding = await create({
      ownerUserId: 'alice', dataRoot: app.dataRoot, packsRoot: join(app.dataRoot, 'stream-installed-packs'),
      database: {
        conversations: app.database.conversations,
        mediaAssets: app.database.mediaAssets,
        conversionArtifacts: app.database.conversionArtifacts,
        conversionJobs: app.database.conversionJobs,
      },
      artifacts: app.artifacts,
    })
    const job = app.database.conversionJobs.create({
      id: 'stream-limit-job', ownerUserId: 'alice', executionId: 'execution', sourceKind: 'artifact',
      sourceId: 'source', targetFormat: 'png', status: 'queued', createdAt: 4,
    })

    await expect(binding.runtime.acquirePack(job, new AbortController().signal))
      .rejects.toMatchObject({ code: 'CONVERSION_COMPONENT_UNAVAILABLE' })
    expect(cancelled).toBe(true)
    expect(pulls).toBeLessThan(512)
    expect(fetch).toHaveBeenCalledTimes(1)
    app.database.close()
  })

  it.each(['symlink', 'same-size regular replacement'] as const)(
    'rejects a packaged root key %s before any network request',
    async (replacementKind) => {
      const app = await fixture({
        name: 'annual-report.pdf', mimeType: 'application/pdf', format: 'pdf', bytes: pdf(3),
      })
      const resourcesRoot = join(app.dataRoot, `root-key-race-${replacementKind.replaceAll(' ', '-')}`)
      await mkdir(resourcesRoot)
      await writeFile(join(resourcesRoot, 'bootstrap.json'), JSON.stringify({
        schemaVersion: 1, downloadsEnabled: true,
        indexUrl: 'https://packs.example.test/releases/index.json', rootPublicKeyFile: 'root-public-key.pem',
        requiredPackFamilies: ['image-icon', 'document', 'pdf', 'media'],
        supportedTargets: ['darwin-arm64', 'darwin-x64'],
      }))
      const trustedKey = await readFile(new URL('./fixtures/test-converter-root-public-key.pem', import.meta.url))
      const rootKeyPath = join(resourcesRoot, 'root-public-key.pem')
      const replacementPath = join(resourcesRoot, 'replacement.pem')
      await writeFile(rootKeyPath, trustedKey)
      await writeFile(replacementPath, Buffer.alloc(trustedKey.byteLength, 0x78))
      let replaced = false
      const fetch = vi.fn(async () => new Response('{}', { status: 200 }))
      const create = createProductionConversionRuntimeFactory({
        resourcesRoot,
        network: {
          fetch,
          withTransportLease: async (operation: () => Promise<unknown>) => operation(),
        } as never,
        platform: 'darwin', arch: 'arm64',
        resourceFileOpen: async (path, flags) => {
          const handle = await open(path, flags)
          if (path.endsWith('/root-public-key.pem')) {
            const canonicalRoot = path.slice(0, -'/root-public-key.pem'.length)
            await rename(path, join(canonicalRoot, 'trusted-backup.pem'))
            if (replacementKind === 'symlink') await symlink(replacementPath, path)
            else await writeFile(path, await readFile(replacementPath))
            replaced = true
          }
          return handle
        },
      })
      const binding = await create({
        ownerUserId: 'alice', dataRoot: app.dataRoot, packsRoot: join(app.dataRoot, 'root-race-installed-packs'),
        database: {
          conversations: app.database.conversations,
          mediaAssets: app.database.mediaAssets,
          conversionArtifacts: app.database.conversionArtifacts,
          conversionJobs: app.database.conversionJobs,
        },
        artifacts: app.artifacts,
      })
      const job = app.database.conversionJobs.create({
        id: `root-key-${replacementKind}`, ownerUserId: 'alice', executionId: 'execution', sourceKind: 'artifact',
        sourceId: 'source', targetFormat: 'png', status: 'queued', createdAt: 5,
      })

      await expect(binding.runtime.acquirePack(job, new AbortController().signal))
        .rejects.toMatchObject({ code: 'CONVERSION_COMPONENT_UNAVAILABLE' })
      expect(replaced).toBe(true)
      expect(fetch).not.toHaveBeenCalled()
      app.database.close()
    },
  )

  it('excludes win32 from the first-release matrix before reading release metadata or using the network', async () => {
    const app = await fixture({
      name: 'annual-report.pdf', mimeType: 'application/pdf', format: 'pdf', bytes: pdf(3),
    })
    const resourcesRoot = join(app.dataRoot, 'win32-packaged-resources')
    await mkdir(resourcesRoot)
    await writeFile(join(resourcesRoot, 'bootstrap.json'), JSON.stringify({
      schemaVersion: 1, downloadsEnabled: true,
      indexUrl: 'https://packs.example.test/releases/index.json', rootPublicKeyFile: 'root-public-key.pem',
      requiredPackFamilies: ['image-icon', 'document', 'pdf', 'media'],
      supportedTargets: ['darwin-arm64', 'darwin-x64'],
    }))
    await writeFile(
      join(resourcesRoot, 'root-public-key.pem'),
      await readFile(new URL('./fixtures/test-converter-root-public-key.pem', import.meta.url)),
    )
    const network = { fetch: vi.fn(), withTransportLease: vi.fn() }
    const resourceFileOpen = vi.fn((path: string, flags: number) => open(path, flags))
    const create = createProductionConversionRuntimeFactory({
      resourcesRoot, network: network as never, platform: 'win32', arch: 'x64',
      windowsJobObject: {
        treeKind: 'windows-job-object',
        spawn() { throw new Error('Windows conversion must remain unreachable in the first release') },
        async terminateTree() {},
      },
      resourceFileOpen,
    })
    const binding = await create({
      ownerUserId: 'alice', dataRoot: app.dataRoot, packsRoot: join(app.dataRoot, 'win32-installed-packs'),
      database: {
        conversations: app.database.conversations,
        mediaAssets: app.database.mediaAssets,
        conversionArtifacts: app.database.conversionArtifacts,
        conversionJobs: app.database.conversionJobs,
      },
      artifacts: app.artifacts,
    })
    const job = app.database.conversionJobs.create({
      id: 'win32-job', ownerUserId: 'alice', executionId: 'execution', sourceKind: 'artifact',
      sourceId: 'source', targetFormat: 'png', status: 'queued', createdAt: 4,
    })

    await expect(binding.runtime.acquirePack(job, new AbortController().signal))
      .rejects.toMatchObject({ code: 'CONVERSION_COMPONENT_UNAVAILABLE' })
    expect(network.fetch).not.toHaveBeenCalled()
    expect(network.withTransportLease).not.toHaveBeenCalled()
    expect(resourceFileOpen).not.toHaveBeenCalled()
    app.database.close()
  })
})
