import { createHash, randomUUID } from 'node:crypto'
import type { Dirent, Stats } from 'node:fs'
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
} from 'node:fs/promises'
import { basename, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
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
const BASE64_BATCH_CHARACTERS = 64 * 1024

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
  removeDraft(assetId: string, conversationId: string): Promise<void>
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
  filesystem?: Partial<MediaAssetFileSystem>
}

export interface MediaAssetFileSystem {
  lstat(path: string): Promise<Stats>
  mkdir(path: string, options: { recursive: true }): Promise<string | undefined>
  open(path: string, flags: string, mode?: number): Promise<FileHandle>
  readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>
  realpath(path: string): Promise<string>
  rename(source: string, destination: string): Promise<void>
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
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw failure('INVALID_INPUT')
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

function sameNode(left: StableFile, right: StableFile): boolean {
  return left.dev === right.dev && left.ino === right.ino
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
  const filesystem: MediaAssetFileSystem = {
    lstat,
    mkdir,
    open,
    readdir,
    realpath,
    rename,
    ...options.filesystem,
  }
  let rootPromise: Promise<string> | undefined

  const controlledId = () => {
    const id = createId()
    assertIdentifier(id)
    return id
  }

  const mediaRoot = async () => {
    rootPromise ??= (async () => {
      await filesystem.mkdir(configuredRoot, { recursive: true })
      return filesystem.realpath(configuredRoot)
    })()
    return rootPromise
  }

  const conversationDirectories = async (conversationId: string) => {
    assertIdentifier(conversationId)
    const root = await mediaRoot()
    const conversationPath = join(root, conversationId)
    await filesystem.mkdir(conversationPath, { recursive: true })
    if (await filesystem.realpath(conversationPath) !== conversationPath) throw failure('MEDIA_IMPORT_FAILED')
    const stagingPath = join(conversationPath, '.staging')
    await filesystem.mkdir(stagingPath, { recursive: true })
    if (await filesystem.realpath(stagingPath) !== stagingPath) throw failure('MEDIA_IMPORT_FAILED')
    return { root, conversationPath, stagingPath }
  }

  const newStage = async (conversationId: string) => {
    const directories = await conversationDirectories(conversationId)
    const path = join(directories.stagingPath, `${randomUUID()}.part`)
    const handle = await filesystem.open(path, 'wx', 0o600)
    return { ...directories, path, handle }
  }

  const mappedNewStage = async (conversationId: string, fallback: AppErrorCode) => {
    try {
      return await newStage(conversationId)
    } catch (error) {
      throw mappedFailure(error, fallback)
    }
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

  const missing = (error: unknown) => (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT'
  )

  const verifyManagedDirectory = async (path: string): Promise<StableFile> => {
    const root = await mediaRoot()
    const relativePath = relative(root, path)
    if (relativePath.startsWith(`..${sep}`) || relativePath === '..' || isAbsolute(relativePath)) {
      throw failure('MEDIA_IMPORT_FAILED')
    }
    const metadata = await filesystem.lstat(path)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw failure('MEDIA_IMPORT_FAILED')
    if (await filesystem.realpath(path) !== path) throw failure('MEDIA_IMPORT_FAILED')
    return snapshot(metadata)
  }

  const verifyManagedAncestors = async (path: string): Promise<Array<{ path: string; identity: StableFile }>> => {
    const root = await mediaRoot()
    const relativePath = relative(root, path)
    if (
      !relativePath
      || relativePath.startsWith(`..${sep}`)
      || relativePath === '..'
      || isAbsolute(relativePath)
    ) throw failure('MEDIA_IMPORT_FAILED')
    const segments = relativePath.split(sep)
    const quarantine = segments[0] === '.quarantine' && segments.length === 2
    const conversationFile = (
      ID_PATTERN.test(segments[0]!)
      && (segments.length === 2 || (segments.length === 3 && segments[1] === '.staging'))
    )
    if (!quarantine && !conversationFile) throw failure('MEDIA_IMPORT_FAILED')
    const directories = [root]
    for (let index = 0; index < segments.length - 1; index += 1) {
      directories.push(join(root, ...segments.slice(0, index + 1)))
    }
    const verified: Array<{ path: string; identity: StableFile }> = []
    for (const directory of directories) {
      verified.push({ path: directory, identity: await verifyManagedDirectory(directory) })
    }
    return verified
  }

  const reverifyAncestors = async (ancestors: Array<{ path: string; identity: StableFile }>) => {
    for (const ancestor of ancestors) {
      if (!sameNode(ancestor.identity, await verifyManagedDirectory(ancestor.path))) {
        throw failure('MEDIA_IMPORT_FAILED')
      }
    }
  }

  const verifyManagedFile = async (path: string, expected?: StableFile): Promise<StableFile> => {
    await verifyManagedAncestors(path)
    const metadata = await filesystem.lstat(path)
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw failure('MEDIA_IMPORT_FAILED')
    if (await filesystem.realpath(path) !== path) throw failure('MEDIA_IMPORT_FAILED')
    const identity = snapshot(metadata)
    if (expected && !sameFile(expected, identity)) throw failure('MEDIA_IMPORT_FAILED')
    return identity
  }

  interface QuarantineLocation {
    directory: string
    directoryIdentity: StableFile
    path: string
    relativePath: string
  }

  const newQuarantineLocation = async (): Promise<QuarantineLocation> => {
    const root = await mediaRoot()
    const directory = join(root, '.quarantine')
    await filesystem.mkdir(directory, { recursive: true })
    const directoryIdentity = await verifyManagedDirectory(directory)
    const path = join(directory, `${randomUUID()}.delete`)
    try {
      await filesystem.lstat(path)
      throw failure('MEDIA_IMPORT_FAILED')
    } catch (error) {
      if (!missing(error)) throw error
    }
    return {
      directory,
      directoryIdentity,
      path,
      relativePath: posix.join('.quarantine', basename(path)),
    }
  }

  const quarantineManagedFile = async (
    path: string,
    expected?: StableFile,
    requestedLocation?: QuarantineLocation,
  ): Promise<QuarantineLocation> => {
    const location = requestedLocation ?? await newQuarantineLocation()
    const originalAncestors = await verifyManagedAncestors(path)
    const originalIdentity = await verifyManagedFile(path, expected)
    await filesystem.rename(path, location.path)
    const quarantinedIdentity = await verifyManagedFile(location.path)
    if (!sameNode(originalIdentity, quarantinedIdentity) || originalIdentity.size !== quarantinedIdentity.size) {
      throw failure('MEDIA_IMPORT_FAILED')
    }
    try {
      await filesystem.lstat(path)
      throw failure('MEDIA_IMPORT_FAILED')
    } catch (error) {
      if (!missing(error)) throw error
    }
    try {
      await reverifyAncestors(originalAncestors)
      if (!sameNode(location.directoryIdentity, await verifyManagedDirectory(location.directory))) {
        throw failure('MEDIA_IMPORT_FAILED')
      }
      if (!sameFile(quarantinedIdentity, await verifyManagedFile(location.path))) {
        throw failure('MEDIA_IMPORT_FAILED')
      }
      if (!sameNode(location.directoryIdentity, await verifyManagedDirectory(location.directory))) {
        throw failure('MEDIA_IMPORT_FAILED')
      }
    } catch (error) {
      throw mappedFailure(error, 'MEDIA_IMPORT_FAILED')
    }
    return location
  }

  const restoreCanonicalCopy = async (
    location: QuarantineLocation,
    originalPath: string,
    expected?: StableFile,
  ): Promise<boolean> => {
    let source: Awaited<ReturnType<typeof open>> | undefined
    let destination: Awaited<ReturnType<typeof open>> | undefined
    try {
      if (!sameNode(location.directoryIdentity, await verifyManagedDirectory(location.directory))) return false
      const quarantineIdentity = await verifyManagedFile(location.path)
      if (expected && (!sameNode(expected, quarantineIdentity) || expected.size !== quarantineIdentity.size)) {
        return false
      }
      const originalAncestors = expected ? await verifyManagedAncestors(originalPath) : undefined
      try {
        await filesystem.lstat(originalPath)
        return false
      } catch (error) {
        if (!missing(error)) return false
      }

      source = await filesystem.open(location.path, 'r')
      const openedSource = snapshot(await source.stat())
      if (!sameFile(quarantineIdentity, openedSource)) return false
      destination = await filesystem.open(originalPath, 'wx', 0o600)
      let byteSize = 0
      for await (const value of source.createReadStream({ start: 0, autoClose: false })) {
        const chunk = value as Buffer
        byteSize += chunk.byteLength
        await writeAll(destination, chunk)
      }
      await destination.sync()
      const destinationIdentity = snapshot(await destination.stat())
      await destination.close()
      destination = undefined
      await source.close()
      source = undefined
      const restoredMetadata = await filesystem.lstat(originalPath)
      if (restoredMetadata.isSymbolicLink() || !restoredMetadata.isFile()) return false
      const restoredIdentity = expected
        ? await verifyManagedFile(originalPath)
        : snapshot(restoredMetadata)
      if (originalAncestors) await reverifyAncestors(originalAncestors)
      return (
        byteSize === quarantineIdentity.size
        && destinationIdentity.size === quarantineIdentity.size
        && sameFile(destinationIdentity, restoredIdentity)
      )
    } catch {
      return false
    } finally {
      await destination?.close().catch(() => undefined)
      await source?.close().catch(() => undefined)
    }
  }

  const cleanupManagedFile = async (path: string) => {
    try {
      await quarantineManagedFile(path)
    } catch {
      // Task 4 only moves verified files into inaccessible quarantine. Task 5 owns physical purge.
    }
  }

  const restoreRecordAfterQuarantineFailure = async (
    record: MediaAssetRecord,
    originalPath: string,
    identity: StableFile,
    location: QuarantineLocation,
  ) => {
    let restored: boolean
    try {
      restored = sameFile(identity, await verifyManagedFile(originalPath))
    } catch {
      restored = await restoreCanonicalCopy(location, originalPath, identity)
      if (!restored) await restoreCanonicalCopy(location, originalPath)
    }
    try {
      database.mediaAssets.update(record.id, {
        status: restored ? record.status : 'failed',
        relativePath: restored ? record.relativePath : location.relativePath,
        updatedAt: now(),
      })
    } catch {
      // The pre-move deleting state remains non-ready and points at the quarantine tombstone.
    }
  }

  const removeRecordAndFiles = async (record: MediaAssetRecord) => {
    if (record.messageId) throw failure('CONFLICT')
    const originalPath = await safeAssetPath(record)
    let identity: StableFile
    try {
      identity = await verifyManagedFile(originalPath)
    } catch (error) {
      if (!missing(error) || (record.status !== 'staging' && record.status !== 'failed')) throw error
      const deleting = database.mediaAssets.update(record.id, { status: 'deleting', updatedAt: now() })
      if (!deleting || deleting.messageId || deleting.conversationId !== record.conversationId) {
        throw failure('CONFLICT')
      }
      try {
        database.mediaAssets.delete(record.id)
        return
      } catch (deleteError) {
        try {
          database.mediaAssets.update(record.id, { status: 'failed', updatedAt: now() })
        } catch {
          // The deleting state is already non-ready.
        }
        throw deleteError
      }
    }

    const location = await newQuarantineLocation()
    const deleting = database.mediaAssets.update(record.id, {
      status: 'deleting',
      relativePath: location.relativePath,
      updatedAt: now(),
    })
    if (!deleting || deleting.messageId || deleting.conversationId !== record.conversationId) {
      if (deleting?.messageId) {
        try {
          database.mediaAssets.update(record.id, {
            status: record.status,
            relativePath: record.relativePath,
            updatedAt: now(),
          })
        } catch {
          // The claimed row remains non-removable; persistence recovery is external.
        }
      }
      throw failure('CONFLICT')
    }
    try {
      await quarantineManagedFile(originalPath, identity, location)
      database.mediaAssets.delete(record.id)
    } catch (error) {
      await restoreRecordAfterQuarantineFailure(record, originalPath, identity, location)
      throw error
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
      await filesystem.rename(staged.path, destination)
      renamed = true
      const ready = database.mediaAssets.update(id, { status: 'ready', updatedAt: now() })
      if (!ready || ready.status !== 'ready') throw new Error('Media asset did not become ready')
      return publicAsset(ready)
    } catch (error) {
      if (inserted) {
        try {
          database.mediaAssets.update(id, { status: 'failed', updatedAt: now() })
        } catch {
          // Deletion is still attempted; a successful failed-state update prevents a ready orphan.
        }
        try {
          database.mediaAssets.delete(id)
        } catch {
          // Cleanup continues with the file; no ready result is returned.
        }
      }
      await cleanupManagedFile(staged.path)
      if (renamed) await cleanupManagedFile(destination)
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
    const stage = await mappedNewStage(conversationId, fallback)
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
      await cleanupManagedFile(stage.path)
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
      const initialPathStat = await filesystem.lstat(sourcePath)
      if (initialPathStat.isSymbolicLink() || !initialPathStat.isFile()) throw failure('MEDIA_IMPORT_FAILED')
      const initial = snapshot(initialPathStat)
      const initialRealPath = await filesystem.realpath(sourcePath)
      sourceHandle = await filesystem.open(sourcePath, 'r')
      const opened = snapshot(await sourceHandle.stat())
      if (!sameFile(initial, opened) || await filesystem.realpath(sourcePath) !== initialRealPath) {
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
      const afterPath = await filesystem.lstat(sourcePath)
      if (
        afterPath.isSymbolicLink()
        || !sameFile(opened, afterHandle)
        || !sameFile(afterHandle, snapshot(afterPath))
        || await filesystem.realpath(sourcePath) !== initialRealPath
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
      if (stagePath) await cleanupManagedFile(stagePath)
      throw mappedFailure(error, 'MEDIA_IMPORT_FAILED')
    }
  }

  const stageGeneratedStream = async (input: GeneratedStreamInput): Promise<StagedMedia> => {
    const stage = await mappedNewStage(input.conversationId, 'MEDIA_GENERATION_FAILED')
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
      await cleanupManagedFile(stage.path)
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
      const pathStat = await filesystem.lstat(absolutePath)
      if (pathStat.isSymbolicLink() || !pathStat.isFile()) throw failure('MEDIA_ASSET_UNAVAILABLE')
      const before = snapshot(pathStat)
      const canonical = await filesystem.realpath(absolutePath)
      if (canonical !== absolutePath) throw failure('MEDIA_ASSET_UNAVAILABLE')
      handle = await filesystem.open(absolutePath, 'r')
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
      const afterPath = await filesystem.lstat(absolutePath)
      if (
        byteSize !== record.byteSize
        || hash.digest('hex') !== record.sha256
        || !sameFile(opened, after)
        || afterPath.isSymbolicLink()
        || !sameFile(after, snapshot(afterPath))
        || await filesystem.realpath(absolutePath) !== canonical
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
        const metadata = await filesystem.lstat(path).catch((error: unknown) => { throw mappedFailure(error, 'MEDIA_IMPORT_FAILED') })
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
        await cleanupManagedFile(staged.path)
        throw failure('MEDIA_MIME_MISMATCH')
      }
      return [await commitStage(input, 'upload', staged, 'MEDIA_IMPORT_FAILED')]
    },

    async removeDraft(assetId, conversationId) {
      assertIdentifier(assetId)
      assertIdentifier(conversationId)
      const record = database.mediaAssets.get(assetId)
      if (!record) return
      if (record.conversationId !== conversationId) throw failure('MEDIA_ASSET_UNAVAILABLE')
      await removeRecordAndFiles(record).catch((error: unknown) => {
        throw mappedFailure(error, 'MEDIA_IMPORT_FAILED')
      })
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
      const stage = await mappedNewStage(input.conversationId, 'MEDIA_GENERATION_FAILED')
      const hash = createHash('sha256')
      let byteSize = 0
      let encodedCharacters = 0
      let pending = ''
      let state: 'open' | 'failed' | 'committing' | 'done' = 'open'
      let tail = Promise.resolve()

      const cleanup = async () => {
        await stage.handle.close().catch(() => undefined)
        await cleanupManagedFile(stage.path)
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

      const writeDecodedBatches = async (encoded: string) => {
        for (let offset = 0; offset < encoded.length; offset += BASE64_BATCH_CHARACTERS) {
          await writeDecoded(encoded.slice(offset, offset + BASE64_BATCH_CHARACTERS))
        }
      }

      const append = async (chunk: string) => {
        if (state !== 'open') throw failure('MEDIA_GENERATION_FAILED')
        if (!chunk) return
        encodedCharacters += chunk.length
        if (encodedCharacters > MAX_ENCODED_GENERATED_BYTES || !/^[A-Za-z0-9+/=]+$/.test(chunk)) {
          throw failure(encodedCharacters > MAX_ENCODED_GENERATED_BYTES ? 'MEDIA_SIZE_LIMIT_EXCEEDED' : 'MEDIA_GENERATION_FAILED')
        }
        const combined = pending + chunk
        const completeLength = combined.length - (combined.length % 4)
        const complete = combined.slice(0, completeLength)
        pending = combined.slice(completeLength)
        const paddingIndex = complete.indexOf('=')
        if (paddingIndex >= 0) {
          const finalQuartetOffset = complete.length - 4
          const finalQuartet = complete.slice(finalQuartetOffset)
          if (
            pending.length > 0
            || paddingIndex < finalQuartetOffset
            || !/^(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/.test(finalQuartet)
          ) {
            throw failure('MEDIA_GENERATION_FAILED')
          }
          await writeDecodedBatches(complete.slice(0, finalQuartetOffset))
          await writeDecoded(finalQuartet)
        } else {
          await writeDecodedBatches(complete)
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
            if (pending.length === 1 || !/^[A-Za-z0-9+/]{0,3}$/.test(pending)) {
              throw failure('MEDIA_GENERATION_FAILED')
            }
            if (pending.length > 0) await writeDecoded(pending)
            await stage.handle.sync()
            await stage.handle.close()
            const handle = await filesystem.open(stage.path, 'r')
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
        try {
          await service.removeDraft(record.id, record.conversationId)
        } catch {
          // Cleanup is per-entry: unsafe or raced drafts remain for later recovery.
        }
      }
      const root = await mediaRoot()
      const conversations = await filesystem.readdir(root, { withFileTypes: true })
      for (const conversation of conversations) {
        if (!conversation.isDirectory() || !ID_PATTERN.test(conversation.name)) continue
        try {
          const conversationPath = join(root, conversation.name)
          await verifyManagedDirectory(conversationPath)
          const stagingPath = join(conversationPath, '.staging')
          await verifyManagedDirectory(stagingPath)
          for (const entry of await filesystem.readdir(stagingPath, { withFileTypes: true })) {
            if (!entry.isFile()) continue
            const path = join(stagingPath, entry.name)
            try {
              const metadata = await filesystem.lstat(path)
              if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.mtimeMs >= olderThan) continue
              await quarantineManagedFile(path, snapshot(metadata))
            } catch {
              // One unsafe or raced orphan must not authorize deletion or block other entries.
            }
          }
        } catch {
          // A swapped or symlinked managed ancestor is skipped without following it.
          continue
        }
      }
    },
  }

  return service
}
