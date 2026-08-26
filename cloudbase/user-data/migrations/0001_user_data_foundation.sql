BEGIN;

CREATE TABLE IF NOT EXISTS app_conversations (
  id varchar(128) NOT NULL CHECK (length(id) BETWEEN 1 AND 128 AND id = btrim(id)),
  owner_user_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title varchar(500) NOT NULL CHECK (length(title) BETWEEN 1 AND 500 AND title = btrim(title)),
  title_state varchar(32) NOT NULL
    CHECK (title_state IN ('pending', 'generating', 'ai_named', 'user_named', 'failed')),
  generation_preferences jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(generation_preferences) = 'object'),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  last_activity_at timestamptz NOT NULL,
  metadata_updated_at timestamptz NOT NULL,
  cursor_token uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  PRIMARY KEY (owner_user_id, id)
);

CREATE TABLE IF NOT EXISTS app_messages (
  id varchar(128) NOT NULL CHECK (length(id) BETWEEN 1 AND 128 AND id = btrim(id)),
  owner_user_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id varchar(128) NOT NULL,
  ordinal bigint NOT NULL CHECK (ordinal > 0),
  role varchar(16) NOT NULL CHECK (role IN ('user', 'assistant')),
  blocks jsonb NOT NULL CHECK (jsonb_typeof(blocks) = 'array'),
  execution_id varchar(128) CHECK (execution_id IS NULL OR length(execution_id) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  cursor_token uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  FOREIGN KEY (owner_user_id, conversation_id)
    REFERENCES app_conversations(owner_user_id, id) ON DELETE CASCADE,
  PRIMARY KEY (owner_user_id, id)
);

CREATE TABLE IF NOT EXISTS app_model_runs (
  id varchar(128) NOT NULL CHECK (length(id) BETWEEN 1 AND 128 AND id = btrim(id)),
  owner_user_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id varchar(128) NOT NULL,
  operation_id varchar(128) NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 128),
  status varchar(32) NOT NULL
    CHECK (status IN ('queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled')),
  provider varchar(32) NOT NULL CHECK (length(provider) BETWEEN 1 AND 32),
  model varchar(256) NOT NULL CHECK (length(model) BETWEEN 1 AND 256),
  credential_owner varchar(16) NOT NULL CHECK (credential_owner IN ('platform', 'user')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (owner_user_id, conversation_id)
    REFERENCES app_conversations(owner_user_id, id) ON DELETE CASCADE,
  PRIMARY KEY (owner_user_id, id),
  UNIQUE (owner_user_id, operation_id)
);

CREATE TABLE IF NOT EXISTS app_usage_events (
  id varchar(128) NOT NULL CHECK (length(id) BETWEEN 1 AND 128 AND id = btrim(id)),
  owner_user_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id varchar(128),
  operation_id varchar(128) NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 128),
  provider varchar(32) NOT NULL CHECK (length(provider) BETWEEN 1 AND 32),
  model varchar(256) NOT NULL CHECK (length(model) BETWEEN 1 AND 256),
  purpose varchar(64) NOT NULL CHECK (length(purpose) BETWEEN 1 AND 64),
  modality varchar(16) NOT NULL CHECK (modality IN ('text', 'image', 'audio', 'video')),
  credential_owner varchar(16) NOT NULL CHECK (credential_owner IN ('platform', 'user')),
  billable boolean NOT NULL,
  status varchar(32) NOT NULL
    CHECK (status IN ('pending', 'reported', 'calculated', 'estimated', 'unavailable')),
  input_tokens bigint CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens IS NULL OR output_tokens >= 0),
  provider_cost numeric(30, 12) CHECK (provider_cost IS NULL OR provider_cost >= 0),
  charged_amount numeric(30, 12) CHECK (charged_amount IS NULL OR charged_amount >= 0),
  estimated_cost numeric(30, 12) CHECK (estimated_cost IS NULL OR estimated_cost >= 0),
  currency varchar(3) CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (owner_user_id, conversation_id)
    REFERENCES app_conversations(owner_user_id, id) ON DELETE RESTRICT,
  PRIMARY KEY (owner_user_id, id),
  CHECK (
    credential_owner <> 'user'
    OR (billable = false AND status IN ('estimated', 'unavailable') AND charged_amount IS NULL)
  ),
  CHECK (
    (status = 'estimated' AND estimated_cost IS NOT NULL)
    OR (status <> 'estimated' AND estimated_cost IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS app_sync_devices (
  owner_user_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id varchar(128) NOT NULL CHECK (length(device_id) BETWEEN 1 AND 128 AND device_id = btrim(device_id)),
  protocol_version integer NOT NULL CHECK (protocol_version > 0),
  registered_at timestamptz NOT NULL DEFAULT now(),
  last_push_at timestamptz,
  last_pull_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (owner_user_id, device_id)
);

CREATE TABLE IF NOT EXISTS app_sync_mutations (
  server_sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_user_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  mutation_id varchar(128) NOT NULL CHECK (length(mutation_id) BETWEEN 1 AND 128 AND mutation_id = btrim(mutation_id)),
  device_id varchar(128) NOT NULL,
  kind varchar(32) NOT NULL CHECK (kind IN (
    'conversation.create', 'conversation.rename', 'conversation.preferences',
    'conversation.delete', 'conversation.restore',
    'message.append', 'legacy.import', 'privacy.consent', 'preferences.update', 'usage.record'
  )),
  entity_id varchar(128) NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 128 AND entity_id = btrim(entity_id)),
  base_revision bigint NOT NULL CHECK (base_revision >= 0),
  result_revision bigint CHECK (result_revision IS NULL OR result_revision >= 0),
  status varchar(16) NOT NULL CHECK (status IN ('applied', 'duplicate', 'conflict', 'rejected')),
  error_code varchar(64),
  mutation_payload jsonb NOT NULL CHECK (jsonb_typeof(mutation_payload) = 'object'),
  request_hash varchar(32) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{32}$'),
  cursor_token uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, mutation_id),
  FOREIGN KEY (owner_user_id, device_id)
    REFERENCES app_sync_devices(owner_user_id, device_id)
);

