BEGIN;

-- Disable the executable surface first. Owner-scoped tables, rows, RLS policies,
-- composite foreign keys, and immutable lifecycle guards are deliberately retained.
REVOKE ALL ON FUNCTION public.autoforge_knowledge_request_hash(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_begin_embedding_drift_probe(varchar, varchar, varchar, varchar, varchar) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_complete_embedding_generation(varchar, varchar, varchar, bigint, varchar, varchar, bigint) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_get_embedding_consent(varchar) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_set_embedding_consent(varchar, varchar, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_assert_embedding_consent(bigint, bigint) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_claim_embedding_batch(varchar, varchar, varchar, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_store_embedding(bigint, varchar, varchar, varchar, bigint, varchar, integer, varchar, real[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_search_keywords(varchar, varchar[], varchar, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_search_vectors(varchar, varchar[], real[], varchar, integer, varchar, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_cleanup_retention(varchar, integer, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_cancel_claimed_job(varchar, varchar, varchar) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_complete_job(varchar, varchar, varchar, varchar, varchar) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_claim_job(varchar, varchar, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_get_entitlement(varchar) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_get_job(varchar, varchar) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_prepare_base_purge(varchar, varchar, varchar) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_complete_base_purge(varchar, varchar, varchar, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_complete_orphan_cleanup(varchar, varchar, varchar, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_prepare_orphan_cleanup(varchar, varchar, varchar, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_cancel_job(varchar, varchar, varchar) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_delete_base(varchar, varchar, varchar, varchar) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_publish_generation(varchar, varchar, varchar, varchar, varchar) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_full_resync(varchar, varchar, varchar, integer, integer, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_pull_changes(varchar, varchar, bigint, integer, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_push_mutation(varchar, varchar, varchar, varchar, varchar, varchar, varchar, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_authorize_upload(varchar, varchar, varchar, varchar, varchar, bigint, varchar, varchar) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_verify_upload(varchar, varchar, varchar, varchar, varchar, bigint, varchar, varchar, bigint, varchar, varchar) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_get_upload(varchar, varchar) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_begin_sync(varchar, varchar, varchar, varchar, varchar, varchar) FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.autoforge_knowledge_begin_embedding_drift_probe(varchar, varchar, varchar, varchar, varchar);
DROP FUNCTION IF EXISTS public.autoforge_knowledge_complete_embedding_generation(varchar, varchar, varchar, bigint, varchar, varchar, bigint);
DROP FUNCTION IF EXISTS public.autoforge_knowledge_get_embedding_consent(varchar);
DROP FUNCTION IF EXISTS public.autoforge_knowledge_set_embedding_consent(varchar, varchar, boolean);
DROP FUNCTION IF EXISTS public.autoforge_knowledge_assert_embedding_consent(bigint, bigint);
DROP FUNCTION IF EXISTS public.autoforge_knowledge_claim_embedding_batch(varchar, varchar, varchar, integer);
DROP FUNCTION IF EXISTS public.autoforge_knowledge_store_embedding(bigint, varchar, varchar, varchar, bigint, varchar, integer, varchar, real[]);
DROP FUNCTION IF EXISTS public.autoforge_knowledge_search_keywords(varchar, varchar[], varchar, integer);
DROP FUNCTION IF EXISTS public.autoforge_knowledge_search_vectors(varchar, varchar[], real[], varchar, integer, varchar, integer);
DROP FUNCTION IF EXISTS public.autoforge_knowledge_cleanup_retention(varchar, integer, integer);
DROP FUNCTION IF EXISTS public.autoforge_knowledge_cancel_claimed_job(varchar, varchar, varchar);
DROP FUNCTION IF EXISTS public.autoforge_knowledge_complete_job(varchar, varchar, varchar, varchar, varchar);
DROP FUNCTION IF EXISTS public.autoforge_knowledge_claim_job(varchar, varchar, integer);
DROP FUNCTION IF EXISTS public.autoforge_knowledge_get_entitlement(varchar);
DROP FUNCTION IF EXISTS public.autoforge_knowledge_get_job(varchar, varchar);
DROP FUNCTION IF EXISTS public.autoforge_knowledge_prepare_base_purge(varchar, varchar, varchar);
DROP FUNCTION IF EXISTS public.autoforge_knowledge_complete_base_purge(varchar, varchar, varchar, jsonb);
DROP FUNCTION IF EXISTS public.autoforge_knowledge_complete_orphan_cleanup(varchar, varchar, varchar, jsonb);
DROP FUNCTION IF EXISTS public.autoforge_knowledge_prepare_orphan_cleanup(varchar, varchar, varchar, jsonb);
DROP FUNCTION IF EXISTS public.autoforge_knowledge_cancel_job(varchar, varchar, varchar);
DROP FUNCTION IF EXISTS public.autoforge_knowledge_delete_base(varchar, varchar, varchar, varchar);
DROP FUNCTION IF EXISTS public.autoforge_knowledge_publish_generation(varchar, varchar, varchar, varchar, varchar);
DROP FUNCTION IF EXISTS public.autoforge_knowledge_full_resync(varchar, varchar, varchar, integer, integer, integer);
DROP FUNCTION IF EXISTS public.autoforge_knowledge_pull_changes(varchar, varchar, bigint, integer, integer);
DROP FUNCTION IF EXISTS public.autoforge_knowledge_push_mutation(varchar, varchar, varchar, varchar, varchar, varchar, varchar, jsonb);
DROP FUNCTION IF EXISTS public.autoforge_knowledge_authorize_upload(varchar, varchar, varchar, varchar, varchar, bigint, varchar, varchar);
DROP FUNCTION IF EXISTS public.autoforge_knowledge_verify_upload(varchar, varchar, varchar, varchar, varchar, bigint, varchar, varchar, bigint, varchar, varchar);
DROP FUNCTION IF EXISTS public.autoforge_knowledge_get_upload(varchar, varchar);
DROP FUNCTION IF EXISTS public.autoforge_knowledge_begin_sync(varchar, varchar, varchar, varchar, varchar, varchar);
DROP FUNCTION IF EXISTS public.autoforge_knowledge_require_cloud(bigint);
DROP FUNCTION IF EXISTS public.autoforge_knowledge_caller(varchar);
DROP FUNCTION IF EXISTS public.autoforge_knowledge_request_hash(jsonb);

DO $revoke_tables$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'knowledge_bases', 'knowledge_objects', 'knowledge_documents', 'knowledge_versions',
    'knowledge_parser_runs', 'knowledge_blocks', 'knowledge_chunks',
    'knowledge_index_generations', 'knowledge_jobs', 'knowledge_entity_heads',
    'knowledge_changes', 'knowledge_tombstones', 'knowledge_conflicts',
    'knowledge_sync_floors', 'knowledge_upload_authorizations',
    'knowledge_entitlements', 'knowledge_requests', 'knowledge_snapshots',
    'knowledge_snapshot_items', 'knowledge_embedding_consents',
    'knowledge_chunk_embeddings'
  ] LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role', table_name);
  END LOOP;
END;
$revoke_tables$;

REVOKE ALL ON SEQUENCE public.knowledge_changes_sequence_seq FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.knowledge_tombstones_id_seq FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.knowledge_conflicts_id_seq FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
