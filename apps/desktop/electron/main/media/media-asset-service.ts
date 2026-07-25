import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises'
import { basename, isAbsolute, join, posix, resolve, sep } from 'node:path'
import {
  appErrorCodeSchema,
  toSafeAppError,
  type AppError,
  type AppErrorCode,
  type MediaAsset,
  type ModelProviderId,
} from '@autoforge/shared'
import type { MediaAssetPatch, MediaAssetRecord } from '../database/repositories.js'
import { detectMediaType, type DetectedMedia } from './media-sniffer.js'

export const MEDIA_LIMITS = {
  attachments: 5,
  imageBytes: 20 * 1024 * 1024,
  audioBytes: 50 * 1024 * 1024,
  videoBytes: 200 * 1024 * 1024,
  requestBytes: 250 * 1024 * 1024,
  generatedBytes: 500 * 1024 * 1024,
} as const

const MAX_SNIFF_BYTES = 64 * 1024
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const SAFE_EXTENSIONS = new Set(['png', 'jpg', 'webp', 'gif', 'avif', 'svg', 'mp3', 'wav', 'ogg', 'flac', 'm4a', 'mp4', 'webm', 'mov'])
const MAX_ENCODED_GENERATED_BYTES = Math.ceil(MEDIA_LIMITS.generatedBytes / 3) * 4

export interface MediaImportPathsInput {
  conversationId: string
  existingAssetIds: string[]
  paths: string[]
}

export interface MediaImportBytesInput {
  conversationId: string
  existingAssetIds: string[]
  bytes: Uint8Array
  mimeType: 'image/png'
  name: string
}

export interface ResolvedMediaAsset extends MediaAsset {
  conversationId: string
  absolutePath: string
  relativePath: string
  inlineSafe: boolean
}

export interface ModelMediaInput {
  assetId: string
  kind: 'image' | 'audio' | 'video'
  mimeType: string
  dataBase64: string
}

export interface GeneratedWriterInput {
  conversationId: string
  messageId: string
  kind: 'image' | 'audio' | 'video'
  provider: ModelProviderId
  model: string
  name: string
}

export interface GeneratedAssetWriter {
  appendBase64Chunk(chunk: string): Promise<void>
  commit(): Promise<MediaAsset>
  abort(): Promise<void>
}

export interface GeneratedBase64Input extends GeneratedWriterInput {
  dataBase64: string
  declaredMimeType?: string
}

export interface GeneratedStreamInput extends GeneratedWriterInput {
  stream: AsyncIterable<Uint8Array>
  declaredMimeType?: string
}

export interface MediaAssetService {
  importPaths(input: MediaImportPathsInput): Promise<MediaAsset[]>
  importClipboardImage(input: MediaImportBytesInput): Promise<MediaAsset[]>
  removeDraft(assetId: string): Promise<void>
  resolveReadyAsset(assetId: string, conversationId?: string): Promise<ResolvedMediaAsset>
  modelInput(conversationId: string, assetIds: string[]): Promise<ModelMediaInput[]>
  createGeneratedWriter(input: GeneratedWriterInput): Promise<GeneratedAssetWriter>
  commitGeneratedBase64(input: GeneratedBase64Input): Promise<MediaAsset>
  commitGeneratedStream(input: GeneratedStreamInput): Promise<MediaAsset>
  cleanupDrafts(olderThan: number): Promise<void>
}

interface MediaAssetRepository {
  insert(value: MediaAssetRecord): MediaAssetRecord
  get(id: string): MediaAssetRecord | undefined
  listForConversation(conversationId: string): MediaAssetRecord[]
  listUnclaimedBefore(timestamp: number): MediaAssetRecord[]
  update(id: string, patch: MediaAssetPatch): MediaAssetRecord | undefined
  delete(id: string): void
}

export interface MediaAssetServiceDatabase {
  mediaAssets: MediaAssetRepository
}

