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
const conversionAdditiveUrl = new URL(
  '../../cloudbase/migrations/20260829000000_conversion_block_terminal.sql',
  import.meta.url,
)
const projectionAdditiveUrl = new URL(
  '../../cloudbase/migrations/20260830190000_message_provider_projection.sql',
  import.meta.url,
)
const projectionFeatureUrl = new URL(
  '../../cloudbase/user-data/migrations/0002_message_provider_projection.sql',
  import.meta.url,
)
const projectionV2AdditiveUrl = new URL(
  '../../cloudbase/migrations/20260830213000_message_provider_projection_v2.sql',
  import.meta.url,
)
const projectionV2FeatureUrl = new URL(
  '../../cloudbase/user-data/migrations/0003_message_provider_projection_v2.sql',
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

  it('upgrades projections to version 2 with an ordered selected attachment set', async () => {
    const [additive, featureCopy] = await Promise.all([
      readFile(projectionV2AdditiveUrl, 'utf8'),
      readFile(projectionV2FeatureUrl, 'utf8'),
    ])
    expect(additive).toBe(featureCopy)
    expect(additive).toContain("provider_projection->>'version' IS DISTINCT FROM '2'")
    expect(additive).toContain(
      "jsonb_typeof(provider_projection->'selectedAttachmentIndexes') IS DISTINCT FROM 'array'",
    )
    expect(additive).toContain("projection->'selectedAttachmentIndexes'")
    expect(additive).toContain('jsonb_array_elements_text')
    expect(additive).toContain('selected_text::integer <= previous_text::integer')
    expect(additive).toContain('SET provider_projection = NULL')
  })

  it('stores only constrained canonical projections and returns them from push/list/bootstrap', async () => {
    const [canonical, additive, featureAdditive] = await Promise.all([
      readFile(canonicalUrl, 'utf8'),
      readFile(projectionAdditiveUrl, 'utf8'),
      readFile(projectionFeatureUrl, 'utf8'),
    ])
    expect(additive).toBe(featureAdditive)
    for (const sql of [canonical, additive]) {
      expect(sql).toContain('provider_projection jsonb')
      expect(sql).toContain("projection->>'kind' <> 'local_conversion'")
      expect(sql).toContain("projection->>'targetFormat'")
      expect(sql).toContain("projection->>'attachmentCount'")
      expect(sql).toContain("payload->'providerProjection'")
      expect(sql).toContain("'providerProjection', page.provider_projection")
    }
    const projectionTrigger = extractFunction(additive, 'autoforge_apply_message_provider_projection')
    const list = extractFunction(additive, 'autoforge_list_messages')
    expect(projectionTrigger).toContain('provider_projection')
    expect(projectionTrigger).toContain("jsonb_object_keys(projection)")
    expect(projectionTrigger).toContain('stored_projection IS DISTINCT FROM projection')
    expect(list).toContain("'providerProjection', page.provider_projection")
    expect(additive.indexOf('ALTER TABLE app_messages ADD COLUMN IF NOT EXISTS provider_projection'))
      .toBeLessThan(additive.indexOf('CREATE OR REPLACE FUNCTION autoforge_apply_message_provider_projection('))
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

  it('resolves sync-push identifiers to PL/pgSQL variables when column names overlap', async () => {
    const canonical = await readFile(canonicalUrl, 'utf8')
    const syncPush = extractFunction(canonical, 'autoforge_sync_push')

    expect(syncPush).toContain('#variable_conflict use_variable')
  })

  it('ships deployed replacements for conversion push, versioned pull, and terminal-safe purge', async () => {
    const [canonical, additive] = await Promise.all([
      readFile(canonicalUrl, 'utf8'),
      readFile(conversionAdditiveUrl, 'utf8'),
    ])
    const canonicalPush = extractFunction(canonical, 'autoforge_sync_push')
    const additivePush = extractFunction(additive, 'autoforge_sync_push')
    const canonicalPull = extractFunction(canonical, 'autoforge_sync_pull')
    const additivePull = extractFunction(additive, 'autoforge_sync_pull')
    const canonicalPurge = extractFunction(canonical, 'autoforge_purge_expired_conversation_tombstones')
    const additivePurge = extractFunction(additive, 'autoforge_purge_expired_conversation_tombstones')

    expect(additive).toContain('CREATE OR REPLACE FUNCTION autoforge_sync_push(')
    expect(additivePush).toBe(canonicalPush)
    expect(additivePull).toBe(canonicalPull)
    expect(additivePurge).toBe(canonicalPurge)
    const terminalBranch = additivePush.slice(
      additivePush.indexOf("ELSIF mutation_kind = 'message.conversion_block_terminal'"),
      additivePush.indexOf("ELSIF mutation_kind = 'message.append'"),
    )
    expect(terminalBranch).toContain("(SELECT count(*) FROM jsonb_object_keys(payload)) <> 4")
    expect(terminalBranch).not.toContain("existing_message.execution_id IS DISTINCT FROM payload->>'executionId'")
    expect(terminalBranch).toContain("existing_block->>'state' = 'terminal'")
    expect(terminalBranch).toContain("mutation_status := 'duplicate'")
    expect(terminalBranch).toContain('conversation_row.revision <> base_revision_value')
    expect(terminalBranch).toContain('UPDATE app_conversations SET revision = result_revision_value')
  })

  it('keeps conversion terminal storage, key counting, and additive whitelist installation fail-closed', async () => {
    const [canonical, featureCopy, additive] = await Promise.all([
      readFile(canonicalUrl, 'utf8'),
      readFile(featureUrl, 'utf8'),
      readFile(conversionAdditiveUrl, 'utf8'),
    ])

    for (const sql of [canonical, featureCopy, additive]) {
      expect(sql).not.toMatch(/jsonb?_object_length\s*\(/)
      expect(sql).toContain('(SELECT count(*) FROM jsonb_object_keys(payload)) <> 4')
    }

    for (const foundation of [canonical, featureCopy]) {
      const mutations = extractTable(foundation, 'app_sync_mutations')
      const kindWidth = mutations.match(/\bkind varchar\((\d+)\) NOT NULL/)?.[1]
      expect(Number(kindWidth)).toBeGreaterThanOrEqual(64)
    }

    const additiveSetup = additive.slice(0, additive.indexOf('CREATE OR REPLACE FUNCTION autoforge_sync_push('))
    expect(additiveSetup).toContain('ALTER TABLE app_sync_mutations ALTER COLUMN kind TYPE varchar(64)')
    expect(additiveSetup).toMatch(
      /END \$\$;\s+ALTER TABLE app_sync_mutations ALTER COLUMN kind TYPE varchar\(64\);\s+ALTER TABLE app_sync_mutations DROP CONSTRAINT IF EXISTS app_sync_mutations_kind_check;\s+ALTER TABLE app_sync_mutations ADD CONSTRAINT app_sync_mutations_kind_check CHECK/,
    )
  })

  it('enforces exact unique-block, null-state, base-revision, and receipt replay parity', async () => {
    const canonical = await readFile(canonicalUrl, 'utf8')
    const syncPush = extractFunction(canonical, 'autoforge_sync_push')
    const receiptReplay = syncPush.slice(
      syncPush.indexOf('IF FOUND THEN'),
      syncPush.indexOf("IF mutation_kind = 'conversation.create'"),
    )
    const terminalBranch = syncPush.slice(
      syncPush.indexOf("ELSIF mutation_kind = 'message.conversion_block_terminal'"),
      syncPush.indexOf("ELSIF mutation_kind = 'message.append'"),
    )
    const uniqueTargetCheck = terminalBranch.slice(
      terminalBranch.indexOf('IF NOT FOUND OR (SELECT count(*)'),
      terminalBranch.indexOf('THEN', terminalBranch.indexOf('IF NOT FOUND OR (SELECT count(*)')),
    )

    expect(receiptReplay).toMatch(
      /WHEN existing_receipt\.kind = 'message\.conversion_block_terminal'\s+THEN existing_receipt\.status\s+WHEN existing_receipt\.status = 'applied' THEN 'duplicate'/,
    )
    expect(terminalBranch).toMatch(
      /count\(\*\) FROM jsonb_array_elements\(existing_message\.blocks\) block\s+WHERE block->>'blockId' = payload->>'blockId'/,
    )
    expect(uniqueTargetCheck).not.toContain("block->>'type'")
    expect(uniqueTargetCheck).not.toContain("block->>'executionId'")
    expect(terminalBranch).toContain("existing_block->>'type' IS DISTINCT FROM 'conversion'")
    expect(terminalBranch).toContain(
      "existing_block->>'executionId' IS DISTINCT FROM payload->>'executionId'",
    )
    expect(terminalBranch).toContain("existing_block->>'state' IS DISTINCT FROM 'active'")
    expect(terminalBranch).toContain("existing_block->>'state' IS DISTINCT FROM 'terminal'")
    expect(terminalBranch).toMatch(
      /conversation_row\.revision <> base_revision_value[\s\S]+?ELSIF existing_block->>'state' = 'terminal' THEN[\s\S]+?result_revision_value := base_revision_value;[\s\S]+?mutation_status := 'duplicate'/,
    )
    expect(terminalBranch).toContain('result_revision_value := base_revision_value + 1')
    expect(terminalBranch.indexOf('conversation_row.revision <> base_revision_value'))
      .toBeLessThan(terminalBranch.indexOf("existing_block->>'state' = 'terminal'"))
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
    expect(duplicateBranch.indexOf("auth_user_id::text || ':' || conversation_id"))
      .toBeLessThan(duplicateBranch.indexOf('SELECT * INTO conversation_row'))
    expect(duplicateBranch.indexOf('SELECT * INTO conversation_row'))
      .toBeLessThan(duplicateBranch.indexOf("auth_user_id::text || ':message:' || entity_id"))
    expect(duplicateBranch.indexOf("auth_user_id::text || ':message:' || entity_id"))
      .toBeLessThan(duplicateBranch.indexOf('SELECT * INTO existing_message'))
  })

  it('accepts sync protocol v1/v2 while keeping legacy import v1 and sanitizing failures', async () => {
    const canonical = await readFile(canonicalUrl, 'utf8')
    const syncPush = extractFunction(canonical, 'autoforge_sync_push')
    const syncPull = extractFunction(canonical, 'autoforge_sync_pull')
    const legacyImport = extractFunction(canonical, 'autoforge_import_legacy_batch')

    for (const rpc of [syncPush, syncPull]) {
      expect(rpc).toContain('IF p_protocol_version IS NULL OR p_protocol_version NOT IN (1, 2) THEN')
      expect(rpc).toContain("MESSAGE = 'UPGRADE_REQUIRED'")
    }
    expect(legacyImport).toContain('IF p_protocol_version IS DISTINCT FROM 1 THEN')
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

  it('validates legacy devices before stable-batch idempotency', async () => {
    const canonical = await readFile(canonicalUrl, 'utf8')
    const legacyImport = extractFunction(canonical, 'autoforge_import_legacy_batch')
    const deviceCheck = legacyImport.indexOf('device_row.revoked_at IS NOT NULL')
    const duplicateCheck = legacyImport.indexOf("receipt.kind = 'legacy.import'")

    expect(deviceCheck).toBeGreaterThan(-1)
    expect(duplicateCheck).toBeGreaterThan(deviceCheck)
    expect(legacyImport).toContain(
      '-- Consent metadata is renewed for each confirmation, so it must not turn',
    )
    expect(legacyImport).toContain("IF receipt.kind = 'legacy.import' THEN")
    expect(legacyImport).not.toContain('receipt.request_hash = legacy_request_hash')
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
    expect(legacyImport).toContain("p_batch_id || ':conversation:' || (item->>'id')")
    expect(legacyImport).toContain("p_batch_id || ':message:' || (item->>'id')")
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
    expect(purge).toContain("mutation.kind = 'message.conversion_block_terminal'")
    expect(purge).toContain('LEFT JOIN app_messages message')
    expect(purge).toMatch(
      /WHEN mutation\.kind IN \(\s*'message\.append', 'message\.conversion_block_terminal'\s*\)\s+THEN to_jsonb\(candidate\."conversationId"\)/,
    )
    expect(purge).toContain("mutation_payload->'payload'->>'conversationId'")
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

  it('locks each conversation before its message and revalidates exact terminal identity', async () => {
    const canonical = await readFile(canonicalUrl, 'utf8')
    const syncPush = extractFunction(canonical, 'autoforge_sync_push')
    const terminalBranch = syncPush.slice(
      syncPush.indexOf("ELSIF mutation_kind = 'message.conversion_block_terminal'"),
      syncPush.indexOf("ELSIF mutation_kind = 'message.append'"),
    )
    const conversationLookup = terminalBranch.indexOf('SELECT * INTO conversation_row')
    const messageLock = terminalBranch.indexOf("auth_user_id::text || ':message:' || entity_id")
    const lockedMessageLookup = terminalBranch.indexOf('SELECT * INTO existing_message', messageLock)

    expect(terminalBranch).toContain('SELECT message.conversation_id INTO conversation_id')
    expect(terminalBranch.indexOf("auth_user_id::text || ':' || conversation_id"))
      .toBeLessThan(conversationLookup)
    expect(conversationLookup).toBeLessThan(messageLock)
    expect(messageLock).toBeLessThan(lockedMessageLookup)
    expect(terminalBranch).toContain(
      'existing_message.conversation_id IS DISTINCT FROM conversation_id',
    )
    expect(terminalBranch).toContain('conversation_row.revision <> base_revision_value')
    expect(terminalBranch).toMatch(
      /jsonb_agg\([\s\S]+?ORDER BY item\.ordinality\)[\s\S]+?FROM jsonb_array_elements\(blocks\) WITH ORDINALITY AS item\(block, ordinality\)/,
    )
  })

  it('projects a v1-safe page while advancing the cursor across hidden v2 mutations', async () => {
    const canonical = await readFile(canonicalUrl, 'utf8')
    const syncPull = extractFunction(canonical, 'autoforge_sync_pull')

    expect(syncPull).toContain('WITH candidates AS (')
    expect(syncPull).toContain('visible_candidates AS (')
    expect(syncPull).toContain('visible_page AS (')
    expect(syncPull).toMatch(
      /p_protocol_version = 2\s+OR candidate\.kind <> 'message\.conversion_block_terminal'\s+OR \(candidate\.result_revision = candidate\.base_revision \+ 1/,
    )
    expect(syncPull).toContain("THEN 'conversation.preferences'")
    expect(syncPull).toContain('THEN page.terminal_conversation_id')
    expect(syncPull).toContain("mutation.mutation_payload->>'conversationId'")
    expect(syncPull).toContain("message.conversation_id")
    expect(syncPull).toMatch(
      /page\.kind = 'message\.conversion_block_terminal'[\s\S]+?THEN true ELSE NULL END/,
    )
    expect(syncPull).toContain("block.value->>'type' <> 'conversion'")
    expect(syncPull).toMatch(
      /jsonb_array_elements\(page\.mutation_payload->'payload'->'blocks'\)\s+WITH ORDINALITY/,
    )
    expect(syncPull).toMatch(
      /CASE WHEN \(SELECT count\(\*\) FROM visible_page\) = p_limit[\s\S]+?FROM visible_page[\s\S]+?FROM candidates/,
    )
    expect(syncPull.indexOf("candidate.kind <> 'message.conversion_block_terminal'"))
      .toBeLessThan(syncPull.indexOf('LIMIT p_limit'))
  })

  it('paginates by 100 visible v1 mutations while advancing across every hidden-tail shape', () => {
    type Row = {
      id: string
      cursor: string
      kind: 'conversation.rename' | 'message.conversion_block_terminal'
      baseRevision: number
      resultRevision: number
      conversationId?: string
    }
    const rename = (id: string, revision: number): Row => ({
      id,
      cursor: `cursor_${id}`,
      kind: 'conversation.rename',
      baseRevision: revision,
      resultRevision: revision + 1,
    })
    const duplicateTerminal = (id: string, revision: number): Row => ({
      id,
      cursor: `cursor_${id}`,
      kind: 'message.conversion_block_terminal',
      baseRevision: revision,
      resultRevision: revision,
      conversationId: 'conversation_visible_projection',
    })
    const appliedTerminal = (id: string, revision: number): Row => ({
      id,
      cursor: `cursor_${id}`,
      kind: 'message.conversion_block_terminal',
      baseRevision: revision,
      resultRevision: revision + 1,
      conversationId: 'conversation_visible_projection',
    })
    const page = (
      rows: readonly Row[],
      cursor: string | undefined,
      protocolVersion: 1 | 2,
      limit = 100,
    ) => {
      const afterIndex = cursor === undefined ? -1 : rows.findIndex((item) => item.cursor === cursor)
      const candidates = rows.slice(afterIndex + 1)
      const visible = candidates.filter((item) => (
        protocolVersion === 2
        || item.kind !== 'message.conversion_block_terminal'
        || (item.resultRevision === item.baseRevision + 1 && item.conversationId !== undefined)
      )).slice(0, limit)
      const nextCursor = visible.length === limit
        ? visible.at(-1)?.cursor
        : candidates.at(-1)?.cursor ?? cursor
      return { mutations: visible, cursor: nextCursor }
    }
    const drainLikeStrictV1 = (rows: readonly Row[]) => {
      const received: Row[] = []
      const cursors: Array<string | undefined> = []
      const pageSizes: number[] = []
      let cursor: string | undefined
      for (let request = 0; request < 10; request += 1) {
        const current = page(rows, cursor, 1)
        received.push(...current.mutations)
        cursors.push(current.cursor)
        pageSizes.push(current.mutations.length)
        cursor = current.cursor
        if (current.mutations.length < 100) return { received, cursors, pageSizes }
      }
      throw new Error('strict v1 loop did not terminate')
    }

    const hiddenThenRename = [
      ...Array.from({ length: 100 }, (_, index) => duplicateTerminal(`hidden_${index}`, 1)),
      rename('rename_after_hidden', 1),
    ]
    const hiddenThenRenameDrain = drainLikeStrictV1(hiddenThenRename)
    expect(hiddenThenRenameDrain).toEqual({
      received: [rename('rename_after_hidden', 1)],
      cursors: ['cursor_rename_after_hidden'],
      pageSizes: [1],
    })

    const mixed = [
      ...Array.from({ length: 60 }, (_, index) => rename(`visible_first_${index}`, index)),
      ...Array.from({ length: 140 }, (_, index) => duplicateTerminal(`hidden_middle_${index}`, 60)),
      appliedTerminal('visible_terminal', 60),
      ...Array.from({ length: 64 }, (_, index) => rename(`visible_last_${index}`, 61 + index)),
    ]
    const mixedDrain = drainLikeStrictV1(mixed)
    expect(mixedDrain.received).toHaveLength(125)
    expect(mixedDrain.received.map(({ id }) => id)).toEqual([
      ...Array.from({ length: 60 }, (_, index) => `visible_first_${index}`),
      'visible_terminal',
      ...Array.from({ length: 64 }, (_, index) => `visible_last_${index}`),
    ])
    expect(mixedDrain.cursors).toEqual([
      'cursor_visible_last_38',
      'cursor_visible_last_63',
    ])
    expect(mixedDrain.pageSizes).toEqual([100, 25])

    const shortWithHiddenTail = [
      ...Array.from({ length: 99 }, (_, index) => rename(`short_visible_${index}`, index)),
      ...Array.from({ length: 100 }, (_, index) => duplicateTerminal(`short_tail_${index}`, 99)),
    ]
    const shortTailDrain = drainLikeStrictV1(shortWithHiddenTail)
    expect(shortTailDrain.received).toHaveLength(99)
    expect(shortTailDrain.cursors).toEqual(['cursor_short_tail_99'])
    expect(shortTailDrain.pageSizes).toEqual([99])
    expect(page([
      ...shortWithHiddenTail,
      rename('rename_after_hidden_tail', 99),
    ], shortTailDrain.cursors.at(-1), 1)).toMatchObject({
      mutations: [expect.objectContaining({ id: 'rename_after_hidden_tail' })],
      cursor: 'cursor_rename_after_hidden_tail',
    })

    const fullWithHiddenTail = [
      ...Array.from({ length: 100 }, (_, index) => rename(`full_visible_${index}`, index)),
      ...Array.from({ length: 100 }, (_, index) => duplicateTerminal(`full_tail_${index}`, 100)),
    ]
    const fullTailDrain = drainLikeStrictV1(fullWithHiddenTail)
    expect(fullTailDrain.received.map(({ id }) => id)).toEqual(
      Array.from({ length: 100 }, (_, index) => `full_visible_${index}`),
    )
    expect(fullTailDrain.cursors).toEqual([
      'cursor_full_visible_99',
      'cursor_full_tail_99',
    ])
    expect(fullTailDrain.pageSizes).toEqual([100, 0])

    const v2FirstPage = page(hiddenThenRename, undefined, 2)
    expect(v2FirstPage.mutations.map(({ id }) => id)).toEqual(
      Array.from({ length: 100 }, (_, index) => `hidden_${index}`),
    )
    expect(v2FirstPage.cursor).toBe('cursor_hidden_99')
    expect(page(hiddenThenRename, v2FirstPage.cursor, 2).mutations.map(({ id }) => id))
      .toEqual(['rename_after_hidden'])
  })

  it('keeps strict v1 readers OCC-continuous across an active append, hidden terminal, and later write', () => {
    const isRecord = (value: unknown): value is Record<string, unknown> => (
      typeof value === 'object' && value !== null && !Array.isArray(value)
    )
    const hasExactKeys = (value: Record<string, unknown>, expected: readonly string[]) => (
      Object.keys(value).length === expected.length
      && expected.every((key) => Object.hasOwn(value, key))
    )
    const oldV1ChatBlock = (value: unknown): boolean => {
      if (!isRecord(value) || typeof value.type !== 'string') return false
      if (value.type === 'text') {
        return hasExactKeys(value, ['type', 'text']) && typeof value.text === 'string'
      }
      return value.type === 'error'
        && hasExactKeys(value, ['type', 'code', 'message'])
        && typeof value.code === 'string'
        && typeof value.message === 'string'
    }
    const oldV1PulledMutation = (value: unknown): boolean => {
      if (!isRecord(value)) return false
      if (value.kind === 'conversation.preferences' && value.compacted === true) {
        return hasExactKeys(value, [
          'id', 'kind', 'entityId', 'baseRevision', 'resultRevision', 'compacted', 'receivedAt',
        ])
          && typeof value.id === 'string'
          && typeof value.entityId === 'string'
          && Number.isSafeInteger(value.baseRevision)
          && Number.isSafeInteger(value.resultRevision)
          && typeof value.receivedAt === 'string'
      }
      if (!hasExactKeys(value, [
        'id', 'kind', 'entityId', 'baseRevision', 'resultRevision', 'payload', 'receivedAt',
      ]) || !isRecord(value.payload)) return false
      const payload = value.payload
      if (value.kind === 'conversation.rename') {
        return hasExactKeys(payload, ['title', 'titleState', 'metadataUpdatedAt'])
          && typeof value.id === 'string'
          && typeof value.entityId === 'string'
          && Number.isSafeInteger(value.baseRevision)
          && Number.isSafeInteger(value.resultRevision)
          && typeof value.receivedAt === 'string'
          && typeof payload.title === 'string'
          && typeof payload.titleState === 'string'
          && typeof payload.metadataUpdatedAt === 'string'
      }
      if (value.kind !== 'message.append') return false
      return hasExactKeys(payload, ['id', 'conversationId', 'role', 'blocks', 'createdAt'])
        && typeof value.id === 'string'
        && typeof value.entityId === 'string'
        && Number.isSafeInteger(value.baseRevision)
        && Number.isSafeInteger(value.resultRevision)
        && typeof value.receivedAt === 'string'
        && typeof payload.id === 'string'
        && typeof payload.conversationId === 'string'
        && (payload.role === 'user' || payload.role === 'assistant')
        && Array.isArray(payload.blocks)
        && payload.blocks.every(oldV1ChatBlock)
        && typeof payload.createdAt === 'string'
    }
    const receivedAt = '2026-08-29T00:00:00.000Z'
    const v2Page = [{
      id: 'append_with_conversion',
      kind: 'message.append' as const,
      entityId: 'assistant_message',
      baseRevision: 1,
      resultRevision: 2,
      payload: {
        id: 'assistant_message',
        conversationId: 'conversation_1',
        role: 'assistant' as const,
        blocks: [
          { type: 'text' as const, text: '转换已提交' },
          {
            type: 'conversion' as const,
            blockId: 'conversion_block',
            executionId: 'conversion_execution',
            state: 'active' as const,
          },
        ],
        createdAt: receivedAt,
      },
      receivedAt,
      cursor: 'cursor_append',
    }, {
      id: 'terminal_hidden_from_v1',
      kind: 'message.conversion_block_terminal' as const,
      entityId: 'assistant_message',
      baseRevision: 2,
      resultRevision: 3,
      payload: {
        messageId: 'assistant_message',
        blockId: 'conversion_block',
        executionId: 'conversion_execution',
        state: 'terminal' as const,
      },
      receivedAt,
      cursor: 'cursor_terminal',
    }, {
      id: 'terminal_duplicate_hidden_from_v1',
      kind: 'message.conversion_block_terminal' as const,
      entityId: 'assistant_message',
      baseRevision: 3,
      resultRevision: 3,
      payload: {
        messageId: 'assistant_message',
        blockId: 'conversion_block',
        executionId: 'conversion_execution',
        state: 'terminal' as const,
      },
      receivedAt,
      cursor: 'cursor_terminal_duplicate',
    }, {
      id: 'rename_after_terminal',
      kind: 'conversation.rename' as const,
      entityId: 'conversation_1',
      baseRevision: 3,
      resultRevision: 4,
      payload: {
        title: '转换完成',
        titleState: 'user_named',
        metadataUpdatedAt: receivedAt,
      },
      receivedAt,
      cursor: 'cursor_rename',
    }]
    const unprojected = v2Page.map(({ cursor, ...mutation }) => {
      expect(cursor).toEqual(expect.stringMatching(/^cursor_/))
      return mutation
    })
    expect(unprojected.map(oldV1PulledMutation)).toEqual([false, false, false, true])
    const projected = unprojected
      .flatMap((mutation) => {
        if (mutation.kind === 'message.conversion_block_terminal') {
          if (mutation.resultRevision !== mutation.baseRevision + 1) return []
          return [{
            id: mutation.id,
            kind: 'conversation.preferences' as const,
            entityId: 'conversation_1',
            baseRevision: mutation.baseRevision,
            resultRevision: mutation.resultRevision,
            compacted: true as const,
            receivedAt: mutation.receivedAt,
          }]
        }
        return [mutation.kind === 'message.append'
          ? {
              ...mutation,
              payload: {
                ...mutation.payload,
                blocks: mutation.payload.blocks.filter(({ type }) => type !== 'conversion'),
              },
            }
          : mutation]
      })

    expect(projected.every(oldV1PulledMutation)).toBe(true)
    let oldDeviceRevision = 1
    for (const mutation of projected) {
      expect(mutation.baseRevision).toBe(oldDeviceRevision)
      oldDeviceRevision = mutation.resultRevision
    }
    const nextLocalWrite = { baseRevision: oldDeviceRevision }
    expect(nextLocalWrite.baseRevision).toBe(4)
    expect(v2Page.at(-1)?.cursor).toBe('cursor_rename')
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
      /ELSIF NOT conversation_found THEN[\s\S]+?mutation := jsonb_build_object\([\s\S]+?'compacted', true,[\s\S]+?'conversationId', conversation_id/,
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

    expect(receiptReplay).toContain("WHEN existing_receipt.status = 'applied' THEN 'duplicate'")
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
