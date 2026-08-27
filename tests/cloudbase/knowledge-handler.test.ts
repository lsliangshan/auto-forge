import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  createKnowledgeHandler,
  createPostgresRpcClient,
  createPostgresStorageClient,
} from '../../cloudbase/knowledge/function/knowledge-handler.js'

const context = { auth: { uid: '2089908515857502208' } }
const futureExpiry = new Date(Date.now() + 15 * 60_000).toISOString()

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

  it('rejects extra keys on every public action before RPC or Storage', async () => {
    const rpc = vi.fn()
    const storage = {
      createUploadAuthorization: vi.fn(), statObject: vi.fn(), deleteObjects: vi.fn(),
    }
    const handler = createKnowledgeHandler({ rpc, storage })
    const sha256 = 'a'.repeat(64)
    const events = [
      { action: 'beginSync', requestId: 'r', knowledgeBaseId: 'kb', name: 'n', revision: 'v', generationId: 'g' },
      { action: 'authorizeUpload', requestId: 'r', knowledgeBaseId: 'kb', documentId: 'd', versionId: 'v', byteSize: 1, sha256, mimeType: 'text/plain' },
      { action: 'completeUpload', uploadTicket: 't' },
      { action: 'pushMutation', mutationId: 'm', knowledgeBaseId: 'kb', entityKind: 'document', entityId: 'd', operation: 'upsert', baseRevision: null, payload: {} },
      { action: 'pullChanges', knowledgeBaseId: 'kb', afterSequence: 0, limit: 1, maxBytes: 65536 },
      { action: 'fullResync', knowledgeBaseId: 'kb', snapshotId: null, afterOrdinal: 0, limit: 1, maxBytes: 65536 },
      { action: 'publishGeneration', requestId: 'r', knowledgeBaseId: 'kb', generationId: 'g', expectedPublishedGenerationId: null },
      { action: 'deleteKnowledgeBase', requestId: 'r', knowledgeBaseId: 'kb', expectedPublishedGenerationId: null },
      { action: 'cancelJob', requestId: 'r', jobId: 'j' },
      { action: 'cleanupOrphans', requestId: 'r', knowledgeBaseId: 'kb', storageReferences: ['knowledge/1/kb/o'] },
      { action: 'getJob', jobId: 'j' },
      { action: 'getEntitlement' },
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

  it('returns a consumable expiring PG Storage authorization and verifies uploaded bytes', async () => {
    const sha256 = 'a'.repeat(64)
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        uploadTicket: 'ticket_1', storageReference: 'knowledge/1/kb_1/object_1',
        objectId: 'object_1', jobId: 'job_1', mimeType: 'text/plain',
        expiresAt: futureExpiry,
      })
      .mockResolvedValueOnce({
        objectId: 'object_1', storageReference: 'knowledge/1/kb_1/object_1',
        expectedByteSize: 42, expectedSha256: sha256, expectedMimeType: 'text/plain',
      })
      .mockResolvedValueOnce({
        objectId: 'object_1', storageReference: 'knowledge/1/kb_1/object_1', verified: true,
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
    expect(storage.statObject).toHaveBeenCalledWith('knowledge/1/kb_1/object_1')
    expect(rpc).toHaveBeenNthCalledWith(3, 'autoforge_knowledge_verify_upload', {
      p_caller_user_id: '2089908515857502208', p_upload_ticket: 'ticket_1',
      p_actual_byte_size: 42, p_actual_sha256: sha256, p_actual_mime_type: 'text/plain',
    })
  })

  it('rejects upload authorization outside the configured HTTPS path or with credential headers', async () => {
    const rpc = vi.fn().mockResolvedValue({
      uploadTicket: 'ticket_1', storageReference: 'knowledge/1/kb_1/object_1',
      objectId: 'object_1', jobId: 'job_1', mimeType: 'text/plain',
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
      .mockResolvedValueOnce(streamedResponse(undefined, 204))
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
  })
})
