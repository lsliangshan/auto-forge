import Database from 'better-sqlite3-multiple-ciphers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudBaseKnowledgeClient } from './cloudbase-knowledge-client.js'
import { configureKnowledgeConnection, initializeKnowledgeSchema } from './knowledge-schema.js'
import { KnowledgeSyncService, type CloudKnowledgeRemote } from './sync-service.js'

const databases: Database.Database[] = []

function fixture(
  overrides: Partial<CloudKnowledgeRemote> = {},
  online = true,
  dependencyOverrides: { id?: () => string } = {},
) {
  const database = new Database(':memory:')
  databases.push(database)
  configureKnowledgeConnection(database)
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
  const applyRemoteChange = vi.fn().mockResolvedValue(undefined)
  const replaceRemoteSnapshot = vi.fn().mockResolvedValue(undefined)
  const dependencies = {
    now: () => 1_000,
    id: dependencyOverrides.id ?? (() => 'lease_1'),
    isOnline: () => online,
    applyRemoteChange,
    replaceRemoteSnapshot,
  }
  const service = new KnowledgeSyncService(database, remote, dependencies)
  return { database, remote, service, dependencies, applyRemoteChange, replaceRemoteSnapshot }
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

describe('KnowledgeSyncService', () => {
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

  it('performs a full resync for an expired cursor and advances only after applying changes', async () => {
    const fullResync = vi.fn().mockResolvedValue({
      kind: 'snapshot',
      nextSequence: 42,
      changes: [{ sequence: 42, entityKind: 'document', entityId: 'document_remote', operation: 'upsert', revision: 'r42', payload: {} }],
    })
    const { database, service, applyRemoteChange, replaceRemoteSnapshot } = fixture({
      pullChanges: vi.fn().mockResolvedValue({ kind: 'cursor_stale' }), fullResync,
    })

    await expect(service.synchronize('kb_1')).resolves.toMatchObject({ status: 'synced' })
    expect(fullResync).toHaveBeenCalledWith({ knowledgeBaseId: 'kb_1' })
    expect(replaceRemoteSnapshot).toHaveBeenCalledWith([
      { sequence: 42, entityKind: 'document', entityId: 'document_remote', operation: 'upsert', revision: 'r42', payload: {} },
    ])
    expect(applyRemoteChange).not.toHaveBeenCalled()
    expect(database.prepare(
      'SELECT sequence FROM sync_cursors WHERE knowledge_base_id = ?',
    ).get('kb_1')).toEqual({ sequence: 42 })
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

  it('uses an accepted private durable cleanup identity for a long storage reference', async () => {
    const storageReference = `private/storage/${'s'.repeat(496)}`
    const otherStorageReference = `private/storage/${'t'.repeat(496)}`
    const callFunction = vi.fn()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({ result: { ok: true, data: { removed: 1 } } })
    const client = new CloudBaseKnowledgeClient({ callFunction })
    const cleanupOrphans = vi.fn(input => client.cleanupOrphans(input))
    let generated = 0
    const { database, remote, service, dependencies } = fixture({ cleanupOrphans }, true, {
      id: () => `generated_${generated += 1}`,
    })
    service.recordOrphan('kb_1', storageReference)
    const persisted = database.prepare(`
      SELECT request_id AS requestId FROM cloud_sync_orphans WHERE storage_reference = ?
    `).get(storageReference) as { requestId: string }

    expect(storageReference).toHaveLength(512)
    expect(persisted.requestId).toMatch(/^cleanup:v1:[a-f0-9]{64}$/)
    expect(persisted.requestId.length).toBeLessThanOrEqual(128)
    expect(persisted.requestId).not.toContain('private/storage')

    const independent = fixture({}, true, { id: () => 'different_generated_id' })
    independent.service.recordOrphan('kb_1', storageReference)
    independent.service.recordOrphan('kb_1', otherStorageReference)
    const independentRows = independent.database.prepare(`
      SELECT storage_reference AS storageReference, request_id AS requestId
      FROM cloud_sync_orphans ORDER BY storage_reference
    `).all() as Array<{ storageReference: string; requestId: string }>
    expect(independentRows[0]).toEqual({ storageReference, requestId: persisted.requestId })
    expect(independentRows[1]?.storageReference).toBe(otherStorageReference)
    expect(independentRows[1]?.requestId).not.toBe(persisted.requestId)

    await expect(service.cleanupOrphans('kb_1')).rejects.toMatchObject({
      code: 'TRANSIENT_FAILURE',
    })
    const restarted = new KnowledgeSyncService(database, remote, dependencies)
    await expect(restarted.cleanupOrphans('kb_1')).resolves.toBeUndefined()
    expect(cleanupOrphans).toHaveBeenCalledTimes(2)
    expect(cleanupOrphans.mock.calls.map(([input]) => input.requestId))
      .toEqual([persisted.requestId, persisted.requestId])
    const sentCleanup = {
      name: 'autoforge-knowledge',
      data: {
        action: 'cleanupOrphans', requestId: persisted.requestId, knowledgeBaseId: 'kb_1',
        storageReferences: [storageReference],
      },
    }
    expect(callFunction).toHaveBeenNthCalledWith(1, sentCleanup)
    expect(callFunction).toHaveBeenNthCalledWith(2, sentCleanup)
    expect(database.prepare('SELECT count(*) AS count FROM cloud_sync_orphans').get())
      .toEqual({ count: 0 })
  })

  it('rejects every late remote result from a synchronization invalidated by cancellation', async () => {
    let resolvePush!: (value: {
      mutationId: string; status: 'applied'; sequence: number; revision: string
    }) => void
    const pushMutation = vi.fn().mockReturnValue(new Promise(resolve => { resolvePush = resolve }))
    const pullChanges = vi.fn().mockResolvedValue({
      kind: 'incremental', nextSequence: 1, hasMore: false,
      changes: [{
        sequence: 1, entityKind: 'document', entityId: 'document_1', operation: 'upsert',
        revision: 'r1', payload: { versionId: 'remote_after_cancel' },
      }],
    })
    const { database, service, applyRemoteChange } = fixture({ pushMutation, pullChanges })
    service.enqueue({
      mutationId: 'mutation_late', knowledgeBaseId: 'kb_1', entityKind: 'document',
      entityId: 'document_1', operation: 'upsert', baseRevision: null, payload: {},
    })
    const running = service.synchronize('kb_1')
    await vi.waitFor(() => expect(pushMutation).toHaveBeenCalledOnce())
    await service.cancelMutation('mutation_late')
    resolvePush({ mutationId: 'mutation_late', status: 'applied', sequence: 1, revision: 'r1' })

    await expect(running).resolves.toMatchObject({ processed: 0, conflicts: 0 })
    expect(pullChanges).not.toHaveBeenCalled()
    expect(applyRemoteChange).not.toHaveBeenCalled()
    expect(database.prepare(
      'SELECT state FROM cloud_sync_mutations WHERE id = ?',
    ).get('mutation_late')).toEqual({ state: 'cancelled' })
    expect(database.prepare(
      'SELECT sequence FROM sync_cursors WHERE knowledge_base_id = ?',
    ).get('kb_1')).toBeUndefined()
  })

  it('pulls every incremental page without skipping the 1001st change', async () => {
    const firstPage = Array.from({ length: 1_000 }, (_, index) => ({
      sequence: index + 1, entityKind: 'document' as const, entityId: `document_${index + 1}`,
      operation: 'upsert' as const, revision: `r${index + 1}`, payload: {},
    }))
    const pullChanges = vi.fn()
      .mockResolvedValueOnce({
        kind: 'incremental', nextSequence: 1_000, hasMore: true, changes: firstPage,
      })
      .mockResolvedValueOnce({
        kind: 'incremental', nextSequence: 1_001, hasMore: false,
        changes: [{ sequence: 1_001, entityKind: 'document', entityId: 'document_1001',
          operation: 'upsert', revision: 'r1001', payload: {} }],
      })
    const { database, service, applyRemoteChange } = fixture({ pullChanges })

    await expect(service.synchronize('kb_1')).resolves.toMatchObject({ status: 'synced' })
    expect(pullChanges).toHaveBeenNthCalledWith(1, { knowledgeBaseId: 'kb_1', afterSequence: 0 })
    expect(pullChanges).toHaveBeenNthCalledWith(2, { knowledgeBaseId: 'kb_1', afterSequence: 1_000 })
    expect(applyRemoteChange).toHaveBeenCalledTimes(1_001)
    expect(database.prepare(
      'SELECT sequence FROM sync_cursors WHERE knowledge_base_id = ?',
    ).get('kb_1')).toEqual({ sequence: 1_001 })
  })

  it('fails closed when a remote page claims more without advancing', async () => {
    const pullChanges = vi.fn().mockResolvedValue({
      kind: 'incremental', nextSequence: 0, hasMore: true, changes: [],
    })
    const { service } = fixture({ pullChanges })

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

  it('does not report synced when resumed before an invalidated lease expires', async () => {
    let resolvePush!: (value: {
      mutationId: string; status: 'applied'; sequence: number; revision: string
    }) => void
    const pushMutation = vi.fn().mockReturnValue(new Promise(resolve => { resolvePush = resolve }))
    const { database, remote, service } = fixture({ pushMutation })
    service.enqueue({
      mutationId: 'mutation_resume', knowledgeBaseId: 'kb_1', entityKind: 'document',
      entityId: 'document_1', operation: 'upsert', baseRevision: null, payload: {},
    })

    const interrupted = service.synchronize('kb_1')
    await vi.waitFor(() => expect(pushMutation).toHaveBeenCalledOnce())
    service.pause('kb_1')
    resolvePush({ mutationId: 'mutation_resume', status: 'applied', sequence: 1, revision: 'r1' })
    await expect(interrupted).resolves.toEqual({ status: 'paused', processed: 0, conflicts: 0 })

    service.resume('kb_1')
    await expect(service.synchronize('kb_1')).resolves.toEqual({
      status: 'paused', processed: 0, conflicts: 0,
    })
    expect(service.getState('kb_1').mode).toBe('syncing')
    expect(remote.pullChanges).not.toHaveBeenCalled()
    expect(database.prepare(
      'SELECT state, attempt FROM cloud_sync_mutations WHERE id = ?',
    ).get('mutation_resume')).toEqual({ state: 'leased', attempt: 1 })
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
      operationId: 'lease_1', requestId: 'lease_1', state: 'purge_accepted', deletionJobId: 'delete_1',
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
