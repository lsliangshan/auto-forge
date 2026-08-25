import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  createKnowledgeHandler,
  createPostgresRpcClient,
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
})

describe('CloudBase knowledge migration contract', () => {
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
      'knowledge_entitlements',
    ]) {
      expect(featureSql).toContain(`CREATE TABLE IF NOT EXISTS public.${table}`)
      expect(featureSql).toContain(`'${table}'`)
      expect(rollback).toContain(`DROP TABLE IF EXISTS public.${table}`)
    }
    expect(featureSql).toContain("EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY'")
    expect(featureSql).toContain("EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY'")
    expect(featureSql).toContain("owner_id = public.autoforge_knowledge_request_user_id()")
    expect(featureSql).toContain("interval '90 days'")
    expect(featureSql).toContain('lease_token')
    expect(featureSql).toContain('lease_expires_at')
    expect(featureSql).toContain('expected_published_generation_id')
    expect(featureSql).toContain('GENERATION_NOT_READY')
    expect(featureSql).toContain('CURSOR_STALE')
    expect(featureSql).toContain('autoforge_knowledge_version_lifecycle')
    expect(featureSql).toContain('autoforge_knowledge_generation_lifecycle')
    expect(featureSql).toContain('knowledge_changes_immutable')
    expect(featureSql).toContain('input_hash char(32) NOT NULL')
    expect(featureSql).toContain("RAISE EXCEPTION USING MESSAGE = 'CONFLICT'")
    expect(featureSql).toContain('pg_advisory_xact_lock')
    expect(featureSql).not.toMatch(/GRANT\s+(?:ALL|SELECT|INSERT|UPDATE|DELETE)[^;]*\bTO\s+(?:PUBLIC|anon)\b/i)
  })
})
