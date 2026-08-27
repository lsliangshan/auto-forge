import { describe, expect, it } from 'vitest'
import { KnowledgeExportService } from './export-service.js'
import { memoryKnowledgeStore } from './knowledge-test-support.js'

describe('knowledge export service', () => {
  it('writes originals and a sanitized manifest without private implementation data', async () => {
    // Catches exports that leak paths, vectors, keys, chunks, queries, or URLs.
    const memory = memoryKnowledgeStore()
    const original = Buffer.from('原始合同正文')
    const stored = await memory.objects.put(original)
    const db = memory.database
    db.prepare('INSERT INTO knowledge_bases(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('base', '合同库', 1, 2)
    db.prepare(`INSERT INTO documents(
      id, knowledge_base_id, name, mime_type, active_version_id, created_at, updated_at,
      lifecycle_status, publication_generation, recycled_at
    ) VALUES ('doc', 'base', '合同.txt', 'text/plain', NULL, 1, 2, 'ready', 1, NULL)`).run()
    db.prepare(`INSERT INTO document_versions(
      id, document_id, version_number, status, content_hash, object_id, created_at, publication_generation
    ) VALUES ('version', 'doc', 1, 'ready', 'secret-hash', ?, 2, 1)`).run(stored.objectId)
    db.prepare("UPDATE documents SET active_version_id = 'version' WHERE id = 'doc'").run()
    db.prepare(`INSERT INTO knowledge_blocks(id, version_id, ordinal, kind, text, coordinates_json)
      VALUES ('block', 'version', 0, 'txt', 'hidden chunk sentinel', '{"kind":"txt"}')`).run()
    db.prepare(`INSERT INTO kb_chunks(id, knowledge_base_id, document_id, version_id, block_id, ordinal, body, coordinates_json)
      VALUES ('chunk', 'base', 'doc', 'version', 'block', 0, 'query url https://secret.example', '{"kind":"txt"}')`).run()
    let archive: Buffer | undefined
    const exporter = new KnowledgeExportService({
      database: db,
      objects: memory.objects,
      save: async (_name, bytes) => { archive = Buffer.from(bytes) },
    })

    await exporter.exportBase('base')

    expect(archive).toBeDefined()
    const serialized = archive!.toString('utf8')
    expect(serialized).toContain('manifest.json')
    expect(serialized).toContain('originals/version.txt')
    expect(serialized).toContain('原始合同正文')
    expect(serialized).not.toMatch(/secret-hash|hidden chunk sentinel|query url|https:\/\/|objectId|vector|localPath|filePath|key/i)
  })

  it('clears the assembled archive when the user-visible save fails', async () => {
    // Catches plaintext export buffers retained after a failed filesystem write.
    const memory = memoryKnowledgeStore()
    memory.database.prepare(
      'INSERT INTO knowledge_bases(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('base', '合同库', 1, 2)
    let captured: Buffer | undefined
    const exporter = new KnowledgeExportService({
      database: memory.database,
      objects: memory.objects,
      save: async (_name, bytes) => {
        captured = bytes
        throw new Error('save failed')
      },
    })

    await expect(exporter.exportBase('base')).rejects.toThrow('save failed')
    expect(captured).toBeDefined()
    expect(captured!.every(byte => byte === 0)).toBe(true)
  })

  it('rejects an export before retained originals exceed its memory ceiling', async () => {
    // Catches repeated immutable versions growing one in-memory ZIP without a hard bound.
    const memory = memoryKnowledgeStore()
    const first = await memory.objects.put(Buffer.from('1234'))
    const second = await memory.objects.put(Buffer.from('5678'))
    const db = memory.database
    db.prepare('INSERT INTO knowledge_bases(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('base', '合同库', 1, 2)
    db.prepare(`INSERT INTO documents(
      id, knowledge_base_id, name, mime_type, active_version_id, created_at, updated_at,
      lifecycle_status, publication_generation, recycled_at
    ) VALUES ('doc', 'base', '合同.txt', 'text/plain', NULL, 1, 2, 'ready', 2, NULL)`).run()
    db.prepare(`INSERT INTO document_versions(
      id, document_id, version_number, status, content_hash, object_id, created_at, publication_generation
    ) VALUES ('v1', 'doc', 1, 'superseded', 'h1', ?, 1, 1),
             ('v2', 'doc', 2, 'ready', 'h2', ?, 2, 2)`).run(first.objectId, second.objectId)
    const exporter = new KnowledgeExportService({
      database: db,
      objects: memory.objects,
      save: async () => undefined,
      maxBytes: 5,
    })

    await expect(exporter.exportBase('base')).rejects.toThrow('export exceeds its limit')
  })
})
