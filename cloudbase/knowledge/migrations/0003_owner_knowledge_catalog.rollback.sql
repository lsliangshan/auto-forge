BEGIN;

DO $rollback$
DECLARE
  definition text;
  restored text;
BEGIN
  SELECT pg_get_functiondef(
    'public.autoforge_knowledge_verify_upload(varchar,varchar,varchar,varchar,varchar,bigint,varchar,varchar,bigint,varchar,varchar)'::regprocedure
  ) INTO definition;

  restored := replace(
    definition,
    $old$BEGIN
  PERFORM public.autoforge_knowledge_require_cloud(owner);
  SELECT * INTO authorization FROM public.knowledge_upload_authorizations
    WHERE upload_ticket = p_upload_ticket AND owner_id = owner FOR UPDATE;$old$,
    $new$BEGIN
  SELECT * INTO authorization FROM public.knowledge_upload_authorizations
    WHERE upload_ticket = p_upload_ticket AND owner_id = owner FOR UPDATE;$new$
  );
  IF restored = definition THEN
    RAISE EXCEPTION 'autoforge_knowledge_verify_upload consent rollback anchor was not found';
  END IF;

  EXECUTE restored;
END
$rollback$;

REVOKE ALL ON FUNCTION public.autoforge_knowledge_assert_cloud_sync_consent(varchar)
  FROM PUBLIC, anon, authenticated, service_role;
DROP FUNCTION IF EXISTS public.autoforge_knowledge_assert_cloud_sync_consent(varchar);

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_require_cloud(p_owner_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE entitlement public.knowledge_entitlements%ROWTYPE;
BEGIN
  SELECT * INTO entitlement FROM public.knowledge_entitlements WHERE owner_id = p_owner_id;
  IF NOT FOUND OR entitlement.kill_switch_enabled THEN
    RAISE EXCEPTION USING MESSAGE = 'KILL_SWITCH_ENABLED', ERRCODE = 'P0001';
  END IF;
  IF entitlement.tier <> 'member' OR NOT entitlement.cloud_enabled
    OR entitlement.status NOT IN ('active', 'offline_grace') THEN
    RAISE EXCEPTION USING MESSAGE = 'ENTITLEMENT_REQUIRED', ERRCODE = 'P0001';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.autoforge_knowledge_list_bases(varchar, varchar, integer, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_cleanup_owner_catalog(varchar, integer)
  FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.autoforge_knowledge_list_bases(varchar, varchar, integer, integer, integer);
DROP FUNCTION IF EXISTS public.autoforge_knowledge_cleanup_owner_catalog(varchar, integer);

COMMIT;
