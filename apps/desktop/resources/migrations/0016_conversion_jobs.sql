CREATE TABLE conversion_jobs (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('media', 'artifact')),
  source_id TEXT NOT NULL,
  target_format TEXT NOT NULL CHECK (target_format IN (
    'png', 'jpeg', 'webp', 'avif', 'tiff', 'bmp', 'gif', 'ico', 'icns',
    'pdf', 'xlsx', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus',
    'mp4', 'webm', 'mov'
  )),
  preset TEXT CHECK (preset IS NULL OR preset IN ('default', 'favicon', 'app-icon')),
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'downloading_component', 'converting', 'verifying',
    'completed', 'failed', 'cancelled', 'interrupted'
  )),
  epoch INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER
);

CREATE INDEX conversion_jobs_owner_status_created_at_idx
  ON conversion_jobs(owner_user_id, status, created_at);

CREATE TABLE conversion_artifacts (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  conversion_job_id TEXT REFERENCES conversion_jobs(id) ON DELETE SET NULL,
  role TEXT NOT NULL CHECK (role IN ('input', 'output')),
  display_name TEXT NOT NULL,
  detected_format TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  relative_path TEXT NOT NULL CHECK (
    length(relative_path) > 0
    AND relative_path NOT LIKE '/%'
    AND substr(relative_path, 1, 1) <> char(92)
    AND NOT (
      substr(relative_path, 2, 1) = ':'
      AND substr(relative_path, 3, 1) IN ('/', char(92))
    )
  ),
  metadata_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('ready', 'deleted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  CHECK (
    (status = 'ready' AND deleted_at IS NULL)
    OR (status = 'deleted' AND deleted_at IS NOT NULL)
  )
);

CREATE INDEX conversion_artifacts_owner_job_idx
  ON conversion_artifacts(owner_user_id, conversion_job_id);
