-- Upgrade local-conversion Provider projections to bind the exact selected attachment set.
UPDATE app_messages
SET provider_projection = NULL
WHERE provider_projection IS NOT NULL
  AND (
    provider_projection->>'version' IS DISTINCT FROM '2'
    OR jsonb_typeof(provider_projection->'selectedAttachmentIndexes') IS DISTINCT FROM 'array'
  );

CREATE OR REPLACE FUNCTION autoforge_apply_message_provider_projection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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
    OR (SELECT count(*) FROM jsonb_object_keys(projection)) <> 5
    OR projection->>'version' <> '2'
    OR projection->>'kind' <> 'local_conversion'
    OR projection->>'targetFormat' NOT IN (
      'png', 'jpeg', 'webp', 'avif', 'tiff', 'bmp', 'gif', 'ico', 'icns', 'pdf', 'xlsx',
      'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'mp4', 'webm', 'mov'
    )
    OR jsonb_typeof(projection->'attachmentCount') <> 'number'
    OR projection->>'attachmentCount' !~ '^[1-5]$'
    OR jsonb_typeof(projection->'selectedAttachmentIndexes') <> 'array'
    OR jsonb_array_length(projection->'selectedAttachmentIndexes') NOT BETWEEN 1 AND 5
    OR EXISTS (
      SELECT 1
      FROM (
        SELECT selected_text, ordinal,
          lag(selected_text) OVER (ORDER BY ordinal) AS previous_text
        FROM jsonb_array_elements_text(projection->'selectedAttachmentIndexes')
          WITH ORDINALITY AS selected(selected_text, ordinal)
      ) ordered
      WHERE selected_text !~ '^[0-4]$'
        OR CASE WHEN selected_text ~ '^[0-4]$'
          THEN selected_text::integer >= (projection->>'attachmentCount')::integer
          ELSE false END
        OR CASE WHEN selected_text ~ '^[0-4]$' AND previous_text ~ '^[0-4]$'
          THEN selected_text::integer <= previous_text::integer
          ELSE false END
    )
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
