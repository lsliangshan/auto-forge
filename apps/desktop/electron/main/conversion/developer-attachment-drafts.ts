import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import { toSafeAppError, type AppError, type DeveloperAttachmentDraft } from '@autoforge/shared'
import type { ConversionArtifact, NewConversionArtifact } from '../database/repositories.js'
import { resolveUserConversionRoot } from '../media/user-media-root.js'
import {
  assertAttachmentBatchLimits,
  CONVERSION_LIMITS,
  probeConversionInput,
  type ProbedConversionInput,
} from './conversion-catalog.js'

export interface DeveloperDraftRecord extends DeveloperAttachmentDraft {
  readonly ownerUserId: string
  readonly projectId: string
  readonly detectedFormat: string
  readonly sha256: string
  readonly relativePath: string
  readonly probe: ProbedConversionInput
}

export interface DeveloperAttachmentDraftService {
  recover(): Promise<void>
  importPaths(input: {
    projectId: string
    existingAttachmentIds: readonly string[]
    paths: readonly string[]
  }): Promise<DeveloperAttachmentDraft[]>
  remove(projectId: string, attachmentId: string): Promise<void>
  clearProject(projectId: string): Promise<void>
  clearOwner(): Promise<void>
  get(projectId: string, attachmentId: string): DeveloperDraftRecord | undefined
  claim(projectId: string, executionId: string, attachmentIds: readonly string[]): DeveloperDraftRecord[]
  materialize(executionId: string, attachmentIds: readonly string[]): Promise<void>
  releaseExecution(executionId: string, referencedAttachmentIds: ReadonlySet<string>): Promise<void>
}

interface CreateDeveloperAttachmentDraftServiceOptions {
  dataRoot: string
  ownerUserId: string
  id?: () => string
  artifacts: {
    create(input: NewConversionArtifact): ConversionArtifact
    getOwned(artifactId: string, ownerUserId: string): ConversionArtifact | null
    markDeleted(artifactId: string, ownerUserId: string, expected: ConversionArtifact): boolean
  }
}

function failure(code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONVERSION_INPUT_INVALID'): AppError {
  return toSafeAppError({ code })
}

function inside(root: string, candidate: string): boolean {
  const value = relative(root, candidate)
  return value !== '..' && !value.startsWith(`..${sep}`)
}

function sameFile(
  left: { dev: number | bigint; ino: number | bigint; size: number; mtimeMs: number; ctimeMs: number },
  right: { dev: number | bigint; ino: number | bigint; size: number; mtimeMs: number; ctimeMs: number },
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
}

async function ensureDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw failure('CONVERSION_INPUT_INVALID')
  return realpath(path)
}

function publicDraft(record: DeveloperDraftRecord): DeveloperAttachmentDraft {
  return { id: record.id, name: record.name, mimeType: record.mimeType, byteSize: record.byteSize }
}

