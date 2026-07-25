import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openAppDatabase } from '../database/client.js'
import {
  MEDIA_LIMITS,
  createMediaAssetService,
  type MediaAssetServiceDatabase,
} from './media-asset-service.js'

const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('payload')])
const mp3 = Buffer.concat([Buffer.from('ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000', 'binary'), Buffer.from('audio')])
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(12)])
const roots: string[] = []

type Database = ReturnType<typeof openAppDatabase>

let root: string
let mediaRoot: string
let database: Database

async function stagingEntries(conversationId = 'conversation_1') {
  try {
    return await readdir(join(mediaRoot, conversationId, '.staging'))
  } catch {
    return []
  }
}

async function sparseMedia(name: string, bytes: Buffer, size: number) {
  const path = join(root, name)
  await writeFile(path, bytes)
  await truncate(path, size)
  return path
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'autoforge-media-service-'))
  roots.push(root)
  mediaRoot = join(root, 'managed-media')
  database = openAppDatabase(join(root, 'database.sqlite'))
  database.conversations.insert({ id: 'conversation_1', title: 'Media' })
})

afterEach(async () => {
  database.close()
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('MediaAssetService imports', () => {
  it('uses sniffed bytes instead of the source extension and hashes while copying', async () => {
    const source = join(root, 'spoofed.txt')
    await writeFile(source, png)
    const service = createMediaAssetService({ database, mediaRoot, id: () => 'asset_png' })

    const [asset] = await service.importPaths({
      conversationId: 'conversation_1',
      existingAssetIds: [],
      paths: [source],
    })

    expect(asset).toEqual({
      id: 'asset_png',
      kind: 'image',
      mimeType: 'image/png',
      name: 'spoofed.txt',
      byteSize: png.byteLength,
    })
    const record = database.mediaAssets.get('asset_png')
    expect(record).toMatchObject({
      status: 'ready',
      relativePath: 'conversation_1/asset_png.png',
      sha256: createHash('sha256').update(png).digest('hex'),
    })
    expect(await readFile(join(mediaRoot, record!.relativePath!))).toEqual(png)
    expect(await stagingEntries()).toEqual([])
  })

  it('accepts the exact image byte cap and rejects one byte more before persistence', async () => {
    const exact = await sparseMedia('exact.png', png, MEDIA_LIMITS.imageBytes)
    const tooLarge = await sparseMedia('too-large.png', png, MEDIA_LIMITS.imageBytes + 1)
    const service = createMediaAssetService({ database, mediaRoot, id: () => 'asset_exact' })

    await expect(service.importPaths({
      conversationId: 'conversation_1',
      existingAssetIds: [],
      paths: [exact],
    })).resolves.toMatchObject([{ byteSize: MEDIA_LIMITS.imageBytes }])
    await expect(service.importPaths({
      conversationId: 'conversation_1',
      existingAssetIds: [],
      paths: [tooLarge],
    })).rejects.toMatchObject({ code: 'MEDIA_SIZE_LIMIT_EXCEEDED' })
    expect(database.mediaAssets.listForConversation('conversation_1')).toHaveLength(1)
    expect(await stagingEntries()).toEqual([])
  })

  it.each([
    ['audio', 'oversized.mp3', mp3, MEDIA_LIMITS.audioBytes + 1],
    ['video', 'oversized.mp4', mp4, MEDIA_LIMITS.videoBytes + 1],
  ] as const)('rejects one byte beyond the %s cap before copying', async (_kind, name, bytes, size) => {
    const source = await sparseMedia(name, bytes, size)
    const service = createMediaAssetService({ database, mediaRoot })

    await expect(service.importPaths({
      conversationId: 'conversation_1',
      existingAssetIds: [],
      paths: [source],
    })).rejects.toMatchObject({ code: 'MEDIA_SIZE_LIMIT_EXCEEDED' })
    expect(await stagingEntries()).toEqual([])
  })

  it('rejects more than five attachments before reading a new path', async () => {
    const source = join(root, 'source.png')
    await writeFile(source, png)
    const service = createMediaAssetService({ database, mediaRoot })

    await expect(service.importPaths({
      conversationId: 'conversation_1',
      existingAssetIds: ['a', 'b', 'c', 'd', 'e'],
      paths: [source],
    })).rejects.toMatchObject({ code: 'MEDIA_ATTACHMENT_LIMIT_EXCEEDED' })
  })

  it('rejects a request over 250 MB from file metadata without leaving staging files', async () => {
    const audio = await sparseMedia('large.mp3', mp3, MEDIA_LIMITS.audioBytes)
    const video = await sparseMedia('large.mp4', mp4, MEDIA_LIMITS.videoBytes)
    const extra = await sparseMedia('extra.png', png, 1)
    const service = createMediaAssetService({ database, mediaRoot })

    await expect(service.importPaths({
      conversationId: 'conversation_1',
      existingAssetIds: [],
      paths: [audio, video, extra],
    })).rejects.toMatchObject({ code: 'MEDIA_SIZE_LIMIT_EXCEEDED' })
    expect(database.mediaAssets.listForConversation('conversation_1')).toEqual([])
    expect(await stagingEntries()).toEqual([])
  })

  it('rechecks the request cap against the files actually opened after preflight', async () => {
    database.mediaAssets.insert({
      id: 'existing_video',
      conversationId: 'conversation_1',
      source: 'upload',
      kind: 'video',
      mimeType: 'video/mp4',
      originalName: 'existing.mp4',
      relativePath: 'conversation_1/existing_video.mp4',
      byteSize: MEDIA_LIMITS.videoBytes,
      sha256: 'a'.repeat(64),
      status: 'ready',
      createdAt: 1,
      updatedAt: 1,
    })
    const preflightPath = await sparseMedia('small.mp4', mp4, 1)
    const openedPath = await sparseMedia('opened.mp4', mp4, 50 * 1024 * 1024 + 1)
    let reads = 0
    const changingPaths = new Proxy([preflightPath], {
      get(target, property, receiver) {
        if (property === '0') {
          reads += 1
          return reads === 1 ? preflightPath : openedPath
        }
        return Reflect.get(target, property, receiver)
      },
    })
    const service = createMediaAssetService({ database, mediaRoot })

    await expect(service.importPaths({
      conversationId: 'conversation_1',
      existingAssetIds: ['existing_video'],
      paths: changingPaths,
    })).rejects.toMatchObject({ code: 'MEDIA_SIZE_LIMIT_EXCEEDED' })
    expect(database.mediaAssets.listForConversation('conversation_1')).toHaveLength(1)
    expect(await stagingEntries()).toEqual([])
  })

  it('rejects symbolic links and unsupported content without staging residue', async () => {
    const source = join(root, 'source.png')
    const link = join(root, 'source-link.png')
    const unsupported = join(root, 'unsupported.png')
    await writeFile(source, png)
    await symlink(source, link)
    await writeFile(unsupported, 'plain text')
    const service = createMediaAssetService({ database, mediaRoot })

    await expect(service.importPaths({
      conversationId: 'conversation_1',
      existingAssetIds: [],
      paths: [link],
    })).rejects.toMatchObject({ code: 'MEDIA_IMPORT_FAILED' })
    await expect(service.importPaths({
      conversationId: 'conversation_1',
      existingAssetIds: [],
      paths: [unsupported],
    })).rejects.toMatchObject({ code: 'MEDIA_TYPE_UNSUPPORTED' })
    expect(await stagingEntries()).toEqual([])
  })

  it('removes the staging row and file when the atomic rename fails', async () => {
    await mkdir(join(mediaRoot, 'conversation_1', 'asset_collision.png'), { recursive: true })
    const source = join(root, 'source.png')
    await writeFile(source, png)
    const service = createMediaAssetService({ database, mediaRoot, id: () => 'asset_collision' })

    await expect(service.importPaths({
      conversationId: 'conversation_1',
      existingAssetIds: [],
      paths: [source],
    })).rejects.toMatchObject({ code: 'MEDIA_IMPORT_FAILED' })
    expect(database.mediaAssets.get('asset_collision')).toBeUndefined()
    expect(await stagingEntries()).toEqual([])
  })

  it('removes the renamed file and any row when the ready database update fails', async () => {
    const source = join(root, 'source.png')
    await writeFile(source, png)
    const baseMediaAssets = database.mediaAssets
    const failingDatabase: MediaAssetServiceDatabase = {
      mediaAssets: {
        ...baseMediaAssets,
        update: (id, patch) => {
          baseMediaAssets.update(id, patch)
          const error = new Error('database write failed')
          throw error
        },
      },
    }
    const service = createMediaAssetService({
      database: failingDatabase,
      mediaRoot,
      id: () => 'asset_db_failure',
    })

    await expect(service.importPaths({
      conversationId: 'conversation_1',
      existingAssetIds: [],
      paths: [source],
    })).rejects.toMatchObject({ code: 'MEDIA_IMPORT_FAILED' })
    expect(database.mediaAssets.get('asset_db_failure')).toBeUndefined()
    await expect(readFile(join(mediaRoot, 'conversation_1', 'asset_db_failure.png'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await stagingEntries()).toEqual([])
  })

  it('imports clipboard PNG bytes without persisting Base64 or an absolute path', async () => {
    const service = createMediaAssetService({ database, mediaRoot, id: () => 'asset_clipboard' })
    const [asset] = await service.importClipboardImage({
      conversationId: 'conversation_1',
      existingAssetIds: [],
      bytes: png,
      mimeType: 'image/png',
      name: 'Clipboard.png',
    })

    expect(asset).toMatchObject({ id: 'asset_clipboard', mimeType: 'image/png' })
    expect(JSON.stringify(database.mediaAssets.get('asset_clipboard'))).not.toContain(mediaRoot)
    expect(JSON.stringify(database.mediaAssets.get('asset_clipboard'))).not.toContain(png.toString('base64'))
  })
})

describe('MediaAssetService generated outputs', () => {
  it('decodes Base64 split across arbitrary chunk boundaries and commits by sniffed type', async () => {
    const service = createMediaAssetService({ database, mediaRoot, id: () => 'asset_generated' })
    const writer = await service.createGeneratedWriter({
      conversationId: 'conversation_1',
      messageId: 'message_1',
      kind: 'image',
      provider: 'openrouter',
      model: 'image-model',
      name: '../provider-output.anything',
    })
    const encoded = png.toString('base64')
    for (const chunk of [encoded.slice(0, 1), encoded.slice(1, 6), encoded.slice(6, 11), encoded.slice(11)]) {
      await writer.appendBase64Chunk(chunk)
    }

    await expect(writer.commit()).resolves.toMatchObject({
      id: 'asset_generated',
      kind: 'image',
      mimeType: 'image/png',
      name: 'provider-output.anything',
    })
    expect(await readFile(join(mediaRoot, 'conversation_1', 'asset_generated.png'))).toEqual(png)
    expect(await stagingEntries()).toEqual([])
  })

  it('rejects invalid cross-chunk Base64 and cleans staging', async () => {
    const service = createMediaAssetService({ database, mediaRoot })
    const writer = await service.createGeneratedWriter({
      conversationId: 'conversation_1',
      messageId: 'message_1',
      kind: 'image',
      provider: 'openrouter',
      model: 'image-model',
      name: 'output.png',
    })
    await writer.appendBase64Chunk('iVBO')
    await expect(writer.appendBase64Chunk('$w0K')).rejects.toMatchObject({ code: 'MEDIA_GENERATION_FAILED' })
    await writer.abort()
    expect(await stagingEntries()).toEqual([])
  })

  it('rejects data URLs and never persists a data URL supplied as a display name', async () => {
    const service = createMediaAssetService({ database, mediaRoot, id: () => 'asset_safe_name' })
    await expect(service.commitGeneratedBase64({
      conversationId: 'conversation_1',
      messageId: 'message_1',
      kind: 'image',
      provider: 'openrouter',
      model: 'image-model',
      name: 'output.png',
      dataBase64: `data:image/png;base64,${png.toString('base64')}`,
    })).rejects.toMatchObject({ code: 'MEDIA_GENERATION_FAILED' })

    await service.commitGeneratedBase64({
      conversationId: 'conversation_1',
      messageId: 'message_1',
      kind: 'image',
      provider: 'openrouter',
      model: 'image-model',
      name: `data:image/png;base64,${png.toString('base64')}`,
      dataBase64: png.toString('base64'),
    })
    expect(database.mediaAssets.get('asset_safe_name')?.originalName).toBe('media')
    expect(JSON.stringify(database.mediaAssets.get('asset_safe_name'))).not.toContain('data:')
  })

  it('rejects non-canonical Base64 padding bits split across chunks', async () => {
    const service = createMediaAssetService({ database, mediaRoot })
    const writer = await service.createGeneratedWriter({
      conversationId: 'conversation_1',
      messageId: 'message_1',
      kind: 'image',
      provider: 'openrouter',
      model: 'image-model',
      name: 'output.png',
    })
    const encoded = Buffer.concat([png, Buffer.from('d')]).toString('base64')
    const nonCanonical = `${encoded.slice(0, -3)}B==`
    await writer.appendBase64Chunk(nonCanonical.slice(0, -2))

    await expect(writer.appendBase64Chunk(nonCanonical.slice(-2))).rejects.toMatchObject({
      code: 'MEDIA_GENERATION_FAILED',
    })
    await writer.abort()
    expect(await stagingEntries()).toEqual([])
  })

  it('rejects a generated kind or declared MIME mismatch without a ready row', async () => {
    const service = createMediaAssetService({ database, mediaRoot, id: () => 'asset_mismatch' })

    await expect(service.commitGeneratedBase64({
      conversationId: 'conversation_1',
      messageId: 'message_1',
      kind: 'audio',
      provider: 'openrouter',
      model: 'audio-model',
      name: 'claimed.mp3',
      declaredMimeType: 'audio/mpeg',
      dataBase64: png.toString('base64'),
    })).rejects.toMatchObject({ code: 'MEDIA_MIME_MISMATCH' })
    expect(database.mediaAssets.get('asset_mismatch')).toBeUndefined()
    expect(await stagingEntries()).toEqual([])
  })

  it('maps ENOSPC from a generated stream to the safe storage error and cleans staging', async () => {
    const service = createMediaAssetService({ database, mediaRoot })
    async function* failingStream() {
      yield png
      throw Object.assign(new Error('secret disk detail'), { code: 'ENOSPC' })
    }

    await expect(service.commitGeneratedStream({
      conversationId: 'conversation_1',
      messageId: 'message_1',
      kind: 'image',
      provider: 'openrouter',
      model: 'image-model',
      name: 'output.png',
      stream: failingStream(),
    })).rejects.toEqual({
      code: 'MEDIA_STORAGE_FULL',
      message: 'There is not enough local storage for this media.',
    })
    expect(await stagingEntries()).toEqual([])
  })

  it('hashes and commits generated byte streams without persisting their bytes', async () => {
    const service = createMediaAssetService({ database, mediaRoot, id: () => 'asset_stream' })
    async function* stream() {
      yield png.subarray(0, 3)
      yield png.subarray(3)
    }

    await expect(service.commitGeneratedStream({
      conversationId: 'conversation_1',
      messageId: 'message_1',
      kind: 'image',
      provider: 'openrouter',
      model: 'image-model',
      name: 'stream.result',
      stream: stream(),
      declaredMimeType: 'image/png',
    })).resolves.toMatchObject({ id: 'asset_stream', mimeType: 'image/png' })
    expect(database.mediaAssets.get('asset_stream')).toMatchObject({
      sha256: createHash('sha256').update(png).digest('hex'),
      relativePath: 'conversation_1/asset_stream.png',
    })
  })

  it('enforces generated encoded and streamed limits before expanding an oversized chunk', async () => {
    const service = createMediaAssetService({ database, mediaRoot })
    const encodedCeiling = Math.ceil(MEDIA_LIMITS.generatedBytes / 3) * 4
    const oversizedEncoded = { length: encodedCeiling + 1 } as unknown as string
    await expect(service.commitGeneratedBase64({
      conversationId: 'conversation_1',
      messageId: 'message_1',
      kind: 'image',
      provider: 'openrouter',
      model: 'image-model',
      name: 'output.png',
      dataBase64: oversizedEncoded,
    })).rejects.toMatchObject({ code: 'MEDIA_SIZE_LIMIT_EXCEEDED' })

    class ReportedOversizedChunk extends Uint8Array {
      override get byteLength() {
        return MEDIA_LIMITS.generatedBytes + 1
      }
    }
    async function* oversizedStream() {
      yield new ReportedOversizedChunk(1)
    }
    await expect(service.commitGeneratedStream({
      conversationId: 'conversation_1',
      messageId: 'message_1',
      kind: 'image',
      provider: 'openrouter',
      model: 'image-model',
      name: 'output.png',
      stream: oversizedStream(),
    })).rejects.toMatchObject({ code: 'MEDIA_SIZE_LIMIT_EXCEEDED' })
    expect(await stagingEntries()).toEqual([])
  })
})

describe('MediaAssetService ready assets', () => {
  it('rejects an over-limit model request before reading or encoding any asset', async () => {
    const fixtures = [
      { id: 'model_video', kind: 'video' as const, mimeType: 'video/mp4', extension: 'mp4', byteSize: MEDIA_LIMITS.videoBytes },
      { id: 'model_audio', kind: 'audio' as const, mimeType: 'audio/mpeg', extension: 'mp3', byteSize: MEDIA_LIMITS.audioBytes },
      { id: 'model_image', kind: 'image' as const, mimeType: 'image/png', extension: 'png', byteSize: 1 },
    ]
    for (const fixture of fixtures) {
      database.mediaAssets.insert({
        id: fixture.id,
        conversationId: 'conversation_1',
        source: 'upload',
        kind: fixture.kind,
        mimeType: fixture.mimeType,
        originalName: `${fixture.id}.${fixture.extension}`,
        relativePath: `conversation_1/${fixture.id}.${fixture.extension}`,
        byteSize: fixture.byteSize,
        sha256: 'a'.repeat(64),
        status: 'ready',
        createdAt: 1,
        updatedAt: 1,
      })
    }
    const service = createMediaAssetService({ database, mediaRoot })

    await expect(service.modelInput('conversation_1', fixtures.map(({ id }) => id)))
      .rejects.toMatchObject({ code: 'MEDIA_SIZE_LIMIT_EXCEEDED' })
  })

  it('only exposes an absolute path through resolveReadyAsset and verifies model bytes', async () => {
    const service = createMediaAssetService({ database, mediaRoot, id: () => 'asset_ready' })
    const [asset] = await service.importClipboardImage({
      conversationId: 'conversation_1',
      existingAssetIds: [],
      bytes: png,
      mimeType: 'image/png',
      name: 'ready.png',
    })

    const resolved = await service.resolveReadyAsset(asset.id, 'conversation_1')
    expect(resolved.absolutePath).toBe(join(await realpath(mediaRoot), 'conversation_1', 'asset_ready.png'))
    expect(resolved.relativePath).toBe('conversation_1/asset_ready.png')
    await expect(service.modelInput('conversation_1', [asset.id])).resolves.toEqual([{
      assetId: 'asset_ready',
      kind: 'image',
      mimeType: 'image/png',
      dataBase64: png.toString('base64'),
    }])

    await writeFile(resolved.absolutePath, Buffer.concat([png, Buffer.from('tampered')]))
    await expect(service.modelInput('conversation_1', [asset.id])).rejects.toMatchObject({
      code: 'MEDIA_ASSET_UNAVAILABLE',
    })
  })

  it('removes only unclaimed drafts and cleanupDrafts uses the repository cutoff', async () => {
    const service = createMediaAssetService({ database, mediaRoot, id: () => 'asset_draft', now: () => 100 })
    const [asset] = await service.importClipboardImage({
      conversationId: 'conversation_1',
      existingAssetIds: [],
      bytes: png,
      mimeType: 'image/png',
      name: 'draft.png',
    })
    expect(basename((await service.resolveReadyAsset(asset.id)).absolutePath)).toBe('asset_draft.png')

    await service.cleanupDrafts(101)
    expect(database.mediaAssets.get(asset.id)).toBeUndefined()
    await expect(service.resolveReadyAsset(asset.id)).rejects.toMatchObject({ code: 'MEDIA_ASSET_UNAVAILABLE' })
  })
})
