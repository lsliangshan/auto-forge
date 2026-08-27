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

describe('knowledge schema v1', () => {
  it('initializes the versioned personal knowledge graph exactly once', () => {
    const database = testDatabase()

    initializeKnowledgeSchema(database)
    initializeKnowledgeSchema(database)

    expect(KNOWLEDGE_SCHEMA_VERSION).toBe(1)
    expect(database.prepare('SELECT version FROM knowledge_schema_migrations').all())
      .toEqual([{ version: 1 }])
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
      'knowledge_schema_migrations',
    ]))
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
      SELECT kb_chunks.id
      FROM kb_chunks_fts
      JOIN kb_chunks ON kb_chunks.rowid = kb_chunks_fts.rowid
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
