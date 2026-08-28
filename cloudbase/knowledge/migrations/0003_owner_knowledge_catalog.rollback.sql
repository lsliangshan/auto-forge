BEGIN;

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
