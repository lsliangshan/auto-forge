CREATE TABLE sync_receipt_evidence (
  mutation_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
  payload_json TEXT NOT NULL,
  occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
);