export interface CreateMediaAssetServiceOptions {
  database: MediaAssetServiceDatabase
  mediaRoot: string
  id?: () => string
  now?: () => number
}

interface StagedMedia {
  path: string
  byteSize: number
  sha256: string
  detected: DetectedMedia
}

interface StableFile {
  dev: number | bigint
  ino: number | bigint
  size: number
  mtimeMs: number
  ctimeMs: number
}

function failure(code: AppErrorCode): AppError {
  return toSafeAppError({ code })
}

function mappedFailure(error: unknown, fallback: AppErrorCode): AppError {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (code === 'ENOSPC' || code === 'EDQUOT') return failure('MEDIA_STORAGE_FULL')
    if (appErrorCodeSchema.safeParse(code).success) return toSafeAppError(error)
  }
  return failure(fallback)
}

function assertIdentifier(value: string): void {
  if (!ID_PATTERN.test(value)) throw failure('INVALID_INPUT')
}

function displayName(value: string): string {
  if (/^(?:data:|https?:\/\/)/i.test(value.trim())) return 'media'
  const name = [...basename(value)]
    .filter((character) => character.charCodeAt(0) >= 0x20 && character.charCodeAt(0) !== 0x7f)
    .join('')
    .trim()
  return name.slice(0, 255) || 'media'
}

function publicAsset(record: MediaAssetRecord): MediaAsset {
  if (record.status !== 'ready' || !record.mimeType || record.byteSize === undefined) {
    throw failure('MEDIA_ASSET_UNAVAILABLE')
  }
  return {
    id: record.id,
    kind: record.kind,
    mimeType: record.mimeType,
    name: record.originalName,
    byteSize: record.byteSize,
    ...(record.width === undefined ? {} : { width: record.width }),
    ...(record.height === undefined ? {} : { height: record.height }),
    ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
  }
}

function byteLimit(kind: DetectedMedia['kind']): number {
  if (kind === 'image') return MEDIA_LIMITS.imageBytes
  if (kind === 'audio') return MEDIA_LIMITS.audioBytes
  return MEDIA_LIMITS.videoBytes
}

function snapshot(stat: StableFile): StableFile {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  }
}

function sameFile(left: StableFile, right: StableFile): boolean {
  return (
    left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
  )
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, bytes: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset)
    if (bytesWritten <= 0) throw new Error('Media staging write made no progress')
    offset += bytesWritten
  }
}

