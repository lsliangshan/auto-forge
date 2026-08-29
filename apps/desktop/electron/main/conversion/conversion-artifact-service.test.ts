import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { link, lstat, mkdir, open, readFile, readdir, rename, symlink, truncate, writeFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversionArtifact, NewConversionArtifact } from '../database/repositories.js'
import { resolveUserConversionRoot, resolveUserMediaRoot } from '../media/user-media-root.js'
import {
  createConversionArtifactService,
  type ConversionArtifactServiceDatabase,
  type ExecutionAttachmentBinding,
} from './conversion-artifact-service.js'

const roots: string[] = []
afterEach(async () => {
  const { rm } = await import('node:fs/promises')
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

const png = (width = 2, height = 3) => {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc((width * 4 + 1) * height))),
    chunk('IEND'),
  ])
}

function icoRepresentations(sizes: readonly number[]): Buffer {
  const payloads = sizes.map((size) => png(size, size))
  const header = Buffer.alloc(6 + payloads.length * 16)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(payloads.length, 4)
  let offset = header.byteLength
  for (const [index, payload] of payloads.entries()) {
    const size = sizes[index]!
    const entry = 6 + index * 16
    header[entry] = size === 256 ? 0 : size
    header[entry + 1] = size === 256 ? 0 : size
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(payload.byteLength, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += payload.byteLength
  }
  return Buffer.concat([header, ...payloads])
}

function icnsRepresentations(slots: readonly { type: 'icp4' | 'ic11' | 'ic12'; size: 16 | 32 | 64 }[]): Buffer {
  const chunks = slots.map(({ type, size }) => {
    const payload = png(size, size)
    const header = Buffer.alloc(8)
    header.write(type)
    header.writeUInt32BE(8 + payload.byteLength, 4)
    return Buffer.concat([header, payload])
  })
  const header = Buffer.alloc(8)
  header.write('icns')
  header.writeUInt32BE(8 + chunks.reduce((total, value) => total + value.byteLength, 0), 4)
  return Buffer.concat([header, ...chunks])
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function opus(): Buffer {
  const packet = Buffer.from('OpusHead')
  const header = Buffer.alloc(28)
  Buffer.from('OggS').copy(header)
  header[5] = 0x06
  header[26] = 1
  header[27] = packet.byteLength
  return Buffer.concat([header, packet])
}

function database(): ConversionArtifactServiceDatabase & { artifacts: Map<string, ConversionArtifact> } {
  const artifacts = new Map<string, ConversionArtifact>()
  return {
    artifacts,
    conversations: {
      get: (id) => id === 'conversation-a' ? {
        id,
        title: 'A',
        titleState: 'pending',
        userId: 'user-a',
        createdAt: 1,
        updatedAt: 1,
      } : undefined,
    },
    mediaAssets: { get: () => undefined },
    conversionArtifacts: {
      getOwned: (id, ownerUserId) => {
        const artifact = artifacts.get(id)
        return artifact?.ownerUserId === ownerUserId ? artifact : null
      },
      create: (input: NewConversionArtifact) => {
        const artifact: ConversionArtifact = {
          ...input,
          status: input.status ?? 'ready',
          createdAt: input.createdAt ?? 1,
          updatedAt: input.updatedAt ?? 1,
        }
        artifacts.set(artifact.id, artifact)
        return artifact
      },
      createBatch: (inputs: readonly NewConversionArtifact[]) => inputs.map((input) => {
        const artifact: ConversionArtifact = {
          ...input,
          status: input.status ?? 'ready',
          createdAt: input.createdAt ?? 1,
          updatedAt: input.updatedAt ?? 1,
        }
        artifacts.set(artifact.id, artifact)
        return artifact
      }),
    },
  }
}

async function fixture(overrides: Record<string, unknown> = {}) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'autoforge-conversion-test-'))
  roots.push(dataRoot)
  const db = database()
  const service = createConversionArtifactService({
    dataRoot,
    database: db,
    id: () => 'output-id',
    now: () => 123,
    ...overrides,
  })
  return { dataRoot, db, service }
}

function binding(source: ExecutionAttachmentBinding['source']): ExecutionAttachmentBinding {
  return {
    attachmentIndex: 0,
    ownerUserId: 'user-a',
    displayName: 'input.png',
    mimeType: 'image/png',
    byteSize: png().byteLength,
    source,
  }
}