CREATE TABLE IF NOT EXISTS app_privacy_consents (
  owner_user_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  purpose varchar(32) NOT NULL CHECK (purpose IN ('cloud_sync', 'legacy_unowned_import')),
  document_version varchar(128) NOT NULL
    CHECK (length(document_version) BETWEEN 1 AND 128 AND document_version = btrim(document_version)),
  consented_at timestamptz NOT NULL,
  client_version varchar(64) NOT NULL CHECK (length(client_version) BETWEEN 1 AND 64),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, purpose, document_version)
);

CREATE TABLE IF NOT EXISTS app_user_data_preferences (
  owner_user_id bigint PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  timezone varchar(128) NOT NULL DEFAULT 'Asia/Shanghai'
    CHECK (length(timezone) BETWEEN 1 AND 128 AND timezone = btrim(timezone)),
  display_currency varchar(3) NOT NULL DEFAULT 'CNY' CHECK (display_currency IN ('CNY', 'USD')),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_conversations_owner_activity_idx
  ON app_conversations(owner_user_id, last_activity_at DESC, id);
CREATE UNIQUE INDEX IF NOT EXISTS app_messages_conversation_ordinal_key
  ON app_messages(owner_user_id, conversation_id, ordinal);
CREATE UNIQUE INDEX IF NOT EXISTS app_active_run_per_conversation
  ON app_model_runs(owner_user_id, conversation_id)
  WHERE status IN ('queued', 'running', 'cancelling');
CREATE UNIQUE INDEX IF NOT EXISTS app_usage_operation_key
  ON app_usage_events(owner_user_id, operation_id, provider, purpose);
CREATE INDEX IF NOT EXISTS app_usage_owner_occurred_idx
  ON app_usage_events(owner_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS app_sync_mutations_owner_sequence_idx
  ON app_sync_mutations(owner_user_id, server_sequence);

ALTER TABLE app_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_model_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_sync_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_sync_mutations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_privacy_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_user_data_preferences ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION autoforge_resolve_user_id(p_caller_user_id varchar)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  resolved_user_id bigint;
BEGIN
  IF p_caller_user_id IS NULL
    OR p_caller_user_id !~ '^[0-9]{1,64}$' THEN
    RAISE EXCEPTION USING MESSAGE = 'AUTH_REQUIRED', ERRCODE = 'P0001';
  END IF;

  SELECT users.id INTO resolved_user_id
  FROM auth.users users
  WHERE users.id::text = p_caller_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING MESSAGE = 'AUTH_REQUIRED', ERRCODE = 'P0001';
  END IF;
  RETURN resolved_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION autoforge_require_identifier(
  p_value text,
  p_max_length integer DEFAULT 128
)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_value IS NULL
    OR length(p_value) < 1
    OR length(p_value) > p_max_length
    OR p_value <> btrim(p_value) THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION autoforge_iso_timestamp(p_value timestamptz)
RETURNS text
LANGUAGE sql
STABLE
STRICT
SET search_path = pg_catalog, public
AS $$
  SELECT to_char(p_value AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

CREATE OR REPLACE FUNCTION autoforge_record_consent(
  p_owner_user_id bigint,
  p_consent jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  consent_purpose text := p_consent->>'purpose';
  consent_document_version text := p_consent->>'documentVersion';
  consent_client_version text := p_consent->>'clientVersion';
BEGIN
  IF jsonb_typeof(p_consent) <> 'object'
    OR consent_purpose NOT IN ('cloud_sync', 'legacy_unowned_import')
    OR consent_document_version IS NULL
    OR length(consent_document_version) NOT BETWEEN 1 AND 128
    OR consent_client_version IS NULL
    OR length(consent_client_version) NOT BETWEEN 1 AND 64
    OR NOT (p_consent ? 'consentedAt') THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;

  INSERT INTO app_privacy_consents(
    owner_user_id, purpose, document_version, consented_at, client_version
  ) VALUES (
    p_owner_user_id, consent_purpose, consent_document_version,
    (p_consent->>'consentedAt')::timestamptz, consent_client_version
  )
  ON CONFLICT (owner_user_id, purpose, document_version) DO NOTHING;
END;
$$;

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
DECLARE
  auth_user_id bigint;
  mutation_record record;
  mutation jsonb;
  payload jsonb;
  device_row app_sync_devices%ROWTYPE;
  existing_receipt app_sync_mutations%ROWTYPE;
  existing_message app_messages%ROWTYPE;
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
      'message.append', 'legacy.import', 'privacy.consent', 'preferences.update', 'usage.record'
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

CREATE OR REPLACE FUNCTION autoforge_sync_pull(
  p_caller_user_id varchar,
  p_protocol_version integer,
  p_device_id varchar,
  p_cursor varchar DEFAULT NULL,
  p_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  auth_user_id bigint;
  after_sequence bigint := 0;
  next_cursor text := p_cursor;
  result jsonb;
BEGIN
  auth_user_id := autoforge_resolve_user_id(p_caller_user_id);
  PERFORM autoforge_require_identifier(p_device_id, 128);
  IF p_protocol_version IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION USING MESSAGE = 'UPGRADE_REQUIRED', ERRCODE = 'P0001';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app_sync_devices device
    WHERE device.owner_user_id = auth_user_id
      AND device.device_id = p_device_id
      AND device.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION USING MESSAGE = 'FORBIDDEN', ERRCODE = 'P0001';
  END IF;

  IF p_cursor IS NOT NULL THEN
    SELECT mutation.server_sequence INTO after_sequence
    FROM app_sync_mutations mutation
    WHERE mutation.owner_user_id = auth_user_id
      AND mutation.cursor_token::text = p_cursor;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
    END IF;
  END IF;

  WITH page AS (
    SELECT mutation.*
    FROM app_sync_mutations mutation
    WHERE mutation.owner_user_id = auth_user_id
      AND mutation.server_sequence > after_sequence
      AND mutation.status IN ('applied', 'duplicate')
    ORDER BY mutation.server_sequence
    LIMIT p_limit
  )
  SELECT jsonb_build_object(
    'mutations', COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'id', page.mutation_id,
      'kind', page.kind,
      'entityId', page.entity_id,
      'baseRevision', page.base_revision,
      'resultRevision', page.result_revision,
      'payload', CASE WHEN page.mutation_payload->>'compacted' = 'true'
        THEN NULL ELSE page.mutation_payload->'payload' END,
      'compacted', CASE WHEN page.mutation_payload->>'compacted' = 'true'
        THEN true ELSE NULL END,
      'conversationId', CASE WHEN page.mutation_payload->>'compacted' = 'true'
        AND page.kind = 'message.append'
        THEN page.mutation_payload->'conversationId' ELSE NULL END,
      'receivedAt', autoforge_iso_timestamp(page.received_at)
    )) ORDER BY page.server_sequence), '[]'::jsonb),
    'cursor', COALESCE((array_agg(page.cursor_token::text ORDER BY page.server_sequence DESC))[1], next_cursor)
  ) INTO result
  FROM page;

  UPDATE app_sync_devices SET last_pull_at = clock_timestamp()
  WHERE owner_user_id = auth_user_id AND device_id = p_device_id;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION autoforge_list_conversations(
  p_caller_user_id varchar,
  p_limit integer DEFAULT 50,
  p_cursor varchar DEFAULT NULL,
  p_include_deleted boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  auth_user_id bigint;
  anchor_activity timestamptz;
  anchor_id varchar(128);
  result jsonb;
BEGIN
  auth_user_id := autoforge_resolve_user_id(p_caller_user_id);
  IF p_limit <> 50 THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  IF p_cursor IS NOT NULL THEN
    SELECT conversation.last_activity_at, conversation.id INTO anchor_activity, anchor_id
    FROM app_conversations conversation
    WHERE conversation.owner_user_id = auth_user_id
      AND conversation.cursor_token::text = p_cursor;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
    END IF;
  END IF;

  WITH candidates AS (
    SELECT conversation.*
    FROM app_conversations conversation
    WHERE conversation.owner_user_id = auth_user_id
      AND (p_include_deleted OR conversation.deleted_at IS NULL)
      AND (
        p_cursor IS NULL
        OR conversation.last_activity_at < anchor_activity
        OR (conversation.last_activity_at = anchor_activity AND conversation.id > anchor_id)
      )
    ORDER BY conversation.last_activity_at DESC, conversation.id
    LIMIT 51
  ), page AS (
    SELECT * FROM candidates
    ORDER BY last_activity_at DESC, id
    LIMIT 50
  )
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'items', COALESCE(jsonb_agg(jsonb_build_object(
      'id', page.id,
      'title', page.title,
      'titleState', page.title_state,
      'revision', page.revision,
      'syncState', 'synced',
      'createdAt', autoforge_iso_timestamp(page.created_at),
      'lastActivityAt', autoforge_iso_timestamp(page.last_activity_at),
      'metadataUpdatedAt', autoforge_iso_timestamp(page.metadata_updated_at),
      'deletedAt', CASE WHEN page.deleted_at IS NULL THEN NULL ELSE autoforge_iso_timestamp(page.deleted_at) END
    ) ORDER BY page.last_activity_at DESC, page.id), '[]'::jsonb),
    'nextCursor', CASE WHEN (SELECT count(*) FROM candidates) > 50
      THEN (array_agg(page.cursor_token::text ORDER BY page.last_activity_at, page.id DESC))[1]
      ELSE NULL END
  )) INTO result
  FROM page;
  RETURN result;
