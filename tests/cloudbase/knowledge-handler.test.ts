import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  createKnowledgeHandler,
  createPostgresRpcClient,
  createPostgresStorageClient,
} from '../../cloudbase/knowledge/function/knowledge-handler.js'

const context = { auth: { uid: '2089908515857502208' } }

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
    await handler({
      action: 'pushMutation', mutationId: 'mutation_1', knowledgeBaseId: 'kb_1',
      entityKind: 'document', entityId: 'document_1', operation: 'upsert',
      baseRevision: null, payload: {}, userId: 'attacker', ownerId: 'attacker',
    }, context)

    expect(rpc).toHaveBeenCalledWith('autoforge_knowledge_push_mutation', {
      p_caller_user_id: '2089908515857502208', p_mutation_id: 'mutation_1',
      p_knowledge_base_id: 'kb_1', p_entity_kind: 'document', p_entity_id: 'document_1',
      p_operation: 'upsert', p_base_revision: null, p_payload: {},
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
      documentId: 'document_1', versionId: 'version_1', byteSize: 0, sha256: 'bad',
    }, context)).resolves.toEqual({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('masks server details and keeps service credentials inside the function RPC client', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: vi.fn().mockResolvedValue({ tier: 'member' }),
    })
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

  it('returns a consumable expiring PG Storage authorization and verifies uploaded bytes', async () => {
    const sha256 = 'a'.repeat(64)
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        uploadTicket: 'ticket_1', storageReference: 'knowledge/1/kb_1/object_1',
        objectId: 'object_1', jobId: 'job_1', expiresAt: '2026-08-26T12:15:00.000Z',
      })
      .mockResolvedValueOnce({
        objectId: 'object_1', storageReference: 'knowledge/1/kb_1/object_1',
        expectedByteSize: 42, expectedSha256: sha256,
      })
      .mockResolvedValueOnce({
        objectId: 'object_1', storageReference: 'knowledge/1/kb_1/object_1', verified: true,
      })
    const storage = {
      createUploadAuthorization: vi.fn().mockResolvedValue({
        url: 'https://pg-storage.example/upload/ticket_1', method: 'PUT',
        headers: { 'content-length': '42', 'x-content-sha256': sha256 },
        expiresAt: '2026-08-26T12:15:00.000Z',
      }),
      statObject: vi.fn().mockResolvedValue({ byteSize: 42, sha256 }),
      deleteObjects: vi.fn(),
    }
    const handler = createKnowledgeHandler({ rpc, storage })

    await expect(handler({
      action: 'authorizeUpload', requestId: 'upload_1', knowledgeBaseId: 'kb_1',
      documentId: 'document_1', versionId: 'version_1', byteSize: 42, sha256,
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
      p_actual_byte_size: 42, p_actual_sha256: sha256,
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

  it('keeps storage service credentials server-side in the PG Storage adapter', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200, json: vi.fn().mockResolvedValue({
        url: 'https://pg-storage.example/upload/ticket', method: 'PUT', headers: {},
        expiresAt: '2026-08-26T12:15:00.000Z',
        }),
      })
      .mockResolvedValueOnce({
        ok: true, status: 204, json: vi.fn().mockRejectedValue(new Error('empty')),
      })
    const storage = createPostgresStorageClient({
      baseUrl: 'https://pg-storage.example/v1/storage', serviceKey: 'server-only', fetchImpl,
    })
    await storage.createUploadAuthorization({
      uploadTicket: 'ticket_1', storageReference: 'knowledge/1/kb_1/object_1',
      byteSize: 42, sha256: 'a'.repeat(64), expiresAt: '2026-08-26T12:15:00.000Z',
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://pg-storage.example/v1/storage/upload-authorizations',
      expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer server-only' }) }),
    )
    await expect(storage.deleteObjects(['knowledge/1/kb_1/object_1'])).resolves.toBeUndefined()
  })
})

