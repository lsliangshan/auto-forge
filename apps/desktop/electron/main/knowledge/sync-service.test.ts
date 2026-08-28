import { createRequire } from 'node:module'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeKnowledgeSchema } from './knowledge-schema.js'
import { KnowledgeSyncService, type CloudKnowledgeRemote } from './sync-service.js'

const databases: Database.Database[] = []
const CipherDatabase = createRequire(import.meta.url)('better-sqlite3-multiple-ciphers') as {
  new(filename: string): Database.Database
}

interface LocalDependencyOverrides {
  applyRemoteChange?: (...args: unknown[]) => Promise<void>
  replaceRemoteSnapshot?: (...args: unknown[]) => Promise<void>
}

function fixture(
  overrides: Partial<CloudKnowledgeRemote> = {},
  online = true,
  localOverrides: LocalDependencyOverrides = {},
  cloudAllowed = true,
) {
  const database = new CipherDatabase(':memory:')
  databases.push(database)
  initializeKnowledgeSchema(database)
  database.prepare(`
    INSERT INTO knowledge_bases (id, name, created_at, updated_at)
    VALUES ('kb_1', 'Synced', 1, 1)
  `).run()
  const remote: CloudKnowledgeRemote = {
    beginSync: vi.fn().mockResolvedValue({
      knowledgeBaseId: 'kb_1', generationId: 'generation_1', status: 'staging',
    }),
    pushMutation: vi.fn().mockResolvedValue({
      mutationId: 'mutation_1', status: 'applied', sequence: 1, revision: 'remote_1',
    }),
    pullChanges: vi.fn().mockResolvedValue({
      kind: 'incremental', nextSequence: 0, hasMore: false, changes: [],
    }),
    fullResync: vi.fn().mockResolvedValue({ kind: 'snapshot', nextSequence: 0, changes: [] }),
    publishGeneration: vi.fn().mockResolvedValue({
      generationId: 'generation_new', previousGenerationId: 'generation_old', sequence: 2,
    }),
    deleteKnowledgeBase: vi.fn().mockResolvedValue({ deletionJobId: 'delete_1' }),
    getJob: vi.fn().mockResolvedValue({ jobId: 'delete_1', state: 'completed', errorCode: null }),
    cancelJob: vi.fn().mockResolvedValue(undefined),
    cleanupOrphans: vi.fn().mockResolvedValue({ removed: 0 }),
    ...overrides,
  }
  const applyRemoteChange = vi.fn(localOverrides.applyRemoteChange ?? (async (...args: unknown[]) => {
    const change = args[0] as { sequence: number }
    const guard = args[1] as {
      commitIncremental(sequence: number, write: () => void): void
    }
    guard.commitIncremental(change.sequence, () => undefined)
  }))
  const replaceRemoteSnapshot = vi.fn(
    localOverrides.replaceRemoteSnapshot ?? (async (...args: unknown[]) => {
      const guard = args[1] as {
        commitSnapshot(sequence: number, write: () => void): void
      }
      guard.commitSnapshot(args[2] as number, () => undefined)
    }),
  )
  const service = new KnowledgeSyncService(database, remote, {
    now: () => 1_000,
    id: () => 'lease_1',
    isOnline: () => online,
    applyRemoteChange,
    replaceRemoteSnapshot,
  })
  if (cloudAllowed) service.setCloudAccess(true)
  return { database, remote, service, applyRemoteChange, replaceRemoteSnapshot }
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>(settle => { resolve = settle })
  return { promise, resolve }
}

