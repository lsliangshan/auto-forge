CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  blocks_json TEXT NOT NULL,
  execution_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE chat_runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL UNIQUE,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  generation_id TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd TEXT,
  error_code TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE workflow_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  manifest_json TEXT,
  status TEXT NOT NULL,
  build_hash TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE installed_workflows (
  workflow_id TEXT NOT NULL,
  version TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  author TEXT NOT NULL,
  category TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  install_path TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  integrity_status TEXT NOT NULL,
  source TEXT NOT NULL,
  installed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(workflow_id, version)
);

CREATE TABLE workflow_files (
  workflow_id TEXT NOT NULL,
  workflow_version TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY(workflow_id, workflow_version, path),
  FOREIGN KEY(workflow_id, workflow_version) REFERENCES installed_workflows(workflow_id, version) ON DELETE CASCADE
);

CREATE TABLE executions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  workflow_version TEXT NOT NULL,
  chat_run_id TEXT REFERENCES chat_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  input_json TEXT NOT NULL,
  result_json TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER
);

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

CREATE TABLE permission_grants (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  workflow_version TEXT NOT NULL,
  capability TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(workflow_id, workflow_version, capability, scope_hash)
);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE encrypted_secrets (
  key TEXT PRIMARY KEY,
  ciphertext_base64 TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX conversations_updated_at_idx ON conversations(updated_at DESC);
CREATE INDEX messages_conversation_created_at_idx ON messages(conversation_id, created_at, id);
CREATE INDEX chat_runs_conversation_started_at_idx ON chat_runs(conversation_id, started_at DESC);
CREATE INDEX chat_runs_status_idx ON chat_runs(status, started_at DESC);
CREATE INDEX workflow_projects_status_idx ON workflow_projects(status, updated_at DESC);
CREATE INDEX installed_workflows_enabled_integrity_idx ON installed_workflows(enabled, integrity_status);
CREATE INDEX workflow_files_workflow_idx ON workflow_files(workflow_id, workflow_version);
CREATE INDEX executions_status_created_at_idx ON executions(status, created_at DESC);
CREATE INDEX executions_created_at_idx ON executions(created_at DESC);
CREATE INDEX execution_steps_execution_sequence_idx ON execution_steps(execution_id, sequence);
CREATE INDEX execution_logs_execution_sequence_idx ON execution_logs(execution_id, sequence);
CREATE INDEX permission_grants_lookup_idx ON permission_grants(workflow_id, workflow_version, capability, scope_hash);
