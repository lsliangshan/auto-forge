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
    DROP TRIGGER IF EXISTS documents_scope_immutable;
    CREATE TRIGGER documents_scope_immutable
    BEFORE UPDATE ON documents
    WHEN NEW.id IS NOT OLD.id OR NEW.knowledge_base_id IS NOT OLD.knowledge_base_id
    BEGIN
      SELECT RAISE(ABORT, 'document scope is immutable');
    END;

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
    DROP TRIGGER IF EXISTS document_versions_immutable;
    DROP TRIGGER IF EXISTS document_versions_payload_immutable;
    DROP TRIGGER IF EXISTS document_versions_lifecycle;
    CREATE TRIGGER document_versions_payload_immutable
    BEFORE UPDATE ON document_versions
    WHEN NEW.id IS NOT OLD.id
      OR NEW.document_id IS NOT OLD.document_id
      OR NEW.version_number IS NOT OLD.version_number
      OR NEW.content_hash IS NOT OLD.content_hash
      OR NEW.source_object_id IS NOT OLD.source_object_id
      OR NEW.created_at IS NOT OLD.created_at
    BEGIN
      SELECT RAISE(ABORT, 'document version payload is immutable');
    END;

    CREATE TABLE IF NOT EXISTS source_objects (
      id TEXT PRIMARY KEY,
      relative_name TEXT NOT NULL UNIQUE,
      wrapped_file_key BLOB NOT NULL,
      byte_size INTEGER NOT NULL CHECK (byte_size > 0),
      content_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS knowledge_metadata (
      key TEXT PRIMARY KEY,
      value BLOB NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS conversation_selections (
      conversation_id TEXT PRIMARY KEY,
      knowledge_mode TEXT NOT NULL CHECK (knowledge_mode IN ('mixed', 'strict')),
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS conversation_selection_bases (
      conversation_id TEXT NOT NULL REFERENCES conversation_selections(conversation_id) ON DELETE CASCADE,
      knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      PRIMARY KEY (conversation_id, knowledge_base_id),
      UNIQUE (conversation_id, ordinal)
    ) STRICT;
    CREATE TRIGGER document_versions_lifecycle
    BEFORE UPDATE OF status ON document_versions
    WHEN NOT (
      (OLD.status = 'staging' AND NEW.status IN ('ready', 'failed'))
      OR (OLD.status = 'ready' AND NEW.status = 'superseded')
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid document version lifecycle transition');
    END;

    DROP TRIGGER IF EXISTS documents_active_version_scope_insert;
    DROP TRIGGER IF EXISTS documents_active_version_scope_update;
    DROP TRIGGER IF EXISTS documents_active_version_deleted;
    CREATE TRIGGER documents_active_version_scope_insert
    BEFORE INSERT ON documents
    WHEN NEW.active_version_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM document_versions
        WHERE id = NEW.active_version_id AND document_id = NEW.id
      )
    BEGIN
      SELECT RAISE(ABORT, 'active version must belong to the document');
    END;
    CREATE TRIGGER documents_active_version_deleted
    AFTER DELETE ON document_versions
    BEGIN
      UPDATE documents
      SET active_version_id = NULL
      WHERE id = OLD.document_id AND active_version_id = OLD.id;
    END;
    CREATE TRIGGER documents_active_version_scope_update
    BEFORE UPDATE OF active_version_id ON documents
    WHEN NEW.active_version_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM document_versions
        WHERE id = NEW.active_version_id AND document_id = NEW.id
      )
    BEGIN
      SELECT RAISE(ABORT, 'active version must belong to the document');
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
    DROP TRIGGER IF EXISTS knowledge_blocks_scope_immutable;
    CREATE TRIGGER knowledge_blocks_scope_immutable
    BEFORE UPDATE ON knowledge_blocks
    WHEN NEW.id IS NOT OLD.id OR NEW.version_id IS NOT OLD.version_id
    BEGIN
      SELECT RAISE(ABORT, 'knowledge block scope is immutable');
    END;

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

    DROP TRIGGER IF EXISTS kb_chunks_scope_insert;
    DROP TRIGGER IF EXISTS kb_chunks_scope_update;
    CREATE TRIGGER kb_chunks_scope_insert
    BEFORE INSERT ON kb_chunks
    WHEN NOT EXISTS (
      SELECT 1
      FROM documents
      JOIN document_versions ON document_versions.document_id = documents.id
      JOIN knowledge_blocks ON knowledge_blocks.version_id = document_versions.id
      WHERE documents.id = NEW.document_id
        AND documents.knowledge_base_id = NEW.knowledge_base_id
        AND document_versions.id = NEW.version_id
        AND knowledge_blocks.id = NEW.block_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'knowledge chunk scope mismatch');
    END;
    CREATE TRIGGER kb_chunks_scope_update
    BEFORE UPDATE OF knowledge_base_id, document_id, version_id, block_id ON kb_chunks
    WHEN NOT EXISTS (
      SELECT 1
      FROM documents
      JOIN document_versions ON document_versions.document_id = documents.id
      JOIN knowledge_blocks ON knowledge_blocks.version_id = document_versions.id
      WHERE documents.id = NEW.document_id
        AND documents.knowledge_base_id = NEW.knowledge_base_id
        AND document_versions.id = NEW.version_id
        AND knowledge_blocks.id = NEW.block_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'knowledge chunk scope mismatch');
    END;

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

    CREATE TABLE IF NOT EXISTS local_import_jobs (
      job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
      authority_token TEXT NOT NULL UNIQUE,
      knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
      object_id TEXT REFERENCES source_objects(id) ON DELETE SET NULL,
      generation INTEGER NOT NULL CHECK (generation > 0),
      format TEXT NOT NULL CHECK (format IN ('pdf', 'docx', 'txt', 'markdown', 'html')),
      source_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS local_import_jobs_document
      ON local_import_jobs(document_id, generation DESC);

    CREATE TABLE IF NOT EXISTS orphan_object_cleanups (
      relative_name TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      document_id TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS orphan_object_cleanups_document
      ON orphan_object_cleanups(document_id);

    CREATE TABLE IF NOT EXISTS document_import_heads (
      document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL CHECK (generation > 0),
      authoritative_job_id TEXT NOT NULL REFERENCES jobs(id),
      authority_token TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS purge_operations (
      id TEXT PRIMARY KEY,
      entity_kind TEXT NOT NULL CHECK (entity_kind IN ('document', 'knowledge_base')),
      target_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('prepared', 'graph_deleted', 'objects_unlinked', 'vacuumed')),
      object_ids_json TEXT NOT NULL,
      object_names_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(entity_kind, target_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS sync_cursors (
      knowledge_base_id TEXT PRIMARY KEY REFERENCES knowledge_bases(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      updated_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS cloud_sync_states (
      knowledge_base_id TEXT PRIMARY KEY REFERENCES knowledge_bases(id) ON DELETE CASCADE,
      mode TEXT NOT NULL CHECK (mode IN ('local_only', 'syncing', 'synced', 'paused', 'converting', 'failed')),
      published_generation_id TEXT,
      epoch INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0),
      updated_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS cloud_sync_mutations (
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
    CREATE INDEX IF NOT EXISTS cloud_sync_mutations_ready
      ON cloud_sync_mutations(knowledge_base_id, state, created_at);

    CREATE TABLE IF NOT EXISTS cloud_sync_orphans (
      storage_reference TEXT PRIMARY KEY,
      knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS cloud_sync_conversions (
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

    CREATE TABLE IF NOT EXISTS conflicts (
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