describe('CloudBase knowledge migration contract', () => {
  it('replays a persisted conflict receipt only for the original mutation input', async () => {
    const sql = await readFile(
      new URL('../../cloudbase/knowledge/migrations/0001_personal_knowledge.sql', import.meta.url),
      'utf8',
    )
    const pushMutation = sql.match(
      /CREATE OR REPLACE FUNCTION public\.autoforge_knowledge_push_mutation[\s\S]*?\n\$\$;/,
    )?.[0]

    expect(pushMutation).toBeDefined()
    expect(sql).toContain('input_hash char(32) NOT NULL')
    expect(sql).toContain('response jsonb NOT NULL')
    expect(pushMutation).toContain('SELECT * INTO existing_conflict FROM public.knowledge_conflicts')
    expect(pushMutation).toContain('existing_conflict.input_hash <> fingerprint')
    expect(pushMutation).toContain('RETURN existing_conflict.response')
    expect(pushMutation).toContain('input_hash, response')
  })

  it('reserves orphan cleanup so upload verification and deletion cannot both win', async () => {
    const sql = await readFile(
      new URL('../../cloudbase/knowledge/migrations/0001_personal_knowledge.sql', import.meta.url),
      'utf8',
    )
    const verifyUpload = sql.match(
      /CREATE OR REPLACE FUNCTION public\.autoforge_knowledge_verify_upload[\s\S]*?\n\$\$;/,
    )?.[0]
    const prepareCleanup = sql.match(
      /CREATE OR REPLACE FUNCTION public\.autoforge_knowledge_prepare_orphan_cleanup[\s\S]*?\n\$\$;/,
    )?.[0]
    const completeCleanup = sql.match(
      /CREATE OR REPLACE FUNCTION public\.autoforge_knowledge_complete_orphan_cleanup[\s\S]*?\n\$\$;/,
    )?.[0]

    expect(sql).toContain("'cleanup_reserved'")
    expect(prepareCleanup).toContain("SET state = 'cleanup_reserved'")
    expect(prepareCleanup).toContain('cleanup_request_id = p_request_id')
    expect(prepareCleanup).toContain('RETURNING object.storage_reference')
    expect(prepareCleanup).toContain('RETURN request_row.response')
    expect(verifyUpload).toContain("object.state IN ('authorized', 'uploaded')")
    expect(verifyUpload).toContain("IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'CONFLICT'")
    expect(completeCleanup).toContain("object.state = 'cleanup_reserved'")
    expect(completeCleanup).toContain('object.cleanup_request_id = p_request_id')
    expect(completeCleanup).toContain("SET state = 'deleted'")
  })

  it('rejects cross-document version and block tuples inside one knowledge base', async () => {
    const sql = await readFile(
      new URL('../../cloudbase/knowledge/migrations/0001_personal_knowledge.sql', import.meta.url),
      'utf8',
    )
    const versions = sql.match(
      /CREATE TABLE IF NOT EXISTS public\.knowledge_versions \([\s\S]*?\n\);/,
    )?.[0]
    const blocks = sql.match(
      /CREATE TABLE IF NOT EXISTS public\.knowledge_blocks \([\s\S]*?\n\);/,
    )?.[0]
    const chunks = sql.match(
      /CREATE TABLE IF NOT EXISTS public\.knowledge_chunks \([\s\S]*?\n\);/,
    )?.[0]

    expect(versions).toContain('UNIQUE(owner_id, knowledge_base_id, document_id, id)')
    expect(blocks).toContain('UNIQUE(owner_id, knowledge_base_id, version_id, id)')
    expect(chunks).toContain(
      'FOREIGN KEY(owner_id, knowledge_base_id, document_id, version_id)',
    )
    expect(chunks).toContain(
      'REFERENCES public.knowledge_versions(owner_id, knowledge_base_id, document_id, id)',
    )
    expect(chunks).toContain('FOREIGN KEY(owner_id, knowledge_base_id, version_id, block_id)')
    expect(chunks).toContain(
      'REFERENCES public.knowledge_blocks(owner_id, knowledge_base_id, version_id, id)',
    )
    expect(sql).toContain(
      'FOREIGN KEY(owner_id, knowledge_base_id, id, active_version_id)',
    )
    expect(sql).toContain(
      'REFERENCES public.knowledge_versions(owner_id, knowledge_base_id, document_id, id)',
    )
  })

  it('ships matching versioned migration and rollback artifacts with owner RLS', async () => {
    const featureSql = await readFile(
      new URL('../../cloudbase/knowledge/migrations/0001_personal_knowledge.sql', import.meta.url), 'utf8',
    )
    const versionedSql = await readFile(
      new URL('../../cloudbase/migrations/20260826120000_personal_knowledge.sql', import.meta.url), 'utf8',
    )
    const rollback = await readFile(
      new URL('../../cloudbase/knowledge/migrations/0001_personal_knowledge.rollback.sql', import.meta.url), 'utf8',
    )
    expect(versionedSql).toBe(featureSql)
    for (const table of [
      'knowledge_bases', 'knowledge_objects', 'knowledge_documents', 'knowledge_versions',
      'knowledge_parser_runs', 'knowledge_blocks', 'knowledge_chunks', 'knowledge_index_generations',
      'knowledge_jobs', 'knowledge_changes', 'knowledge_tombstones', 'knowledge_conflicts',
      'knowledge_sync_floors', 'knowledge_upload_authorizations', 'knowledge_entitlements',
    ]) {
      expect(featureSql).toContain(`CREATE TABLE IF NOT EXISTS public.${table}`)
      expect(featureSql).toContain(`'${table}'`)
      expect(rollback).toContain(`DROP TABLE IF EXISTS public.${table}`)
    }
    expect(featureSql).toContain("EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY'")
    expect(featureSql).toContain("EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY'")
    expect(featureSql).toContain("owner_id = public.autoforge_knowledge_request_user_id()")
    expect(featureSql).toContain("interval '90 days'")
    expect(featureSql).toContain('CREATE TABLE IF NOT EXISTS public.knowledge_sync_floors')
    expect(featureSql).toContain('autoforge_knowledge_cleanup_retention')
    expect(featureSql).toContain("'kind', 'snapshot'")
    expect(featureSql).toContain("'hasMore'")
    expect(featureSql).toContain('page_last_sequence')
    expect(featureSql).toContain('lease_token')
    expect(featureSql).toContain('lease_expires_at')
    expect(featureSql).toContain('expected_published_generation_id')
    expect(featureSql).toContain('GENERATION_NOT_READY')
    expect(featureSql).toContain("'kind', 'cursor_stale'")
    expect(featureSql).toContain('autoforge_knowledge_version_lifecycle')
    expect(featureSql).toContain('autoforge_knowledge_generation_lifecycle')
    expect(featureSql).toContain('knowledge_changes_immutable')
    expect(featureSql).toContain("error_code = 'LEASE_EXPIRED'")
    expect(featureSql).toContain("p_error_code = 'TRANSIENT_FAILURE'")
    expect(featureSql).toContain('CREATE TABLE IF NOT EXISTS public.knowledge_upload_authorizations')
    expect(featureSql).toContain('autoforge_knowledge_verify_upload')
    expect(featureSql).toContain('verified_at IS NULL')
    expect(featureSql).toContain('conflict_kind varchar(32) NOT NULL')
    expect(featureSql).toContain('input_hash char(32) NOT NULL')
    expect(featureSql).toContain("RAISE EXCEPTION USING MESSAGE = 'CONFLICT'")
    expect(featureSql).toContain('pg_advisory_xact_lock')
    expect(featureSql).toContain('FOREIGN KEY(owner_id, knowledge_base_id)')
    expect(featureSql).toContain('FOREIGN KEY(owner_id, knowledge_base_id, document_id)')
    expect(featureSql).toContain('FOREIGN KEY(owner_id, knowledge_base_id, source_object_id)')
    expect(featureSql).not.toContain('ON ALL SEQUENCES IN SCHEMA public')
    for (const sequence of [
      'knowledge_changes_sequence_seq', 'knowledge_tombstones_id_seq',
      'knowledge_conflicts_id_seq',
    ]) expect(featureSql).toContain(`ON SEQUENCE public.${sequence} TO service_role`)
    expect(featureSql).not.toMatch(/GRANT\s+(?:ALL|SELECT|INSERT|UPDATE|DELETE)[^;]*\bTO\s+(?:PUBLIC|anon)\b/i)
  })
})
