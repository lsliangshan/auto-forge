import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import {
  toSafeAppError,
  type AppError,
  type AppErrorCode,
  type ConversionTargetFormat,
} from '@autoforge/shared'
import type {
  ConversionArtifact,
  ConversionArtifactMetadata,
  MediaAssetRecord,
  NewConversionArtifact,
} from '../database/repositories.js'
import { resolveUserConversionRoot, resolveUserMediaRoot } from '../media/user-media-root.js'
import {
  CONVERSION_LIMITS,
  expectedMimeType,
  probeConversionInput,
  type ProbedConversionInput,
} from './conversion-catalog.js'

export type ConversionSourceRef =
  | { kind: 'media'; mediaAssetId: string }
  | { kind: 'artifact'; artifactId: string }

export interface ExecutionAttachmentBinding {
  attachmentIndex: number
  ownerUserId: string
  displayName: string
  mimeType: string
  byteSize: number
  source: ConversionSourceRef
}

export interface VerifiedConversionOutput {
  metadata?: ConversionArtifactMetadata
}

export interface ManagedOutputWriter {
  readonly tempPath: string
  commit(metadata: VerifiedConversionOutput): Promise<ConversionArtifact>
  abort(): Promise<void>
}

export interface ResolvedOwnedInput {
  readonly handle: FileHandle
  readonly mainPath: string
  readonly probe: ProbedConversionInput
  close(): Promise<void>
}

interface ConversationRepository {
  get(id: string): { id: string; userId?: string } | undefined
}

interface MediaAssetRepository {
  get(id: string): MediaAssetRecord | undefined
}

interface ConversionArtifactRepository {
  getOwned(artifactId: string, ownerUserId: string): ConversionArtifact | null
  create(input: NewConversionArtifact): ConversionArtifact
}

export interface ConversionArtifactServiceDatabase {
  conversations: ConversationRepository
  mediaAssets: MediaAssetRepository
  conversionArtifacts: ConversionArtifactRepository
}

export interface CreateOutputWriterInput {
  ownerUserId: string
  executionId: string
  conversionJobId?: string
  displayName: string
  targetFormat: ConversionTargetFormat
}

export interface ConversionArtifactService {
  resolveOwnedInput(binding: ExecutionAttachmentBinding): Promise<ResolvedOwnedInput>
  createOutputWriter(input: CreateOutputWriterInput): Promise<ManagedOutputWriter>
}

interface CreateConversionArtifactServiceOptions {
  dataRoot: string
  database: ConversionArtifactServiceDatabase
  id?: () => string
  now?: () => number
  filesystem?: {
    rename?(source: string, destination: string): Promise<void>
  }
}

function failure(code: AppErrorCode): AppError {
  return toSafeAppError({ code })
}

function identifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(value)
}

