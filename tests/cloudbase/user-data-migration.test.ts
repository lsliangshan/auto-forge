import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const canonicalUrl = new URL(
  '../../cloudbase/migrations/20260824090000_user_data_foundation.sql',
  import.meta.url,
)
const featureUrl = new URL(
  '../../cloudbase/user-data/migrations/0001_user_data_foundation.sql',
  import.meta.url,
)
const rollbackUrl = new URL(
  '../../cloudbase/user-data/migrations/0001_user_data_foundation.rollback.sql',
  import.meta.url,
)

const tableNames = [
  'app_conversations',
  'app_messages',
  'app_model_runs',
  'app_usage_events',
  'app_sync_devices',
  'app_sync_mutations',
  'app_privacy_consents',
  'app_user_data_preferences',
] as const

const rpcNames = [
  'autoforge_sync_push',
  'autoforge_sync_pull',
  'autoforge_list_conversations',
  'autoforge_list_messages',
  'autoforge_preview_legacy_import',
  'autoforge_import_legacy_batch',
  'autoforge_get_usage_snapshot',
  'autoforge_get_user_data_preferences',
  'autoforge_update_user_data_preferences',
] as const

describe('CloudBase user data migration', () => {
  it('keeps the canonical and deployable migrations byte-identical', async () => {
    const [canonical, featureCopy] = await Promise.all([
      readFile(canonicalUrl, 'utf8'),
      readFile(featureUrl, 'utf8'),
    ])

    expect(canonical).toBe(featureCopy)
  })

  it('defines owner-bound revisioned records, tombstones, idempotency, and ordering', async () => {
    const canonical = await readFile(canonicalUrl, 'utf8')

    for (const tableName of tableNames) {
      expect(canonical).toContain(`CREATE TABLE IF NOT EXISTS ${tableName}`)
      expect(canonical).toContain(`REVOKE ALL ON TABLE ${tableName} FROM PUBLIC, anon, authenticated`)
    }
    expect(canonical).toContain('owner_user_id bigint NOT NULL REFERENCES auth.users(id)')
    expect(canonical).toContain('UNIQUE (owner_user_id, mutation_id)')
    expect(canonical).toContain('UNIQUE (conversation_id, ordinal)')
    expect(canonical).toContain('revision bigint NOT NULL')
    expect(canonical).toContain('deleted_at timestamptz')
    expect(canonical).toContain('CREATE UNIQUE INDEX app_active_run_per_conversation')
    expect(canonical).toContain("WHERE status IN ('queued', 'running', 'cancelling')")
    expect(canonical).toContain('CREATE UNIQUE INDEX app_usage_operation_key')
    expect(canonical).toContain('ON app_usage_events(owner_user_id, operation_id, provider, purpose)')
  })

  it('implements bounded owner-scoped transactional sync with opaque cursors', async () => {
    const canonical = await readFile(canonicalUrl, 'utf8')

    expect(canonical).toContain('jsonb_array_length(p_mutations) > 100')
    expect(canonical).toContain('pg_column_size(p_mutations) > 1048576')
    expect(canonical).toContain('FOR UPDATE')
    expect(canonical).toContain('base_revision')
    expect(canonical).toContain('server_sequence')
    expect(canonical).toContain('ORDER BY mutation.server_sequence')
    expect(canonical).toContain('cursor_token uuid NOT NULL DEFAULT gen_random_uuid()')
    expect(canonical).toContain('cursor_token::text')
    expect(canonical).not.toMatch(/jsonb_extract_path_text\([^)]*,\s*'owner(?:UserId|_user_id)'/i)
    expect(canonical).not.toMatch(/(?:cursor|nextCursor|previousCursor)'\s*,\s*(?:mutation\.)?server_sequence/i)
  })

  it('exposes only service-role RPC execution and no direct table access', async () => {
    const canonical = await readFile(canonicalUrl, 'utf8')

    for (const rpcName of rpcNames) {
      expect(canonical).toContain(`CREATE OR REPLACE FUNCTION ${rpcName}`)
      expect(canonical).toContain(`REVOKE ALL ON FUNCTION ${rpcName}`)
      expect(canonical).toContain(`GRANT EXECUTE ON FUNCTION ${rpcName}`)
    }
    expect(canonical).toContain('SECURITY DEFINER')
    expect(canonical).toContain('SET search_path = pg_catalog, public')
    expect(canonical).not.toMatch(/GRANT .* ON TABLE/i)
    expect(canonical).not.toMatch(/GRANT .* TO authenticated/i)
    expect(canonical).not.toMatch(/GRANT .* TO anon/i)
    expect(canonical).not.toMatch(/GRANT .* TO PUBLIC/i)
  })

  it('keeps accepted data tables intact during rollback', async () => {
    const rollback = await readFile(rollbackUrl, 'utf8')

    for (const rpcName of rpcNames) {
      expect(rollback).toContain(`DROP FUNCTION IF EXISTS ${rpcName}`)
    }
    expect(rollback).not.toMatch(/DROP TABLE/i)
    expect(rollback).not.toMatch(/TRUNCATE/i)
    expect(rollback).not.toMatch(/DELETE FROM/i)
  })
})
