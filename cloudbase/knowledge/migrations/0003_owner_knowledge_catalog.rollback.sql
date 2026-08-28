BEGIN;

REVOKE ALL ON FUNCTION public.autoforge_knowledge_list_bases(varchar, varchar, integer, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_cleanup_owner_catalog(varchar, integer)
  FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.autoforge_knowledge_list_bases(varchar, varchar, integer, integer, integer);
DROP FUNCTION IF EXISTS public.autoforge_knowledge_cleanup_owner_catalog(varchar, integer);

COMMIT;
