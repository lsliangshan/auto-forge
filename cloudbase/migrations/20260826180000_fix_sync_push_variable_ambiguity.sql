-- Resolve PL/pgSQL variables explicitly when sync-push column names overlap.
DO $$
DECLARE
  function_definition text;
  patched_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.autoforge_sync_push(character varying,integer,character varying,jsonb)'::regprocedure
  ) INTO function_definition;

  IF function_definition LIKE '%#variable_conflict use_variable%' THEN
    RETURN;
  END IF;

  patched_definition := replace(
    function_definition,
    E'AS $function$\nDECLARE',
    E'AS $function$\n#variable_conflict use_variable\nDECLARE'
  );

  IF patched_definition = function_definition THEN
    RAISE EXCEPTION 'sync push variable-conflict patch did not match the deployed function';
  END IF;

  EXECUTE patched_definition;
END
$$;
