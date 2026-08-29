BEGIN;

CREATE TABLE IF NOT EXISTS app_privacy_consent_states (
  owner_user_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  purpose varchar(32) NOT NULL CHECK (purpose IN ('cloud_sync', 'legacy_unowned_import')),
  state varchar(16) NOT NULL CHECK (state IN ('accepted', 'revoked')),
  revision bigint NOT NULL CHECK (revision > 0),
  document_version varchar(128),
  consented_at timestamptz,
  revoked_at timestamptz,
  client_version varchar(64) NOT NULL CHECK (length(client_version) BETWEEN 1 AND 64),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, purpose),
  CHECK (
    (state = 'accepted' AND document_version IS NOT NULL
      AND length(document_version) BETWEEN 1 AND 128
      AND document_version = btrim(document_version)
      AND consented_at IS NOT NULL AND revoked_at IS NULL)
    OR
    (state = 'revoked' AND document_version IS NULL
      AND consented_at IS NULL AND revoked_at IS NOT NULL)
  )
);

INSERT INTO app_privacy_consent_states(
  owner_user_id, purpose, state, revision, document_version,
  consented_at, revoked_at, client_version, updated_at
)
SELECT DISTINCT ON (history.owner_user_id, history.purpose)
  history.owner_user_id, history.purpose, 'accepted', 1, history.document_version,
  history.consented_at, NULL, history.client_version, history.received_at
FROM app_privacy_consents history
ORDER BY history.owner_user_id, history.purpose,
  history.received_at DESC, history.document_version DESC
ON CONFLICT (owner_user_id, purpose) DO NOTHING;

ALTER TABLE app_privacy_consent_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_privacy_consent_states FORCE ROW LEVEL SECURITY;

ALTER TABLE app_sync_mutations
  DROP CONSTRAINT IF EXISTS app_sync_mutations_kind_check;
ALTER TABLE app_sync_mutations
  ADD CONSTRAINT app_sync_mutations_kind_check CHECK (kind IN (
    'conversation.create', 'conversation.rename', 'conversation.preferences',
    'conversation.delete', 'conversation.restore',
    'message.append', 'legacy.import', 'privacy.consent', 'privacy.consent.revoke',
    'preferences.update', 'usage.record'
  ));

