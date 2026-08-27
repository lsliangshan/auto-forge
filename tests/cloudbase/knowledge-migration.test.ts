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
] as const

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
    expect(sql).toContain("'kind', 'snapshot'")
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
