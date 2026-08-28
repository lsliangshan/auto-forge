-- Data-preserving rollback.
-- Accepted history and the accepted/revoked current-state projection remain intact so an older
-- desktop cannot erase or bypass a revocation recorded by a newer device.
BEGIN;
REVOKE ALL ON FUNCTION autoforge_apply_privacy_consent_mutation(bigint, text, text, bigint, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
COMMIT;
