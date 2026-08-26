CREATE TABLE privacy_consents (
  purpose TEXT PRIMARY KEY CHECK (purpose IN ('cloud_sync', 'legacy_unowned_import')),
  document_version TEXT NOT NULL,
  consented_at INTEGER NOT NULL CHECK (consented_at >= 0),
  client_version TEXT NOT NULL
);

CREATE TABLE account_data_preferences (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  timezone TEXT NOT NULL,
  display_currency TEXT NOT NULL CHECK (display_currency IN ('CNY', 'USD')),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
);
