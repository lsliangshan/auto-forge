import { lstat, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
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

  it('accepts an unchanged inode after intentional materialization rename', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-developer-draft-materialize-'))
    roots.push(root)
    const source = join(root, 'source.bmp')
    const bytes = bmp(7)
    await writeFile(source, bytes)
    const artifacts = artifactRepository()
    const service = createDeveloperAttachmentDraftService({
      dataRoot: root, ownerUserId: 'user_1', artifacts, id: () => 'draft_1',
    })
    await service.recover()
    const [draft] = await service.importPaths({
      projectId: 'project_1', existingAttachmentIds: [], paths: [source],
    })
    service.claim('project_1', 'execution_1', [draft!.id])

    await expect(service.materialize('execution_1', [draft!.id])).resolves.toBeUndefined()
    expect(await readFile(join(resolveUserConversionRoot(root, 'user_1'), 'inputs', 'draft_1.input'))).toEqual(bytes)
    expect(artifacts.records.get('draft_1')).toMatchObject({ role: 'input', status: 'ready' })
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

  it('serializes concurrent picks against the Main-owned five-file inventory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-developer-draft-quota-'))
    roots.push(root)
    const sources = await Promise.all(Array.from({ length: 6 }, async (_, index) => {
      const path = join(root, `source-${index}.bmp`)
      await writeFile(path, bmp(index))
      return path
    }))
    const service = createDeveloperAttachmentDraftService({
      dataRoot: root, ownerUserId: 'user_1', artifacts: artifactRepository(),
    })
    await service.recover()

    const results = await Promise.all([
      service.importPaths({ projectId: 'project_1', existingAttachmentIds: [], paths: sources.slice(0, 3) }),
      service.importPaths({ projectId: 'project_1', existingAttachmentIds: [], paths: sources.slice(3) }),
    ])
    expect(results.flat()).toHaveLength(5)
    expect((await readdir(join(resolveUserConversionRoot(root, 'user_1'), '.developer-drafts')))
      .filter((name) => name.endsWith('.input'))).toHaveLength(5)
  })

  it('retains the exact materialized inode in quarantine after execution release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-developer-draft-release-'))
    roots.push(root)
    const source = join(root, 'source.bmp')
    const bytes = bmp(9)
    await writeFile(source, bytes)
    const artifacts = artifactRepository()
    const service = createDeveloperAttachmentDraftService({
      dataRoot: root, ownerUserId: 'user_1', artifacts, id: () => 'draft_1',
    })
    await service.recover()
    const [draft] = await service.importPaths({ projectId: 'project_1', existingAttachmentIds: [], paths: [source] })
    service.claim('project_1', 'execution_1', [draft!.id])
    await service.materialize('execution_1', [draft!.id])
    const input = join(resolveUserConversionRoot(root, 'user_1'), 'inputs', 'draft_1.input')
    const inputIdentity = await lstat(input)

    await service.releaseExecution('execution_1', new Set())

    const quarantine = join(resolveUserConversionRoot(root, 'user_1'), '.trash')
    const candidate = (await readdir(quarantine)).find((name) => name.startsWith('draft_1.quarantine-'))
    expect(candidate).toBeDefined()
    const quarantinedIdentity = await lstat(join(quarantine, candidate!))
    expect({ dev: quarantinedIdentity.dev, ino: quarantinedIdentity.ino }).toEqual({ dev: inputIdentity.dev, ino: inputIdentity.ino })
    expect(artifacts.records.get('draft_1')).toMatchObject({ status: 'deleted' })
  })

  it('preserves a replacement node when removing a draft record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-developer-draft-replacement-'))
    roots.push(root)
    const source = join(root, 'source.bmp')
    await writeFile(source, bmp(3))
    const service = createDeveloperAttachmentDraftService({
      dataRoot: root, ownerUserId: 'user_1', artifacts: artifactRepository(), id: () => 'draft_1',
    })
    await service.recover()
    const [draft] = await service.importPaths({ projectId: 'project_1', existingAttachmentIds: [], paths: [source] })
    const input = join(resolveUserConversionRoot(root, 'user_1'), '.developer-drafts', `${draft!.id}.input`)
    await unlink(input)
    await writeFile(input, 'sentinel')

    await expect(service.remove('project_1', draft!.id)).rejects.toMatchObject({ code: 'CONVERSION_INPUT_INVALID' })
    expect(await readFile(input, 'utf8')).toBe('sentinel')
    expect(service.get('project_1', draft!.id)).toBeDefined()
  })

  it('publishes no records and preserves a colliding sentinel on a later batch failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-developer-draft-atomic-'))
    roots.push(root)
    const sourcePaths = await Promise.all([1, 2].map(async (value) => {
      const path = join(root, `source-${value}.bmp`)
      await writeFile(path, bmp(value))
      return path
    }))
    const service = createDeveloperAttachmentDraftService({
      dataRoot: root, ownerUserId: 'user_1', artifacts: artifactRepository(),
      id: (() => { let index = 0; return () => `draft_${++index}` })(),
    })
    await service.recover()
    const drafts = join(resolveUserConversionRoot(root, 'user_1'), '.developer-drafts')
    const sentinel = join(drafts, 'draft_2.input')
    await writeFile(sentinel, 'sentinel')

    await expect(service.importPaths({ projectId: 'project_1', existingAttachmentIds: [], paths: sourcePaths }))
      .rejects.toMatchObject({ code: 'CONVERSION_INPUT_INVALID' })
    expect(await readFile(sentinel, 'utf8')).toBe('sentinel')
    expect((await readdir(drafts)).filter((name) => name.endsWith('.input'))).toEqual(['draft_2.input'])
    expect(service.get('project_1', 'draft_1')).toBeUndefined()
  })

  it('rejects a same-byte replacement before materializing a claimed draft', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-developer-draft-same-byte-source-'))
    roots.push(root)
    const source = join(root, 'source.bmp')
    const bytes = bmp(4)
    await writeFile(source, bytes)
    const service = createDeveloperAttachmentDraftService({
      dataRoot: root, ownerUserId: 'user_1', artifacts: artifactRepository(), id: () => 'draft_1',
    })
    await service.recover()
    const [draft] = await service.importPaths({ projectId: 'project_1', existingAttachmentIds: [], paths: [source] })
    const input = join(resolveUserConversionRoot(root, 'user_1'), '.developer-drafts', `${draft!.id}.input`)
    await unlink(input)
    await writeFile(input, bytes)
    service.claim('project_1', 'execution_1', [draft!.id])

    await expect(service.materialize('execution_1', [draft!.id]))
      .rejects.toMatchObject({ code: 'CONVERSION_INPUT_INVALID' })
    expect(await readFile(input)).toEqual(bytes)
  })

  it('rejects a same-byte replacement of a materialized input during release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-developer-draft-same-byte-release-'))
    roots.push(root)
    const source = join(root, 'source.bmp')
    const bytes = bmp(5)
    await writeFile(source, bytes)
    const artifacts = artifactRepository()
    const service = createDeveloperAttachmentDraftService({
      dataRoot: root, ownerUserId: 'user_1', artifacts, id: () => 'draft_1',
    })
    await service.recover()
    const [draft] = await service.importPaths({ projectId: 'project_1', existingAttachmentIds: [], paths: [source] })
    service.claim('project_1', 'execution_1', [draft!.id])
    await service.materialize('execution_1', [draft!.id])
    const input = join(resolveUserConversionRoot(root, 'user_1'), 'inputs', `${draft!.id}.input`)
    await unlink(input)
    await writeFile(input, bytes)

    await expect(service.releaseExecution('execution_1', new Set()))
      .rejects.toMatchObject({ code: 'CONVERSION_INPUT_INVALID' })
    expect(await readFile(input)).toEqual(bytes)
    expect(artifacts.records.get('draft_1')).toMatchObject({ status: 'ready' })
  })
})
