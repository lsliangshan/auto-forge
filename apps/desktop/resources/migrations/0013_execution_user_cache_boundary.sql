ALTER TABLE browser_action_audits RENAME TO browser_action_audits_legacy_execution_fk;
ALTER TABLE browser_tab_bindings RENAME TO browser_tab_bindings_legacy_execution_fk;
ALTER TABLE execution_steps RENAME TO execution_steps_legacy_execution_fk;
ALTER TABLE execution_logs RENAME TO execution_logs_legacy_execution_fk;
ALTER TABLE executions RENAME TO executions_legacy_chat_run_fk;

DROP INDEX browser_action_audits_binding_sequence_idx;
DROP INDEX browser_tab_bindings_conversation_status_idx;
DROP INDEX execution_steps_execution_sequence_idx;
DROP INDEX execution_logs_execution_sequence_idx;
DROP INDEX executions_status_created_at_idx;
DROP INDEX executions_created_at_idx;

CREATE TABLE executions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  workflow_version TEXT NOT NULL,
  chat_run_id TEXT,
  status TEXT NOT NULL,
  input_json TEXT NOT NULL,
  result_json TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER
);
CREATE INDEX executions_status_created_at_idx ON executions(status, created_at DESC);
CREATE INDEX executions_created_at_idx ON executions(created_at DESC);

CREATE TABLE execution_steps (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  percent INTEGER,
  started_at INTEGER,
  ended_at INTEGER,
  UNIQUE(execution_id, sequence)
);
CREATE INDEX execution_steps_execution_sequence_idx ON execution_steps(execution_id, sequence);

CREATE TABLE execution_logs (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(execution_id, sequence)
);
CREATE INDEX execution_logs_execution_sequence_idx ON execution_logs(execution_id, sequence);

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

INSERT INTO executions SELECT * FROM executions_legacy_chat_run_fk;
INSERT INTO execution_steps SELECT * FROM execution_steps_legacy_execution_fk;
INSERT INTO execution_logs SELECT * FROM execution_logs_legacy_execution_fk;
INSERT INTO browser_tab_bindings SELECT * FROM browser_tab_bindings_legacy_execution_fk;
INSERT INTO browser_action_audits SELECT * FROM browser_action_audits_legacy_execution_fk;

DROP TABLE browser_action_audits_legacy_execution_fk;
DROP TABLE browser_tab_bindings_legacy_execution_fk;
DROP TABLE execution_steps_legacy_execution_fk;
DROP TABLE execution_logs_legacy_execution_fk;
DROP TABLE executions_legacy_chat_run_fk;
