BEGIN;

-- Reader-first additive rollout: the nullable column is installed before the
-- trigger or list RPC starts referring to it. Legacy rows remain NULL.
ALTER TABLE app_messages ADD COLUMN IF NOT EXISTS provider_projection jsonb;

CREATE OR REPLACE FUNCTION autoforge_apply_message_provider_projection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  payload jsonb;
  projection jsonb;
  stored_projection jsonb;
BEGIN
  IF NEW.kind <> 'message.append' OR NEW.status NOT IN ('applied', 'duplicate') THEN
    RETURN NEW;
  END IF;
  payload := NEW.mutation_payload->'payload';
  projection := payload->'providerProjection';
  SELECT message.provider_projection INTO stored_projection
  FROM app_messages message
  WHERE message.owner_user_id = NEW.owner_user_id AND message.id = NEW.entity_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  IF projection IS NULL THEN
    IF stored_projection IS NOT NULL THEN
      RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF jsonb_typeof(projection) <> 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(projection)) <> 3
    OR projection->>'kind' <> 'local_conversion'
    OR projection->>'targetFormat' NOT IN (
      'png', 'jpeg', 'webp', 'avif', 'tiff', 'bmp', 'gif', 'ico', 'icns', 'pdf', 'xlsx',
      'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'mp4', 'webm', 'mov'
    )
    OR jsonb_typeof(projection->'attachmentCount') <> 'number'
    OR projection->>'attachmentCount' !~ '^[1-5]$'
    OR payload->>'role' <> 'user'
    OR (SELECT count(*) FROM jsonb_array_elements(payload->'blocks') block
        WHERE block->>'type' = 'media' AND block->>'purpose' = 'input')
      <> (projection->>'attachmentCount')::integer
    OR stored_projection IS NOT NULL AND stored_projection IS DISTINCT FROM projection THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  UPDATE app_messages SET provider_projection = projection
  WHERE owner_user_id = NEW.owner_user_id AND id = NEW.entity_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS app_sync_message_provider_projection ON app_sync_mutations;
CREATE TRIGGER app_sync_message_provider_projection
BEFORE INSERT ON app_sync_mutations
FOR EACH ROW EXECUTE FUNCTION autoforge_apply_message_provider_projection();

CREATE OR REPLACE FUNCTION autoforge_list_messages(
  p_caller_user_id varchar,
  p_conversation_id varchar,
  p_limit integer DEFAULT 100,
  p_cursor varchar DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  auth_user_id bigint;
  before_ordinal bigint;
  result jsonb;
BEGIN
  auth_user_id := autoforge_resolve_user_id(p_caller_user_id);
  PERFORM autoforge_require_identifier(p_conversation_id, 128);
  IF p_limit <> 100 OR NOT EXISTS (
    SELECT 1 FROM app_conversations conversation
    WHERE conversation.owner_user_id = auth_user_id AND conversation.id = p_conversation_id
  ) THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  IF p_cursor IS NOT NULL THEN
    SELECT message.ordinal INTO before_ordinal
    FROM app_messages message
    WHERE message.owner_user_id = auth_user_id
      AND message.conversation_id = p_conversation_id
      AND message.cursor_token::text = p_cursor;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
    END IF;
  END IF;

  WITH candidates AS (
    SELECT message.*
    FROM app_messages message
    WHERE message.owner_user_id = auth_user_id
      AND message.conversation_id = p_conversation_id
      AND (p_cursor IS NULL OR message.ordinal < before_ordinal)
    ORDER BY message.ordinal DESC
    LIMIT 101
  ), page AS (
    SELECT * FROM candidates ORDER BY ordinal DESC LIMIT 100
  )
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'items', COALESCE(jsonb_agg(jsonb_build_object(
      'id', page.id,
      'conversationId', page.conversation_id,
      'role', page.role,
      'blocks', page.blocks,
      'providerProjection', page.provider_projection,
      'executionId', page.execution_id,
      'createdAt', autoforge_iso_timestamp(page.created_at)
    ) ORDER BY page.ordinal), '[]'::jsonb),
    'previousCursor', CASE WHEN (SELECT count(*) FROM candidates) > 100
      THEN (array_agg(page.cursor_token::text ORDER BY page.ordinal))[1]
      ELSE NULL END
  )) INTO result
  FROM page;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION autoforge_apply_message_provider_projection() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION autoforge_list_messages(varchar, varchar, integer, varchar) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION autoforge_list_messages(varchar, varchar, integer, varchar) TO service_role;

COMMIT;