describe('resolveOwnedInput', () => {
  it('rejects cross-user artifact IDs at the repository boundary', async () => {
    const { db, service } = await fixture()
    db.artifacts.set('input-id', {
      id: 'input-id', ownerUserId: 'user-b', executionId: 'execution-b', role: 'input',
      displayName: 'input.png', detectedFormat: 'png', mimeType: 'image/png', byteSize: png().byteLength,
      sha256: sha256(png()), relativePath: 'inputs/input-id.png', status: 'ready', createdAt: 1, updatedAt: 1,
    })
    await expect(service.resolveOwnedInput(binding({ kind: 'artifact', artifactId: 'input-id' })))
      .rejects.toMatchObject({ code: 'CONVERSION_INPUT_INVALID' })
  })

  it('rejects traversal and symlink escapes before opening an artifact', async () => {
    const { dataRoot, db, service } = await fixture()
    const root = resolveUserConversionRoot(dataRoot, 'user-a')
    await mkdir(join(root, 'inputs'), { recursive: true })
    const outside = join(dataRoot, 'outside.png')
    await writeFile(outside, png())

    const record = {
      id: 'input-id', ownerUserId: 'user-a', executionId: 'execution-a', role: 'input' as const,
      displayName: 'input.png', detectedFormat: 'png', mimeType: 'image/png', byteSize: png().byteLength,
      sha256: sha256(png()), relativePath: '../outside.png', status: 'ready' as const, createdAt: 1, updatedAt: 1,
    }
    db.artifacts.set(record.id, record)
    await expect(service.resolveOwnedInput(binding({ kind: 'artifact', artifactId: record.id })))
      .rejects.toMatchObject({ code: 'CONVERSION_INPUT_INVALID' })

    record.relativePath = 'inputs/input-id.png'
    await symlink(outside, join(root, record.relativePath))
    await expect(service.resolveOwnedInput(binding({ kind: 'artifact', artifactId: record.id })))
      .rejects.toMatchObject({ code: 'CONVERSION_INPUT_INVALID' })
  })

  it('rechecks media ownership through its conversation and returns a stable regular-file handle', async () => {
    const { dataRoot, db, service } = await fixture()
    const mediaRoot = resolveUserMediaRoot(dataRoot, 'user-a')
    await mkdir(join(mediaRoot, 'conversation-a'), { recursive: true })
    await writeFile(join(mediaRoot, 'conversation-a/asset-a.png'), png())
    db.mediaAssets.get = () => ({
      id: 'asset-a', conversationId: 'conversation-a', source: 'upload', kind: 'image',
      mimeType: 'image/png', originalName: 'input.png', relativePath: 'conversation-a/asset-a.png',
      byteSize: png().byteLength, sha256: sha256(png()), status: 'ready', createdAt: 1, updatedAt: 1,
    })

    const resolved = await service.resolveOwnedInput(binding({ kind: 'media', mediaAssetId: 'asset-a' }))
    expect(resolved.probe).toMatchObject({ format: 'png', width: 2, height: 3 })
    expect((await resolved.handle.stat()).isFile()).toBe(true)
    expect(await resolved.handle.readFile()).toEqual(png())
    await resolved.close()

    db.conversations.get = () => ({ id: 'conversation-a', userId: 'user-b' })
    await expect(service.resolveOwnedInput(binding({ kind: 'media', mediaAssetId: 'asset-a' })))
      .rejects.toMatchObject({ code: 'CONVERSION_INPUT_INVALID' })
  })

  it('rejects a same-size same-format source whose repository hash no longer matches', async () => {
    const { dataRoot, db, service } = await fixture()
    const expected = png(2, 3)
    const replacement = png(3, 2)
    expect(replacement.byteLength).toBe(expected.byteLength)
    const mediaRoot = resolveUserMediaRoot(dataRoot, 'user-a')
    await mkdir(join(mediaRoot, 'conversation-a'), { recursive: true })
    await writeFile(join(mediaRoot, 'conversation-a/asset-a.png'), replacement)
    db.mediaAssets.get = () => ({
      id: 'asset-a', conversationId: 'conversation-a', source: 'upload', kind: 'image',
      mimeType: 'image/png', originalName: 'input.png', relativePath: 'conversation-a/asset-a.png',
      byteSize: expected.byteLength, sha256: sha256(expected), status: 'ready', createdAt: 1, updatedAt: 1,
    })

    await expect(service.resolveOwnedInput(binding({ kind: 'media', mediaAssetId: 'asset-a' })))
      .rejects.toMatchObject({ code: 'CONVERSION_INPUT_INVALID' })
  })

  it('rejects a symlink in a relative-path ancestor even when it stays inside the owner root', async () => {
    const { dataRoot, db, service } = await fixture()
    const mediaRoot = resolveUserMediaRoot(dataRoot, 'user-a')
    await mkdir(join(mediaRoot, 'real'), { recursive: true })
    await writeFile(join(mediaRoot, 'real/asset-a.png'), png())
    await symlink(join(mediaRoot, 'real'), join(mediaRoot, 'conversation-a'))
    db.mediaAssets.get = () => ({
      id: 'asset-a', conversationId: 'conversation-a', source: 'upload', kind: 'image',
      mimeType: 'image/png', originalName: 'input.png', relativePath: 'conversation-a/asset-a.png',
      byteSize: png().byteLength, sha256: sha256(png()), status: 'ready', createdAt: 1, updatedAt: 1,
    })

    await expect(service.resolveOwnedInput(binding({ kind: 'media', mediaAssetId: 'asset-a' })))
      .rejects.toMatchObject({ code: 'CONVERSION_INPUT_INVALID' })
  })

  it('rejects repository size above 200 MiB without reading the file', async () => {
    const { dataRoot, db, service } = await fixture()
    const mediaRoot = resolveUserMediaRoot(dataRoot, 'user-a')
    await mkdir(join(mediaRoot, 'conversation-a'), { recursive: true })
    const path = join(mediaRoot, 'conversation-a/asset-a.mp4')
    await writeFile(path, Buffer.from('small'))
    await truncate(path, 200 * 1024 * 1024 + 1)
    db.mediaAssets.get = () => ({
      id: 'asset-a', conversationId: 'conversation-a', source: 'upload', kind: 'video',
      mimeType: 'video/mp4', originalName: 'input.mp4', relativePath: 'conversation-a/asset-a.mp4',
      byteSize: 200 * 1024 * 1024 + 1, sha256: 'a'.repeat(64), status: 'ready', createdAt: 1, updatedAt: 1,
    })
    const sample = await open(path, 'r')
    const read = vi.spyOn(Object.getPrototypeOf(sample) as { read: typeof sample.read }, 'read')
    await sample.close()

    const oversized = { ...binding({ kind: 'media', mediaAssetId: 'asset-a' }), displayName: 'input.mp4', mimeType: 'video/mp4', byteSize: 200 * 1024 * 1024 + 1 }
    await expect(service.resolveOwnedInput(oversized)).rejects.toMatchObject({ code: 'CONVERSION_INPUT_INVALID' })
    expect(read).not.toHaveBeenCalled()
    read.mockRestore()
  })

  it('enforces the declared image-family limit before full parsing', async () => {
    const { dataRoot, db, service } = await fixture()
    const mediaRoot = resolveUserMediaRoot(dataRoot, 'user-a')
    await mkdir(join(mediaRoot, 'conversation-a'), { recursive: true })
    const path = join(mediaRoot, 'conversation-a/asset-a.png')
    await writeFile(path, png())
    await truncate(path, 20 * 1024 * 1024 + 1)
    db.mediaAssets.get = () => ({
      id: 'asset-a', conversationId: 'conversation-a', source: 'upload', kind: 'image',
      mimeType: 'image/png', originalName: 'input.png', relativePath: 'conversation-a/asset-a.png',
      byteSize: 20 * 1024 * 1024 + 1, sha256: 'a'.repeat(64), status: 'ready', createdAt: 1, updatedAt: 1,
    })
    const sample = await open(path, 'r')
    const read = vi.spyOn(Object.getPrototypeOf(sample) as { read: typeof sample.read }, 'read')
    read.mockRejectedValue(new Error('unexpected read'))
    await sample.close()

    const oversized = { ...binding({ kind: 'media', mediaAssetId: 'asset-a' }), byteSize: 20 * 1024 * 1024 + 1 }
    await expect(service.resolveOwnedInput(oversized)).rejects.toMatchObject({ code: 'CONVERSION_INPUT_INVALID' })
    expect(read).not.toHaveBeenCalled()
    read.mockRestore()
  })

  it.each([
    {
      label: 'generic MIME with stored PNG format and extension',
      detectedFormat: 'png',
      displayName: 'input.png',
      mimeType: 'application/octet-stream',
    },
    {
      label: 'uppercase image MIME',
      detectedFormat: 'mp4',
      displayName: 'input.mp4',
      mimeType: 'IMAGE/PNG',
    },
    {
      label: 'conflicting audio format, image extension, and video MIME',
      detectedFormat: 'mp3',
      displayName: 'input.png',
      mimeType: 'video/mp4',
    },
  ])('applies the smallest trusted pre-read family limit for $label', async ({ detectedFormat, displayName, mimeType }) => {
    const { dataRoot, db, service } = await fixture()
    const root = resolveUserConversionRoot(dataRoot, 'user-a')
    await mkdir(join(root, 'inputs'), { recursive: true })
    const path = join(root, 'inputs/input-id.bin')
    await writeFile(path, png())
    await truncate(path, 20 * 1024 * 1024 + 1)
    db.artifacts.set('input-id', {
      id: 'input-id', ownerUserId: 'user-a', executionId: 'execution-a', role: 'input',
      displayName, detectedFormat, mimeType, byteSize: 20 * 1024 * 1024 + 1,
      sha256: 'a'.repeat(64), relativePath: 'inputs/input-id.bin', status: 'ready', createdAt: 1, updatedAt: 1,
    })
    const sample = await open(path, 'r')
    const read = vi.spyOn(Object.getPrototypeOf(sample) as { read: typeof sample.read }, 'read')
    read.mockRejectedValue(new Error('unexpected read'))
    await sample.close()

    try {
      await expect(service.resolveOwnedInput({
        attachmentIndex: 0,
        ownerUserId: 'user-a',
        displayName,
        mimeType,
        byteSize: 20 * 1024 * 1024 + 1,
        source: { kind: 'artifact', artifactId: 'input-id' },
      })).rejects.toMatchObject({ code: 'CONVERSION_INPUT_INVALID' })
      expect(read).not.toHaveBeenCalled()
    } finally {
      read.mockRestore()
    }
  })
})

