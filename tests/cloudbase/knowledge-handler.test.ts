import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  createEmbeddingGenerationWorker,
  createKnowledgeHandler as createProductionKnowledgeHandler,
  createPostgresRpcClient,
  createPostgresStorageClient,
  createTokenHubClient,
} from '../../cloudbase/knowledge/function/knowledge-handler.js'

const context = { auth: { uid: '2089908515857502208' } }
const futureExpiry = new Date(Date.now() + 15 * 60_000).toISOString()
const currentCloudSyncConsent = {
  state: 'accepted', revision: 1, documentVersion: 'cloud-sync-2026-08',
}

function createKnowledgeHandler(
  options: Parameters<typeof createProductionKnowledgeHandler>[0],
) {
  const rpc = options.rpc
  return createProductionKnowledgeHandler({
    ...options,
    rpc: async (name: string, parameters: Record<string, unknown>) => (
      name === 'autoforge_knowledge_assert_cloud_sync_consent'
        ? currentCloudSyncConsent
        : rpc(name, parameters)
    ),
  })
}

function expectedUploadObjectId(requestId = 'upload_1', versionId = 'version_1') {
  return `object_${createHash('md5').update(`${requestId}:${versionId}`).digest('hex')}`
}

function expectedStorageReference(objectId = expectedUploadObjectId()) {
  return `knowledge/${context.auth.uid}/kb_1/${objectId}`
}

function streamedResponse(value: unknown, status = 200) {
  const bytes = new TextEncoder().encode(value === undefined ? '' : JSON.stringify(value))
  let read = false
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: vi.fn().mockReturnValue(String(bytes.byteLength)) },
    body: { getReader: () => ({
      read: vi.fn().mockImplementation(async () => {
        if (read) return { done: true, value: undefined }
        read = true
        return { done: false, value: bytes }
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn(),
    }) },
  }
}

