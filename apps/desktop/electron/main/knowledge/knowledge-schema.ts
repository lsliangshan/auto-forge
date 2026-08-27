import type Database from 'better-sqlite3'

export const KNOWLEDGE_SCHEMA_VERSION = 1

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
    FOREIGN KEY (knowledge_base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE
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
    database.exec(KNOWLEDGE_SCHEMA_V1)
    database.prepare(
      'INSERT INTO knowledge_schema_migrations (version, applied_at) VALUES (?, ?)',
    ).run(KNOWLEDGE_SCHEMA_VERSION, Date.now())
  })()
}
