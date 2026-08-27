import type Database from 'better-sqlite3'

export const KNOWLEDGE_SCHEMA_VERSION = 8

const KNOWLEDGE_SCHEMA_V1 = `
  CREATE TABLE knowledge_bases (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    knowledge_base_id TEXT NOT NULL,
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    active_version_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (id, knowledge_base_id),
    FOREIGN KEY (knowledge_base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    FOREIGN KEY (active_version_id, id) REFERENCES document_versions(id, document_id)
  ) STRICT;

  CREATE TABLE document_versions (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    version_number INTEGER NOT NULL CHECK (version_number > 0),
    status TEXT NOT NULL CHECK (status IN ('staging', 'ready', 'failed', 'superseded')),
    content_hash TEXT NOT NULL,
    object_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (id, document_id),
    UNIQUE (document_id, version_number),
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE knowledge_blocks (
    id TEXT PRIMARY KEY,
    version_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    coordinates_json TEXT NOT NULL,
    UNIQUE (id, version_id),
    UNIQUE (version_id, ordinal),
    FOREIGN KEY (version_id) REFERENCES document_versions(id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE kb_chunks (
    id TEXT PRIMARY KEY,
    knowledge_base_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    block_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    body TEXT NOT NULL,
    coordinates_json TEXT NOT NULL,
    UNIQUE (version_id, ordinal),
    FOREIGN KEY (knowledge_base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    FOREIGN KEY (document_id, knowledge_base_id)
      REFERENCES documents(id, knowledge_base_id) ON DELETE CASCADE,
    FOREIGN KEY (version_id, document_id)
      REFERENCES document_versions(id, document_id) ON DELETE CASCADE,
    FOREIGN KEY (block_id, version_id)
      REFERENCES knowledge_blocks(id, version_id) ON DELETE CASCADE
  ) STRICT;

  CREATE VIRTUAL TABLE kb_chunks_fts USING fts5(
    body,
    content='kb_chunks',
    content_rowid='rowid',
    tokenize='trigram'
  );

  CREATE TRIGGER kb_chunks_fts_insert AFTER INSERT ON kb_chunks BEGIN
    INSERT INTO kb_chunks_fts(rowid, body) VALUES (new.rowid, new.body);
  END;

  CREATE TRIGGER kb_chunks_fts_delete AFTER DELETE ON kb_chunks BEGIN
    INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, body)
    VALUES ('delete', old.rowid, old.body);
  END;

  CREATE TRIGGER kb_chunks_fts_update AFTER UPDATE OF body ON kb_chunks BEGIN
    INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, body)
    VALUES ('delete', old.rowid, old.body);
    INSERT INTO kb_chunks_fts(rowid, body) VALUES (new.rowid, new.body);
  END;
`

const KNOWLEDGE_SCHEMA_V2 = `
  ALTER TABLE knowledge_bases ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'ready'
    CHECK (lifecycle_status IN ('ready', 'processing', 'paused', 'failed', 'read_only', 'recycled'));
  ALTER TABLE knowledge_bases ADD COLUMN recycled_at INTEGER;

  ALTER TABLE documents ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'queued'
    CHECK (lifecycle_status IN ('queued', 'copying', 'parsing', 'indexing', 'ready', 'failed', 'paused', 'deleted'));
  ALTER TABLE documents ADD COLUMN publication_generation INTEGER NOT NULL DEFAULT 0
    CHECK (publication_generation >= 0);
  ALTER TABLE documents ADD COLUMN recycled_at INTEGER;

  ALTER TABLE document_versions ADD COLUMN publication_generation INTEGER NOT NULL DEFAULT 0
    CHECK (publication_generation >= 0);
  ALTER TABLE document_versions ADD COLUMN error_code TEXT;

  CREATE TABLE knowledge_import_jobs (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    version_id TEXT NOT NULL UNIQUE,
    generation INTEGER NOT NULL CHECK (generation > 0),
    publication_token TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
    FOREIGN KEY (version_id, document_id) REFERENCES document_versions(id, document_id) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX knowledge_import_jobs_status_idx
    ON knowledge_import_jobs(status, created_at, id);

  CREATE TABLE knowledge_cleanup_records (
    object_id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  ) STRICT;
`