describe('managed output writer', () => {
  it('commits every page in one output batch with stable names and metadata', async () => {
    let nextId = 0
    const { db, service } = await fixture({ id: () => `output-${++nextId}` })
    const batch = await service.createOutputBatch([
      {
        ownerUserId: 'user-a', executionId: 'execution-a', conversionJobId: 'job-a',
        displayName: 'report-page-001.png', targetFormat: 'png',
      },
      {
        ownerUserId: 'user-a', executionId: 'execution-a', conversionJobId: 'job-a',
        displayName: 'report-page-002.png', targetFormat: 'png',
      },
      {
        ownerUserId: 'user-a', executionId: 'execution-a', conversionJobId: 'job-a',
        displayName: 'report-page-003.png', targetFormat: 'png',
      },
    ])
    await Promise.all(batch.outputs.map(({ tempPath }, index) => writeFile(tempPath, png(index + 1, index + 1))))

    const artifacts = await batch.commit([
      { metadata: { pdfPage: 1 } },
      { metadata: { pdfPage: 2 } },
      { metadata: { pdfPage: 3 } },
    ])

    expect(artifacts.map(({ displayName, metadata }) => ({ displayName, metadata }))).toEqual([
      { displayName: 'report-page-001.png', metadata: { pdfPage: 1 } },
      { displayName: 'report-page-002.png', metadata: { pdfPage: 2 } },
      { displayName: 'report-page-003.png', metadata: { pdfPage: 3 } },
    ])
    expect([...db.artifacts.values()].map(({ id }) => id)).toEqual(['output-1', 'output-2', 'output-3'])
  })

  it('leaves no ready subset when a later output in the batch fails verification', async () => {
    let nextId = 0
    const { dataRoot, db, service } = await fixture({ id: () => `output-${++nextId}` })
    const batch = await service.createOutputBatch([
      {
        ownerUserId: 'user-a', executionId: 'execution-a', conversionJobId: 'job-a',
        displayName: 'icon-16.png', targetFormat: 'png',
      },
      {
        ownerUserId: 'user-a', executionId: 'execution-a', conversionJobId: 'job-a',
        displayName: 'icon-32.png', targetFormat: 'png',
      },
      {
        ownerUserId: 'user-a', executionId: 'execution-a', conversionJobId: 'job-a',
        displayName: 'icon-48.png', targetFormat: 'png',
      },
    ])
    await writeFile(batch.outputs[0]!.tempPath, png(16, 16))
    await writeFile(batch.outputs[1]!.tempPath, Buffer.from('not a png'))
    await writeFile(batch.outputs[2]!.tempPath, png(48, 48))

    await expect(batch.commit([
      { metadata: { pdfPage: 1 } },
      { metadata: { pdfPage: 2 } },
      { metadata: { pdfPage: 3 } },
    ])).rejects.toMatchObject({ code: 'CONVERSION_INPUT_INVALID' })

    expect([...db.artifacts.values()]).toEqual([])
    expect(await readdir(join(resolveUserConversionRoot(dataRoot, 'user-a'), 'results'))).toEqual([])
  })

  it.each([
    {
      targetFormat: 'ico' as const,
      bytes: icoRepresentations([16, 32]),
      metadata: { iconRepresentations: [16, 32, 48] as const },
    },
    {
      targetFormat: 'icns' as const,
      bytes: icnsRepresentations([{ type: 'icp4', size: 16 }, { type: 'ic11', size: 32 }]),
      metadata: { iconRepresentations: [16, 32, 64] as const },
    },
  ])('rejects a $targetFormat container whose content omits declared representations', async ({ targetFormat, bytes, metadata }) => {
    const { dataRoot, db, service } = await fixture()
    const batch = await service.createOutputBatch([{
      ownerUserId: 'user-a', executionId: 'execution-a', conversionJobId: 'job-a',
      displayName: `App.${targetFormat}`, targetFormat,
    }])
    await writeFile(batch.outputs[0]!.tempPath, bytes)

    await expect(batch.commit([{ metadata: { iconRepresentations: [...metadata.iconRepresentations] } }]))
      .rejects.toMatchObject({ code: 'CONVERSION_INPUT_INVALID' })

    expect([...db.artifacts.values()]).toEqual([])
    expect(await readdir(join(resolveUserConversionRoot(dataRoot, 'user-a'), 'results'))).toEqual([])
  })

  it('persists an icon container only when every declared representation matches its content', async () => {
    const { db, service } = await fixture()
    const batch = await service.createOutputBatch([{
      ownerUserId: 'user-a', executionId: 'execution-a', conversionJobId: 'job-a',
      displayName: 'App.ico', targetFormat: 'ico',
    }])
    await writeFile(batch.outputs[0]!.tempPath, icoRepresentations([16, 32, 48]))

    await expect(batch.commit([{ metadata: { iconRepresentations: [16, 32, 48] } }]))
      .resolves.toMatchObject([{ metadata: { iconRepresentations: [16, 32, 48] } }])
    expect([...db.artifacts.values()]).toHaveLength(1)
  })

  it('rolls back every exact destination when a later batch rename fails', async () => {
    let nextId = 0
    let renames = 0
    let firstDestinationIdentity: Awaited<ReturnType<typeof lstat>> | undefined
    const { dataRoot, db, service } = await fixture({
      id: () => `output-${++nextId}`,
      filesystem: {
        rename: async (source: string, destination: string) => {
          renames += 1
          if (renames === 2) throw new Error('injected second rename failure')
          const { rename } = await import('node:fs/promises')
          await rename(source, destination)
          if (renames === 1) firstDestinationIdentity = await lstat(destination)
        },
      },
    })
    const batch = await service.createOutputBatch([1, 2, 3].map((page) => ({
      ownerUserId: 'user-a', executionId: 'execution-a', conversionJobId: 'job-a',
      displayName: `report-page-00${page}.png`, targetFormat: 'png' as const,
    })))
    await Promise.all(batch.outputs.map(({ tempPath }, index) => writeFile(tempPath, png(index + 1, index + 1))))

    await expect(batch.commit([1, 2, 3].map((pdfPage) => ({ metadata: { pdfPage } }))))
      .rejects.toMatchObject({ code: 'CONVERSION_INPUT_INVALID' })
    expect([...db.artifacts.values()]).toEqual([])
    const ownerRoot = resolveUserConversionRoot(dataRoot, 'user-a')
    expect(await readdir(join(ownerRoot, 'results'))).toEqual([])
    const rollbackNames = (await readdir(join(ownerRoot, '.trash')))
      .filter((name) => /^rollback-[0-9a-f-]{36}$/u.test(name))
    expect(rollbackNames).toHaveLength(1)
    const rollbackDirectory = join(ownerRoot, '.trash', rollbackNames[0]!)
    const directory = await lstat(rollbackDirectory)
    expect(directory.isDirectory()).toBe(true)
    expect(directory.mode & 0o777).toBe(0o700)
    const rollbackPayload = join(rollbackDirectory, 'batch')
    const payloadDirectory = await lstat(rollbackPayload)
    const rollbackId = rollbackNames[0]!.slice('rollback-'.length)
    await expect(readFile(join(ownerRoot, '.trash', `.rollback-${rollbackId}.reserve`), 'utf8'))
      .resolves.toBe(`v1 ${payloadDirectory.dev} ${payloadDirectory.ino}\n`)
    expect(await readdir(rollbackDirectory)).toEqual(['batch'])
    expect(await readdir(rollbackPayload)).toEqual(['output-1.png'])
    const isolated = await lstat(join(rollbackPayload, 'output-1.png'))
    expect({ dev: isolated.dev, ino: isolated.ino, size: isolated.size }).toEqual({
      dev: firstDestinationIdentity?.dev,
      ino: firstDestinationIdentity?.ino,
      size: firstDestinationIdentity?.size,
    })
  })

  it('fails closed without touching a replacement introduced before rollback isolation', async () => {
    let nextId = 0
    let renames = 0
    let firstDestination: string | undefined
    const replacement = Buffer.from('replacement must remain at the result leaf')
    const preservedRoot = await mkdtemp(join(tmpdir(), 'autoforge-preserved-output-'))
    roots.push(preservedRoot)
    const preservedOriginal = join(preservedRoot, 'original.png')
    const { dataRoot, db, service } = await fixture({
      id: () => `output-${++nextId}`,
      filesystem: {
        rename: async (source: string, destination: string) => {
          renames += 1
          const { rename } = await import('node:fs/promises')
          if (renames === 1) {
            await rename(source, destination)
            firstDestination = destination
            return
          }
          if (renames === 2) {
            if (!firstDestination) throw new Error('missing first destination')
            await rename(firstDestination, preservedOriginal)
            await writeFile(firstDestination, replacement)
            throw new Error('injected second rename failure after replacement')
          }
          await rename(source, destination)
        },
      },
    })
    const batch = await service.createOutputBatch([1, 2].map((page) => ({
      ownerUserId: 'user-a', executionId: 'execution-a', conversionJobId: 'job-a',
      displayName: `report-page-00${page}.png`, targetFormat: 'png' as const,
    })))
    const original = png(4, 4)
    await Promise.all(batch.outputs.map(({ tempPath }) => writeFile(tempPath, original)))

    await expect(batch.commit([{ metadata: { pdfPage: 1 } }, { metadata: { pdfPage: 2 } }]))
      .rejects.toMatchObject({ code: 'CONVERSION_INPUT_INVALID' })

    expect([...db.artifacts.values()]).toEqual([])
    expect(firstDestination).toBeTypeOf('string')
    await expect(readFile(preservedOriginal)).resolves.toEqual(original)
    const ownerRoot = resolveUserConversionRoot(dataRoot, 'user-a')
    expect(await readdir(join(ownerRoot, 'results'))).toEqual([])
    const rollback = (await readdir(join(ownerRoot, '.trash')))
      .find((name) => /^rollback-[0-9a-f-]{36}$/u.test(name))
    expect(rollback).toBeTypeOf('string')
    await expect(readFile(join(ownerRoot, '.trash', rollback!, 'batch', 'output-1.png')))
      .resolves.toEqual(replacement)
  })

  it('quarantines the exclusive result batch even when staging cleanup fails', async () => {
    let nextId = 0
    const { dataRoot, db, service } = await fixture({ id: () => `output-${++nextId}` })
    const batch = await service.createOutputBatch([1, 2].map((page) => ({
      ownerUserId: 'user-a', executionId: 'execution-a', conversionJobId: 'job-a',
      displayName: `report-page-00${page}.png`, targetFormat: 'png' as const,
    })))
    await Promise.all(batch.outputs.map(({ tempPath }) => writeFile(tempPath, png())))
    db.conversionArtifacts.createBatch = () => {
      mkdirSync(batch.outputs[0]!.tempPath)
      throw new Error('injected database failure after durable moves')
    }

    await expect(batch.commit([{ metadata: { pdfPage: 1 } }, { metadata: { pdfPage: 2 } }]))
      .rejects.toMatchObject({ code: 'CONVERSION_INPUT_INVALID' })

    const ownerRoot = resolveUserConversionRoot(dataRoot, 'user-a')
    expect([...db.artifacts.values()]).toEqual([])
    expect(await readdir(join(ownerRoot, 'results'))).toEqual([])
    const quarantines = (await readdir(join(ownerRoot, '.trash')))
      .filter((name) => /^rollback-[0-9a-f-]{36}$/u.test(name))
    expect(quarantines).toHaveLength(1)
    const quarantined = join(ownerRoot, '.trash', quarantines[0]!)
    expect(await readdir(quarantined)).toEqual(['batch'])
    expect((await readdir(join(quarantined, 'batch'))).sort()).toEqual(['output-1.png', 'output-2.png'])
  })

  it('fails closed on a quarantine-name conflict without moving the conflicting node or a replacement batch', async () => {
    let nextId = 0
    let renames = 0
    let preservedBatch: string | undefined
    let replacementBatch: string | undefined
    let quarantineConflict: string | undefined
    const preservedRoot = await mkdtemp(join(tmpdir(), 'autoforge-preserved-batch-'))
    roots.push(preservedRoot)
    const { db, service } = await fixture({
      id: () => `output-${++nextId}`,
      filesystem: {
        rename: async (source: string, destination: string) => {
          renames += 1
          if (renames <= 2) {
            await rename(source, destination)
            return
          }
          preservedBatch = join(preservedRoot, 'original-batch')
          replacementBatch = source
          quarantineConflict = destination
          await rename(source, preservedBatch)
          await mkdir(replacementBatch, { mode: 0o700 })
          await writeFile(join(replacementBatch, 'replacement.txt'), 'must remain')
          await mkdir(quarantineConflict, { mode: 0o700 })
          await writeFile(join(quarantineConflict, 'conflict.txt'), 'must remain')
          throw new Error('injected quarantine collision after batch replacement')
        },
      },
    })
    const batch = await service.createOutputBatch([1, 2].map((page) => ({
      ownerUserId: 'user-a', executionId: 'execution-a', conversionJobId: 'job-a',
      displayName: `report-page-00${page}.png`, targetFormat: 'png' as const,
    })))
    await Promise.all(batch.outputs.map(({ tempPath }) => writeFile(tempPath, png())))
    db.conversionArtifacts.createBatch = () => { throw new Error('injected database failure') }

    await expect(batch.commit([{ metadata: { pdfPage: 1 } }, { metadata: { pdfPage: 2 } }]))
      .rejects.toMatchObject({ code: 'CONVERSION_INPUT_INVALID' })

    expect([...db.artifacts.values()]).toEqual([])
    await expect(readFile(join(replacementBatch!, 'replacement.txt'), 'utf8')).resolves.toBe('must remain')
    await expect(readFile(join(quarantineConflict!, 'conflict.txt'), 'utf8')).resolves.toBe('must remain')
    expect((await readdir(preservedBatch!)).sort()).toEqual(['output-1.png', 'output-2.png'])
  })

  it('does not overwrite an empty rollback container created at exclusive allocation', async () => {
    let nextId = 0
    let conflict: string | undefined
    let conflictIdentity: { dev: number; ino: number } | undefined
    const { dataRoot, db, service } = await fixture({
      id: () => `output-${++nextId}`,
      filesystem: {
        mkdir: async (path: string) => {
          conflict = path
          await mkdir(path, { mode: 0o700 })
          const metadata = await lstat(path)
          conflictIdentity = { dev: metadata.dev, ino: metadata.ino }
          throw Object.assign(new Error('injected empty rollback conflict'), { code: 'EEXIST' })
        },
      },
    })
    const batch = await service.createOutputBatch([1, 2].map((page) => ({
      ownerUserId: 'user-a', executionId: 'execution-a', conversionJobId: 'job-a',
      displayName: `report-page-00${page}.png`, targetFormat: 'png' as const,
    })))
    await Promise.all(batch.outputs.map(({ tempPath }) => writeFile(tempPath, png())))
    db.conversionArtifacts.createBatch = () => { throw new Error('injected database failure') }

    await expect(batch.commit([{ metadata: { pdfPage: 1 } }, { metadata: { pdfPage: 2 } }]))
      .rejects.toMatchObject({ code: 'CONVERSION_INPUT_INVALID' })

    expect(conflict).toBeDefined()
    const preservedConflict = await lstat(conflict!)
    expect({ dev: preservedConflict.dev, ino: preservedConflict.ino }).toEqual(conflictIdentity)
    expect(await readdir(conflict!)).toEqual([])
    expect([...db.artifacts.values()]).toEqual([])
    const ownerRoot = resolveUserConversionRoot(dataRoot, 'user-a')
    const resultBatches = await readdir(join(ownerRoot, 'results'))
    expect(resultBatches).toHaveLength(1)
    expect((await readdir(join(ownerRoot, 'results', resultBatches[0]!))).sort())
      .toEqual(['output-1.png', 'output-2.png'])
  })

  it('enforces the 500 MiB limit over the aggregate batch before verification', async () => {
    let nextId = 0
    const { db, service } = await fixture({ id: () => `output-${++nextId}` })
    const batch = await service.createOutputBatch([1, 2].map((page) => ({
      ownerUserId: 'user-a', executionId: 'execution-a', conversionJobId: 'job-a',
      displayName: `large-page-00${page}.png`, targetFormat: 'png' as const,
    })))
    await Promise.all(batch.outputs.map(async ({ tempPath }) => {
      await writeFile(tempPath, png())
      await truncate(tempPath, 300 * 1024 * 1024)
    }))

    await expect(batch.commit([{ metadata: { pdfPage: 1 } }, { metadata: { pdfPage: 2 } }]))
      .rejects.toMatchObject({ code: 'CONVERSION_OUTPUT_TOO_LARGE' })
    expect([...db.artifacts.values()]).toEqual([])
  })

  it('removes verified files when the atomic job completion CAS is unavailable', async () => {
    let nextId = 0
    const { dataRoot, db, service } = await fixture({ id: () => `output-${++nextId}` })
    const batch = await service.createOutputBatch([1, 2].map((page) => ({
      ownerUserId: 'user-a', executionId: 'execution-a', conversionJobId: 'job-a',
      displayName: `stale-page-00${page}.png`, targetFormat: 'png' as const,
    })))
    await Promise.all(batch.outputs.map(({ tempPath }) => writeFile(tempPath, png())))

    await expect(batch.commit([{ metadata: { pdfPage: 1 } }, { metadata: { pdfPage: 2 } }], {
      jobId: 'job-a', ownerUserId: 'user-a', executionId: 'execution-a', expectedEpoch: 1, endedAt: 10,
    })).rejects.toMatchObject({ code: 'CONVERSION_INTERRUPTED' })
    expect([...db.artifacts.values()]).toEqual([])
    expect(await readdir(join(resolveUserConversionRoot(dataRoot, 'user-a'), 'results'))).toEqual([])
  })

  it('rejects a managed-root parent symlink that escapes the data root', async () => {
    const { dataRoot, service } = await fixture()
    const outside = await mkdtemp(join(tmpdir(), 'autoforge-conversion-escape-'))
    roots.push(outside)
    await symlink(outside, join(dataRoot, 'conversion-artifacts'))

    await expect(service.createOutputWriter({
      ownerUserId: 'user-a', executionId: 'execution-a', displayName: 'converted.png', targetFormat: 'png',
    })).rejects.toMatchObject({ code: 'CONVERSION_INPUT_INVALID' })
  })

  it('registers only after verified same-filesystem rename into the owner result root', async () => {
    const { dataRoot, db, service } = await fixture()
    const writer = await service.createOutputWriter({
      ownerUserId: 'user-a', executionId: 'execution-a', conversionJobId: 'job-a',
      displayName: 'converted.png', targetFormat: 'png',
    })
    expect(db.conversionArtifacts.getOwned('output-id', 'user-a')).toBeNull()
    await writeFile(writer.tempPath, png(7, 9))

    const artifact = await writer.commit({})

    expect(artifact).toMatchObject({
      id: 'output-id', ownerUserId: 'user-a', detectedFormat: 'png', mimeType: 'image/png',
      byteSize: png(7, 9).byteLength, relativePath: 'results/output-id.png', status: 'ready',
    })
    expect(artifact.relativePath).not.toMatch(/^\//)
    expect(db.conversionArtifacts.getOwned('output-id', 'user-a')).toEqual(artifact)
    expect(await readFile(join(resolveUserConversionRoot(dataRoot, 'user-a'), artifact.relativePath))).toEqual(png(7, 9))
    await expect(readFile(writer.tempPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('commits a verifier-owned copy that cannot be modified through a hard link to converter output', async () => {
    const { dataRoot, service } = await fixture()
    const writer = await service.createOutputWriter({
      ownerUserId: 'user-a', executionId: 'execution-a', displayName: 'converted.png', targetFormat: 'png',
    })
    const original = png(2, 3)
    await writeFile(writer.tempPath, original)
    const attackerLink = join(dataRoot, 'converter-output-link.png')
    await link(writer.tempPath, attackerLink)
    const artifact = await writer.commit({})
    await writeFile(attackerLink, png(3, 2))

    expect(await readFile(join(resolveUserConversionRoot(dataRoot, 'user-a'), artifact.relativePath))).toEqual(original)
  })

  it('commits Ogg Opus as canonical opus output', async () => {
    const { service } = await fixture()
    const writer = await service.createOutputWriter({
      ownerUserId: 'user-a', executionId: 'execution-a', displayName: 'voice.opus', targetFormat: 'opus',
    })
    await writeFile(writer.tempPath, opus())
    await expect(writer.commit({})).resolves.toMatchObject({ detectedFormat: 'opus', mimeType: 'audio/opus' })
  })

  it('serializes abort against an in-flight commit and never registers after cancellation', async () => {
    let releaseRename!: () => void
    let renameStarted!: () => void
    const started = new Promise<void>((resolve) => { renameStarted = resolve })
    const release = new Promise<void>((resolve) => { releaseRename = resolve })
    const { dataRoot, db, service } = await fixture({
      filesystem: {
        rename: async (source: string, destination: string) => {
          renameStarted()
          await release
          const { rename } = await import('node:fs/promises')
          await rename(source, destination)
        },
      },
    })
    const writer = await service.createOutputWriter({
      ownerUserId: 'user-a', executionId: 'execution-a', displayName: 'converted.png', targetFormat: 'png',
    })
    await writeFile(writer.tempPath, png())
    const committing = writer.commit({})
    await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error('rename hook not reached')), 100))])
    const aborting = writer.abort()
    releaseRename()
    await aborting
    await expect(committing).rejects.toMatchObject({ code: 'CONVERSION_CANCELLED' })
    expect(db.conversionArtifacts.getOwned('output-id', 'user-a')).toBeNull()
    const root = resolveUserConversionRoot(dataRoot, 'user-a')
    expect(await readdir(join(root, '.staging'))).toEqual([])
    expect(await readdir(join(root, 'results'))).toEqual([])
  })

  it('removes a failed or aborted temp output and never exposes an artifact', async () => {
    const { dataRoot, db, service } = await fixture()
    const writer = await service.createOutputWriter({
      ownerUserId: 'user-a', executionId: 'execution-a', displayName: 'converted.png', targetFormat: 'png',
    })
    await writeFile(writer.tempPath, Buffer.from('not png'))
    await expect(writer.commit({})).rejects.toMatchObject({ code: 'CONVERSION_INPUT_INVALID' })
    await expect(readFile(writer.tempPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(db.conversionArtifacts.getOwned('output-id', 'user-a')).toBeNull()
    expect(await readdir(join(resolveUserConversionRoot(dataRoot, 'user-a'), '.staging'))).toEqual([])

    const aborted = await service.createOutputWriter({
      ownerUserId: 'user-a', executionId: 'execution-a', displayName: 'converted.png', targetFormat: 'png',
    })
    await writeFile(aborted.tempPath, png())
    await aborted.abort()
    await expect(readFile(aborted.tempPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects output over 500 MiB before hashing or rename', async () => {
    const { db, service } = await fixture()
    const writer = await service.createOutputWriter({
      ownerUserId: 'user-a', executionId: 'execution-a', displayName: 'converted.png', targetFormat: 'png',
    })
    await writeFile(writer.tempPath, png())
    const { truncate } = await import('node:fs/promises')
    await truncate(writer.tempPath, 500 * 1024 * 1024 + 1)
    await expect(writer.commit({})).rejects.toMatchObject({ code: 'CONVERSION_OUTPUT_TOO_LARGE' })
    expect(db.conversionArtifacts.getOwned('output-id', 'user-a')).toBeNull()
  })
})
