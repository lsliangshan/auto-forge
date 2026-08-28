import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { link, mkdir, open, readFile, readdir, symlink, truncate, writeFile } from 'node:fs/promises'
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
