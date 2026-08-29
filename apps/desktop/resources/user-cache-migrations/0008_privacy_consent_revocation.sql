CREATE TABLE privacy_consent_states (
  purpose TEXT PRIMARY KEY CHECK (purpose IN ('cloud_sync', 'legacy_unowned_import')),
  state TEXT NOT NULL CHECK (state IN ('accepted', 'revoked')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  document_version TEXT,
  consented_at INTEGER CHECK (consented_at IS NULL OR consented_at >= 0),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= 0),
  client_version TEXT NOT NULL,
  CHECK (
    (state = 'accepted' AND document_version IS NOT NULL
      AND consented_at IS NOT NULL AND revoked_at IS NULL)
    OR
    (state = 'revoked' AND document_version IS NULL
      AND consented_at IS NULL AND revoked_at IS NOT NULL)
  )
);

INSERT INTO privacy_consent_states(
  purpose, state, revision, document_version, consented_at, revoked_at, client_version
)
SELECT purpose, 'accepted', 1, document_version, consented_at, NULL, client_version
FROM privacy_consents;
