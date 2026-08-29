-- Permit the new immutable message transition on deployed databases. The
-- replacement autoforge_sync_push definition from the foundation migration is
-- deployed with this migration release and validates the payload strictly.
DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'app_sync_mutations'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%message.append%'
  LOOP
    EXECUTE format('ALTER TABLE app_sync_mutations DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE app_sync_mutations ALTER COLUMN kind TYPE varchar(64);
ALTER TABLE app_sync_mutations DROP CONSTRAINT IF EXISTS app_sync_mutations_kind_check;
ALTER TABLE app_sync_mutations ADD CONSTRAINT app_sync_mutations_kind_check CHECK (kind IN (
  'conversation.create', 'conversation.rename', 'conversation.preferences',
  'conversation.delete', 'conversation.restore', 'message.append',
  'message.conversion_block_terminal', 'legacy.import', 'privacy.consent',
  'preferences.update', 'usage.record'
));

-- Keep deployed databases on exactly the same strict protocol implementation
-- as new installations. This replaces the production function atomically.
CREATE OR REPLACE FUNCTION autoforge_sync_push(
  p_caller_user_id varchar,
  p_protocol_version integer,
  p_device_id varchar,
  p_mutations jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_variable
DECLARE
  auth_user_id bigint;
  mutation_record record;
  mutation jsonb;
  payload jsonb;
  device_row app_sync_devices%ROWTYPE;
  existing_receipt app_sync_mutations%ROWTYPE;
  existing_message app_messages%ROWTYPE;
  existing_block jsonb;
  conversation_row app_conversations%ROWTYPE;
  preferences_row app_user_data_preferences%ROWTYPE;
  mutation_id text;
  mutation_kind text;
  entity_id text;
  conversation_id text;
  request_hash_value text;
  mutation_status text;
  mutation_error text;
  base_revision_value bigint;
  result_revision_value bigint;
  assigned_ordinal bigint;
  latest_cursor text;
  result_id text;
  receipt_ready boolean;
  results jsonb := '[]'::jsonb;
BEGIN
  auth_user_id := autoforge_resolve_user_id(p_caller_user_id);
  PERFORM autoforge_require_identifier(p_device_id, 128);
  IF p_protocol_version IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION USING MESSAGE = 'UPGRADE_REQUIRED', ERRCODE = 'P0001';
  END IF;
  IF p_mutations IS NULL OR jsonb_typeof(p_mutations) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  IF jsonb_array_length(p_mutations) > 100
    OR pg_column_size(p_mutations) > 1048576 THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;

  SELECT * INTO device_row
  FROM app_sync_devices device
  WHERE device.owner_user_id = auth_user_id
    AND device.device_id = p_device_id
  FOR UPDATE;
  IF FOUND AND device_row.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'FORBIDDEN', ERRCODE = 'P0001';
  END IF;

  INSERT INTO app_sync_devices(owner_user_id, device_id, protocol_version)
  VALUES (auth_user_id, p_device_id, p_protocol_version)
  ON CONFLICT (owner_user_id, device_id) DO UPDATE SET
    protocol_version = EXCLUDED.protocol_version;

  FOR mutation_record IN
    SELECT item.value, item.ordinality
    FROM jsonb_array_elements(p_mutations) WITH ORDINALITY AS item(value, ordinality)
    ORDER BY item.ordinality
  LOOP
    BEGIN
    result_id := 'invalid-' || mutation_record.ordinality::text;
    receipt_ready := false;
    mutation := mutation_record.value;
    IF jsonb_typeof(mutation) <> 'object'
      OR EXISTS (
        SELECT 1 FROM jsonb_object_keys(mutation) AS supplied_key
        WHERE supplied_key NOT IN ('id', 'entityId', 'baseRevision', 'occurredAt', 'kind', 'payload')
      )
      OR NOT (mutation ?& ARRAY['id', 'entityId', 'baseRevision', 'occurredAt', 'kind', 'payload'])
      OR jsonb_typeof(mutation->'id') <> 'string'
      OR jsonb_typeof(mutation->'entityId') <> 'string'
      OR jsonb_typeof(mutation->'kind') <> 'string'
      OR jsonb_typeof(mutation->'baseRevision') <> 'number'
      OR mutation ? 'ownerUserId'
      OR mutation ? 'owner_user_id'
      OR jsonb_typeof(mutation->'payload') <> 'object' THEN
      RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
    END IF;

    mutation_id := mutation->>'id';
    mutation_kind := mutation->>'kind';
    entity_id := mutation->>'entityId';
    payload := mutation->'payload';
    PERFORM autoforge_require_identifier(mutation_id, 128);
    result_id := mutation_id;
    PERFORM autoforge_require_identifier(entity_id, 128);
    IF mutation_kind NOT IN (
      'conversation.create', 'conversation.rename', 'conversation.preferences',
      'conversation.delete', 'conversation.restore',
      'message.append', 'message.conversion_block_terminal', 'legacy.import', 'privacy.consent', 'preferences.update', 'usage.record'
    )
      OR mutation->>'baseRevision' !~ '^(0|[1-9][0-9]{0,18})$'
      OR (mutation->>'baseRevision')::numeric > 9223372036854775807
      OR jsonb_typeof(mutation->'occurredAt') <> 'string' THEN
      RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
    END IF;
    PERFORM (mutation->>'occurredAt')::timestamptz;

    base_revision_value := (mutation->>'baseRevision')::bigint;
    request_hash_value := md5(mutation::text);
    receipt_ready := true;
    mutation_status := 'applied';
    mutation_error := NULL;
    result_revision_value := NULL;

    PERFORM pg_advisory_xact_lock(
      hashtextextended(auth_user_id::text || ':mutation:' || mutation_id, 0)
    );
    SELECT * INTO existing_receipt
    FROM app_sync_mutations receipt
    WHERE receipt.owner_user_id = auth_user_id
      AND receipt.mutation_id = mutation_id
    FOR UPDATE;
    IF FOUND THEN
      IF existing_receipt.request_hash = request_hash_value THEN
        results := results || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
          'id', mutation_id,
          'status', CASE
            WHEN existing_receipt.kind = 'message.conversion_block_terminal'
              THEN existing_receipt.status
            WHEN existing_receipt.status = 'applied' THEN 'duplicate'
            ELSE existing_receipt.status
          END,
          'revision', existing_receipt.result_revision,
          'errorCode', existing_receipt.error_code
        )));
      ELSE
        results := results || jsonb_build_array(jsonb_build_object(
          'id', mutation_id, 'status', 'rejected', 'errorCode', 'INVALID_INPUT'
        ));
      END IF;
      latest_cursor := existing_receipt.cursor_token::text;
      CONTINUE;
    END IF;

    IF mutation_kind = 'conversation.create' THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(auth_user_id::text || ':' || entity_id, 0));
      SELECT * INTO conversation_row
      FROM app_conversations conversation
      WHERE conversation.owner_user_id = auth_user_id AND conversation.id = entity_id
      FOR UPDATE;
      IF FOUND OR base_revision_value <> 0 THEN
        mutation_status := 'conflict';
        mutation_error := 'SYNC_CONFLICT';
      ELSIF payload->>'title' IS NULL
        OR length(payload->>'title') NOT BETWEEN 1 AND 500
        OR payload->>'title' <> btrim(payload->>'title')
        OR payload->>'titleState' NOT IN ('pending', 'generating', 'ai_named', 'user_named', 'failed')
        OR NOT (payload ?& ARRAY['createdAt', 'lastActivityAt', 'metadataUpdatedAt']) THEN
        mutation_status := 'rejected';
        mutation_error := 'INVALID_INPUT';
      ELSE
        INSERT INTO app_conversations(
          id, owner_user_id, title, title_state, revision,
          created_at, last_activity_at, metadata_updated_at
        ) VALUES (
          entity_id, auth_user_id, payload->>'title', payload->>'titleState', 1,
          (payload->>'createdAt')::timestamptz,
          (payload->>'lastActivityAt')::timestamptz,
          (payload->>'metadataUpdatedAt')::timestamptz
        );
        result_revision_value := 1;
      END IF;

    ELSIF mutation_kind IN ('conversation.rename', 'conversation.preferences',
      'conversation.delete', 'conversation.restore') THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(auth_user_id::text || ':' || entity_id, 0));
      SELECT * INTO conversation_row
      FROM app_conversations conversation
      WHERE conversation.owner_user_id = auth_user_id AND conversation.id = entity_id
      FOR UPDATE;
      IF NOT FOUND THEN
        mutation_status := 'conflict';
        mutation_error := 'SYNC_CONFLICT';
        IF mutation_kind IN ('conversation.rename', 'conversation.preferences') THEN
          mutation := jsonb_build_object('compacted', true);
        END IF;
      ELSIF conversation_row.revision <> base_revision_value THEN
        mutation_status := 'conflict';
        mutation_error := 'SYNC_CONFLICT';
      ELSIF mutation_kind = 'conversation.rename' THEN
        IF payload->>'title' IS NULL
          OR length(payload->>'title') NOT BETWEEN 1 AND 500
          OR payload->>'title' <> btrim(payload->>'title')
          OR payload->>'titleState' NOT IN ('pending', 'generating', 'ai_named', 'user_named', 'failed')
          OR NOT (payload ? 'metadataUpdatedAt') THEN
          mutation_status := 'rejected';
          mutation_error := 'INVALID_INPUT';
        ELSIF conversation_row.title_state = 'user_named'
          AND payload->>'titleState' <> 'user_named' THEN
          mutation_status := 'conflict';
          mutation_error := 'SYNC_CONFLICT';
        ELSE
          result_revision_value := conversation_row.revision + 1;
          UPDATE app_conversations SET
            title = payload->>'title',
            title_state = payload->>'titleState',
            metadata_updated_at = (payload->>'metadataUpdatedAt')::timestamptz,
            revision = result_revision_value
          WHERE owner_user_id = auth_user_id AND id = entity_id;
        END IF;
      ELSIF mutation_kind = 'conversation.preferences' THEN
        IF jsonb_typeof(payload->'preferences') <> 'object'
          OR jsonb_typeof(payload->'metadataUpdatedAt') <> 'string'
          OR EXISTS (
            SELECT 1 FROM jsonb_object_keys(payload) AS supplied_key
            WHERE supplied_key NOT IN ('preferences', 'metadataUpdatedAt')
          )
          OR NOT (payload ?& ARRAY['preferences', 'metadataUpdatedAt'])
          OR EXISTS (
            SELECT 1 FROM jsonb_object_keys(payload->'preferences') AS supplied_key
            WHERE supplied_key NOT IN ('outputType', 'models', 'generation')
          )
          OR NOT (payload->'preferences' ?& ARRAY['outputType', 'models', 'generation'])
          OR jsonb_typeof(payload->'preferences'->'outputType') <> 'string'
          OR payload->'preferences'->>'outputType' NOT IN ('auto', 'text', 'image', 'audio', 'video')
          OR jsonb_typeof(payload->'preferences'->'models') <> 'object'
          OR EXISTS (
            SELECT 1 FROM jsonb_each(payload->'preferences'->'models') AS model(key, value)
            WHERE model.key NOT IN ('text', 'image', 'audio', 'video')
              OR jsonb_typeof(model.value) <> 'string'
              OR length(model.value #>> '{}') < 1
              OR model.value #>> '{}' <> btrim(model.value #>> '{}')
          )
          OR jsonb_typeof(payload->'preferences'->'generation') <> 'object'
          OR EXISTS (
            SELECT 1 FROM jsonb_object_keys(payload->'preferences'->'generation') AS supplied_key
            WHERE supplied_key NOT IN ('image', 'audio', 'video')
          )
          OR NOT (payload->'preferences'->'generation' ?& ARRAY['image', 'audio', 'video'])
          OR jsonb_typeof(payload->'preferences'->'generation'->'image') <> 'object'
          OR NOT (payload->'preferences'->'generation'->'image'
            ?& ARRAY['count', 'resolution', 'aspectRatio', 'format'])
          OR EXISTS (
            SELECT 1 FROM jsonb_object_keys(
              payload->'preferences'->'generation'->'image'
            ) AS supplied_key
            WHERE supplied_key NOT IN ('count', 'resolution', 'aspectRatio', 'format')
          )
          OR payload->'preferences'->'generation'->'image'->'count' <> '1'::jsonb
          OR jsonb_typeof(payload->'preferences'->'generation'->'image'->'resolution') <> 'string'
          OR jsonb_typeof(payload->'preferences'->'generation'->'image'->'aspectRatio') <> 'string'
          OR jsonb_typeof(payload->'preferences'->'generation'->'image'->'format') <> 'string'
          OR jsonb_typeof(payload->'preferences'->'generation'->'audio') <> 'object'
          OR NOT (payload->'preferences'->'generation'->'audio' ? 'format')
          OR EXISTS (
            SELECT 1 FROM jsonb_object_keys(
              payload->'preferences'->'generation'->'audio'
            ) AS supplied_key
            WHERE supplied_key NOT IN ('voice', 'format')
          )
          OR jsonb_typeof(payload->'preferences'->'generation'->'audio'->'format') <> 'string'
          OR (payload->'preferences'->'generation'->'audio' ? 'voice' AND (
            jsonb_typeof(payload->'preferences'->'generation'->'audio'->'voice') <> 'string'
            OR length(payload->'preferences'->'generation'->'audio'->>'voice') < 1
            OR payload->'preferences'->'generation'->'audio'->>'voice'
              <> btrim(payload->'preferences'->'generation'->'audio'->>'voice')
          ))
          OR jsonb_typeof(payload->'preferences'->'generation'->'video') <> 'object'
          OR NOT (payload->'preferences'->'generation'->'video'
            ?& ARRAY['durationSeconds', 'resolution', 'aspectRatio', 'generateAudio'])
          OR EXISTS (
            SELECT 1 FROM jsonb_object_keys(
              payload->'preferences'->'generation'->'video'
            ) AS supplied_key
            WHERE supplied_key NOT IN (
              'durationSeconds', 'resolution', 'aspectRatio', 'generateAudio'
            )
          )
          OR payload->'preferences'->'generation'->'video'->>'durationSeconds'
            !~ '^[1-9][0-9]*$'
          OR jsonb_typeof(
            payload->'preferences'->'generation'->'video'->'durationSeconds'
          ) <> 'number'
          OR jsonb_typeof(payload->'preferences'->'generation'->'video'->'resolution') <> 'string'
          OR jsonb_typeof(payload->'preferences'->'generation'->'video'->'aspectRatio') <> 'string'
          OR jsonb_typeof(payload->'preferences'->'generation'->'video'->'generateAudio') <> 'boolean' THEN
          mutation_status := 'rejected';
          mutation_error := 'INVALID_INPUT';
        ELSE
          result_revision_value := conversation_row.revision + 1;
          UPDATE app_conversations SET
            generation_preferences = payload->'preferences',
            metadata_updated_at = (payload->>'metadataUpdatedAt')::timestamptz,
            revision = result_revision_value
          WHERE owner_user_id = auth_user_id AND id = entity_id;
        END IF;
      ELSIF mutation_kind = 'conversation.delete' THEN
        result_revision_value := conversation_row.revision + 1;
        UPDATE app_conversations SET
          deleted_at = COALESCE(deleted_at, clock_timestamp()),
          metadata_updated_at = clock_timestamp(),
          revision = result_revision_value
        WHERE owner_user_id = auth_user_id AND id = entity_id;
      ELSIF conversation_row.deleted_at IS NULL
        OR conversation_row.deleted_at < clock_timestamp() - interval '30 days' THEN
        mutation_status := 'conflict';
        mutation_error := 'SYNC_CONFLICT';
      ELSE
        result_revision_value := conversation_row.revision + 1;
        UPDATE app_conversations SET
          deleted_at = NULL,
          metadata_updated_at = clock_timestamp(),
          revision = result_revision_value
        WHERE owner_user_id = auth_user_id AND id = entity_id;
      END IF;

    ELSIF mutation_kind = 'message.conversion_block_terminal' THEN
      IF payload->>'messageId' IS DISTINCT FROM entity_id
        OR payload->>'state' IS DISTINCT FROM 'terminal'
        OR NOT (payload ?& ARRAY['messageId', 'blockId', 'executionId', 'state'])
        OR (SELECT count(*) FROM jsonb_object_keys(payload)) <> 4
        OR jsonb_typeof(payload->'messageId') <> 'string'
        OR jsonb_typeof(payload->'blockId') <> 'string'
        OR jsonb_typeof(payload->'executionId') <> 'string'
        OR jsonb_typeof(payload->'state') <> 'string' THEN
        mutation_status := 'rejected'; mutation_error := 'INVALID_INPUT';
      ELSE
        PERFORM autoforge_require_identifier(payload->>'messageId', 128);
        PERFORM autoforge_require_identifier(payload->>'blockId', 128);
        PERFORM autoforge_require_identifier(payload->>'executionId', 128);
        PERFORM pg_advisory_xact_lock(hashtextextended(
          auth_user_id::text || ':message:' || entity_id, 0
        ));
        SELECT * INTO existing_message
        FROM app_messages message
        WHERE message.owner_user_id = auth_user_id AND message.id = entity_id
        FOR UPDATE;
        IF NOT FOUND OR (SELECT count(*) FROM jsonb_array_elements(existing_message.blocks) block
              WHERE block->>'blockId' = payload->>'blockId') <> 1 THEN
          mutation_status := 'rejected'; mutation_error := 'INVALID_INPUT';
        ELSE
          SELECT block INTO existing_block
          FROM jsonb_array_elements(existing_message.blocks) block
          WHERE block->>'blockId' = payload->>'blockId';
          IF existing_block->>'type' IS DISTINCT FROM 'conversion'
            OR existing_block->>'executionId' IS DISTINCT FROM payload->>'executionId'
            OR (existing_block->>'state' IS DISTINCT FROM 'active'
              AND existing_block->>'state' IS DISTINCT FROM 'terminal') THEN
            mutation_status := 'rejected'; mutation_error := 'INVALID_INPUT';
          ELSE
            PERFORM pg_advisory_xact_lock(hashtextextended(
              auth_user_id::text || ':' || existing_message.conversation_id, 0
            ));
            SELECT * INTO conversation_row
            FROM app_conversations conversation
            WHERE conversation.owner_user_id = auth_user_id
              AND conversation.id = existing_message.conversation_id
            FOR UPDATE;
            IF NOT FOUND OR conversation_row.deleted_at IS NOT NULL
              OR conversation_row.revision <> base_revision_value THEN
              mutation_status := 'conflict'; mutation_error := 'SYNC_CONFLICT';
            ELSIF existing_block->>'state' = 'terminal' THEN
              result_revision_value := base_revision_value;
              mutation_status := 'duplicate';
            ELSE
              result_revision_value := base_revision_value + 1;
              UPDATE app_messages SET blocks = (SELECT jsonb_agg(CASE
                WHEN block->>'type' = 'conversion' AND block->>'blockId' = payload->>'blockId'
                  AND block->>'executionId' = payload->>'executionId' AND block->>'state' = 'active'
                THEN jsonb_set(block, '{state}', '"terminal"'::jsonb) ELSE block END)
                FROM jsonb_array_elements(blocks) block)
              WHERE owner_user_id = auth_user_id AND id = entity_id;
              UPDATE app_conversations SET revision = result_revision_value
              WHERE owner_user_id = auth_user_id AND id = existing_message.conversation_id;
            END IF;
          END IF;
        END IF;
      END IF;
    ELSIF mutation_kind = 'message.append' THEN
      conversation_id := payload->>'conversationId';
      PERFORM autoforge_require_identifier(conversation_id, 128);
      IF payload->>'id' IS DISTINCT FROM entity_id
        OR payload->>'role' NOT IN ('user', 'assistant')
        OR jsonb_typeof(payload->'blocks') <> 'array'
        OR NOT (payload ? 'createdAt') THEN
        mutation_status := 'rejected';
        mutation_error := 'INVALID_INPUT';
      ELSE
        PERFORM pg_advisory_xact_lock(hashtextextended(
          auth_user_id::text || ':message:' || entity_id, 0
        ));
        SELECT * INTO existing_message
        FROM app_messages message
        WHERE message.owner_user_id = auth_user_id AND message.id = entity_id;
        IF FOUND THEN
          IF existing_message.conversation_id IS DISTINCT FROM conversation_id
            OR existing_message.role IS DISTINCT FROM payload->>'role'
            OR existing_message.blocks IS DISTINCT FROM payload->'blocks'
            OR existing_message.execution_id IS DISTINCT FROM NULLIF(payload->>'executionId', '')
            OR existing_message.created_at IS DISTINCT FROM (payload->>'createdAt')::timestamptz THEN
            mutation_status := 'rejected';
            mutation_error := 'INVALID_INPUT';
          ELSE
            SELECT revision INTO result_revision_value
            FROM app_conversations conversation
            WHERE conversation.owner_user_id = auth_user_id
              AND conversation.id = existing_message.conversation_id;
            mutation_status := 'duplicate';
          END IF;
        ELSE
          PERFORM pg_advisory_xact_lock(hashtextextended(auth_user_id::text || ':' || conversation_id, 0));
          SELECT * INTO conversation_row
          FROM app_conversations conversation
          WHERE conversation.owner_user_id = auth_user_id AND conversation.id = conversation_id
          FOR UPDATE;
          IF NOT FOUND THEN
            mutation_status := 'conflict';
            mutation_error := 'SYNC_CONFLICT';
            mutation := jsonb_build_object(
              'compacted', true,
              'conversationId', conversation_id
            );
          ELSIF conversation_row.deleted_at IS NOT NULL
            OR conversation_row.revision <> base_revision_value THEN
            mutation_status := 'conflict';
            mutation_error := 'SYNC_CONFLICT';
          ELSE
            SELECT COALESCE(max(message.ordinal), 0) + 1 INTO assigned_ordinal
            FROM app_messages message
            WHERE message.owner_user_id = auth_user_id
              AND message.conversation_id = conversation_id;
            INSERT INTO app_messages(
              id, owner_user_id, conversation_id, ordinal, role, blocks, execution_id, created_at
            ) VALUES (
              entity_id, auth_user_id, conversation_id, assigned_ordinal, payload->>'role',
              payload->'blocks', NULLIF(payload->>'executionId', ''), (payload->>'createdAt')::timestamptz
            );
            result_revision_value := conversation_row.revision + 1;
            UPDATE app_conversations SET
              revision = result_revision_value,
              last_activity_at = GREATEST(last_activity_at, (payload->>'createdAt')::timestamptz)
            WHERE owner_user_id = auth_user_id AND id = conversation_id;
          END IF;
        END IF;
      END IF;

    ELSIF mutation_kind = 'privacy.consent' THEN
      IF payload->>'documentVersion' IS DISTINCT FROM entity_id OR base_revision_value <> 0 THEN
        mutation_status := 'rejected';
        mutation_error := 'INVALID_INPUT';
      ELSE
        PERFORM autoforge_record_consent(auth_user_id, payload);
        result_revision_value := 0;
      END IF;

    ELSIF mutation_kind = 'preferences.update' THEN
      IF payload->>'timezone' IS NULL
        OR length(payload->>'timezone') NOT BETWEEN 1 AND 128
        OR payload->>'displayCurrency' IS NULL
        OR payload->>'displayCurrency' NOT IN ('CNY', 'USD') THEN
        mutation_status := 'rejected';
        mutation_error := 'INVALID_INPUT';
      ELSE
        PERFORM pg_advisory_xact_lock(hashtextextended(auth_user_id::text || ':preferences', 0));
        SELECT * INTO preferences_row
        FROM app_user_data_preferences preferences
        WHERE preferences.owner_user_id = auth_user_id
        FOR UPDATE;
        IF FOUND AND preferences_row.revision <> base_revision_value THEN
          mutation_status := 'conflict';
          mutation_error := 'SYNC_CONFLICT';
        ELSIF NOT FOUND AND base_revision_value <> 0 THEN
          mutation_status := 'conflict';
          mutation_error := 'SYNC_CONFLICT';
        ELSE
          result_revision_value := COALESCE(preferences_row.revision, 0) + 1;
          INSERT INTO app_user_data_preferences(
            owner_user_id, timezone, display_currency, revision
          ) VALUES (
            auth_user_id, payload->>'timezone', payload->>'displayCurrency', result_revision_value
          )
          ON CONFLICT (owner_user_id) DO UPDATE SET
            timezone = EXCLUDED.timezone,
            display_currency = EXCLUDED.display_currency,
            revision = EXCLUDED.revision,
            updated_at = clock_timestamp();
        END IF;
      END IF;

    ELSIF mutation_kind = 'usage.record' THEN
      IF payload->>'id' IS DISTINCT FROM entity_id
        OR base_revision_value <> 0
        OR payload->>'credentialOwner' <> 'user'
        OR jsonb_typeof(payload->'billable') <> 'boolean'
        OR payload->'billable' <> 'false'::jsonb
        OR payload->>'costStatus' NOT IN ('estimated', 'unavailable')
        OR payload->>'provider' NOT IN ('deepseek', 'openrouter')
        OR payload->>'modality' NOT IN ('text', 'image', 'audio', 'video') THEN
        mutation_status := 'rejected';
        mutation_error := 'INVALID_INPUT';
      ELSIF EXISTS (
        SELECT 1 FROM app_usage_events usage
        WHERE usage.owner_user_id = auth_user_id
          AND usage.operation_id = payload->>'operationId'
          AND usage.provider = payload->>'provider'
          AND usage.purpose = payload->>'purpose'
      ) THEN
        mutation_status := 'duplicate';
        result_revision_value := 0;
      ELSE
        INSERT INTO app_usage_events(
          id, owner_user_id, operation_id, provider, model, purpose, modality,
          credential_owner, billable, status, input_tokens, output_tokens,
          estimated_cost, currency, occurred_at
        ) VALUES (
          entity_id, auth_user_id, payload->>'operationId', payload->>'provider',
          payload->>'model', payload->>'purpose', payload->>'modality', 'user', false,
          payload->>'costStatus', (payload->>'inputTokens')::bigint,
          (payload->>'outputTokens')::bigint,
          CASE WHEN payload->>'costStatus' = 'estimated'
            THEN (payload->>'estimatedCostUsd')::numeric ELSE NULL END,
          CASE WHEN payload->>'costStatus' = 'estimated' THEN 'USD' ELSE NULL END,
          (payload->>'occurredAt')::timestamptz
        );
        result_revision_value := 0;
      END IF;

    ELSE
      IF payload->>'batchId' IS DISTINCT FROM entity_id OR base_revision_value <> 0
        OR jsonb_typeof(payload->'includeUnowned') <> 'boolean'
        OR payload->'includeUnowned' = 'true'::jsonb
          AND COALESCE(payload->'unownedImportConsent'->>'purpose', '') <> 'legacy_unowned_import'
        OR COALESCE(payload->'cloudSyncConsent'->>'purpose', '') <> 'cloud_sync' THEN
        mutation_status := 'rejected';
        mutation_error := 'INVALID_INPUT';
      ELSE
        PERFORM autoforge_record_consent(auth_user_id, payload->'cloudSyncConsent');
        IF payload->'includeUnowned' = 'true'::jsonb THEN
          PERFORM autoforge_record_consent(auth_user_id, payload->'unownedImportConsent');
        END IF;
        result_revision_value := 0;
      END IF;
    END IF;

    INSERT INTO app_sync_mutations(
      owner_user_id, mutation_id, device_id, kind, entity_id, base_revision,
      result_revision, status, error_code, mutation_payload, request_hash
    ) VALUES (
      auth_user_id, mutation_id, p_device_id, mutation_kind, entity_id, base_revision_value,
      result_revision_value, mutation_status, mutation_error, mutation, request_hash_value
    )
    RETURNING cursor_token::text INTO latest_cursor;

    results := results || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'id', mutation_id,
      'status', mutation_status,
      'revision', result_revision_value,
      'errorCode', mutation_error
    )));
    EXCEPTION
      WHEN SQLSTATE 'P0001' OR data_exception OR integrity_constraint_violation THEN
      IF receipt_ready THEN
        PERFORM pg_advisory_xact_lock(
          hashtextextended(auth_user_id::text || ':mutation:' || mutation_id, 0)
        );
        INSERT INTO app_sync_mutations(
          owner_user_id, mutation_id, device_id, kind, entity_id, base_revision,
          status, error_code, mutation_payload, request_hash
        ) VALUES (
          auth_user_id, mutation_id, p_device_id, mutation_kind, entity_id,
          base_revision_value, 'rejected', 'INVALID_INPUT', mutation, request_hash_value
        )
        ON CONFLICT (owner_user_id, mutation_id) DO NOTHING
        RETURNING cursor_token::text INTO latest_cursor;
      END IF;
      results := results || jsonb_build_array(jsonb_build_object(
        'id', result_id, 'status', 'rejected', 'errorCode', 'INVALID_INPUT'
      ));
      WHEN OTHERS THEN
        RAISE EXCEPTION USING MESSAGE = 'INTERNAL_ERROR', ERRCODE = 'P0001';
    END;
  END LOOP;

  UPDATE app_sync_devices SET last_push_at = clock_timestamp()
  WHERE owner_user_id = auth_user_id AND device_id = p_device_id;

  SELECT mutation.cursor_token::text INTO latest_cursor
  FROM app_sync_mutations mutation
  WHERE mutation.owner_user_id = auth_user_id
  ORDER BY mutation.server_sequence DESC
  LIMIT 1;

  RETURN jsonb_strip_nulls(jsonb_build_object('results', results, 'cursor', latest_cursor));
EXCEPTION
  WHEN SQLSTATE 'P0001' THEN
    RAISE;
  WHEN OTHERS THEN
    RAISE EXCEPTION USING MESSAGE = 'INTERNAL_ERROR', ERRCODE = 'P0001';
END;
$$;
