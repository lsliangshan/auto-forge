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
  CompleteConversionJobWithArtifactsInput,
  ConversionArtifact,
  ConversionArtifactMetadata,
  MediaAssetRecord,
  NewConversionArtifact,
} from '../database/repositories.js'
import { conversionArtifactMetadataSchema } from '../database/repositories.js'
import { resolveUserConversionRoot, resolveUserMediaRoot } from '../media/user-media-root.js'
import {
  CONVERSION_LIMITS,
  expectedMimeType,
  probeConversionInput,
  type ProbedConversionInput,
} from './conversion-catalog.js'

function matchesIconContainerMetadata(
  probe: ProbedConversionInput,
  declared: readonly number[] | undefined,
): boolean {
  if (probe.format === 'ico') {
    if (declared === undefined || probe.icoRepresentations?.length !== probe.frameCount) return false
    const actual = probe.icoRepresentations.map((representation) => {
      if (representation.width !== representation.height) return -1
      return representation.width
    })
    return actual.length === declared.length && actual.every((size, index) => size === declared[index])
  }
  if (probe.format === 'icns') {
    if (declared === undefined || probe.iconSlots?.length !== probe.frameCount) return false
    const actual = probe.iconSlots.reduce<number[]>((sizes, slot) => {
      if (!sizes.includes(slot.pixelSize)) sizes.push(slot.pixelSize)
      return sizes
    }, [])
    return actual.length === declared.length && actual.every((size, index) => size === declared[index])
  }
  return declared === undefined
}

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

export interface ManagedOutputBatchCompletion {
  readonly jobId: string
  readonly ownerUserId: string
  readonly executionId: string
  readonly expectedEpoch: number
  readonly endedAt: number
}

export interface ManagedOutputBatch {
  readonly atomicJobCompletion: true
  readonly outputs: readonly { readonly tempPath: string }[]
  commit(
    outputs: readonly VerifiedConversionOutput[],
    completion?: ManagedOutputBatchCompletion,
  ): Promise<readonly ConversionArtifact[]>
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
  createBatch(inputs: readonly NewConversionArtifact[]): ConversionArtifact[]
}

interface ConversionJobCompletionRepository {
  completeWithArtifacts(input: CompleteConversionJobWithArtifactsInput): ConversionArtifact[] | null
}

export interface ConversionArtifactServiceDatabase {
  conversations: ConversationRepository
  mediaAssets: MediaAssetRepository
  conversionArtifacts: ConversionArtifactRepository
  conversionJobs?: ConversionJobCompletionRepository
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
  createOutputBatch(inputs: readonly CreateOutputWriterInput[]): Promise<ManagedOutputBatch>
}