END;
$$;

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

CREATE OR REPLACE FUNCTION autoforge_preview_legacy_import(
  p_caller_user_id varchar,
  p_owned_count integer,
  p_unowned_count integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM autoforge_resolve_user_id(p_caller_user_id);
  IF p_owned_count IS NULL OR p_owned_count < 0
    OR p_unowned_count IS NULL OR p_unowned_count < 0 THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  RETURN jsonb_build_object(
    'ownedCount', p_owned_count,
    'unownedCount', p_unowned_count,
    'requiresUnownedConfirmation', p_unowned_count > 0
  );
END;
$$;

CREATE OR REPLACE FUNCTION autoforge_import_legacy_batch(
  p_caller_user_id varchar,
  p_protocol_version integer,
  p_device_id varchar,
  p_batch_id varchar,
  p_include_unowned boolean,
  p_conversations jsonb,
  p_messages jsonb,
  p_cloud_sync_consent jsonb,
  p_unowned_import_consent jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  auth_user_id bigint;
  item jsonb;
  device_row app_sync_devices%ROWTYPE;
  receipt app_sync_mutations%ROWTYPE;
  conversation_row app_conversations%ROWTYPE;
  imported_conversations integer := 0;
  imported_messages integer := 0;
  inserted_count integer;
  next_ordinal bigint;
  message_base_revision bigint;
  conversation_mutation_id text;
  message_mutation_id text;
  row_mutation_payload jsonb;
  legacy_request_hash text;
BEGIN
  auth_user_id := autoforge_resolve_user_id(p_caller_user_id);
  PERFORM autoforge_require_identifier(p_device_id, 128);
  PERFORM autoforge_require_identifier(p_batch_id, 128);
  IF p_protocol_version IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION USING MESSAGE = 'UPGRADE_REQUIRED', ERRCODE = 'P0001';
  END IF;
  IF jsonb_typeof(p_conversations) IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_messages) IS DISTINCT FROM 'array'
    OR p_include_unowned IS NULL THEN
    RETURN jsonb_build_object(
      'batchId', p_batch_id, 'status', 'rejected', 'errorCode', 'INVALID_INPUT'
    );
  END IF;
  IF jsonb_array_length(p_conversations) + jsonb_array_length(p_messages) > 100
    OR pg_column_size(p_conversations) + pg_column_size(p_messages) > 1048576
    OR COALESCE(p_cloud_sync_consent->>'purpose', '') <> 'cloud_sync'
    OR (p_include_unowned AND COALESCE(p_unowned_import_consent->>'purpose', '') <> 'legacy_unowned_import')
    OR (NOT p_include_unowned AND p_unowned_import_consent IS NOT NULL) THEN
    RAISE EXCEPTION USING MESSAGE = 'IMPORT_CONFIRMATION_REQUIRED', ERRCODE = 'P0001';
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

  legacy_request_hash := md5(jsonb_build_object(
    'protocolVersion', p_protocol_version,
    'deviceId', p_device_id,
    'batchId', p_batch_id,
    'includeUnowned', p_include_unowned,
    'conversations', p_conversations,
    'messages', p_messages,
    'cloudSyncConsent', p_cloud_sync_consent,
    'unownedImportConsent', p_unowned_import_consent
  )::text);
  PERFORM pg_advisory_xact_lock(hashtextextended(auth_user_id::text || ':legacy:' || p_batch_id, 0));
  SELECT * INTO receipt
  FROM app_sync_mutations stored_receipt
  WHERE stored_receipt.owner_user_id = auth_user_id
    AND stored_receipt.mutation_id = p_batch_id
  FOR UPDATE;
  IF FOUND THEN
    IF receipt.kind = 'legacy.import'
      AND receipt.request_hash = legacy_request_hash THEN
      RETURN jsonb_build_object('batchId', p_batch_id, 'status', 'duplicate');
    END IF;
    RETURN jsonb_build_object(
      'batchId', p_batch_id,
      'status', 'rejected',
      'errorCode', 'SYNC_CONFLICT'
    );
  END IF;

  BEGIN
  PERFORM autoforge_record_consent(auth_user_id, p_cloud_sync_consent);
  IF p_include_unowned THEN
    PERFORM autoforge_record_consent(auth_user_id, p_unowned_import_consent);
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(p_conversations)
  LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object'
      OR item ? 'ownerUserId' OR item ? 'owner_user_id'
      OR jsonb_typeof(item->'id') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item->'title') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item->'titleState') IS DISTINCT FROM 'string'
      OR item->>'titleState' NOT IN ('pending', 'generating', 'ai_named', 'user_named', 'failed')
      OR jsonb_typeof(item->'createdAt') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item->'lastActivityAt') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item->'metadataUpdatedAt') IS DISTINCT FROM 'string'
      OR (item ? 'sourceUnowned' AND jsonb_typeof(item->'sourceUnowned') <> 'boolean')
      OR (item->'sourceUnowned' = 'true'::jsonb AND NOT p_include_unowned) THEN
      RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
    END IF;
    PERFORM autoforge_require_identifier(item->>'id', 128);
    INSERT INTO app_conversations(
      id, owner_user_id, title, title_state, revision,
      created_at, last_activity_at, metadata_updated_at
    ) VALUES (
      item->>'id', auth_user_id, item->>'title', item->>'titleState', 1,
      (item->>'createdAt')::timestamptz, (item->>'lastActivityAt')::timestamptz,
      (item->>'metadataUpdatedAt')::timestamptz
    ) ON CONFLICT (owner_user_id, id) DO NOTHING;
    GET DIAGNOSTICS inserted_count = ROW_COUNT;
    imported_conversations := imported_conversations + inserted_count;
    IF inserted_count = 1 THEN
      conversation_mutation_id := 'legacy-conversation:' || md5(
        p_batch_id || ':conversation:' || item->>'id'
      );
      row_mutation_payload := jsonb_build_object(
        'id', conversation_mutation_id,
        'entityId', item->>'id',
        'baseRevision', 0,
        'kind', 'conversation.create',
        'payload', jsonb_build_object(
          'title', item->>'title', 'titleState', item->>'titleState',
          'createdAt', item->>'createdAt', 'lastActivityAt', item->>'lastActivityAt',
          'metadataUpdatedAt', item->>'metadataUpdatedAt'
        )
      );
      INSERT INTO app_sync_mutations(
        owner_user_id, mutation_id, device_id, kind, entity_id, base_revision,
        result_revision, status, mutation_payload, request_hash
      ) VALUES (
        auth_user_id, conversation_mutation_id, p_device_id, 'conversation.create',
        item->>'id', 0, 1, 'applied', row_mutation_payload,
        md5(row_mutation_payload::text)
      );
    END IF;
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(p_messages)
  LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object'
      OR item ? 'ownerUserId' OR item ? 'owner_user_id'
      OR jsonb_typeof(item->'id') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item->'conversationId') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item->'role') IS DISTINCT FROM 'string'
      OR item->>'role' NOT IN ('user', 'assistant')
      OR jsonb_typeof(item->'blocks') IS DISTINCT FROM 'array'
      OR (item ? 'executionId' AND jsonb_typeof(item->'executionId') <> 'string')
      OR jsonb_typeof(item->'createdAt') IS DISTINCT FROM 'string'
      OR (item ? 'sourceUnowned' AND jsonb_typeof(item->'sourceUnowned') <> 'boolean')
      OR (item->'sourceUnowned' = 'true'::jsonb AND NOT p_include_unowned) THEN
      RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
    END IF;
    PERFORM autoforge_require_identifier(item->>'id', 128);
    PERFORM autoforge_require_identifier(item->>'conversationId', 128);
    SELECT * INTO conversation_row
    FROM app_conversations conversation
    WHERE conversation.owner_user_id = auth_user_id
      AND conversation.id = item->>'conversationId'
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
    END IF;
    SELECT COALESCE(max(message.ordinal), 0) + 1 INTO next_ordinal
    FROM app_messages message
    WHERE message.owner_user_id = auth_user_id
      AND message.conversation_id = item->>'conversationId';
    INSERT INTO app_messages(
      id, owner_user_id, conversation_id, ordinal, role, blocks, execution_id, created_at
    ) VALUES (
      item->>'id', auth_user_id, item->>'conversationId', next_ordinal,
      item->>'role', item->'blocks', NULLIF(item->>'executionId', ''),
      (item->>'createdAt')::timestamptz
    ) ON CONFLICT (owner_user_id, id) DO NOTHING;
    GET DIAGNOSTICS inserted_count = ROW_COUNT;
    imported_messages := imported_messages + inserted_count;
    IF inserted_count = 1 THEN
      message_base_revision := conversation_row.revision;
      UPDATE app_conversations SET
        revision = message_base_revision + 1,
        last_activity_at = GREATEST(last_activity_at, (item->>'createdAt')::timestamptz)
      WHERE owner_user_id = auth_user_id
        AND id = item->>'conversationId';
      message_mutation_id := 'legacy-message:' || md5(
        p_batch_id || ':message:' || item->>'id'
      );
      row_mutation_payload := jsonb_build_object(
        'id', message_mutation_id,
        'entityId', item->>'id',
        'baseRevision', message_base_revision,
        'kind', 'message.append',
        'payload', jsonb_strip_nulls(jsonb_build_object(
          'id', item->>'id', 'conversationId', item->>'conversationId',
          'role', item->>'role', 'blocks', item->'blocks',
          'executionId', NULLIF(item->>'executionId', ''),
          'createdAt', item->>'createdAt'
        ))
      );
      INSERT INTO app_sync_mutations(
        owner_user_id, mutation_id, device_id, kind, entity_id, base_revision,
        result_revision, status, mutation_payload, request_hash
      ) VALUES (
        auth_user_id, message_mutation_id, p_device_id,
        'message.append', item->>'id', message_base_revision, message_base_revision + 1,
        'applied', row_mutation_payload, md5(row_mutation_payload::text)
      );
    END IF;
  END LOOP;

  INSERT INTO app_sync_mutations(
    owner_user_id, mutation_id, device_id, kind, entity_id, base_revision,
    result_revision, status, mutation_payload, request_hash
  ) VALUES (
    auth_user_id, p_batch_id, p_device_id, 'legacy.import', p_batch_id, 0, 0, 'applied',
    jsonb_build_object(
      'id', p_batch_id, 'entityId', p_batch_id, 'baseRevision', 0,
      'kind', 'legacy.import', 'payload', jsonb_build_object(
        'batchId', p_batch_id, 'includeUnowned', p_include_unowned
      )
    ),
    legacy_request_hash
  );

  RETURN jsonb_build_object(
    'batchId', p_batch_id,
    'status', 'applied',
    'importedConversations', imported_conversations,
    'importedMessages', imported_messages
  );
  EXCEPTION
    WHEN SQLSTATE 'P0001' OR data_exception OR integrity_constraint_violation THEN
      RETURN jsonb_build_object(
        'batchId', p_batch_id, 'status', 'rejected', 'errorCode', 'INVALID_INPUT'
      );
    WHEN OTHERS THEN
      RAISE EXCEPTION USING MESSAGE = 'INTERNAL_ERROR', ERRCODE = 'P0001';
  END;
