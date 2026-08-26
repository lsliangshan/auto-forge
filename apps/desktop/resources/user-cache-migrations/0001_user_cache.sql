CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  title_state TEXT NOT NULL DEFAULT 'user_named'
    CHECK (title_state IN ('pending', 'generating', 'ai_named', 'user_named', 'failed')),
  user_id TEXT,
  generation_preferences_json TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  sync_state TEXT NOT NULL DEFAULT 'synced'
    CHECK (sync_state IN ('synced', 'pending', 'syncing', 'failed')),
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  metadata_updated_at INTEGER NOT NULL
);

CREATE INDEX conversations_activity_idx
  ON conversations(last_activity_at DESC, id);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  blocks_json TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  execution_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(conversation_id, ordinal)
);

CREATE INDEX messages_conversation_created_at_idx
  ON messages(conversation_id, created_at, id);

CREATE TABLE conversation_contexts (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  summary_text TEXT NOT NULL,
  through_ordinal INTEGER NOT NULL CHECK (through_ordinal >= 0),
  estimated_tokens INTEGER NOT NULL CHECK (estimated_tokens >= 0),
  updated_at INTEGER NOT NULL
);

CREATE TABLE agent_workflow_approvals (
  execution_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  block_id TEXT NOT NULL
);

CREATE TABLE media_assets (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('upload', 'generated')),
  kind TEXT NOT NULL CHECK (kind IN ('image', 'audio', 'video')),
  mime_type TEXT,
  original_name TEXT NOT NULL,
  relative_path TEXT,
  byte_size INTEGER,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  sha256 TEXT,
  provider TEXT,
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('staging', 'ready', 'failed', 'deleting')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX media_assets_conversation_status_idx
  ON media_assets(conversation_id, status, created_at);
CREATE INDEX media_assets_unclaimed_idx
  ON media_assets(message_id, created_at);

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
  ended_at INTEGER,
  user_id TEXT,
  provider TEXT CHECK (provider IS NULL OR provider IN ('deepseek', 'openrouter'))
);

CREATE INDEX chat_runs_conversation_started_at_idx
  ON chat_runs(conversation_id, started_at DESC);
CREATE INDEX chat_runs_status_idx
  ON chat_runs(status, started_at DESC);
CREATE INDEX chat_runs_user_started_at_idx
  ON chat_runs(user_id, started_at);

CREATE TABLE media_generation_jobs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  assistant_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'video'),
  provider_job_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'downloading', 'paused', 'completed', 'failed')),
  parameters_json TEXT NOT NULL,
  next_poll_at INTEGER,
  poll_attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  asset_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE INDEX media_generation_jobs_resume_idx
  ON media_generation_jobs(status, next_poll_at);

CREATE TABLE provider_usage_events (
  id TEXT PRIMARY KEY,
  operation_key TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('deepseek', 'openrouter')),
  api_key_fingerprint TEXT,
  request_id TEXT NOT NULL,
  chat_run_id TEXT,
  generation_id TEXT,
  provider_job_id TEXT,
  model TEXT NOT NULL,
  modality TEXT NOT NULL CHECK (modality IN ('text', 'image', 'audio', 'video')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'reported', 'unknown')),
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cost_usd TEXT,
  reconcile_attempts INTEGER NOT NULL DEFAULT 0 CHECK (reconcile_attempts >= 0),
  next_reconcile_at INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  CHECK (
    (status = 'reported' AND cost_usd IS NOT NULL)
    OR (status IN ('pending', 'unknown') AND cost_usd IS NULL)
  )
);

CREATE UNIQUE INDEX provider_usage_generation_unique
  ON provider_usage_events(generation_id)
  WHERE generation_id IS NOT NULL;
CREATE INDEX provider_usage_user_provider_started_idx
  ON provider_usage_events(user_id, provider, started_at);
CREATE INDEX provider_usage_reconcile_idx
  ON provider_usage_events(status, next_reconcile_at);

CREATE TABLE outbox_mutations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','syncing','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error_code TEXT,
  occurred_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX outbox_ready_idx
  ON outbox_mutations(state, next_attempt_at, created_at, id);

CREATE TABLE sync_checkpoint (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  remote_cursor TEXT,
  protocol_version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