interface CreateConversionArtifactServiceOptions {
  dataRoot: string
  database: ConversionArtifactServiceDatabase
  id?: () => string
  now?: () => number
  filesystem?: {
    mkdir?(path: string): Promise<void>
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

function sameNode(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino
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

const imageFamilyFormats = new Set(['png', 'jpeg', 'jpg', 'webp', 'avif', 'tiff', 'tif', 'bmp', 'gif', 'svg', 'ico', 'icns'])
const audioFamilyFormats = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'])
const videoFamilyFormats = new Set(['mp4', 'webm', 'mov', 'mkv', 'avi'])

function formatFamilyLimit(value: string | undefined): number | undefined {
  const format = value?.trim().toLowerCase()
  if (!format) return undefined
  if (imageFamilyFormats.has(format)) return CONVERSION_LIMITS.imageBytes
  if (audioFamilyFormats.has(format)) return CONVERSION_LIMITS.audioBytes
  if (videoFamilyFormats.has(format)) return CONVERSION_LIMITS.videoBytes
  return undefined
}

function safeDisplayNameExtension(displayName: string): string | undefined {
  if (!displayName || displayName.length > 1_024 || displayName.includes('/') || displayName.includes('\\') || displayName.includes('\0')) {
    return undefined
  }
  const extension = posix.extname(displayName).slice(1).toLowerCase()
  return /^[a-z0-9]{1,16}$/.test(extension) ? extension : undefined
}

function mimeFamilyLimit(mimeType: string): number | undefined {
  const normalized = mimeType.trim().toLowerCase()
  if (normalized.startsWith('image/')) return CONVERSION_LIMITS.imageBytes
  if (normalized.startsWith('audio/')) return CONVERSION_LIMITS.audioBytes
  if (normalized.startsWith('video/')) return CONVERSION_LIMITS.videoBytes
  if (normalized.startsWith('text/') || (normalized.startsWith('application/') && normalized !== 'application/octet-stream')) {
    return CONVERSION_LIMITS.fileBytes
  }
  return undefined
}

function artifactPreReadLimit(record: ConversionArtifact): number {
  const indicators = [
    formatFamilyLimit(record.detectedFormat),
    formatFamilyLimit(safeDisplayNameExtension(record.displayName)),
    mimeFamilyLimit(record.mimeType),
  ].filter((limit): limit is number => limit !== undefined)
  return indicators.length > 0 ? Math.min(...indicators) : CONVERSION_LIMITS.fileBytes
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
  if (
    !record
    || record.status !== 'ready'
    || record.role !== 'input'
    || !/^[a-f0-9]{64}$/.test(record.sha256)
    || record.byteSize > CONVERSION_LIMITS.videoBytes
    || record.byteSize > artifactPreReadLimit(record)
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
  const makeQuarantineDirectory = options.filesystem?.mkdir
    ?? (async (path: string) => { await mkdir(path, { mode: 0o700 }) })
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

    async createOutputBatch(inputs) {
      if (inputs.length === 0 || inputs.length > 256) throw failure('CONVERSION_INPUT_INVALID')
      const first = inputs[0]!
      if (
        !identifier(first.ownerUserId)
        || !identifier(first.executionId)
        || !identifier(first.conversionJobId ?? '')
        || inputs.some((input) => (
          input.ownerUserId !== first.ownerUserId
          || input.executionId !== first.executionId
          || input.conversionJobId !== first.conversionJobId
        ))
      ) throw failure('CONVERSION_INPUT_INVALID')

      const root = resolveUserConversionRoot(options.dataRoot, first.ownerUserId)
      const dataRootRealPath = await realpath(options.dataRoot)
      const parentRealPath = await ensureManagedDirectory(dirname(root))
      if (!inside(dataRootRealPath, parentRealPath)) throw failure('CONVERSION_INPUT_INVALID')
      const rootRealPath = await ensureManagedDirectory(root)
      if (!inside(parentRealPath, rootRealPath)) throw failure('CONVERSION_INPUT_INVALID')
      const staging = join(root, '.staging')
      const results = join(root, 'results')
      const trash = join(root, '.trash')
      const stagingRealPath = await ensureManagedDirectory(staging)
      const resultsRealPath = await ensureManagedDirectory(results)
      const trashRealPath = await ensureManagedDirectory(trash)
      if (
        !inside(rootRealPath, stagingRealPath)
        || !inside(rootRealPath, resultsRealPath)
        || !inside(rootRealPath, trashRealPath)
      ) {
        throw failure('CONVERSION_INPUT_INVALID')
      }
      const resultsMetadata = await lstat(resultsRealPath)
      const trashMetadata = await lstat(trashRealPath)
      if (resultsMetadata.dev !== trashMetadata.dev) throw failure('CONVERSION_INPUT_INVALID')
      const batchDirectoryName = `batch-${randomUUID()}`
      const batchDirectory = join(resultsRealPath, batchDirectoryName)
      await mkdir(batchDirectory, { mode: 0o700 })
      const batchDirectoryMetadata = await lstat(batchDirectory)
      const batchDirectoryRealPath = await realpath(batchDirectory)
      if (
        batchDirectoryMetadata.isSymbolicLink()
        || !batchDirectoryMetadata.isDirectory()
        || batchDirectoryMetadata.dev !== resultsMetadata.dev
        || !inside(resultsRealPath, batchDirectoryRealPath)
      ) throw failure('CONVERSION_INPUT_INVALID')

      const allocated: Array<{
        input: CreateOutputWriterInput
        artifactId: string
        tempPath: string
        verifierPath: string
        destination: string
        relativePath: string
      }> = []
      try {
        for (const input of inputs) {
          const artifactId = makeId()
          if (!identifier(artifactId) || allocated.some((output) => output.artifactId === artifactId)) {
            throw failure('CONVERSION_INPUT_INVALID')
          }
          const tempPath = join(staging, `${artifactId}.partial`)
          const created = await open(tempPath, 'wx', 0o600)
          await created.close()
          allocated.push({
            input,
            artifactId,
            tempPath,
            verifierPath: join(staging, `${artifactId}.${randomUUID()}.verify`),
            destination: join(batchDirectoryRealPath, `${artifactId}.${input.targetFormat}`),
            relativePath: posix.join('results', batchDirectoryName, `${artifactId}.${input.targetFormat}`),
          })
        }
      } catch (error) {
        await Promise.all(allocated.map(({ tempPath, verifierPath }) => Promise.all([
          rm(tempPath, { force: true }),
          rm(verifierPath, { force: true }),
        ])))
        await rm(batchDirectoryRealPath, { force: true }).catch(() => undefined)
        throw error
      }

      let state: 'open' | 'committing' | 'committed' | 'aborted' = 'open'
      let cancelRequested = false
      let commitTask: Promise<readonly ConversionArtifact[]> | undefined
      const cleanupStaging = async () => {
        await Promise.all(allocated.flatMap(({ tempPath, verifierPath }) => [
          rm(tempPath, { force: true }),
          rm(verifierPath, { force: true }),
        ]))
      }
      const quarantineBatch = async (): Promise<boolean> => {
        try {
          const named = await lstat(batchDirectoryRealPath)
          if (
            named.isSymbolicLink()
            || !named.isDirectory()
            || !sameNode(batchDirectoryMetadata, named)
            || named.dev !== trashMetadata.dev
          ) return false
          const quarantineId = randomUUID()
          const reservation = await open(join(trashRealPath, `.rollback-${quarantineId}.reserve`), 'wx', 0o600)
          try {
            await reservation.writeFile(`v1 ${batchDirectoryMetadata.dev} ${batchDirectoryMetadata.ino}\n`)
            await reservation.sync()
          } finally {
            await reservation.close()
          }
          const isolated = join(trashRealPath, `rollback-${quarantineId}`)
          const conflict = await lstat(isolated).then(
            () => true,
            (error: unknown) => {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
              throw error
            },
          )
          if (conflict) return false
          await makeQuarantineDirectory(isolated)
          const isolatedContainer = await lstat(isolated)
          const isolatedContainerRealPath = await realpath(isolated)
          if (
            isolatedContainer.isSymbolicLink()
            || !isolatedContainer.isDirectory()
            || isolatedContainer.dev !== trashMetadata.dev
            || isolatedContainerRealPath !== isolated
            || !inside(trashRealPath, isolatedContainerRealPath)
          ) return false
          const payload = join(isolatedContainerRealPath, 'batch')
          await renameFile(batchDirectoryRealPath, payload)
          const replacementAtSource = await lstat(batchDirectoryRealPath).then(
            () => true,
            (error: unknown) => {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
              throw error
            },
          )
          const isolatedContainerAfter = await lstat(isolated)
          const isolatedMetadata = await lstat(payload)
          return !replacementAtSource
            && !isolatedContainerAfter.isSymbolicLink()
            && isolatedContainerAfter.isDirectory()
            && sameNode(isolatedContainer, isolatedContainerAfter)
            && !isolatedMetadata.isSymbolicLink()
            && isolatedMetadata.isDirectory()
            && sameNode(batchDirectoryMetadata, isolatedMetadata)
        } catch {
          // The exclusive result batch and any conflicting/replacement node are
          // preserved rather than being removed through a shared leaf path.
          return false
        }
      }

      return {
        atomicJobCompletion: true,
        outputs: Object.freeze(allocated.map(({ tempPath }) => Object.freeze({ tempPath }))),
        async abort() {
          if (state === 'committed' || state === 'aborted') return
          if (state === 'committing') {
            cancelRequested = true
            await commitTask?.catch(() => undefined)
            return
          }
          state = 'aborted'
          await Promise.allSettled([cleanupStaging(), quarantineBatch()])
        },
        commit(outputs, completion) {
          if (state !== 'open' || outputs.length !== allocated.length) throw failure('CONVERSION_INPUT_INVALID')
          const parsedMetadata = outputs.map((output) => {
            if (output.metadata === undefined) return undefined
            const parsed = conversionArtifactMetadataSchema.safeParse(output.metadata)
            if (!parsed.success) throw failure('CONVERSION_INPUT_INVALID')
            return parsed.data
          })
          if (completion !== undefined && (
            completion.jobId !== first.conversionJobId
            || completion.ownerUserId !== first.ownerUserId
            || completion.executionId !== first.executionId
            || !Number.isSafeInteger(completion.expectedEpoch)
            || completion.expectedEpoch < 0
            || !Number.isSafeInteger(completion.endedAt)
          )) throw failure('CONVERSION_INPUT_INVALID')
          state = 'committing'
          commitTask = (async () => {
            try {
              const sourceMetadata = await Promise.all(allocated.map(({ tempPath }) => lstat(tempPath)))
              let aggregateBytes = 0
              for (const metadata of sourceMetadata) {
                if (metadata.isSymbolicLink() || !metadata.isFile()) throw failure('CONVERSION_INPUT_INVALID')
                aggregateBytes += metadata.size
                if (!Number.isSafeInteger(aggregateBytes) || aggregateBytes > CONVERSION_LIMITS.outputBytes) {
                  throw failure('CONVERSION_OUTPUT_TOO_LARGE')
                }
              }

              const prepared: NewConversionArtifact[] = []
              const batchTimestamp = now()
              if (!Number.isSafeInteger(batchTimestamp + allocated.length - 1)) throw failure('CONVERSION_INPUT_INVALID')
              for (const [index, output] of allocated.entries()) {
                if (cancelRequested) throw failure('CONVERSION_CANCELLED')
                const before = sourceMetadata[index]!
                const tempRealPath = await realpath(output.tempPath)
                if (!inside(stagingRealPath, tempRealPath)) throw failure('CONVERSION_INPUT_INVALID')
                const source = await open(output.tempPath, constants.O_RDONLY | constants.O_NOFOLLOW)
                const verifier = await open(output.verifierPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
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
                await rm(output.tempPath, { force: true })

                const verifiedBefore = await lstat(output.verifierPath)
                if (verifiedBefore.isSymbolicLink() || !verifiedBefore.isFile() || verifiedBefore.size !== before.size) {
                  throw failure('CONVERSION_INPUT_INVALID')
                }
                const bytes = await readFile(output.verifierPath)
                const probe = probeConversionInput({
                  bytes,
                  displayName: output.input.displayName,
                  mimeType: expectedMimeType(output.input.targetFormat),
                  byteSize: verifiedBefore.size,
                })
                if (probe.format !== output.input.targetFormat) throw failure('CONVERSION_INPUT_INVALID')
                if (!matchesIconContainerMetadata(probe, parsedMetadata[index]?.iconRepresentations)) {
                  throw failure('CONVERSION_INPUT_INVALID')
                }
                const representation = parsedMetadata[index]?.iconRepresentation
                if (representation !== undefined && (
                  probe.width !== representation.pixelWidth
                  || probe.height !== representation.pixelHeight
                )) throw failure('CONVERSION_INPUT_INVALID')
                const verifiedAfter = await lstat(output.verifierPath)
                if (!sameFile(verifiedBefore, verifiedAfter)) throw failure('CONVERSION_INPUT_INVALID')
                const timestamp = batchTimestamp + index
                prepared.push({
                  id: output.artifactId,
                  ownerUserId: output.input.ownerUserId,
                  executionId: output.input.executionId,
                  conversionJobId: output.input.conversionJobId,
                  role: 'output',
                  displayName: output.input.displayName,
                  detectedFormat: probe.format,
                  mimeType: probe.mimeType,
                  byteSize: probe.byteSize,
                  sha256: createHash('sha256').update(bytes).digest('hex'),
                  relativePath: output.relativePath,
                  ...(parsedMetadata[index] === undefined ? {} : { metadata: parsedMetadata[index] }),
                  status: 'ready',
                  createdAt: timestamp,
                  updatedAt: timestamp,
                })
              }

              if (cancelRequested) throw failure('CONVERSION_CANCELLED')
              for (const output of allocated) {
                const identity = await lstat(output.verifierPath)
                await renameFile(output.verifierPath, output.destination)
                const destination = await lstat(output.destination)
                if (destination.isSymbolicLink() || !destination.isFile() || !sameFile(identity, destination)) {
                  throw failure('CONVERSION_INPUT_INVALID')
                }
                if (cancelRequested) throw failure('CONVERSION_CANCELLED')
              }

              const artifacts = completion === undefined
                ? options.database.conversionArtifacts.createBatch(prepared)
                : options.database.conversionJobs?.completeWithArtifacts({
                  ...completion,
                  artifacts: prepared,
                })
              if (!artifacts) throw failure('CONVERSION_INTERRUPTED')
              state = 'committed'
              return artifacts
            } catch (error) {
              state = 'aborted'
              await Promise.allSettled([cleanupStaging(), quarantineBatch()])
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
