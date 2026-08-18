ALTER TABLE chat_runs ADD COLUMN user_id TEXT REFERENCES local_users(id);
ALTER TABLE chat_runs ADD COLUMN provider TEXT CHECK (provider IS NULL OR provider IN ('deepseek', 'openrouter'));

CREATE INDEX idx_chat_runs_user_started_at
  ON chat_runs(user_id, started_at);

CREATE TABLE provider_usage_events (
  id TEXT PRIMARY KEY,
  operation_key TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES local_users(id),
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

CREATE UNIQUE INDEX idx_provider_usage_generation_unique
  ON provider_usage_events(generation_id)
  WHERE generation_id IS NOT NULL;
CREATE INDEX idx_provider_usage_user_provider_started
  ON provider_usage_events(user_id, provider, started_at);
CREATE INDEX idx_provider_usage_reconcile
  ON provider_usage_events(status, next_reconcile_at);
