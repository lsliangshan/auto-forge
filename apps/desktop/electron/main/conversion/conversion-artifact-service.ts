import { createHash, randomUUID } from 'node:crypto'
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
): { rootKind: 'media' | 'conversion'; relativePath: string; displayName: string; mimeType: string; byteSize: number } {
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
    ) throw failure('CONVERSION_INPUT_INVALID')
    return {
      rootKind: 'media',
      relativePath: record.relativePath,
      displayName: record.originalName,
      mimeType: record.mimeType,
      byteSize: record.byteSize,
    }
  }
  if (!identifier(binding.source.artifactId)) throw failure('CONVERSION_INPUT_INVALID')
  const record = database.conversionArtifacts.getOwned(binding.source.artifactId, binding.ownerUserId)
  if (!record || record.status !== 'ready' || record.role !== 'input') throw failure('CONVERSION_INPUT_INVALID')
  return {
    rootKind: 'conversion',
    relativePath: record.relativePath,
    displayName: record.displayName,
    mimeType: record.mimeType,
    byteSize: record.byteSize,
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
          if (metadata.size !== record.byteSize) throw failure('CONVERSION_INPUT_INVALID')
          const bytes = await readStableHandle(opened.handle, metadata.size)
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
      const destination = join(results, `${artifactId}.${input.targetFormat}`)
      const relativePath = posix.join('results', `${artifactId}.${input.targetFormat}`)
      const created = await open(tempPath, 'wx', 0o600)
      await created.close()
      let state: 'open' | 'committed' | 'aborted' = 'open'

      const cleanup = async () => {
        await rm(tempPath, { force: true })
      }

      return {
        tempPath,
        async abort() {
          if (state !== 'open') return
          state = 'aborted'
          await cleanup()
        },
        async commit(output) {
          if (state !== 'open') throw failure('CONVERSION_INPUT_INVALID')
          try {
            const before = await lstat(tempPath)
            if (before.isSymbolicLink() || !before.isFile()) throw failure('CONVERSION_INPUT_INVALID')
            if (before.size > CONVERSION_LIMITS.outputBytes) throw failure('CONVERSION_OUTPUT_TOO_LARGE')
            const tempRealPath = await realpath(tempPath)
            if (!inside(stagingRealPath, tempRealPath)) throw failure('CONVERSION_INPUT_INVALID')
            const bytes = await readFile(tempPath)
            const probe = probeConversionInput({
              bytes,
              displayName: input.displayName,
              mimeType: expectedMimeType(input.targetFormat),
              byteSize: before.size,
            })
            if (probe.format !== input.targetFormat) throw failure('CONVERSION_INPUT_INVALID')
            const after = await lstat(tempPath)
            if (!sameFile(before, after)) throw failure('CONVERSION_INPUT_INVALID')
            const sha256 = createHash('sha256').update(bytes).digest('hex')
            await rename(tempPath, destination)
            let artifact: ConversionArtifact
            try {
              const timestamp = now()
              artifact = options.database.conversionArtifacts.create({
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
            } catch (error) {
              await rm(destination, { force: true })
              throw error
            }
            state = 'committed'
            return artifact
          } catch (error) {
            state = 'aborted'
            await cleanup()
            if (typeof error === 'object' && error !== null && 'code' in error && String((error as { code: unknown }).code).startsWith('CONVERSION_')) {
              throw error
            }
            throw failure('CONVERSION_INPUT_INVALID')
          }
        },
      }
    },
  }
}
