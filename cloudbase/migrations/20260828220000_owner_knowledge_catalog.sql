BEGIN;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_require_cloud(p_owner_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  entitlement public.knowledge_entitlements%ROWTYPE;
  consent_purpose constant varchar := 'cloud_sync';
  consent_state varchar;
  consent_revision bigint;
  consent_document_version varchar;
BEGIN
  SELECT * INTO entitlement FROM public.knowledge_entitlements WHERE owner_id = p_owner_id;
  IF NOT FOUND OR entitlement.kill_switch_enabled THEN
    RAISE EXCEPTION USING MESSAGE = 'KILL_SWITCH_ENABLED', ERRCODE = 'P0001';
  END IF;
  IF entitlement.tier <> 'member' OR NOT entitlement.cloud_enabled
    OR entitlement.status NOT IN ('active', 'offline_grace') THEN
    RAISE EXCEPTION USING MESSAGE = 'ENTITLEMENT_REQUIRED', ERRCODE = 'P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_owner_id::text || ':privacy-consent:' || consent_purpose, 0
  ));
  IF to_regclass('public.app_privacy_consent_states') IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'FORBIDDEN', ERRCODE = 'P0001';
  END IF;
  EXECUTE $query$
    SELECT state, revision, document_version
    FROM public.app_privacy_consent_states
    WHERE owner_user_id = $1 AND purpose = $2
  $query$
  INTO consent_state, consent_revision, consent_document_version
  USING p_owner_id, consent_purpose;
  IF consent_state IS DISTINCT FROM 'accepted'
    OR consent_revision IS NULL OR consent_revision < 1
    OR consent_document_version IS DISTINCT FROM 'cloud-sync-2026-08' THEN
    RAISE EXCEPTION USING MESSAGE = 'FORBIDDEN', ERRCODE = 'P0001';
  END IF;
END;
$$;

DO $migration$
DECLARE
  definition text;
  guarded text;
BEGIN
  SELECT pg_get_functiondef(
    'public.autoforge_knowledge_verify_upload(varchar,varchar,varchar,varchar,varchar,bigint,varchar,varchar,bigint,varchar,varchar)'::regprocedure
  ) INTO definition;

  guarded := replace(
    definition,
    $old$BEGIN
  SELECT * INTO authorization FROM public.knowledge_upload_authorizations
    WHERE upload_ticket = p_upload_ticket AND owner_id = owner FOR UPDATE;$old$,
    $new$BEGIN
  PERFORM public.autoforge_knowledge_require_cloud(owner);
  SELECT * INTO authorization FROM public.knowledge_upload_authorizations
    WHERE upload_ticket = p_upload_ticket AND owner_id = owner FOR UPDATE;$new$
  );
  IF guarded = definition THEN
    RAISE EXCEPTION 'autoforge_knowledge_verify_upload consent guard anchor was not found';
  END IF;

  -- pg_get_functiondef returns CREATE OR REPLACE; the consent lock is held to transaction end.
  EXECUTE guarded;
END
$migration$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_assert_cloud_sync_consent(
  p_caller_user_id varchar
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner bigint := public.autoforge_knowledge_caller(p_caller_user_id);
  consent_purpose constant varchar := 'cloud_sync';
  consent_revision bigint;
  consent_document_version varchar;
BEGIN
  PERFORM public.autoforge_knowledge_require_cloud(owner);
  EXECUTE $query$
    SELECT revision, document_version
    FROM public.app_privacy_consent_states
    WHERE owner_user_id = $1 AND purpose = $2 AND state = 'accepted'
  $query$
  INTO consent_revision, consent_document_version
  USING owner, consent_purpose;
  IF consent_revision IS NULL
    OR consent_document_version IS DISTINCT FROM 'cloud-sync-2026-08' THEN
    RAISE EXCEPTION USING MESSAGE = 'FORBIDDEN', ERRCODE = 'P0001';
  END IF;
  RETURN jsonb_build_object(
    'state', 'accepted', 'revision', consent_revision,
    'documentVersion', consent_document_version
  );
END;
$$;

CREATE TABLE IF NOT EXISTS public.knowledge_owner_catalog_snapshots (
  id varchar(128) NOT NULL,
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  item_count integer NOT NULL CHECK (item_count BETWEEN 0 AND 10000),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id, id)
);
CREATE INDEX IF NOT EXISTS knowledge_owner_catalog_snapshots_expiry
  ON public.knowledge_owner_catalog_snapshots(expires_at, owner_id, id);

