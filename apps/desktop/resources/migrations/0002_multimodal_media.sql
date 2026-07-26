ALTER TABLE conversations ADD COLUMN generation_preferences_json TEXT;

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