describe('CloudBase knowledge function', () => {
  it('authorizes ordinary RPCs only from authoritative current cloud-sync consent', async () => {
    let consent: 'accepted' | 'revoked' = 'revoked'
    let revision = 2
    const rpc = vi.fn(async (name: string) => {
      if (name === 'autoforge_knowledge_assert_cloud_sync_consent') {
        if (consent === 'revoked') throw { code: 'FORBIDDEN' }
        return {
          state: 'accepted', revision, documentVersion: 'cloud-sync-2026-08',
        }
      }
      if (name === 'autoforge_knowledge_begin_sync') return {
        knowledgeBaseId: 'kb_1', generationId: 'generation_1', status: 'staging',
      }
      throw new Error(`unexpected RPC ${name}`)
    })
    const handler = createProductionKnowledgeHandler({ rpc })
    const request = {
      action: 'beginSync', requestId: 'sync_1', knowledgeBaseId: 'kb_1',
      name: 'Contracts', revision: 'revision_1', generationId: 'generation_1',
    }

    await expect(handler(request, context)).resolves.toEqual({
      ok: false, error: { code: 'FORBIDDEN' },
    })
    expect(rpc).toHaveBeenCalledTimes(1)

    consent = 'accepted'
    revision = 3
    await expect(handler(request, context)).resolves.toMatchObject({ ok: true })
    expect(rpc).toHaveBeenNthCalledWith(2, 'autoforge_knowledge_assert_cloud_sync_consent', {
      p_caller_user_id: context.auth.uid,
    })
    expect(rpc).toHaveBeenNthCalledWith(3, 'autoforge_knowledge_begin_sync', {
      p_caller_user_id: context.auth.uid, p_request_id: 'sync_1',
      p_knowledge_base_id: 'kb_1', p_name: 'Contracts', p_revision: 'revision_1',
      p_generation_id: 'generation_1',
    })

    consent = 'revoked'
    revision = 4
    await expect(handler(request, context)).resolves.toEqual({
      ok: false, error: { code: 'FORBIDDEN' },
    })
    expect(rpc).toHaveBeenCalledTimes(4)
  })

  it('rejects caller-supplied cloud-sync authorization before the server gate', async () => {
    const rpc = vi.fn()
    const handler = createProductionKnowledgeHandler({ rpc })

    await expect(handler({
      action: 'beginSync', requestId: 'sync_1', knowledgeBaseId: 'kb_1',
      name: 'Contracts', revision: 'revision_1', generationId: 'generation_1',
      cloudSyncConsent: true,
    }, context)).resolves.toEqual({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('fails every ordinary knowledge action closed while cloud-sync is revoked', async () => {
    const rpc = vi.fn(async (name: string) => {
      if (name === 'autoforge_knowledge_assert_cloud_sync_consent') {
        throw { code: 'FORBIDDEN' }
      }
      return {}
    })
    const storage = {
      createUploadAuthorization: vi.fn(), statObject: vi.fn(), deleteObjects: vi.fn(),
    }
    const handler = createProductionKnowledgeHandler({ rpc, storage })
    const sha256 = 'a'.repeat(64)
    const requests = [
      { action: 'beginSync', requestId: 'r1', knowledgeBaseId: 'kb', name: 'n', revision: 'v', generationId: 'g' },
      { action: 'beginGeneration', requestId: 'r2', knowledgeBaseId: 'kb', name: 'n', revision: 'v', generationId: 'g' },
      { action: 'authorizeUpload', requestId: 'r3', knowledgeBaseId: 'kb', documentId: 'd', versionId: 'v', byteSize: 1, sha256, mimeType: 'text/plain' },
      { action: 'completeUpload', uploadTicket: 'ticket' },
      { action: 'pushMutation', mutationId: 'm', knowledgeBaseId: 'kb', entityKind: 'document', entityId: 'd', operation: 'upsert', baseRevision: null, payload: {} },
      { action: 'pullChanges', knowledgeBaseId: 'kb', afterSequence: 0, limit: 1, maxBytes: 65_536 },
      { action: 'fullResync', knowledgeBaseId: 'kb', snapshotId: null, afterOrdinal: 0, limit: 1, maxBytes: 65_536 },
      { action: 'listKnowledgeBases', snapshotId: null, afterOrdinal: 0, limit: 1, maxBytes: 65_536 },
      { action: 'publishGeneration', requestId: 'r4', knowledgeBaseId: 'kb', generationId: 'g', expectedPublishedGenerationId: null },
      { action: 'getJob', jobId: 'job' },
      { action: 'setEmbeddingConsent', requestId: 'r5', enabled: true },
      { action: 'searchKnowledge', requestId: 'r6', query: '合同', knowledgeBaseIds: ['kb'], limit: 1 },
      { action: 'beginEmbeddingDriftProbe', requestId: 'r7', knowledgeBaseId: 'kb', generationId: 'g2', expectedPublishedGenerationId: 'g1' },
    ]

    for (const request of requests) {
      await expect(handler(request, context)).resolves.toEqual({
        ok: false, error: { code: 'FORBIDDEN' },
      })
    }
    expect(rpc).toHaveBeenCalledTimes(requests.length)
    expect(rpc.mock.calls.every(([name]) => (
      name === 'autoforge_knowledge_assert_cloud_sync_consent'
    ))).toBe(true)
    expect(storage.createUploadAuthorization).not.toHaveBeenCalled()
    expect(storage.statObject).not.toHaveBeenCalled()
  })

  it('uses the CloudBase CommonJS index.main deployment contract', async () => {
    const packageJson = JSON.parse(await readFile(
      new URL('../../cloudbase/knowledge/function/package.json', import.meta.url), 'utf8',
    ))
    const entry = await readFile(
      new URL('../../cloudbase/knowledge/function/index.js', import.meta.url), 'utf8',
    )
    expect(packageJson.type).toBe('commonjs')
    expect(entry).toContain('exports.main = main')
    expect(entry).not.toMatch(/\bexport\s+(?:default|async|function|const|let|var|class)/)
  })

  it('derives ownership only from trusted context', async () => {
    const rpc = vi.fn().mockResolvedValue({
      mutationId: 'mutation_1', status: 'applied', sequence: 1, revision: 'r1',
    })
    const handler = createKnowledgeHandler({ rpc })
    await expect(handler({
      action: 'pushMutation', mutationId: 'mutation_1', knowledgeBaseId: 'kb_1',
      entityKind: 'document', entityId: 'document_1', operation: 'upsert',
      baseRevision: null, payload: {},
    }, context)).resolves.toMatchObject({ ok: true })

    expect(rpc).toHaveBeenCalledWith('autoforge_knowledge_push_mutation', {
      p_caller_user_id: '2089908515857502208', p_mutation_id: 'mutation_1',
      p_knowledge_base_id: 'kb_1', p_entity_kind: 'document', p_entity_id: 'document_1',
      p_operation: 'upsert', p_base_revision: null, p_payload: {},
    })
    await expect(handler({
      action: 'pushMutation', mutationId: 'mutation_2', knowledgeBaseId: 'kb_1',
      entityKind: 'document', entityId: 'document_1', operation: 'upsert',
      baseRevision: null, payload: {}, ownerId: 'attacker',
    }, context)).resolves.toEqual({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('routes additive generation staging through the authenticated RPC boundary', async () => {
    const rpc = vi.fn().mockResolvedValue({
      knowledgeBaseId: 'kb_1', generationId: 'generation_2', status: 'staging',
    })
    const handler = createKnowledgeHandler({ rpc })

    await expect(handler({
      action: 'beginGeneration', requestId: 'begin_2', knowledgeBaseId: 'kb_1',
      name: 'Contracts', revision: 'revision_2', generationId: 'generation_2',
    }, context)).resolves.toMatchObject({ ok: true, data: { status: 'staging' } })
    expect(rpc).toHaveBeenCalledWith('autoforge_knowledge_begin_generation', {
      p_caller_user_id: context.auth.uid, p_request_id: 'begin_2',
      p_knowledge_base_id: 'kb_1', p_name: 'Contracts', p_revision: 'revision_2',
      p_generation_id: 'generation_2',
    })
  })

  it('rejects missing identity and invalid or oversized business input', async () => {
    const rpc = vi.fn()
    const handler = createKnowledgeHandler({ rpc })
    await expect(handler({ action: 'getEntitlement' }, {})).resolves.toEqual({
      ok: false, error: { code: 'AUTH_REQUIRED' },
    })
    await expect(handler({
      action: 'pullChanges', knowledgeBaseId: 'kb_1', afterSequence: -1, limit: 1001,
    }, context)).resolves.toEqual({ ok: false, error: { code: 'INVALID_INPUT' } })
    await expect(handler({
      action: 'authorizeUpload', requestId: 'upload_1', knowledgeBaseId: 'kb_1',
      documentId: 'document_1', versionId: 'version_1', byteSize: 0,
      sha256: 'bad', mimeType: 'text/plain',
    }, context)).resolves.toEqual({ ok: false, error: { code: 'INVALID_INPUT' } })
    await expect(handler({ action: '__proto__' }, context)).resolves.toEqual({
      ok: false, error: { code: 'INVALID_INPUT' },
    })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('rejects non-canonical base IDs before begin or upload SQL side effects', async () => {
    const rpc = vi.fn()
    const storage = {
      createUploadAuthorization: vi.fn(), statObject: vi.fn(), deleteObjects: vi.fn(),
    }
    const handler = createKnowledgeHandler({ rpc, storage })
    await expect(handler({
      action: 'beginSync', requestId: 'sync_1', knowledgeBaseId: '../kb',
      name: 'Contracts', revision: 'revision_1', generationId: 'generation_1',
    }, context)).resolves.toEqual({ ok: false, error: { code: 'INVALID_INPUT' } })
    await expect(handler({
      action: 'authorizeUpload', requestId: 'upload_1', knowledgeBaseId: '../kb',
      documentId: 'document_1', versionId: 'version_1', byteSize: 42,
      sha256: 'a'.repeat(64), mimeType: 'text/plain',
    }, context)).resolves.toEqual({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(rpc).not.toHaveBeenCalled()
    expect(storage.createUploadAuthorization).not.toHaveBeenCalled()
  })

  it('forwards bounded pull budgets and snapshot page identity exactly', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        kind: 'incremental', nextSequence: 5, hasMore: false, changes: [],
      })
      .mockResolvedValueOnce({
        kind: 'snapshot_page', snapshotId: 'snapshot_1', snapshotSequence: 5,
        nextOrdinal: 0, hasMore: false, changes: [],
      })
    const handler = createKnowledgeHandler({ rpc })

    await expect(handler({
      action: 'pullChanges', knowledgeBaseId: 'kb_1', afterSequence: 5,
      limit: 512, maxBytes: 786_432,
    }, context)).resolves.toMatchObject({ ok: true })
    await expect(handler({
      action: 'fullResync', knowledgeBaseId: 'kb_1', snapshotId: null,
      afterOrdinal: 0, limit: 512, maxBytes: 786_432,
    }, context)).resolves.toMatchObject({ ok: true })
    expect(rpc).toHaveBeenNthCalledWith(1, 'autoforge_knowledge_pull_changes', {
      p_caller_user_id: '2089908515857502208', p_knowledge_base_id: 'kb_1',
      p_after_sequence: 5, p_limit: 512, p_max_bytes: 786_432,
    })
    expect(rpc).toHaveBeenNthCalledWith(2, 'autoforge_knowledge_full_resync', {
      p_caller_user_id: '2089908515857502208', p_knowledge_base_id: 'kb_1',
      p_snapshot_id: null, p_after_ordinal: 0, p_limit: 512, p_max_bytes: 786_432,
    })
  })

  it('lists the trusted owner catalog through a bounded stable snapshot page', async () => {
    const rpc = vi.fn().mockResolvedValue({
      kind: 'catalog_page', snapshotId: 'catalog_1', totalCount: 2,
      nextOrdinal: 1, hasMore: true, knowledgeBaseIds: ['kb_1'],
    })
    const handler = createKnowledgeHandler({ rpc })

    await expect(handler({
      action: 'listKnowledgeBases', snapshotId: null, afterOrdinal: 0,
      limit: 512, maxBytes: 786_432,
    }, context)).resolves.toEqual({ ok: true, data: {
      kind: 'catalog_page', snapshotId: 'catalog_1', totalCount: 2,
      nextOrdinal: 1, hasMore: true, knowledgeBaseIds: ['kb_1'],
    } })
    expect(rpc).toHaveBeenCalledWith('autoforge_knowledge_list_bases', {
      p_caller_user_id: context.auth.uid, p_snapshot_id: null,
      p_after_ordinal: 0, p_limit: 512, p_max_bytes: 786_432,
    })
    await expect(handler({
      action: 'listKnowledgeBases', snapshotId: null, afterOrdinal: 0,
      limit: 512, maxBytes: 786_432, ownerId: 'attacker',
    }, context)).resolves.toEqual({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(rpc).toHaveBeenCalledOnce()
  })

  it('rejects malformed, duplicate, non-progressing, and mismatched catalog pages', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        kind: 'catalog_page', snapshotId: 'catalog_1', totalCount: 2,
        nextOrdinal: 2, hasMore: false, knowledgeBaseIds: ['kb_1', 'kb_1'],
      })
      .mockResolvedValueOnce({
        kind: 'catalog_page', snapshotId: 'catalog_1', totalCount: 1,
        nextOrdinal: 0, hasMore: true, knowledgeBaseIds: ['kb_1'],
      })
      .mockResolvedValueOnce({
        kind: 'catalog_page', snapshotId: 'catalog_1', totalCount: 2,
        nextOrdinal: 1, hasMore: false, knowledgeBaseIds: ['kb_1'],
      })
      .mockResolvedValueOnce({
        kind: 'catalog_page', snapshotId: 'catalog_other', totalCount: 1,
        nextOrdinal: 1, hasMore: false, knowledgeBaseIds: ['kb_1'],
      })
    const handler = createKnowledgeHandler({ rpc })
    const first = {
      action: 'listKnowledgeBases', snapshotId: null, afterOrdinal: 0,
      limit: 512, maxBytes: 786_432,
    }
    await expect(handler(first, context)).resolves.toEqual({
      ok: false, error: { code: 'INTERNAL_ERROR' },
    })
    await expect(handler(first, context)).resolves.toEqual({
      ok: false, error: { code: 'INTERNAL_ERROR' },
    })
    await expect(handler(first, context)).resolves.toEqual({
      ok: false, error: { code: 'INTERNAL_ERROR' },
    })
    await expect(handler({ ...first, snapshotId: 'catalog_1' }, context)).resolves.toEqual({
      ok: false, error: { code: 'INTERNAL_ERROR' },
    })
  })

  it('rejects extra keys on every public action before RPC or Storage', async () => {
    const rpc = vi.fn()
    const storage = {
      createUploadAuthorization: vi.fn(), statObject: vi.fn(), deleteObjects: vi.fn(),
    }
    const handler = createKnowledgeHandler({ rpc, storage })
    const sha256 = 'a'.repeat(64)
    const events = [
      { action: 'beginSync', requestId: 'r', knowledgeBaseId: 'kb', name: 'n', revision: 'v', generationId: 'g' },
      { action: 'beginGeneration', requestId: 'r2', knowledgeBaseId: 'kb', name: 'n', revision: 'v2', generationId: 'g2' },
      { action: 'authorizeUpload', requestId: 'r', knowledgeBaseId: 'kb', documentId: 'd', versionId: 'v', byteSize: 1, sha256, mimeType: 'text/plain' },
      { action: 'completeUpload', uploadTicket: 't' },
      { action: 'pushMutation', mutationId: 'm', knowledgeBaseId: 'kb', entityKind: 'document', entityId: 'd', operation: 'upsert', baseRevision: null, payload: {} },
      { action: 'pullChanges', knowledgeBaseId: 'kb', afterSequence: 0, limit: 1, maxBytes: 65536 },
      { action: 'fullResync', knowledgeBaseId: 'kb', snapshotId: null, afterOrdinal: 0, limit: 1, maxBytes: 65536 },
      { action: 'listKnowledgeBases', snapshotId: null, afterOrdinal: 0, limit: 1, maxBytes: 65536 },
      { action: 'publishGeneration', requestId: 'r', knowledgeBaseId: 'kb', generationId: 'g', expectedPublishedGenerationId: null },
      { action: 'deleteKnowledgeBase', requestId: 'r', knowledgeBaseId: 'kb', expectedPublishedGenerationId: null },
      { action: 'cancelJob', requestId: 'r', jobId: 'j' },
      { action: 'cleanupOrphans', requestId: 'r', knowledgeBaseId: 'kb', storageReferences: ['knowledge/1/kb/o'] },
      { action: 'getJob', jobId: 'j' },
      { action: 'getEntitlement' },
      { action: 'getEmbeddingConsent' },
      { action: 'setEmbeddingConsent', requestId: 'r', enabled: true },
      { action: 'searchKnowledge', requestId: 'search_1', query: '合同条款',
        knowledgeBaseIds: ['kb'], limit: 8 },
      { action: 'beginEmbeddingDriftProbe', requestId: 'r', knowledgeBaseId: 'kb',
        generationId: 'g2', expectedPublishedGenerationId: 'g1' },
    ]
    for (const event of events) {
      await expect(handler({ ...event, extra: true }, context)).resolves.toEqual({
        ok: false, error: { code: 'INVALID_INPUT' },
      })
    }
    expect(rpc).not.toHaveBeenCalled()
    expect(storage.createUploadAuthorization).not.toHaveBeenCalled()
    expect(storage.statObject).not.toHaveBeenCalled()
    expect(storage.deleteObjects).not.toHaveBeenCalled()
  })

  it('masks server details and keeps service credentials inside the function RPC client', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(streamedResponse({ tier: 'member' }))
    const rpc = createPostgresRpcClient({
      baseUrl: 'https://autoforge.example/v1/rdb/rest', serviceKey: 'server-only', fetchImpl,
    })
    await rpc('autoforge_knowledge_get_entitlement', { p_caller_user_id: '1' })
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://autoforge.example/v1/rdb/rest/rpc/autoforge_knowledge_get_entitlement',
      expect.objectContaining({ headers: {
        authorization: 'Bearer server-only', 'content-type': 'application/json',
      } }),
    )

    const handler = createKnowledgeHandler({
      rpc: vi.fn().mockRejectedValue(new Error('database password and signed URL')),
    })
    await expect(handler({ action: 'getEntitlement' }, context)).resolves.toEqual({
      ok: false, error: { code: 'INTERNAL_ERROR' },
    })
  })

  it('cancels a streamed RPC response before decoding beyond one MiB', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    const releaseLock = vi.fn()
    const read = vi.fn().mockResolvedValueOnce({
      done: false, value: new Uint8Array(1_048_577),
    })
    const rpc = createPostgresRpcClient({
      baseUrl: 'https://autoforge.example/v1/rdb/rest',
      serviceKey: 'server-only',
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true, status: 200, headers: { get: vi.fn().mockReturnValue(null) },
        body: { getReader: () => ({ read, cancel, releaseLock }) },
      }),
    })
    await expect(rpc('autoforge_knowledge_get_entitlement', {
      p_caller_user_id: '1',
    })).rejects.toEqual({ code: 'INTERNAL_ERROR' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(releaseLock).toHaveBeenCalledOnce()
  })

  it('fails closed before parsing an unbounded non-streaming upstream response', async () => {
    const parse = vi.fn().mockResolvedValue({ tier: 'member' })
    const rpc = createPostgresRpcClient({
      baseUrl: 'https://autoforge.example/v1/rdb/rest',
      serviceKey: 'server-only',
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true, status: 200, headers: { get: vi.fn().mockReturnValue(null) }, json: parse,
      }),
    })

    await expect(rpc('autoforge_knowledge_get_entitlement', {
      p_caller_user_id: '1',
    })).rejects.toEqual({ code: 'INTERNAL_ERROR' })
    expect(parse).not.toHaveBeenCalled()
  })

  it('aborts never-settling PostgreSQL RPC and Storage calls at their deadline', async () => {
    vi.useFakeTimers()
    try {
      const signals: AbortSignal[] = []
      const fetchImpl = vi.fn((_url: string, init: { signal: AbortSignal }) => {
        signals.push(init.signal)
        return new Promise<never>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      })
      const rpc = createPostgresRpcClient({
        baseUrl: 'https://autoforge.example/v1/rdb/rest', serviceKey: 'server-only',
        fetchImpl, timeoutMs: 50,
      })
      const storage = createPostgresStorageClient({
        baseUrl: 'https://pg-storage.example/v1/storage', serviceKey: 'server-only',
        uploadUrlPrefix: 'https://pg-storage.example/upload/', fetchImpl, timeoutMs: 50,
      })

      const rpcRequest = rpc('autoforge_knowledge_get_entitlement', { p_caller_user_id: '1' })
      const storageRequest = storage.statObject('knowledge/1/kb_1/object_1')
      const rpcRejected = expect(rpcRequest).rejects.toEqual({ code: 'TRANSIENT_FAILURE' })
      const storageRejected = expect(storageRequest).rejects.toEqual({ code: 'TRANSIENT_FAILURE' })
      await vi.advanceTimersByTimeAsync(50)

      await rpcRejected
      await storageRejected
      expect(signals).toHaveLength(2)
      expect(signals.every(signal => signal.aborted)).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drains the underlying fetch abort acknowledgement before returning', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      let drained = false
      const rpc = createPostgresRpcClient({
        baseUrl: 'https://autoforge.example/v1/rdb/rest', serviceKey: 'server-only',
        timeoutMs: 50,
        fetchImpl: vi.fn((_url: string, init: { signal: AbortSignal }) => (
          new Promise<never>((_resolve, reject) => {
            init.signal.addEventListener('abort', () => {
              setTimeout(() => {
                drained = true
                reject(new Error('transport closed'))
              }, 5)
            }, { once: true })
          })
        )),
      })
      const request = rpc('autoforge_knowledge_get_entitlement', { p_caller_user_id: '1' })
      const beforeAck = Promise.race([
        request.then(() => 'settled' as const, () => 'settled' as const),
        new Promise<'unsettled'>(resolve => setTimeout(() => resolve('unsettled'), 51)),
      ])
      await vi.advanceTimersByTimeAsync(51)
      await expect(beforeAck).resolves.toBe('unsettled')
      expect(drained).toBe(false)
      await vi.advanceTimersByTimeAsync(4)
      await expect(request).rejects.toEqual({ code: 'TRANSIENT_FAILURE' })
      expect(drained).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts and cancels a never-settling streamed response body', async () => {
    vi.useFakeTimers()
    try {
      const cancel = vi.fn().mockResolvedValue(undefined)
      const releaseLock = vi.fn()
      let requestSignal: AbortSignal | undefined
      const rpc = createPostgresRpcClient({
        baseUrl: 'https://autoforge.example/v1/rdb/rest', serviceKey: 'server-only',
        timeoutMs: 50,
        fetchImpl: vi.fn((_url: string, init: { signal: AbortSignal }) => {
          requestSignal = init.signal
          return Promise.resolve({
            ok: true, status: 200, headers: { get: vi.fn().mockReturnValue(null) },
            body: { getReader: () => ({
              read: vi.fn(() => new Promise<never>(() => undefined)), cancel, releaseLock,
            }) },
          })
        }),
      })
      const request = rpc('autoforge_knowledge_get_entitlement', { p_caller_user_id: '1' })
      const rejected = expect(request).rejects.toEqual({ code: 'TRANSIENT_FAILURE' })
      await vi.advanceTimersByTimeAsync(50)

      await rejected
      expect(requestSignal?.aborted).toBe(true)
      expect(cancel).toHaveBeenCalledOnce()
      expect(releaseLock).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns a consumable expiring PG Storage authorization and verifies uploaded bytes', async () => {
    const sha256 = 'a'.repeat(64)
    const objectId = expectedUploadObjectId()
    const storageReference = expectedStorageReference(objectId)
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        uploadTicket: 'ticket_1', storageReference,
        objectId, jobId: 'job_1', mimeType: 'text/plain',
        expiresAt: futureExpiry,
      })
      .mockResolvedValueOnce({
        ownerId: context.auth.uid, knowledgeBaseId: 'kb_1', uploadTicket: 'ticket_1',
        objectId, storageReference,
        expectedByteSize: 42, expectedSha256: sha256, expectedMimeType: 'text/plain',
      })
      .mockResolvedValueOnce({
        ownerId: context.auth.uid, knowledgeBaseId: 'kb_1', uploadTicket: 'ticket_1',
        objectId, storageReference, byteSize: 42, sha256, mimeType: 'text/plain',
        verified: true,
      })
    const storage = {
      createUploadAuthorization: vi.fn().mockResolvedValue({
        url: 'https://pg-storage.example/upload/ticket_1', method: 'PUT',
        headers: {
          'content-type': 'text/plain', 'content-length': '42',
          'x-content-sha256': sha256, 'x-upload-ticket': 'ticket_1',
        },
        expiresAt: futureExpiry,
      }),
      statObject: vi.fn().mockResolvedValue({ byteSize: 42, sha256, mimeType: 'text/plain' }),
      deleteObjects: vi.fn(),
    }
    const handler = createKnowledgeHandler({
      rpc, storage, uploadUrlPrefix: 'https://pg-storage.example/upload/',
    })

    await expect(handler({
      action: 'authorizeUpload', requestId: 'upload_1', knowledgeBaseId: 'kb_1',
      documentId: 'document_1', versionId: 'version_1', byteSize: 42, sha256,
      mimeType: 'text/plain',
    }, context)).resolves.toMatchObject({ ok: true, data: {
      uploadTicket: 'ticket_1', uploadAuthorization: {
        url: 'https://pg-storage.example/upload/ticket_1', method: 'PUT',
      },
    } })
    await expect(handler({ action: 'completeUpload', uploadTicket: 'ticket_1' }, context))
      .resolves.toMatchObject({ ok: true, data: { verified: true } })
    expect(storage.statObject).toHaveBeenCalledWith(storageReference)
    expect(rpc).toHaveBeenNthCalledWith(3, 'autoforge_knowledge_verify_upload', {
      p_caller_user_id: '2089908515857502208', p_upload_ticket: 'ticket_1',
      p_knowledge_base_id: 'kb_1', p_object_id: objectId,
      p_storage_reference: storageReference,
      p_expected_byte_size: 42, p_expected_sha256: sha256,
      p_expected_mime_type: 'text/plain',
      p_actual_byte_size: 42, p_actual_sha256: sha256, p_actual_mime_type: 'text/plain',
    })
  })

  it('returns an atomically committed upload verification even if consent is revoked afterward', async () => {
    const sha256 = 'a'.repeat(64)
    const objectId = expectedUploadObjectId()
    const storageReference = expectedStorageReference(objectId)
    let consentChecks = 0
    let verifiedInDatabase = false
    const rpc = vi.fn(async (name: string) => {
      if (name === 'autoforge_knowledge_assert_cloud_sync_consent') {
        consentChecks += 1
        if (consentChecks > 2) throw { code: 'FORBIDDEN' }
        return currentCloudSyncConsent
      }
      if (name === 'autoforge_knowledge_get_upload') return {
        ownerId: context.auth.uid, knowledgeBaseId: 'kb_1', uploadTicket: 'ticket_1',
        objectId, storageReference, expectedByteSize: 42, expectedSha256: sha256,
        expectedMimeType: 'text/plain',
      }
      if (name === 'autoforge_knowledge_verify_upload') {
        verifiedInDatabase = true
        return {
          ownerId: context.auth.uid, knowledgeBaseId: 'kb_1', uploadTicket: 'ticket_1',
          objectId, storageReference, byteSize: 42, sha256, mimeType: 'text/plain',
          verified: true,
        }
      }
      throw new Error(`unexpected RPC ${name}`)
    })
    const handler = createProductionKnowledgeHandler({
      rpc,
      storage: {
        createUploadAuthorization: vi.fn(),
        statObject: vi.fn().mockResolvedValue({ byteSize: 42, sha256, mimeType: 'text/plain' }),
        deleteObjects: vi.fn(),
      },
    })

    await expect(handler({ action: 'completeUpload', uploadTicket: 'ticket_1' }, context))
      .resolves.toEqual({
        ok: true, data: { objectId, storageReference, verified: true },
      })
    expect(verifiedInDatabase).toBe(true)
    expect(consentChecks).toBe(2)
  })

  it('rejects reviewer-reproduced owner, base, object, or private-path drift before Storage authorization', async () => {
    const objectId = expectedUploadObjectId()
    const valid = {
      uploadTicket: 'ticket_1', storageReference: expectedStorageReference(objectId),
      objectId, jobId: 'job_1', mimeType: 'text/plain', expiresAt: futureExpiry,
    }
    for (const drift of [
      { storageReference: `knowledge/attacker/kb_1/${objectId}` },
      { storageReference: `knowledge/${context.auth.uid}/kb_other/${objectId}` },
      { objectId: 'object_attacker', storageReference: expectedStorageReference('object_attacker') },
    ]) {
      const storage = {
        createUploadAuthorization: vi.fn(), statObject: vi.fn(), deleteObjects: vi.fn(),
      }
      const handler = createKnowledgeHandler({
        rpc: vi.fn().mockResolvedValue({ ...valid, ...drift }), storage,
        uploadUrlPrefix: 'https://pg-storage.example/upload/',
      })
      await expect(handler({
        action: 'authorizeUpload', requestId: 'upload_1', knowledgeBaseId: 'kb_1',
        documentId: 'document_1', versionId: 'version_1', byteSize: 42,
        sha256: 'a'.repeat(64), mimeType: 'text/plain',
      }, context)).resolves.toEqual({ ok: false, error: { code: 'INTERNAL_ERROR' } })
      expect(storage.createUploadAuthorization).not.toHaveBeenCalled()
    }
  })

  it('rejects get/stat/verify correlation drift without publishing a completion', async () => {
    const sha256 = 'a'.repeat(64)
    const objectId = expectedUploadObjectId()
    const storageReference = expectedStorageReference(objectId)
    const getUpload = {
      ownerId: context.auth.uid, knowledgeBaseId: 'kb_1', uploadTicket: 'ticket_1',
      objectId, storageReference, expectedByteSize: 42, expectedSha256: sha256,
      expectedMimeType: 'text/plain',
    }
    const storage = {
      createUploadAuthorization: vi.fn(),
      statObject: vi.fn().mockResolvedValue({ byteSize: 42, sha256, mimeType: 'text/plain' }),
      deleteObjects: vi.fn(),
    }
    const mismatchedGet = createKnowledgeHandler({
      rpc: vi.fn().mockResolvedValue({ ...getUpload, knowledgeBaseId: 'kb_other' }), storage,
    })
    await expect(mismatchedGet({ action: 'completeUpload', uploadTicket: 'ticket_1' }, context))
      .resolves.toEqual({ ok: false, error: { code: 'INTERNAL_ERROR' } })
    expect(storage.statObject).not.toHaveBeenCalled()

    const statDriftRpc = vi.fn().mockResolvedValue(getUpload)
    const mismatchedStat = createKnowledgeHandler({
      rpc: statDriftRpc,
      storage: {
        ...storage,
        statObject: vi.fn().mockResolvedValue({
          byteSize: 41, sha256, mimeType: 'text/plain',
        }),
      },
    })
    await expect(mismatchedStat({ action: 'completeUpload', uploadTicket: 'ticket_1' }, context))
      .resolves.toEqual({ ok: false, error: { code: 'INTERNAL_ERROR' } })
    expect(statDriftRpc).toHaveBeenCalledTimes(1)

    const rpc = vi.fn()
      .mockResolvedValueOnce(getUpload)
      .mockResolvedValueOnce({
        ownerId: context.auth.uid, knowledgeBaseId: 'kb_1', uploadTicket: 'ticket_other',
        objectId, storageReference, byteSize: 42, sha256, mimeType: 'text/plain',
        verified: true,
      })
    const mismatchedVerify = createKnowledgeHandler({ rpc, storage })
    await expect(mismatchedVerify({ action: 'completeUpload', uploadTicket: 'ticket_1' }, context))
      .resolves.toEqual({ ok: false, error: { code: 'INTERNAL_ERROR' } })
  })

  it('rejects upload authorization outside the configured HTTPS path or with credential headers', async () => {
    const objectId = expectedUploadObjectId()
    const rpc = vi.fn().mockResolvedValue({
      uploadTicket: 'ticket_1', storageReference: expectedStorageReference(objectId),
      objectId, jobId: 'job_1', mimeType: 'text/plain',
      expiresAt: futureExpiry,
    })
    const storage = {
      createUploadAuthorization: vi.fn().mockResolvedValue({
        url: 'https://attacker.example/upload/ticket_1', method: 'PUT',
        headers: {
          authorization: 'Bearer leaked', 'content-type': 'text/plain',
          'content-length': '42', 'x-content-sha256': 'a'.repeat(64),
          'x-upload-ticket': 'ticket_1',
        },
        expiresAt: futureExpiry,
      }),
      statObject: vi.fn(), deleteObjects: vi.fn(),
    }
    const handler = createKnowledgeHandler({
      rpc, storage, uploadUrlPrefix: 'https://pg-storage.example/upload/',
    })

    await expect(handler({
      action: 'authorizeUpload', requestId: 'upload_1', knowledgeBaseId: 'kb_1',
      documentId: 'document_1', versionId: 'version_1', byteSize: 42,
      sha256: 'a'.repeat(64), mimeType: 'text/plain',
    }, context)).resolves.toEqual({ ok: false, error: { code: 'INTERNAL_ERROR' } })
  })

  it('fails closed on oversized or extra-key upstream responses', async () => {
    const handler = createKnowledgeHandler({
      rpc: vi.fn()
        .mockResolvedValueOnce({ tier: 'free', status: 'active', betaEnabled: false,
          cloudEnabled: false, killSwitchEnabled: true, version: 1, validUntil: null,
          secret: 'must-not-cross' })
        .mockResolvedValueOnce({ value: 'x'.repeat(1_048_577) }),
    })
    await expect(handler({ action: 'getEntitlement' }, context)).resolves.toEqual({
      ok: false, error: { code: 'INTERNAL_ERROR' },
    })
    await expect(handler({ action: 'getEntitlement' }, context)).resolves.toEqual({
      ok: false, error: { code: 'INTERNAL_ERROR' },
    })
  })

  it('deletes private storage bytes before completing orphan cleanup records', async () => {
    const order: string[] = []
    const rpc = vi.fn().mockImplementationOnce(async () => {
      order.push('prepare')
      return { storageReferences: ['knowledge/1/kb_1/object_1'] }
    }).mockImplementationOnce(async () => {
      order.push('complete')
      return { removed: 1 }
    })
    const storage = {
      createUploadAuthorization: vi.fn(), statObject: vi.fn(),
      deleteObjects: vi.fn().mockImplementation(async () => { order.push('storage') }),
    }
    const handler = createKnowledgeHandler({ rpc, storage })

    await expect(handler({
      action: 'cleanupOrphans', requestId: 'cleanup_1', knowledgeBaseId: 'kb_1',
      storageReferences: ['knowledge/1/kb_1/object_1'],
    }, context)).resolves.toEqual({ ok: true, data: { removed: 1 } })
    expect(order).toEqual(['prepare', 'storage', 'complete'])
  })

  it('replays a completed orphan-cleanup receipt without deleting Storage twice', async () => {
    const storage = {
      createUploadAuthorization: vi.fn(), statObject: vi.fn(), deleteObjects: vi.fn(),
    }
    const handler = createKnowledgeHandler({
      rpc: vi.fn().mockResolvedValue({
        storageReferences: ['knowledge/1/kb_1/object_1'], removed: 1,
      }),
      storage,
    })

    await expect(handler({
      action: 'cleanupOrphans', requestId: 'cleanup_1', knowledgeBaseId: 'kb_1',
      storageReferences: ['knowledge/1/kb_1/object_1'],
    }, context)).resolves.toEqual({ ok: true, data: { removed: 1 } })
    expect(storage.deleteObjects).not.toHaveBeenCalled()
  })

  it('keeps storage service credentials server-side in the PG Storage adapter', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(streamedResponse({
        url: 'https://pg-storage.example/upload/ticket_1', method: 'PUT', headers: {
          'content-length': '42', 'content-type': 'text/plain',
          'x-content-sha256': 'a'.repeat(64), 'x-upload-ticket': 'ticket_1',
        },
        expiresAt: futureExpiry,
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    const storage = createPostgresStorageClient({
      baseUrl: 'https://pg-storage.example/v1/storage', serviceKey: 'server-only',
      uploadUrlPrefix: 'https://pg-storage.example/upload/', fetchImpl,
    })
    await storage.createUploadAuthorization({
      uploadTicket: 'ticket_1', storageReference: 'knowledge/1/kb_1/object_1',
      byteSize: 42, sha256: 'a'.repeat(64), mimeType: 'text/plain',
      expiresAt: futureExpiry,
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://pg-storage.example/v1/storage/upload-authorizations',
      expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer server-only' }) }),
    )
    await expect(storage.deleteObjects(['knowledge/1/kb_1/object_1'])).resolves.toBeUndefined()

    const nonEmptyStatusStorage = createPostgresStorageClient({
      baseUrl: 'https://pg-storage.example/v1/storage', serviceKey: 'server-only',
      uploadUrlPrefix: 'https://pg-storage.example/upload/',
      fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
    })
    await expect(nonEmptyStatusStorage.deleteObjects(['knowledge/1/kb_1/object_1']))
      .rejects.toEqual({ code: 'INTERNAL_ERROR' })
  })
})

describe('CloudBase embedding consent and retrieval', () => {
  const embedding = {
    model: 'kinfra-text-embedding-0.6b', dimensions: 1024,
    configurationVersion: 'autoforge-knowledge-embedding-v1', region: 'guangzhou',
  }
  const cloudCandidate = (id: string, rank: number) => ({
    id, knowledgeBaseId: 'kb_1', documentId: 'document_1', versionId: 'version_1',
    generationId: 'generation_1', rank, body: `body-${id}`,
    coordinates: { kind: 'txt', lineStart: rank, lineEnd: rank },
  })
  const permit = (purpose: 'query' | 'chunk', requestId: string, attemptId = 1) => ({
    issued: true, permitId: `permit_${requestId}`, purpose, requestId,
    attemptId, consentEpoch: 2, expiresAt: futureExpiry,
    providerRequestKey: `embed_${requestId}_${attemptId}`, embedding,
  })

  it('uses a strict bounded TokenHub adapter without diagnostic content output', async () => {
    const vector = Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0)
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(streamedResponse({
        model: embedding.model, dimensions: 1024, embedding: vector,
      }))
      .mockResolvedValueOnce(streamedResponse({
        status: 'completed', model: embedding.model, dimensions: 1024, embedding: vector,
      }))
    const tokenHub = createTokenHubClient({
      endpoint: 'https://tokenhub.example/v1/embeddings', apiKey: 'server-only', fetchImpl,
    })
    await expect(tokenHub.embed({
      input: '合同条款', model: embedding.model, dimensions: 1024,
      configurationVersion: embedding.configurationVersion, region: 'guangzhou',
      dispatchPermit: 'permit_1', idempotencyKey: 'embed_attempt_1',
    })).resolves.toEqual(vector)
    await expect(tokenHub.recoverAttempt({
      model: embedding.model, dimensions: 1024,
      configurationVersion: embedding.configurationVersion, region: 'guangzhou',
      idempotencyKey: 'embed_attempt_1',
    })).resolves.toEqual({ state: 'completed', vector })
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://tokenhub.example/v1/embeddings',
      expect.objectContaining({
        method: 'POST', headers: expect.objectContaining({
          'idempotency-key': 'embed_attempt_1',
        }),
      }),
    )
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://tokenhub.example/v1/embeddings/status',
      expect.objectContaining({
        method: 'POST', headers: expect.objectContaining({
          'idempotency-key': 'embed_attempt_1',
        }),
      }),
    )
    expect(String(fetchImpl.mock.calls[1]?.[1]?.body)).not.toContain('合同条款')
    expect(() => createTokenHubClient({
      endpoint: 'http://tokenhub.example/v1/embeddings?query=leak', apiKey: 'server-only',
    })).toThrow('TokenHub is not configured')
  })

  it('aborts a never-settling TokenHub request at its deadline and clears the timer', async () => {
    vi.useFakeTimers()
    try {
      let requestSignal: AbortSignal | undefined
      const tokenHub = createTokenHubClient({
        endpoint: 'https://tokenhub.example/v1/embeddings', apiKey: 'server-only',
        timeoutMs: 50,
        fetchImpl: vi.fn((_url: string, init: { signal: AbortSignal }) => {
          requestSignal = init.signal
          return new Promise<never>((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          })
        }),
      })
      const request = tokenHub.embed({
        input: '合同条款', model: embedding.model, dimensions: 1024,
        configurationVersion: embedding.configurationVersion, region: 'guangzhou',
        dispatchPermit: 'permit_1', idempotencyKey: 'embed_attempt_1',
      })
      const rejected = expect(request).rejects.toEqual({ code: 'TRANSIENT_FAILURE' })
      await vi.advanceTimersByTimeAsync(50)

      await rejected
      expect(requestSignal?.aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('caps PostgreSQL RPC and TokenHub clients to the caller remaining deadline', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      const signals: AbortSignal[] = []
      const fetchImpl = vi.fn((_url: string, init: { signal: AbortSignal }) => {
        signals.push(init.signal)
        return new Promise<never>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      })
      const rpc = createPostgresRpcClient({
        baseUrl: 'https://autoforge.example/v1/rdb/rest', serviceKey: 'server-only',
        fetchImpl, timeoutMs: 500,
      })
      const tokenHub = createTokenHubClient({
        endpoint: 'https://tokenhub.example/v1/embeddings', apiKey: 'server-only',
        fetchImpl, timeoutMs: 500,
      })
      const boundary = {
        signal: new AbortController().signal,
        deadlineAt: Date.now() + 50,
        timeoutMs: 500,
      }
      const requests = [
        rpc('autoforge_knowledge_get_entitlement', { p_caller_user_id: '1' }, boundary),
        tokenHub.embed({
          input: '合同条款', model: embedding.model, dimensions: 1024,
          configurationVersion: embedding.configurationVersion, region: 'guangzhou',
          dispatchPermit: 'permit_1', idempotencyKey: 'embed_attempt_1',
        }, boundary),
      ]
      const earlyOutcomes = requests.map(request => Promise.race([
        request.then(
          () => ({ kind: 'resolved' as const }),
          error => ({ kind: 'rejected' as const, error }),
        ),
        new Promise<{ kind: 'unsettled' }>(resolve => {
          setTimeout(() => resolve({ kind: 'unsettled' }), 51)
        }),
      ]))

      await vi.advanceTimersByTimeAsync(51)
      const observed = await Promise.all(earlyOutcomes)
      await vi.advanceTimersByTimeAsync(500)
      await Promise.allSettled(requests)

      expect(observed).toEqual([
        { kind: 'rejected', error: { code: 'TRANSIENT_FAILURE' } },
        { kind: 'rejected', error: { code: 'TRANSIENT_FAILURE' } },
      ])
      expect(signals).toHaveLength(2)
      expect(signals.every(signal => signal.aborted)).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('binds separate embedding consent to the trusted owner and deletes vectors on revocation', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        state: 'granted', consentEpoch: 3, vectorsDeleted: 0, rebuildRequired: true,
      })
      .mockResolvedValueOnce({
        state: 'revoked', consentEpoch: 4, vectorsDeleted: 19, rebuildRequired: false,
      })
    const handler = createKnowledgeHandler({ rpc })

    await expect(handler({
      action: 'setEmbeddingConsent', requestId: 'consent_1', enabled: true,
    }, context)).resolves.toEqual({
      ok: true, data: {
        state: 'granted', consentEpoch: 3, vectorsDeleted: 0, rebuildRequired: true,
      },
    })
    await expect(handler({
      action: 'setEmbeddingConsent', requestId: 'consent_2', enabled: false,
    }, context)).resolves.toEqual({
      ok: true, data: {
        state: 'revoked', consentEpoch: 4, vectorsDeleted: 19, rebuildRequired: false,
      },
    })
    expect(rpc).toHaveBeenNthCalledWith(1, 'autoforge_knowledge_set_embedding_consent', {
      p_caller_user_id: context.auth.uid, p_request_id: 'consent_1', p_enabled: true,
    })
    expect(rpc).toHaveBeenNthCalledWith(2, 'autoforge_knowledge_set_embedding_consent', {
      p_caller_user_id: context.auth.uid, p_request_id: 'consent_2', p_enabled: false,
    })

    const forged = createKnowledgeHandler({ rpc: vi.fn() })
    await expect(forged({
      action: 'setEmbeddingConsent', requestId: 'consent_3', enabled: true,
      ownerId: 'attacker',
    }, context)).resolves.toEqual({ ok: false, error: { code: 'INVALID_INPUT' } })
  })

  it('creates a correlated shadow drift generation without changing publication', async () => {
    const rpc = vi.fn().mockResolvedValue({
      generationId: 'generation_shadow', previousGenerationId: 'generation_current',
      jobId: 'job_embedding', status: 'staging',
    })
    const handler = createKnowledgeHandler({ rpc })
    await expect(handler({
      action: 'beginEmbeddingDriftProbe', requestId: 'probe_1', knowledgeBaseId: 'kb_1',
      generationId: 'generation_shadow',
      expectedPublishedGenerationId: 'generation_current',
    }, context)).resolves.toMatchObject({ ok: true, data: { status: 'staging' } })
    expect(rpc).toHaveBeenCalledWith('autoforge_knowledge_begin_embedding_drift_probe', {
      p_caller_user_id: context.auth.uid, p_request_id: 'probe_1',
      p_knowledge_base_id: 'kb_1', p_generation_id: 'generation_shadow',
      p_expected_published_generation_id: 'generation_current',
    })
  })

  it('refuses TokenHub disclosure without consent and returns keyword-only candidates', async () => {
    const tokenHub = { embed: vi.fn() }
    const rpc = vi.fn()
      .mockResolvedValueOnce({ state: 'revoked', consentEpoch: 8, rebuildRequired: false })
      .mockResolvedValueOnce({
        generations: [{ knowledgeBaseId: 'kb_1', generationId: 'generation_1',
          previousGenerationId: null }],
        embedding, driftProbeRequired: false,
        keywordCandidates: [cloudCandidate('chunk_keyword', 1)],
      })
    const handler = createKnowledgeHandler({ rpc, tokenHub })

    await expect(handler({
      action: 'searchKnowledge', requestId: 'search_refused', query: '合同条款',
      knowledgeBaseIds: ['kb_1'], limit: 24,
    }, context)).resolves.toMatchObject({ ok: true, data: {
      generations: [{ generationId: 'generation_1' }], generationState: 'published',
      strategy: 'keyword_only_consent', vectorCandidates: [],
    } })
    expect(tokenHub.embed).not.toHaveBeenCalled()
  })

  it('uses the fixed 1024-dimension TokenHub boundary and falls back on outage', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ state: 'granted', consentEpoch: 2, rebuildRequired: false })
      .mockResolvedValueOnce({
        generations: [{ knowledgeBaseId: 'kb_1', generationId: 'generation_1',
          previousGenerationId: null }],
        embedding, driftProbeRequired: false,
        keywordCandidates: [cloudCandidate('chunk_keyword', 1)],
      })
      .mockResolvedValueOnce(permit('query', 'search_outage'))
      .mockResolvedValueOnce({ reserved: true })
      .mockResolvedValueOnce({ started: true })
      .mockResolvedValueOnce({ recorded: true })
      .mockResolvedValueOnce({ settled: true })
    const tokenHub = { embed: vi.fn().mockRejectedValue(new Error('provider body')) }
    const handler = createKnowledgeHandler({ rpc, tokenHub })

    await expect(handler({
      action: 'searchKnowledge', requestId: 'search_outage', query: '合同条款',
      knowledgeBaseIds: ['kb_1'], limit: 24,
    }, context)).resolves.toMatchObject({ ok: true, data: {
      strategy: 'keyword_only_provider', vectorCandidates: [],
    } })
    expect(tokenHub.embed).toHaveBeenCalledWith({
      input: '合同条款', model: embedding.model, dimensions: 1024,
      configurationVersion: embedding.configurationVersion, region: 'guangzhou',
      dispatchPermit: 'permit_search_outage', idempotencyKey: 'embed_search_outage_1',
    }, expect.objectContaining({
      signal: expect.any(AbortSignal), deadlineAt: expect.any(Number), timeoutMs: 10_000,
    }))
  })

  it('uses a new bounded attempt identity for one transient provider retry', async () => {
    const vector = Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0)
    const tokenHub = { embed: vi.fn()
      .mockRejectedValueOnce({ code: 'TRANSIENT_FAILURE' })
      .mockResolvedValueOnce(vector) }
    const rpc = vi.fn().mockImplementation(async (name: string, parameters: {
      p_attempt_id?: number
    }) => {
      if (name === 'autoforge_knowledge_get_embedding_consent') return {
        state: 'granted', consentEpoch: 2, rebuildRequired: false,
      }
      if (name === 'autoforge_knowledge_search_keywords') return {
        generations: [{ knowledgeBaseId: 'kb_1', generationId: 'generation_1',
          previousGenerationId: null }], embedding, driftProbeRequired: false,
        keywordCandidates: [cloudCandidate('chunk_keyword', 1)],
      }
      if (name === 'autoforge_knowledge_issue_embedding_dispatch_permit') {
        const attemptId = parameters.p_attempt_id ?? 0
        return {
          ...permit('query', 'search_retry', attemptId),
          permitId: `permit_search_retry_${attemptId}`,
        }
      }
      if (name === 'autoforge_knowledge_reserve_embedding_dispatch_attempt') {
        return { reserved: true }
      }
      if (name === 'autoforge_knowledge_mark_embedding_dispatch_started') {
        return { started: true }
      }
      if (name === 'autoforge_knowledge_record_embedding_dispatch_settlement_intent') {
        return { recorded: true }
      }
      if (name === 'autoforge_knowledge_settle_embedding_dispatch_attempt') {
        return { settled: true }
      }
      if (name === 'autoforge_knowledge_search_vectors') {
        return { vectorCandidates: [cloudCandidate('chunk_vector', 1)] }
      }
      throw new Error(`unexpected rpc ${name}`)
    })
    const handler = createKnowledgeHandler({ rpc, tokenHub })

    await expect(handler({
      action: 'searchKnowledge', requestId: 'search_retry', query: '合同条款',
      knowledgeBaseIds: ['kb_1'], limit: 8,
    }, context)).resolves.toMatchObject({ ok: true, data: { strategy: 'hybrid' } })
    expect(tokenHub.embed).toHaveBeenCalledTimes(2)
    expect(tokenHub.embed.mock.calls.map(([input]) => input.dispatchPermit)).toEqual([
      'permit_search_retry_1', 'permit_search_retry_2',
    ])
    expect(rpc.mock.calls.filter(([name]) => (
      name === 'autoforge_knowledge_issue_embedding_dispatch_permit'
    )).map(([, parameters]) => parameters.p_attempt_id)).toEqual([1, 2])
    expect(rpc.mock.calls.filter(([name]) => (
      name === 'autoforge_knowledge_record_embedding_dispatch_settlement_intent'
    )).map(([, parameters]) => ({
      attemptId: parameters.p_attempt_id,
      outcome: parameters.p_outcome,
      retryable: parameters.p_retryable,
    }))).toEqual([
      { attemptId: 1, outcome: 'failed', retryable: true },
      { attemptId: 2, outcome: 'completed', retryable: false },
    ])
  })

  it('recovers a durable completed attempt after the settle response is lost', async () => {
    const vector = Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0)
    const responseHash = createHash('sha256').update(JSON.stringify({
      state: 'completed', vector,
    })).digest('hex')
    let invocation = 0
    let attemptState: 'absent' | 'issued' | 'dispatching' | 'started'
      | 'settlement_pending' | 'completed' = 'absent'
    let settleCalls = 0
    const tokenHub = {
      embed: vi.fn().mockResolvedValue(vector),
      recoverAttempt: vi.fn().mockResolvedValue({ state: 'completed', vector }),
    }
    const rpc = vi.fn().mockImplementation(async (name: string) => {
      if (name === 'autoforge_knowledge_get_embedding_consent') return {
        state: 'granted', consentEpoch: 2, rebuildRequired: false,
      }
      if (name === 'autoforge_knowledge_search_keywords') {
        invocation += 1
        return {
          generations: [{ knowledgeBaseId: 'kb_1', generationId: 'generation_1',
            previousGenerationId: null }], embedding, driftProbeRequired: false,
          keywordCandidates: [cloudCandidate(`chunk_keyword_${invocation}`, 1)],
        }
      }
      if (name === 'autoforge_knowledge_issue_embedding_dispatch_permit') {
        if (attemptState === 'absent') {
          attemptState = 'issued'
          return {
            ...permit('query', 'search_lost_settle'),
            providerRequestKey: 'embed_search_lost_settle_1',
          }
        }
        return { issued: false, recovery: {
          state: attemptState, permitId: 'permit_search_lost_settle',
          purpose: 'query', requestId: 'search_lost_settle', attemptId: 1,
          consentEpoch: 2, providerRequestKey: 'embed_search_lost_settle_1',
          outcome: 'completed', responseHash, retryable: false, embedding,
        } }
      }
      if (name === 'autoforge_knowledge_reserve_embedding_dispatch_attempt') {
        attemptState = 'dispatching'
        return { reserved: true }
      }
      if (name === 'autoforge_knowledge_mark_embedding_dispatch_started') {
        attemptState = 'started'
        return { started: true }
      }
      if (name === 'autoforge_knowledge_record_embedding_dispatch_settlement_intent') {
        attemptState = 'settlement_pending'
        return { recorded: true }
      }
      if (name === 'autoforge_knowledge_settle_embedding_dispatch_attempt') {
        settleCalls += 1
        attemptState = 'completed'
        if (settleCalls === 1) throw { code: 'TRANSIENT_FAILURE' }
        return { settled: true }
      }
      if (name === 'autoforge_knowledge_search_vectors') {
        return { vectorCandidates: [cloudCandidate('chunk_vector', 1)] }
      }
      throw new Error(`unexpected rpc ${name}`)
    })
    const handler = createKnowledgeHandler({ rpc, tokenHub })
    const event = {
      action: 'searchKnowledge', requestId: 'search_lost_settle', query: '合同条款',
      knowledgeBaseIds: ['kb_1'], limit: 8,
    } as const

    await expect(handler(event, context)).resolves.toEqual({
      ok: false, error: { code: 'TRANSIENT_FAILURE' },
    })
    await expect(handler(event, context)).resolves.toMatchObject({
      ok: true, data: { strategy: 'hybrid' },
    })
    expect(tokenHub.embed).toHaveBeenCalledOnce()
    expect(tokenHub.recoverAttempt).toHaveBeenCalledOnce()
    expect(settleCalls).toBe(2)
  })

  it('recovers a started provider attempt after the sender exits before intent persistence', async () => {
    const vector = Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0)
    let attemptState: 'absent' | 'started' | 'completed' = 'absent'
    let recordCalls = 0
    const tokenHub = {
      embed: vi.fn().mockResolvedValue(vector),
      recoverAttempt: vi.fn().mockResolvedValue({ state: 'completed', vector }),
    }
    const rpc = vi.fn().mockImplementation(async (name: string) => {
      if (name === 'autoforge_knowledge_get_embedding_consent') return {
        state: 'granted', consentEpoch: 2, rebuildRequired: false,
      }
      if (name === 'autoforge_knowledge_search_keywords') return {
        generations: [{ knowledgeBaseId: 'kb_1', generationId: 'generation_1',
          previousGenerationId: null }], embedding, driftProbeRequired: false,
        keywordCandidates: [cloudCandidate('chunk_keyword', 1)],
      }
      if (name === 'autoforge_knowledge_issue_embedding_dispatch_permit') {
        if (attemptState === 'absent') return permit('query', 'search_process_retry')
        return { issued: false, recovery: {
          state: attemptState, permitId: 'permit_search_process_retry',
          purpose: 'query', requestId: 'search_process_retry', attemptId: 1,
          consentEpoch: 2, providerRequestKey: 'embed_search_process_retry_1',
          outcome: null, responseHash: null, retryable: false, embedding,
        } }
      }
      if (name === 'autoforge_knowledge_reserve_embedding_dispatch_attempt') {
        return { reserved: true }
      }
      if (name === 'autoforge_knowledge_mark_embedding_dispatch_started') {
        attemptState = 'started'
        return { started: true }
      }
      if (name === 'autoforge_knowledge_record_embedding_dispatch_settlement_intent') {
        recordCalls += 1
        if (recordCalls === 1) throw { code: 'TRANSIENT_FAILURE' }
        return { recorded: true }
      }
      if (name === 'autoforge_knowledge_settle_embedding_dispatch_attempt') {
        attemptState = 'completed'
        return { settled: true }
      }
      if (name === 'autoforge_knowledge_search_vectors') {
        return { vectorCandidates: [cloudCandidate('chunk_vector', 1)] }
      }
      throw new Error(`unexpected rpc ${name}`)
    })
    const handler = createKnowledgeHandler({ rpc, tokenHub })
    const event = {
      action: 'searchKnowledge', requestId: 'search_process_retry', query: '合同条款',
      knowledgeBaseIds: ['kb_1'], limit: 8,
    } as const

    await expect(handler(event, context)).resolves.toEqual({
      ok: false, error: { code: 'TRANSIENT_FAILURE' },
    })
    await expect(handler(event, context)).resolves.toMatchObject({
      ok: true, data: { strategy: 'hybrid' },
    })
    expect(tokenHub.embed).toHaveBeenCalledOnce()
    expect(tokenHub.recoverAttempt).toHaveBeenCalledOnce()
    expect(recordCalls).toBe(2)
  })

  it('maps fixed metadata drift to the rebuild strategy accepted by Main', async () => {
    const tokenHub = { embed: vi.fn() }
    const rpc = vi.fn()
      .mockResolvedValueOnce({ state: 'granted', consentEpoch: 2, rebuildRequired: false })
      .mockResolvedValueOnce({
        generations: [{ knowledgeBaseId: 'kb_1', generationId: 'generation_1',
          previousGenerationId: null }],
        embedding: { ...embedding, dimensions: 768 }, driftProbeRequired: false,
        keywordCandidates: [cloudCandidate('chunk_keyword', 1)],
      })
    const handler = createKnowledgeHandler({ rpc, tokenHub })
    await expect(handler({
      action: 'searchKnowledge', requestId: 'search_drift', query: '合同 条款',
      knowledgeBaseIds: ['kb_1'], limit: 8,
    }, context)).resolves.toMatchObject({ ok: true, data: {
      strategy: 'keyword_only_rebuild', driftProbeRequired: true, vectorCandidates: [],
    } })
    expect(tokenHub.embed).not.toHaveBeenCalled()
  })

  it('rechecks consent and returns strictly correlated hybrid candidates', async () => {
    const vector = Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0)
    const vectorCandidate = cloudCandidate('chunk_vector', 1)
    const rpc = vi.fn()
      .mockResolvedValueOnce({ state: 'granted', consentEpoch: 2, rebuildRequired: false })
      .mockResolvedValueOnce({
        generations: [{ knowledgeBaseId: 'kb_1', generationId: 'generation_1',
          previousGenerationId: 'generation_previous' }],
        embedding, driftProbeRequired: false,
        keywordCandidates: [cloudCandidate('chunk_keyword', 1)],
      })
      .mockResolvedValueOnce(permit('query', 'search_hybrid'))
      .mockResolvedValueOnce({ reserved: true })
      .mockResolvedValueOnce({ started: true })
      .mockResolvedValueOnce({ recorded: true })
      .mockResolvedValueOnce({ settled: true })
      .mockResolvedValueOnce({ state: 'granted', consentEpoch: 2, rebuildRequired: false })
      .mockResolvedValueOnce({ vectorCandidates: [vectorCandidate] })
    const tokenHub = { embed: vi.fn().mockResolvedValue(vector) }
    const handler = createKnowledgeHandler({ rpc, tokenHub })

    await expect(handler({
      action: 'searchKnowledge', requestId: 'search_hybrid', query: '合同条款',
      knowledgeBaseIds: ['kb_1'], limit: 8,
    }, context)).resolves.toMatchObject({ ok: true, data: {
      generationState: 'published', strategy: 'hybrid',
      vectorCandidates: [vectorCandidate],
    } })
    expect(rpc).toHaveBeenNthCalledWith(9, 'autoforge_knowledge_search_vectors', {
      p_caller_user_id: context.auth.uid, p_knowledge_base_ids: ['kb_1'],
      p_vector: vector, p_model: embedding.model, p_dimensions: 1024,
      p_configuration_version: embedding.configurationVersion, p_limit: 8,
    })
  })

  it('never starts a reserved search send after revocation has begun', async () => {
    let consentState: 'granted' | 'revoking' | 'revoked' = 'granted'
    let attemptActive = true
    let releaseStart!: () => void
    let settleAttempt!: () => void
    const startGate = new Promise<void>(resolve => { releaseStart = resolve })
    const attemptSettled = new Promise<void>(resolve => { settleAttempt = resolve })
    const tokenHub = { embed: vi.fn() }
    const rpc = vi.fn().mockImplementation(async (name: string) => {
      if (name === 'autoforge_knowledge_get_embedding_consent') {
        return { state: consentState, consentEpoch: consentState === 'granted' ? 2 : 3,
          rebuildRequired: false }
      }
      if (name === 'autoforge_knowledge_search_keywords') return {
        generations: [{ knowledgeBaseId: 'kb_1', generationId: 'generation_1',
          previousGenerationId: null }], embedding, driftProbeRequired: false,
        keywordCandidates: [cloudCandidate('chunk_keyword', 1)],
      }
      if (name === 'autoforge_knowledge_issue_embedding_dispatch_permit') {
        return permit('query', 'search_race')
      }
      if (name === 'autoforge_knowledge_reserve_embedding_dispatch_attempt') {
        return { reserved: true }
      }
      if (name === 'autoforge_knowledge_mark_embedding_dispatch_started') {
        await startGate
        attemptActive = false
        settleAttempt()
        return { started: consentState === 'granted' }
      }
      if (name === 'autoforge_knowledge_set_embedding_consent') {
        consentState = 'revoking'
        return { state: 'revoking', consentEpoch: 3, vectorsDeleted: 0,
          rebuildRequired: false }
      }
      if (name === 'autoforge_knowledge_get_embedding_revocation_attempt') {
        return { attempt: null }
      }
      if (name === 'autoforge_knowledge_finalize_embedding_revocation') {
        if (attemptActive) await attemptSettled
        consentState = 'revoked'
        return { state: 'revoked', consentEpoch: 3, vectorsDeleted: 8,
          rebuildRequired: false }
      }
      throw new Error(`unexpected rpc ${name}`)
    })
    const handler = createKnowledgeHandler({ rpc, tokenHub })
    const search = handler({
      action: 'searchKnowledge', requestId: 'search_race', query: '合同 条款',
      knowledgeBaseIds: ['kb_1'], limit: 8,
    }, context)
    await vi.waitFor(() => expect(rpc.mock.calls.some(
      ([name]) => name === 'autoforge_knowledge_mark_embedding_dispatch_started',
    )).toBe(true))

    let revokeReturned = false
    const revoke = handler({
      action: 'setEmbeddingConsent', requestId: 'revoke_race', enabled: false,
    }, context).finally(() => { revokeReturned = true })
    await vi.waitFor(() => expect(consentState).toBe('revoking'))
    expect(revokeReturned).toBe(false)
    releaseStart()

    await expect(search).resolves.toMatchObject({ ok: true, data: {
      strategy: 'keyword_only_consent', vectorCandidates: [],
    } })
    await expect(revoke).resolves.toMatchObject({ ok: true, data: { state: 'revoked' } })
    expect(tokenHub.embed).not.toHaveBeenCalled()
  })

  it('returns a stable retry while a started dispatch is still active', async () => {
    const rpc = vi.fn().mockImplementation(async (name: string) => {
      if (name === 'autoforge_knowledge_set_embedding_consent') return {
        state: 'revoking', consentEpoch: 3, vectorsDeleted: 0, rebuildRequired: false,
      }
      if (name === 'autoforge_knowledge_get_embedding_revocation_attempt') {
        return { attempt: null }
      }
      if (name === 'autoforge_knowledge_finalize_embedding_revocation') return {
        state: 'revoking', consentEpoch: 3, vectorsDeleted: 0, rebuildRequired: false,
      }
      throw new Error(`unexpected rpc ${name}`)
    })
    const handler = createKnowledgeHandler({ rpc, tokenHub: { embed: vi.fn() } })

    await expect(handler({
      action: 'setEmbeddingConsent', requestId: 'revoke_pending', enabled: false,
    }, context)).resolves.toEqual({ ok: false, error: { code: 'TRANSIENT_FAILURE' } })
    expect(rpc).toHaveBeenCalledTimes(7)
    expect(rpc.mock.calls.filter(([name]) => (
      name === 'autoforge_knowledge_get_embedding_revocation_attempt'
    ))).toHaveLength(3)
    expect(rpc.mock.calls.filter(([name]) => (
      name === 'autoforge_knowledge_finalize_embedding_revocation'
    ))).toHaveLength(3)
  })

  it('recovers a provider result with no settlement intent before revocation completes', async () => {
    const vector = Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0)
    let attemptActive = true
    const tokenHub = {
      embed: vi.fn(),
      recoverAttempt: vi.fn().mockResolvedValue({ state: 'completed', vector }),
    }
    const rpc = vi.fn().mockImplementation(async (name: string) => {
      if (name === 'autoforge_knowledge_set_embedding_consent') return {
        state: 'revoking', consentEpoch: 7, vectorsDeleted: 0, rebuildRequired: false,
      }
      if (name === 'autoforge_knowledge_get_embedding_revocation_attempt') {
        return { attempt: attemptActive ? {
          state: 'started', permitId: 'permit_job_1_chunk_1',
          purpose: 'chunk', requestId: 'job_1:chunk_1', attemptId: 1,
          consentEpoch: 6, providerRequestKey: 'embed_job_1_chunk_1_1',
          outcome: null, responseHash: null, retryable: false,
          knowledgeBaseId: 'kb_1', generationId: 'generation_shadow', chunkId: 'chunk_1',
          embedding,
        } : null }
      }
      if (name === 'autoforge_knowledge_record_embedding_dispatch_settlement_intent') {
        return { recorded: true }
      }
      if (name === 'autoforge_knowledge_settle_embedding_dispatch_attempt') {
        attemptActive = false
        return { settled: true }
      }
      if (name === 'autoforge_knowledge_finalize_embedding_revocation') return {
        state: attemptActive ? 'revoking' : 'revoked', consentEpoch: 7,
        vectorsDeleted: attemptActive ? 0 : 12, rebuildRequired: false,
      }
      throw new Error(`unexpected rpc ${name}`)
    })
    const handler = createKnowledgeHandler({ rpc, tokenHub })

    await expect(handler({
      action: 'setEmbeddingConsent', requestId: 'revoke_recover', enabled: false,
    }, context)).resolves.toMatchObject({ ok: true, data: {
      state: 'revoked', consentEpoch: 7, vectorsDeleted: 12,
    } })
    expect(tokenHub.embed).not.toHaveBeenCalled()
    expect(tokenHub.recoverAttempt).toHaveBeenCalledOnce()
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      'autoforge_knowledge_set_embedding_consent',
      'autoforge_knowledge_get_embedding_revocation_attempt',
      'autoforge_knowledge_record_embedding_dispatch_settlement_intent',
      'autoforge_knowledge_settle_embedding_dispatch_attempt',
      'autoforge_knowledge_finalize_embedding_revocation',
    ])
  })

  it('converges interleaved revocation request receipts on one authoritative epoch', async () => {
    let consentState: 'revoking' | 'revoked' = 'revoking'
    let releaseA!: () => void
    const holdA = new Promise<void>(resolve => { releaseA = resolve })
    const receipts = new Map<string, {
      state: 'revoking' | 'revoked'
      consentEpoch: number
      vectorsDeleted: number
      rebuildRequired: boolean
    }>()
    const rpc = vi.fn().mockImplementation(async (name: string, parameters: {
      p_request_id?: string
    }) => {
      const requestId = parameters.p_request_id ?? ''
      if (name === 'autoforge_knowledge_set_embedding_consent') {
        const response = consentState === 'revoked'
          ? { state: 'revoked' as const, consentEpoch: 7, vectorsDeleted: 9,
            rebuildRequired: false }
          : { state: 'revoking' as const, consentEpoch: 7, vectorsDeleted: 0,
            rebuildRequired: false }
        receipts.set(requestId, response)
        return response
      }
      if (name === 'autoforge_knowledge_get_embedding_revocation_attempt') {
        if (requestId === 'revoke_A' && consentState === 'revoking') await holdA
        return { attempt: null }
      }
      if (name === 'autoforge_knowledge_finalize_embedding_revocation') {
        consentState = 'revoked'
        const authoritative = {
          state: 'revoked' as const, consentEpoch: 7, vectorsDeleted: 9,
          rebuildRequired: false,
        }
        for (const receiptId of receipts.keys()) receipts.set(receiptId, authoritative)
        return receipts.get(requestId)
      }
      throw new Error(`unexpected rpc ${name}`)
    })
    const handler = createKnowledgeHandler({ rpc })
    const revokeA = handler({
      action: 'setEmbeddingConsent', requestId: 'revoke_A', enabled: false,
    }, context)
    await vi.waitFor(() => expect(rpc.mock.calls.some(([name, parameters]) => (
      name === 'autoforge_knowledge_get_embedding_revocation_attempt'
        && parameters.p_request_id === 'revoke_A'
    ))).toBe(true))
    const revokeB = handler({
      action: 'setEmbeddingConsent', requestId: 'revoke_B', enabled: false,
    }, context)

    await expect(revokeB).resolves.toMatchObject({ ok: true, data: {
      state: 'revoked', consentEpoch: 7, vectorsDeleted: 9,
    } })
    releaseA()
    await expect(revokeA).resolves.toMatchObject({ ok: true, data: {
      state: 'revoked', consentEpoch: 7, vectorsDeleted: 9,
    } })
    expect(receipts.get('revoke_A')).toEqual(receipts.get('revoke_B'))
  })

  it('stays keyword-only after grant until a rebuilt generation is atomically published', async () => {
    const tokenHub = { embed: vi.fn() }
    const rpc = vi.fn()
      .mockResolvedValueOnce({ state: 'granted', consentEpoch: 5, rebuildRequired: true })
      .mockResolvedValueOnce({
        generations: [{ knowledgeBaseId: 'kb_1', generationId: 'generation_old',
          previousGenerationId: null }], embedding, driftProbeRequired: true,
        keywordCandidates: [{
          ...cloudCandidate('chunk_keyword', 1), generationId: 'generation_old',
        }],
      })
    const handler = createKnowledgeHandler({ rpc, tokenHub })
    await expect(handler({
      action: 'searchKnowledge', requestId: 'search_rebuild', query: '合同 条款',
      knowledgeBaseIds: ['kb_1'], limit: 8,
    }, context)).resolves.toMatchObject({ ok: true, data: {
      strategy: 'keyword_only_rebuild', driftProbeRequired: true, vectorCandidates: [],
    } })
    expect(tokenHub.embed).not.toHaveBeenCalled()
  })

  it('rejects a combined success envelope above one MiB', async () => {
    const vector = Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0)
    const largeCandidates = (prefix: string) => Array.from({ length: 12 }, (_, index) => ({
      ...cloudCandidate(`${prefix}_${index}`, index + 1), body: '界'.repeat(18_000),
    }))
    const rpc = vi.fn()
      .mockResolvedValueOnce({ state: 'granted', consentEpoch: 2, rebuildRequired: false })
      .mockResolvedValueOnce({
        generations: [{ knowledgeBaseId: 'kb_1', generationId: 'generation_1',
          previousGenerationId: null }], embedding, driftProbeRequired: false,
        keywordCandidates: largeCandidates('keyword'),
      })
      .mockResolvedValueOnce(permit('query', 'search_oversized'))
      .mockResolvedValueOnce({ reserved: true })
      .mockResolvedValueOnce({ started: true })
      .mockResolvedValueOnce({ recorded: true })
      .mockResolvedValueOnce({ settled: true })
      .mockResolvedValueOnce({ state: 'granted', consentEpoch: 2, rebuildRequired: false })
      .mockResolvedValueOnce({ vectorCandidates: largeCandidates('vector') })
    const handler = createKnowledgeHandler({
      rpc, tokenHub: { embed: vi.fn().mockResolvedValue(vector) },
    })
    await expect(handler({
      action: 'searchKnowledge', requestId: 'search_oversized', query: '合同 条款',
      knowledgeBaseIds: ['kb_1'], limit: 24,
    }, context)).resolves.toEqual({ ok: false, error: { code: 'INTERNAL_ERROR' } })
  })

  it('stops a held generation after revocation without storing or sending another chunk', async () => {
    let consentEnabled = true
    let dispatchActive = true
    let settleDispatch!: () => void
    const dispatchSettled = new Promise<void>(resolve => { settleDispatch = resolve })
    let releaseEmbedding!: (value: number[]) => void
    const heldEmbedding = new Promise<number[]>(resolve => { releaseEmbedding = resolve })
    const tokenHub = {
      embed: vi.fn().mockReturnValue(heldEmbedding),
      recoverAttempt: vi.fn().mockResolvedValue({ state: 'pending' }),
    }
    const rpc = vi.fn().mockImplementation(async (name: string) => {
      if (name === 'autoforge_knowledge_claim_embedding_batch') return {
        ownerId: context.auth.uid, knowledgeBaseId: 'kb_1', generationId: 'generation_shadow',
        consentEpoch: 6,
        chunks: [
          { id: 'chunk_1', versionId: 'version_1', body: 'first' },
          { id: 'chunk_2', versionId: 'version_1', body: 'second' },
        ],
      }
      if (name === 'autoforge_knowledge_issue_embedding_dispatch_permit') {
        return { ...permit('chunk', 'job_1:chunk_1'), consentEpoch: 6 }
      }
      if (name === 'autoforge_knowledge_reserve_embedding_dispatch_attempt') {
        return { reserved: true }
      }
      if (name === 'autoforge_knowledge_mark_embedding_dispatch_started') {
        return { started: true }
      }
      if (name === 'autoforge_knowledge_record_embedding_dispatch_settlement_intent') {
        return { recorded: true }
      }
      if (name === 'autoforge_knowledge_settle_embedding_dispatch_attempt') {
        dispatchActive = false
        settleDispatch()
        return { settled: true }
      }
      if (name === 'autoforge_knowledge_assert_embedding_consent') return {
        enabled: consentEnabled, consentEpoch: consentEnabled ? 6 : 7,
      }
      if (name === 'autoforge_knowledge_set_embedding_consent') {
        consentEnabled = false
        return {
          state: 'revoking', consentEpoch: 7, vectorsDeleted: 0, rebuildRequired: false,
        }
      }
      if (name === 'autoforge_knowledge_get_embedding_revocation_attempt') {
        return { attempt: dispatchActive ? {
          state: 'started', permitId: 'permit_job_1:chunk_1', purpose: 'chunk',
          requestId: 'job_1:chunk_1', attemptId: 1, consentEpoch: 6,
          providerRequestKey: 'embed_job_1:chunk_1_1', outcome: null,
          responseHash: null, retryable: false, knowledgeBaseId: 'kb_1',
          generationId: 'generation_shadow', chunkId: 'chunk_1', embedding,
        } : null }
      }
      if (name === 'autoforge_knowledge_finalize_embedding_revocation') {
        if (dispatchActive) await dispatchSettled
        return {
          state: 'revoked', consentEpoch: 7, vectorsDeleted: 12, rebuildRequired: false,
        }
      }
      if (name === 'autoforge_knowledge_store_embedding') throw new Error('must not store')
      throw new Error(`unexpected rpc ${name}`)
    })
    const worker = createEmbeddingGenerationWorker({ rpc, tokenHub })
    const run = worker.run({ workerId: 'worker_1', jobId: 'job_1', leaseToken: 'lease_1' })
    await vi.waitFor(() => expect(tokenHub.embed).toHaveBeenCalledOnce())

    const handler = createKnowledgeHandler({ rpc, tokenHub })
    let revokeReturned = false
    const revoke = handler({
      action: 'setEmbeddingConsent', requestId: 'revoke_1', enabled: false,
    }, context).finally(() => { revokeReturned = true })
    await vi.waitFor(() => expect(consentEnabled).toBe(false))
    expect(revokeReturned).toBe(false)
    releaseEmbedding(Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0))

    await expect(run).resolves.toEqual({ state: 'revoked', embedded: 0 })
    await expect(revoke).resolves.toMatchObject({ ok: true, data: { state: 'revoked' } })
    expect(tokenHub.embed).toHaveBeenCalledOnce()
    expect(rpc.mock.calls.some(([name]) => name === 'autoforge_knowledge_store_embedding')).toBe(false)
  })

  it('never starts a reserved worker send after revocation has begun', async () => {
    let consentState: 'granted' | 'revoking' | 'revoked' = 'granted'
    let attemptActive = true
    let releaseStart!: () => void
    let settleAttempt!: () => void
    const startGate = new Promise<void>(resolve => { releaseStart = resolve })
    const attemptSettled = new Promise<void>(resolve => { settleAttempt = resolve })
    const tokenHub = { embed: vi.fn() }
    const rpc = vi.fn().mockImplementation(async (name: string) => {
      if (name === 'autoforge_knowledge_claim_embedding_batch') return {
        ownerId: context.auth.uid, knowledgeBaseId: 'kb_1', generationId: 'generation_shadow',
        consentEpoch: 6,
        chunks: [{ id: 'chunk_1', versionId: 'version_1', body: 'first' }],
      }
      if (name === 'autoforge_knowledge_issue_embedding_dispatch_permit') {
        return { ...permit('chunk', 'job_1:chunk_1'), consentEpoch: 6 }
      }
      if (name === 'autoforge_knowledge_reserve_embedding_dispatch_attempt') {
        return { reserved: true }
      }
      if (name === 'autoforge_knowledge_mark_embedding_dispatch_started') {
        await startGate
        attemptActive = false
        settleAttempt()
        return { started: consentState === 'granted' }
      }
      if (name === 'autoforge_knowledge_set_embedding_consent') {
        consentState = 'revoking'
        return {
          state: 'revoking', consentEpoch: 7, vectorsDeleted: 0, rebuildRequired: false,
        }
      }
      if (name === 'autoforge_knowledge_get_embedding_revocation_attempt') {
        return { attempt: null }
      }
      if (name === 'autoforge_knowledge_finalize_embedding_revocation') {
        if (attemptActive) await attemptSettled
        consentState = 'revoked'
        return {
          state: 'revoked', consentEpoch: 7, vectorsDeleted: 0, rebuildRequired: false,
        }
      }
      throw new Error(`unexpected rpc ${name}`)
    })
    const worker = createEmbeddingGenerationWorker({ rpc, tokenHub })
    const run = worker.run({ workerId: 'worker_1', jobId: 'job_1', leaseToken: 'lease_1' })
    await vi.waitFor(() => expect(rpc.mock.calls.some(
      ([name]) => name === 'autoforge_knowledge_mark_embedding_dispatch_started',
    )).toBe(true))

    let revokeReturned = false
    const handler = createKnowledgeHandler({ rpc, tokenHub })
    const revoke = handler({
      action: 'setEmbeddingConsent', requestId: 'revoke_worker_race', enabled: false,
    }, context).finally(() => { revokeReturned = true })
    await vi.waitFor(() => expect(consentState).toBe('revoking'))
    expect(revokeReturned).toBe(false)
    releaseStart()

    await expect(run).resolves.toEqual({ state: 'revoked', embedded: 0 })
    await expect(revoke).resolves.toMatchObject({ ok: true, data: { state: 'revoked' } })
    expect(tokenHub.embed).not.toHaveBeenCalled()
    expect(rpc.mock.calls.some(([name]) => name === 'autoforge_knowledge_store_embedding')).toBe(false)
  })

  it('rejects non-1024 TokenHub output and never persists it', async () => {
    const rpc = vi.fn().mockImplementation(async (name: string) => {
      if (name === 'autoforge_knowledge_claim_embedding_batch') return {
        ownerId: context.auth.uid, knowledgeBaseId: 'kb_1', generationId: 'generation_shadow',
        consentEpoch: 1, chunks: [{ id: 'chunk_1', versionId: 'version_1', body: 'one' }],
      }
      if (name === 'autoforge_knowledge_issue_embedding_dispatch_permit') {
        return { ...permit('chunk', 'job_1:chunk_1'), consentEpoch: 1 }
      }
      if (name === 'autoforge_knowledge_reserve_embedding_dispatch_attempt') {
        return { reserved: true }
      }
      if (name === 'autoforge_knowledge_mark_embedding_dispatch_started') {
        return { started: true }
      }
      if (name === 'autoforge_knowledge_record_embedding_dispatch_settlement_intent') {
        return { recorded: true }
      }
      if (name === 'autoforge_knowledge_settle_embedding_dispatch_attempt') {
        return { settled: true }
      }
      if (name === 'autoforge_knowledge_assert_embedding_consent') {
        return { enabled: true, consentEpoch: 1 }
      }
      throw new Error(`unexpected rpc ${name}`)
    })
    const worker = createEmbeddingGenerationWorker({
      rpc, tokenHub: { embed: vi.fn().mockResolvedValue([1, 2, 3]) },
    })
    await expect(worker.run({ workerId: 'worker_1', jobId: 'job_1', leaseToken: 'lease_1' }))
      .rejects.toEqual({ code: 'INVALID_EMBEDDING_RESPONSE' })
    expect(rpc.mock.calls.some(([name]) => name === 'autoforge_knowledge_store_embedding')).toBe(false)
  })

  it('drains bounded batches and marks the shadow ready only after vectors are stored', async () => {
    let claims = 0
    const vector = Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0)
    const rpc = vi.fn().mockImplementation(async (name: string, parameters: {
      p_request_deadline_ms?: number
    }) => {
      if (name === 'autoforge_knowledge_claim_embedding_batch') {
        claims += 1
        return {
          ownerId: context.auth.uid, knowledgeBaseId: 'kb_1',
          generationId: 'generation_shadow', consentEpoch: 4,
          chunks: claims === 1
            ? [{ id: 'chunk_1', versionId: 'version_1', body: 'one' }] : [],
        }
      }
      if (name === 'autoforge_knowledge_issue_embedding_dispatch_permit') {
        return { ...permit('chunk', 'job_1:chunk_1'), consentEpoch: 4 }
      }
      if (name === 'autoforge_knowledge_reserve_embedding_dispatch_attempt') {
        return { reserved: true }
      }
      if (name === 'autoforge_knowledge_mark_embedding_dispatch_started') {
        return { started: true }
      }
      if (name === 'autoforge_knowledge_record_embedding_dispatch_settlement_intent') {
        return { recorded: true }
      }
      if (name === 'autoforge_knowledge_settle_embedding_dispatch_attempt') {
        return { settled: true }
      }
      if (name === 'autoforge_knowledge_assert_embedding_consent') {
        return { enabled: true, consentEpoch: 4 }
      }
      if (name === 'autoforge_knowledge_store_embedding') return { stored: true }
      if (name === 'autoforge_knowledge_complete_embedding_generation') return { ready: true }
      throw new Error(`unexpected rpc ${name}`)
    })
    const worker = createEmbeddingGenerationWorker({
      rpc, tokenHub: { embed: vi.fn().mockResolvedValue(vector) },
    })
    const requestBoundary = {
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 5_000,
      timeoutMs: 5_000,
    }
    await expect(worker.run({
      workerId: 'worker_1', jobId: 'job_1', leaseToken: 'lease_1',
    }, requestBoundary))
      .resolves.toEqual({ state: 'completed', embedded: 1 })
    expect(claims).toBe(2)
    expect(rpc.mock.calls.map(([name]) => name)).toContain(
      'autoforge_knowledge_complete_embedding_generation',
    )
    const mutationNames = new Set([
      'autoforge_knowledge_issue_embedding_dispatch_permit',
      'autoforge_knowledge_reserve_embedding_dispatch_attempt',
      'autoforge_knowledge_mark_embedding_dispatch_started',
      'autoforge_knowledge_record_embedding_dispatch_settlement_intent',
      'autoforge_knowledge_settle_embedding_dispatch_attempt',
      'autoforge_knowledge_store_embedding',
      'autoforge_knowledge_complete_embedding_generation',
    ])
    const mutationCalls = rpc.mock.calls.filter(([name]) => mutationNames.has(name))
    expect(new Set(mutationCalls.map(([name]) => name))).toEqual(mutationNames)
    expect(mutationCalls.every(([, parameters]) => (
      parameters.p_request_deadline_ms === requestBoundary.deadlineAt
    ))).toBe(true)
    expect(mutationCalls.every(([, parameters]) => (
      parameters.p_worker_id === 'worker_1'
        && parameters.p_job_id === 'job_1'
        && parameters.p_lease_token === 'lease_1'
    ))).toBe(true)
  })

  it('returns a resumable partial result after one configured embedding slice', async () => {
    let claims = 0
    const vector = Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0)
    const rpc = vi.fn().mockImplementation(async (name: string, parameters: {
      p_request_id?: string
    }) => {
      if (name === 'autoforge_knowledge_claim_embedding_batch') {
        claims += 1
        return {
          ownerId: context.auth.uid, knowledgeBaseId: 'kb_1',
          generationId: 'generation_shadow', consentEpoch: 4,
          chunks: claims === 1 ? [
            { id: 'chunk_1', versionId: 'version_1', body: 'one' },
            { id: 'chunk_2', versionId: 'version_1', body: 'two' },
          ] : [{ id: 'chunk_3', versionId: 'version_1', body: 'three' }],
        }
      }
      if (name === 'autoforge_knowledge_issue_embedding_dispatch_permit') {
        return { ...permit('chunk', parameters.p_request_id ?? ''), consentEpoch: 4 }
      }
      if (name === 'autoforge_knowledge_reserve_embedding_dispatch_attempt') {
        return { reserved: true }
      }
      if (name === 'autoforge_knowledge_mark_embedding_dispatch_started') {
        return { started: true }
      }
      if (name === 'autoforge_knowledge_record_embedding_dispatch_settlement_intent') {
        return { recorded: true }
      }
      if (name === 'autoforge_knowledge_settle_embedding_dispatch_attempt') {
        return { settled: true }
      }
      if (name === 'autoforge_knowledge_assert_embedding_consent') {
        return { enabled: true, consentEpoch: 4 }
      }
      if (name === 'autoforge_knowledge_store_embedding') return { stored: true }
      throw new Error(`unexpected rpc ${name}`)
    })
    const tokenHub = { embed: vi.fn().mockResolvedValue(vector) }
    const worker = createEmbeddingGenerationWorker({
      rpc, tokenHub, maximumChunksPerRun: 2,
    })

    const requestBoundary = {
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 5_000,
      timeoutMs: 5_000,
    }

    await expect(worker.run({
      workerId: 'worker_1', jobId: 'job_1', leaseToken: 'lease_1',
    }, requestBoundary)).resolves.toEqual({ state: 'partial', embedded: 2 })
    expect(claims).toBe(2)
    expect(tokenHub.embed).toHaveBeenCalledTimes(2)
    expect(tokenHub.embed.mock.calls.every(call => call[1] === requestBoundary)).toBe(true)
    expect(rpc.mock.calls.every(call => call[2] === requestBoundary)).toBe(true)
    expect(rpc.mock.calls.some(([name]) => (
      name === 'autoforge_knowledge_complete_embedding_generation'
    ))).toBe(false)
  })
})
