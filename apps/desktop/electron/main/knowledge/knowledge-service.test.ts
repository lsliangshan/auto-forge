import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { KnowledgeEntitlementState } from '@autoforge/shared'
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
  it('keeps only the Main-selected free allowance writable/searchable after membership expiry', async () => {
    const memory = memoryKnowledgeStore()
    let entitlement: KnowledgeEntitlementState = {
      tier: 'member' as const,
      status: 'active' as const,
      localEnabled: true as const,
      betaEnabled: true,
      cloudEnabled: true,
      expiresAt: '2026-08-28T00:00:00.000Z',
      graceEndsAt: '2026-08-31T00:00:00.000Z',
    }
    const selected = [
      { name: '甲.txt', mimeType: 'text/plain' as const, bytes: Buffer.from('甲库合同条款') },
      { name: '乙.txt', mimeType: 'text/plain' as const, bytes: Buffer.from('乙库采购条款') },
      { name: '替换.txt', mimeType: 'text/plain' as const, bytes: Buffer.from('不可替换') },
    ]
    let parsed = 0
    const saveExport = vi.fn()
    const service = createLocalKnowledgeService({
      openStore: async () => memory.store,
      selectImportFiles: async () => [selected.shift()!],
      createParser: () => ({
        parse: async () => parsedText(++parsed === 1 ? '甲库合同条款' : '乙库采购条款'),
        terminateAll: async () => undefined,
      }),
      saveExport,
      isMember: () => false,
      entitlement: () => entitlement,
      cloudKillSwitchEnabled: () => true,
    })
    const owner = { userId: 'alice' }
    await service.bind(owner.userId)
    const firstBase = await service.create(owner, '甲库')
    let handle = (await service.pickImportFiles(owner))[0]!
    const firstDocument = (await service.importDocument(owner, firstBase.id, handle.id))!
    const secondBase = await service.create(owner, '乙库')
    handle = (await service.pickImportFiles(owner))[0]!
    const secondDocument = (await service.importDocument(owner, secondBase.id, handle.id))!
    await vi.waitFor(async () => {
      expect(await service.listDocuments(owner, secondBase.id)).toEqual([
        expect.objectContaining({ id: secondDocument.id, status: 'ready' }),
      ])
    })

    entitlement = {
      ...entitlement,
      tier: 'free',
      status: 'expired',
      betaEnabled: false,
      cloudEnabled: false,
      expiresAt: '2020-08-20T00:00:00.000Z',
      graceEndsAt: '2020-08-23T00:00:00.000Z',
    }
    await expect(service.getEntitlement(owner)).resolves.toMatchObject({
      tier: 'free', status: 'expired', retainedBaseId: firstBase.id,
      retainedDocumentId: firstDocument.id,
    })
    await expect(service.list(owner)).resolves.toEqual([
      expect.objectContaining({ id: firstBase.id, status: 'ready', searchable: true }),
      expect.objectContaining({ id: secondBase.id, status: 'read_only', searchable: false, readOnly: true }),
    ])
    await expect(service.searchSelected(owner, '采购条款', [secondBase.id])).resolves.toMatchObject({
      kind: 'results', evidence: [],
    })

    await expect(service.retainFreeAllowance(owner, {
      baseId: secondBase.id, documentId: secondDocument.id,
    })).resolves.toMatchObject({ retainedBaseId: secondBase.id, retainedDocumentId: secondDocument.id })
    await expect(service.searchSelected(owner, '采购条款', [secondBase.id])).resolves.toMatchObject({
      kind: 'results', evidence: [expect.objectContaining({ documentId: secondDocument.id })],
    })
    await expect(service.retainFreeAllowance(owner, {
      baseId: firstBase.id, documentId: firstDocument.id,
    })).rejects.toMatchObject({ code: 'CONFLICT' })
    const replacement = (await service.pickImportFiles(owner))[0]!
    await expect(service.replaceDocument(owner, firstDocument.id, replacement.id))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(service.exportBase(owner, firstBase.id)).resolves.toBeUndefined()
    expect(saveExport).toHaveBeenCalledOnce()
    await expect(service.recycleBase(owner, firstBase.id)).resolves.toBeUndefined()
  })

  it('drops a late entitlement refresh after the owner epoch is invalidated', async () => {
    const alice = memoryKnowledgeStore()
    const bob = memoryKnowledgeStore()
    const refreshed = deferred<KnowledgeEntitlementState>()
    const service = createLocalKnowledgeService({
      openStore: async ownerId => ownerId === 'alice' ? alice.store : bob.store,
      selectImportFiles: async () => [],
      createParser: () => ({ parse: async () => parsedText('unused'), terminateAll: async () => undefined }),
      saveExport: async () => undefined,
      isMember: () => false,
      refreshEntitlement: async () => refreshed.promise,
    })
    await service.bind('alice')
    const pending = service.refreshEntitlement!('alice')
    service.invalidate()
    const rebound = service.bind('bob')
    refreshed.resolve({
      tier: 'member', status: 'active', localEnabled: true, betaEnabled: true, cloudEnabled: true,
    })

    await expect(pending).rejects.toMatchObject({ code: 'CONFLICT' })
    await rebound
    await expect(service.getEntitlement({ userId: 'bob' })).resolves.toMatchObject({
      tier: 'free', cloudEnabled: false,
    })
  })

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
    await expect(service.searchSelected({ userId: 'alice' }, '合同', ['base_forged']))
      .resolves.toEqual({ kind: 'results', strategy: 'bounded-instr', evidence: [] })
    await expect(service.searchSelected({ userId: 'bob' }, '合同', ['base_forged']))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(service.sourceAvailable({ userId: 'alice' }, 'document_missing', 'version_missing'))
      .resolves.toBe(false)
  })

  it('persists consent per owner and Provider and revalidates lazy source previews', async () => {
    const memory = memoryKnowledgeStore()
    let pick = 0
    let parse = 0
    const service = createLocalKnowledgeService({
      openStore: async () => memory.store,
      selectImportFiles: async () => [pick++ === 0
        ? { name: '合同.txt', mimeType: 'text/plain', bytes: Buffer.from('合同经双方签字后生效。') }
        : { name: '合同-v2.txt', mimeType: 'text/plain', bytes: Buffer.from('合同经盖章后生效。') }],
      createParser: () => ({
        parse: async () => parsedText(parse++ === 0
          ? '合同经双方签字后生效。 路径/etc/private,path=/opt/autoforge,source:/Users/alice/secret \\\\server\\share\\secret.txt 比例 10/2 and/or docs/readme 每秒/次'
          : '合同经盖章后生效。'),
        terminateAll: async () => undefined,
      }),
      saveExport: async () => undefined,
      isMember: () => false,
      now: () => Date.parse('2026-08-28T00:00:00.000Z'),
    })
    await service.bind('alice')
    await expect(service.getConsent({ userId: 'alice' }, 'openrouter')).resolves.toEqual({
      provider: 'openrouter', status: 'unknown',
    })
    await service.setConsent({ userId: 'alice' }, 'openrouter', 'granted')
    await expect(service.getConsent({ userId: 'alice' }, 'openrouter')).resolves.toMatchObject({ status: 'granted' })
    await expect(service.getConsent({ userId: 'alice' }, 'deepseek')).resolves.toEqual({
      provider: 'deepseek', status: 'unknown',
    })
    await service.revokeConsent({ userId: 'alice' }, 'openrouter')
    await expect(service.getConsent({ userId: 'alice' }, 'openrouter')).resolves.toMatchObject({ status: 'unknown' })

    const base = await service.create({ userId: 'alice' }, '合同库')
    const [handle] = await service.pickImportFiles({ userId: 'alice' })
    const document = await service.importDocument({ userId: 'alice' }, base.id, handle!.id)
    await vi.waitFor(async () => {
      expect((await service.listDocuments({ userId: 'alice' }, base.id))[0]?.status).toBe('ready')
    })
    const search = await service.searchSelected({ userId: 'alice' }, '合同经双', [base.id])
    if (search.kind !== 'results' || !search.evidence[0]) throw new Error('Expected evidence')
    const evidence = search.evidence[0]
    const preview = await service.getSourcePreview({ userId: 'alice' }, {
      evidenceId: evidence.id, baseId: evidence.baseId, documentId: evidence.documentId,
      versionId: evidence.versionId, coordinate: evidence.citation.coordinate,
    })
    expect(preview).toMatchObject({ kind: 'available', preview: expect.stringContaining('合同') })
    expect(JSON.stringify(preview)).not.toMatch(/\/etc\/private|\/opt\/autoforge|\/Users\/alice|server\\share/u)
    expect(JSON.stringify(preview)).toContain('比例 10/2 and/or docs/readme 每秒/次')
    const [replacement] = await service.pickImportFiles({ userId: 'alice' })
    await service.replaceDocument({ userId: 'alice' }, document!.id, replacement!.id)
    await vi.waitFor(async () => {
      const replacementSearch = await service.searchSelected({ userId: 'alice' }, '盖章后生', [base.id])
      const replacementVersion = replacementSearch.kind === 'results' ? replacementSearch.evidence[0]?.versionId : undefined
      expect(replacementVersion).toBeTruthy()
      expect(replacementVersion).not.toBe(evidence.versionId)
    })
    await expect(service.getSourcePreview({ userId: 'alice' }, {
      evidenceId: evidence.id, baseId: evidence.baseId, documentId: evidence.documentId,
      versionId: evidence.versionId, coordinate: evidence.citation.coordinate,
    })).resolves.toEqual({ kind: 'unavailable' })
    await service.recycleDocument({ userId: 'alice' }, document!.id)
    await expect(service.getSourcePreview({ userId: 'alice' }, {
      evidenceId: evidence.id, baseId: evidence.baseId, documentId: evidence.documentId,
      versionId: evidence.versionId, coordinate: evidence.citation.coordinate,
    })).resolves.toEqual({ kind: 'unavailable' })
    await service.purgeDocument({ userId: 'alice' }, document!.id)
    await expect(service.getSourcePreview({ userId: 'alice' }, {
      evidenceId: evidence.id, baseId: evidence.baseId, documentId: evidence.documentId,
      versionId: evidence.versionId, coordinate: evidence.citation.coordinate,
    })).resolves.toEqual({ kind: 'unavailable' })
    await service.setConsent({ userId: 'alice' }, 'deepseek', 'denied')
    service.invalidate()
    await service.drain()
    await service.bind('alice')
    await expect(service.getConsent({ userId: 'alice' }, 'deepseek')).resolves.toMatchObject({
      provider: 'deepseek', status: 'denied',
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
    service.invalidate()
    await expect(service.drain()).resolves.toBeUndefined()
  })

  it('rethrows the first stale-bind cleanup failure from drain after the lifecycle tail settles', async () => {
    // Catches the serialization tail handling a rejection but permanently hiding it from Application shutdown.
    const alice = memoryKnowledgeStore()
    const bob = memoryKnowledgeStore()
    const parserStarted = deferred<void>()
    const parserGate = deferred<KnowledgeParserPort>()
    const terminateFailure = new Error('stale parser termination failed')
    const closeFailure = new Error('stale store close failed')
    const terminateAll = vi.fn(async () => { throw terminateFailure })
    const closeAlice = vi.fn(async () => { throw closeFailure })
    const service = createLocalKnowledgeService({
      openStore: async ownerId => ownerId === 'alice' ? { ...alice.store, close: closeAlice } : bob.store,
      selectImportFiles: async () => [],
      createParser: store => {
        if (store.database !== alice.database) {
          return { parse: async () => parsedText('bob'), terminateAll: async () => undefined }
        }
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
    parserGate.resolve({ parse: async () => parsedText('alice'), terminateAll })

    await expect(bindingAlice).rejects.toBe(terminateFailure)
    await bindingBob
    expect(terminateAll).toHaveBeenCalledOnce()
    expect(closeAlice).toHaveBeenCalledOnce()
    service.invalidate()
    await expect(service.drain()).rejects.toBe(terminateFailure)
    await expect(service.drain()).resolves.toBeUndefined()
  })

  it('retains a stale-bind store-close failure when parser termination succeeds', async () => {
    const memory = memoryKnowledgeStore()
    const parserStarted = deferred<void>()
    const parserGate = deferred<KnowledgeParserPort>()
    const closeFailure = new Error('stale store close failed')
    const close = vi.fn(async () => { throw closeFailure })
    const service = createLocalKnowledgeService({
      openStore: async () => ({ ...memory.store, close }),
      selectImportFiles: async () => [],
      createParser: async () => { parserStarted.resolve(); return parserGate.promise },
      saveExport: async () => undefined,
      isMember: () => false,
    })

    const binding = service.bind('alice')
    await parserStarted.promise
    service.invalidate()
    parserGate.resolve({ parse: async () => parsedText('alice'), terminateAll: async () => undefined })

    await expect(binding).rejects.toBe(closeFailure)
    expect(close).toHaveBeenCalledOnce()
    await expect(service.drain()).rejects.toBe(closeFailure)
    await expect(service.drain()).resolves.toBeUndefined()
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
