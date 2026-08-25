import type Database from 'better-sqlite3-multiple-ciphers'

export interface KnowledgeDatabaseCapabilities {
  readonly tempStore: 'memory'
  readonly fts5: true
  readonly trigram: true
}

export function configureKnowledgeConnection(database: Database.Database): void {
  database.pragma('foreign_keys = ON')
  database.pragma('temp_store = MEMORY')
  if (database.pragma('temp_store', { simple: true }) !== 2) {
    throw new Error('Encrypted knowledge database requires memory-only temporary storage')
  }
}

export function probeKnowledgeCapabilities(
  database: Database.Database,
): KnowledgeDatabaseCapabilities {
  const compileOptions = database.pragma('compile_options') as Array<{ compile_options: string }>
  if (!compileOptions.some(({ compile_options: option }) => option === 'ENABLE_FTS5')) {
    throw new Error('Encrypted knowledge database requires FTS5')
  }

  database.exec(`
    CREATE VIRTUAL TABLE temp.__knowledge_trigram_probe
    USING fts5(body, tokenize='trigram');
    DROP TABLE temp.__knowledge_trigram_probe;
  `)

  return { tempStore: 'memory', fts5: true, trigram: true }
}

export function initializeKnowledgeSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_bases (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'read_only', 'recycled')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      active_version_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'ready', 'failed', 'recycled')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS documents_knowledge_base
      ON documents(knowledge_base_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS document_versions (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      version_number INTEGER NOT NULL CHECK (version_number > 0),
      status TEXT NOT NULL CHECK (status IN ('staging', 'ready', 'failed', 'superseded')),
      content_hash TEXT NOT NULL,
      source_object_id TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(document_id, version_number)
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS document_versions_immutable
    BEFORE UPDATE ON document_versions BEGIN
      SELECT RAISE(ABORT, 'document versions are immutable');
    END;

    CREATE TABLE IF NOT EXISTS knowledge_blocks (
      id TEXT PRIMARY KEY,
      version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      coordinates_json TEXT NOT NULL,
      UNIQUE(version_id, ordinal)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS kb_chunks (
      rowid INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
      block_id TEXT NOT NULL REFERENCES knowledge_blocks(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      body TEXT NOT NULL,
      coordinates_json TEXT NOT NULL,
      UNIQUE(version_id, ordinal)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS kb_chunks_scope
      ON kb_chunks(knowledge_base_id, document_id, version_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
      body,
      content='kb_chunks',
      content_rowid='rowid',
      tokenize='trigram',
      detail=full
    );
    CREATE TRIGGER IF NOT EXISTS kb_chunks_fts_insert AFTER INSERT ON kb_chunks BEGIN
      INSERT INTO kb_chunks_fts(rowid, body) VALUES (new.rowid, new.body);
    END;
    CREATE TRIGGER IF NOT EXISTS kb_chunks_fts_delete AFTER DELETE ON kb_chunks BEGIN
      INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, body)
      VALUES ('delete', old.rowid, old.body);
    END;
    CREATE TRIGGER IF NOT EXISTS kb_chunks_fts_update AFTER UPDATE OF body ON kb_chunks BEGIN
      INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, body)
      VALUES ('delete', old.rowid, old.body);
      INSERT INTO kb_chunks_fts(rowid, body) VALUES (new.rowid, new.body);
    END;

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'paused', 'completed', 'failed', 'cancelled')),
      attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      lease_token TEXT,
      lease_expires_at INTEGER,
      error_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, updated_at);

    CREATE TABLE IF NOT EXISTS sync_cursors (
      knowledge_base_id TEXT PRIMARY KEY REFERENCES knowledge_bases(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      updated_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS conflicts (
      id TEXT PRIMARY KEY,
      knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
      entity_kind TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      local_version TEXT,
      remote_version TEXT,
      status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    ) STRICT;
    CREATE INDEX IF NOT EXISTS conflicts_scope ON conflicts(knowledge_base_id, status);

    CREATE TABLE IF NOT EXISTS tombstones (
      id TEXT PRIMARY KEY,
      knowledge_base_id TEXT NOT NULL,
      entity_kind TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      deleted_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS tombstones_sequence ON tombstones(sequence);
    CREATE INDEX IF NOT EXISTS tombstones_expiry ON tombstones(expires_at);
  `)
}
