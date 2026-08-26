-- Fix PostgreSQL operator precedence when deriving legacy receipt IDs.
DO $$
DECLARE
  function_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.autoforge_import_legacy_batch(character varying,integer,character varying,character varying,boolean,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  ) INTO function_definition;
  function_definition := replace(
    function_definition,
    $patch$p_batch_id || ':conversation:' || item->>'id'$patch$,
    $patch$p_batch_id || ':conversation:' || (item->>'id')$patch$
  );
  function_definition := replace(
    function_definition,
    $patch$p_batch_id || ':message:' || item->>'id'$patch$,
    $patch$p_batch_id || ':message:' || (item->>'id')$patch$
  );
  EXECUTE function_definition;
END
$$;
