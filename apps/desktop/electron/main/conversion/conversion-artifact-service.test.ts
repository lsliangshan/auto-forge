import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
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

const png = (width = 2, height = 3) => {
  const bytes = Buffer.alloc(24)
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(bytes)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
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

async function fixture() {
  const dataRoot = await mkdtemp(join(tmpdir(), 'autoforge-conversion-test-'))
  roots.push(dataRoot)
  const db = database()
  const service = createConversionArtifactService({
    dataRoot,
    database: db,
    id: () => 'output-id',
    now: () => 123,
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
      sha256: 'a'.repeat(64), relativePath: 'inputs/input-id.png', status: 'ready', createdAt: 1, updatedAt: 1,
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
      sha256: 'a'.repeat(64), relativePath: '../outside.png', status: 'ready' as const, createdAt: 1, updatedAt: 1,
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
      byteSize: png().byteLength, sha256: 'a'.repeat(64), status: 'ready', createdAt: 1, updatedAt: 1,
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
      byteSize: png().byteLength, relativePath: 'results/output-id.png', status: 'ready',
    })
    expect(artifact.relativePath).not.toMatch(/^\//)
    expect(db.conversionArtifacts.getOwned('output-id', 'user-a')).toEqual(artifact)
    expect(await readFile(join(resolveUserConversionRoot(dataRoot, 'user-a'), artifact.relativePath))).toEqual(png(7, 9))
    await expect(readFile(writer.tempPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes a failed or aborted temp output and never exposes an artifact', async () => {
    const { db, service } = await fixture()
    const writer = await service.createOutputWriter({
      ownerUserId: 'user-a', executionId: 'execution-a', displayName: 'converted.png', targetFormat: 'png',
    })
    await writeFile(writer.tempPath, Buffer.from('not png'))
    await expect(writer.commit({})).rejects.toMatchObject({ code: 'CONVERSION_INPUT_INVALID' })
    await expect(readFile(writer.tempPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(db.conversionArtifacts.getOwned('output-id', 'user-a')).toBeNull()

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
