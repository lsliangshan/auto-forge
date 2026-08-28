BEGIN;

REVOKE ALL ON FUNCTION public.autoforge_knowledge_begin_generation(
  varchar, varchar, varchar, varchar, varchar, varchar
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_get_upload_work(
  varchar, varchar, varchar
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_complete_upload_index(
  varchar, varchar, varchar, bigint, varchar, varchar, varchar, varchar,
  varchar, varchar, varchar, integer, varchar, varchar, jsonb, jsonb
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_yield_job(
  varchar, varchar, varchar
) FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.autoforge_knowledge_yield_job(
  varchar, varchar, varchar
);
DROP FUNCTION IF EXISTS public.autoforge_knowledge_complete_upload_index(
  varchar, varchar, varchar, bigint, varchar, varchar, varchar, varchar,
  varchar, varchar, varchar, integer, varchar, varchar, jsonb, jsonb
);
DROP FUNCTION IF EXISTS public.autoforge_knowledge_get_upload_work(
  varchar, varchar, varchar
);
DROP FUNCTION IF EXISTS public.autoforge_knowledge_begin_generation(
  varchar, varchar, varchar, varchar, varchar, varchar
);

COMMIT;
