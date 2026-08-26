ALTER TABLE legacy_import_identity RENAME TO legacy_import_identity_singleton;

CREATE TABLE legacy_import_identity (
  selection_fingerprint TEXT NOT NULL CHECK (length(selection_fingerprint) = 64),
  include_unowned INTEGER NOT NULL CHECK (include_unowned IN (0, 1)),
  cloud_consent_version TEXT NOT NULL,
  unowned_consent_version TEXT NOT NULL DEFAULT '',
  batch_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (
    selection_fingerprint,
    include_unowned,
    cloud_consent_version,
    unowned_consent_version
  )
);

INSERT INTO legacy_import_identity(
  selection_fingerprint,
  include_unowned,
  cloud_consent_version,
  unowned_consent_version,
  batch_id,
  updated_at
)
SELECT
  selection_fingerprint,
  include_unowned,
  cloud_consent_version,
  COALESCE(unowned_consent_version, ''),
  batch_id,
  updated_at
FROM legacy_import_identity_singleton;

DROP TABLE legacy_import_identity_singleton;
