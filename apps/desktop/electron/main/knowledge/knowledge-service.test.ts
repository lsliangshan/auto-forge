import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { KnowledgeStoreFactory } from './encrypted-database.js'
import { createLocalKnowledgeService } from './knowledge-service.js'
import type { KnowledgeParserPort } from './import-job-runner.js'
import { memoryKnowledgeStore, parsedText } from './knowledge-test-support.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

describe('local knowledge service', () => {
  it.runIf(process.platform === 'darwin' && process.arch === 'arm64')(
    'recovers a durable import through the real encrypted store after restart',
    async () => {
      // Catches integration drift between service jobs, Task 2 encrypted schema/objects, and restart recovery.
      const root = await mkdtemp(join(tmpdir(), 'autoforge-knowledge-service-integration-'))
      const factory = new KnowledgeStoreFactory(root, {
        isAvailable: async () => true,
        encrypt: async value => Buffer.from(value, 'utf8'),
        decrypt: async value => ({ value: value.toString('utf8'), shouldReEncrypt: false }),
      })
      const parserStarted = deferred<void>()
      const first = createLocalKnowledgeService({
        openStore: ownerId => factory.open(ownerId),
        selectImportFiles: async () => [{
          name: '合同.txt', mimeType: 'text/plain', bytes: Buffer.from('合同条款第一项'),
        }],
        createParser: () => ({
          parse: async ({ signal }) => new Promise((_, reject) => {
            parserStarted.resolve()
            signal?.addEventListener('abort', () => { reject(new Error('cancelled')) }, { once: true })
          }),
          terminateAll: async () => undefined,
        }),
        saveExport: async () => undefined,
        isMember: () => false,
      })
      try {
        await first.bind('alice')
        const base = await first.create({ userId: 'alice' }, '我的资料')
        const [handle] = await first.pickImportFiles({ userId: 'alice' })
        await first.importDocument({ userId: 'alice' }, base.id, handle!.id)
        await parserStarted.promise
        first.invalidate()
        await first.drain()

        const restarted = createLocalKnowledgeService({
          openStore: ownerId => factory.open(ownerId),
          selectImportFiles: async () => [],
          createParser: () => ({
            parse: async () => parsedText('合同条款第一项'),
            terminateAll: async () => undefined,
          }),
          saveExport: async () => undefined,
          isMember: () => false,
        })
        await restarted.bind('alice')
        await vi.waitFor(async () => {
          expect(await restarted.listDocuments({ userId: 'alice' }, base.id)).toEqual([
            expect.objectContaining({ status: 'ready', versionCount: 1 }),
          ])
        })
        await expect(restarted.search({ userId: 'alice' }, '合同条款')).resolves.toMatchObject({
          kind: 'results',
          strategy: 'trigram',
          evidence: [expect.objectContaining({ baseId: base.id, snippet: '合同条款第一项' })],
        })
        restarted.invalidate()
        await restarted.drain()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it('keeps authentication usable when encryption or parser admission fails closed', async () => {
    // Catches unsupported native/parser targets turning a knowledge gate into an application login failure.
    const encryptionUnavailable = createLocalKnowledgeService({
      openStore: async () => { throw new Error('native unavailable') },
      selectImportFiles: async () => [],
      createParser: () => { throw new Error('must not run') },
      saveExport: async () => undefined,
      isMember: () => false,
    })
    await expect(encryptionUnavailable.bind('alice')).resolves.toBeUndefined()
    await expect(encryptionUnavailable.getAvailability({ userId: 'alice' })).resolves.toMatchObject({
      encryption: { available: false, reason: 'encryption_unavailable' },
      parser: { available: false, reason: 'parser_unavailable' },
    })
    await expect(encryptionUnavailable.list({ userId: 'alice' }))
      .rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })

    const memory = memoryKnowledgeStore()
    const parserUnavailable = createLocalKnowledgeService({
      openStore: async () => memory.store,
      selectImportFiles: async () => [],
      createParser: () => { throw new Error('parser unavailable') },
      saveExport: async () => undefined,
      isMember: () => false,
    })
    await expect(parserUnavailable.bind('alice')).resolves.toBeUndefined()
    await expect(parserUnavailable.getAvailability({ userId: 'alice' })).resolves.toMatchObject({
      encryption: { available: true },
      parser: { available: false, reason: 'parser_unavailable' },
    })
    expect(memory.closes()).toBe(1)
  })

  it('derives all access from its bound owner and enforces the free one-base/one-active-file limits', async () => {
    // Catches missing owner equality checks or renderer-bypassable free-tier limits.
    const memory = memoryKnowledgeStore()
    const selected = [
      { name: '合同.txt', mimeType: 'text/plain' as const, bytes: Buffer.from('合同条款甲') },
      { name: '附件.txt', mimeType: 'text/plain' as const, bytes: Buffer.from('附件条款乙') },
    ]
    const service = createLocalKnowledgeService({
      openStore: async () => memory.store,
      selectImportFiles: async () => selected.splice(0),
      createParser: () => ({ parse: async () => parsedText('合同条款甲'), terminateAll: async () => undefined }),
      saveExport: async () => undefined,
      isMember: () => false,
    })
    await service.bind('alice')

    const base = await service.create({ userId: 'alice' }, '我的资料')
    await expect(service.create({ userId: 'alice' }, '第二个')).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(service.list({ userId: 'bob' })).rejects.toMatchObject({ code: 'FORBIDDEN' })

    const handles = await service.pickImportFiles({ userId: 'alice' })
    const acknowledged = await service.importDocument({ userId: 'alice' }, base.id, handles[0]!.id)
    expect(acknowledged).toMatchObject({ status: 'queued', versionCount: 1 })
    await expect(service.importDocument({ userId: 'alice' }, base.id, handles[1]!.id))
      .rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('preserves query-too-short and bounded two-character search results through the service DTO', async () => {
    const memory = memoryKnowledgeStore()
    const service = createLocalKnowledgeService({
      openStore: async () => memory.store,
      selectImportFiles: async () => [],
      createParser: () => ({ parse: async () => parsedText('unused'), terminateAll: async () => undefined }),
      saveExport: async () => undefined,
      isMember: () => false,
    })
    await service.bind('alice')

    await expect(service.search({ userId: 'alice' }, '合')).resolves.toEqual({ kind: 'query-too-short' })
    await expect(service.search({ userId: 'alice' }, '合同')).resolves.toEqual({
      kind: 'results', strategy: 'bounded-instr', evidence: [],
    })
  })

  it('acknowledges a durable import without awaiting parsing and rejects a late owner callback', async () => {
    // Catches imports that block on parsing or publish after owner invalidation.
    const memory = memoryKnowledgeStore()
    const parserStarted = deferred<void>()
    const parserResult = deferred<ReturnType<typeof parsedText>>()
    const service = createLocalKnowledgeService({
      openStore: async () => memory.store,
      selectImportFiles: async () => [{
        name: '合同.txt', mimeType: 'text/plain', bytes: Buffer.from('合同条款'),
      }],
      createParser: () => ({
        parse: async () => { parserStarted.resolve(); return parserResult.promise },
        terminateAll: async () => undefined,
      }),
      saveExport: async () => undefined,
      isMember: () => false,
    })
    await service.bind('alice')
    const base = await service.create({ userId: 'alice' }, '我的资料')
    const [handle] = await service.pickImportFiles({ userId: 'alice' })

    const startedAt = performance.now()
    const document = await service.importDocument({ userId: 'alice' }, base.id, handle!.id)
    expect(performance.now() - startedAt).toBeLessThan(1_000)
    expect(document).toMatchObject({ status: 'queued' })
    await parserStarted.promise

    service.invalidate()
    parserResult.resolve(parsedText('合同条款'))
    await service.drain()

    expect(memory.database.prepare('SELECT status FROM document_versions').get()).toEqual({ status: 'staging' })
    await expect(service.list({ userId: 'alice' })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    expect(memory.closes()).toBe(1)
  })

  it('invalidates callbacks immediately but leaves the store open until admitted work drains', async () => {
    // Catches owner invalidation closing a lease underneath an already admitted export/import operation.
    const memory = memoryKnowledgeStore()
    const saveStarted = deferred<void>()
    const releaseSave = deferred<void>()
    const service = createLocalKnowledgeService({
      openStore: async () => memory.store,
      selectImportFiles: async () => [],
      createParser: () => ({ parse: async () => parsedText('unused'), terminateAll: async () => undefined }),
      saveExport: async () => { saveStarted.resolve(); await releaseSave.promise },
      isMember: () => false,
    })
    await service.bind('alice')
    const base = await service.create({ userId: 'alice' }, '我的资料')
    const exporting = service.exportBase({ userId: 'alice' }, base.id)
    await saveStarted.promise

    service.invalidate()
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(memory.closes()).toBe(0)

    releaseSave.resolve()
    await exporting
    await service.drain()
    expect(memory.closes()).toBe(1)
  })

  it('releases a stale parser and store without recovering old-owner jobs before binding the new owner', async () => {
    // Catches bind A resuming after createParser while bind B owns the newer admission epoch.
    const alice = memoryKnowledgeStore()
    const bob = memoryKnowledgeStore()
    alice.database.prepare('INSERT INTO knowledge_bases(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('base', 'Alice', 1, 1)
    alice.database.prepare(`INSERT INTO documents(
      id, knowledge_base_id, name, mime_type, active_version_id, created_at, updated_at,
      lifecycle_status, publication_generation, recycled_at
    ) VALUES ('doc', 'base', 'a.txt', 'text/plain', NULL, 1, 1, 'queued', 1, NULL)`).run()
    alice.database.prepare(`INSERT INTO document_versions(
      id, document_id, version_number, status, content_hash, object_id, created_at, publication_generation
    ) VALUES ('version', 'doc', 1, 'staging', 'hash', '00000000000000000000000000000001', 1, 1)`).run()
    alice.database.prepare(`INSERT INTO knowledge_import_jobs(
      id, document_id, version_id, generation, publication_token, status, attempt_count, created_at, updated_at
    ) VALUES ('job', 'doc', 'version', 1, 'token', 'running', 1, 1, 1)`).run()

    const parserGate = deferred<KnowledgeParserPort>()
    const parserStarted = deferred<void>()
    const staleTerminate = vi.fn(async () => undefined)
    const bobParser = { parse: async () => parsedText('bob'), terminateAll: async () => undefined }
    const service = createLocalKnowledgeService({
      openStore: async ownerId => ownerId === 'alice' ? alice.store : bob.store,
      selectImportFiles: async () => [],
      createParser: store => {
        if (store !== alice.store) return bobParser
        parserStarted.resolve()
        return parserGate.promise
      },
      saveExport: async () => undefined,
      isMember: () => false,
    })

    const bindingAlice = service.bind('alice')
    await parserStarted.promise
    service.invalidate()
    const bindingBob = service.bind('bob')
    parserGate.resolve({ parse: async () => parsedText('alice'), terminateAll: staleTerminate })

    await expect(bindingAlice).rejects.toMatchObject({ code: 'CONFLICT' })
    await bindingBob
    expect(staleTerminate).toHaveBeenCalledOnce()
    expect(alice.closes()).toBe(1)
    expect(alice.database.prepare('SELECT status FROM knowledge_import_jobs WHERE id = ?').get('job'))
      .toEqual({ status: 'running' })
    await expect(service.list({ userId: 'bob' })).resolves.toEqual([])
  })

  it('keeps a cleanup receipt when its object deletion returns after owner invalidation', async () => {
    const alice = memoryKnowledgeStore()
    const bob = memoryKnowledgeStore()
    alice.database.prepare(
      'INSERT INTO knowledge_cleanup_records(object_id, created_at) VALUES (?, ?)',
    ).run('00000000000000000000000000000001', 1)
    const deletionStarted = deferred<void>()
    const releaseDeletion = deferred<void>()
    alice.objects.delete = vi.fn(async () => { deletionStarted.resolve(); await releaseDeletion.promise })
    const createParser = vi.fn(() => ({
      parse: async () => parsedText('unused'), terminateAll: async () => undefined,
    }))
    const service = createLocalKnowledgeService({
      openStore: async ownerId => ownerId === 'alice' ? alice.store : bob.store,
      selectImportFiles: async () => [],
      createParser,
      saveExport: async () => undefined,
      isMember: () => false,
    })

    const bindingAlice = service.bind('alice')
    await deletionStarted.promise
    service.invalidate()
    const bindingBob = service.bind('bob')
    releaseDeletion.resolve()

    await expect(bindingAlice).rejects.toMatchObject({ code: 'CONFLICT' })
    await bindingBob
    expect(alice.database.prepare('SELECT object_id FROM knowledge_cleanup_records').all())
      .toEqual([{ object_id: '00000000000000000000000000000001' }])
    expect(alice.closes()).toBe(1)
    expect(createParser).toHaveBeenCalledTimes(1)
    expect(createParser).toHaveBeenCalledWith(bob.store)
  })

  it('persists failed unused-handle cleanup and propagates retire resource failures', async () => {
    // Catches logout permanently leaking copied objects or hiding parser/store cleanup failures from Application.
    const memory = memoryKnowledgeStore()
    const deleteFailure = new Error('delete failed')
    const close = vi.fn(async () => undefined)
    const service = createLocalKnowledgeService({
      openStore: async () => ({ ...memory.store, close }),
      selectImportFiles: async () => [{ name: 'draft.txt', mimeType: 'text/plain', bytes: Buffer.from('draft') }],
      createParser: () => ({ parse: async () => parsedText('unused'), terminateAll: async () => undefined }),
      saveExport: async () => undefined,
      isMember: () => false,
    })
    await service.bind('alice')
    const [handle] = await service.pickImportFiles({ userId: 'alice' })
    memory.objects.delete = vi.fn(async () => { throw deleteFailure })

    service.invalidate()
    await expect(service.drain()).rejects.toBe(deleteFailure)
    expect(close).toHaveBeenCalledOnce()
    expect(memory.database.prepare('SELECT object_id FROM knowledge_cleanup_records').all())
      .toEqual([{ object_id: [...memory.objects.values.keys()][0] }])
    expect(handle).toBeDefined()
  })

  it('propagates parser termination failure while still closing the store', async () => {
    const memory = memoryKnowledgeStore()
    const terminateFailure = new Error('terminate failed')
    const close = vi.fn(async () => undefined)
    const service = createLocalKnowledgeService({
      openStore: async () => ({ ...memory.store, close }),
      selectImportFiles: async () => [],
      createParser: () => ({
        parse: async () => parsedText('unused'),
        terminateAll: async () => { throw terminateFailure },
      }),
      saveExport: async () => undefined,
      isMember: () => false,
    })
    await service.bind('alice')

    service.invalidate()
    await expect(service.drain()).rejects.toBe(terminateFailure)
    expect(close).toHaveBeenCalledOnce()
  })

  it('propagates a store-close failure after parser retirement succeeds', async () => {
    const memory = memoryKnowledgeStore()
    const closeFailure = new Error('store close failed')
    const service = createLocalKnowledgeService({
      openStore: async () => ({ ...memory.store, close: async () => { throw closeFailure } }),
      selectImportFiles: async () => [],
      createParser: () => ({ parse: async () => parsedText('unused'), terminateAll: async () => undefined }),
      saveExport: async () => undefined,
      isMember: () => false,
    })
    await service.bind('alice')

    service.invalidate()
    await expect(service.drain()).rejects.toBe(closeFailure)
  })

  it('keeps the published document name and MIME type when a replacement fails', async () => {
    const memory = memoryKnowledgeStore()
    const selections = [
      { name: '旧合同.txt', mimeType: 'text/plain' as const, bytes: Buffer.from('旧版') },
      { name: '新版.pdf', mimeType: 'application/pdf' as const, bytes: Buffer.from('%PDF-new') },
    ]
    let parseCount = 0
    const service = createLocalKnowledgeService({
      openStore: async () => memory.store,
      selectImportFiles: async () => [selections.shift()!],
      createParser: () => ({
        parse: async () => {
          parseCount += 1
          if (parseCount === 2) throw new Error('invalid PDF')
          return parsedText('旧版')
        },
        terminateAll: async () => undefined,
      }),
      saveExport: async () => undefined,
      isMember: () => false,
    })
    await service.bind('alice')
    const base = await service.create({ userId: 'alice' }, '合同库')
    const [first] = await service.pickImportFiles({ userId: 'alice' })
    const document = await service.importDocument({ userId: 'alice' }, base.id, first!.id)
    await vi.waitFor(async () => {
      expect(await service.listDocuments({ userId: 'alice' }, base.id)).toEqual([
        expect.objectContaining({ status: 'ready', name: '旧合同.txt', mimeType: 'text/plain' }),
      ])
    })

    const [replacement] = await service.pickImportFiles({ userId: 'alice' })
    await expect(service.replaceDocument({ userId: 'alice' }, document!.id, replacement!.id))
      .resolves.toMatchObject({ status: 'ready', name: '旧合同.txt', mimeType: 'text/plain' })
    await vi.waitFor(() => {
      expect(memory.database.prepare("SELECT status FROM document_versions WHERE version_number = 2").get())
        .toEqual({ status: 'failed' })
    })
    await expect(service.listDocuments({ userId: 'alice' }, base.id)).resolves.toEqual([
      expect.objectContaining({ status: 'ready', name: '旧合同.txt', mimeType: 'text/plain' }),
    ])
  })

  it('recycles, restores, and purges local documents without exposing another base', async () => {
    // Catches recycle operations that delete immediately or restore/purge without ownership checks.
    const memory = memoryKnowledgeStore()
    const service = createLocalKnowledgeService({
      openStore: async () => memory.store,
      selectImportFiles: async () => [{ name: '合同.txt', mimeType: 'text/plain', bytes: Buffer.from('合同') }],
      createParser: () => ({ parse: async () => parsedText('合同'), terminateAll: async () => undefined }),
      saveExport: async () => undefined,
      isMember: () => false,
    })
    await service.bind('alice')
    const base = await service.create({ userId: 'alice' }, '我的资料')
    const [handle] = await service.pickImportFiles({ userId: 'alice' })
    const document = await service.importDocument({ userId: 'alice' }, base.id, handle!.id)

    await service.recycleDocument({ userId: 'alice' }, document!.id)
    expect(await service.listDocuments({ userId: 'alice' }, base.id)).toEqual([
      expect.objectContaining({ id: document!.id, status: 'deleted' }),
    ])
    await service.restoreDocument({ userId: 'alice' }, document!.id)
    expect(await service.listDocuments({ userId: 'alice' }, base.id)).toEqual([
      expect.objectContaining({ id: document!.id, status: expect.not.stringMatching('deleted') }),
    ])
    await expect(service.purgeDocument({ userId: 'alice' }, 'not-owned')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await service.recycleDocument({ userId: 'alice' }, document!.id)
    await service.purgeDocument({ userId: 'alice' }, document!.id)
    expect(await service.listDocuments({ userId: 'alice' }, base.id)).toEqual([])
  })

  it('requires recycle before restoring or purging a base', async () => {
    // Catches destructive base purge bypassing the recoverable recycle boundary.
    const memory = memoryKnowledgeStore()
    const service = createLocalKnowledgeService({
      openStore: async () => memory.store,
      selectImportFiles: async () => [],
      createParser: () => ({ parse: async () => parsedText('unused'), terminateAll: async () => undefined }),
      saveExport: async () => undefined,
      isMember: () => false,
    })
    await service.bind('alice')
    const base = await service.create({ userId: 'alice' }, '我的资料')
    await expect(service.purgeBase({ userId: 'alice' }, base.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await service.recycleBase({ userId: 'alice' }, base.id)
    await expect(service.list({ userId: 'alice' })).resolves.toEqual([
      expect.objectContaining({ id: base.id, status: 'recycled', searchable: false }),
    ])
    await service.restoreBase({ userId: 'alice' }, base.id)
    await expect(service.list({ userId: 'alice' })).resolves.toEqual([
      expect.objectContaining({ id: base.id, status: 'ready' }),
    ])
    await service.recycleBase({ userId: 'alice' }, base.id)
    await service.purgeBase({ userId: 'alice' }, base.id)
    await expect(service.list({ userId: 'alice' })).resolves.toEqual([])
  })
})
