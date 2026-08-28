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
  'knowledge_embedding_consents',
  'knowledge_chunk_embeddings',
  'knowledge_generation_memberships',
  'knowledge_embedding_dispatch_permits',
] as const

function staticFunctionBodyFragment(sql: string, name: string): string {
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
    expect(sql).toContain(
      'authorization.expected_mime_type IS DISTINCT FROM p_actual_mime_type',
    )
    expect(sql).toContain('authorization.consumed_at IS NOT NULL')
    expect(sql).toContain('WHERE upload_ticket = p_upload_ticket AND owner_id = owner FOR UPDATE')
    expect(sql).toContain('FOREIGN KEY(owner_id, knowledge_base_id, object_id)')
    const getUpload = staticFunctionBodyFragment(sql, 'autoforge_knowledge_get_upload')
    expect(getUpload).toContain("'ownerId', owner::text")
    expect(getUpload).toContain("'knowledgeBaseId', authorization.knowledge_base_id")
    expect(getUpload).toContain("'uploadTicket', authorization.upload_ticket")
    const verify = staticFunctionBodyFragment(sql, 'autoforge_knowledge_verify_upload')
    for (const fragment of [
      'authorization.knowledge_base_id IS DISTINCT FROM p_knowledge_base_id',
      'authorization.object_id IS DISTINCT FROM p_object_id',
      'object.storage_reference IS DISTINCT FROM p_storage_reference',
      'authorization.expected_byte_size IS DISTINCT FROM p_expected_byte_size',
      'authorization.expected_sha256 IS DISTINCT FROM p_expected_sha256',
      'authorization.expected_mime_type IS DISTINCT FROM p_expected_mime_type',
      'authorization.expected_byte_size IS DISTINCT FROM p_actual_byte_size',
      'authorization.expected_sha256 IS DISTINCT FROM p_actual_sha256',
      'authorization.expected_mime_type IS DISTINCT FROM p_actual_mime_type',
    ]) expect(verify).toContain(fragment)
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

  it('keeps authenticated owner cleanup available independently of cloud feature gates', async () => {
    const sql = await readFile(canonicalUrl, 'utf8')
    const cleanupGuard = staticFunctionBodyFragment(sql, 'autoforge_knowledge_require_cleanup')
    expect(cleanupGuard).toContain('FROM auth.users WHERE id = p_owner_id')
    expect(cleanupGuard).not.toContain('knowledge_entitlements')
    expect(cleanupGuard).not.toContain('kill_switch_enabled')
    const deleteBase = staticFunctionBodyFragment(sql, 'autoforge_knowledge_delete_base')
    expect(deleteBase).toContain('autoforge_knowledge_require_cleanup(owner)')
    expect(deleteBase).not.toContain('autoforge_knowledge_require_cloud(owner)')
    const revoke = staticFunctionBodyFragment(sql, 'autoforge_knowledge_set_embedding_consent')
    expect(revoke).toContain('IF p_enabled THEN PERFORM public.autoforge_knowledge_require_cloud(owner); END IF')
  })

  it('defines fixed consented embeddings, shadow isolation, atomic publication, and seven-day retention', async () => {
    const sql = await readFile(canonicalUrl, 'utf8')
    expect(sql).toContain("model varchar(128) NOT NULL DEFAULT 'kinfra-text-embedding-0.6b'")
    expect(sql).toContain('embedding_dimensions smallint NOT NULL DEFAULT 1024')
    expect(sql).toContain("configuration_version varchar(128) NOT NULL DEFAULT 'autoforge-knowledge-embedding-v1'")
    expect(sql).toContain('"region":"guangzhou"')
    expect(sql).toContain('cardinality(embedding) = 1024')
    expect(sql).not.toMatch(/\bUSING\s+hnsw\b/i)
    expect(sql).toContain('provider_request_key varchar(128) NOT NULL')
    expect(sql).toContain('settlement_outcome varchar(16)')
    expect(sql).toContain('provider_response_hash char(64)')
    expect(sql).toContain('settlement_intent_at timestamptz')

    const revoke = staticFunctionBodyFragment(sql, 'autoforge_knowledge_set_embedding_consent')
    expect(revoke).toContain('owner bigint := public.autoforge_knowledge_caller(p_caller_user_id)')
    expect(revoke).toContain('consent_epoch = consent_epoch + 1')
    expect(revoke).toContain('DELETE FROM public.knowledge_chunk_embeddings')
    expect(revoke).toContain('WHERE owner_id = owner')
    expect(revoke).toContain("state = 'expired'")
    expect(revoke).toContain("rebuild_required = p_enabled")
    expect(revoke).toContain("state = 'revoking'")
    expect(revoke).toContain("owner::text || ':embedding-consent'")
    expect(revoke).toContain('SELECT prior.response INTO response')
    expect(revoke).toContain("prior.response->>'state' = 'revoked'")

    const issuePermit = staticFunctionBodyFragment(
      sql, 'autoforge_knowledge_issue_embedding_dispatch_permit',
    )
    expect(issuePermit).toContain('FOR UPDATE')
    expect(issuePermit).toContain("consent.state <> 'granted'")
    expect(issuePermit).toContain("interval '15 seconds'")
    expect(issuePermit).toContain('configuration_version')
    expect(issuePermit).toContain('p_attempt_id NOT BETWEEN 1 AND 3')
    expect(issuePermit).toContain("completed.state = 'completed'")
    expect(issuePermit).toContain("prior.state = 'failed'")
    expect(issuePermit).toContain('p_attempt_id - 1')
    expect(issuePermit).toContain("'embed_' || md5(jsonb_build_array(")
    expect(issuePermit).toContain("'providerRequestKey', permit.provider_request_key")
    expect(issuePermit).toContain("'recovery', jsonb_build_object")
    const reserveAttempt = staticFunctionBodyFragment(
      sql, 'autoforge_knowledge_reserve_embedding_dispatch_attempt',
    )
    expect(reserveAttempt).toContain("permit.state <> 'issued'")
    expect(reserveAttempt).toContain('consent.consent_epoch <> permit.consent_epoch')
    expect(reserveAttempt).toContain("SET state = 'dispatching'")
    const startAttempt = staticFunctionBodyFragment(
      sql, 'autoforge_knowledge_mark_embedding_dispatch_started',
    )
    expect(startAttempt).toContain("consent.state <> 'granted'")
    expect(startAttempt).toContain("SET state = 'started'")
    const recordIntent = staticFunctionBodyFragment(
      sql, 'autoforge_knowledge_record_embedding_dispatch_settlement_intent',
    )
    expect(recordIntent).toContain('provider_response_hash')
    expect(recordIntent).toContain('settlement_outcome')
    expect(recordIntent).toContain('settlement_intent_at')
    expect(recordIntent).toContain('IS DISTINCT FROM p_provider_response_hash')
    const settleAttempt = staticFunctionBodyFragment(
      sql, 'autoforge_knowledge_settle_embedding_dispatch_attempt',
    )
    expect(settleAttempt).toContain("p_outcome NOT IN ('completed', 'failed')")
    expect(settleAttempt).toContain('permit.settlement_outcome IS DISTINCT FROM p_outcome')
    expect(settleAttempt).toContain('state = p_outcome')
    const revocationRecovery = staticFunctionBodyFragment(
      sql, 'autoforge_knowledge_get_embedding_revocation_attempt',
    )
    expect(revocationRecovery).toContain("consent.state <> 'revoking'")
    expect(revocationRecovery).toContain("state = 'started'")
    expect(revocationRecovery).toContain("'providerRequestKey', permit.provider_request_key")
    const finalizeRevocation = staticFunctionBodyFragment(
      sql, 'autoforge_knowledge_finalize_embedding_revocation',
    )
    expect(finalizeRevocation).toContain("consent.state <> 'revoking'")
    expect(finalizeRevocation).toContain("WHERE owner_id = owner AND state = 'dispatching'")
    expect(finalizeRevocation).toContain("permit.state = 'started'")
    expect(finalizeRevocation).not.toContain("state IN ('dispatching', 'started')\n      AND expires_at")
    expect(finalizeRevocation).toContain('DELETE FROM public.knowledge_chunk_embeddings')
    expect(finalizeRevocation).toContain("SET state = 'revoked'")
    expect(finalizeRevocation).toContain("response->>'consentEpoch'")
    expect(finalizeRevocation).toContain("response->>'state' = 'revoking'")
    expect(finalizeRevocation).toContain("owner::text || ':embedding-consent'")

    const store = staticFunctionBodyFragment(sql, 'autoforge_knowledge_store_embedding')
    expect(store).toContain("consent.state <> 'granted'")
    expect(store).toContain('consent.consent_epoch <> p_consent_epoch')
    expect(store).toContain('cardinality(p_vector) <> 1024')
    expect(store).toContain("generation.status NOT IN ('staging', 'ready')")
    expect(store).toContain('knowledge_generation_memberships')

    const keyword = staticFunctionBodyFragment(sql, 'autoforge_knowledge_search_keywords')
    expect(keyword).toContain("generation.status = 'published'")
    expect(keyword).toContain('knowledge_generation_memberships')
    expect(keyword).toContain('autoforge_knowledge_query_terms(p_query)')
    expect(keyword).toContain('NOT EXISTS')
    expect(keyword).toContain('LIMIT least(p_limit * 4, 96)')
    const vectors = staticFunctionBodyFragment(sql, 'autoforge_knowledge_search_vectors')
    expect(vectors).toContain("generation.status = 'published'")
    expect(vectors).toContain('cardinality(p_vector) <> 1024')
    expect(vectors).toContain('row_number() OVER')
    expect(vectors).toContain('candidate.id')
    expect(vectors).toContain('candidate.knowledge_base_id, candidate.id')

    const publish = staticFunctionBodyFragment(sql, 'autoforge_knowledge_publish_generation')
    expect(publish).toContain("consent.owner_id = owner AND consent.state = 'granted'")
    expect(publish).toContain('embedding.generation_id = p_generation_id')
    expect(publish).toContain("AND status = 'retained';")
    expect(publish).toContain("status = 'retained'")
    expect(publish).toContain("retained_until = clock_timestamp() + interval '7 days'")
    expect(publish).toContain("status = 'published', published_at = clock_timestamp()")

    const probe = staticFunctionBodyFragment(sql, 'autoforge_knowledge_begin_embedding_drift_probe')
    expect(probe).toContain("'begin_embedding_drift_probe'")
    expect(probe).toContain("'embedding', p_generation_id, 'queued'")
    expect(probe).toContain("p_generation_id, owner, p_knowledge_base_id, 'staging'")
    expect(probe).toContain('INSERT INTO public.knowledge_generation_memberships')
    expect(probe).toContain('document.active_version_id = chunk.version_id')
    const complete = staticFunctionBodyFragment(
      sql, 'autoforge_knowledge_complete_embedding_generation',
    )
    expect(complete).toContain("AND id = job.entity_id AND status = 'staging'")
    expect(complete).toContain("SET status = 'ready', ready_at = clock_timestamp()")
    expect(complete).toContain('knowledge_generation_memberships membership')
  })

  it('models bounded Chinese term AND matching and immutable generation membership', () => {
    const terms = (query: string) => query.toLocaleLowerCase('zh-CN').trim()
      .split(/[\s.,!?;:，。！？；：、（）【】《》“”‘’]+/u)
      .filter(Boolean).slice(0, 16)
    const matches = (query: string, body: string) => terms(query)
      .every(term => body.toLocaleLowerCase('zh-CN').includes(term))
    expect(terms(' 合同， 条款！违约 ')).toEqual(['合同', '条款', '违约'])
    expect(matches('合同 条款', '这里包含合同中的付款条款')).toBe(true)
    expect(matches('合同 条款', '这里只有合同')).toBe(false)

    const manifest = new Set(['kb_1:generation_1:version_1:chunk_1'])
    const laterChunk = 'kb_1:generation_1:version_2:chunk_2'
    expect(manifest.has(laterChunk)).toBe(false)
    expect([...manifest].slice(0, 96)).toEqual(['kb_1:generation_1:version_1:chunk_1'])
  })

  it('statically binds conflict receipts and independently models lost-response replay', async () => {
    const sql = await readFile(canonicalUrl, 'utf8')
    expect(sql).not.toContain('md5(concat_ws(')
    expect(canonical({ a: 'x:y', b: '' })).not.toBe(canonical({ a: 'x', b: 'y:' }))
    const push = staticFunctionBodyFragment(sql, 'autoforge_knowledge_push_mutation')
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

  it('statically constrains snapshot paging and independently models a stable byte-bounded page', async () => {
    const sql = await readFile(canonicalUrl, 'utf8')
    const snapshot = staticFunctionBodyFragment(sql, 'autoforge_knowledge_full_resync')
    expect(snapshot).toContain('p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 512')
    expect(snapshot).toContain('p_max_bytes IS NULL OR p_max_bytes NOT BETWEEN 65536 AND 786432')
    expect(snapshot).toContain('INSERT INTO public.knowledge_snapshots')
    expect(snapshot).toContain('INSERT INTO public.knowledge_snapshot_items')
    expect(snapshot).toContain('WITH snapshot_boundary AS MATERIALIZED')
    expect(snapshot).toContain('CROSS JOIN created_snapshot created')
    expect(snapshot).toContain('snapshot.snapshot_sequence')
    expect(snapshot).toContain('sum(item.response_bytes) OVER')
    expect(snapshot).toContain("'hasMore', has_more")
    const pull = staticFunctionBodyFragment(sql, 'autoforge_knowledge_pull_changes')
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

  it('statically binds worker/request arguments and independently models lease ownership', async () => {
    const sql = await readFile(canonicalUrl, 'utf8')
    const claim = staticFunctionBodyFragment(sql, 'autoforge_knowledge_claim_job')
    expect(claim).toContain("btrim(p_worker_id) = ''")
    expect(claim).toContain("btrim(p_lease_token) = ''")
    expect(claim).toContain('p_lease_seconds IS NULL')
    expect(claim).toContain('worker_id = p_worker_id')
    const complete = staticFunctionBodyFragment(sql, 'autoforge_knowledge_complete_job')
    expect(complete).toContain('worker_id = p_worker_id')
    const cancel = staticFunctionBodyFragment(sql, 'autoforge_knowledge_cancel_job')
    expect(cancel).toContain("'action', 'cancel_job'")
    expect(cancel).toContain("request_row.input_hash <> fingerprint")
    const orphan = staticFunctionBodyFragment(sql, 'autoforge_knowledge_prepare_orphan_cleanup')
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

  it('statically requires payload purge after exact Storage deletion and models payload removal separately', async () => {
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
    const purge = staticFunctionBodyFragment(sql, 'autoforge_knowledge_complete_base_purge')
    expect(purge).toContain('DELETE FROM public.knowledge_changes')
    expect(purge).toContain('DELETE FROM public.knowledge_conflicts')
    expect(purge).toContain('DELETE FROM public.knowledge_requests')
    expect(purge).toContain('DELETE FROM public.knowledge_jobs')
    expect(purge).toContain('DELETE FROM public.knowledge_snapshots')
    const sentinel = 'secret-content-sentinel'
    const simulatedPayloadRows = [sentinel]
    const independentlyModelPurge = (rows: string[]) => { rows.length = 0 }
    independentlyModelPurge(simulatedPayloadRows)
    expect(simulatedPayloadRows.join('|')).not.toContain(sentinel)
    expect(purge).toContain("jsonb_build_object('deletionJobId', job.id)")
    expect(purge).toContain("'delete', job.request_id, '{}'::jsonb")
  })

  it('statically bounds global expired-snapshot cleanup and independently models cascade and purge', async () => {
    const sql = await readFile(canonicalUrl, 'utf8')
    const cleanup = staticFunctionBodyFragment(sql, 'autoforge_knowledge_cleanup_retention')
    expect(cleanup).toContain('p_snapshot_limit IS NULL OR p_snapshot_limit NOT BETWEEN 1 AND 1000')
    expect(cleanup).toContain('FOR UPDATE SKIP LOCKED')
    expect(cleanup).toContain('LIMIT p_snapshot_limit')
    expect(cleanup).toContain('snapshot.owner_id = candidate.owner_id')
    expect(cleanup).toContain('snapshot.id = candidate.id')
    expect(cleanup).toContain('snapshot.expires_at <= clock_timestamp()')
    expect(cleanup).toContain("'prunedSnapshots', pruned_snapshots")
    const fullResync = staticFunctionBodyFragment(sql, 'autoforge_knowledge_full_resync')
    expect(fullResync).not.toContain('DELETE FROM public.knowledge_snapshots WHERE owner_id = owner')

    type Snapshot = { owner: string; base: string; id: string; expiresAt: number }
    const snapshots: Snapshot[] = [
      { owner: 'owner-a', base: 'kb-a', id: 'expired-a', expiresAt: 1 },
      { owner: 'owner-b', base: 'kb-b', id: 'expired-b', expiresAt: 2 },
      { owner: 'owner-a', base: 'kb-a', id: 'future-a', expiresAt: 20 },
    ]
    const items = new Map([
      ['owner-a:expired-a', ['secret-a']],
      ['owner-b:expired-b', ['secret-b']],
      ['owner-a:future-a', ['future-secret']],
    ])
    const independentlyModelRetention = (now: number, limit: number) => {
      const selected = snapshots.filter(row => row.expiresAt <= now)
        .sort((left, right) => left.expiresAt - right.expiresAt).slice(0, limit)
      for (const row of selected) {
        snapshots.splice(snapshots.findIndex(candidate => candidate.owner === row.owner
          && candidate.id === row.id && candidate.expiresAt <= now), 1)
        items.delete(`${row.owner}:${row.id}`)
      }
      return selected.length
    }
    expect(independentlyModelRetention(10, 1)).toBe(1)
    expect(snapshots.map(row => row.id)).toEqual(['expired-b', 'future-a'])
    expect(items.has('owner-a:expired-a')).toBe(false)
    expect(items.get('owner-a:future-a')).toEqual(['future-secret'])
    expect(independentlyModelRetention(10, 1)).toBe(1)
    expect(snapshots.map(row => row.id)).toEqual(['future-a'])

    const independentlyModelBasePurge = (owner: string, base: string) => {
      for (let index = snapshots.length - 1; index >= 0; index -= 1) {
        const row = snapshots[index]!
        if (row.owner === owner && row.base === base) {
          snapshots.splice(index, 1)
          items.delete(`${row.owner}:${row.id}`)
        }
      }
    }
    independentlyModelBasePurge('owner-a', 'kb-a')
    expect(snapshots).toEqual([])
    expect([...items.keys()]).toEqual([])
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