const KNOWLEDGE_SCHEMA_V3 = `
  ALTER TABLE document_versions ADD COLUMN name TEXT NOT NULL DEFAULT '';
  ALTER TABLE document_versions ADD COLUMN mime_type TEXT NOT NULL DEFAULT '';

  UPDATE document_versions
  SET name = (SELECT documents.name FROM documents WHERE documents.id = document_versions.document_id),
      mime_type = (SELECT documents.mime_type FROM documents WHERE documents.id = document_versions.document_id);
`

const KNOWLEDGE_SCHEMA_V4 = `
  CREATE TABLE sync_cursors (
    knowledge_base_id TEXT PRIMARY KEY REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE cloud_sync_states (
    knowledge_base_id TEXT PRIMARY KEY REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK (mode IN ('local_only', 'syncing', 'synced', 'paused', 'converting', 'failed')),
    published_generation_id TEXT,
    epoch INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0),
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE cloud_sync_mutations (
    id TEXT PRIMARY KEY,
    knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    entity_kind TEXT NOT NULL CHECK (entity_kind IN ('knowledge_base', 'document', 'metadata')),
    entity_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
    base_revision TEXT,
    payload_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'retry', 'completed', 'conflict', 'failed', 'cancelled')),
    attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 3),
    lease_token TEXT,
    lease_expires_at INTEGER,
    error_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX cloud_sync_mutations_ready
    ON cloud_sync_mutations(knowledge_base_id, state, created_at, id);

  CREATE TABLE cloud_sync_orphans (
    storage_reference TEXT PRIMARY KEY,
    knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE cloud_sync_conversions (
    knowledge_base_id TEXT PRIMARY KEY REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL UNIQUE,
    request_id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('downloading', 'verified', 'purge_accepted', 'completed')),
    expected_published_generation_id TEXT,
    previous_mode TEXT NOT NULL CHECK (previous_mode IN ('local_only', 'syncing', 'synced', 'paused', 'failed')),
    expected_digest TEXT,
    actual_digest TEXT,
    deletion_job_id TEXT,
    error_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE conflicts (
    id TEXT PRIMARY KEY,
    knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    entity_kind TEXT NOT NULL,
    conflict_kind TEXT NOT NULL CHECK (conflict_kind IN ('content', 'delete_vs_update')),
    entity_id TEXT NOT NULL,
    local_version TEXT,
    remote_version TEXT,
    status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  ) STRICT;
  CREATE INDEX conflicts_scope ON conflicts(knowledge_base_id, status);
`

const KNOWLEDGE_SCHEMA_V5 = `
  CREATE TABLE knowledge_provider_consents (
    provider TEXT PRIMARY KEY CHECK (provider IN ('openrouter', 'deepseek')),
    status TEXT NOT NULL CHECK (status IN ('granted', 'denied')),
    updated_at INTEGER NOT NULL
  ) STRICT;
`

const KNOWLEDGE_SCHEMA_V6 = `
  CREATE TABLE knowledge_entitlement_projection (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    tier TEXT NOT NULL CHECK (tier IN ('free', 'member')),
    status TEXT NOT NULL CHECK (status IN ('active', 'offline_grace', 'expired', 'unavailable')),
    beta_enabled INTEGER NOT NULL CHECK (beta_enabled IN (0, 1)),
    cloud_enabled INTEGER NOT NULL CHECK (cloud_enabled IN (0, 1)),
    expires_at INTEGER,
    grace_ends_at INTEGER,
    epoch INTEGER NOT NULL CHECK (epoch >= 0),
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE knowledge_free_retention (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    knowledge_base_id TEXT NOT NULL,
    document_id TEXT,
    confirmed INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
    entitlement_epoch INTEGER NOT NULL CHECK (entitlement_epoch >= 0),
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (knowledge_base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    FOREIGN KEY (document_id, knowledge_base_id)
      REFERENCES documents(id, knowledge_base_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE knowledge_cloud_retention (
    knowledge_base_id TEXT PRIMARY KEY REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    stage TEXT NOT NULL CHECK (stage IN ('download_window', 'recycle', 'purging')),
    download_until INTEGER NOT NULL,
    recycle_until INTEGER NOT NULL,
    operation_id TEXT NOT NULL UNIQUE,
    request_id TEXT NOT NULL UNIQUE,
    deletion_job_id TEXT,
    epoch INTEGER NOT NULL CHECK (epoch >= 0),
    updated_at INTEGER NOT NULL,
    CHECK (download_until <= recycle_until)
  ) STRICT;
`

