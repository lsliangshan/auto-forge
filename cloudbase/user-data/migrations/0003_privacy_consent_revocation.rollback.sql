-- Data-preserving rollback.
-- Accepted history and the accepted/revoked current-state projection remain intact so an older
-- desktop cannot erase or bypass a revocation recorded by a newer device.
BEGIN;
DO $rollback$
DECLARE
  definition text;
  restored text;
BEGIN
  SELECT pg_get_functiondef(
    'autoforge_sync_push(varchar,integer,varchar,jsonb)'::regprocedure
  ) INTO definition;

  restored := replace(
    definition,
    $old$'message.append', 'legacy.import', 'privacy.consent', 'privacy.consent.revoke',
      'preferences.update', 'usage.record'$old$,
    $new$'message.append', 'legacy.import', 'privacy.consent', 'preferences.update', 'usage.record'$new$
  );
  IF restored = definition THEN
    RAISE EXCEPTION 'autoforge_sync_push consent kind rollback anchor was not found';
  END IF;

  definition := restored;
  restored := replace(
    definition,
    $old$preferences_row app_user_data_preferences%ROWTYPE;
  consent_result jsonb;
  mutation_id text;$old$,
    $new$preferences_row app_user_data_preferences%ROWTYPE;
  mutation_id text;$new$
  );
  IF restored = definition THEN
    RAISE EXCEPTION 'autoforge_sync_push declaration rollback anchor was not found';
  END IF;

  definition := restored;
  restored := replace(
    definition,
    $old$ELSIF mutation_kind IN ('privacy.consent', 'privacy.consent.revoke') THEN
      consent_result := autoforge_apply_privacy_consent_mutation(
        auth_user_id, mutation_kind, entity_id, base_revision_value, payload
      );
      mutation_status := consent_result->>'status';
      mutation_error := consent_result->>'errorCode';
      IF mutation_status = 'applied' THEN
        result_revision_value := base_revision_value + 1;
      END IF;$old$,
    $new$ELSIF mutation_kind = 'privacy.consent' THEN
      IF payload->>'documentVersion' IS DISTINCT FROM entity_id OR base_revision_value <> 0 THEN
        mutation_status := 'rejected';
        mutation_error := 'INVALID_INPUT';
      ELSE
        PERFORM autoforge_record_consent(auth_user_id, payload);
        result_revision_value := 0;
      END IF;$new$
  );
  IF restored = definition THEN
    RAISE EXCEPTION 'autoforge_sync_push consent branch rollback anchor was not found';
  END IF;

  -- pg_get_functiondef returns a CREATE OR REPLACE definition, so this preserves rows and grants.
  EXECUTE restored;
END
$rollback$;

REVOKE ALL ON FUNCTION autoforge_apply_privacy_consent_mutation(bigint, text, text, bigint, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
COMMIT;