CREATE OR REPLACE FUNCTION autoforge_apply_privacy_consent_mutation(
  p_owner_user_id bigint,
  p_kind text,
  p_entity_id text,
  p_base_revision bigint,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  consent_purpose text := p_payload->>'purpose';
  consent_state app_privacy_consent_states%ROWTYPE;
  next_revision bigint;
BEGIN
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
    OR p_kind NOT IN ('privacy.consent', 'privacy.consent.revoke')
    OR consent_purpose NOT IN ('cloud_sync', 'legacy_unowned_import')
    OR p_base_revision IS NULL OR p_base_revision < 0 THEN
    RETURN jsonb_build_object('status', 'rejected', 'errorCode', 'INVALID_INPUT');
  END IF;

  IF p_kind = 'privacy.consent' THEN
    IF EXISTS (
        SELECT 1 FROM jsonb_object_keys(p_payload) supplied_key
        WHERE supplied_key NOT IN ('purpose', 'documentVersion', 'consentedAt', 'clientVersion')
      )
      OR NOT (p_payload ?& ARRAY['purpose', 'documentVersion', 'consentedAt', 'clientVersion'])
      OR p_entity_id IS DISTINCT FROM p_payload->>'documentVersion'
      OR length(p_payload->>'documentVersion') NOT BETWEEN 1 AND 128
      OR p_payload->>'documentVersion' <> btrim(p_payload->>'documentVersion')
      OR length(p_payload->>'clientVersion') NOT BETWEEN 1 AND 64
      OR p_payload->>'clientVersion' <> btrim(p_payload->>'clientVersion') THEN
      RETURN jsonb_build_object('status', 'rejected', 'errorCode', 'INVALID_INPUT');
    END IF;
    PERFORM (p_payload->>'consentedAt')::timestamptz;
  ELSE
    IF EXISTS (
        SELECT 1 FROM jsonb_object_keys(p_payload) supplied_key
        WHERE supplied_key NOT IN ('purpose', 'revokedAt', 'clientVersion')
      )
      OR NOT (p_payload ?& ARRAY['purpose', 'revokedAt', 'clientVersion'])
      OR p_entity_id IS DISTINCT FROM consent_purpose
      OR length(p_payload->>'clientVersion') NOT BETWEEN 1 AND 64
      OR p_payload->>'clientVersion' <> btrim(p_payload->>'clientVersion') THEN
      RETURN jsonb_build_object('status', 'rejected', 'errorCode', 'INVALID_INPUT');
    END IF;
    PERFORM (p_payload->>'revokedAt')::timestamptz;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_owner_user_id::text || ':privacy-consent:' || consent_purpose, 0
  ));
  SELECT * INTO consent_state
  FROM app_privacy_consent_states current_state
  WHERE current_state.owner_user_id = p_owner_user_id
    AND current_state.purpose = consent_purpose
  FOR UPDATE;
  IF FOUND AND consent_state.revision <> p_base_revision THEN
    RETURN jsonb_build_object('status', 'conflict', 'errorCode', 'SYNC_CONFLICT');
  ELSIF NOT FOUND AND p_base_revision <> 0 THEN
    RETURN jsonb_build_object('status', 'conflict', 'errorCode', 'SYNC_CONFLICT');
  END IF;

  next_revision := p_base_revision + 1;
  IF p_kind = 'privacy.consent' THEN
    PERFORM autoforge_record_consent(p_owner_user_id, p_payload);
    INSERT INTO app_privacy_consent_states(
      owner_user_id, purpose, state, revision, document_version,
      consented_at, revoked_at, client_version, updated_at
    ) VALUES (
      p_owner_user_id, consent_purpose, 'accepted', next_revision,
      p_payload->>'documentVersion', (p_payload->>'consentedAt')::timestamptz,
      NULL, p_payload->>'clientVersion', clock_timestamp()
    )
    ON CONFLICT (owner_user_id, purpose) DO UPDATE SET
      state = 'accepted', revision = EXCLUDED.revision,
      document_version = EXCLUDED.document_version,
      consented_at = EXCLUDED.consented_at, revoked_at = NULL,
      client_version = EXCLUDED.client_version, updated_at = EXCLUDED.updated_at;
  ELSE
    INSERT INTO app_privacy_consent_states(
      owner_user_id, purpose, state, revision, document_version,
      consented_at, revoked_at, client_version, updated_at
    ) VALUES (
      p_owner_user_id, consent_purpose, 'revoked', next_revision,
      NULL, NULL, (p_payload->>'revokedAt')::timestamptz,
      p_payload->>'clientVersion', clock_timestamp()
    )
    ON CONFLICT (owner_user_id, purpose) DO UPDATE SET
      state = 'revoked', revision = EXCLUDED.revision,
      document_version = NULL, consented_at = NULL,
      revoked_at = EXCLUDED.revoked_at,
      client_version = EXCLUDED.client_version, updated_at = EXCLUDED.updated_at;
  END IF;
  RETURN jsonb_build_object('status', 'applied');
END;
$$;

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
    $old$'message.append', 'legacy.import', 'privacy.consent', 'preferences.update', 'usage.record'$old$,
    $new$'message.append', 'legacy.import', 'privacy.consent', 'privacy.consent.revoke',
      'preferences.update', 'usage.record'$new$
  );
  IF widened = definition THEN
    RAISE EXCEPTION 'autoforge_sync_push consent kind validator was not found';
  END IF;

  definition := widened;
  widened := replace(
    definition,
    $old$preferences_row app_user_data_preferences%ROWTYPE;
  mutation_id text;$old$,
    $new$preferences_row app_user_data_preferences%ROWTYPE;
  consent_result jsonb;
  mutation_id text;$new$
  );
  IF widened = definition THEN
    RAISE EXCEPTION 'autoforge_sync_push declaration anchor was not found';
  END IF;

  definition := widened;
  widened := replace(
    definition,
    $old$ELSIF mutation_kind = 'privacy.consent' THEN
      IF payload->>'documentVersion' IS DISTINCT FROM entity_id OR base_revision_value <> 0 THEN
        mutation_status := 'rejected';
        mutation_error := 'INVALID_INPUT';
      ELSE
        PERFORM autoforge_record_consent(auth_user_id, payload);
        result_revision_value := 0;
      END IF;$old$,
    $new$ELSIF mutation_kind IN ('privacy.consent', 'privacy.consent.revoke') THEN
      consent_result := autoforge_apply_privacy_consent_mutation(
        auth_user_id, mutation_kind, entity_id, base_revision_value, payload
      );
      mutation_status := consent_result->>'status';
      mutation_error := consent_result->>'errorCode';
      IF mutation_status = 'applied' THEN
        result_revision_value := base_revision_value + 1;
      END IF;$new$
  );
  IF widened = definition THEN
    RAISE EXCEPTION 'autoforge_sync_push consent branch was not found';
  END IF;

  EXECUTE widened;
END
$migration$;

REVOKE ALL ON TABLE app_privacy_consent_states FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION autoforge_apply_privacy_consent_mutation(bigint, text, text, bigint, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
