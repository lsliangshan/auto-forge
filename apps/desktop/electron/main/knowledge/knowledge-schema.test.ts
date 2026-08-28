import { createRequire } from 'node:module'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { initializeKnowledgeSchema, KNOWLEDGE_SCHEMA_VERSION } from './knowledge-schema.js'

const CipherDatabase = createRequire(import.meta.url)('better-sqlite3-multiple-ciphers') as {
  new(filename?: string): Database.Database
}

const databases: Database.Database[] = []

function testDatabase(): Database.Database {
  const database = new CipherDatabase(':memory:')
  databases.push(database)
  database.pragma('foreign_keys = ON')
  return database
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

describe('knowledge schema v12', () => {
  it('initializes the versioned personal knowledge graph exactly once', () => {
    const database = testDatabase()

    initializeKnowledgeSchema(database)
    initializeKnowledgeSchema(database)

    expect(KNOWLEDGE_SCHEMA_VERSION).toBe(12)
    expect(database.prepare('SELECT version FROM knowledge_schema_migrations').all())
      .toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 }, { version: 11 }, { version: 12 }])
    const tables = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as Array<{ name: string }>
    expect(tables.map(row => row.name)).toEqual(expect.arrayContaining([
      'document_versions',
      'documents',
      'kb_chunks',
      'kb_chunks_fts',
      'knowledge_bases',
      'knowledge_blocks',
      'knowledge_cleanup_records',
      'knowledge_import_jobs',
      'knowledge_provider_consents',
      'knowledge_entitlement_projection',
      'knowledge_free_retention',
      'knowledge_cloud_retention',
      'knowledge_cloud_deletion_receipts',
      'knowledge_schema_migrations',
      'cloud_sync_conversions',
      'cloud_sync_mutations',
      'cloud_sync_states',
      'cloud_entity_heads',
      'cloud_pending_publications',
      'cloud_base_projections',
      'cloud_document_projections',
      'cloud_version_projections',
      'cloud_generation_projections',
      'cloud_remote_sync_cursors',
      'cloud_remote_sync_states',
      'cloud_remote_entity_heads',
      'conflicts',
      'sync_cursors',
    ]))
    expect(database.prepare(`
      SELECT lifecycle_status, publication_generation, recycled_at
      FROM documents LIMIT 0
    `).all()).toEqual([])
    expect(database.prepare('SELECT name, mime_type FROM document_versions LIMIT 0').all()).toEqual([])
    expect(database.prepare(
      'SELECT accepted_key_generation FROM knowledge_entitlement_projection LIMIT 0',
    ).all()).toEqual([])
    expect((database.prepare(
      'PRAGMA table_info(knowledge_cloud_deletion_receipts)',
    ).all() as Array<{ name: string }>).map(column => column.name)).toEqual([
      'knowledge_base_id', 'operation_id', 'request_id', 'deletion_job_id', 'completed_at',
    ])
    expect((database.prepare(
      'PRAGMA table_info(cloud_pending_publications)',
    ).all() as Array<{ name: string }>).map(column => column.name)).toEqual([
      'knowledge_base_id', 'generation_id', 'document_id', 'version_id', 'object_id',
      'upload_job_id', 'publish_request_id', 'updated_at', 'recovery_attempt',
      'next_retry_at', 'last_error_code',
    ])
    expect((database.prepare(
      'PRAGMA table_info(cloud_version_projections)',
    ).all() as Array<{ name: string }>).map(column => column.name)).toEqual([
      'id', 'knowledge_base_id', 'document_id', 'version_number', 'status',
      'content_hash', 'generation_id', 'created_at', 'local_object_available',
      'revision', 'updated_at',
    ])
    expect(() => database.exec(`
      INSERT INTO cloud_base_projections(
        id, name, status, published_generation_id, revision, updated_at
      ) VALUES ('cloud_base', 'Cloud', 'ready', 'cloud_generation', 'r1', 1);
      INSERT INTO cloud_document_projections(
        id, knowledge_base_id, name, mime_type, active_version_id, status, revision, updated_at
      ) VALUES (
        'cloud_document', 'cloud_base', 'cloud.txt', 'text/plain',
        'cloud_version', 'ready', 'r1', 1
      );
      INSERT INTO cloud_generation_projections(
        id, knowledge_base_id, status, revision, updated_at
      ) VALUES ('cloud_generation', 'cloud_base', 'published', 'r1', 1);
      INSERT INTO cloud_version_projections(
        id, knowledge_base_id, document_id, version_number, status, content_hash,
        generation_id, created_at, local_object_available, revision, updated_at
      ) VALUES (
        'cloud_version', 'cloud_base', 'cloud_document', 1, 'ready', 'hash',
        'cloud_generation', 1, 1, 'r1', 1
      );
    `)).toThrow(/check constraint/i)
    expect((database.prepare(
      "PRAGMA foreign_key_list('sync_cursors')",
    ).all() as Array<{ table: string }>).map(foreignKey => foreignKey.table)).toContain(
      'knowledge_bases',
    )
    expect((database.prepare(
      "PRAGMA foreign_key_list('cloud_sync_states')",
    ).all() as Array<{ table: string }>).map(foreignKey => foreignKey.table)).toContain(
      'knowledge_bases',
    )
    database.prepare(`
      INSERT INTO cloud_remote_sync_states(
        knowledge_base_id, mode, published_generation_id, epoch, updated_at
      ) VALUES (?, 'syncing', NULL, 1, ?)
    `).run('remote_only_base', 1)
    database.prepare(`
      INSERT INTO cloud_remote_sync_cursors(knowledge_base_id, sequence, updated_at)
      VALUES (?, ?, ?)
    `).run('remote_only_base', 7, 1)
  })

  it('backfills immutable version metadata when upgrading a v2 database', () => {
    const database = testDatabase()
    initializeKnowledgeSchema(database)
    database.prepare('DELETE FROM knowledge_schema_migrations WHERE version >= 3').run()
    database.exec(`
      DROP TABLE cloud_version_projections;
      DROP TABLE cloud_generation_projections;
      DROP TABLE cloud_document_projections;
      DROP TABLE cloud_base_projections;
      DROP TABLE cloud_remote_sync_cursors;
      DROP TABLE cloud_remote_sync_states;
      DROP TABLE cloud_remote_entity_heads;
      DROP TABLE knowledge_provider_consents;
      DROP TABLE cloud_pending_publications;
      DROP TABLE cloud_entity_heads;
      DROP TABLE knowledge_cloud_deletion_receipts;
      DROP TABLE knowledge_cloud_retention;
      DROP TABLE knowledge_free_retention;
      DROP TABLE knowledge_entitlement_projection;
      DROP TABLE conflicts;
      DROP TABLE cloud_sync_conversions;
      DROP TABLE cloud_sync_orphans;
      DROP TABLE cloud_sync_mutations;
      DROP TABLE cloud_sync_states;
      DROP TABLE sync_cursors;
    `)
    database.exec(`
      ALTER TABLE document_versions DROP COLUMN mime_type;
      ALTER TABLE document_versions DROP COLUMN name;
      INSERT INTO knowledge_bases(id, name, created_at, updated_at) VALUES ('base', 'Base', 1, 1);
      INSERT INTO documents(id, knowledge_base_id, name, mime_type, created_at, updated_at)
      VALUES ('doc', 'base', '旧合同.txt', 'text/plain', 1, 1);
      INSERT INTO document_versions(id, document_id, version_number, status, content_hash, object_id, created_at)
      VALUES ('version', 'doc', 1, 'ready', 'hash', 'object', 1);
    `)

    initializeKnowledgeSchema(database)

    expect(database.prepare('SELECT name, mime_type FROM document_versions').get()).toEqual({
      name: '旧合同.txt', mime_type: 'text/plain',
    })
  })

  it('keeps trigram FTS rows synchronized with external chunk content', () => {
    const database = testDatabase()
    initializeKnowledgeSchema(database)
    database.exec(`
      INSERT INTO knowledge_bases (id, name, created_at, updated_at)
      VALUES ('kb_1', '本地知识库', 1, 1);
      INSERT INTO documents (id, knowledge_base_id, name, mime_type, created_at, updated_at)
      VALUES ('document_1', 'kb_1', 'source.txt', 'text/plain', 1, 1);
      INSERT INTO document_versions (id, document_id, version_number, status, content_hash, object_id, created_at)
      VALUES ('version_1', 'document_1', 1, 'ready', 'hash-1', 'object-1', 1);
      INSERT INTO knowledge_blocks (id, version_id, ordinal, kind, text, coordinates_json)
      VALUES ('block_1', 'version_1', 0, 'paragraph', '橙色星云测试标记', '{}');
      INSERT INTO kb_chunks
        (id, knowledge_base_id, document_id, version_id, block_id, ordinal, body, coordinates_json)
      VALUES ('chunk_1', 'kb_1', 'document_1', 'version_1', 'block_1', 0, '橙色星云测试标记', '{}');
    `)

    expect(database.prepare(`
      SELECT kb_chunks.id
      FROM kb_chunks_fts
      JOIN kb_chunks ON kb_chunks.rowid = kb_chunks_fts.rowid
      WHERE kb_chunks_fts MATCH ?
    `).all('"橙色星云"')).toEqual([{ id: 'chunk_1' }])

    database.prepare(
      "UPDATE kb_chunks SET body = '紫色彗星更新内容' WHERE id = 'chunk_1'",
    ).run()
    expect(database.prepare(`
      SELECT kb_chunks.id
      FROM kb_chunks_fts
      JOIN kb_chunks ON kb_chunks.rowid = kb_chunks_fts.rowid
      WHERE kb_chunks_fts MATCH ?
    `).all('"橙色星云"')).toEqual([])
    expect(database.prepare(`
      SELECT kb_chunks.id
      FROM kb_chunks_fts
      JOIN kb_chunks ON kb_chunks.rowid = kb_chunks_fts.rowid
      WHERE kb_chunks_fts MATCH ?
    `).all('"紫色彗星"')).toEqual([{ id: 'chunk_1' }])

    database.prepare("DELETE FROM kb_chunks WHERE id = 'chunk_1'").run()
    expect(database.prepare(`
      SELECT rowid
      FROM kb_chunks_fts
      WHERE kb_chunks_fts MATCH ?
    `).all('"紫色彗星"')).toEqual([])
  })

  it('rejects a chunk whose graph identifiers cross knowledge-base boundaries', () => {
    const database = testDatabase()
    initializeKnowledgeSchema(database)
    database.exec(`
      INSERT INTO knowledge_bases (id, name, created_at, updated_at) VALUES
        ('kb_a', 'A', 1, 1), ('kb_b', 'B', 1, 1);
      INSERT INTO documents (id, knowledge_base_id, name, mime_type, created_at, updated_at)
      VALUES ('document_a', 'kb_a', 'a.txt', 'text/plain', 1, 1);
      INSERT INTO document_versions (id, document_id, version_number, status, content_hash, object_id, created_at)
      VALUES ('version_a', 'document_a', 1, 'ready', 'hash-a', 'object-a', 1);
      INSERT INTO knowledge_blocks (id, version_id, ordinal, kind, text, coordinates_json)
      VALUES ('block_a', 'version_a', 0, 'paragraph', 'a', '{}');
    `)

    expect(() => database.prepare(`
      INSERT INTO kb_chunks
        (id, knowledge_base_id, document_id, version_id, block_id, ordinal, body, coordinates_json)
      VALUES ('chunk_bad', 'kb_b', 'document_a', 'version_a', 'block_a', 0, 'bad', '{}')
    `).run()).toThrow(/foreign key/i)
  })

  it('publishes only an active version belonging to the same document', () => {
    const database = testDatabase()
    initializeKnowledgeSchema(database)
    database.exec(`
      INSERT INTO knowledge_bases (id, name, created_at, updated_at)
      VALUES ('kb_versions', 'Versions', 1, 1);
      INSERT INTO documents (id, knowledge_base_id, name, mime_type, created_at, updated_at) VALUES
        ('document_a', 'kb_versions', 'a.txt', 'text/plain', 1, 1),
        ('document_b', 'kb_versions', 'b.txt', 'text/plain', 1, 1);
      INSERT INTO document_versions
        (id, document_id, version_number, status, content_hash, object_id, created_at) VALUES
        ('version_a', 'document_a', 1, 'ready', 'hash-a', 'object-a', 1),
        ('version_b', 'document_b', 1, 'ready', 'hash-b', 'object-b', 1);
    `)

    expect(() => database.prepare(
      "UPDATE documents SET active_version_id = 'version_missing' WHERE id = 'document_a'",
    ).run()).toThrow(/foreign key/i)
    expect(() => database.prepare(
      "UPDATE documents SET active_version_id = 'version_b' WHERE id = 'document_a'",
    ).run()).toThrow(/foreign key/i)

    expect(() => database.prepare(
      "UPDATE documents SET active_version_id = 'version_a' WHERE id = 'document_a'",
    ).run()).not.toThrow()
    expect(database.prepare(
      "SELECT active_version_id AS activeVersionId FROM documents WHERE id = 'document_a'",
    ).get()).toEqual({ activeVersionId: 'version_a' })
  })
})
