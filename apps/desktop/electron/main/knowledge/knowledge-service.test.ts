import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { KnowledgeEntitlementState } from '@autoforge/shared'
import { KnowledgeStoreFactory } from './encrypted-database.js'
import { createLocalKnowledgeService } from './knowledge-service.js'
import { canonicalizeEntitlementPayload, KnowledgeEntitlementVerifier } from './entitlement-verifier.js'
import type { KnowledgeParserPort } from './import-job-runner.js'
import { memoryKnowledgeStore, parsedText } from './knowledge-test-support.js'
import type { CloudKnowledgeRemote } from './sync-service.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

function cloudRemote(overrides: Partial<CloudKnowledgeRemote> = {}): CloudKnowledgeRemote {
  return {
    beginSync: vi.fn().mockResolvedValue({
      knowledgeBaseId: 'unused', generationId: 'unused', status: 'staging',
    }),
    pushMutation: vi.fn(async input => ({
      mutationId: input.mutationId, status: 'applied' as const,
      sequence: 1, revision: input.mutationId,
    })),
    pullChanges: vi.fn(async input => ({
      kind: 'incremental' as const,
      nextSequence: input.afterSequence,
      hasMore: false,
      changes: [],
    })),
    fullResync: vi.fn().mockResolvedValue({ kind: 'snapshot', nextSequence: 0, changes: [] }),
    listKnowledgeBases: vi.fn().mockResolvedValue([]),
    publishGeneration: vi.fn().mockResolvedValue({
      generationId: 'unused', previousGenerationId: null, sequence: 1,
    }),
    deleteKnowledgeBase: vi.fn().mockResolvedValue({ deletionJobId: 'unused' }),
    getJob: vi.fn().mockResolvedValue({
      jobId: 'unused', state: 'completed', errorCode: null,
    }),
    cancelJob: vi.fn().mockResolvedValue(undefined),
    cleanupOrphans: vi.fn().mockResolvedValue({ removed: 0 }),
    beginGeneration: vi.fn(async input => ({
      knowledgeBaseId: input.knowledgeBaseId,
      generationId: input.generationId,
      status: 'staging' as const,
    })),
    uploadDocument: vi.fn().mockResolvedValue({
      jobId: 'unused', storageReference: 'knowledge/unused',
    }),
    search: vi.fn().mockResolvedValue({
      generationState: 'published', generations: [], strategy: 'keyword_only_consent',
      embedding: {
        model: 'kinfra-text-embedding-0.6b', dimensions: 1024,
        configurationVersion: 'autoforge-knowledge-embedding-v1', region: 'guangzhou',
      },
      keywordCandidates: [], vectorCandidates: [], driftProbeRequired: false,
    }),
    ...overrides,
  }
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
      retainedDocumentId: firstDocument.id, retentionConfirmed: false,
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
    })).resolves.toMatchObject({
      retainedBaseId: secondBase.id, retainedDocumentId: secondDocument.id,
      retentionConfirmed: true,
    })
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

    await service.recycleDocument(owner, secondDocument.id)
    await expect(service.getEntitlement(owner)).resolves.toMatchObject({
      retainedBaseId: secondBase.id, retainedDocumentId: secondDocument.id,
      retentionConfirmed: true,
    })
    await expect(service.restoreDocument(owner, secondDocument.id)).resolves.toBeUndefined()
    await expect(service.searchSelected(owner, '采购条款', [secondBase.id])).resolves.toMatchObject({
      kind: 'results', evidence: [expect.objectContaining({ documentId: secondDocument.id })],
    })

    await service.recycleDocument(owner, secondDocument.id)
    await service.purgeDocument(owner, secondDocument.id)
    const afterPurge = await service.getEntitlement(owner)
    expect(afterPurge).toMatchObject({ retentionConfirmed: false })
    expect(afterPurge).not.toHaveProperty('retainedBaseId')
    await expect(service.list(owner)).resolves.toEqual([
      expect.objectContaining({ id: firstBase.id, readOnly: true }),
      expect.objectContaining({ id: secondBase.id, readOnly: true }),
    ])
  })

  it('persists verified grace and replay/clock floors while transient refresh failures preserve authority', async () => {
    const memory = memoryKnowledgeStore()
    const keys = generateKeyPairSync('ed25519')
    let observedAt = Date.parse('2026-08-28T00:00:00.000Z')
    let killSwitchEnabled = false
    const verifier = new KnowledgeEntitlementVerifier({
      publicKeys: {
        primary: { publicKey: keys.publicKey, generation: 1, status: 'active' },
      },
      now: () => observedAt,
    })
    const signed = (issuedAt: string, expiresAt: string) => {
      const canonical = canonicalizeEntitlementPayload({
        userId: 'alice', entitlements: ['knowledge_base_beta', 'knowledge_base_cloud'],
        issuedAt, expiresAt, keyId: 'primary',
      })
      return {
        payload: Buffer.from(canonical).toString('base64url'),
        signature: sign(null, Buffer.from(canonical), keys.privateKey).toString('base64url'),
      }
    }
    const firstSigned = signed('2026-08-27T00:00:00.000Z', '2026-08-29T00:00:00.000Z')
    const laterSigned = signed('2026-08-28T00:00:00.000Z', '2026-08-30T00:00:00.000Z')
    const createService = () => createLocalKnowledgeService({
      openStore: async () => memory.store,
      selectImportFiles: async () => [],
      createParser: () => ({ parse: async () => parsedText('unused'), terminateAll: async () => undefined }),
      saveExport: async () => undefined,
      isMember: () => false,
      now: () => observedAt,
      verifyEntitlement: (ownerId, snapshot, effectiveNow) => (
        verifier.verify(ownerId, snapshot, effectiveNow)
      ),
      cloudKillSwitchEnabled: () => killSwitchEnabled,
    })

    const first = createService()
    first.configureCloudRemote!(cloudRemote())
    await expect(first.getAvailability({ userId: 'alice' }))
      .rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    await first.bind('alice', true)
    await first.refreshEntitlement!('alice', firstSigned, true)
    await expect(first.getEntitlement({ userId: 'alice' })).resolves.toMatchObject({ tier: 'member' })
    await expect(first.getAvailability({ userId: 'alice' })).resolves.toMatchObject({
      cloudbase: { available: true },
      entitlement: { available: true },
      beta: { available: true },
      cloud: { available: true },
    })
    first.invalidate()
    await first.drain()

    const restarted = createService()
    restarted.configureCloudRemote!(cloudRemote())
    await restarted.bind('alice', true)
    await restarted.refreshEntitlement!('alice', undefined, false)
    await expect(restarted.getEntitlement({ userId: 'alice' })).resolves.toMatchObject({
      tier: 'member', status: 'active',
    })
    await expect(restarted.getAvailability({ userId: 'alice' })).resolves.toMatchObject({
      entitlement: { available: true }, beta: { available: true }, cloud: { available: true },
    })
    killSwitchEnabled = true
    await expect(restarted.getAvailability({ userId: 'alice' })).resolves.toMatchObject({
      cloudbase: { available: true },
      entitlement: { available: true }, beta: { available: true },
      cloud: { available: false },
    })
    killSwitchEnabled = false
    await restarted.refreshEntitlement!('alice', laterSigned, true)
    await expect(restarted.refreshEntitlement!('alice', firstSigned, true))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })

    observedAt = Date.parse('2026-09-02T00:00:00.000Z') + 1
    await expect(restarted.getEntitlement({ userId: 'alice' })).resolves.toMatchObject({
      tier: 'free', status: 'expired',
    })
    await expect(restarted.getAvailability({ userId: 'alice' })).resolves.toMatchObject({
      entitlement: { available: false }, beta: { available: false }, cloud: { available: false },
    })
    observedAt = Date.parse('2026-08-29T00:00:00.000Z')
    await expect(restarted.getEntitlement({ userId: 'alice' })).resolves.toMatchObject({
      tier: 'free', status: 'expired',
    })

    await restarted.refreshEntitlement!('alice', undefined, true)
    await expect(restarted.getEntitlement({ userId: 'alice' })).resolves.toMatchObject({
      tier: 'free', status: 'active', cloudEnabled: false,
    })
    await expect(restarted.getAvailability({ userId: 'alice' })).resolves.toMatchObject({
      entitlement: { available: false }, beta: { available: false }, cloud: { available: false },
    })
    await expect(restarted.refreshEntitlement!('alice', laterSigned, true))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('runs admitted cloud import, synchronization, and retrieval only through the production remote', async () => {
    const memory = memoryKnowledgeStore()
    const selected = [{
      name: 'cloud.txt', mimeType: 'text/plain' as const, bytes: Buffer.from('云端合同条款'),
    }]
    let publishedGeneration = ''
    let cloudDocumentId = ''
    let cloudVersionId = ''
    const beginGeneration = vi.fn(async (input: {
      knowledgeBaseId: string; generationId: string
    }) => ({ ...input, status: 'staging' as const }))
    const uploadDocument = vi.fn().mockResolvedValue({
      jobId: 'upload_job_1', storageReference: 'knowledge/1/base/object_1',
    })
    const search = vi.fn(async ({ knowledgeBaseIds }: { knowledgeBaseIds: string[] }) => ({
      generationState: 'published',
      generations: knowledgeBaseIds.map(knowledgeBaseId => ({
        knowledgeBaseId, generationId: publishedGeneration, previousGenerationId: null,
      })),
      strategy: 'keyword_only_consent' as const,
      embedding: {
        model: 'kinfra-text-embedding-0.6b' as const, dimensions: 1024 as const,
        configurationVersion: 'autoforge-knowledge-embedding-v1' as const,
        region: 'guangzhou' as const,
      },
      keywordCandidates: [{
        id: 'cloud_chunk_1', knowledgeBaseId: knowledgeBaseIds[0]!,
        documentId: cloudDocumentId, versionId: cloudVersionId,
        generationId: publishedGeneration, rank: 1, body: '云端合同条款',
        coordinates: { kind: 'txt', lineStart: 1, lineEnd: 1, charStart: 0, charEnd: 6 },
      }],
      vectorCandidates: [], driftProbeRequired: false,
    }))
    const remote = {
      ...cloudRemote({
        pushMutation: vi.fn(async input => ({
          mutationId: input.mutationId, status: 'applied' as const,
          sequence: 1, revision: input.mutationId,
        })),
        pullChanges: vi.fn(async input => ({
          kind: 'incremental' as const, nextSequence: input.afterSequence + 1,
          hasMore: false, changes: [{
            sequence: input.afterSequence + 1, entityKind: 'metadata' as const,
            entityId: 'remote_head_1', operation: 'upsert' as const,
            revision: 'remote_r1', payload: { source: 'remote' },
          }],
        })),
        fullResync: vi.fn().mockResolvedValue({ kind: 'snapshot', nextSequence: 0, changes: [] }),
        publishGeneration: vi.fn(async input => {
          publishedGeneration = input.generationId
          return { generationId: input.generationId, previousGenerationId: null, sequence: 7 }
        }),
        getJob: vi.fn(async input => ({
          jobId: input.jobId, state: 'completed' as const, errorCode: null,
        })),
      }),
      beginGeneration,
      uploadDocument,
      search,
    }
    const service = createLocalKnowledgeService({
      openStore: async () => memory.store,
      selectImportFiles: async () => selected.splice(0),
      createParser: () => ({
        parse: async () => parsedText('云端合同条款'), terminateAll: async () => undefined,
      }),
      saveExport: async () => undefined,
      isMember: () => true,
      entitlement: () => ({
        tier: 'member', status: 'active', localEnabled: true,
        betaEnabled: true, cloudEnabled: true,
      }),
      cloudKillSwitchEnabled: () => false,
    })
    service.configureCloudRemote!(remote)
    const owner = { userId: 'alice' }
    await service.bind(owner.userId, true)
    memory.database.prepare(`
      INSERT INTO knowledge_entitlement_projection(
        singleton, tier, status, beta_enabled, cloud_enabled, epoch, updated_at,
        accepted_key_generation, verified, explicit_free, max_observed_at
      ) VALUES (1, 'member', 'active', 1, 1, 1, 1, 1, 1, 0, 1)
    `).run()
    const base = await service.create(owner, 'Cloud')
    const handle = (await service.pickImportFiles(owner))[0]!
    const document = (await service.importDocument(owner, base.id, handle.id))!

    await vi.waitFor(() => expect(uploadDocument).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(publishedGeneration).not.toBe(''))
    cloudDocumentId = document.id
    cloudVersionId = (memory.database.prepare(`
      SELECT active_version_id AS versionId FROM documents WHERE id = ?
    `).get(document.id) as { versionId: string }).versionId
    const scope = await service.captureSearchScope(owner, [base.id])
    const result = await service.searchSelected(owner, '云端合同', [base.id], undefined, scope)

    expect(beginGeneration).toHaveBeenCalledOnce()
    expect(uploadDocument).toHaveBeenCalledWith(expect.objectContaining({
      knowledgeBaseId: base.id, documentId: document.id, bytes: expect.any(Buffer),
    }))
    expect(remote.pushMutation).toHaveBeenCalled()
    expect(remote.pushMutation).toHaveBeenCalledWith(expect.objectContaining({
      knowledgeBaseId: base.id,
      entityKind: 'knowledge_base',
      entityId: base.id,
      operation: 'upsert',
      payload: { name: 'Cloud', publishedGenerationId: publishedGeneration },
    }))
    expect(remote.pullChanges).toHaveBeenCalled()
    expect(search).toHaveBeenCalledWith({ query: '云端合同', knowledgeBaseIds: [base.id], limit: 24 })
    expect(result).toMatchObject({
      kind: 'results', evidence: [expect.objectContaining({ id: 'evidence:cloud:cloud_chunk_1' })],
    })
    expect(memory.database.prepare(`
      SELECT revision FROM cloud_entity_heads
      WHERE knowledge_base_id = ? AND entity_kind = 'metadata' AND entity_id = 'remote_head_1'
    `).get(base.id)).toEqual({ revision: 'remote_r1' })
  })

  it('discovers and materializes every personal cloud base on a cold-start list', async () => {
    const memory = memoryKnowledgeStore()
    const listKnowledgeBases = vi.fn().mockResolvedValue(['cold_base_a', 'cold_base_b'])
    const fullResync = vi.fn(async ({ knowledgeBaseId }: { knowledgeBaseId: string }) => {
      const suffix = knowledgeBaseId === 'cold_base_a' ? 'a' : 'b'
      return {
        kind: 'snapshot' as const, nextSequence: 2,
        changes: [{
          sequence: 2, entityKind: 'document' as const,
          entityId: `cold_document_${suffix}`, operation: 'upsert' as const,
          revision: `document_r_${suffix}`, payload: {
            name: `cold-${suffix}.txt`, mimeType: 'text/plain',
            versionId: `cold_version_${suffix}`, versionNumber: 1,
            contentHash: suffix.repeat(64), generationId: `cold_generation_${suffix}`,
            createdAt: 1_000,
          },
        }, {
          sequence: 2, entityKind: 'knowledge_base' as const,
          entityId: knowledgeBaseId, operation: 'upsert' as const,
          revision: `base_r_${suffix}`, payload: {
            name: `Cold ${suffix.toUpperCase()}`,
            publishedGenerationId: `cold_generation_${suffix}`,
          },
        }],
      }
    })
    const service = createLocalKnowledgeService({
      openStore: async () => memory.store,
      selectImportFiles: async () => [],
      createParser: () => ({
        parse: async () => parsedText('unused'), terminateAll: async () => undefined,
      }),
      saveExport: async () => undefined,
      isMember: () => true,
      entitlement: () => ({
        tier: 'member', status: 'active', localEnabled: true,
        betaEnabled: true, cloudEnabled: true,
      }),
      cloudKillSwitchEnabled: () => false,
    })
    service.configureCloudRemote!({
      ...cloudRemote({ fullResync }), listKnowledgeBases,
    })
    const owner = { userId: 'alice' }
    await service.bind(owner.userId, true)
    memory.database.prepare(`
      INSERT INTO knowledge_entitlement_projection(
        singleton, tier, status, beta_enabled, cloud_enabled, epoch, updated_at,
        accepted_key_generation, verified, explicit_free, max_observed_at
      ) VALUES (1, 'member', 'active', 1, 1, 1, 1, 1, 1, 0, 1)
    `).run()
    expect(memory.database.prepare(
      'SELECT count(*) AS count FROM knowledge_bases',
    ).get()).toEqual({ count: 0 })
    expect(memory.database.prepare(
      'SELECT count(*) AS count FROM cloud_base_projections',
    ).get()).toEqual({ count: 0 })

    await expect(service.list(owner)).resolves.toEqual([
      expect.objectContaining({ id: 'cold_base_a', name: 'Cold A', kind: 'cloud' }),
      expect.objectContaining({ id: 'cold_base_b', name: 'Cold B', kind: 'cloud' }),
    ])
    expect(listKnowledgeBases).toHaveBeenCalledOnce()
    expect(fullResync.mock.calls.map(([input]) => input.knowledgeBaseId))
      .toEqual(['cold_base_a', 'cold_base_b'])
    const scope = await service.captureSearchScope(owner, ['cold_base_a'])
    expect(scope.entries).toEqual([expect.objectContaining({
      baseId: 'cold_base_a', documentId: 'cold_document_a',
      versionId: 'cold_version_a', cloudGenerationId: 'cold_generation_a',
    })])
    await expect(service.sourceAvailable(
      owner, 'cold_document_a', 'cold_version_a', undefined,
    )).resolves.toBe(false)
    await expect(service.sourceVerifiable!(
      owner, 'cold_base_a', 'cold_document_a', 'cold_version_a', undefined, scope,
    )).resolves.toBe(true)
    expect(memory.database.prepare(`
      SELECT local_object_available AS localObjectAvailable
      FROM cloud_version_projections WHERE id = 'cold_version_a'
    `).get()).toEqual({ localObjectAvailable: 0 })
    service.setCloudSyncConsent!(owner.userId, false)
    service.setCloudSyncConsent!(owner.userId, true)
    await expect(service.sourceVerifiable!(
      owner, 'cold_base_a', 'cold_document_a', 'cold_version_a', undefined, scope,
    )).resolves.toBe(false)
  })

  it('does not discover or prune owner catalog projections without current cloud_sync consent', async () => {
    const memory = memoryKnowledgeStore()
    const listKnowledgeBases = vi.fn().mockResolvedValue([])
    const service = createLocalKnowledgeService({
      openStore: async () => memory.store,
      selectImportFiles: async () => [],
      createParser: () => ({
        parse: async () => parsedText('unused'), terminateAll: async () => undefined,
      }),
      saveExport: async () => undefined,
      isMember: () => true,
      entitlement: () => ({
        tier: 'member', status: 'active', localEnabled: true,
        betaEnabled: true, cloudEnabled: true,
      }),
      cloudKillSwitchEnabled: () => false,
    })
    service.configureCloudRemote!({ ...cloudRemote(), listKnowledgeBases })
    const owner = { userId: 'alice' }
    await service.bind(owner.userId, false)
    memory.database.prepare(`
      INSERT INTO knowledge_entitlement_projection(
        singleton, tier, status, beta_enabled, cloud_enabled, epoch, updated_at,
        accepted_key_generation, verified, explicit_free, max_observed_at
      ) VALUES (1, 'member', 'active', 1, 1, 1, 1, 1, 1, 0, 1)
    `).run()

    await expect(service.list(owner)).resolves.toEqual([])
    expect(listKnowledgeBases).not.toHaveBeenCalled()
  })

  it('materializes remote-only snapshots, stale replacement, incrementals, and tombstones without local objects', async () => {
    const memory = memoryKnowledgeStore()
    const saveExport = vi.fn()
    const readObject = vi.spyOn(memory.objects, 'read')
    const baseChange = (
      sequence: number,
      generationId: string,
      name = 'Remote contracts',
    ) => ({
      sequence, entityKind: 'knowledge_base' as const, entityId: 'remote_base',
      operation: 'upsert' as const, revision: `base_r${sequence}`,
      payload: { name, publishedGenerationId: generationId },
    })
    const documentChange = (
      sequence: number,
      documentId: string,
      versionId: string,
      generationId: string,
      versionNumber: number,
    ) => ({
      sequence, entityKind: 'document' as const, entityId: documentId,
      operation: 'upsert' as const, revision: `document_r${sequence}`,
      payload: {
        name: `${documentId}.txt`, mimeType: 'text/plain', versionId, versionNumber,
        contentHash: versionNumber.toString(16).repeat(64),
        generationId, createdAt: sequence * 1_000,
      },
    })
    const fullResync = vi.fn()
      .mockResolvedValueOnce({
        kind: 'snapshot' as const, nextSequence: 2,
        changes: [
          documentChange(1, 'remote_document_1', 'remote_version_1', 'remote_generation_1', 1),
          baseChange(2, 'remote_generation_1'),
        ],
      })
      .mockResolvedValueOnce({
        kind: 'snapshot' as const, nextSequence: 5,
        changes: [
          documentChange(4, 'remote_document_2', 'remote_version_2', 'remote_generation_2', 2),
          baseChange(5, 'remote_generation_2', 'Remote contracts renamed'),
        ],
      })
    const pullChanges = vi.fn()
      .mockResolvedValueOnce({ kind: 'cursor_stale' as const })
      .mockResolvedValueOnce({
        kind: 'incremental' as const, nextSequence: 7, hasMore: false,
        changes: [
          baseChange(6, 'remote_generation_3', 'Remote contracts renamed'),
          documentChange(7, 'remote_document_2', 'remote_version_3', 'remote_generation_3', 3),
        ],
      })
      .mockResolvedValueOnce({
        kind: 'incremental' as const, nextSequence: 8, hasMore: false,
        changes: [{
          sequence: 8, entityKind: 'document' as const, entityId: 'remote_document_2',
          operation: 'delete' as const, revision: 'document_r8', payload: {},
        }],
      })
    const search = vi.fn(async () => ({
      generationState: 'published',
      generations: [{
        knowledgeBaseId: 'remote_base', generationId: 'remote_generation_1',
        previousGenerationId: null,
      }],
      strategy: 'keyword_only_consent' as const,
      embedding: {
        model: 'kinfra-text-embedding-0.6b' as const, dimensions: 1024 as const,
        configurationVersion: 'autoforge-knowledge-embedding-v1' as const,
        region: 'guangzhou' as const,
      },
      keywordCandidates: [{
        id: 'remote_chunk_1', knowledgeBaseId: 'remote_base',
        documentId: 'remote_document_1', versionId: 'remote_version_1',
        generationId: 'remote_generation_1', rank: 1, body: '远程合同条款',
        coordinates: { kind: 'txt', lineStart: 1, lineEnd: 1, charStart: 0, charEnd: 6 },
      }],
      vectorCandidates: [], driftProbeRequired: false,
    }))
    const service = createLocalKnowledgeService({
      openStore: async () => memory.store,
      selectImportFiles: async () => [],
      createParser: () => ({
        parse: async () => parsedText('unused'), terminateAll: async () => undefined,
      }),
      saveExport,
      isMember: () => true,
      entitlement: () => ({
        tier: 'member', status: 'active', localEnabled: true,
        betaEnabled: true, cloudEnabled: true,
      }),
      cloudKillSwitchEnabled: () => false,
    })
    service.configureCloudRemote!(cloudRemote({
      fullResync, pullChanges, search,
      listKnowledgeBases: vi.fn().mockRejectedValue(
        Object.assign(new Error('temporarily unavailable'), { code: 'SERVICE_UNAVAILABLE' }),
      ),
    }))
    const owner = { userId: 'alice' }
    await service.bind(owner.userId, true)
    memory.database.prepare(`
      INSERT INTO knowledge_entitlement_projection(
        singleton, tier, status, beta_enabled, cloud_enabled, epoch, updated_at,
        accepted_key_generation, verified, explicit_free, max_observed_at
      ) VALUES (1, 'member', 'active', 1, 1, 1, 1, 1, 1, 0, 1)
    `).run()

    const firstScope = await service.captureSearchScope(owner, ['remote_base'])
    await expect(service.list(owner)).resolves.toContainEqual(expect.objectContaining({
      id: 'remote_base', name: 'Remote contracts', kind: 'cloud', status: 'read_only',
      searchable: true, documentCount: 1, readOnly: true,
    }))
    await expect(service.listDocuments(owner, 'remote_base')).resolves.toEqual([
      expect.objectContaining({
        id: 'remote_document_1', baseId: 'remote_base', status: 'ready', readOnly: true,
      }),
    ])
    await expect(service.listVersions(owner, 'remote_document_1')).resolves.toEqual([
      expect.objectContaining({ id: 'remote_version_1', number: 1, status: 'ready' }),
    ])
    expect(firstScope.entries).toEqual([expect.objectContaining({
      baseId: 'remote_base', documentId: 'remote_document_1', versionId: 'remote_version_1',
      cloudGenerationId: 'remote_generation_1',
    })])
    await expect(service.searchSelected(
      owner, '远程合同', ['remote_base'], undefined, firstScope,
    )).resolves.toMatchObject({
      kind: 'results', evidence: [expect.objectContaining({ id: 'evidence:cloud:remote_chunk_1' })],
    })
    await expect(service.sourceAvailable(
      owner, 'remote_document_1', 'remote_version_1', undefined,
    )).resolves.toBe(false)
    await expect(service.sourceVerifiable!(
      owner, 'remote_base', 'remote_document_1', 'remote_version_1', undefined, firstScope,
    )).resolves.toBe(true)
    await expect(service.exportBase(owner, 'remote_base')).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    })
    expect(readObject).not.toHaveBeenCalled()
    expect(saveExport).not.toHaveBeenCalled()

    const staleScope = await service.captureSearchScope(owner, ['remote_base'])
    expect(staleScope.entries).toEqual([expect.objectContaining({
      documentId: 'remote_document_2', versionId: 'remote_version_2',
      cloudGenerationId: 'remote_generation_2',
    })])
    await expect(service.sourceVerifiable!(
      owner, 'remote_base', 'remote_document_1', 'remote_version_1', undefined, firstScope,
    )).resolves.toBe(false)
    service.releaseSearchScope(firstScope)
    await expect(service.listDocuments(owner, 'remote_base')).resolves.toEqual([
      expect.objectContaining({ id: 'remote_document_2' }),
    ])
    service.releaseSearchScope(staleScope)

    const incrementalScope = await service.captureSearchScope(owner, ['remote_base'])
    expect(incrementalScope.entries).toEqual([expect.objectContaining({
      documentId: 'remote_document_2', versionId: 'remote_version_3',
      cloudGenerationId: 'remote_generation_3',
    })])
    service.releaseSearchScope(incrementalScope)

    const tombstoneScope = await service.captureSearchScope(owner, ['remote_base'])
    expect(tombstoneScope.entries).toEqual([])
    await expect(service.listDocuments(owner, 'remote_base')).resolves.toEqual([])
    expect(memory.database.prepare(`
      SELECT sequence FROM cloud_remote_sync_cursors WHERE knowledge_base_id = 'remote_base'
    `).get()).toEqual({ sequence: 8 })
    expect(memory.database.prepare(`
      SELECT local_object_available AS localObjectAvailable
      FROM cloud_version_projections WHERE id = 'remote_version_3'
    `).get()).toBeUndefined()
  })

  it('durably resumes a queued cloud generation after the third poll without duplicate upload', async () => {
    const memory = memoryKnowledgeStore()
    let observedAt = 1_000
    let publicationSequence = 7
    const selected = [{
      name: 'recover.txt', mimeType: 'text/plain' as const, bytes: Buffer.from('恢复发布条款'),
    }]
    const beginGeneration = vi.fn(async (input: {
      knowledgeBaseId: string; generationId: string
    }) => ({ ...input, status: 'staging' as const }))
    const pushMutation = vi.fn(async input => ({
      mutationId: input.mutationId, status: 'applied' as const,
      sequence: 1, revision: input.mutationId,
    }))
    const uploadDocument = vi.fn().mockResolvedValue({
      jobId: 'upload_job_late', storageReference: 'knowledge/1/base/object_late',
    })
    const getJob = vi.fn()
      .mockResolvedValueOnce({ jobId: 'upload_job_late', state: 'running' as const, errorCode: null })
      .mockResolvedValueOnce({ jobId: 'upload_job_late', state: 'running' as const, errorCode: null })
      .mockResolvedValueOnce({ jobId: 'upload_job_late', state: 'running' as const, errorCode: null })
      .mockResolvedValueOnce({ jobId: 'upload_job_late', state: 'completed' as const, errorCode: null })
    const publishGeneration = vi.fn(async input => ({
      generationId: input.generationId, previousGenerationId: null,
      sequence: publicationSequence++,
    }))
    const remote = {
      ...cloudRemote({ pushMutation, getJob, publishGeneration }),
      beginGeneration,
      uploadDocument,
      search: vi.fn(),
    }
    const service = createLocalKnowledgeService({
      openStore: async () => memory.store,
      selectImportFiles: async () => selected.splice(0),
      createParser: () => ({
        parse: async () => parsedText('恢复发布条款'), terminateAll: async () => undefined,
      }),
      saveExport: async () => undefined,
      isMember: () => true,
      entitlement: () => ({
        tier: 'member', status: 'active', localEnabled: true,
        betaEnabled: true, cloudEnabled: true,
      }),
      cloudKillSwitchEnabled: () => false,
      now: () => observedAt,
    })
    service.configureCloudRemote!(remote)
    const owner = { userId: 'alice' }
    await service.bind(owner.userId, true)
    memory.database.prepare(`
      INSERT INTO knowledge_entitlement_projection(
        singleton, tier, status, beta_enabled, cloud_enabled, epoch, updated_at,
        accepted_key_generation, verified, explicit_free, max_observed_at
      ) VALUES (1, 'member', 'active', 1, 1, 1, 1, 1, 1, 0, 1)
    `).run()
    const base = await service.create(owner, 'Recovery')
    const handle = (await service.pickImportFiles(owner))[0]!
    await service.importDocument(owner, base.id, handle.id)

    await vi.waitFor(() => expect(getJob).toHaveBeenCalledTimes(3))
    await vi.waitFor(() => expect(memory.database.prepare(`
      SELECT recovery_attempt AS recoveryAttempt, next_retry_at AS nextRetryAt,
        last_error_code AS lastErrorCode
      FROM cloud_pending_publications WHERE knowledge_base_id = ?
    `).get(base.id)).toEqual({
      recoveryAttempt: 1, nextRetryAt: 2_000, lastErrorCode: 'GENERATION_NOT_READY',
    }))

    await service.list(owner)
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(getJob).toHaveBeenCalledTimes(3)
    observedAt = 2_000
    await service.list(owner)
    await vi.waitFor(() => expect(pushMutation).toHaveBeenCalledTimes(2))

    expect(beginGeneration).toHaveBeenCalledOnce()
    expect(publishGeneration).toHaveBeenCalledOnce()
    expect(pushMutation).toHaveBeenCalledTimes(2)
    expect(uploadDocument).toHaveBeenCalledOnce()
    expect(getJob).toHaveBeenCalledTimes(4)
    expect(memory.database.prepare(
      'SELECT 1 FROM cloud_pending_publications WHERE knowledge_base_id = ?',
    ).get(base.id)).toBeUndefined()
  })

  it('recovers a due queued generation from persisted state on the first search after restart', async () => {
    const memory = memoryKnowledgeStore()
    let restartNow = 2
    memory.database.exec(`
      INSERT INTO knowledge_bases(
        id, name, created_at, updated_at, lifecycle_status, recycled_at
      ) VALUES ('base_restart', 'Restart', 1, 1, 'ready', NULL);
      INSERT INTO documents(
        id, knowledge_base_id, name, mime_type, active_version_id, created_at, updated_at,
        lifecycle_status, publication_generation, recycled_at
      ) VALUES (
        'document_restart', 'base_restart', 'restart.txt', 'text/plain', NULL,
        1, 1, 'ready', 1, NULL
      );
      INSERT INTO document_versions(
        id, document_id, version_number, status, content_hash, object_id, created_at,
        publication_generation, name, mime_type
      ) VALUES (
        'version_restart', 'document_restart', 1, 'ready',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'object_restart', 1, 1, 'restart.txt', 'text/plain'
      );
      UPDATE documents SET active_version_id = 'version_restart' WHERE id = 'document_restart';
      INSERT INTO cloud_sync_states(
        knowledge_base_id, mode, published_generation_id, epoch, updated_at
      ) VALUES ('base_restart', 'paused', NULL, 1, 1);
      INSERT INTO cloud_pending_publications(
        knowledge_base_id, generation_id, document_id, version_id, object_id,
        upload_job_id, publish_request_id, updated_at, recovery_attempt,
        next_retry_at, last_error_code
      ) VALUES (
        'base_restart', 'generation_restart', 'document_restart', 'version_restart',
        'object_restart', 'upload_job_restart', 'publish_restart', 1, 1, 1,
        'GENERATION_NOT_READY'
      );
      INSERT INTO knowledge_entitlement_projection(
        singleton, tier, status, beta_enabled, cloud_enabled, epoch, updated_at,
        accepted_key_generation, verified, explicit_free, max_observed_at
      ) VALUES (1, 'member', 'active', 1, 1, 1, 1, 1, 1, 0, 1);
    `)
    const publishGeneration = vi.fn(async input => ({
      generationId: input.generationId, previousGenerationId: null, sequence: 9,
    }))
    const remote = cloudRemote({
      getJob: vi.fn(async input => ({
        jobId: input.jobId, state: 'completed' as const, errorCode: null,
      })),
      publishGeneration,
    })
    const restarted = createLocalKnowledgeService({
      openStore: async () => memory.store,
      selectImportFiles: async () => [],
      createParser: () => ({
        parse: async () => parsedText('unused'), terminateAll: async () => undefined,
      }),
      saveExport: async () => undefined,
      isMember: () => true,
      entitlement: () => ({
        tier: 'member', status: 'active', localEnabled: true,
        betaEnabled: true, cloudEnabled: true,
      }),
      cloudKillSwitchEnabled: () => false,
      now: () => restartNow,
    })
    restarted.configureCloudRemote!(remote)
    await restarted.bind('alice', true)

    await restarted.searchSelected({ userId: 'alice' }, '恢复发布', ['base_restart'])
    await vi.waitFor(() => expect(publishGeneration).toHaveBeenCalledOnce())

    expect(memory.database.prepare(`
      SELECT mode, published_generation_id AS publishedGenerationId
      FROM cloud_sync_states WHERE knowledge_base_id = 'base_restart'
    `).get()).toEqual({ mode: 'synced', publishedGenerationId: 'generation_restart' })
    await vi.waitFor(() => expect(memory.database.prepare(
      "SELECT 1 FROM cloud_pending_publications WHERE knowledge_base_id = 'base_restart'",
    ).get()).toBeUndefined())

    memory.database.prepare(`
      INSERT INTO cloud_pending_publications(
        knowledge_base_id, generation_id, document_id, version_id, object_id,
        upload_job_id, publish_request_id, updated_at, recovery_attempt,
        next_retry_at, last_error_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'base_restart', 'generation_restart', 'document_restart', 'version_restart',
      'object_restart', 'upload_job_restart', 'publish_restart', 2, 1, 2,
      'GENERATION_NOT_READY',
    )
    vi.mocked(remote.getJob).mockClear()
    publishGeneration.mockClear()
    await restarted.list({ userId: 'alice' })
    await vi.waitFor(() => expect(memory.database.prepare(
      "SELECT 1 FROM cloud_pending_publications WHERE knowledge_base_id = 'base_restart'",
    ).get()).toBeUndefined())
    expect(remote.getJob).not.toHaveBeenCalled()
    expect(publishGeneration).not.toHaveBeenCalled()

    memory.database.prepare(`
      UPDATE cloud_sync_states SET mode = 'syncing', published_generation_id = NULL
      WHERE knowledge_base_id = 'base_restart'
    `).run()
    memory.database.prepare(`
      INSERT INTO cloud_pending_publications(
        knowledge_base_id, generation_id, document_id, version_id, object_id,
        upload_job_id, publish_request_id, updated_at, recovery_attempt,
        next_retry_at, last_error_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'base_restart', 'generation_restart_2', 'document_restart', 'version_restart',
      'object_restart', 'upload_job_restart_2', 'publish_restart_2', 2, 1, 2,
      'GENERATION_NOT_READY',
    )
    const transient = Object.assign(new Error('lost job response'), {
      code: 'TRANSIENT_FAILURE', retryable: true,
    })
    vi.mocked(remote.getJob).mockReset()
      .mockRejectedValueOnce(transient)
      .mockResolvedValue({
        jobId: 'upload_job_restart_2', state: 'completed', errorCode: null,
      })
    await restarted.list({ userId: 'alice' })
    await vi.waitFor(() => expect(memory.database.prepare(`
      SELECT recovery_attempt AS recoveryAttempt, next_retry_at AS nextRetryAt,
        last_error_code AS lastErrorCode
      FROM cloud_pending_publications WHERE knowledge_base_id = 'base_restart'
    `).get()).toEqual({
      recoveryAttempt: 2, nextRetryAt: 2_002, lastErrorCode: 'TRANSIENT_FAILURE',
    }))
    await restarted.list({ userId: 'alice' })
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(remote.getJob).toHaveBeenCalledTimes(1)
    restartNow = 2_002
    await restarted.list({ userId: 'alice' })
    await vi.waitFor(() => expect(publishGeneration).toHaveBeenCalledOnce())
  })

  it('keeps import and search local when the cloud kill switch is closed', async () => {
    const memory = memoryKnowledgeStore()
    const beginGeneration = vi.fn()
    const uploadDocument = vi.fn()
    const search = vi.fn()
    const remote = { ...cloudRemote(), beginGeneration, uploadDocument, search }
    const service = createLocalKnowledgeService({
      openStore: async () => memory.store,
      selectImportFiles: async () => [{
        name: 'local.txt', mimeType: 'text/plain', bytes: Buffer.from('本地合同条款'),
      }],
      createParser: () => ({
        parse: async () => parsedText('本地合同条款'), terminateAll: async () => undefined,
      }),
      saveExport: async () => undefined,
      isMember: () => true,
      entitlement: () => ({
        tier: 'member', status: 'active', localEnabled: true,
        betaEnabled: true, cloudEnabled: true,
      }),
      cloudKillSwitchEnabled: () => true,
    })
    service.configureCloudRemote!(remote)
    const owner = { userId: 'alice' }
    await service.bind(owner.userId)
    const base = await service.create(owner, 'Local')
    const handle = (await service.pickImportFiles(owner))[0]!
    await service.importDocument(owner, base.id, handle.id)
    await vi.waitFor(async () => expect(await service.searchSelected(
      owner, '本地合同', [base.id],
    )).toMatchObject({ kind: 'results', evidence: [expect.any(Object)] }))

    expect(beginGeneration).not.toHaveBeenCalled()
    expect(uploadDocument).not.toHaveBeenCalled()
    expect(search).not.toHaveBeenCalled()
  })

  it('requires current cloud_sync consent and fences old scopes across revoke and regrant', async () => {
    const memory = memoryKnowledgeStore()
    const selected = [{
      name: 'consent.txt', mimeType: 'text/plain' as const, bytes: Buffer.from('同意边界条款'),
    }]
    const beginGeneration = vi.fn()
    const uploadDocument = vi.fn()
    const heldSearch = deferred<Awaited<ReturnType<NonNullable<CloudKnowledgeRemote['search']>>>>()
    let searchCalls = 0
    let documentId = ''
    let versionId = ''
    const cloudResponse = () => ({
      generationState: 'published',
      generations: [{
        knowledgeBaseId: 'consent_base', generationId: 'consent_generation',
        previousGenerationId: null,
      }],
      strategy: 'keyword_only_consent' as const,
      embedding: {
        model: 'kinfra-text-embedding-0.6b' as const, dimensions: 1024 as const,
        configurationVersion: 'autoforge-knowledge-embedding-v1' as const,
        region: 'guangzhou' as const,
      },
      keywordCandidates: [{
        id: 'consent_cloud_chunk', knowledgeBaseId: 'consent_base',
        documentId, versionId, generationId: 'consent_generation', rank: 1,
        body: '同意边界条款',
        coordinates: { kind: 'txt', lineStart: 1, lineEnd: 1, charStart: 0, charEnd: 6 },
      }],
      vectorCandidates: [], driftProbeRequired: false,
    })
    const search = vi.fn(async () => {
      searchCalls += 1
      return searchCalls === 1 ? heldSearch.promise : cloudResponse()
    })
    const service = createLocalKnowledgeService({
      openStore: async () => memory.store,
      selectImportFiles: async () => selected.splice(0),
      createParser: () => ({
        parse: async () => parsedText('同意边界条款'), terminateAll: async () => undefined,
      }),
      saveExport: async () => undefined,
      isMember: () => true,
      entitlement: () => ({
        tier: 'member', status: 'active', localEnabled: true,
        betaEnabled: true, cloudEnabled: true,
      }),
      cloudKillSwitchEnabled: () => false,
    })
    service.configureCloudRemote!({
      ...cloudRemote({ search }), beginGeneration, uploadDocument,
    })
    const owner = { userId: 'alice' }
    await service.bind(owner.userId, false)
    memory.database.prepare(`
      INSERT INTO knowledge_entitlement_projection(
        singleton, tier, status, beta_enabled, cloud_enabled, epoch, updated_at,
        accepted_key_generation, verified, explicit_free, max_observed_at
      ) VALUES (1, 'member', 'active', 1, 1, 1, 1, 1, 1, 0, 1)
    `).run()
    const base = await service.create(owner, 'Consent')
    expect(base.id).not.toBe('consent_base')
    memory.database.prepare(
      'UPDATE knowledge_bases SET id = ? WHERE id = ?',
    ).run('consent_base', base.id)
    const handle = (await service.pickImportFiles(owner))[0]!
    const document = (await service.importDocument(owner, 'consent_base', handle.id))!
    documentId = document.id
    await vi.waitFor(async () => expect(await service.listDocuments(
      owner, 'consent_base',
    )).toEqual([expect.objectContaining({ status: 'ready' })]))
    versionId = (memory.database.prepare(`
      SELECT active_version_id AS versionId FROM documents WHERE id = ?
    `).get(documentId) as { versionId: string }).versionId

    await expect(service.getAvailability(owner)).resolves.toMatchObject({
      cloud: { available: false, reason: 'cloud_disabled' },
    })
    expect(beginGeneration).not.toHaveBeenCalled()
    expect(uploadDocument).not.toHaveBeenCalled()
    expect(search).not.toHaveBeenCalled()
    memory.database.prepare(`
      INSERT INTO cloud_sync_states(
        knowledge_base_id, mode, published_generation_id, epoch, updated_at
      ) VALUES ('consent_base', 'synced', 'consent_generation', 1, 1)
      ON CONFLICT(knowledge_base_id) DO UPDATE SET
        mode = 'synced', published_generation_id = 'consent_generation', epoch = epoch + 1
    `).run()

    service.setCloudSyncConsent!(owner.userId, true)
    await expect(service.getAvailability(owner)).resolves.toMatchObject({
      cloud: { available: true },
    })
    const oldScope = await service.captureSearchScope(owner, ['consent_base'])
    const oldSearch = service.searchSelected(
      owner, '同意边界', ['consent_base'], undefined, oldScope,
    )
    await vi.waitFor(() => expect(search).toHaveBeenCalledOnce())
    service.setCloudSyncConsent!(owner.userId, false)
    expect(memory.database.prepare(`
      SELECT mode FROM cloud_sync_states WHERE knowledge_base_id = 'consent_base'
    `).get()).toEqual({ mode: 'paused' })
    service.setCloudSyncConsent!(owner.userId, true)
    heldSearch.resolve(cloudResponse())

    const oldResult = await oldSearch
    expect(oldResult).toMatchObject({ kind: 'results' })
    expect(oldResult.kind === 'results'
      ? oldResult.evidence.some(item => item.id === 'evidence:cloud:consent_cloud_chunk')
      : true).toBe(false)
    const newScope = await service.captureSearchScope(owner, ['consent_base'])
    await expect(service.searchSelected(
      owner, '同意边界', ['consent_base'], undefined, newScope,
    )).resolves.toMatchObject({
      kind: 'results',
      evidence: [expect.objectContaining({ id: 'evidence:cloud:consent_cloud_chunk' })],
    })
    expect(beginGeneration).not.toHaveBeenCalled()
    expect(uploadDocument).not.toHaveBeenCalled()
  })

  it('does not let a publication task from an earlier consent epoch continue after regrant', async () => {
    const memory = memoryKnowledgeStore()
    const firstUpload = deferred<{ jobId: string; storageReference: string }>()
    const secondUpload = deferred<{ jobId: string; storageReference: string }>()
    const firstPublish = deferred<{
      generationId: string; previousGenerationId: string | null; sequence: number
    }>()
    const secondPublish = deferred<{
      generationId: string; previousGenerationId: string | null; sequence: number
    }>()
    const uploadDocument = vi.fn()
      .mockImplementationOnce(async () => firstUpload.promise)
      .mockImplementationOnce(async () => secondUpload.promise)
    const pushMutation = vi.fn(async (input: Parameters<CloudKnowledgeRemote['pushMutation']>[0]) => ({
      mutationId: input.mutationId, status: 'applied' as const,
      sequence: 1, revision: input.mutationId,
    }))
    const getJob = vi.fn(async (input: { jobId: string }) => ({
      jobId: input.jobId, state: 'completed' as const, errorCode: null,
    }))
    const publishGeneration = vi.fn()
      .mockImplementationOnce(async () => firstPublish.promise)
      .mockImplementationOnce(async () => secondPublish.promise)
    const selected = [{
      name: 'epoch.txt', mimeType: 'text/plain' as const, bytes: Buffer.from('授权 epoch 条款'),
    }]
    const service = createLocalKnowledgeService({
      openStore: async () => memory.store,
      selectImportFiles: async () => selected.splice(0),
      createParser: () => ({
        parse: async () => parsedText('授权 epoch 条款'), terminateAll: async () => undefined,
      }),
      saveExport: async () => undefined,
      isMember: () => true,
      entitlement: () => ({
        tier: 'member', status: 'active', localEnabled: true,
        betaEnabled: true, cloudEnabled: true,
      }),
      cloudKillSwitchEnabled: () => false,
    })
    service.configureCloudRemote!(cloudRemote({
      uploadDocument, getJob, publishGeneration, pushMutation,
    }))
    const owner = { userId: 'alice' }
    await service.bind(owner.userId, true)
    memory.database.prepare(`
      INSERT INTO knowledge_entitlement_projection(
        singleton, tier, status, beta_enabled, cloud_enabled, epoch, updated_at,
        accepted_key_generation, verified, explicit_free, max_observed_at
      ) VALUES (1, 'member', 'active', 1, 1, 1, 1, 1, 1, 0, 1)
    `).run()
    const base = await service.create(owner, 'Epoch')
    const handle = (await service.pickImportFiles(owner))[0]!
    await service.importDocument(owner, base.id, handle.id)
    await vi.waitFor(() => expect(uploadDocument).toHaveBeenCalledOnce())

    service.setCloudSyncConsent!(owner.userId, false)
    service.setCloudSyncConsent!(owner.userId, true)
    firstUpload.resolve({ jobId: 'upload_old_epoch', storageReference: 'knowledge/old' })

    await vi.waitFor(() => expect(uploadDocument).toHaveBeenCalledTimes(2))
    expect(getJob).not.toHaveBeenCalled()
    expect(publishGeneration).not.toHaveBeenCalled()
    secondUpload.resolve({ jobId: 'upload_new_epoch', storageReference: 'knowledge/new' })
    await vi.waitFor(() => expect(publishGeneration).toHaveBeenCalledOnce())

    service.setCloudSyncConsent!(owner.userId, false)
    service.setCloudSyncConsent!(owner.userId, true)
    const generationId = publishGeneration.mock.calls[0]![0].generationId
    firstPublish.resolve({ generationId, previousGenerationId: null, sequence: 7 })

    await vi.waitFor(() => expect(publishGeneration).toHaveBeenCalledTimes(2))
    expect(pushMutation).toHaveBeenCalledTimes(1)
    secondPublish.resolve({ generationId, previousGenerationId: null, sequence: 8 })
    await vi.waitFor(() => expect(pushMutation).toHaveBeenCalledTimes(2))
  })

  it('rejects entitlement key-generation rollback and same-generation key replacement across restart', async () => {
    const memory = memoryKnowledgeStore()
    const oldKey = generateKeyPairSync('ed25519')
    const currentKey = generateKeyPairSync('ed25519')
    const replacementKey = generateKeyPairSync('ed25519')
    const observedAt = Date.parse('2026-08-28T12:00:00.000Z')
    const rotationVerifier = new KnowledgeEntitlementVerifier({
      publicKeys: {
        old: {
          publicKey: oldKey.publicKey,
          generation: 1,
          status: 'retired',
          retiredAt: '2026-08-28T12:00:00.000Z',
        },
        current: { publicKey: currentKey.publicKey, generation: 2, status: 'active' },
      },
      now: () => observedAt,
    })
    const replacementVerifier = new KnowledgeEntitlementVerifier({
      publicKeys: {
        replacement: { publicKey: replacementKey.publicKey, generation: 2, status: 'active' },
      },
      now: () => observedAt,
    })
    let verifier = rotationVerifier
    const signed = (
      keyId: 'old' | 'current' | 'replacement',
      issuedAt: string,
      privateKey: typeof oldKey.privateKey,
    ) => {
      const canonical = canonicalizeEntitlementPayload({
        userId: 'alice',
        entitlements: ['knowledge_base_beta', 'knowledge_base_cloud'],
        issuedAt,
        expiresAt: '2026-08-30T00:00:00.000Z',
        keyId,
      })
      return {
        payload: Buffer.from(canonical).toString('base64url'),
        signature: sign(null, Buffer.from(canonical), privateKey).toString('base64url'),
      }
    }
    const createService = () => createLocalKnowledgeService({
      openStore: async () => memory.store,
      selectImportFiles: async () => [],
      createParser: () => ({ parse: async () => parsedText('unused'), terminateAll: async () => undefined }),
      saveExport: async () => undefined,
      isMember: () => false,
      now: () => observedAt,
      verifyEntitlement: (ownerId, snapshot, effectiveNow) => (
        verifier.verify(ownerId, snapshot, effectiveNow)
      ),
    })

    const first = createService()
    await first.bind('alice')
    await first.refreshEntitlement!('alice', signed(
      'old', '2026-08-28T00:00:00.000Z', oldKey.privateKey,
    ), true)
    await first.refreshEntitlement!('alice', signed(
      'current', '2026-08-28T06:00:00.000Z', currentKey.privateKey,
    ), true)
    await expect(first.refreshEntitlement!('alice', signed(
      'old', '2026-08-28T12:00:00.000Z', oldKey.privateKey,
    ), true)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    first.invalidate()
    await first.drain()

    const restarted = createService()
    await restarted.bind('alice')
    await expect(restarted.refreshEntitlement!('alice', signed(
      'old', '2026-08-28T12:00:00.000Z', oldKey.privateKey,
    ), true)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    verifier = replacementVerifier
    await expect(restarted.refreshEntitlement!('alice', signed(
      'replacement', '2026-08-28T11:00:00.000Z', replacementKey.privateKey,
    ), true)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('starts explicit-free cloud retention at the confirmed refresh boundary without extending it', async () => {
    const memory = memoryKnowledgeStore()
    const keys = generateKeyPairSync('ed25519')
    let observedAt = Date.parse('2026-08-28T00:00:00.000Z')
    const verifier = new KnowledgeEntitlementVerifier({
      publicKeys: {
        primary: { publicKey: keys.publicKey, generation: 1, status: 'active' },
      },
      now: () => observedAt,
    })
    const canonical = canonicalizeEntitlementPayload({
      userId: 'alice',
      entitlements: ['knowledge_base_beta', 'knowledge_base_cloud'],
      issuedAt: '2026-08-27T00:00:00.000Z',
      expiresAt: '2026-09-10T00:00:00.000Z',
      keyId: 'primary',
    })
    const member = {
      payload: Buffer.from(canonical).toString('base64url'),
      signature: sign(null, Buffer.from(canonical), keys.privateKey).toString('base64url'),
    }
    const createService = () => createLocalKnowledgeService({
      openStore: async () => memory.store,
      selectImportFiles: async () => [],
      createParser: () => ({ parse: async () => parsedText('unused'), terminateAll: async () => undefined }),
      saveExport: async () => undefined,
      isMember: () => false,
      now: () => observedAt,
      verifyEntitlement: (ownerId, snapshot, effectiveNow) => (
        verifier.verify(ownerId, snapshot, effectiveNow)
      ),
    })
    const owner = { userId: 'alice' }
    const first = createService()
    await first.bind(owner.userId)
    await first.refreshEntitlement!(owner.userId, member, true)
    const base = await first.create(owner, '曾同步资料')
    memory.database.prepare(`
      INSERT INTO cloud_sync_states(knowledge_base_id, mode, published_generation_id, epoch, updated_at)
      VALUES (?, 'synced', 'generation_1', 1, ?)
    `).run(base.id, observedAt)

    const confirmedFreeAt = Date.parse('2026-09-01T08:30:00.000Z')
    observedAt = confirmedFreeAt
    await first.refreshEntitlement!(owner.userId, undefined, true)
    const firstRetention = memory.database.prepare(`
      SELECT download_until AS downloadUntil, recycle_until AS recycleUntil,
        operation_id AS operationId, request_id AS requestId
      FROM knowledge_cloud_retention WHERE knowledge_base_id = ?
    `).get(base.id)
    expect(firstRetention).toEqual({
      downloadUntil: confirmedFreeAt + (30 * 24 * 60 * 60 * 1_000),
      recycleUntil: confirmedFreeAt + (60 * 24 * 60 * 60 * 1_000),
      operationId: expect.any(String), requestId: expect.any(String),
    })

    observedAt += 24 * 60 * 60 * 1_000
    await first.refreshEntitlement!(owner.userId, undefined, true)
    expect(memory.database.prepare(`
      SELECT download_until AS downloadUntil, recycle_until AS recycleUntil,
        operation_id AS operationId, request_id AS requestId
      FROM knowledge_cloud_retention WHERE knowledge_base_id = ?
    `).get(base.id)).toEqual(firstRetention)
    first.invalidate()
    await first.drain()

    const restarted = createService()
    await restarted.bind(owner.userId)
    await expect(restarted.getEntitlement(owner)).resolves.toMatchObject({
      tier: 'free', status: 'active', cloudEnabled: false,
    })
    expect(memory.database.prepare(`
      SELECT download_until AS downloadUntil, recycle_until AS recycleUntil,
        operation_id AS operationId, request_id AS requestId
      FROM knowledge_cloud_retention WHERE knowledge_base_id = ?
    `).get(base.id)).toEqual(firstRetention)
  })

  it('keeps a synced recycled base and journal until remote deletion is durably confirmed', async () => {
    const memory = memoryKnowledgeStore()
    const selected = [{
      name: 'cloud.txt', mimeType: 'text/plain' as const, bytes: Buffer.from('cloud body'),
    }]
    const deleteKnowledgeBase = vi.fn()
      .mockRejectedValueOnce(new Error('lost response'))
      .mockResolvedValueOnce({ deletionJobId: 'delete_service_1' })
    const remote = cloudRemote({
      deleteKnowledgeBase,
      getJob: vi.fn().mockResolvedValue({
        jobId: 'delete_service_1', state: 'completed', errorCode: null,
      }),
    })
    const service = createLocalKnowledgeService({
      openStore: async () => memory.store,
      selectImportFiles: async () => selected.splice(0),
      createParser: () => ({ parse: async () => parsedText('cloud body'), terminateAll: async () => undefined }),
      saveExport: async () => undefined,
      isMember: () => false,
      verifyEntitlement: () => { throw new Error('signed path unused') },
    })
    service.configureCloudRemote!(remote)
    const owner = { userId: 'alice' }
    await service.bind(owner.userId)
    const base = await service.create(owner, '曾同步资料')
    const handle = (await service.pickImportFiles(owner))[0]!
    await service.importDocument(owner, base.id, handle.id)
    await vi.waitFor(() => expect(memory.objects.values.size).toBe(1))
    memory.database.prepare(`
      INSERT INTO cloud_sync_states(knowledge_base_id, mode, published_generation_id, epoch, updated_at)
      VALUES (?, 'synced', 'generation_1', 1, 1)
    `).run(base.id)
    await service.refreshEntitlement!(owner.userId, undefined, true)
    await service.recycleBase(owner, base.id)

    await expect(service.purgeBase(owner, base.id)).rejects.toThrow('lost response')
    await expect(service.list(owner)).resolves.toEqual([
      expect.objectContaining({ id: base.id, status: 'recycled' }),
    ])
    const journal = memory.database.prepare(`
      SELECT operation_id AS operationId, request_id AS requestId
      FROM knowledge_cloud_retention WHERE knowledge_base_id = ?
    `).get(base.id) as { operationId: string; requestId: string }
    expect(memory.objects.values.size).toBe(1)

    await expect(service.purgeBase(owner, base.id)).resolves.toBeUndefined()
    await expect(service.list(owner)).resolves.toEqual([])
    expect(memory.objects.values.size).toBe(0)
    expect(deleteKnowledgeBase.mock.calls.map(([input]) => input.requestId))
      .toEqual([journal.requestId, journal.requestId])
    expect(memory.database.prepare(
      'SELECT 1 FROM knowledge_cloud_retention WHERE knowledge_base_id = ?',
    ).get(base.id)).toBeUndefined()
    expect(memory.database.prepare(
      'SELECT 1 FROM cloud_sync_states WHERE knowledge_base_id = ?',
    ).get(base.id)).toBeUndefined()
    expect(memory.database.prepare(`
      SELECT operation_id AS operationId, request_id AS requestId,
        deletion_job_id AS deletionJobId
      FROM knowledge_cloud_deletion_receipts WHERE knowledge_base_id = ?
    `).get(base.id)).toEqual({
      operationId: journal.operationId,
      requestId: journal.requestId,
      deletionJobId: 'delete_service_1',
    })
  })

  it('fences a held cloud purge synchronously through public owner invalidation and drains it', async () => {
    const memory = memoryKnowledgeStore()
    const deleteResult = deferred<{ deletionJobId: string }>()
    const deleteKnowledgeBase = vi.fn(() => deleteResult.promise)
    const service = createLocalKnowledgeService({
      openStore: async () => memory.store,
      selectImportFiles: async () => [],
      createParser: () => ({
        parse: async () => parsedText('unused'), terminateAll: async () => undefined,
      }),
      saveExport: async () => undefined,
      isMember: () => false,
    })
    service.configureCloudRemote!(cloudRemote({ deleteKnowledgeBase }))
    const owner = { userId: 'alice' }
    await service.bind(owner.userId)
    const base = await service.create(owner, '待删除云端库')
    memory.database.prepare(`
      INSERT INTO cloud_sync_states(
        knowledge_base_id, mode, published_generation_id, epoch, updated_at
      ) VALUES (?, 'synced', 'generation_held', 1, 1)
    `).run(base.id)
    memory.database.prepare(`
      INSERT INTO knowledge_cloud_retention(
        knowledge_base_id, stage, download_until, recycle_until,
        operation_id, request_id, deletion_job_id, epoch, updated_at
      ) VALUES (?, 'download_window', 10000, 20000, 'operation_held', 'request_held', NULL, 1, 1)
    `).run(base.id)
    await service.recycleBase(owner, base.id)

    const purging = service.purgeBase(owner, base.id)
    await vi.waitFor(() => expect(deleteKnowledgeBase).toHaveBeenCalledOnce())
    const claimed = memory.database.prepare(`
      SELECT epoch FROM knowledge_cloud_retention WHERE knowledge_base_id = ?
    `).get(base.id) as { epoch: number }
    expect(claimed.epoch).toBe(2)

    service.invalidate()
    const immediate = {
      retention: memory.database.prepare(`
        SELECT epoch, stage, deletion_job_id AS deletionJobId
        FROM knowledge_cloud_retention WHERE knowledge_base_id = ?
      `).get(base.id),
      sync: memory.database.prepare(`
        SELECT mode, epoch FROM cloud_sync_states WHERE knowledge_base_id = ?
      `).get(base.id),
    }
    let drained = false
    const draining = service.drain().then(() => { drained = true })
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(drained).toBe(false)

    deleteResult.resolve({ deletionJobId: 'delete_late' })
    await expect(purging).rejects.toMatchObject({ code: 'CONFLICT' })
    await draining

    expect(immediate).toEqual({
      retention: { epoch: 3, stage: 'download_window', deletionJobId: null },
      sync: { mode: 'paused', epoch: 2 },
    })
    expect(memory.database.prepare(`
      SELECT 1 FROM knowledge_cloud_deletion_receipts WHERE knowledge_base_id = ?
    `).get(base.id)).toBeUndefined()
    expect(memory.database.prepare(`
      SELECT lifecycle_status AS status FROM knowledge_bases WHERE id = ?
    `).get(base.id)).toEqual({ status: 'recycled' })
    expect(memory.database.prepare(`
      SELECT epoch, stage, deletion_job_id AS deletionJobId
      FROM knowledge_cloud_retention WHERE knowledge_base_id = ?
    `).get(base.id)).toEqual({ epoch: 3, stage: 'download_window', deletionJobId: null })
    expect(memory.database.prepare(`
      SELECT mode, epoch FROM cloud_sync_states WHERE knowledge_base_id = ?
    `).get(base.id)).toEqual({ mode: 'paused', epoch: 2 })
    expect(memory.closes()).toBe(1)
  })

  it('surfaces a synchronous owner-fence failure while still draining and closing retirement', async () => {
    const memory = memoryKnowledgeStore()
    const invalidationOrder: string[] = []
    let terminations = 0
    const service = createLocalKnowledgeService({
      openStore: async () => memory.store,
      selectImportFiles: async () => [],
      createParser: () => ({
        parse: async () => parsedText('unused'),
        terminateAll: async () => {
          invalidationOrder.push('runner')
          terminations += 1
        },
      }),
      saveExport: async () => undefined,
      isMember: () => false,
    })
    const owner = { userId: 'alice' }
    await service.bind(owner.userId)
    const base = await service.create(owner, '云端故障库')
    memory.database.prepare(`
      INSERT INTO cloud_sync_states(
        knowledge_base_id, mode, published_generation_id, epoch, updated_at
      ) VALUES (?, 'synced', 'generation_1', 1, 1)
    `).run(base.id)
    memory.database.function('observe_cloud_owner_fence', () => {
      invalidationOrder.push('cloud-fence')
    })
    memory.database.exec(`
      CREATE TRIGGER fail_cloud_owner_fence
      BEFORE UPDATE OF mode ON cloud_sync_states
      WHEN NEW.mode = 'paused'
      BEGIN
        SELECT observe_cloud_owner_fence();
        SELECT RAISE(ABORT, 'cloud owner fence failed');
      END
    `)

    let invalidationFailure: unknown
    try {
      service.invalidate()
    } catch (error) {
      invalidationFailure = error
    }
    await new Promise<void>(resolve => { setImmediate(resolve) })

    let firstDrainFailure: unknown
    try {
      await service.drain()
    } catch (error) {
      firstDrainFailure = error
    }
    memory.database.exec('DROP TRIGGER fail_cloud_owner_fence')

    let secondDrainFailure: unknown
    try {
      await service.drain()
    } catch (error) {
      secondDrainFailure = error
    }

    expect({
      invalidationFailure: invalidationFailure instanceof Error
        ? invalidationFailure.message
        : invalidationFailure,
      invalidationOrder,
      terminations,
      firstDrainFailure: firstDrainFailure instanceof Error
        ? firstDrainFailure.message
        : firstDrainFailure,
      secondDrainFailure,
      closes: memory.closes(),
      sync: memory.database.prepare(`
        SELECT mode, epoch FROM cloud_sync_states WHERE knowledge_base_id = ?
      `).get(base.id),
    }).toEqual({
      invalidationFailure: undefined,
      invalidationOrder: ['cloud-fence', 'runner', 'cloud-fence'],
      terminations: 1,
      firstDrainFailure: 'cloud owner fence failed',
      secondDrainFailure: undefined,
      closes: 1,
      sync: { mode: 'synced', epoch: 1 },
    })
  })

  it('purges a local-only recycled base without a remote deletion operation', async () => {
    const memory = memoryKnowledgeStore()
    const remote = cloudRemote()
    const service = createLocalKnowledgeService({
      openStore: async () => memory.store,
      selectImportFiles: async () => [],
      createParser: () => ({ parse: async () => parsedText('unused'), terminateAll: async () => undefined }),
      saveExport: async () => undefined,
      isMember: () => false,
    })
    service.configureCloudRemote!(remote)
    const owner = { userId: 'alice' }
    await service.bind(owner.userId)
    const base = await service.create(owner, '仅本地')
    await service.recycleBase(owner, base.id)

    await expect(service.purgeBase(owner, base.id)).resolves.toBeUndefined()
    expect(remote.deleteKnowledgeBase).not.toHaveBeenCalled()
  })

  it('anchors durable cloud degradation to the signed grace boundary while local data remains available', async () => {
    const memory = memoryKnowledgeStore()
    const boundaryAt = Date.parse('2026-08-31T00:00:00.000Z')
    let entitlement: KnowledgeEntitlementState = {
      tier: 'member', status: 'active', localEnabled: true,
      betaEnabled: true, cloudEnabled: true,
      expiresAt: '2026-08-28T00:00:00.000Z',
      graceEndsAt: '2026-08-31T00:00:00.000Z',
    }
    const service = createLocalKnowledgeService({
      openStore: async () => memory.store,
      selectImportFiles: async () => [],
      createParser: () => ({ parse: async () => parsedText('unused'), terminateAll: async () => undefined }),
      saveExport: async () => undefined,
      isMember: () => false,
      entitlement: () => entitlement,
      cloudKillSwitchEnabled: () => true,
      now: () => boundaryAt + 1,
    })
    const owner = { userId: 'alice' }
    await service.bind(owner.userId)
    const base = await service.create(owner, '云端资料')
    memory.database.prepare(`
      INSERT INTO cloud_sync_states(knowledge_base_id, mode, published_generation_id, epoch, updated_at)
      VALUES (?, 'synced', 'generation_1', 1, ?)
    `).run(base.id, boundaryAt)
    entitlement = { ...entitlement, tier: 'free', status: 'expired', betaEnabled: false, cloudEnabled: false }

    await expect(service.getEntitlement(owner)).resolves.toMatchObject({ status: 'expired' })
    expect(memory.database.prepare(`
      SELECT download_until AS downloadUntil, recycle_until AS recycleUntil
      FROM knowledge_cloud_retention WHERE knowledge_base_id = ?
    `).get(base.id)).toEqual({
      downloadUntil: boundaryAt + (30 * 24 * 60 * 60 * 1_000),
      recycleUntil: boundaryAt + (60 * 24 * 60 * 60 * 1_000),
    })
    await expect(service.list(owner)).resolves.toEqual([
      expect.objectContaining({ id: base.id }),
    ])
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

  it('pins the admitted version scope across replace and recycle until the run releases it', async () => {
    const memory = memoryKnowledgeStore()
    let pick = 0
    let parse = 0
    const service = createLocalKnowledgeService({
      openStore: async () => memory.store,
      selectImportFiles: async () => [pick++ === 0
        ? { name: '合同-v1.txt', mimeType: 'text/plain', bytes: Buffer.from('第一版唯一条款') }
        : { name: '合同-v2.txt', mimeType: 'text/plain', bytes: Buffer.from('第二版替换条款') }],
      createParser: () => ({
        parse: async () => parsedText(parse++ === 0 ? '第一版唯一条款' : '第二版替换条款'),
        terminateAll: async () => undefined,
      }),
      saveExport: async () => undefined,
      isMember: () => false,
    })
    await service.bind('alice')
    const owner = { userId: 'alice' }
    const base = await service.create(owner, '合同库')
    const [firstHandle] = await service.pickImportFiles(owner)
    const document = (await service.importDocument(owner, base.id, firstHandle!.id))!
    await vi.waitFor(async () => {
      const result = await service.searchSelected(owner, '第一版唯', [base.id])
      expect(result.kind === 'results' ? result.evidence : []).toHaveLength(1)
    })
    const scoped = service as typeof service & {
      captureSearchScope(owner: { userId: string }, baseIds: readonly string[]): Promise<unknown>
      releaseSearchScope(scope: unknown): void
      searchSelected(
        owner: { userId: string }, query: string, baseIds: readonly string[],
        signal: AbortSignal | undefined, scope: unknown,
      ): ReturnType<typeof service.searchSelected>
    }
    const scope = await scoped.captureSearchScope(owner, [base.id])
    const [replacement] = await service.pickImportFiles(owner)
    await service.replaceDocument(owner, document.id, replacement!.id)
    await vi.waitFor(async () => {
      const result = await service.searchSelected(owner, '第二版替', [base.id])
      expect(result.kind === 'results' ? result.evidence : []).toHaveLength(1)
    })
    await service.recycleDocument(owner, document.id)

    const admitted = await scoped.searchSelected(owner, '第一版唯', [base.id], undefined, scope)
    expect(admitted).toMatchObject({
      kind: 'results', evidence: [expect.objectContaining({ snippet: '第一版唯一条款' })],
    })
    await expect(service.purgeDocument(owner, document.id)).rejects.toMatchObject({ code: 'CONFLICT' })
    scoped.releaseSearchScope(scope)
    await expect(service.purgeDocument(owner, document.id)).resolves.toBeUndefined()
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
