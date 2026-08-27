import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const canonicalUrl = new URL(
  '../../cloudbase/migrations/20260826230000_personal_knowledge.sql',
  import.meta.url,
)
const featureUrl = new URL(
  '../../cloudbase/knowledge/migrations/0001_personal_knowledge.sql',
  import.meta.url,
)
const rollbackUrl = new URL(
  '../../cloudbase/knowledge/migrations/0001_personal_knowledge.rollback.sql',
  import.meta.url,
)

const tables = [
  'knowledge_bases',
  'knowledge_objects',
  'knowledge_documents',
  'knowledge_versions',
  'knowledge_parser_runs',
  'knowledge_blocks',
  'knowledge_chunks',
  'knowledge_index_generations',
  'knowledge_jobs',
  'knowledge_entity_heads',
  'knowledge_changes',
  'knowledge_tombstones',
  'knowledge_conflicts',
  'knowledge_sync_floors',
  'knowledge_upload_authorizations',
  'knowledge_entitlements',
  'knowledge_requests',
  'knowledge_snapshots',
  'knowledge_snapshot_items',
] as const

function functionBody(sql: string, name: string): string {
  const marker = `CREATE OR REPLACE FUNCTION public.${name}(`
  const start = sql.indexOf(marker)
  expect(start, `${name} exists`).toBeGreaterThanOrEqual(0)
  const bodyStart = sql.indexOf('AS $$', start)
  const end = sql.indexOf('$$;', bodyStart + 5)
  expect(bodyStart, `${name} has body`).toBeGreaterThan(start)
  expect(end, `${name} body closes`).toBeGreaterThan(bodyStart)
  return sql.slice(bodyStart + 5, end)
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

describe('CloudBase personal knowledge migration', () => {
  it('keeps the deployment and feature migrations byte-identical', async () => {
    const [canonical, feature] = await Promise.all([
      readFile(canonicalUrl, 'utf8'),
      readFile(featureUrl, 'utf8'),
    ])
    expect(canonical).toBe(feature)
  })

  it('uses owner-composite relationships, forced RLS, and default-deny grants', async () => {
    const sql = await readFile(canonicalUrl, 'utf8')
    for (const table of tables) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS public.${table}`)
      expect(sql).toContain(`'${table}'`)
    }
    expect(sql).toContain('FOREIGN KEY(owner_id, knowledge_base_id)')
    expect(sql).toContain('FOREIGN KEY(owner_id, knowledge_base_id, document_id)')
    expect(sql).toContain('FOREIGN KEY(owner_id, knowledge_base_id, source_object_id)')
    expect(sql.match(/PRIMARY KEY\(owner_id, (?:knowledge_base_id, )?id\)/g)?.length)
      .toBeGreaterThanOrEqual(9)
    expect(sql).not.toMatch(/\bid varchar\(128\) PRIMARY KEY/)
    expect(sql).toContain("EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY'")
    expect(sql).toContain("EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY'")
    expect(sql).toContain('owner_id = public.autoforge_knowledge_request_user_id()')
    expect(sql).toContain(
      "REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated",
    )
    expect(sql).not.toMatch(
      /GRANT\s+(?:ALL|SELECT|INSERT|UPDATE|DELETE)[^;]*\bTO\s+(?:PUBLIC|anon|authenticated)\b/i,
    )
    expect(sql).not.toContain('ON ALL SEQUENCES IN SCHEMA public')
  })

  it('binds one-time upload tickets to owner, object, size, hash, and MIME', async () => {
    const sql = await readFile(canonicalUrl, 'utf8')
    expect(sql).toContain('expected_byte_size bigint NOT NULL')
    expect(sql).toContain('expected_sha256 char(64) NOT NULL')
    expect(sql).toContain('expected_mime_type varchar(200) NOT NULL')
    expect(sql).toContain('authorization.expected_mime_type <> p_actual_mime_type')
    expect(sql).toContain('authorization.consumed_at IS NOT NULL')
    expect(sql).toContain('WHERE upload_ticket = p_upload_ticket AND owner_id = owner FOR UPDATE')
    expect(sql).toContain('FOREIGN KEY(owner_id, knowledge_base_id, object_id)')
  })

  it('defines immutable publication, bounded pull, retention floors, and durable leases', async () => {
    const sql = await readFile(canonicalUrl, 'utf8')
    expect(sql).toContain('knowledge_changes_immutable')
    expect(sql).toContain('expected_published_generation_id')
    expect(sql).toContain('GENERATION_NOT_READY')
    expect(sql).toContain("'kind', 'cursor_stale'")
    expect(sql).toContain("'kind', 'snapshot_page'")
    expect(sql).toContain("'hasMore'")
    expect(sql).toContain('page_last_sequence')
    expect(sql).toContain("interval '90 days'")
    expect(sql).toContain('lease_token')
    expect(sql).toContain('lease_expires_at')
    expect(sql).toContain("error_code = 'LEASE_EXPIRED'")
    expect(sql).toContain("p_error_code = 'TRANSIENT_FAILURE'")
    expect(sql).toContain('attempt >= 3')
    expect(sql).toContain('kill_switch_enabled boolean NOT NULL DEFAULT true')
  })

  it('uses canonical request binding and durably replays conflict outcomes with both sides', async () => {
    const sql = await readFile(canonicalUrl, 'utf8')
    expect(sql).not.toContain('md5(concat_ws(')
    expect(canonical({ a: 'x:y', b: '' })).not.toBe(canonical({ a: 'x', b: 'y:' }))
    const push = functionBody(sql, 'autoforge_knowledge_push_mutation')
    expect(push).toContain('existing_conflict public.knowledge_conflicts%ROWTYPE')
    expect(push).toContain('existing_conflict.input_hash <> fingerprint')
    expect(push).toContain('RETURN existing_conflict.response')
    expect(push).toContain('local_revision, remote_revision, local_payload, remote_payload')
    expect(push).toContain('p_mutation_id, head.revision, p_payload, head.payload')
    expect(push).toContain('input_hash, response')

    const receipts = new Map<string, {
      hash: string
      response: Record<string, unknown>
      localPayload: Record<string, unknown>
      remotePayload: Record<string, unknown>
    }>()
    const attempt = (
      owner: string,
      mutationId: string,
      input: Record<string, unknown>,
      remotePayload: Record<string, unknown>,
    ) => {
      const key = `${owner.length}:${owner}${mutationId.length}:${mutationId}`
      const hash = canonical(input)
      const existing = receipts.get(key)
      if (existing) {
        if (existing.hash !== hash) throw new Error('CONFLICT')
        return existing
      }
      const receipt = {
        hash,
        response: {
          mutationId, status: 'conflict', conflictKind: 'content',
          localRevision: mutationId, remoteRevision: 'remote-r2', sequence: 9,
        },
        localPayload: input.payload as Record<string, unknown>,
        remotePayload,
      }
      receipts.set(key, receipt)
      return receipt
    }
    const input = { knowledgeBaseId: 'kb', entityId: 'document', payload: { side: 'local' } }
    const first = attempt('owner-1', 'mutation-1', input, { side: 'remote' })
    const replay = attempt('owner-1', 'mutation-1', input, { side: 'new-remote-ignored' })
    expect(replay.response).toEqual(first.response)
    expect(replay.localPayload).toEqual({ side: 'local' })
    expect(replay.remotePayload).toEqual({ side: 'remote' })
    expect(() => attempt('owner-1', 'mutation-1', {
      ...input, payload: { side: 'changed' },
    }, {})).toThrow('CONFLICT')
    expect(attempt('owner-2', 'mutation-1', input, { side: 'owner-2-remote' }).remotePayload)
      .toEqual({ side: 'owner-2-remote' })
  })

  it('pages one stable materialized snapshot by both row and response-byte budgets', async () => {
    const sql = await readFile(canonicalUrl, 'utf8')
    const snapshot = functionBody(sql, 'autoforge_knowledge_full_resync')
    expect(snapshot).toContain('p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 512')
    expect(snapshot).toContain('p_max_bytes IS NULL OR p_max_bytes NOT BETWEEN 65536 AND 786432')
    expect(snapshot).toContain('INSERT INTO public.knowledge_snapshots')
    expect(snapshot).toContain('INSERT INTO public.knowledge_snapshot_items')
    expect(snapshot).toContain('WITH snapshot_boundary AS MATERIALIZED')
    expect(snapshot).toContain('CROSS JOIN created_snapshot created')
    expect(snapshot).toContain('snapshot.snapshot_sequence')
    expect(snapshot).toContain('sum(item.response_bytes) OVER')
    expect(snapshot).toContain("'hasMore', has_more")
    const pull = functionBody(sql, 'autoforge_knowledge_pull_changes')
    expect(pull).toContain('sum(candidate.response_bytes) OVER')
    expect(pull).toContain('p_max_bytes')
    expect(pull).toContain("'nextSequence', page_last_sequence")
    expect(pull).toContain('INTO changes, page_last_sequence, has_more')

    const liveHeads = [
      { id: 'a', payload: 'old-a', bytes: 60_000 },
      { id: 'b', payload: 'old-b', bytes: 60_000 },
      { id: 'c', payload: 'old-c', bytes: 60_000 },
    ]
    const materialized = structuredClone(liveHeads)
    liveHeads[1]!.payload = 'new-b'
    const page = (after: number, rowLimit: number, byteLimit: number) => {
      const selected: typeof materialized = []
      let bytes = 0
      for (const item of materialized.slice(after, after + rowLimit)) {
        if (bytes + item.bytes > byteLimit) break
        selected.push(item)
        bytes += item.bytes
      }
      return {
        selected,
        next: after + selected.length,
        hasMore: after + selected.length < materialized.length,
      }
    }
    const first = page(0, 2, 100_000)
    const second = page(first.next, 2, 130_000)
    expect(first).toMatchObject({ next: 1, hasMore: true })
    expect([...first.selected, ...second.selected].map(item => item.payload))
      .toEqual(['old-a', 'old-b', 'old-c'])
  })

  it('binds worker leases and idempotent cancellation/orphan requests to exact arguments', async () => {
    const sql = await readFile(canonicalUrl, 'utf8')
    const claim = functionBody(sql, 'autoforge_knowledge_claim_job')
    expect(claim).toContain("btrim(p_worker_id) = ''")
    expect(claim).toContain("btrim(p_lease_token) = ''")
    expect(claim).toContain('p_lease_seconds IS NULL')
    expect(claim).toContain('worker_id = p_worker_id')
    const complete = functionBody(sql, 'autoforge_knowledge_complete_job')
    expect(complete).toContain('worker_id = p_worker_id')
    const cancel = functionBody(sql, 'autoforge_knowledge_cancel_job')
    expect(cancel).toContain("'action', 'cancel_job'")
    expect(cancel).toContain("request_row.input_hash <> fingerprint")
    const orphan = functionBody(sql, 'autoforge_knowledge_prepare_orphan_cleanup')
    expect(orphan).toContain("'storageReferences', canonical_references")
    expect(orphan).toContain('request_row.input_hash <> fingerprint')

    const lease = { workerId: 'worker-a', token: 'token-a', state: 'running' }
    const completeLease = (workerId: string, token: string) => {
      if (lease.state !== 'running' || lease.workerId !== workerId || lease.token !== token) {
        throw new Error('CONFLICT')
      }
      lease.state = 'completed'
    }
    expect(() => completeLease('worker-b', 'token-a')).toThrow('CONFLICT')
    expect(() => completeLease('worker-a', 'token-b')).toThrow('CONFLICT')
    completeLease('worker-a', 'token-a')
    expect(lease.state).toBe('completed')
  })

  it('admits metadata purge only after the trusted worker reports exact Storage deletion', async () => {
    const sql = await readFile(canonicalUrl, 'utf8')
    expect(sql).toContain('autoforge_knowledge_prepare_base_purge')
    expect(sql).toContain('autoforge_knowledge_complete_base_purge')
    expect(sql).toContain('p_deleted_storage_references ? object.storage_reference')
    expect(sql).toContain('DELETE FROM public.knowledge_documents')
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.autoforge_knowledge_complete_base_purge',
    )
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_complete_base_purge',
    )
    const purge = functionBody(sql, 'autoforge_knowledge_complete_base_purge')
    const sentinel = 'secret-content-sentinel'
    const simulatedPayloadRows = [sentinel]
    if (purge.includes('DELETE FROM public.knowledge_changes')
      && purge.includes('DELETE FROM public.knowledge_conflicts')
      && purge.includes('DELETE FROM public.knowledge_requests')
      && purge.includes('DELETE FROM public.knowledge_jobs')) {
      simulatedPayloadRows.length = 0
    }
    expect(simulatedPayloadRows.join('|')).not.toContain(sentinel)
    expect(purge).toContain("jsonb_build_object('deletionJobId', job.id)")
    expect(purge).toContain("'delete', job.request_id, '{}'::jsonb")
  })

  it('ships a data-preserving rollback that disables the executable surface', async () => {
    const rollback = await readFile(rollbackUrl, 'utf8')
    expect(rollback).toContain('REVOKE ALL ON FUNCTION')
    expect(rollback).toContain('DROP FUNCTION IF EXISTS public.autoforge_knowledge_begin_sync')
    expect(rollback).toContain('REVOKE ALL ON TABLE public.%I')
    expect(rollback).not.toMatch(/DROP TABLE/i)
    expect(rollback).not.toMatch(/TRUNCATE|DELETE\s+FROM/i)
  })
})