CREATE TABLE IF NOT EXISTS public.knowledge_owner_catalog_items (
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  snapshot_id varchar(128) NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  knowledge_base_id varchar(128) NOT NULL,
  response_bytes integer NOT NULL CHECK (response_bytes > 0 AND response_bytes <= 1024),
  PRIMARY KEY(owner_id, snapshot_id, ordinal),
  UNIQUE(owner_id, snapshot_id, knowledge_base_id),
  FOREIGN KEY(owner_id, snapshot_id)
    REFERENCES public.knowledge_owner_catalog_snapshots(owner_id, id) ON DELETE CASCADE
);

ALTER TABLE public.knowledge_owner_catalog_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_owner_catalog_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_owner_isolation ON public.knowledge_owner_catalog_snapshots;
CREATE POLICY knowledge_owner_isolation ON public.knowledge_owner_catalog_snapshots
  USING (owner_id = public.autoforge_knowledge_request_user_id())
  WITH CHECK (owner_id = public.autoforge_knowledge_request_user_id());

ALTER TABLE public.knowledge_owner_catalog_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_owner_catalog_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_owner_isolation ON public.knowledge_owner_catalog_items;
CREATE POLICY knowledge_owner_isolation ON public.knowledge_owner_catalog_items
  USING (owner_id = public.autoforge_knowledge_request_user_id())
  WITH CHECK (owner_id = public.autoforge_knowledge_request_user_id());

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_list_bases(
  p_caller_user_id varchar, p_snapshot_id varchar, p_after_ordinal integer,
  p_limit integer, p_max_bytes integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner bigint := public.autoforge_knowledge_caller(p_caller_user_id);
  catalog_snapshot public.knowledge_owner_catalog_snapshots%ROWTYPE;
  created_snapshot_id varchar;
  knowledge_base_ids jsonb;
  next_ordinal integer;
  has_more boolean;
BEGIN
  PERFORM public.autoforge_knowledge_require_cloud(owner);
  IF p_after_ordinal IS NULL OR p_after_ordinal < 0
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 512
    OR p_max_bytes IS NULL OR p_max_bytes NOT BETWEEN 65536 AND 786432
    OR (p_snapshot_id IS NULL AND p_after_ordinal <> 0)
    OR (p_snapshot_id IS NOT NULL
      AND (btrim(p_snapshot_id) = '' OR length(p_snapshot_id) > 128)) THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;

  IF p_snapshot_id IS NULL THEN
    created_snapshot_id := 'catalog_' || md5(
      owner::text || ':' || clock_timestamp()::text || ':' || random()::text
    );
    WITH catalog AS MATERIALIZED (
      SELECT base.id AS knowledge_base_id,
        row_number() OVER (ORDER BY base.id)::integer - 1 AS ordinal,
        pg_column_size(to_jsonb(base.id)) + 64 AS response_bytes
      FROM public.knowledge_bases base
      WHERE base.owner_id = owner
        AND base.status <> 'deleted'
        AND base.deleted_at IS NULL
      ORDER BY base.id
    ), stats AS (
      SELECT count(*)::integer AS item_count FROM catalog
    ), created_snapshot AS (
      INSERT INTO public.knowledge_owner_catalog_snapshots(
        id, owner_id, item_count
      )
      SELECT created_snapshot_id, owner, stats.item_count
      FROM stats
      WHERE stats.item_count <= 10000
      RETURNING id, owner_id
    )
    INSERT INTO public.knowledge_owner_catalog_items(
      owner_id, snapshot_id, ordinal, knowledge_base_id, response_bytes
    )
    SELECT owner, created.id, catalog.ordinal,
      catalog.knowledge_base_id, catalog.response_bytes
    FROM catalog CROSS JOIN created_snapshot created;

    SELECT * INTO catalog_snapshot
    FROM public.knowledge_owner_catalog_snapshots snapshot
    WHERE snapshot.owner_id = owner AND snapshot.id = created_snapshot_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING MESSAGE = 'INTERNAL_ERROR', ERRCODE = 'P0001';
    END IF;
  ELSE
    SELECT * INTO catalog_snapshot
    FROM public.knowledge_owner_catalog_snapshots snapshot
    WHERE snapshot.owner_id = owner AND snapshot.id = p_snapshot_id
      AND snapshot.expires_at > clock_timestamp()
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING MESSAGE = 'CURSOR_STALE', ERRCODE = 'P0001';
    END IF;
  END IF;

  IF p_after_ordinal > catalog_snapshot.item_count THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;

  WITH candidates AS (
    SELECT item.*
    FROM public.knowledge_owner_catalog_items item
    WHERE item.owner_id = owner AND item.snapshot_id = catalog_snapshot.id
      AND item.ordinal >= p_after_ordinal
    ORDER BY item.ordinal
    LIMIT p_limit
  ), measured AS (
    SELECT item.*,
      sum(item.response_bytes) OVER (ORDER BY item.ordinal) AS cumulative_bytes
    FROM candidates item
  ), selected AS (
    SELECT * FROM measured WHERE cumulative_bytes <= p_max_bytes - 4096
  )
  SELECT COALESCE(
      jsonb_agg(knowledge_base_id ORDER BY ordinal), '[]'::jsonb
    ),
    COALESCE(max(ordinal) + 1, p_after_ordinal)
  INTO knowledge_base_ids, next_ordinal
  FROM selected;

  has_more := next_ordinal < catalog_snapshot.item_count;
  IF has_more AND next_ordinal = p_after_ordinal THEN
    RAISE EXCEPTION USING MESSAGE = 'INTERNAL_ERROR', ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'kind', 'catalog_page', 'snapshotId', catalog_snapshot.id,
    'totalCount', catalog_snapshot.item_count, 'nextOrdinal', next_ordinal,
    'hasMore', has_more, 'knowledgeBaseIds', knowledge_base_ids
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_cleanup_owner_catalog(
  p_worker_id varchar, p_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE pruned_snapshots integer := 0;
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = ''
    OR length(p_worker_id) > 128
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  WITH candidates AS (
    SELECT snapshot.owner_id, snapshot.id
    FROM public.knowledge_owner_catalog_snapshots snapshot
    WHERE snapshot.expires_at <= clock_timestamp()
    ORDER BY snapshot.expires_at, snapshot.owner_id, snapshot.id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  DELETE FROM public.knowledge_owner_catalog_snapshots snapshot
  USING candidates candidate
  WHERE snapshot.owner_id = candidate.owner_id
    AND snapshot.id = candidate.id
    AND snapshot.expires_at <= clock_timestamp();
  GET DIAGNOSTICS pruned_snapshots = ROW_COUNT;
  RETURN jsonb_build_object('prunedSnapshots', pruned_snapshots);
END;
$$;

REVOKE ALL ON TABLE public.knowledge_owner_catalog_snapshots FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.knowledge_owner_catalog_items FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.knowledge_owner_catalog_snapshots TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.knowledge_owner_catalog_items TO service_role;

REVOKE ALL ON FUNCTION public.autoforge_knowledge_list_bases(varchar, varchar, integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_cleanup_owner_catalog(varchar, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_assert_cloud_sync_consent(varchar) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_list_bases(varchar, varchar, integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_cleanup_owner_catalog(varchar, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_assert_cloud_sync_consent(varchar) TO service_role;

COMMIT;
