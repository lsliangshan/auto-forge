import Database from 'better-sqlite3-multiple-ciphers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureKnowledgeConnection, initializeKnowledgeSchema } from './knowledge-schema.js'
import { KnowledgeSyncService, type CloudKnowledgeRemote } from './sync-service.js'

const databases: Database.Database[] = []

function fixture(overrides: Partial<CloudKnowledgeRemote> = {}, online = true) {
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
    pullChanges: vi.fn().mockResolvedValue({ kind: 'incremental', nextSequence: 0, changes: [] }),
    fullResync: vi.fn().mockResolvedValue({ nextSequence: 0, changes: [] }),
    publishGeneration: vi.fn().mockResolvedValue({
      generationId: 'generation_new', previousGenerationId: 'generation_old', sequence: 2,
    }),
    deleteKnowledgeBase: vi.fn().mockResolvedValue({ deletionJobId: 'delete_1' }),
    cancelJob: vi.fn().mockResolvedValue(undefined),
    cleanupOrphans: vi.fn().mockResolvedValue({ removed: 0 }),
    ...overrides,
  }
  const applyRemoteChange = vi.fn().mockResolvedValue(undefined)
  const replaceRemoteSnapshot = vi.fn().mockResolvedValue(undefined)
  const service = new KnowledgeSyncService(database, remote, {
    now: () => 1_000,
    id: () => 'lease_1',
    isOnline: () => online,
    applyRemoteChange,
    replaceRemoteSnapshot,
  })
  return { database, remote, service, applyRemoteChange, replaceRemoteSnapshot }
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

  it('performs a full resync for an expired cursor and advances only after applying changes', async () => {
    const fullResync = vi.fn().mockResolvedValue({
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
      pullChanges: vi.fn().mockResolvedValue({ kind: 'incremental', nextSequence: 4, changes: [] }),
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
      SELECT entity_id AS entityId, local_version AS localVersion,
        remote_version AS remoteVersion, status
      FROM conflicts ORDER BY entity_id
    `).all()).toEqual([
      { entityId: 'document_1', localVersion: 'local_2', remoteVersion: 'remote_2', status: 'open' },
      { entityId: 'document_2', localVersion: 'local_3', remoteVersion: 'remote_3', status: 'open' },
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
      Object.assign(new Error('masked'), { code: 'FORBIDDEN', retryable: false }),
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
})
