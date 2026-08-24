ALTER TABLE browser_action_audits RENAME TO browser_action_audits_legacy_fk;
ALTER TABLE browser_tab_bindings RENAME TO browser_tab_bindings_legacy_fk;
DROP INDEX browser_action_audits_binding_sequence_idx;
DROP INDEX browser_tab_bindings_conversation_status_idx;

CREATE TABLE browser_tab_bindings (
  id TEXT PRIMARY KEY,
  tab_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES local_users(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  chat_run_id TEXT,
  execution_id TEXT REFERENCES executions(id) ON DELETE SET NULL,
  workflow_id TEXT NOT NULL,
  workflow_version TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('installed', 'development')),
  build_hash TEXT,
  security_fingerprint TEXT NOT NULL CHECK (length(security_fingerprint) = 64),
  permission_matrix_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'closed', 'stale')),
  terminal_reason TEXT,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX browser_tab_bindings_conversation_status_idx
  ON browser_tab_bindings(conversation_id, status, created_at);

CREATE TABLE browser_action_audits (
  id TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL REFERENCES browser_tab_bindings(id) ON DELETE CASCADE,
  chat_run_id TEXT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  origin TEXT NOT NULL,
  action TEXT NOT NULL,
  target_summary TEXT NOT NULL CHECK (length(target_summary) BETWEEN 1 AND 500),
  risk TEXT NOT NULL CHECK (risk IN ('safe_navigation', 'sensitive_read', 'external_action')),
  outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'blocked', 'failed', 'cancelled', 'handed_off')),
  error_code TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(binding_id, sequence)
);
CREATE INDEX browser_action_audits_binding_sequence_idx
  ON browser_action_audits(binding_id, sequence);

INSERT INTO browser_tab_bindings SELECT * FROM browser_tab_bindings_legacy_fk;
INSERT INTO browser_action_audits SELECT * FROM browser_action_audits_legacy_fk;

DROP TABLE browser_action_audits_legacy_fk;
DROP TABLE browser_tab_bindings_legacy_fk;
