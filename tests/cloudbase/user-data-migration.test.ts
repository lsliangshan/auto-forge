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
  'autoforge_purge_expired_conversation_tombstones',
] as const

function extractTable(sql: string, tableName: string): string {
  const match = sql.match(new RegExp(
    `CREATE TABLE IF NOT EXISTS ${tableName} \\([\\s\\S]*?\\n\\);`,
  ))
  expect(match, `missing table ${tableName}`).not.toBeNull()
  return match![0]
}

function extractFunction(sql: string, functionName: string): string {
  const match = sql.match(new RegExp(
    `CREATE OR REPLACE FUNCTION ${functionName}\\([\\s\\S]*?\\n\\$\\$;`,
  ))
  expect(match, `missing function ${functionName}`).not.toBeNull()
  return match![0]
}

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
    expect(canonical).toContain('revision bigint NOT NULL')
    expect(canonical).toContain('deleted_at timestamptz')
    expect(canonical).toContain('CREATE UNIQUE INDEX IF NOT EXISTS app_active_run_per_conversation')
    expect(canonical).toContain("WHERE status IN ('queued', 'running', 'cancelling')")
    expect(canonical).toContain('CREATE UNIQUE INDEX IF NOT EXISTS app_usage_operation_key')
    expect(canonical).toContain('ON app_usage_events(owner_user_id, operation_id, provider, purpose)')
  })

  it('scopes every client identity and conversation dependency to its owner', async () => {
    const canonical = await readFile(canonicalUrl, 'utf8')
    const conversations = extractTable(canonical, 'app_conversations')
    const messages = extractTable(canonical, 'app_messages')
    const runs = extractTable(canonical, 'app_model_runs')
    const usage = extractTable(canonical, 'app_usage_events')
    const legacyImport = extractFunction(canonical, 'autoforge_import_legacy_batch')

    for (const table of [conversations, messages, runs, usage]) {
      expect(table).toContain('PRIMARY KEY (owner_user_id, id)')
      expect(table).not.toMatch(/\bid varchar\(128\) PRIMARY KEY/)
    }
    for (const table of [messages, runs, usage]) {
      expect(table).toContain('FOREIGN KEY (owner_user_id, conversation_id)')
      expect(table).toContain('REFERENCES app_conversations(owner_user_id, id)')
    }
    expect(canonical).toContain(
      'ON app_messages(owner_user_id, conversation_id, ordinal)',
    )
    expect(canonical).toContain(
      'ON app_model_runs(owner_user_id, conversation_id)',
    )
    expect(legacyImport).toContain('ON CONFLICT (owner_user_id, id) DO NOTHING')
    expect(legacyImport).not.toContain('ON CONFLICT (id) DO NOTHING')
  })

  it('implements bounded owner-scoped transactional sync with opaque cursors', async () => {
    const canonical = await readFile(canonicalUrl, 'utf8')
    const syncPush = extractFunction(canonical, 'autoforge_sync_push')

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
    expect(syncPush).toMatch(/LOOP\s+BEGIN\s/)
    expect(syncPush).toContain("'status', 'rejected'")
    expect(syncPush).toContain("'errorCode', 'INVALID_INPUT'")
    expect(syncPush).not.toMatch(/SQLERRM|CONSTRAINT_NAME|PG_EXCEPTION_DETAIL|GET STACKED DIAGNOSTICS/)
  })

  it('rejects a duplicate message id unless every immutable field matches', async () => {
    const canonical = await readFile(canonicalUrl, 'utf8')
    const syncPush = extractFunction(canonical, 'autoforge_sync_push')
    const duplicateBranch = syncPush.slice(
      syncPush.indexOf("ELSIF mutation_kind = 'message.append'"),
      syncPush.indexOf("ELSIF mutation_kind = 'privacy.consent'"),
    )

    expect(duplicateBranch).toContain('existing_message.conversation_id IS DISTINCT FROM conversation_id')
    expect(duplicateBranch).toContain("existing_message.role IS DISTINCT FROM payload->>'role'")
    expect(duplicateBranch).toContain("existing_message.blocks IS DISTINCT FROM payload->'blocks'")
    expect(duplicateBranch).toContain("existing_message.execution_id IS DISTINCT FROM NULLIF(payload->>'executionId', '')")
    expect(duplicateBranch).toContain("existing_message.created_at IS DISTINCT FROM (payload->>'createdAt')::timestamptz")
    expect(duplicateBranch).toContain("mutation_status := 'rejected'")
    expect(duplicateBranch).toContain("mutation_error := 'INVALID_INPUT'")
    expect(duplicateBranch).toContain("auth_user_id::text || ':message:' || entity_id")
    expect(duplicateBranch.indexOf("auth_user_id::text || ':message:' || entity_id"))
      .toBeLessThan(duplicateBranch.indexOf('SELECT * INTO existing_message'))
    expect(duplicateBranch.indexOf('SELECT * INTO existing_message'))
      .toBeLessThan(duplicateBranch.indexOf('SELECT * INTO conversation_row'))
  })

  it('rejects null protocol versions and separates expected data failures from internal failures', async () => {
    const canonical = await readFile(canonicalUrl, 'utf8')
    const syncPush = extractFunction(canonical, 'autoforge_sync_push')
    const syncPull = extractFunction(canonical, 'autoforge_sync_pull')
    const legacyImport = extractFunction(canonical, 'autoforge_import_legacy_batch')

    for (const rpc of [syncPush, syncPull, legacyImport]) {
      expect(rpc).toContain('IF p_protocol_version IS DISTINCT FROM 1 THEN')
      expect(rpc).toContain("MESSAGE = 'UPGRADE_REQUIRED'")
    }
    expect(syncPush).toContain(
      "WHEN SQLSTATE 'P0001' OR data_exception OR integrity_constraint_violation THEN",
    )
    expect(syncPush).toMatch(
      /WHEN OTHERS THEN\s+RAISE EXCEPTION USING MESSAGE = 'INTERNAL_ERROR', ERRCODE = 'P0001'/,
    )
    expect(syncPush).not.toMatch(
      /WHEN OTHERS THEN[\s\S]{0,500}status, error_code[\s\S]{0,200}'rejected', 'INVALID_INPUT'/,
    )
    expect(syncPush).not.toMatch(/WHEN OTHERS THEN\s+NULL/)
  })

  it('uses rerunnable named indexes and the correct conversation cursor tie break', async () => {
    const canonical = await readFile(canonicalUrl, 'utf8')
    const messages = extractTable(canonical, 'app_messages')
    const listConversations = extractFunction(canonical, 'autoforge_list_conversations')
    const namedIndexes = canonical.match(/CREATE (?:UNIQUE )?INDEX[^;]+;/g) ?? []

    expect(namedIndexes.length).toBeGreaterThan(0)
    for (const index of namedIndexes) {
      expect(index).toMatch(/^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS /)
    }
    expect(messages).not.toContain('UNIQUE (conversation_id, ordinal)')
    expect(listConversations).toContain('conversation.last_activity_at < anchor_activity')
    expect(listConversations).toContain(
      'conversation.last_activity_at = anchor_activity AND conversation.id > anchor_id',
    )
    expect(listConversations).not.toContain(
      '(conversation.last_activity_at, conversation.id) < (anchor_activity, anchor_id)',
    )
    expect(listConversations).toContain(
      '(array_agg(page.cursor_token::text ORDER BY page.last_activity_at, page.id DESC))[1]',
    )
  })

  it('validates legacy devices before idempotency and hashes the complete batch', async () => {
    const canonical = await readFile(canonicalUrl, 'utf8')
    const legacyImport = extractFunction(canonical, 'autoforge_import_legacy_batch')
    const deviceCheck = legacyImport.indexOf('device_row.revoked_at IS NOT NULL')
    const duplicateCheck = legacyImport.indexOf("receipt.kind = 'legacy.import'")

    expect(deviceCheck).toBeGreaterThan(-1)
    expect(duplicateCheck).toBeGreaterThan(deviceCheck)
    expect(legacyImport).toContain('legacy_request_hash := md5(jsonb_build_object(')
    expect(legacyImport).toContain("'conversations', p_conversations")
    expect(legacyImport).toContain("'messages', p_messages")
    expect(legacyImport).toContain("'cloudSyncConsent', p_cloud_sync_consent")
    expect(legacyImport).toContain("'unownedImportConsent', p_unowned_import_consent")
    expect(legacyImport).toContain('receipt.request_hash = legacy_request_hash')
    expect(legacyImport).not.toContain(
      "md5(p_batch_id || ':' || jsonb_array_length(p_conversations)::text",
    )
  })

  it('projects accepted legacy rows through ordered deterministic sync receipts', async () => {
    const canonical = await readFile(canonicalUrl, 'utf8')
    const legacyImport = extractFunction(canonical, 'autoforge_import_legacy_batch')
    const conversationReceipt = legacyImport.indexOf(
      "conversation_mutation_id := 'legacy-conversation:' || md5(",
    )
    const messageLoop = legacyImport.indexOf(
      'FOR item IN SELECT value FROM jsonb_array_elements(p_messages)',
    )
    const messageReceipt = legacyImport.indexOf(
      "message_mutation_id := 'legacy-message:' || md5(",
    )
    const reducedReceipt = legacyImport.lastIndexOf(
      "auth_user_id, p_batch_id, p_device_id, 'legacy.import'",
    )

    expect(conversationReceipt).toBeGreaterThan(-1)
    expect(messageLoop).toBeGreaterThan(conversationReceipt)
    expect(messageReceipt).toBeGreaterThan(messageLoop)
    expect(reducedReceipt).toBeGreaterThan(messageReceipt)
    expect(legacyImport).toContain("p_batch_id || ':conversation:' || item->>'id'")
    expect(legacyImport).toContain("p_batch_id || ':message:' || item->>'id'")
    expect(legacyImport).toContain(
      "'title', item->>'title', 'titleState', item->>'titleState'",
    )
    expect(legacyImport).toContain(
      "'createdAt', item->>'createdAt', 'lastActivityAt', item->>'lastActivityAt'",
    )
    expect(legacyImport).toContain(
      "'id', item->>'id', 'conversationId', item->>'conversationId'",
    )
    expect(legacyImport).toContain(
      "'role', item->>'role', 'blocks', item->'blocks'",
    )
    expect(legacyImport).toContain(
      "'executionId', NULLIF(item->>'executionId', '')",
    )
    expect(legacyImport).toContain('message_base_revision := conversation_row.revision')
    expect(legacyImport).toContain('revision = message_base_revision + 1')
    expect(legacyImport).toContain(
      "'message.append', item->>'id', message_base_revision, message_base_revision + 1",
    )
    expect(legacyImport).toMatch(
      /IF inserted_count = 1 THEN[\s\S]+?conversation_mutation_id[\s\S]+?END IF;[\s\S]+?FOR item IN SELECT value FROM jsonb_array_elements\(p_messages\)/,
    )
    expect(legacyImport).toMatch(
      /IF inserted_count = 1 THEN[\s\S]+?message_base_revision := conversation_row\.revision[\s\S]+?UPDATE app_conversations[\s\S]+?message_mutation_id[\s\S]+?END IF;[\s\S]+?INSERT INTO app_sync_mutations\(/,
    )
    expect(legacyImport.indexOf("receipt.kind = 'legacy.import'"))
      .toBeLessThan(legacyImport.indexOf('BEGIN\n  PERFORM autoforge_record_consent'))
  })

  it('contains nullable legacy and preference inputs behind sanitized stable errors', async () => {
    const canonical = await readFile(canonicalUrl, 'utf8')
    const legacyImport = extractFunction(canonical, 'autoforge_import_legacy_batch')
    const updatePreferences = extractFunction(
      canonical,
      'autoforge_update_user_data_preferences',
    )

    expect(legacyImport).toContain(
      "jsonb_typeof(p_conversations) IS DISTINCT FROM 'array'",
    )
    expect(legacyImport).toContain(
      "jsonb_typeof(p_messages) IS DISTINCT FROM 'array'",
    )
    expect(legacyImport).toContain("jsonb_typeof(item) IS DISTINCT FROM 'object'")
    expect(legacyImport).toContain("'status', 'rejected', 'errorCode', 'INVALID_INPUT'")
    expect(legacyImport).toMatch(
      /WHEN OTHERS THEN\s+RAISE EXCEPTION USING MESSAGE = 'INTERNAL_ERROR', ERRCODE = 'P0001'/,
    )
    expect(legacyImport).not.toMatch(/SQLERRM|CONSTRAINT_NAME|PG_EXCEPTION_DETAIL|GET STACKED DIAGNOSTICS/)

    expect(updatePreferences).toContain('p_timezone IS NULL')
    expect(updatePreferences).toContain('p_display_currency IS NULL')
    expect(updatePreferences).toContain("p_display_currency NOT IN ('CNY', 'USD')")
    expect(updatePreferences).toContain(
      'EXCEPTION WHEN data_exception OR integrity_constraint_violation THEN',
    )
    expect(updatePreferences).toContain("MESSAGE = 'INVALID_INPUT'")
    expect(updatePreferences).toMatch(
      /WHEN OTHERS THEN\s+RAISE EXCEPTION USING MESSAGE = 'INTERNAL_ERROR', ERRCODE = 'P0001'/,
    )
    expect(updatePreferences).not.toMatch(/SQLERRM|CONSTRAINT_NAME|PG_EXCEPTION_DETAIL|GET STACKED DIAGNOSTICS/)
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

  it('purges only conversation tombstones older than 30 days through service role', async () => {
    const canonical = await readFile(canonicalUrl, 'utf8')
    const purge = extractFunction(canonical, 'autoforge_purge_expired_conversation_tombstones')

    expect(purge).toContain('SECURITY DEFINER')
    expect(purge).toContain('SET search_path = pg_catalog, public')
    expect(purge).toContain("purge_before timestamptz := clock_timestamp() - interval '30 days'")
    expect(purge).toContain('candidate_snapshot jsonb')
    expect(purge).toContain('purge_candidates jsonb')
    expect(purge).toContain('ORDER BY "ownerUserId", "conversationId"')
    expect(purge).toContain('pg_advisory_xact_lock')
    expect(purge).toContain('FOR UPDATE')
    expect(purge).toContain('UPDATE app_usage_events')
    expect(purge).toContain('conversation_id = NULL')
    expect(purge).toContain('UPDATE app_sync_mutations')
    expect(purge).not.toContain('DELETE FROM app_sync_mutations')
    expect(purge).toContain("'compacted', true")
    expect(purge).not.toContain('[deleted conversation]')
    expect(purge).not.toContain("'blocks'")
    expect(purge).toContain("mutation.kind = 'message.append'")
    expect(purge).toContain("mutation_payload->'payload'->'conversationId'")
    expect(purge).not.toContain('request_hash =')
    expect(purge).toContain('DELETE FROM app_conversations')
    expect(canonical).toContain(
      'REVOKE ALL ON FUNCTION autoforge_purge_expired_conversation_tombstones() FROM PUBLIC, anon, authenticated, service_role',
    )
    expect(canonical).toContain(
      'GRANT EXECUTE ON FUNCTION autoforge_purge_expired_conversation_tombstones() TO service_role',
    )
    expect(canonical).not.toContain(
      'GRANT EXECUTE ON FUNCTION autoforge_purge_expired_conversation_tombstones() TO authenticated',
    )
  })

  it('compacts stale rename and message receipts that arrive after purge without changing the request hash', async () => {
    const canonical = await readFile(canonicalUrl, 'utf8')
    const syncPush = extractFunction(canonical, 'autoforge_sync_push')
    const renameBranch = syncPush.slice(
      syncPush.indexOf("ELSIF mutation_kind IN ('conversation.rename'"),
      syncPush.indexOf("ELSIF mutation_kind = 'message.append'"),
    )
    const messageBranch = syncPush.slice(
      syncPush.indexOf("ELSIF mutation_kind = 'message.append'"),
      syncPush.indexOf("ELSIF mutation_kind = 'privacy.consent'"),
    )

    expect(renameBranch).toMatch(
      /IF NOT FOUND THEN[\s\S]+?mutation_kind IN \('conversation\.rename', 'conversation\.preferences'\)[\s\S]+?'compacted', true/,
    )
    expect(messageBranch).toMatch(
      /IF NOT FOUND[\s\S]+?mutation := jsonb_build_object\([\s\S]+?'compacted', true,[\s\S]+?'conversationId', conversation_id/,
    )
    expect(renameBranch.indexOf("auth_user_id::text || ':' || entity_id"))
      .toBeLessThan(renameBranch.indexOf("mutation := jsonb_build_object('compacted', true)"))
    expect(messageBranch.indexOf("auth_user_id::text || ':' || conversation_id"))
      .toBeLessThan(messageBranch.indexOf('mutation := jsonb_build_object('))
    expect(syncPush.indexOf('request_hash_value := md5(mutation::text)'))
      .toBeLessThan(syncPush.indexOf("'compacted', true"))
    expect(syncPush).toContain('mutation, request_hash_value')
  })

  it('versions conversation generation preferences and compacts their purged receipts', async () => {
    const canonical = await readFile(canonicalUrl, 'utf8')
    const syncPush = extractFunction(canonical, 'autoforge_sync_push')
    const purge = extractFunction(canonical, 'autoforge_purge_expired_conversation_tombstones')
    const preferenceBranch = syncPush.slice(
      syncPush.indexOf("ELSIF mutation_kind IN ('conversation.rename'"),
      syncPush.indexOf("ELSIF mutation_kind = 'message.append'"),
    )

    expect(canonical).toContain("'conversation.preferences'")
    expect(preferenceBranch).toContain("mutation_kind = 'conversation.preferences'")
    expect(preferenceBranch).toContain('generation_preferences = payload->\'preferences\'')
    expect(preferenceBranch).toContain('metadata_updated_at = (payload->>\'metadataUpdatedAt\')::timestamptz')
    expect(preferenceBranch).toContain('result_revision_value := conversation_row.revision + 1')
    expect(preferenceBranch).toMatch(
      /IF NOT FOUND THEN[\s\S]+?mutation_kind IN \('conversation\.rename', 'conversation\.preferences'\)[\s\S]+?'compacted', true/,
    )
    expect(purge).toMatch(
      /mutation\.kind IN \([\s\S]+?'conversation\.preferences'[\s\S]+?\) AND mutation\.entity_id/,
    )
  })

  it('replays a post-purge stale conflict verbatim after a lost response', async () => {
    const canonical = await readFile(canonicalUrl, 'utf8')
    const syncPush = extractFunction(canonical, 'autoforge_sync_push')
    const receiptReplay = syncPush.slice(
      syncPush.indexOf('IF FOUND THEN'),
      syncPush.indexOf("IF mutation_kind = 'conversation.create'"),
    )

    expect(receiptReplay).toMatch(
      /'status', CASE\s+WHEN existing_receipt\.status = 'applied' THEN 'duplicate'\s+ELSE existing_receipt\.status\s+END/,
    )
    expect(receiptReplay).toContain("'revision', existing_receipt.result_revision")
    expect(receiptReplay).toContain("'errorCode', existing_receipt.error_code")
    expect(receiptReplay).not.toContain("'status', 'duplicate'")
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
