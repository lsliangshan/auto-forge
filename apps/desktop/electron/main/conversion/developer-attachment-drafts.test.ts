import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConversionArtifact, NewConversionArtifact } from '../database/repositories.js'
import { resolveUserConversionRoot } from '../media/user-media-root.js'
import { createDeveloperAttachmentDraftService } from './developer-attachment-drafts.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function bmp(red: number): Buffer {
  const bytes = Buffer.alloc(58)
  bytes.write('BM')
  bytes.writeUInt32LE(bytes.byteLength, 2)
  bytes.writeUInt32LE(54, 10)
  bytes.writeUInt32LE(40, 14)
  bytes.writeInt32LE(1, 18)
  bytes.writeInt32LE(1, 22)
  bytes.writeUInt16LE(1, 26)
  bytes.writeUInt16LE(24, 28)
  bytes.writeUInt32LE(4, 34)
  bytes[56] = red
  return bytes
}

function artifactRepository() {
  const records = new Map<string, ConversionArtifact>()
  return {
    records,
    create(input: NewConversionArtifact) {
      const artifact = {
        ...input, status: 'ready' as const, createdAt: 1, updatedAt: 1,
      } as ConversionArtifact
      records.set(artifact.id, artifact)
      return artifact
    },
    getOwned(id: string, ownerUserId: string) {
      const artifact = records.get(id)
      return artifact?.ownerUserId === ownerUserId ? artifact : null
    },
    markDeleted(id: string, ownerUserId: string, expected: ConversionArtifact) {
      if (records.get(id) !== expected || expected.ownerUserId !== ownerUserId) return false
      records.set(id, { ...expected, status: 'deleted', updatedAt: 2, deletedAt: 2 })
      return true
    },
  }
}

describe('developer attachment drafts', () => {
  it('revalidates a claimed draft before creating an execution input artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-developer-draft-'))
    roots.push(root)
    const source = join(root, 'source.bmp')
    await writeFile(source, bmp(1))
    const artifacts = artifactRepository()
    const service = createDeveloperAttachmentDraftService({
      dataRoot: root, ownerUserId: 'user_1', artifacts, id: () => 'draft_1',
    })
    await service.recover()
    const [draft] = await service.importPaths({
      projectId: 'project_1', existingAttachmentIds: [], paths: [source],
    })
    service.claim('project_1', 'execution_1', [draft!.id])
    await writeFile(join(
      resolveUserConversionRoot(root, 'user_1'), '.developer-drafts', `${draft!.id}.input`,
    ), bmp(2))

    await expect(service.materialize('execution_1', [draft!.id]))
      .rejects.toMatchObject({ code: 'CONVERSION_INPUT_INVALID' })
    expect(artifacts.records.size).toBe(0)
  })

  it('does not overwrite an existing execution input when materializing a draft', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-developer-draft-collision-'))
    roots.push(root)
    const source = join(root, 'source.bmp')
    await writeFile(source, bmp(1))
    const artifacts = artifactRepository()
    const service = createDeveloperAttachmentDraftService({
      dataRoot: root, ownerUserId: 'user_1', artifacts, id: () => 'draft_1',
    })
    await service.recover()
    const [draft] = await service.importPaths({
      projectId: 'project_1', existingAttachmentIds: [], paths: [source],
    })
    service.claim('project_1', 'execution_1', [draft!.id])
    const inputs = join(resolveUserConversionRoot(root, 'user_1'), 'inputs')
    await mkdir(inputs, { recursive: true })
    const destination = join(inputs, `${draft!.id}.input`)
    await writeFile(destination, 'pre-existing')

    await expect(service.materialize('execution_1', [draft!.id]))
      .rejects.toMatchObject({ code: 'CONVERSION_INPUT_INVALID' })
    expect(await readFile(destination, 'utf8')).toBe('pre-existing')
    expect(artifacts.records.size).toBe(0)
  })

  it('turns source filesystem failures into path-free conversion errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-developer-draft-errors-'))
    roots.push(root)
    const service = createDeveloperAttachmentDraftService({
      dataRoot: root, ownerUserId: 'user_1', artifacts: artifactRepository(),
    })
    await service.recover()

    await expect(service.importPaths({
      projectId: 'project_1', existingAttachmentIds: [], paths: [join(root, 'missing-source.bmp')],
    })).rejects.toMatchObject({ code: 'CONVERSION_INPUT_INVALID' })
  })
})
