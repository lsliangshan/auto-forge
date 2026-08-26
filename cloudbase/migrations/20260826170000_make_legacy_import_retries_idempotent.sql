-- A legacy-import batch id is stable for one selected local-history snapshot.
-- Do not reject a retry merely because its refreshed consent metadata changes
-- the stored request hash.
DO $$
DECLARE
  function_definition text;
  patched_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.autoforge_import_legacy_batch(character varying,integer,character varying,character varying,boolean,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  ) INTO function_definition;

  patched_definition := regexp_replace(
    function_definition,
    $pattern$IF receipt\.kind = 'legacy\.import'\s+AND receipt\.request_hash = legacy_request_hash THEN$pattern$,
    $replacement$IF receipt.kind = 'legacy.import' THEN$replacement$
  );

  IF patched_definition = function_definition THEN
    RAISE EXCEPTION 'legacy import retry patch did not match the deployed function';
  END IF;

  EXECUTE patched_definition;
END
$$;