function safeRelativePath(value: string): boolean {
  if (!value || isAbsolute(value) || value.includes('\\') || value.includes('\0')) return false
  const normalized = posix.normalize(value)
  return normalized === value && normalized !== '..' && !normalized.startsWith('../')
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function sameFile(
  left: { dev: number | bigint; ino: number | bigint; size: number },
  right: { dev: number | bigint; ino: number | bigint; size: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
}

async function ensureManagedDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw failure('CONVERSION_INPUT_INVALID')
  return realpath(path)
}

async function verifyManagedDirectory(path: string): Promise<string> {
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw failure('CONVERSION_INPUT_INVALID')
  return realpath(path)
}

async function verifyOwnerRoot(dataRoot: string, root: string): Promise<string> {
  const dataRootRealPath = await realpath(dataRoot)
  const parentRealPath = await verifyManagedDirectory(dirname(root))
  const rootRealPath = await verifyManagedDirectory(root)
  if (!inside(dataRootRealPath, parentRealPath) || !inside(parentRealPath, rootRealPath)) {
    throw failure('CONVERSION_INPUT_INVALID')
  }
  return rootRealPath
}

async function openStableRegularFile(dataRoot: string, root: string, relativePath: string): Promise<{ handle: FileHandle; path: string }> {
  if (!safeRelativePath(relativePath)) throw failure('CONVERSION_INPUT_INVALID')
  const rootRealPath = await verifyOwnerRoot(dataRoot, root)
  const path = resolve(root, ...relativePath.split('/'))
  const segments = relativePath.split('/')
  let ancestor = root
  for (const segment of segments.slice(0, -1)) {
    ancestor = join(ancestor, segment)
    const metadata = await lstat(ancestor)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw failure('CONVERSION_INPUT_INVALID')
  }
  const before = await lstat(path)
  if (before.isSymbolicLink() || !before.isFile()) throw failure('CONVERSION_INPUT_INVALID')
  const fileRealPath = await realpath(path)
  if (!inside(rootRealPath, fileRealPath)) throw failure('CONVERSION_INPUT_INVALID')
  const handle = await open(path, 'r')
  try {
    const opened = await handle.stat()
    const after = await lstat(path)
    if (!sameFile(before, opened) || !sameFile(opened, after)) throw failure('CONVERSION_INPUT_INVALID')
    return { handle, path }
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function readStableHandle(handle: FileHandle, byteSize: number): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(byteSize)
  let offset = 0
  while (offset < byteSize) {
    const result = await handle.read(bytes, offset, byteSize - offset, offset)
    if (result.bytesRead === 0) throw failure('CONVERSION_INPUT_INVALID')
    offset += result.bytesRead
  }
  return bytes
}

function sourceRecord(
  database: ConversionArtifactServiceDatabase,
  binding: ExecutionAttachmentBinding,
): { rootKind: 'media' | 'conversion'; relativePath: string; displayName: string; mimeType: string; byteSize: number; sha256: string } {
  if (!Number.isInteger(binding.attachmentIndex) || binding.attachmentIndex < 0 || !identifier(binding.ownerUserId)) {
    throw failure('CONVERSION_INPUT_INVALID')
  }
  if (binding.source.kind === 'media') {
    if (!identifier(binding.source.mediaAssetId)) throw failure('CONVERSION_INPUT_INVALID')
    const record = database.mediaAssets.get(binding.source.mediaAssetId)
    const conversation = record ? database.conversations.get(record.conversationId) : undefined
    if (
      !record
      || !conversation
      || conversation.userId !== binding.ownerUserId
      || record.status !== 'ready'
      || !record.relativePath
      || record.byteSize === undefined
      || !record.mimeType
      || !record.sha256
      || !/^[a-f0-9]{64}$/.test(record.sha256)
      || record.byteSize > CONVERSION_LIMITS.videoBytes
      || record.byteSize > (
        record.kind === 'image' ? CONVERSION_LIMITS.imageBytes
          : record.kind === 'audio' ? CONVERSION_LIMITS.audioBytes
            : record.kind === 'video' ? CONVERSION_LIMITS.videoBytes
              : CONVERSION_LIMITS.fileBytes
      )
    ) throw failure('CONVERSION_INPUT_INVALID')
    return {
      rootKind: 'media',
      relativePath: record.relativePath,
      displayName: record.originalName,
      mimeType: record.mimeType,
      byteSize: record.byteSize,
      sha256: record.sha256,
    }
  }
  if (!identifier(binding.source.artifactId)) throw failure('CONVERSION_INPUT_INVALID')
  const record = database.conversionArtifacts.getOwned(binding.source.artifactId, binding.ownerUserId)
  const artifactLimit = record?.mimeType.startsWith('image/') ? CONVERSION_LIMITS.imageBytes
    : record?.mimeType.startsWith('audio/') ? CONVERSION_LIMITS.audioBytes
      : record?.mimeType.startsWith('video/') ? CONVERSION_LIMITS.videoBytes
        : CONVERSION_LIMITS.fileBytes
  if (
    !record
    || record.status !== 'ready'
    || record.role !== 'input'
    || !/^[a-f0-9]{64}$/.test(record.sha256)
    || record.byteSize > CONVERSION_LIMITS.videoBytes
    || record.byteSize > artifactLimit
  ) throw failure('CONVERSION_INPUT_INVALID')
  return {
    rootKind: 'conversion',
    relativePath: record.relativePath,
    displayName: record.displayName,
    mimeType: record.mimeType,
    byteSize: record.byteSize,
    sha256: record.sha256,
  }
}

function matchesBinding(
  binding: ExecutionAttachmentBinding,
  record: { displayName: string; mimeType: string; byteSize: number },
): boolean {
  return binding.displayName === record.displayName
    && binding.mimeType === record.mimeType
    && binding.byteSize === record.byteSize
}

export function createConversionArtifactService(
  options: CreateConversionArtifactServiceOptions,
): ConversionArtifactService {
  const makeId = options.id ?? randomUUID
  const now = options.now ?? Date.now
  const renameFile = options.filesystem?.rename ?? rename

  return {
    async resolveOwnedInput(binding) {
      try {
        const record = sourceRecord(options.database, binding)
        if (!matchesBinding(binding, record)) throw failure('CONVERSION_INPUT_INVALID')
        const root = record.rootKind === 'media'
          ? resolveUserMediaRoot(options.dataRoot, binding.ownerUserId)
          : resolveUserConversionRoot(options.dataRoot, binding.ownerUserId)
        const opened = await openStableRegularFile(options.dataRoot, root, record.relativePath)
        try {
          const metadata = await opened.handle.stat()
          if (metadata.size !== record.byteSize || metadata.size > CONVERSION_LIMITS.videoBytes) throw failure('CONVERSION_INPUT_INVALID')
          const bytes = await readStableHandle(opened.handle, metadata.size)
          if (createHash('sha256').update(bytes).digest('hex') !== record.sha256) throw failure('CONVERSION_INPUT_INVALID')
          const probe = probeConversionInput({
            bytes,
            displayName: record.displayName,
            mimeType: record.mimeType,
            byteSize: metadata.size,
          })
          return {
            handle: opened.handle,
            mainPath: opened.path,
            probe,
            close: () => opened.handle.close(),
          }
        } catch (error) {
          await opened.handle.close()
          throw error
        }
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && String((error as { code: unknown }).code).startsWith('CONVERSION_')) {
          throw error
        }
        throw failure('CONVERSION_INPUT_INVALID')
      }
    },

    async createOutputWriter(input) {
      if (
        !identifier(input.ownerUserId)
        || !identifier(input.executionId)
        || (input.conversionJobId !== undefined && !identifier(input.conversionJobId))
      ) throw failure('CONVERSION_INPUT_INVALID')
      const artifactId = makeId()
      if (!identifier(artifactId)) throw failure('CONVERSION_INPUT_INVALID')
      const root = resolveUserConversionRoot(options.dataRoot, input.ownerUserId)
      const dataRootRealPath = await realpath(options.dataRoot)
      const parentRealPath = await ensureManagedDirectory(dirname(root))
      if (!inside(dataRootRealPath, parentRealPath)) throw failure('CONVERSION_INPUT_INVALID')
      const rootRealPath = await ensureManagedDirectory(root)
      if (!inside(parentRealPath, rootRealPath)) throw failure('CONVERSION_INPUT_INVALID')
      const staging = join(root, '.staging')
      const results = join(root, 'results')
      const stagingRealPath = await ensureManagedDirectory(staging)
      const resultsRealPath = await ensureManagedDirectory(results)
      if (!inside(rootRealPath, stagingRealPath) || !inside(rootRealPath, resultsRealPath)) {
        throw failure('CONVERSION_INPUT_INVALID')
      }
      const tempPath = join(staging, `${artifactId}.partial`)
      const verifierPath = join(staging, `${artifactId}.${randomUUID()}.verify`)
      const destination = join(results, `${artifactId}.${input.targetFormat}`)
      const relativePath = posix.join('results', `${artifactId}.${input.targetFormat}`)
      const created = await open(tempPath, 'wx', 0o600)
      await created.close()
      let state: 'open' | 'committing' | 'committed' | 'aborted' = 'open'
      let cancelRequested = false
      let commitTask: Promise<ConversionArtifact> | undefined

      const cleanup = async () => {
        await Promise.all([rm(tempPath, { force: true }), rm(verifierPath, { force: true })])
      }

      return {
        tempPath,
        async abort() {
          if (state === 'committed' || state === 'aborted') return
          if (state === 'committing') {
            cancelRequested = true
            await commitTask?.catch(() => undefined)
            return
          }
          state = 'aborted'
          await cleanup()
        },
        commit(output) {
          if (state !== 'open') throw failure('CONVERSION_INPUT_INVALID')
          state = 'committing'
          commitTask = (async () => {
            let renamed = false
            try {
              const before = await lstat(tempPath)
              if (before.isSymbolicLink() || !before.isFile()) throw failure('CONVERSION_INPUT_INVALID')
              if (before.size > CONVERSION_LIMITS.outputBytes) throw failure('CONVERSION_OUTPUT_TOO_LARGE')
              const tempRealPath = await realpath(tempPath)
              if (!inside(stagingRealPath, tempRealPath)) throw failure('CONVERSION_INPUT_INVALID')

              const source = await open(tempPath, constants.O_RDONLY | constants.O_NOFOLLOW)
              const verifier = await open(verifierPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
              try {
                const opened = await source.stat()
                if (!sameFile(before, opened)) throw failure('CONVERSION_INPUT_INVALID')
                const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, before.size)))
                let offset = 0
                while (offset < before.size) {
                  if (cancelRequested) throw failure('CONVERSION_CANCELLED')
                  const read = await source.read(chunk, 0, Math.min(chunk.byteLength, before.size - offset), offset)
                  if (read.bytesRead === 0) throw failure('CONVERSION_INPUT_INVALID')
                  let written = 0
                  while (written < read.bytesRead) {
                    const result = await verifier.write(chunk, written, read.bytesRead - written, offset + written)
                    if (result.bytesWritten === 0) throw failure('CONVERSION_INPUT_INVALID')
                    written += result.bytesWritten
                  }
                  offset += read.bytesRead
                }
                const after = await source.stat()
                if (!sameFile(opened, after) || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
                  throw failure('CONVERSION_INPUT_INVALID')
                }
                await verifier.sync()
              } finally {
                await Promise.all([source.close(), verifier.close()])
              }
              await rm(tempPath, { force: true })
              if (cancelRequested) throw failure('CONVERSION_CANCELLED')

              const verifiedBefore = await lstat(verifierPath)
              if (verifiedBefore.isSymbolicLink() || !verifiedBefore.isFile() || verifiedBefore.size !== before.size) {
                throw failure('CONVERSION_INPUT_INVALID')
              }
              const bytes = await readFile(verifierPath)
              const probe = probeConversionInput({
                bytes,
                displayName: input.displayName,
                mimeType: expectedMimeType(input.targetFormat),
                byteSize: verifiedBefore.size,
              })
              if (probe.format !== input.targetFormat) throw failure('CONVERSION_INPUT_INVALID')
              const verifiedAfter = await lstat(verifierPath)
              if (!sameFile(verifiedBefore, verifiedAfter)) throw failure('CONVERSION_INPUT_INVALID')
              const sha256 = createHash('sha256').update(bytes).digest('hex')
              if (cancelRequested) throw failure('CONVERSION_CANCELLED')
              await renameFile(verifierPath, destination)
              renamed = true
              if (cancelRequested) throw failure('CONVERSION_CANCELLED')

              const timestamp = now()
              const artifact = options.database.conversionArtifacts.create({
                id: artifactId,
                ownerUserId: input.ownerUserId,
                executionId: input.executionId,
                ...(input.conversionJobId === undefined ? {} : { conversionJobId: input.conversionJobId }),
                role: 'output',
                displayName: input.displayName,
                detectedFormat: probe.format,
                mimeType: probe.mimeType,
                byteSize: probe.byteSize,
                sha256,
                relativePath,
                ...(output.metadata === undefined ? {} : { metadata: output.metadata }),
                status: 'ready',
                createdAt: timestamp,
                updatedAt: timestamp,
              })
              state = 'committed'
              return artifact
            } catch (error) {
              state = 'aborted'
              await cleanup()
              if (renamed) await rm(destination, { force: true })
              if (typeof error === 'object' && error !== null && 'code' in error && String((error as { code: unknown }).code).startsWith('CONVERSION_')) {
                throw error
              }
              throw failure('CONVERSION_INPUT_INVALID')
            }
          })()
          return commitTask
        },
      }
    },
  }
}