async function readPrefix(handle: Awaited<ReturnType<typeof open>>, size: number): Promise<Buffer> {
  const prefix = Buffer.alloc(Math.min(size, MAX_SNIFF_BYTES))
  let offset = 0
  while (offset < prefix.byteLength) {
    const { bytesRead } = await handle.read(prefix, offset, prefix.byteLength - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  return prefix.subarray(0, offset)
}

export function createMediaAssetService(options: CreateMediaAssetServiceOptions): MediaAssetService {
  const database = options.database
  const configuredRoot = resolve(options.mediaRoot)
  const createId = options.id ?? randomUUID
  const now = options.now ?? Date.now
  let rootPromise: Promise<string> | undefined

  const controlledId = () => {
    const id = createId()
    assertIdentifier(id)
    return id
  }

  const mediaRoot = async () => {
    rootPromise ??= (async () => {
      await mkdir(configuredRoot, { recursive: true })
      return realpath(configuredRoot)
    })()
    return rootPromise
  }

  const conversationDirectories = async (conversationId: string) => {
    assertIdentifier(conversationId)
    const root = await mediaRoot()
    const conversationPath = join(root, conversationId)
    await mkdir(conversationPath, { recursive: true })
    if (await realpath(conversationPath) !== conversationPath) throw failure('MEDIA_IMPORT_FAILED')
    const stagingPath = join(conversationPath, '.staging')
    await mkdir(stagingPath, { recursive: true })
    if (await realpath(stagingPath) !== stagingPath) throw failure('MEDIA_IMPORT_FAILED')
    return { root, conversationPath, stagingPath }
  }

  const newStage = async (conversationId: string) => {
    const directories = await conversationDirectories(conversationId)
    const path = join(directories.stagingPath, `${randomUUID()}.part`)
    const handle = await open(path, 'wx', 0o600)
    return { ...directories, path, handle }
  }

  const existingRequestBytes = (conversationId: string, assetIds: readonly string[]) => {
    const unique = new Set(assetIds)
    if (unique.size !== assetIds.length) throw failure('INVALID_INPUT')
    let total = 0
    for (const assetId of assetIds) {
      assertIdentifier(assetId)
      const record = database.mediaAssets.get(assetId)
      if (
        !record
        || record.conversationId !== conversationId
        || record.status !== 'ready'
        || record.byteSize === undefined
        || record.byteSize > byteLimit(record.kind)
      ) throw failure('MEDIA_ASSET_UNAVAILABLE')
      total += record.byteSize
      if (total > MEDIA_LIMITS.requestBytes) throw failure('MEDIA_SIZE_LIMIT_EXCEEDED')
    }
    return total
  }

  const validateAttachmentCount = (existingAssetIds: readonly string[], added: number) => {
    if (existingAssetIds.length + added > MEDIA_LIMITS.attachments) {
      throw failure('MEDIA_ATTACHMENT_LIMIT_EXCEEDED')
    }
  }

  const safeAssetPath = async (record: MediaAssetRecord) => {
    if (!record.relativePath) throw failure('MEDIA_ASSET_UNAVAILABLE')
    assertIdentifier(record.id)
    assertIdentifier(record.conversationId)
    if (isAbsolute(record.relativePath) || record.relativePath.includes('\\')) {
      throw failure('MEDIA_ASSET_UNAVAILABLE')
    }
    const segments = record.relativePath.split('/')
    if (
      segments.length !== 2
      || segments[0] !== record.conversationId
      || !segments[1]!.startsWith(`${record.id}.`)
    ) throw failure('MEDIA_ASSET_UNAVAILABLE')
    const extension = segments[1]!.slice(record.id.length + 1)
    if (!SAFE_EXTENSIONS.has(extension)) throw failure('MEDIA_ASSET_UNAVAILABLE')
    const root = await mediaRoot()
    const absolutePath = resolve(root, ...segments)
    if (!absolutePath.startsWith(`${root}${sep}`)) throw failure('MEDIA_ASSET_UNAVAILABLE')
    return absolutePath
  }

  const removeRecordAndFiles = async (record: MediaAssetRecord) => {
    try {
      if (record.relativePath) {
        const path = await safeAssetPath(record)
        await rm(path, { force: true })
      }
    } finally {
      database.mediaAssets.delete(record.id)
    }
  }

  const commitStage = async (
    input: GeneratedWriterInput | { conversationId: string; name: string },
    source: 'upload' | 'generated',
    staged: StagedMedia,
    fallback: AppErrorCode,
  ): Promise<MediaAsset> => {
    const id = controlledId()
    const relativePath = posix.join(input.conversationId, `${id}.${staged.detected.extension}`)
    const root = await mediaRoot()
    const destination = resolve(root, ...relativePath.split('/'))
    const timestamp = now()
    const record: MediaAssetRecord = {
      id,
      conversationId: input.conversationId,
      source,
      kind: staged.detected.kind,
      mimeType: staged.detected.mimeType,
      originalName: displayName(input.name),
      relativePath,
      byteSize: staged.byteSize,
      ...(staged.detected.width === undefined ? {} : { width: staged.detected.width }),
      ...(staged.detected.height === undefined ? {} : { height: staged.detected.height }),
      sha256: staged.sha256,
      ...('provider' in input ? { provider: input.provider, model: input.model } : {}),
      status: 'staging',
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    let inserted = false
    let renamed = false
    try {
      database.mediaAssets.insert(record)
      inserted = true
      await rename(staged.path, destination)
      renamed = true
      const ready = database.mediaAssets.update(id, { status: 'ready', updatedAt: now() })
      if (!ready || ready.status !== 'ready') throw new Error('Media asset did not become ready')
      return publicAsset(ready)
    } catch (error) {
      if (inserted) {
        try {
          database.mediaAssets.delete(id)
        } catch {
          // Cleanup continues with the file; no ready result is returned.
        }
      }
      await rm(staged.path, { force: true }).catch(() => undefined)
      if (renamed) await rm(destination, { force: true }).catch(() => undefined)
      throw mappedFailure(error, fallback)
    }
  }

  const stageBytes = async (
    conversationId: string,
    bytes: Uint8Array,
    maximum: number,
    fallback: AppErrorCode,
  ): Promise<StagedMedia> => {
    if (bytes.byteLength > maximum) throw failure('MEDIA_SIZE_LIMIT_EXCEEDED')
    const detected = detectMediaType(bytes)
    if (!detected) throw failure('MEDIA_TYPE_UNSUPPORTED')
    const stage = await newStage(conversationId)
    try {
      await writeAll(stage.handle, bytes)
      await stage.handle.sync()
      await stage.handle.close()
      return {
        path: stage.path,
        byteSize: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        detected,
      }
    } catch (error) {
      await stage.handle.close().catch(() => undefined)
      await rm(stage.path, { force: true }).catch(() => undefined)
      throw mappedFailure(error, fallback)
    }
  }

  const importOnePath = async (
    conversationId: string,
    sourcePath: string,
    remainingRequestBytes: number,
  ): Promise<MediaAsset> => {
    let sourceHandle: Awaited<ReturnType<typeof open>> | undefined
    let stageHandle: Awaited<ReturnType<typeof open>> | undefined
    let stagePath: string | undefined
    try {
      const initialPathStat = await lstat(sourcePath)
      if (initialPathStat.isSymbolicLink() || !initialPathStat.isFile()) throw failure('MEDIA_IMPORT_FAILED')
      const initial = snapshot(initialPathStat)
      const initialRealPath = await realpath(sourcePath)
      sourceHandle = await open(sourcePath, 'r')
      const opened = snapshot(await sourceHandle.stat())
      if (!sameFile(initial, opened) || await realpath(sourcePath) !== initialRealPath) {
        throw failure('MEDIA_IMPORT_FAILED')
      }
      const prefix = await readPrefix(sourceHandle, opened.size)
      const detected = detectMediaType(prefix)
      if (!detected) throw failure('MEDIA_TYPE_UNSUPPORTED')
      if (opened.size > byteLimit(detected.kind) || opened.size > remainingRequestBytes) {
        throw failure('MEDIA_SIZE_LIMIT_EXCEEDED')
      }

      const stage = await newStage(conversationId)
      stageHandle = stage.handle
      stagePath = stage.path
      const hash = createHash('sha256')
      let byteSize = 0
      const stream = sourceHandle.createReadStream({ start: 0, autoClose: false })
      for await (const value of stream) {
        const chunk = value as Buffer
        byteSize += chunk.byteLength
        if (byteSize > byteLimit(detected.kind) || byteSize > remainingRequestBytes) {
          throw failure('MEDIA_SIZE_LIMIT_EXCEEDED')
        }
        hash.update(chunk)
        await writeAll(stageHandle, chunk)
      }
      if (byteSize !== opened.size) throw failure('MEDIA_IMPORT_FAILED')
      const afterHandle = snapshot(await sourceHandle.stat())
      const afterPath = await lstat(sourcePath)
      if (
        afterPath.isSymbolicLink()
        || !sameFile(opened, afterHandle)
        || !sameFile(afterHandle, snapshot(afterPath))
        || await realpath(sourcePath) !== initialRealPath
      ) throw failure('MEDIA_IMPORT_FAILED')
      await stageHandle.sync()
      await stageHandle.close()
      stageHandle = undefined
      await sourceHandle.close()
      sourceHandle = undefined
      return commitStage(
        { conversationId, name: basename(sourcePath) },
        'upload',
        { path: stagePath, byteSize, sha256: hash.digest('hex'), detected },
        'MEDIA_IMPORT_FAILED',
      )
    } catch (error) {
      await sourceHandle?.close().catch(() => undefined)
      await stageHandle?.close().catch(() => undefined)
      if (stagePath) await rm(stagePath, { force: true }).catch(() => undefined)
      throw mappedFailure(error, 'MEDIA_IMPORT_FAILED')
    }
  }

  const stageGeneratedStream = async (input: GeneratedStreamInput): Promise<StagedMedia> => {
    const stage = await newStage(input.conversationId)
    const hash = createHash('sha256')
    let byteSize = 0
    const prefixParts: Buffer[] = []
    let prefixBytes = 0
    try {
      for await (const value of input.stream) {
        if (!(value instanceof Uint8Array)) throw failure('MEDIA_GENERATION_FAILED')
        if (byteSize + value.byteLength > MEDIA_LIMITS.generatedBytes) {
          throw failure('MEDIA_SIZE_LIMIT_EXCEEDED')
        }
        const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
        byteSize += chunk.byteLength
        if (prefixBytes < MAX_SNIFF_BYTES) {
          const part = chunk.subarray(0, MAX_SNIFF_BYTES - prefixBytes)
          prefixParts.push(part)
          prefixBytes += part.byteLength
        }
        hash.update(chunk)
        await writeAll(stage.handle, chunk)
      }
      const detected = detectMediaType(Buffer.concat(prefixParts, prefixBytes))
      if (!detected) throw failure('MEDIA_TYPE_UNSUPPORTED')
      if (detected.kind !== input.kind || (input.declaredMimeType && input.declaredMimeType !== detected.mimeType)) {
        throw failure('MEDIA_MIME_MISMATCH')
      }
      await stage.handle.sync()
      await stage.handle.close()
      return { path: stage.path, byteSize, sha256: hash.digest('hex'), detected }
    } catch (error) {
      await stage.handle.close().catch(() => undefined)
      await rm(stage.path, { force: true }).catch(() => undefined)
      throw mappedFailure(error, 'MEDIA_GENERATION_FAILED')
    }
  }

  const inspectReady = async (record: MediaAssetRecord, includeBytes: boolean) => {
    if (
      record.status !== 'ready'
      || !record.mimeType
      || record.byteSize === undefined
      || !record.sha256
    ) throw failure('MEDIA_ASSET_UNAVAILABLE')
    const absolutePath = await safeAssetPath(record)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      const pathStat = await lstat(absolutePath)
      if (pathStat.isSymbolicLink() || !pathStat.isFile()) throw failure('MEDIA_ASSET_UNAVAILABLE')
      const before = snapshot(pathStat)
      const canonical = await realpath(absolutePath)
      if (canonical !== absolutePath) throw failure('MEDIA_ASSET_UNAVAILABLE')
      handle = await open(absolutePath, 'r')
      const opened = snapshot(await handle.stat())
      if (!sameFile(before, opened) || opened.size !== record.byteSize) throw failure('MEDIA_ASSET_UNAVAILABLE')
      const hash = createHash('sha256')
      const chunks: Buffer[] = []
      const prefixParts: Buffer[] = []
      let prefixBytes = 0
      let byteSize = 0
      for await (const value of handle.createReadStream({ start: 0, autoClose: false })) {
        const chunk = value as Buffer
        byteSize += chunk.byteLength
        if (byteSize > record.byteSize || byteSize > byteLimit(record.kind)) {
          throw failure('MEDIA_ASSET_UNAVAILABLE')
        }
        hash.update(chunk)
        if (includeBytes) chunks.push(chunk)
        if (prefixBytes < MAX_SNIFF_BYTES) {
          const part = chunk.subarray(0, MAX_SNIFF_BYTES - prefixBytes)
          prefixParts.push(part)
          prefixBytes += part.byteLength
        }
      }
      const after = snapshot(await handle.stat())
      const afterPath = await lstat(absolutePath)
      if (
        byteSize !== record.byteSize
        || hash.digest('hex') !== record.sha256
        || !sameFile(opened, after)
        || afterPath.isSymbolicLink()
        || !sameFile(after, snapshot(afterPath))
        || await realpath(absolutePath) !== canonical
      ) throw failure('MEDIA_ASSET_UNAVAILABLE')
      const detected = detectMediaType(Buffer.concat(prefixParts, prefixBytes))
      if (!detected || detected.kind !== record.kind || detected.mimeType !== record.mimeType) {
        throw failure('MEDIA_ASSET_UNAVAILABLE')
      }
      return {
        absolutePath,
        detected,
        ...(includeBytes ? { bytes: Buffer.concat(chunks, byteSize) } : {}),
      }
    } catch (error) {
      throw mappedFailure(error, 'MEDIA_ASSET_UNAVAILABLE')
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  const service: MediaAssetService = {
    async importPaths(input) {
      assertIdentifier(input.conversationId)
      validateAttachmentCount(input.existingAssetIds, input.paths.length)
      const existingBytes = existingRequestBytes(input.conversationId, input.existingAssetIds)
      let preflightBytes = existingBytes
      for (const path of input.paths) {
        const metadata = await lstat(path).catch((error: unknown) => { throw mappedFailure(error, 'MEDIA_IMPORT_FAILED') })
        if (metadata.isSymbolicLink() || !metadata.isFile()) throw failure('MEDIA_IMPORT_FAILED')
        preflightBytes += metadata.size
        if (preflightBytes > MEDIA_LIMITS.requestBytes) throw failure('MEDIA_SIZE_LIMIT_EXCEEDED')
      }
      const imported: MediaAsset[] = []
      let importedBytes = existingBytes
      try {
        for (const path of input.paths) {
          const asset = await importOnePath(
            input.conversationId,
            path,
            MEDIA_LIMITS.requestBytes - importedBytes,
          )
          imported.push(asset)
          importedBytes += asset.byteSize
        }
        return imported
      } catch (error) {
        await Promise.all(imported.map(async ({ id }) => {
          const record = database.mediaAssets.get(id)
          if (record) await removeRecordAndFiles(record).catch(() => undefined)
        }))
        throw mappedFailure(error, 'MEDIA_IMPORT_FAILED')
      }
    },

    async importClipboardImage(input) {
      assertIdentifier(input.conversationId)
      validateAttachmentCount(input.existingAssetIds, 1)
      const existingBytes = existingRequestBytes(input.conversationId, input.existingAssetIds)
      if (input.bytes.byteLength + existingBytes > MEDIA_LIMITS.requestBytes) {
        throw failure('MEDIA_SIZE_LIMIT_EXCEEDED')
      }
      const staged = await stageBytes(input.conversationId, input.bytes, MEDIA_LIMITS.imageBytes, 'MEDIA_IMPORT_FAILED')
      if (staged.detected.kind !== 'image' || staged.detected.mimeType !== input.mimeType) {
        await rm(staged.path, { force: true }).catch(() => undefined)
        throw failure('MEDIA_MIME_MISMATCH')
      }
      return [await commitStage(input, 'upload', staged, 'MEDIA_IMPORT_FAILED')]
    },

    async removeDraft(assetId) {
      assertIdentifier(assetId)
      const record = database.mediaAssets.get(assetId)
      if (!record) return
      if (record.messageId) throw failure('CONFLICT')
      try {
        database.mediaAssets.update(assetId, { status: 'deleting', updatedAt: now() })
        await removeRecordAndFiles(record)
      } catch (error) {
        throw mappedFailure(error, 'MEDIA_IMPORT_FAILED')
      }
    },

    async resolveReadyAsset(assetId, conversationId) {
      assertIdentifier(assetId)
      if (conversationId !== undefined) assertIdentifier(conversationId)
      const record = database.mediaAssets.get(assetId)
      if (!record || (conversationId !== undefined && record.conversationId !== conversationId)) {
        throw failure('MEDIA_ASSET_UNAVAILABLE')
      }
      const inspected = await inspectReady(record, false)
      return {
        ...publicAsset(record),
        conversationId: record.conversationId,
        absolutePath: inspected.absolutePath,
        relativePath: record.relativePath!,
        inlineSafe: inspected.detected.inlineSafe,
      }
    },

    async modelInput(conversationId, assetIds) {
      assertIdentifier(conversationId)
      validateAttachmentCount([], assetIds.length)
      if (new Set(assetIds).size !== assetIds.length) throw failure('INVALID_INPUT')
      const records: MediaAssetRecord[] = []
      let total = 0
      for (const assetId of assetIds) {
        assertIdentifier(assetId)
        const record = database.mediaAssets.get(assetId)
        if (
          !record
          || record.conversationId !== conversationId
          || record.status !== 'ready'
          || record.byteSize === undefined
          || record.byteSize > byteLimit(record.kind)
        ) throw failure('MEDIA_ASSET_UNAVAILABLE')
        records.push(record)
        total += record.byteSize
        if (total > MEDIA_LIMITS.requestBytes) throw failure('MEDIA_SIZE_LIMIT_EXCEEDED')
      }
      const output: ModelMediaInput[] = []
      for (const record of records) {
        const inspected = await inspectReady(record, true)
        output.push({
          assetId: record.id,
          kind: record.kind,
          mimeType: record.mimeType!,
          dataBase64: inspected.bytes!.toString('base64'),
        })
      }
      return output
    },

    async createGeneratedWriter(input) {
      assertIdentifier(input.conversationId)
      assertIdentifier(input.messageId)
      if (!input.model.trim() || !input.name.trim()) throw failure('INVALID_INPUT')
      const declaredMimeType = (input as GeneratedWriterInput & { declaredMimeType?: string }).declaredMimeType
      const stage = await newStage(input.conversationId).catch((error: unknown) => {
        throw mappedFailure(error, 'MEDIA_GENERATION_FAILED')
      })
      const hash = createHash('sha256')
      let byteSize = 0
      let encodedCharacters = 0
      let pending = ''
      let sawPadding = false
      let state: 'open' | 'failed' | 'committing' | 'done' = 'open'
      let tail = Promise.resolve()

      const cleanup = async () => {
        await stage.handle.close().catch(() => undefined)
        await rm(stage.path, { force: true }).catch(() => undefined)
      }

      const writeDecoded = async (encoded: string) => {
        const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')
        const bytes = Buffer.from(padded, 'base64')
        const canonical = bytes.toString('base64')
        const matches = encoded.includes('=')
          ? canonical === encoded
          : canonical.replace(/=+$/, '') === encoded
        if (!matches) throw failure('MEDIA_GENERATION_FAILED')
        byteSize += bytes.byteLength
        if (byteSize > MEDIA_LIMITS.generatedBytes) throw failure('MEDIA_SIZE_LIMIT_EXCEEDED')
        hash.update(bytes)
        await writeAll(stage.handle, bytes)
      }

      const append = async (chunk: string) => {
        if (state !== 'open') throw failure('MEDIA_GENERATION_FAILED')
        if (!chunk) return
        encodedCharacters += chunk.length
        if (encodedCharacters > MAX_ENCODED_GENERATED_BYTES || !/^[A-Za-z0-9+/=]+$/.test(chunk)) {
          throw failure(encodedCharacters > MAX_ENCODED_GENERATED_BYTES ? 'MEDIA_SIZE_LIMIT_EXCEEDED' : 'MEDIA_GENERATION_FAILED')
        }
        if (sawPadding) throw failure('MEDIA_GENERATION_FAILED')
        pending += chunk
        while (pending.length >= 4) {
          const quartet = pending.slice(0, 4)
          pending = pending.slice(4)
          if (/^[A-Za-z0-9+/]{4}$/.test(quartet)) {
            await writeDecoded(quartet)
            continue
          }
          if (!/^(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/.test(quartet) || pending.length > 0) {
            throw failure('MEDIA_GENERATION_FAILED')
          }
          sawPadding = true
          await writeDecoded(quartet)
        }
      }

      return {
        appendBase64Chunk(chunk) {
          const operation = tail.then(() => append(chunk))
          tail = operation.catch(async () => {
            state = 'failed'
            await cleanup()
          })
          return operation.catch((error: unknown) => { throw mappedFailure(error, 'MEDIA_GENERATION_FAILED') })
        },

        async commit() {
          await tail
          if (state !== 'open') throw failure('MEDIA_GENERATION_FAILED')
          state = 'committing'
          try {
            if (pending.length === 1 || (sawPadding && pending.length > 0) || !/^[A-Za-z0-9+/]{0,3}$/.test(pending)) {
              throw failure('MEDIA_GENERATION_FAILED')
            }
            if (pending.length > 0) await writeDecoded(pending)
            await stage.handle.sync()
            await stage.handle.close()
            const handle = await open(stage.path, 'r')
            const prefix = await readPrefix(handle, byteSize)
            await handle.close()
            const detected = detectMediaType(prefix)
            if (!detected) throw failure('MEDIA_TYPE_UNSUPPORTED')
            if (
              detected.kind !== input.kind
              || (declaredMimeType !== undefined && declaredMimeType !== detected.mimeType)
            ) throw failure('MEDIA_MIME_MISMATCH')
            const asset = await commitStage(input, 'generated', {
              path: stage.path,
              byteSize,
              sha256: hash.digest('hex'),
              detected,
            }, 'MEDIA_GENERATION_FAILED')
            state = 'done'
            return asset
          } catch (error) {
            state = 'failed'
            await cleanup()
            throw mappedFailure(error, 'MEDIA_GENERATION_FAILED')
          }
        },

        async abort() {
          if (state === 'done') return
          state = 'failed'
          await tail.catch(() => undefined)
          await cleanup()
        },
      }
    },

    async commitGeneratedBase64(input) {
      if (input.dataBase64.length > MAX_ENCODED_GENERATED_BYTES) {
        throw failure('MEDIA_SIZE_LIMIT_EXCEEDED')
      }
      const writer = await service.createGeneratedWriter(input)
      try {
        await writer.appendBase64Chunk(input.dataBase64)
        return await writer.commit()
      } catch (error) {
        await writer.abort()
        throw mappedFailure(error, 'MEDIA_GENERATION_FAILED')
      }
    },

    async commitGeneratedStream(input) {
      const staged = await stageGeneratedStream(input)
      return commitStage(input, 'generated', staged, 'MEDIA_GENERATION_FAILED')
    },

    async cleanupDrafts(olderThan) {
      if (!Number.isFinite(olderThan) || olderThan < 0) throw failure('INVALID_INPUT')
      for (const record of database.mediaAssets.listUnclaimedBefore(olderThan)) {
        await service.removeDraft(record.id)
      }
      const root = await mediaRoot()
      const conversations = await readdir(root, { withFileTypes: true })
      for (const conversation of conversations) {
        if (!conversation.isDirectory() || !ID_PATTERN.test(conversation.name)) continue
        const stagingPath = join(root, conversation.name, '.staging')
        let stagingStat
        try {
          stagingStat = await lstat(stagingPath)
        } catch {
          continue
        }
        if (stagingStat.isSymbolicLink() || !stagingStat.isDirectory()) continue
        for (const entry of await readdir(stagingPath, { withFileTypes: true })) {
          if (!entry.isFile()) continue
          const path = join(stagingPath, entry.name)
          const metadata = await lstat(path)
          if (!metadata.isSymbolicLink() && metadata.mtimeMs < olderThan) await rm(path, { force: true })
        }
      }
    },
  }

  return service
}
