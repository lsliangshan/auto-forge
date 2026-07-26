import { createHash } from 'node:crypto'
import {
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises'
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

async function exists(path: string) {
  return lstat(path).then(() => true, () => false)
}

function insertReadyAsset(id: string, conversationId = 'conversation_1') {
  return database.mediaAssets.insert({
    id,
    conversationId,
    source: 'upload',
    kind: 'image',
    mimeType: 'image/png',
    originalName: `${id}.png`,
    relativePath: `${conversationId}/${id}.png`,
    byteSize: png.byteLength,
    sha256: createHash('sha256').update(png).digest('hex'),
    status: 'ready',
    createdAt: 1,
    updatedAt: 1,
  })
}

function claimAsset(assetId: string, messageId = `message_${assetId}`) {
  const asset = database.mediaAssets.get(assetId)!
  database.messages.insertWithAssets({
    id: messageId,
    conversationId: asset.conversationId,
    role: 'user',
    blocks: [{
      type: 'media',
      blockId: `block_${assetId}`,
      assetId,
      kind: asset.kind,
      purpose: 'input',
      name: asset.originalName,
      mimeType: asset.mimeType!,
      byteSize: asset.byteSize!,
    }],
    createdAt: 1,
  }, [assetId])
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

  it('never leaves a ready row when rollback deletion also fails', async () => {
    const source = join(root, 'source-rollback.png')
    await writeFile(source, png)
    const baseMediaAssets = database.mediaAssets
    const failingDatabase: MediaAssetServiceDatabase = {
      mediaAssets: {
        ...baseMediaAssets,
        update: (id, patch) => {
          const updated = baseMediaAssets.update(id, patch)
          if (patch.status === 'ready') throw new Error('ready update reported failure')
          return updated
        },
        delete: () => {
          throw new Error('delete failed')
        },
      },
    }
    const service = createMediaAssetService({
      database: failingDatabase,
      mediaRoot,
      id: () => 'asset_rollback_delete_failure',
    })

    await expect(service.importPaths({
      conversationId: 'conversation_1',
      existingAssetIds: [],
      paths: [source],
    })).rejects.toMatchObject({ code: 'MEDIA_IMPORT_FAILED' })
    expect(database.mediaAssets.get('asset_rollback_delete_failure')).toMatchObject({ status: 'failed' })
    expect(await exists(join(mediaRoot, 'conversation_1', 'asset_rollback_delete_failure.png'))).toBe(false)
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

  it('decodes realistic Base64 in bounded multi-quartet filesystem writes', async () => {
    const bytes = Buffer.concat([png, Buffer.alloc(512 * 1024, 0x5a)])
    let stagingWrites = 0
    const service = createMediaAssetService({
      database,
      mediaRoot,
      id: () => 'asset_batched',
      filesystem: {
        open: async (...arguments_: Parameters<typeof open>) => {
          const handle = await open(...arguments_)
          if (arguments_[1] !== 'wx') return handle
          return new Proxy(handle, {
            get(target, property) {
              if (property === 'write') {
                return async (...writeArguments: Parameters<typeof target.write>) => {
                  stagingWrites += 1
                  return target.write(...writeArguments)
                }
              }
              const value = Reflect.get(target, property, target) as unknown
              return typeof value === 'function' ? value.bind(target) : value
            },
          })
        },
      },
    })

    await service.commitGeneratedBase64({
      conversationId: 'conversation_1',
      messageId: 'message_1',
      kind: 'image',
      provider: 'openrouter',
      model: 'image-model',
      name: 'batched.png',
      dataBase64: bytes.toString('base64'),
    })

    expect(await readFile(join(mediaRoot, 'conversation_1', 'asset_batched.png'))).toEqual(bytes)
    expect(stagingWrites).toBeLessThanOrEqual(16)
  })

  it('decodes consecutive independently padded SSE Base64 chunks in byte order', async () => {
    const service = createMediaAssetService({ database, mediaRoot, id: () => 'asset_audio_chunks' })
    const writer = await service.createGeneratedWriter({
      conversationId: 'conversation_1',
      messageId: 'message_audio_chunks',
      kind: 'audio',
      provider: 'openrouter',
      model: 'audio-model',
      name: 'generated-audio',
    })
    const first = mp3.subarray(0, 11)
    const second = mp3.subarray(11)

    await writer.appendBase64Chunk(first.toString('base64'))
    await writer.appendBase64Chunk(second.toString('base64'))
    const asset = await writer.commit()

    expect(asset).toMatchObject({
      id: 'asset_audio_chunks',
      kind: 'audio',
      mimeType: 'audio/mpeg',
      byteSize: mp3.byteLength,
    })
    expect(await readFile(join(mediaRoot, 'conversation_1', 'asset_audio_chunks.mp3'))).toEqual(mp3)
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

  it('commits a caller-bound generated asset ID without overwriting an existing recovery asset', async () => {
    const service = createMediaAssetService({ database, mediaRoot })
    async function* stream() {
      yield mp4
    }

    await expect(service.commitGeneratedStream({
      assetId: 'video_recovery_asset',
      conversationId: 'conversation_1',
      messageId: 'message_video',
      kind: 'video',
      provider: 'openrouter',
      model: 'video-model',
      name: 'generated-video.mp4',
      stream: stream(),
      declaredMimeType: 'video/mp4',
    })).resolves.toMatchObject({
      id: 'video_recovery_asset',
      kind: 'video',
      mimeType: 'video/mp4',
    })

    await expect(service.commitGeneratedStream({
      assetId: 'video_recovery_asset',
      conversationId: 'conversation_1',
      messageId: 'other_message',
      kind: 'video',
      provider: 'openrouter',
      model: 'other-model',
      name: 'replacement.mp4',
      stream: stream(),
    })).rejects.toMatchObject({ code: 'MEDIA_GENERATION_FAILED' })
    expect(database.mediaAssets.get('video_recovery_asset')).toMatchObject({
      model: 'video-model',
      status: 'ready',
    })
    expect(await stagingEntries()).toEqual([])
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

  it('enforces writer terminal states and repeated calls', async () => {
    const service = createMediaAssetService({ database, mediaRoot, id: () => 'asset_terminal' })
    const committed = await service.createGeneratedWriter({
      conversationId: 'conversation_1',
      messageId: 'message_1',
      kind: 'image',
      provider: 'openrouter',
      model: 'image-model',
      name: 'terminal.png',
    })
    await committed.appendBase64Chunk(png.toString('base64'))
    await committed.commit()
    await expect(committed.appendBase64Chunk('AAAA')).rejects.toMatchObject({ code: 'MEDIA_GENERATION_FAILED' })
    await expect(committed.commit()).rejects.toMatchObject({ code: 'MEDIA_GENERATION_FAILED' })
    await expect(committed.abort()).resolves.toBeUndefined()
    await expect(committed.abort()).resolves.toBeUndefined()

    const aborted = await service.createGeneratedWriter({
      conversationId: 'conversation_1',
      messageId: 'message_2',
      kind: 'image',
      provider: 'openrouter',
      model: 'image-model',
      name: 'aborted.png',
    })
    await aborted.abort()
    await expect(aborted.appendBase64Chunk('AAAA')).rejects.toMatchObject({ code: 'MEDIA_GENERATION_FAILED' })
    await expect(aborted.commit()).rejects.toMatchObject({ code: 'MEDIA_GENERATION_FAILED' })
    await expect(aborted.abort()).resolves.toBeUndefined()
  })

  it('serializes concurrent Base64 appends in call order before commit', async () => {
    const service = createMediaAssetService({ database, mediaRoot, id: () => 'asset_concurrent' })
    const writer = await service.createGeneratedWriter({
      conversationId: 'conversation_1',
      messageId: 'message_1',
      kind: 'image',
      provider: 'openrouter',
      model: 'image-model',
      name: 'concurrent.png',
    })
    const encoded = png.toString('base64')
    const appends = [
      writer.appendBase64Chunk(encoded.slice(0, 3)),
      writer.appendBase64Chunk(encoded.slice(3, 9)),
      writer.appendBase64Chunk(encoded.slice(9)),
    ]
    const committing = writer.commit()
    await Promise.all(appends)
    await committing

    expect(await readFile(join(mediaRoot, 'conversation_1', 'asset_concurrent.png'))).toEqual(png)
  })
})

describe('MediaAssetService staging failures', () => {
  const operations = [
    ['clipboard import', (service: ReturnType<typeof createMediaAssetService>) => service.importClipboardImage({
      conversationId: 'conversation_1',
      existingAssetIds: [],
      bytes: png,
      mimeType: 'image/png',
      name: 'clipboard.png',
    }), 'MEDIA_IMPORT_FAILED'],
    ['generated stream', (service: ReturnType<typeof createMediaAssetService>) => service.commitGeneratedStream({
      conversationId: 'conversation_1',
      messageId: 'message_1',
      kind: 'image',
      provider: 'openrouter',
      model: 'image-model',
      name: 'stream.png',
      stream: (async function* () { yield png })(),
    }), 'MEDIA_GENERATION_FAILED'],
    ['Base64 writer', (service: ReturnType<typeof createMediaAssetService>) => service.createGeneratedWriter({
      conversationId: 'conversation_1',
      messageId: 'message_1',
      kind: 'image',
      provider: 'openrouter',
      model: 'image-model',
      name: 'writer.png',
    }), 'MEDIA_GENERATION_FAILED'],
  ] as const

  it.each([
    ['clipboard mkdir ENOSPC', operations[0][1], { mkdir: async () => { throw Object.assign(new Error('secret mkdir path'), { code: 'ENOSPC' }) } }],
    ['stream realpath EDQUOT', operations[1][1], { realpath: async () => { throw Object.assign(new Error('secret realpath'), { code: 'EDQUOT' }) } }],
    ['writer staging open ENOSPC', operations[2][1], { open: async () => { throw Object.assign(new Error('secret staging path'), { code: 'ENOSPC' }) } }],
  ] as const)('maps %s to the fixed storage-full error', async (_label, operation, filesystem) => {
    const service = createMediaAssetService({ database, mediaRoot, filesystem })
    await expect(operation(service)).rejects.toEqual({
      code: 'MEDIA_STORAGE_FULL',
      message: 'There is not enough local storage for this media.',
    })
  })

  it.each(operations)('sanitizes a raw staging-path failure for %s', async (_label, operation, code) => {
    const invalidRoot = join(root, 'media-root-is-a-file')
    await writeFile(invalidRoot, 'not a directory')
    const service = createMediaAssetService({ database, mediaRoot: invalidRoot })

    const error = await operation(service).then(
      () => undefined,
      (reason: unknown) => reason,
    )
    expect(error).toMatchObject({ code })
    expect(JSON.stringify(error)).not.toContain(invalidRoot)
  })
})

describe('MediaAssetService ready assets', () => {
  it('fails closed when a draft conversation parent is a symlink outside the media root', async () => {
    const outside = join(root, 'outside-draft')
    const conversationPath = join(mediaRoot, 'conversation_1')
    await mkdir(outside, { recursive: true })
    await mkdir(mediaRoot, { recursive: true })
    const outsideVictim = join(outside, 'asset_escape.png')
    await writeFile(outsideVictim, png)
    await symlink(outside, conversationPath)
    insertReadyAsset('asset_escape')
    const service = createMediaAssetService({ database, mediaRoot })

    await expect(service.removeDraft('asset_escape', 'conversation_1')).rejects.toMatchObject({ code: 'MEDIA_IMPORT_FAILED' })
    expect(await readFile(outsideVictim)).toEqual(png)
    expect(database.mediaAssets.get('asset_escape')).toMatchObject({ status: 'ready' })
  })

  it('restores an outside target and leaves the asset row non-ready when the conversation parent is swapped', async () => {
    await mkdir(mediaRoot, { recursive: true })
    const canonicalMediaRoot = await realpath(mediaRoot)
    const conversationPath = join(canonicalMediaRoot, 'conversation_1')
    const parkedConversation = join(canonicalMediaRoot, 'conversation_1-parked')
    const outside = join(root, 'outside-swap')
    await mkdir(join(conversationPath, '.staging'), { recursive: true })
    await mkdir(join(outside, '.staging'), { recursive: true })
    await writeFile(join(conversationPath, 'asset_swap.png'), png)
    const outsideVictim = join(outside, 'asset_swap.png')
    await writeFile(outsideVictim, Buffer.from('outside-victim'))
    insertReadyAsset('asset_swap')
    let swapped = false
    const service = createMediaAssetService({
      database,
      mediaRoot,
      filesystem: {
        rename: async (source, destination) => {
          if (!swapped && source === join(conversationPath, 'asset_swap.png')) {
            swapped = true
            await rename(conversationPath, parkedConversation)
            await symlink(outside, conversationPath)
          }
          await rename(source, destination)
        },
      },
    })

    await expect(service.removeDraft('asset_swap', 'conversation_1')).rejects.toMatchObject({ code: 'MEDIA_IMPORT_FAILED' })
    expect(await readFile(outsideVictim)).toEqual(Buffer.from('outside-victim'))
    expect(await readFile(join(parkedConversation, 'asset_swap.png'))).toEqual(png)
    expect(database.mediaAssets.get('asset_swap')).toMatchObject({
      status: 'failed',
      relativePath: expect.stringMatching(/^\.quarantine\/.+\.delete$/),
    })
  })

  it('retains a quarantine tombstone and never deletes an outside victim after the final parent check is swapped', async () => {
    await mkdir(mediaRoot, { recursive: true })
    const canonicalMediaRoot = await realpath(mediaRoot)
    const conversationPath = join(canonicalMediaRoot, 'conversation_1')
    const stagingPath = join(conversationPath, '.staging')
    const canonicalAsset = join(conversationPath, 'asset_final_swap.png')
    const quarantineDirectory = join(canonicalMediaRoot, '.quarantine')
    const parkedQuarantine = join(canonicalMediaRoot, '.quarantine-parked')
    const outside = join(root, 'outside-final-quarantine-swap')
    await mkdir(stagingPath, { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(canonicalAsset, png)
    insertReadyAsset('asset_final_swap')
    let quarantinePath = ''
    let quarantineFileChecks = 0
    let outsideVictim = ''
    const service = createMediaAssetService({
      database,
      mediaRoot,
      filesystem: {
        rename: async (source, destination) => {
          if (source === canonicalAsset) quarantinePath = destination
          await rename(source, destination)
        },
        realpath: async (path) => {
          const canonical = await realpath(path)
          if (quarantinePath && path === quarantinePath) {
            quarantineFileChecks += 1
            if (quarantineFileChecks === 2) {
              await rename(quarantineDirectory, parkedQuarantine)
              await symlink(outside, quarantineDirectory)
              outsideVictim = join(outside, basename(quarantinePath))
              await writeFile(outsideVictim, 'outside-victim')
            }
          }
          return canonical
        },
      },
    })

    await expect(service.removeDraft('asset_final_swap', 'conversation_1'))
      .rejects.toMatchObject({ code: 'MEDIA_IMPORT_FAILED' })
    expect(quarantineFileChecks).toBe(2)
    expect(await readFile(outsideVictim, 'utf8')).toBe('outside-victim')
    expect(await exists(canonicalAsset)).toBe(false)
    expect(await readFile(join(parkedQuarantine, basename(quarantinePath)))).toEqual(png)
    expect(database.mediaAssets.get('asset_final_swap')).toMatchObject({
      status: 'failed',
      relativePath: `.quarantine/${basename(quarantinePath)}`,
    })
  })

  it('restores a substituted target and leaves the lost-identity asset row non-ready', async () => {
    await mkdir(mediaRoot, { recursive: true })
    const canonicalMediaRoot = await realpath(mediaRoot)
    const conversationPath = join(canonicalMediaRoot, 'conversation_1')
    const stagingPath = join(conversationPath, '.staging')
    const target = join(conversationPath, 'asset_substitute.png')
    const parked = join(conversationPath, 'original-parked.png')
    await mkdir(stagingPath, { recursive: true })
    await writeFile(target, png)
    insertReadyAsset('asset_substitute')
    let substituted = false
    const service = createMediaAssetService({
      database,
      mediaRoot,
      filesystem: {
        rename: async (source, destination) => {
          if (!substituted && source === target) {
            substituted = true
            await rename(source, parked)
            await writeFile(source, 'substitute')
          }
          await rename(source, destination)
        },
      },
    })

    await expect(service.removeDraft('asset_substitute', 'conversation_1')).rejects.toMatchObject({ code: 'MEDIA_IMPORT_FAILED' })
    expect(await readFile(parked)).toEqual(png)
    expect(await readFile(target, 'utf8')).toBe('substitute')
    expect(database.mediaAssets.get('asset_substitute')).toMatchObject({
      status: 'failed',
      relativePath: expect.stringMatching(/^\.quarantine\/.+\.delete$/),
    })
  })

  it('does not follow a swapped conversation parent while cleaning orphan staging files', async () => {
    await mkdir(mediaRoot, { recursive: true })
    const canonicalMediaRoot = await realpath(mediaRoot)
    const conversationPath = join(canonicalMediaRoot, 'conversation_1')
    const parkedConversation = join(canonicalMediaRoot, 'conversation_1-parked')
    const stagingPath = join(conversationPath, '.staging')
    const outside = join(root, 'outside-staging')
    const outsideStaging = join(outside, '.staging')
    await mkdir(stagingPath, { recursive: true })
    await mkdir(outsideStaging, { recursive: true })
    const managedOrphan = join(stagingPath, 'managed.part')
    const outsideVictim = join(outsideStaging, 'outside.part')
    await writeFile(managedOrphan, 'managed')
    await writeFile(outsideVictim, 'outside')
    await utimes(managedOrphan, new Date(1), new Date(1))
    await utimes(outsideVictim, new Date(1), new Date(1))
    let swapped = false
    const service = createMediaAssetService({
      database,
      mediaRoot,
      filesystem: {
        lstat: async (path) => {
          if (!swapped && path === stagingPath) {
            swapped = true
            await rename(conversationPath, parkedConversation)
            await symlink(outside, conversationPath)
          }
          return lstat(path)
        },
      },
    })

    await service.cleanupDrafts(100)
    expect(await readFile(outsideVictim, 'utf8')).toBe('outside')
    expect(await readFile(join(parkedConversation, '.staging', 'managed.part'), 'utf8')).toBe('managed')
  })

  it('keeps claimed drafts ready when a claim wins the delete race', async () => {
    const serviceForImport = createMediaAssetService({ database, mediaRoot, id: () => 'asset_claim_race' })
    await serviceForImport.importClipboardImage({
      conversationId: 'conversation_1',
      existingAssetIds: [],
      bytes: png,
      mimeType: 'image/png',
      name: 'claim.png',
    })
    const baseMediaAssets = database.mediaAssets
    let claimed = false
    const service = createMediaAssetService({
      database: {
        mediaAssets: {
          ...baseMediaAssets,
          update: (id, patch) => {
            if (!claimed && patch.status === 'deleting') {
              claimed = true
              claimAsset(id)
            }
            return baseMediaAssets.update(id, patch)
          },
        },
      },
      mediaRoot,
    })

    await expect(service.removeDraft('asset_claim_race', 'conversation_1')).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(database.mediaAssets.get('asset_claim_race')).toMatchObject({
      status: 'ready',
      messageId: 'message_asset_claim_race',
    })
    expect(await readFile(join(mediaRoot, 'conversation_1', 'asset_claim_race.png'))).toEqual(png)
  })

  it('does not remove a draft through a mismatched conversation context', async () => {
    database.conversations.insert({ id: 'conversation_2', title: 'Other' })
    const service = createMediaAssetService({ database, mediaRoot, id: () => 'asset_other_draft' })
    await service.importClipboardImage({
      conversationId: 'conversation_2',
      existingAssetIds: [],
      bytes: png,
      mimeType: 'image/png',
      name: 'other.png',
    })

    await expect(service.removeDraft('asset_other_draft', 'conversation_1'))
      .rejects.toMatchObject({ code: 'MEDIA_ASSET_UNAVAILABLE' })
    expect(database.mediaAssets.get('asset_other_draft')).toMatchObject({
      conversationId: 'conversation_2',
      status: 'ready',
    })
    expect(await readFile(join(mediaRoot, 'conversation_2', 'asset_other_draft.png'))).toEqual(png)
  })

  it('rejects draft removal when the conversation context is omitted', async () => {
    database.conversations.insert({ id: 'conversation_2', title: 'Other' })
    const service = createMediaAssetService({ database, mediaRoot, id: () => 'asset_context_required' })
    await service.importClipboardImage({
      conversationId: 'conversation_2',
      existingAssetIds: [],
      bytes: png,
      mimeType: 'image/png',
      name: 'owned.png',
    })
    const removeWithoutConversation = service.removeDraft as unknown as (assetId: string) => Promise<void>

    await expect(removeWithoutConversation('asset_context_required'))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(database.mediaAssets.get('asset_context_required')).toMatchObject({
      conversationId: 'conversation_2',
      status: 'ready',
    })
    expect(await readFile(join(mediaRoot, 'conversation_2', 'asset_context_required.png'))).toEqual(png)
  })

  it('restores canonical bytes and the ready row when database deletion fails', async () => {
    const importer = createMediaAssetService({ database, mediaRoot, id: () => 'asset_remove_delete_failure' })
    await importer.importClipboardImage({
      conversationId: 'conversation_1',
      existingAssetIds: [],
      bytes: png,
      mimeType: 'image/png',
      name: 'remove.png',
    })
    const baseMediaAssets = database.mediaAssets
    const service = createMediaAssetService({
      database: {
        mediaAssets: {
          ...baseMediaAssets,
          delete: () => {
            throw new Error('delete failed')
          },
        },
      },
      mediaRoot,
    })

    await expect(service.removeDraft('asset_remove_delete_failure', 'conversation_1'))
      .rejects.toMatchObject({ code: 'MEDIA_IMPORT_FAILED' })
    expect(database.mediaAssets.get('asset_remove_delete_failure')).toMatchObject({
      status: 'ready',
      relativePath: 'conversation_1/asset_remove_delete_failure.png',
    })
    expect(await readFile(join(mediaRoot, 'conversation_1', 'asset_remove_delete_failure.png'))).toEqual(png)
  })

  it('cleans safe drafts while retaining a symlink-substituted entry and its outside target', async () => {
    const ids = ['asset_unsafe_cleanup', 'asset_safe_cleanup']
    const service = createMediaAssetService({ database, mediaRoot, id: () => ids.shift()!, now: () => 1 })
    for (const name of ['unsafe.png', 'safe.png']) {
      await service.importClipboardImage({
        conversationId: 'conversation_1',
        existingAssetIds: [],
        bytes: png,
        mimeType: 'image/png',
        name,
      })
    }
    const outside = join(root, 'outside-cleanup.png')
    const unsafe = join(await realpath(mediaRoot), 'conversation_1', 'asset_unsafe_cleanup.png')
    await writeFile(outside, 'outside')
    await rm(unsafe)
    await symlink(outside, unsafe)

    await service.cleanupDrafts(2)
    expect(await readFile(outside, 'utf8')).toBe('outside')
    expect(database.mediaAssets.get('asset_unsafe_cleanup')).toMatchObject({ status: 'ready' })
    expect(database.mediaAssets.get('asset_safe_cleanup')).toBeUndefined()
  })

  it.each(['staging', 'failed'] as const)('removes a stale %s row whose final file is missing', async (status) => {
    const stagingPath = join(mediaRoot, 'conversation_1', '.staging')
    const assetId = `asset_${status}_missing`
    const orphanPath = join(stagingPath, `${status}-before-rename.part`)
    await mkdir(stagingPath, { recursive: true })
    await writeFile(orphanPath, png)
    await utimes(orphanPath, new Date(1), new Date(1))
    database.mediaAssets.insert({
      id: assetId,
      conversationId: 'conversation_1',
      source: 'upload',
      kind: 'image',
      originalName: 'crash.png',
      relativePath: `conversation_1/${assetId}.png`,
      status,
      createdAt: 1,
      updatedAt: 1,
    })
    const service = createMediaAssetService({ database, mediaRoot })

    await service.cleanupDrafts(100)

    expect(database.mediaAssets.get(assetId)).toBeUndefined()
    expect(await exists(orphanPath)).toBe(false)
    const tombstones = await readdir(join(mediaRoot, '.quarantine'))
    expect(tombstones).toHaveLength(1)
    expect(await readFile(join(mediaRoot, '.quarantine', tombstones[0]!))).toEqual(png)
  })

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

  it('rejects duplicate, wrong-conversation, and symlinked model inputs while preserving requested order', async () => {
    database.conversations.insert({ id: 'conversation_2', title: 'Other' })
    const ids = ['asset_first', 'asset_second', 'asset_other']
    const service = createMediaAssetService({ database, mediaRoot, id: () => ids.shift()! })
    for (const conversationId of ['conversation_1', 'conversation_1', 'conversation_2']) {
      await service.importClipboardImage({
        conversationId,
        existingAssetIds: [],
        bytes: png,
        mimeType: 'image/png',
        name: `${conversationId}.png`,
      })
    }

    const ordered = await service.modelInput('conversation_1', ['asset_second', 'asset_first'])
    expect(ordered.map(({ assetId }) => assetId)).toEqual(['asset_second', 'asset_first'])
    await expect(service.modelInput('conversation_1', ['asset_first', 'asset_first']))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(service.modelInput('conversation_1', ['asset_other']))
      .rejects.toMatchObject({ code: 'MEDIA_ASSET_UNAVAILABLE' })

    const firstPath = join(await realpath(mediaRoot), 'conversation_1', 'asset_first.png')
    const outside = join(root, 'outside-model.png')
    await writeFile(outside, png)
    await rm(firstPath)
    await symlink(outside, firstPath)
    await expect(service.modelInput('conversation_1', ['asset_first']))
      .rejects.toMatchObject({ code: 'MEDIA_ASSET_UNAVAILABLE' })
    expect(await readFile(outside)).toEqual(png)
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