EXCEPTION
  WHEN SQLSTATE 'P0001' THEN
    RAISE;
  WHEN OTHERS THEN
    RAISE EXCEPTION USING MESSAGE = 'INTERNAL_ERROR', ERRCODE = 'P0001';
END;
$$;

CREATE OR REPLACE FUNCTION autoforge_get_usage_snapshot(
  p_caller_user_id varchar,
  p_started_at timestamptz,
  p_ended_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  auth_user_id bigint;
  result jsonb;
BEGIN
  auth_user_id := autoforge_resolve_user_id(p_caller_user_id);
  IF p_started_at IS NULL OR p_ended_at IS NULL OR p_started_at >= p_ended_at THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  SELECT jsonb_build_object(
    'startedAt', autoforge_iso_timestamp(p_started_at),
    'endedAt', autoforge_iso_timestamp(p_ended_at),
    'inputTokens', COALESCE(sum(usage.input_tokens), 0),
    'outputTokens', COALESCE(sum(usage.output_tokens), 0),
    'estimatedCostUsd', COALESCE(sum(usage.estimated_cost) FILTER (WHERE usage.currency = 'USD'), 0)::text,
    'estimatedCount', count(*) FILTER (WHERE usage.status = 'estimated'),
    'unavailableCount', count(*) FILTER (WHERE usage.status = 'unavailable')
  ) INTO result
  FROM app_usage_events usage
  WHERE usage.owner_user_id = auth_user_id
    AND usage.occurred_at >= p_started_at
    AND usage.occurred_at < p_ended_at;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION autoforge_get_user_data_preferences(p_caller_user_id varchar)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  auth_user_id bigint;
  preferences app_user_data_preferences%ROWTYPE;
BEGIN
  auth_user_id := autoforge_resolve_user_id(p_caller_user_id);
  INSERT INTO app_user_data_preferences(owner_user_id)
  VALUES (auth_user_id)
  ON CONFLICT (owner_user_id) DO NOTHING;
  SELECT * INTO STRICT preferences
  FROM app_user_data_preferences stored
  WHERE stored.owner_user_id = auth_user_id;
  RETURN jsonb_build_object(
    'timezone', preferences.timezone,
    'displayCurrency', preferences.display_currency,
    'revision', preferences.revision,
    'updatedAt', autoforge_iso_timestamp(preferences.updated_at)
  );
END;
$$;

CREATE OR REPLACE FUNCTION autoforge_update_user_data_preferences(
  p_caller_user_id varchar,
  p_timezone varchar,
  p_display_currency varchar,
  p_expected_revision bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  auth_user_id bigint;
  preferences app_user_data_preferences%ROWTYPE;
  next_revision bigint;
BEGIN
  auth_user_id := autoforge_resolve_user_id(p_caller_user_id);
  IF p_timezone IS NULL OR length(p_timezone) NOT BETWEEN 1 AND 128
    OR p_timezone <> btrim(p_timezone)
    OR p_display_currency IS NULL
    OR p_display_currency NOT IN ('CNY', 'USD')
    OR p_expected_revision IS NULL OR p_expected_revision < 0 THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(auth_user_id::text || ':preferences', 0));
  SELECT * INTO preferences
  FROM app_user_data_preferences stored
  WHERE stored.owner_user_id = auth_user_id
  FOR UPDATE;
  IF FOUND AND preferences.revision <> p_expected_revision
    OR NOT FOUND AND p_expected_revision <> 0 THEN
    RAISE EXCEPTION USING MESSAGE = 'SYNC_CONFLICT', ERRCODE = 'P0001';
  END IF;
  next_revision := COALESCE(preferences.revision, 0) + 1;
  BEGIN
  INSERT INTO app_user_data_preferences(
    owner_user_id, timezone, display_currency, revision
  ) VALUES (
    auth_user_id, p_timezone, p_display_currency, next_revision
  )
  ON CONFLICT (owner_user_id) DO UPDATE SET
    timezone = EXCLUDED.timezone,
    display_currency = EXCLUDED.display_currency,
    revision = EXCLUDED.revision,
    updated_at = clock_timestamp();
  EXCEPTION WHEN data_exception OR integrity_constraint_violation THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  WHEN OTHERS THEN
    RAISE EXCEPTION USING MESSAGE = 'INTERNAL_ERROR', ERRCODE = 'P0001';
  END;
  RETURN jsonb_build_object(
    'timezone', p_timezone,
    'displayCurrency', p_display_currency,
    'revision', next_revision
  );
EXCEPTION
  WHEN SQLSTATE 'P0001' THEN
    RAISE;
  WHEN OTHERS THEN
    RAISE EXCEPTION USING MESSAGE = 'INTERNAL_ERROR', ERRCODE = 'P0001';
END;
$$;

CREATE OR REPLACE FUNCTION autoforge_purge_expired_conversation_tombstones()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  purged_count bigint;
  purge_before timestamptz := clock_timestamp() - interval '30 days';
  candidate_snapshot jsonb;
  purge_candidates jsonb := '[]'::jsonb;
  candidate record;
  locked_deleted_at timestamptz;
BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'ownerUserId', conversation.owner_user_id,
    'conversationId', conversation.id
  ) ORDER BY conversation.owner_user_id, conversation.id), '[]'::jsonb)
  INTO candidate_snapshot
  FROM app_conversations conversation
  WHERE conversation.deleted_at < purge_before;

  FOR candidate IN
    SELECT * FROM jsonb_to_recordset(candidate_snapshot)
      AS item("ownerUserId" bigint, "conversationId" varchar)
    ORDER BY "ownerUserId", "conversationId"
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(
      candidate."ownerUserId"::text || ':' || candidate."conversationId", 0
    ));
    SELECT conversation.deleted_at INTO locked_deleted_at
    FROM app_conversations conversation
    WHERE conversation.owner_user_id = candidate."ownerUserId"
      AND conversation.id = candidate."conversationId"
    FOR UPDATE;
    IF FOUND AND locked_deleted_at < purge_before THEN
      purge_candidates := purge_candidates || jsonb_build_array(jsonb_build_object(
        'ownerUserId', candidate."ownerUserId",
        'conversationId', candidate."conversationId"
      ));
    END IF;
  END LOOP;

  UPDATE app_usage_events usage
  SET conversation_id = NULL
  FROM jsonb_to_recordset(purge_candidates)
    AS candidate("ownerUserId" bigint, "conversationId" varchar)
  WHERE usage.owner_user_id = candidate."ownerUserId"
    AND usage.conversation_id = candidate."conversationId";

  WITH compacted AS (
    SELECT mutation.server_sequence,
           jsonb_strip_nulls(jsonb_build_object(
             'compacted', true,
             'conversationId', CASE WHEN mutation.kind = 'message.append'
               THEN mutation.mutation_payload->'payload'->'conversationId' ELSE NULL END
           )) AS mutation_payload
    FROM app_sync_mutations mutation
    JOIN jsonb_to_recordset(purge_candidates)
      AS candidate("ownerUserId" bigint, "conversationId" varchar)
      ON candidate."ownerUserId" = mutation.owner_user_id
     AND (
       mutation.kind IN (
         'conversation.create', 'conversation.rename', 'conversation.preferences',
         'conversation.delete', 'conversation.restore'
       ) AND mutation.entity_id = candidate."conversationId"
       OR mutation.kind = 'message.append'
         AND mutation.mutation_payload->'payload'->>'conversationId' = candidate."conversationId"
     )
  )
  UPDATE app_sync_mutations mutation
  SET mutation_payload = compacted.mutation_payload
  FROM compacted
  WHERE mutation.server_sequence = compacted.server_sequence;

  DELETE FROM app_conversations conversation
  USING jsonb_to_recordset(purge_candidates)
    AS candidate("ownerUserId" bigint, "conversationId" varchar)
  WHERE conversation.owner_user_id = candidate."ownerUserId"
    AND conversation.id = candidate."conversationId";
  GET DIAGNOSTICS purged_count = ROW_COUNT;
  RETURN purged_count;