const KNOWLEDGE_SCHEMA_V7 = `
  ALTER TABLE knowledge_entitlement_projection
    ADD COLUMN accepted_issued_at INTEGER;
  ALTER TABLE knowledge_entitlement_projection
    ADD COLUMN accepted_key_id TEXT;
  ALTER TABLE knowledge_entitlement_projection
    ADD COLUMN accepted_snapshot_digest TEXT;
  ALTER TABLE knowledge_entitlement_projection
    ADD COLUMN verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1));
  ALTER TABLE knowledge_entitlement_projection
    ADD COLUMN explicit_free INTEGER NOT NULL DEFAULT 0 CHECK (explicit_free IN (0, 1));
  ALTER TABLE knowledge_entitlement_projection
    ADD COLUMN max_observed_at INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE knowledge_free_retention_v7 (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    knowledge_base_id TEXT,
    document_id TEXT,
    confirmed INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
    entitlement_epoch INTEGER NOT NULL CHECK (entitlement_epoch >= 0),
    updated_at INTEGER NOT NULL,
    CHECK (document_id IS NULL OR knowledge_base_id IS NOT NULL),
    CHECK (confirmed = 0 OR (knowledge_base_id IS NOT NULL AND document_id IS NOT NULL)),
    FOREIGN KEY (knowledge_base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    FOREIGN KEY (document_id, knowledge_base_id)
      REFERENCES documents(id, knowledge_base_id) ON DELETE CASCADE
  ) STRICT;
  INSERT INTO knowledge_free_retention_v7
    SELECT * FROM knowledge_free_retention;
  DROP TABLE knowledge_free_retention;
  ALTER TABLE knowledge_free_retention_v7 RENAME TO knowledge_free_retention;
`

const KNOWLEDGE_SCHEMA_V8 = `
  ALTER TABLE knowledge_entitlement_projection
    ADD COLUMN accepted_key_generation INTEGER NOT NULL DEFAULT 0
      CHECK (accepted_key_generation >= 0);
`

const migrations = new Map<number, string>([
  [1, KNOWLEDGE_SCHEMA_V1],
  [2, KNOWLEDGE_SCHEMA_V2],
  [3, KNOWLEDGE_SCHEMA_V3],
  [4, KNOWLEDGE_SCHEMA_V4],
  [5, KNOWLEDGE_SCHEMA_V5],
  [6, KNOWLEDGE_SCHEMA_V6],
  [7, KNOWLEDGE_SCHEMA_V7],
  [8, KNOWLEDGE_SCHEMA_V8],
])

export function initializeKnowledgeSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
  `)
  const current = database.prepare(
    'SELECT max(version) AS version FROM knowledge_schema_migrations',
  ).get() as { version: number | null }
  if ((current.version ?? 0) > KNOWLEDGE_SCHEMA_VERSION) {
    throw new Error('Knowledge database schema is newer than this application')
  }
  if (current.version === KNOWLEDGE_SCHEMA_VERSION) return

  database.transaction(() => {
    for (let version = (current.version ?? 0) + 1; version <= KNOWLEDGE_SCHEMA_VERSION; version += 1) {
      const migration = migrations.get(version)
      if (!migration) throw new Error(`Knowledge database migration ${version} is unavailable`)
      database.exec(migration)
      database.prepare(
        'INSERT INTO knowledge_schema_migrations (version, applied_at) VALUES (?, ?)',
      ).run(version, Date.now())
    }
  })()
}
