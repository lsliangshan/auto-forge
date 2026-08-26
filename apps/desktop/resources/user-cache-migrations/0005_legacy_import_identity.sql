CREATE TABLE legacy_import_identity (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  selection_fingerprint TEXT NOT NULL CHECK (length(selection_fingerprint) = 64),
  include_unowned INTEGER NOT NULL CHECK (include_unowned IN (0, 1)),
  cloud_consent_version TEXT NOT NULL,
  unowned_consent_version TEXT,
  batch_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
);