export function createDeveloperAttachmentDraftService(
  options: CreateDeveloperAttachmentDraftServiceOptions,
): DeveloperAttachmentDraftService {
  const records = new Map<string, DeveloperDraftRecord>()
  const claims = new Map<string, { executionId: string; materialized: boolean }>()
  const makeId = options.id ?? randomUUID
  const root = resolveUserConversionRoot(options.dataRoot, options.ownerUserId)
  const draftDirectory = join(root, '.developer-drafts')

  const verifiedDraftDirectory = async () => {
    const dataRoot = await ensureDirectory(options.dataRoot)
    const conversionRoot = await ensureDirectory(root)
    const drafts = await ensureDirectory(draftDirectory)
    if (!inside(dataRoot, conversionRoot) || !inside(conversionRoot, drafts)) {
      throw failure('CONVERSION_INPUT_INVALID')
    }
    return drafts
  }

  const removeRecord = async (record: DeveloperDraftRecord) => {
    records.delete(record.id)
    const drafts = await verifiedDraftDirectory()
    const path = join(drafts, `${record.id}.input`)
    if (!inside(drafts, path)) throw failure('CONVERSION_INPUT_INVALID')
    await rm(path, { force: true })
  }

  return {
    async recover() {
      records.clear()
      claims.clear()
      const drafts = await verifiedDraftDirectory()
      for (const name of await readdir(drafts)) {
        const path = join(drafts, name)
        if (!inside(drafts, path)) throw failure('CONVERSION_INPUT_INVALID')
        const metadata = await lstat(path)
        if (metadata.isSymbolicLink() || !metadata.isFile()) throw failure('CONVERSION_INPUT_INVALID')
        await rm(path, { force: true })
      }
    },

    async importPaths(input) {
      if (!input.projectId.trim()
        || input.existingAttachmentIds.length > CONVERSION_LIMITS.attachments
        || new Set(input.existingAttachmentIds).size !== input.existingAttachmentIds.length) {
        throw failure('INVALID_INPUT')
      }
      const existing = input.existingAttachmentIds.map((id) => {
        const record = records.get(id)
        if (!record || record.projectId !== input.projectId) throw failure('NOT_FOUND')
        return record
      })
      const remaining = CONVERSION_LIMITS.attachments - existing.length
      const selectedPaths = input.paths.filter(Boolean).slice(0, remaining)
      if (selectedPaths.length === 0) return []
      const drafts = await verifiedDraftDirectory()
      const staged: Array<{ record: DeveloperDraftRecord; temporary: string; final: string }> = []
      try {
        for (const sourcePath of selectedPaths) {
          const name = basename(sourcePath)
          if (!name || name.length > 255 || name.includes('\0')) throw failure('CONVERSION_INPUT_INVALID')
          const sourceMetadata = await lstat(sourcePath)
          if (sourceMetadata.isSymbolicLink()
            || !sourceMetadata.isFile()
            || sourceMetadata.size < 1
            || sourceMetadata.size > CONVERSION_LIMITS.videoBytes) {
            throw failure('CONVERSION_INPUT_INVALID')
          }
          const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW)
          let bytes: Buffer
          try {
            const opened = await source.stat()
            if (!sameFile(sourceMetadata, opened)) throw failure('CONVERSION_INPUT_INVALID')
            bytes = await source.readFile()
            const after = await source.stat()
            const current = await lstat(sourcePath)
            if (!sameFile(opened, after) || !sameFile(after, current) || bytes.byteLength !== after.size) {
              throw failure('CONVERSION_INPUT_INVALID')
            }
          } finally {
            await source.close()
          }
          const probe = probeConversionInput({
            bytes,
            displayName: name,
            mimeType: 'application/octet-stream',
          })
          const id = makeId()
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(id) || records.has(id)) {
            throw failure('CONVERSION_INPUT_INVALID')
          }
          const temporary = join(drafts, `${id}.${randomUUID()}.partial`)
          const final = join(drafts, `${id}.input`)
          const destination = await open(temporary, 'wx', 0o600)
          try {
            await destination.writeFile(bytes)
            await destination.sync()
          } finally {
            await destination.close()
          }
          const record: DeveloperDraftRecord = Object.freeze({
            id,
            ownerUserId: options.ownerUserId,
            projectId: input.projectId,
            name,
            mimeType: probe.mimeType,
            byteSize: probe.byteSize,
            detectedFormat: probe.format,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            relativePath: `.developer-drafts/${id}.input`,
            probe,
          })
          staged.push({ record, temporary, final })
        }
        assertAttachmentBatchLimits([...existing.map(({ probe }) => probe), ...staged.map(({ record }) => record.probe)])
        for (const item of staged) {
          await rename(item.temporary, item.final)
          records.set(item.record.id, item.record)
        }
        return staged.map(({ record }) => publicDraft(record))
      } catch (error) {
        await Promise.all(staged.flatMap(({ temporary, final }) => [
          rm(temporary, { force: true }),
          rm(final, { force: true }),
        ]))
        const safe = toSafeAppError(error)
        throw safe.code === 'INTERNAL_ERROR' ? failure('CONVERSION_INPUT_INVALID') : safe
      }
    },

    async remove(projectId, attachmentId) {
      const record = records.get(attachmentId)
      if (!record || record.projectId !== projectId || claims.has(attachmentId)) throw failure('NOT_FOUND')
      await removeRecord(record)
    },

    async clearProject(projectId) {
      await Promise.all([...records.values()]
        .filter((record) => record.projectId === projectId && !claims.has(record.id))
        .map(removeRecord))
    },

    async clearOwner() {
      await Promise.all([...records.values()].filter((record) => !claims.has(record.id)).map(removeRecord))
    },

    get(projectId, attachmentId) {
      const record = records.get(attachmentId)
      return record?.projectId === projectId ? record : undefined
    },

    claim(projectId, executionId, attachmentIds) {
      if (!executionId.trim()
        || attachmentIds.length === 0
        || attachmentIds.length > CONVERSION_LIMITS.attachments
        || new Set(attachmentIds).size !== attachmentIds.length) throw failure('INVALID_INPUT')
      const selected = attachmentIds.map((id) => {
        const record = records.get(id)
        if (!record || record.projectId !== projectId || claims.has(id)) throw failure('NOT_FOUND')
        return record
      })
      for (const record of selected) claims.set(record.id, { executionId, materialized: false })
      return selected
    },

    async materialize(executionId, attachmentIds) {
      const drafts = await verifiedDraftDirectory()
      const inputs = await ensureDirectory(join(root, 'inputs'))
      if (!inside(await realpath(root), inputs)) throw failure('CONVERSION_INPUT_INVALID')
      for (const id of attachmentIds) {
        const record = records.get(id)
        const claim = claims.get(id)
        if (!record || claim?.executionId !== executionId || claim.materialized) {
          throw failure('CONVERSION_INPUT_INVALID')
        }
        const source = join(drafts, `${id}.input`)
        const destination = join(inputs, `${id}.input`)
        if (!inside(drafts, source) || !inside(inputs, destination)) throw failure('CONVERSION_INPUT_INVALID')
        const destinationExists = await lstat(destination).then(
          () => true,
          (error: unknown) => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
            throw error
          },
        )
        if (destinationExists) throw failure('CONVERSION_INPUT_INVALID')
        const before = await lstat(source)
        if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.size !== record.byteSize) {
          throw failure('CONVERSION_INPUT_INVALID')
        }
        const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const opened = await handle.stat()
          if (!sameFile(before, opened)) throw failure('CONVERSION_INPUT_INVALID')
          const bytes = await handle.readFile()
          const after = await handle.stat()
          if (!sameFile(opened, after)
            || bytes.byteLength !== record.byteSize
            || createHash('sha256').update(bytes).digest('hex') !== record.sha256) {
            throw failure('CONVERSION_INPUT_INVALID')
          }
          const probe = probeConversionInput({
            bytes,
            displayName: record.name,
            mimeType: record.mimeType,
          })
          if (probe.format !== record.detectedFormat
            || probe.mimeType !== record.mimeType
            || probe.byteSize !== record.byteSize) {
            throw failure('CONVERSION_INPUT_INVALID')
          }
        } finally {
          await handle.close()
        }
        await rename(source, destination)
        try {
          const moved = await lstat(destination)
          if (!sameFile(before, moved) || moved.nlink !== 1) throw failure('CONVERSION_INPUT_INVALID')
          options.artifacts.create({
            id,
            ownerUserId: options.ownerUserId,
            executionId,
            role: 'input',
            displayName: record.name,
            detectedFormat: record.detectedFormat,
            mimeType: record.mimeType,
            byteSize: record.byteSize,
            sha256: record.sha256,
            relativePath: `inputs/${id}.input`,
          })
          claim.materialized = true
        } catch (error) {
          await rename(destination, source).catch(() => undefined)
          throw error
        }
      }
    },

    async releaseExecution(executionId, referencedAttachmentIds) {
      const selected = [...claims.entries()].filter(([, claim]) => claim.executionId === executionId)
      for (const [id, claim] of selected) {
        const record = records.get(id)
        if (!record) continue
        if (referencedAttachmentIds.has(id)) {
          claims.delete(id)
          records.delete(id)
          continue
        }
        if (!claim.materialized) {
          claims.delete(id)
          await removeRecord(record)
          continue
        }
        const artifact = options.artifacts.getOwned(id, options.ownerUserId)
        if (!artifact || artifact.executionId !== executionId || artifact.role !== 'input' || artifact.status !== 'ready') {
          throw failure('CONVERSION_INPUT_INVALID')
        }
        const inputs = await ensureDirectory(join(root, 'inputs'))
        const source = join(inputs, `${id}.input`)
        const trash = await ensureDirectory(join(root, '.trash'))
        const quarantined = join(trash, `${id}.quarantine-${randomUUID()}`)
        if (!inside(inputs, source) || !inside(trash, quarantined)) throw failure('CONVERSION_INPUT_INVALID')
        await rename(source, quarantined)
        if (!options.artifacts.markDeleted(id, options.ownerUserId, artifact)) {
          await rename(quarantined, source).catch(() => undefined)
          throw failure('CONVERSION_INPUT_INVALID')
        }
        await rm(quarantined, { force: true })
        claims.delete(id)
        records.delete(id)
      }
    },
  }
}