END;
$$;

REVOKE ALL ON TABLE app_conversations FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE app_messages FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE app_model_runs FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE app_usage_events FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE app_sync_devices FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE app_sync_mutations FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE app_privacy_consents FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE app_user_data_preferences FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE app_sync_mutations_server_sequence_seq FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION autoforge_resolve_user_id(varchar) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION autoforge_require_identifier(text, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION autoforge_iso_timestamp(timestamptz) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION autoforge_record_consent(bigint, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION autoforge_sync_push(varchar, integer, varchar, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION autoforge_sync_pull(varchar, integer, varchar, varchar, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION autoforge_list_conversations(varchar, integer, varchar, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION autoforge_list_messages(varchar, varchar, integer, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION autoforge_preview_legacy_import(varchar, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION autoforge_import_legacy_batch(varchar, integer, varchar, varchar, boolean, jsonb, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION autoforge_get_usage_snapshot(varchar, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION autoforge_get_user_data_preferences(varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION autoforge_update_user_data_preferences(varchar, varchar, varchar, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION autoforge_purge_expired_conversation_tombstones() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION autoforge_sync_push(varchar, integer, varchar, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION autoforge_sync_pull(varchar, integer, varchar, varchar, integer) TO service_role;
GRANT EXECUTE ON FUNCTION autoforge_list_conversations(varchar, integer, varchar, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION autoforge_list_messages(varchar, varchar, integer, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION autoforge_preview_legacy_import(varchar, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION autoforge_import_legacy_batch(varchar, integer, varchar, varchar, boolean, jsonb, jsonb, jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION autoforge_get_usage_snapshot(varchar, timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION autoforge_get_user_data_preferences(varchar) TO service_role;
GRANT EXECUTE ON FUNCTION autoforge_update_user_data_preferences(varchar, varchar, varchar, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION autoforge_purge_expired_conversation_tombstones() TO service_role;

COMMIT;
