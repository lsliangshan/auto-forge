CREATE TABLE browser_tab_bindings (
  id TEXT PRIMARY KEY,
  tab_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES local_users(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  chat_run_id TEXT REFERENCES chat_runs(id) ON DELETE SET NULL,
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
  chat_run_id TEXT REFERENCES chat_runs(id) ON DELETE SET NULL,
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
