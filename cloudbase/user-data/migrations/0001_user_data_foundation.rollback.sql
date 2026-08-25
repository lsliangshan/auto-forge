BEGIN;

REVOKE ALL ON FUNCTION autoforge_sync_push(varchar, integer, varchar, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION autoforge_sync_pull(varchar, integer, varchar, varchar, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION autoforge_list_conversations(varchar, integer, varchar, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION autoforge_list_messages(varchar, varchar, integer, varchar) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION autoforge_preview_legacy_import(varchar, integer, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION autoforge_import_legacy_batch(varchar, integer, varchar, varchar, boolean, jsonb, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION autoforge_get_usage_snapshot(varchar, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION autoforge_get_user_data_preferences(varchar) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION autoforge_update_user_data_preferences(varchar, varchar, varchar, bigint) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION autoforge_purge_expired_conversation_tombstones() FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION IF EXISTS autoforge_sync_push(varchar, integer, varchar, jsonb);
DROP FUNCTION IF EXISTS autoforge_sync_pull(varchar, integer, varchar, varchar, integer);
DROP FUNCTION IF EXISTS autoforge_list_conversations(varchar, integer, varchar, boolean);
DROP FUNCTION IF EXISTS autoforge_list_messages(varchar, varchar, integer, varchar);
DROP FUNCTION IF EXISTS autoforge_preview_legacy_import(varchar, integer, integer);
DROP FUNCTION IF EXISTS autoforge_import_legacy_batch(varchar, integer, varchar, varchar, boolean, jsonb, jsonb, jsonb, jsonb);
DROP FUNCTION IF EXISTS autoforge_get_usage_snapshot(varchar, timestamptz, timestamptz);
DROP FUNCTION IF EXISTS autoforge_get_user_data_preferences(varchar);
DROP FUNCTION IF EXISTS autoforge_update_user_data_preferences(varchar, varchar, varchar, bigint);
DROP FUNCTION IF EXISTS autoforge_purge_expired_conversation_tombstones();
DROP FUNCTION IF EXISTS autoforge_record_consent(bigint, jsonb);
DROP FUNCTION IF EXISTS autoforge_iso_timestamp(timestamptz);
DROP FUNCTION IF EXISTS autoforge_require_identifier(text, integer);
DROP FUNCTION IF EXISTS autoforge_resolve_user_id(varchar);

COMMIT;