function commitFromCallback(args: unknown[], write: () => void): void {
  const guard = args.find(value => typeof value === 'object' && value !== null
    && 'commit' in value) as { commit?: (callback: () => void) => void } | undefined
  if (guard?.commit) {
    guard.commit(write)
    return
  }
  write()
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

describe('KnowledgeSyncService', () => {
  it('starts fail closed and anchors retention windows to the entitlement boundary', async () => {
    const { database, service } = fixture({}, true, {}, false)
    expect(() => service.enqueue({
      mutationId: 'closed', knowledgeBaseId: 'kb_1', entityKind: 'document',
      entityId: 'doc_1', operation: 'upsert', baseRevision: null, payload: {},
    })).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    database.prepare(`
      INSERT INTO cloud_sync_states(knowledge_base_id, mode, published_generation_id, epoch, updated_at)
      VALUES ('kb_1', 'synced', 'generation_1', 1, 1)
    `).run()
    service.setCloudAccess(false)
    expect(service.getState('kb_1').mode).toBe('paused')
    expect(service.beginCloudRetention('kb_1', 500)).toMatchObject({
      downloadUntil: 500 + (30 * 24 * 60 * 60 * 1_000),
      recycleUntil: 500 + (60 * 24 * 60 * 60 * 1_000),
    })
    await expect(service.drain()).resolves.toBeUndefined()
  })

  it('invalidates an awaited cloud callback and removes every cloud operation when access closes', async () => {
    let resolveBegin!: (value: {
      knowledgeBaseId: string; generationId: string; status: 'staging'
    }) => void
    const beginSync = vi.fn().mockReturnValue(new Promise(resolve => { resolveBegin = resolve }))
    const { service } = fixture({ beginSync })
    const enabling = service.enableSync({
      requestId: 'begin_gate', knowledgeBaseId: 'kb_1', name: 'Synced',
      revision: 'local_1', generationId: 'generation_1',
    })
    await vi.waitFor(() => expect(beginSync).toHaveBeenCalledOnce())
    service.setCloudAccess(false)
    resolveBegin({ knowledgeBaseId: 'kb_1', generationId: 'generation_1', status: 'staging' })

    await expect(enabling).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(service.getState('kb_1').mode).toBe('paused')
    await expect(service.enableSync({
      requestId: 'closed', knowledgeBaseId: 'kb_1', name: 'Synced',
      revision: 'local_1', generationId: 'generation_1',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(service.synchronize('kb_1')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(() => service.enqueue({
      mutationId: 'closed_mutation', knowledgeBaseId: 'kb_1', entityKind: 'document',
      entityId: 'document_1', operation: 'upsert', baseRevision: null, payload: {},
    })).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => service.resume('kb_1')).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
  })

  it('does not commit a held mutation result from an earlier access epoch after regrant', async () => {
    type PushResult = Awaited<ReturnType<CloudKnowledgeRemote['pushMutation']>>
    let resolvePush!: (value: PushResult) => void
    const heldPush = new Promise<PushResult>(resolve => { resolvePush = resolve })
    const pushMutation = vi.fn<CloudKnowledgeRemote['pushMutation']>(async () => heldPush)
    const { database, remote, service } = fixture({ pushMutation })
    service.enqueue({
      mutationId: 'mutation_consent_epoch', knowledgeBaseId: 'kb_1',
      entityKind: 'document', entityId: 'document_1', operation: 'upsert',
      baseRevision: null, payload: { versionId: 'version_1' },
    })

    const oldEpoch = service.synchronize('kb_1')
    await vi.waitFor(() => expect(pushMutation).toHaveBeenCalledOnce())
    service.setCloudAccess(false)
    service.setCloudAccess(true)
    service.resume('kb_1')
    resolvePush({
      mutationId: 'mutation_consent_epoch', status: 'applied', sequence: 1, revision: 'r1',
    })

    await expect(oldEpoch).resolves.toEqual({
      status: 'paused', processed: 0, conflicts: 0,
    })
    expect(remote.pullChanges).not.toHaveBeenCalled()
    expect(database.prepare(`
      SELECT state FROM cloud_sync_mutations WHERE id = 'mutation_consent_epoch'
    `).get()).toEqual({ state: 'leased' })
  })

  it('allows verified conversion during the download window after cloud access closes', async () => {
    const { remote, service } = fixture()
    service.beginCloudRetention('kb_1', 500)
    service.setCloudAccess(false)

    await expect(service.convertToLocalOnly('kb_1', async () => ({
      complete: true, expectedDigest: 'verified', actualDigest: 'verified',
    }))).resolves.toBeUndefined()
    expect(remote.deleteKnowledgeBase).toHaveBeenCalledOnce()
    expect(service.getState('kb_1')).toEqual({
      mode: 'local_only', publishedGenerationId: null,
    })
  })

  it('durably advances the 30+30 day lifecycle and permits immediate purge while cloud is off', async () => {
    const { database, remote, service } = fixture()
    expect(service.beginCloudRetention('kb_1')).toMatchObject({
      stage: 'download_window', downloadUntil: 1_000 + (30 * 24 * 60 * 60 * 1_000),
      recycleUntil: 1_000 + (60 * 24 * 60 * 60 * 1_000), epoch: 1,
    })
    database.prepare(`
      UPDATE knowledge_cloud_retention SET download_until = 999, recycle_until = 2000
      WHERE knowledge_base_id = 'kb_1'
    `).run()
    await expect(service.advanceCloudRetention('kb_1')).resolves.toMatchObject({
      stage: 'recycle', epoch: 2,
    })
    const download = vi.fn().mockResolvedValue({
      complete: true, expectedDigest: 'digest', actualDigest: 'digest',
    })
    await expect(service.convertToLocalOnly('kb_1', download))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(download).not.toHaveBeenCalled()
    database.prepare(`
      UPDATE knowledge_cloud_retention SET recycle_until = 1000
      WHERE knowledge_base_id = 'kb_1'
    `).run()
    service.setCloudAccess(false)
    await expect(service.advanceCloudRetention('kb_1')).resolves.toBeUndefined()
    expect(remote.deleteKnowledgeBase).toHaveBeenCalledWith(expect.objectContaining({
      knowledgeBaseId: 'kb_1', requestId: expect.any(String),
    }))
    expect(service.getCloudRetention('kb_1')).toBeUndefined()
    expect(service.getState('kb_1')).toEqual({ mode: 'local_only', publishedGenerationId: null })
    expect(database.prepare(`
      SELECT deletion_job_id AS deletionJobId
      FROM knowledge_cloud_deletion_receipts WHERE knowledge_base_id = 'kb_1'
    `).get()).toEqual({ deletionJobId: 'delete_1' })
  })

  it('permits a user-requested immediate purge during the download window while cloud is off', async () => {
    const { remote, service } = fixture()
    service.beginCloudRetention('kb_1', 500)
    service.setCloudAccess(false)

    await expect(service.purgeCloudImmediately('kb_1')).resolves.toBeUndefined()
    expect(remote.deleteKnowledgeBase).toHaveBeenCalledWith(expect.objectContaining({
      knowledgeBaseId: 'kb_1', requestId: expect.any(String),
    }))
    expect(service.getCloudRetention('kb_1')).toBeUndefined()
    expect(service.getState('kb_1')).toEqual({ mode: 'local_only', publishedGenerationId: null })
  })

  it('fences and drains a purge callback after owner invalidation', async () => {
    let resolveDelete!: (value: { deletionJobId: string }) => void
    const deleteKnowledgeBase = vi.fn().mockReturnValue(new Promise(resolve => {
      resolveDelete = resolve
    }))
    const { database, service } = fixture({ deleteKnowledgeBase })
    service.beginCloudRetention('kb_1', 500)
    service.setCloudAccess(false)

    const purging = service.purgeCloudImmediately('kb_1')
    await vi.waitFor(() => expect(deleteKnowledgeBase).toHaveBeenCalledOnce())
    service.invalidateOwner()
    let drained = false
    const draining = service.drain().then(() => { drained = true })
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(drained).toBe(false)

    resolveDelete({ deletionJobId: 'delete_late' })
    await expect(purging).rejects.toMatchObject({ code: 'CONFLICT' })
    await draining
    expect(database.prepare(`
      SELECT 1 FROM knowledge_cloud_deletion_receipts WHERE knowledge_base_id = 'kb_1'
    `).get()).toBeUndefined()
    expect(database.prepare(`
      SELECT stage FROM knowledge_cloud_retention WHERE knowledge_base_id = 'kb_1'
    `).get()).toEqual({ stage: 'download_window' })
    expect(service.getState('kb_1').mode).toBe('paused')
  })

  it('reuses the deletion request after a lost response and preserves a payload-free terminal receipt', async () => {
    const deleteKnowledgeBase = vi.fn()
      .mockRejectedValueOnce(new Error('lost response'))
      .mockResolvedValueOnce({ deletionJobId: 'delete_retry_1' })
    const { database, remote, service } = fixture({
      deleteKnowledgeBase,
      getJob: vi.fn().mockResolvedValue({
        jobId: 'delete_retry_1', state: 'completed', errorCode: null,
      }),
    })
    service.beginCloudRetention('kb_1', 500)
    service.setCloudAccess(false)

    await expect(service.purgeCloudImmediately('kb_1')).rejects.toThrow('lost response')
    const journal = database.prepare(`
      SELECT operation_id AS operationId, request_id AS requestId
      FROM knowledge_cloud_retention WHERE knowledge_base_id = 'kb_1'
    `).get() as { operationId: string; requestId: string }
    await expect(service.purgeCloudImmediately('kb_1')).resolves.toBeUndefined()
    await expect(service.purgeCloudImmediately('kb_1')).resolves.toBeUndefined()

    expect(deleteKnowledgeBase).toHaveBeenCalledTimes(2)
    expect(deleteKnowledgeBase.mock.calls.map(([input]) => input.requestId))
      .toEqual([journal.requestId, journal.requestId])
    expect(remote.getJob).toHaveBeenCalledWith({ jobId: 'delete_retry_1' })
    expect(database.prepare(`
      SELECT knowledge_base_id AS knowledgeBaseId, operation_id AS operationId,
        request_id AS requestId, deletion_job_id AS deletionJobId, completed_at AS completedAt
      FROM knowledge_cloud_deletion_receipts WHERE knowledge_base_id = 'kb_1'
    `).get()).toEqual({
      knowledgeBaseId: 'kb_1', operationId: journal.operationId,
      requestId: journal.requestId, deletionJobId: 'delete_retry_1', completedAt: 1_000,
    })
    expect(service.getCloudRetention('kb_1')).toBeUndefined()
  })

  it('keeps the deletion job journal recoverable when remote confirmation times out', async () => {
    const getJob = vi.fn().mockResolvedValue({
      jobId: 'delete_timeout_1', state: 'running', errorCode: null,
    })
    const { database, service } = fixture({
      deleteKnowledgeBase: vi.fn().mockResolvedValue({ deletionJobId: 'delete_timeout_1' }),
      getJob,
    })
    service.beginCloudRetention('kb_1', 500)
    service.setCloudAccess(false)

    await expect(service.purgeCloudImmediately('kb_1')).rejects.toMatchObject({
      code: 'TRANSIENT_FAILURE', retryable: true,
    })
    expect(getJob).toHaveBeenCalledTimes(3)
    expect(database.prepare(`
      SELECT stage, deletion_job_id AS deletionJobId
      FROM knowledge_cloud_retention WHERE knowledge_base_id = 'kb_1'
    `).get()).toEqual({ stage: 'purging', deletionJobId: 'delete_timeout_1' })
    expect(database.prepare(`
      SELECT 1 FROM knowledge_cloud_deletion_receipts WHERE knowledge_base_id = 'kb_1'
    `).get()).toBeUndefined()
    expect(database.prepare(
      "SELECT 1 AS present FROM knowledge_bases WHERE id = 'kb_1'",
    ).get()).toEqual({ present: 1 })
  })

  it('durably queues offline mutations without calling CloudBase', async () => {
    const { database, remote, service } = fixture({}, false)
    service.enqueue({
      mutationId: 'mutation_offline', knowledgeBaseId: 'kb_1', entityKind: 'document',
      entityId: 'document_1', operation: 'upsert', baseRevision: null,
      payload: { versionId: 'version_1' },
    })

    await expect(service.synchronize('kb_1')).resolves.toEqual({
      status: 'offline', processed: 0, conflicts: 0,
    })
    expect(remote.pushMutation).not.toHaveBeenCalled()
    expect(database.prepare(
      'SELECT state, attempt FROM cloud_sync_mutations WHERE id = ?',
    ).get('mutation_offline')).toEqual({ state: 'queued', attempt: 0 })
  })

  it('keeps a newly enabled cloud base in staging until explicit publication', async () => {
    const { service } = fixture()
    await service.enableSync({
      requestId: 'begin_1', knowledgeBaseId: 'kb_1', name: 'Synced',
      revision: 'local_1', generationId: 'generation_1',
    })
    expect(service.getState('kb_1')).toEqual({ mode: 'syncing', publishedGenerationId: null })
  })

  it('does not overwrite a pause issued while enablement awaits CloudBase', async () => {
    let resolveBegin!: (value: {
      knowledgeBaseId: string; generationId: string; status: 'staging'
    }) => void
    const beginSync = vi.fn().mockReturnValue(new Promise(resolve => { resolveBegin = resolve }))
    const { service } = fixture({ beginSync })
    const enabling = service.enableSync({
      requestId: 'begin_late', knowledgeBaseId: 'kb_1', name: 'Synced',
      revision: 'local_1', generationId: 'generation_1',
    })
    await vi.waitFor(() => expect(beginSync).toHaveBeenCalledOnce())
    service.pause('kb_1')
    resolveBegin({ knowledgeBaseId: 'kb_1', generationId: 'generation_1', status: 'staging' })

    await expect(enabling).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(service.getState('kb_1').mode).toBe('paused')
  })

  it('performs a full snapshot for a zero cursor before any incremental pull', async () => {
    const fullResync = vi.fn().mockResolvedValue({
      kind: 'snapshot',
      nextSequence: 42,
      changes: [{ sequence: 42, entityKind: 'document', entityId: 'document_remote', operation: 'upsert', revision: 'r42', payload: {} }],
    })
    const pullChanges = vi.fn().mockResolvedValue({ kind: 'cursor_stale' })
    const { database, service, applyRemoteChange, replaceRemoteSnapshot } = fixture({
      pullChanges, fullResync,
    })

    await expect(service.synchronize('kb_1')).resolves.toMatchObject({ status: 'synced' })
    expect(fullResync).toHaveBeenCalledWith({ knowledgeBaseId: 'kb_1' })
    expect(replaceRemoteSnapshot).toHaveBeenCalledWith([
      { sequence: 42, entityKind: 'document', entityId: 'document_remote', operation: 'upsert', revision: 'r42', payload: {} },
    ], expect.objectContaining({
      knowledgeBaseId: 'kb_1', projection: 'local', commit: expect.any(Function),
      commitSnapshot: expect.any(Function), commitIncremental: expect.any(Function),
    }), 42)
    expect(applyRemoteChange).not.toHaveBeenCalled()
    expect(pullChanges).not.toHaveBeenCalled()
    expect(database.prepare(
      'SELECT sequence FROM sync_cursors WHERE knowledge_base_id = ?',
    ).get('kb_1')).toEqual({ sequence: 42 })
  })

  it('uses independent durable state for a remote-only snapshot and commits its cursor atomically', async () => {
    const replaceRemoteSnapshot = async (...args: unknown[]) => {
      const changes = args[0] as Array<{ payload: Record<string, unknown> }>
      const guard = args[1] as {
        projection: 'remote'
        commitSnapshot(sequence: number, write: () => void): void
      }
      expect(guard.projection).toBe('remote')
      guard.commitSnapshot(args[2] as number, () => {
        database.prepare(`
          INSERT INTO cloud_base_projections(
            id, name, status, published_generation_id, revision, updated_at
          ) VALUES (?, ?, 'ready', NULL, 'remote_r7', 1)
        `).run('remote_base', changes[0]!.payload.name)
      })
    }
    const { database, service } = fixture({
      fullResync: vi.fn().mockResolvedValue({
        kind: 'snapshot', nextSequence: 7,
        changes: [{
          sequence: 7, entityKind: 'knowledge_base', entityId: 'remote_base',
          operation: 'upsert', revision: 'remote_r7', payload: { name: 'Remote' },
        }],
      }),
    }, true, { replaceRemoteSnapshot })

    await expect(service.synchronizeRemoteProjection('remote_base')).resolves.toMatchObject({
      status: 'synced', processed: 0, conflicts: 0,
    })
    expect(database.prepare(
      "SELECT 1 AS present FROM knowledge_bases WHERE id = 'remote_base'",
    ).get()).toBeUndefined()
    expect(database.prepare(`
      SELECT mode FROM cloud_remote_sync_states WHERE knowledge_base_id = 'remote_base'
    `).get()).toEqual({ mode: 'synced' })
    expect(database.prepare(`
      SELECT sequence FROM cloud_remote_sync_cursors WHERE knowledge_base_id = 'remote_base'
    `).get()).toEqual({ sequence: 7 })
    expect(database.prepare(`
      SELECT name FROM cloud_base_projections WHERE id = 'remote_base'
    `).get()).toEqual({ name: 'Remote' })
    expect(database.prepare(`
      SELECT 1 AS present FROM cloud_sync_states WHERE knowledge_base_id = 'remote_base'
    `).get()).toBeUndefined()
  })

  it('prunes absent remote-only projections only after the complete owner catalog synchronizes', async () => {
    const pullChanges = vi.fn(async ({ afterSequence }: { afterSequence: number }) => ({
      kind: 'incremental' as const, nextSequence: afterSequence,
      hasMore: false, changes: [],
    }))
    const { database, remote, service } = fixture({ pullChanges })
    const listKnowledgeBases = vi.fn().mockResolvedValue(['remote_keep'])
    Object.assign(remote, { listKnowledgeBases })
    database.exec(`
      INSERT INTO cloud_base_projections(
        id, name, status, published_generation_id, revision, updated_at
      ) VALUES
        ('remote_keep', 'Keep', 'ready', NULL, 'r1', 1),
        ('remote_prune', 'Prune', 'ready', NULL, 'r1', 1),
        ('kb_1', 'Local shadow', 'ready', NULL, 'r1', 1);
      INSERT INTO cloud_remote_entity_heads(
        knowledge_base_id, entity_kind, entity_id, revision, payload_json, deleted, updated_at
      ) VALUES
        ('remote_keep', 'knowledge_base', 'remote_keep', 'r1', '{}', 0, 1),
        ('remote_prune', 'knowledge_base', 'remote_prune', 'r1', '{}', 0, 1),
        ('kb_1', 'knowledge_base', 'kb_1', 'r1', '{}', 0, 1);
      INSERT INTO cloud_remote_sync_states(
        knowledge_base_id, mode, published_generation_id, epoch, updated_at
      ) VALUES
        ('remote_keep', 'synced', NULL, 1, 1),
        ('remote_prune', 'synced', NULL, 1, 1),
        ('kb_1', 'synced', NULL, 1, 1);
      INSERT INTO cloud_remote_sync_cursors(knowledge_base_id, sequence, updated_at)
      VALUES ('remote_keep', 1, 1), ('remote_prune', 1, 1), ('kb_1', 1, 1);
    `)

    await expect(service.synchronizeOwnerCatalog()).resolves.toEqual(['remote_keep'])
    expect(listKnowledgeBases).toHaveBeenCalledOnce()
    expect(pullChanges).toHaveBeenCalledWith({
      knowledgeBaseId: 'remote_keep', afterSequence: 1,
    })
    for (const table of [
      'cloud_base_projections', 'cloud_remote_entity_heads',
      'cloud_remote_sync_states', 'cloud_remote_sync_cursors',
    ]) {
      const id = table === 'cloud_base_projections' ? 'id' : 'knowledge_base_id'
      expect(database.prepare(
        `SELECT ${id} AS id FROM ${table} ORDER BY id`,
      ).all()).toEqual([{ id: 'kb_1' }, { id: 'remote_keep' }])
    }
  })

  it('keeps stale remote projections when catalog synchronization is partial or its access epoch changes', async () => {
    const secondSnapshot = deferred()
    const fullResync = vi.fn(async ({ knowledgeBaseId }: { knowledgeBaseId: string }) => {
      if (knowledgeBaseId === 'remote_second') await secondSnapshot.promise
      return { kind: 'snapshot' as const, nextSequence: 1, changes: [] }
    })
    const first = fixture({ fullResync })
    Object.assign(first.remote, {
      listKnowledgeBases: vi.fn().mockResolvedValue(['remote_first', 'remote_second']),
    })
    first.database.prepare(`
      INSERT INTO cloud_base_projections(
        id, name, status, published_generation_id, revision, updated_at
      ) VALUES ('remote_stale', 'Stale', 'ready', NULL, 'r1', 1)
    `).run()
    const running = first.service.synchronizeOwnerCatalog()
    await vi.waitFor(() => expect(fullResync).toHaveBeenCalledTimes(2))
    first.service.setCloudAccess(false)
    first.service.setCloudAccess(true)
    secondSnapshot.resolve()

    await expect(running).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(first.database.prepare(
      "SELECT id FROM cloud_base_projections WHERE id = 'remote_stale'",
    ).get()).toEqual({ id: 'remote_stale' })

    const rejected = fixture()
    Object.assign(rejected.remote, {
      listKnowledgeBases: vi.fn().mockRejectedValue(
        Object.assign(new Error('expired'), { code: 'CURSOR_STALE' }),
      ),
    })
    rejected.database.prepare(`
      INSERT INTO cloud_base_projections(
        id, name, status, published_generation_id, revision, updated_at
      ) VALUES ('remote_stale', 'Stale', 'ready', NULL, 'r1', 1)
    `).run()
    await expect(rejected.service.synchronizeOwnerCatalog())
      .rejects.toMatchObject({ code: 'CURSOR_STALE' })
    expect(rejected.database.prepare(
      "SELECT id FROM cloud_base_projections WHERE id = 'remote_stale'",
    ).get()).toEqual({ id: 'remote_stale' })
  })

  it('rolls back every catalog prune table when one remote-only deletion fails', async () => {
    const { database, remote, service } = fixture()
    Object.assign(remote, { listKnowledgeBases: vi.fn().mockResolvedValue([]) })
    database.exec(`
      INSERT INTO cloud_base_projections(
        id, name, status, published_generation_id, revision, updated_at
      ) VALUES ('remote_stale', 'Stale', 'ready', NULL, 'r1', 1);
      INSERT INTO cloud_remote_entity_heads(
        knowledge_base_id, entity_kind, entity_id, revision, payload_json, deleted, updated_at
      ) VALUES ('remote_stale', 'knowledge_base', 'remote_stale', 'r1', '{}', 0, 1);
      INSERT INTO cloud_remote_sync_states(
        knowledge_base_id, mode, published_generation_id, epoch, updated_at
      ) VALUES ('remote_stale', 'synced', NULL, 1, 1);
      INSERT INTO cloud_remote_sync_cursors(knowledge_base_id, sequence, updated_at)
      VALUES ('remote_stale', 1, 1);
      CREATE TRIGGER reject_catalog_head_prune
      BEFORE DELETE ON cloud_remote_entity_heads
      BEGIN SELECT RAISE(ABORT, 'catalog prune rejected'); END;
    `)

    await expect(service.synchronizeOwnerCatalog()).rejects.toThrow('catalog prune rejected')
    expect(database.prepare(
      "SELECT id FROM cloud_base_projections WHERE id = 'remote_stale'",
    ).get()).toEqual({ id: 'remote_stale' })
    expect(database.prepare(
      "SELECT knowledge_base_id AS id FROM cloud_remote_sync_states WHERE knowledge_base_id = 'remote_stale'",
    ).get()).toEqual({ id: 'remote_stale' })
    expect(database.prepare(
      "SELECT knowledge_base_id AS id FROM cloud_remote_sync_cursors WHERE knowledge_base_id = 'remote_stale'",
    ).get()).toEqual({ id: 'remote_stale' })
  })

  it('rolls back a remote-only snapshot projection when its cursor cannot commit', async () => {
    const replaceRemoteSnapshot = async (...args: unknown[]) => {
      const guard = args[1] as {
        commitSnapshot(sequence: number, write: () => void): void
      }
      guard.commitSnapshot(args[2] as number, () => {
        database.prepare(`
          INSERT INTO cloud_base_projections(
            id, name, status, published_generation_id, revision, updated_at
          ) VALUES ('remote_base', 'Remote', 'ready', NULL, 'remote_r7', 1)
        `).run()
      })
    }
    const fixtureResult = fixture({
      fullResync: vi.fn().mockResolvedValue({
        kind: 'snapshot', nextSequence: 7, changes: [],
      }),
    }, true, { replaceRemoteSnapshot })
    const { database } = fixtureResult
    database.exec(`
      CREATE TRIGGER reject_remote_cursor
      BEFORE INSERT ON cloud_remote_sync_cursors
      BEGIN SELECT RAISE(ABORT, 'cursor rejected'); END;
    `)

    await expect(fixtureResult.service.synchronizeRemoteProjection('remote_base'))
      .rejects.toThrow('cursor rejected')
    expect(database.prepare(`
      SELECT 1 AS present FROM cloud_base_projections WHERE id = 'remote_base'
    `).get()).toBeUndefined()
    expect(database.prepare(`
      SELECT 1 AS present FROM cloud_remote_sync_cursors WHERE knowledge_base_id = 'remote_base'
    `).get()).toBeUndefined()
  })

  it('rejects a held snapshot commit after cancellation and still releases callback resources', async () => {
    const entered = deferred()
    const release = deferred()
    let localWrites = 0
    let cleanedUp = false
    const replaceRemoteSnapshot = async (...args: unknown[]) => {
      entered.resolve()
      await release.promise
      try {
        commitFromCallback(args, () => { localWrites += 1 })
      } finally {
        cleanedUp = true
      }
    }
    const { database, service } = fixture({
      fullResync: vi.fn().mockResolvedValue({
        kind: 'snapshot', nextSequence: 7,
        changes: [{ sequence: 7, entityKind: 'document', entityId: 'document_remote',
          operation: 'upsert', revision: 'r7', payload: { held: true } }],
      }),
    }, true, { replaceRemoteSnapshot })

    const running = service.synchronize('kb_1')
    await entered.promise
    service.cancel('kb_1')
    release.resolve()

    await expect(running).resolves.toEqual({ status: 'paused', processed: 0, conflicts: 0 })
    expect(localWrites).toBe(0)
    expect(cleanedUp).toBe(true)
    expect(database.prepare(
      'SELECT count(*) AS count FROM sync_cursors WHERE knowledge_base_id = ?',
    ).get('kb_1')).toEqual({ count: 0 })
  })

  it('rejects a late full snapshot when durable owner invalidation rolls back', async () => {
    let resolveSnapshot!: (value: {
      kind: 'snapshot'
      nextSequence: number
      changes: Array<{
        sequence: number
        entityKind: 'document'
        entityId: string
        operation: 'upsert'
        revision: string
        payload: Record<string, unknown>
      }>
    }) => void
    const fullResync = vi.fn().mockReturnValue(new Promise(resolve => { resolveSnapshot = resolve }))
    let localWrites = 0
    const replaceRemoteSnapshot = async (...args: unknown[]) => {
      commitFromCallback(args, () => { localWrites += 1 })
    }
    const { database, service } = fixture(
      { fullResync }, true, { replaceRemoteSnapshot },
    )
    database.exec(`
      CREATE TRIGGER fail_owner_pause
      BEFORE UPDATE OF mode ON cloud_sync_states
      WHEN NEW.mode = 'paused'
      BEGIN
        SELECT RAISE(ABORT, 'owner fence failed');
      END
    `)

    const running = service.synchronize('kb_1')
    await vi.waitFor(() => expect(fullResync).toHaveBeenCalledOnce())
    expect(() => service.invalidateOwner()).toThrow('owner fence failed')
    resolveSnapshot({
      kind: 'snapshot', nextSequence: 7,
      changes: [{
        sequence: 7, entityKind: 'document', entityId: 'document_remote',
        operation: 'upsert', revision: 'r7', payload: { late: true },
      }],
    })

    await expect(running).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(service.drain()).resolves.toBeUndefined()
    expect(localWrites).toBe(0)
    expect(database.prepare(
      'SELECT count(*) AS count FROM sync_cursors WHERE knowledge_base_id = ?',
    ).get('kb_1')).toEqual({ count: 0 })
    expect(database.prepare(
      'SELECT mode, epoch FROM cloud_sync_states WHERE knowledge_base_id = ?',
    ).get('kb_1')).toEqual({ mode: 'syncing', epoch: 1 })
  })

  it('replaces an expired incremental cursor with a complete snapshot', async () => {
    const fullResync = vi.fn().mockResolvedValue({
      kind: 'snapshot', nextSequence: 4,
      changes: [{ sequence: 4, entityKind: 'document', entityId: 'document_remote',
        operation: 'upsert', revision: 'r4', payload: {} }],
    })
    const pullChanges = vi.fn().mockResolvedValue({ kind: 'cursor_stale' })
    const { database, service, replaceRemoteSnapshot } = fixture({ pullChanges, fullResync })
    database.prepare(
      'INSERT INTO sync_cursors (knowledge_base_id, sequence, updated_at) VALUES (?, ?, ?)',
    ).run('kb_1', 9, 1)

    await expect(service.synchronize('kb_1')).resolves.toMatchObject({ status: 'synced' })
    expect(pullChanges).toHaveBeenCalledWith({ knowledgeBaseId: 'kb_1', afterSequence: 9 })
    expect(replaceRemoteSnapshot).toHaveBeenCalledOnce()
    expect(database.prepare(
      'SELECT sequence FROM sync_cursors WHERE knowledge_base_id = ?',
    ).get('kb_1')).toEqual({ sequence: 4 })
  })

  it('rejects a held incremental apply after owner invalidation without advancing the cursor', async () => {
    const entered = deferred()
    const release = deferred()
    let localWrites = 0
    let cleanedUp = false
    const applyRemoteChange = async (...args: unknown[]) => {
      entered.resolve()
      await release.promise
      try {
        commitFromCallback(args, () => { localWrites += 1 })
      } finally {
        cleanedUp = true
      }
    }
    const { database, service } = fixture({
      pullChanges: vi.fn().mockResolvedValue({
        kind: 'incremental', nextSequence: 2, hasMore: false,
        changes: [{ sequence: 2, entityKind: 'document', entityId: 'document_remote',
          operation: 'upsert', revision: 'r2', payload: { held: true } }],
      }),
    }, true, { applyRemoteChange })
    database.prepare(
      'INSERT INTO sync_cursors (knowledge_base_id, sequence, updated_at) VALUES (?, ?, ?)',
    ).run('kb_1', 1, 1)

    const running = service.synchronize('kb_1')
    await entered.promise
    service.invalidateOwner()
    release.resolve()

    await expect(running).resolves.toEqual({ status: 'paused', processed: 0, conflicts: 0 })
    expect(localWrites).toBe(0)
    expect(cleanedUp).toBe(true)
    expect(database.prepare(
      'SELECT sequence FROM sync_cursors WHERE knowledge_base_id = ?',
    ).get('kb_1')).toEqual({ sequence: 1 })
  })

  it('never regresses a durable monotonic cursor', async () => {
    const { database, service } = fixture({
      pullChanges: vi.fn().mockResolvedValue({
        kind: 'incremental', nextSequence: 5, hasMore: false, changes: [],
      }),
    })
    database.prepare(
      'INSERT INTO sync_cursors (knowledge_base_id, sequence, updated_at) VALUES (?, ?, ?)',
    ).run('kb_1', 5, 1)

    await service.synchronize('kb_1')
    expect(database.prepare(
      'SELECT sequence FROM sync_cursors WHERE knowledge_base_id = ?',
    ).get('kb_1')).toEqual({ sequence: 5 })
  })

  it('preserves both sides of content and delete-vs-update conflicts', async () => {
    const pushMutation = vi.fn()
      .mockResolvedValueOnce({
        mutationId: 'mutation_content', status: 'conflict', conflictKind: 'content',
        localRevision: 'local_2', remoteRevision: 'remote_2', sequence: 3,
      })
      .mockResolvedValueOnce({
        mutationId: 'mutation_delete', status: 'conflict', conflictKind: 'delete_vs_update',
        localRevision: 'local_3', remoteRevision: 'remote_3', sequence: 4,
      })
    const { database, service } = fixture({ pushMutation })
    service.enqueue({
      mutationId: 'mutation_content', knowledgeBaseId: 'kb_1', entityKind: 'document',
      entityId: 'document_1', operation: 'upsert', baseRevision: 'remote_1',
      payload: { versionId: 'local_2' },
    })
    service.enqueue({
      mutationId: 'mutation_delete', knowledgeBaseId: 'kb_1', entityKind: 'document',
      entityId: 'document_2', operation: 'delete', baseRevision: 'remote_2', payload: {},
    })

    await expect(service.synchronize('kb_1')).resolves.toMatchObject({ conflicts: 2 })
    expect(database.prepare(`
      SELECT entity_kind AS entityKind, conflict_kind AS conflictKind,
        entity_id AS entityId, local_version AS localVersion,
        remote_version AS remoteVersion, status
      FROM conflicts ORDER BY entity_id
    `).all()).toEqual([
      { entityKind: 'document', conflictKind: 'content', entityId: 'document_1', localVersion: 'local_2', remoteVersion: 'remote_2', status: 'open' },
      { entityKind: 'document', conflictKind: 'delete_vs_update', entityId: 'document_2', localVersion: 'local_3', remoteVersion: 'remote_3', status: 'open' },
    ])
  })

  it('retries only transient failures and stops after three attempts', async () => {
    const transient = Object.assign(new Error('masked'), { code: 'TRANSIENT_FAILURE', retryable: true })
    const pushMutation = vi.fn().mockRejectedValue(transient)
    const { database, service } = fixture({ pushMutation })
    service.enqueue({
      mutationId: 'mutation_1', knowledgeBaseId: 'kb_1', entityKind: 'document',
      entityId: 'document_1', operation: 'upsert', baseRevision: null, payload: {},
    })

    await service.synchronize('kb_1')
    await service.synchronize('kb_1')
    await service.synchronize('kb_1')
    await service.synchronize('kb_1')
    expect(pushMutation).toHaveBeenCalledTimes(3)
    expect(database.prepare(
      'SELECT state, attempt, error_code AS errorCode FROM cloud_sync_mutations WHERE id = ?',
    ).get('mutation_1')).toEqual({ state: 'failed', attempt: 3, errorCode: 'TRANSIENT_FAILURE' })

    const permanentPush = vi.fn().mockRejectedValue(
      Object.assign(new Error('masked'), { code: 'FORBIDDEN', retryable: true }),
    )
    const second = fixture({ pushMutation: permanentPush })
    second.service.enqueue({
      mutationId: 'mutation_permanent', knowledgeBaseId: 'kb_1', entityKind: 'document',
      entityId: 'document_2', operation: 'upsert', baseRevision: null, payload: {},
    })
    await expect(second.service.synchronize('kb_1')).resolves.toMatchObject({ status: 'failed' })
    await second.service.synchronize('kb_1')
    expect(permanentPush).toHaveBeenCalledTimes(1)
    expect(second.service.getState('kb_1').mode).toBe('failed')
  })

  it('rejects a remote mutation result correlated to another operation', async () => {
    const { database, service } = fixture({
      pushMutation: vi.fn().mockResolvedValue({
        mutationId: 'different', status: 'applied', sequence: 1, revision: 'r1',
      }),
    })
    service.enqueue({
      mutationId: 'mutation_expected', knowledgeBaseId: 'kb_1', entityKind: 'document',
      entityId: 'document_1', operation: 'upsert', baseRevision: null, payload: {},
    })
    await expect(service.synchronize('kb_1')).resolves.toMatchObject({ status: 'failed' })
    expect(database.prepare(
      'SELECT state, error_code AS errorCode FROM cloud_sync_mutations WHERE id = ?',
    ).get('mutation_expected')).toEqual({ state: 'failed', errorCode: 'INTERNAL_ERROR' })
  })

  it('does not replace the published generation when staging publication fails', async () => {
    const publicationFailure = Object.assign(new Error('not ready'), {
      code: 'GENERATION_NOT_READY', retryable: false,
    })
    const { database, service } = fixture({
      publishGeneration: vi.fn().mockRejectedValue(publicationFailure),
    })
    database.prepare(`
      INSERT INTO cloud_sync_states (
        knowledge_base_id, mode, published_generation_id, updated_at
      ) VALUES (?, 'synced', ?, ?)
    `).run('kb_1', 'generation_old', 1)

    await expect(service.publishGeneration({
      requestId: 'publish_1', knowledgeBaseId: 'kb_1', generationId: 'generation_staging',
    })).rejects.toMatchObject({ code: 'GENERATION_NOT_READY' })
    expect(database.prepare(`
      SELECT published_generation_id AS publishedGenerationId
      FROM cloud_sync_states WHERE knowledge_base_id = ?
    `).get('kb_1')).toEqual({ publishedGenerationId: 'generation_old' })
  })

  it('keeps pause separate from verified conversion to local-only', async () => {
    const { database, remote, service } = fixture()
    service.pause('kb_1')
    expect(service.getState('kb_1').mode).toBe('paused')

    await expect(service.convertToLocalOnly('kb_1', async () => ({
      complete: true, expectedDigest: 'expected', actualDigest: 'different',
    }))).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
    expect(remote.deleteKnowledgeBase).not.toHaveBeenCalled()
    expect(service.getState('kb_1').mode).toBe('paused')

    await service.convertToLocalOnly('kb_1', async () => ({
      complete: true, expectedDigest: 'verified', actualDigest: 'verified',
    }))
    expect(remote.deleteKnowledgeBase).toHaveBeenCalledTimes(1)
    expect(service.getState('kb_1')).toMatchObject({ mode: 'local_only', publishedGenerationId: null })
    expect(database.prepare(
      'SELECT count(*) AS count FROM sync_cursors WHERE knowledge_base_id = ?',
    ).get('kb_1')).toEqual({ count: 0 })
  })

  it('rejects a held conversion download commit after cancellation and releases resources', async () => {
    const entered = deferred()
    const release = deferred()
    let localWrites = 0
    let cleanedUp = false
    const { database, remote, service } = fixture()
    const conversion = service.convertToLocalOnly('kb_1', async (...args: unknown[]) => {
      entered.resolve()
      await release.promise
      try {
        commitFromCallback(args, () => { localWrites += 1 })
        return { complete: true, expectedDigest: 'verified', actualDigest: 'verified' }
      } finally {
        cleanedUp = true
      }
    })
    await entered.promise
    service.cancel('kb_1')
    release.resolve()

    await expect(conversion).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(localWrites).toBe(0)
    expect(cleanedUp).toBe(true)
    expect(remote.deleteKnowledgeBase).not.toHaveBeenCalled()
    expect(database.prepare(
      'SELECT state FROM cloud_sync_conversions WHERE knowledge_base_id = ?',
    ).get('kb_1')).toEqual({ state: 'downloading' })
  })

  it('cancels queued work and drains durable orphan cleanup records idempotently', async () => {
    const cleanupOrphans = vi.fn().mockResolvedValue({ removed: 1 })
    const { database, remote, service } = fixture({ cleanupOrphans })
    service.enqueue({
      mutationId: 'mutation_cancel', knowledgeBaseId: 'kb_1', entityKind: 'document',
      entityId: 'document_1', operation: 'upsert', baseRevision: null, payload: {},
    })
    await service.cancelMutation('mutation_cancel')
    expect(remote.pushMutation).not.toHaveBeenCalled()
    await service.cancelRemoteJob('job_remote')
    expect(remote.cancelJob).toHaveBeenCalledWith({ requestId: 'lease_1', jobId: 'job_remote' })
    service.recordOrphan('kb_1', 'storage/object_1')
    await service.cleanupOrphans('kb_1')
    expect(cleanupOrphans).toHaveBeenCalledWith({
      requestId: expect.any(String), knowledgeBaseId: 'kb_1', storageReferences: ['storage/object_1'],
    })
    expect(database.prepare('SELECT count(*) AS count FROM cloud_sync_orphans').get())
      .toEqual({ count: 0 })
  })

  it('reuses a durable orphan-cleanup request after a lost response', async () => {
    const transient = Object.assign(new Error('lost'), {
      code: 'TRANSIENT_FAILURE', retryable: true,
    })
    const cleanupOrphans = vi.fn()
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce({ removed: 1 })
    const { database, service } = fixture({ cleanupOrphans })
    service.recordOrphan('kb_1', 'knowledge/1/kb_1/orphan_1')
    await expect(service.cleanupOrphans('kb_1')).rejects.toMatchObject({
      code: 'TRANSIENT_FAILURE',
    })
    await expect(service.cleanupOrphans('kb_1')).resolves.toBeUndefined()
    expect(cleanupOrphans.mock.calls[0]?.[0]).toEqual(cleanupOrphans.mock.calls[1]?.[0])
    expect(database.prepare('SELECT count(*) AS count FROM cloud_sync_orphans').get())
      .toEqual({ count: 0 })
  })

  it('keeps an in-flight local cancellation authoritative after a late remote result', async () => {
    let resolvePush!: (value: {
      mutationId: string; status: 'applied'; sequence: number; revision: string
    }) => void
    const pushMutation = vi.fn().mockReturnValue(new Promise(resolve => { resolvePush = resolve }))
    const { database, service } = fixture({ pushMutation })
    service.enqueue({
      mutationId: 'mutation_late', knowledgeBaseId: 'kb_1', entityKind: 'document',
      entityId: 'document_1', operation: 'upsert', baseRevision: null, payload: {},
    })
    const running = service.synchronize('kb_1')
    await vi.waitFor(() => expect(pushMutation).toHaveBeenCalledOnce())
    await service.cancelMutation('mutation_late')
    resolvePush({ mutationId: 'mutation_late', status: 'applied', sequence: 1, revision: 'r1' })

    await expect(running).resolves.toMatchObject({ processed: 0 })
    expect(database.prepare(
      'SELECT state FROM cloud_sync_mutations WHERE id = ?',
    ).get('mutation_late')).toEqual({ state: 'cancelled' })
  })

  it('cancels the base epoch after a remote mutation succeeds and never applies its pull', async () => {
    let resolvePush!: (value: {
      mutationId: string; status: 'applied'; sequence: number; revision: string
    }) => void
    const pushMutation = vi.fn().mockReturnValue(new Promise(resolve => { resolvePush = resolve }))
    const pullChanges = vi.fn().mockResolvedValue({
      kind: 'incremental', nextSequence: 1, hasMore: false,
      changes: [{ sequence: 1, entityKind: 'document', entityId: 'document_remote',
        operation: 'upsert', revision: 'r1', payload: { visible: true } }],
    })
    const { database, service, applyRemoteChange, replaceRemoteSnapshot } = fixture({
      pushMutation, pullChanges,
    })
    service.enqueue({
      mutationId: 'mutation_epoch_cancel', knowledgeBaseId: 'kb_1', entityKind: 'document',
      entityId: 'document_1', operation: 'upsert', baseRevision: null, payload: {},
    })

    const running = service.synchronize('kb_1')
    await vi.waitFor(() => expect(pushMutation).toHaveBeenCalledOnce())
    service.cancel('kb_1')
    resolvePush({ mutationId: 'mutation_epoch_cancel', status: 'applied', sequence: 1, revision: 'r1' })

    await expect(running).resolves.toEqual({ status: 'paused', processed: 0, conflicts: 0 })
    expect(pullChanges).not.toHaveBeenCalled()
    expect(applyRemoteChange).not.toHaveBeenCalled()
    expect(replaceRemoteSnapshot).not.toHaveBeenCalled()
    expect(database.prepare(
      'SELECT state FROM cloud_sync_mutations WHERE id = ?',
    ).get('mutation_epoch_cancel')).toEqual({ state: 'cancelled' })
  })

  it('invalidates every base epoch before a late enable result can write locally', async () => {
    let resolveBegin!: (value: {
      knowledgeBaseId: string; generationId: string; status: 'staging'
    }) => void
    const beginSync = vi.fn().mockReturnValue(new Promise(resolve => { resolveBegin = resolve }))
    const { service } = fixture({ beginSync })
    const enabling = service.enableSync({
      requestId: 'begin_owner', knowledgeBaseId: 'kb_1', name: 'Synced',
      revision: 'r1', generationId: 'g1',
    })
    await vi.waitFor(() => expect(beginSync).toHaveBeenCalledOnce())
    service.invalidateOwner()
    resolveBegin({ knowledgeBaseId: 'kb_1', generationId: 'g1', status: 'staging' })

    await expect(enabling).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(service.getState('kb_1').mode).toBe('paused')
  })

  it('pulls every incremental page without skipping the 1001st change', async () => {
    const firstPage = Array.from({ length: 1_000 }, (_, index) => ({
      sequence: index + 2, entityKind: 'document' as const, entityId: `document_${index + 2}`,
      operation: 'upsert' as const, revision: `r${index + 2}`, payload: {},
    }))
    const pullChanges = vi.fn()
      .mockResolvedValueOnce({
        kind: 'incremental', nextSequence: 1_001, hasMore: true, changes: firstPage,
      })
      .mockResolvedValueOnce({
        kind: 'incremental', nextSequence: 1_002, hasMore: false,
        changes: [{ sequence: 1_002, entityKind: 'document', entityId: 'document_1002',
          operation: 'upsert', revision: 'r1002', payload: {} }],
      })
    const { database, service, applyRemoteChange } = fixture({ pullChanges })
    database.prepare(
      'INSERT INTO sync_cursors (knowledge_base_id, sequence, updated_at) VALUES (?, ?, ?)',
    ).run('kb_1', 1, 1)

    await expect(service.synchronize('kb_1')).resolves.toMatchObject({ status: 'synced' })
    expect(pullChanges).toHaveBeenNthCalledWith(1, { knowledgeBaseId: 'kb_1', afterSequence: 1 })
    expect(pullChanges).toHaveBeenNthCalledWith(2, { knowledgeBaseId: 'kb_1', afterSequence: 1_001 })
    expect(applyRemoteChange).toHaveBeenCalledTimes(1_001)
    expect(database.prepare(
      'SELECT sequence FROM sync_cursors WHERE knowledge_base_id = ?',
    ).get('kb_1')).toEqual({ sequence: 1_002 })
  })

  it('fails closed when a remote page claims more without advancing', async () => {
    const pullChanges = vi.fn().mockResolvedValue({
      kind: 'incremental', nextSequence: 1, hasMore: true, changes: [],
    })
    const { database, service } = fixture({ pullChanges })
    database.prepare(
      'INSERT INTO sync_cursors (knowledge_base_id, sequence, updated_at) VALUES (?, ?, ?)',
    ).run('kb_1', 1, 1)

    await expect(service.synchronize('kb_1')).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(pullChanges).toHaveBeenCalledTimes(1)
  })

  it('terminally fails a third-attempt lease after it expires', async () => {
    const { database, remote, service } = fixture()
    service.enqueue({
      mutationId: 'mutation_expired', knowledgeBaseId: 'kb_1', entityKind: 'document',
      entityId: 'document_1', operation: 'upsert', baseRevision: null, payload: {},
    })
    database.prepare(`
      UPDATE cloud_sync_mutations SET state = 'leased', attempt = 3,
        lease_token = 'dead_worker', lease_expires_at = 999 WHERE id = 'mutation_expired'
    `).run()

    await expect(service.synchronize('kb_1')).resolves.toMatchObject({ status: 'failed' })
    expect(remote.pushMutation).not.toHaveBeenCalled()
    expect(database.prepare(`
      SELECT state, error_code AS errorCode FROM cloud_sync_mutations WHERE id = ?
    `).get('mutation_expired')).toEqual({ state: 'failed', errorCode: 'LEASE_EXPIRED' })
  })

  it('serializes synchronization per base and preserves queued mutation order', async () => {
    let releaseFirst!: () => void
    const firstPending = new Promise<void>(resolve => { releaseFirst = resolve })
    const seen: string[] = []
    const pushMutation = vi.fn().mockImplementation(async input => {
      seen.push(input.mutationId)
      if (input.mutationId === 'mutation_1') await firstPending
      return { mutationId: input.mutationId, status: 'applied', sequence: seen.length, revision: 'r' }
    })
    const { service } = fixture({ pushMutation })
    for (const mutationId of ['mutation_1', 'mutation_2']) service.enqueue({
      mutationId, knowledgeBaseId: 'kb_1', entityKind: 'document', entityId: mutationId,
      operation: 'upsert', baseRevision: null, payload: {},
    })

    const first = service.synchronize('kb_1')
    const second = service.synchronize('kb_1')
    await vi.waitFor(() => expect(pushMutation).toHaveBeenCalledTimes(1))
    releaseFirst()
    await Promise.all([first, second])
    expect(seen).toEqual(['mutation_1', 'mutation_2'])
    expect(pushMutation).toHaveBeenCalledTimes(2)
  })

  it('keeps pause authoritative after an awaited remote mutation returns', async () => {
    let resolvePush!: (value: {
      mutationId: string; status: 'applied'; sequence: number; revision: string
    }) => void
    const pushMutation = vi.fn().mockReturnValue(new Promise(resolve => { resolvePush = resolve }))
    const { database, remote, service } = fixture({ pushMutation })
    service.enqueue({
      mutationId: 'mutation_pause', knowledgeBaseId: 'kb_1', entityKind: 'document',
      entityId: 'document_1', operation: 'upsert', baseRevision: null, payload: {},
    })

    const running = service.synchronize('kb_1')
    await vi.waitFor(() => expect(pushMutation).toHaveBeenCalledOnce())
    service.pause('kb_1')
    resolvePush({ mutationId: 'mutation_pause', status: 'applied', sequence: 1, revision: 'r1' })

    await expect(running).resolves.toEqual({ status: 'paused', processed: 0, conflicts: 0 })
    expect(remote.pullChanges).not.toHaveBeenCalled()
    expect(service.getState('kb_1').mode).toBe('paused')
    expect(database.prepare(
      'SELECT state FROM cloud_sync_mutations WHERE id = ?',
    ).get('mutation_pause')).toEqual({ state: 'leased' })
  })

  it('persists conversion identity and waits for verified cloud purge before local-only', async () => {
    const transient = Object.assign(new Error('masked'), {
      code: 'TRANSIENT_FAILURE', retryable: true,
    })
    const getJob = vi.fn()
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce({ jobId: 'delete_1', state: 'running', errorCode: null })
      .mockResolvedValueOnce({ jobId: 'delete_1', state: 'completed', errorCode: null })
    const { database, remote, service } = fixture({ getJob })
    const verify = vi.fn().mockResolvedValue({
      complete: true, expectedDigest: 'verified', actualDigest: 'verified',
    })

    await expect(service.convertToLocalOnly('kb_1', verify))
      .rejects.toMatchObject({ code: 'TRANSIENT_FAILURE' })
    expect(service.getState('kb_1').mode).toBe('converting')
    expect(database.prepare(`
      SELECT operation_id AS operationId, request_id AS requestId, state,
        deletion_job_id AS deletionJobId FROM cloud_sync_conversions WHERE knowledge_base_id = ?
    `).get('kb_1')).toEqual({
      operationId: 'lease_1', requestId: 'request:lease_1',
      state: 'purge_accepted', deletionJobId: 'delete_1',
    })

    await expect(service.convertToLocalOnly('kb_1', verify)).resolves.toBeUndefined()
    expect(remote.deleteKnowledgeBase).toHaveBeenCalledTimes(1)
    expect(verify).toHaveBeenCalledTimes(1)
    expect(getJob).toHaveBeenCalledTimes(3)
    expect(service.getState('kb_1').mode).toBe('local_only')
  })

  it('reuses the durable deletion request after the remote accepted but its response was lost', async () => {
    const transient = Object.assign(new Error('response lost'), {
      code: 'TRANSIENT_FAILURE', retryable: true,
    })
    const deleteKnowledgeBase = vi.fn()
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce({ deletionJobId: 'delete_1' })
    const { remote, service } = fixture({ deleteKnowledgeBase })
    const verify = vi.fn().mockResolvedValue({
      complete: true, expectedDigest: 'verified', actualDigest: 'verified',
    })

    await expect(service.convertToLocalOnly('kb_1', verify))
      .rejects.toMatchObject({ code: 'TRANSIENT_FAILURE' })
    await expect(service.convertToLocalOnly('kb_1', verify)).resolves.toBeUndefined()
    expect(deleteKnowledgeBase).toHaveBeenCalledTimes(2)
    expect(deleteKnowledgeBase.mock.calls[0]?.[0].requestId)
      .toBe(deleteKnowledgeBase.mock.calls[1]?.[0].requestId)
    expect(verify).toHaveBeenCalledTimes(1)
    expect(remote.getJob).toHaveBeenCalledWith({ jobId: 'delete_1' })
  })

  it('does not advance a conversion after pause wins an awaited deletion', async () => {
    let resolveDelete!: (value: { deletionJobId: string }) => void
    const deleteKnowledgeBase = vi.fn().mockReturnValue(
      new Promise(resolve => { resolveDelete = resolve }),
    )
    const { database, remote, service } = fixture({ deleteKnowledgeBase })
    const converting = service.convertToLocalOnly('kb_1', async () => ({
      complete: true, expectedDigest: 'verified', actualDigest: 'verified',
    }))
    await vi.waitFor(() => expect(deleteKnowledgeBase).toHaveBeenCalledOnce())
    service.pause('kb_1')
    resolveDelete({ deletionJobId: 'delete_1' })

    await expect(converting).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(remote.getJob).not.toHaveBeenCalled()
    expect(database.prepare(
      'SELECT state, deletion_job_id AS deletionJobId FROM cloud_sync_conversions WHERE knowledge_base_id = ?',
    ).get('kb_1')).toEqual({ state: 'verified', deletionJobId: null })
    expect(service.getState('kb_1').mode).toBe('paused')

    service.resume('kb_1')
    await Promise.resolve()
    await expect(service.convertToLocalOnly('kb_1', async () => {
      throw new Error('verified content must not download twice')
    })).resolves.toBeUndefined()
    expect(deleteKnowledgeBase).toHaveBeenCalledTimes(2)
    expect(service.getState('kb_1').mode).toBe('local_only')
  })

  it('retains the conversion journal if restoring after an integrity failure cannot commit', async () => {
    const { database, service } = fixture()
    service.pause('kb_1')
    database.exec(`
      CREATE TRIGGER fail_conversion_restore
      BEFORE UPDATE ON cloud_sync_states
      WHEN OLD.mode = 'converting' AND NEW.mode = 'paused'
      BEGIN
        SELECT RAISE(ABORT, 'restore failed');
      END;
    `)

    await expect(service.convertToLocalOnly('kb_1', async () => ({
      complete: true, expectedDigest: 'expected', actualDigest: 'different',
    }))).rejects.toThrow('restore failed')
    expect(database.prepare(`
      SELECT state FROM cloud_sync_conversions WHERE knowledge_base_id = ?
    `).get('kb_1')).toEqual({ state: 'downloading' })
    expect(service.getState('kb_1').mode).toBe('converting')
  })
})
