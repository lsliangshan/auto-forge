-- Personal knowledge selection remains inside the existing revisioned conversation preference payload.
-- This migration widens only the existing sync validator; it creates no selection table.
DO $migration$
DECLARE
  definition text;
  widened text;
BEGIN
  SELECT pg_get_functiondef(
    'autoforge_sync_push(varchar,integer,varchar,jsonb)'::regprocedure
  ) INTO definition;

  widened := replace(
    definition,
    $old$WHERE supplied_key NOT IN ('outputType', 'models', 'generation')$old$,
    $new$WHERE supplied_key NOT IN (
              'outputType', 'models', 'generation', 'knowledgeBaseIds', 'knowledgeMode'
            )$new$
  );
  IF widened = definition THEN
    RAISE EXCEPTION 'autoforge_sync_push preference key validator was not found';
  END IF;

  definition := widened;
  widened := replace(
    definition,
    $old$OR NOT (payload->'preferences' ?& ARRAY['outputType', 'models', 'generation'])
          OR jsonb_typeof(payload->'preferences'->'outputType') <> 'string'$old$,
    $new$OR NOT (payload->'preferences' ?& ARRAY['outputType', 'models', 'generation'])
          OR ((payload->'preferences' ? 'knowledgeBaseIds')
            <> (payload->'preferences' ? 'knowledgeMode'))
          OR CASE WHEN payload->'preferences' ? 'knowledgeBaseIds' THEN
            CASE
              WHEN jsonb_typeof(payload->'preferences'->'knowledgeBaseIds') <> 'array' THEN true
              ELSE jsonb_array_length(payload->'preferences'->'knowledgeBaseIds') > 32
                OR EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements(payload->'preferences'->'knowledgeBaseIds') AS base_id
                  WHERE jsonb_typeof(base_id) <> 'string'
                    OR length(base_id #>> '{}') < 1
                    OR length(base_id #>> '{}') > 128
                    OR base_id #>> '{}' <> btrim(base_id #>> '{}')
                )
                OR (
                  SELECT count(*) <> count(DISTINCT base_id #>> '{}')
                  FROM jsonb_array_elements(payload->'preferences'->'knowledgeBaseIds') AS base_id
                )
                OR payload->'preferences'->>'knowledgeMode' NOT IN ('mixed', 'strict')
            END
          ELSE false END
          OR jsonb_typeof(payload->'preferences'->'outputType') <> 'string'$new$
  );
  IF widened = definition THEN
    RAISE EXCEPTION 'autoforge_sync_push preference requirement validator was not found';
  END IF;

  -- The resulting definition is still CREATE OR REPLACE FUNCTION autoforge_sync_push.
  EXECUTE widened;
END
$migration$;
