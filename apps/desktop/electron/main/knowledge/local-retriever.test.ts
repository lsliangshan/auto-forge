import { describe, expect, it } from 'vitest'
import { LocalKnowledgeRetriever } from './local-retriever.js'
import { memoryKnowledgeStore } from './knowledge-test-support.js'

function seedSearchable(memory: ReturnType<typeof memoryKnowledgeStore>) {
  const db = memory.database
  db.prepare('INSERT INTO knowledge_bases(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('base', '合同库', 1, 1)
  db.prepare(`INSERT INTO documents(
    id, knowledge_base_id, name, mime_type, active_version_id, created_at, updated_at,
    lifecycle_status, publication_generation, recycled_at
  ) VALUES ('doc', 'base', '合同.txt', 'text/plain', NULL, 1, 1, 'ready', 1, NULL)`).run()
  db.prepare(`INSERT INTO document_versions(
    id, document_id, version_number, status, content_hash, object_id, created_at, publication_generation
  ) VALUES ('ready', 'doc', 1, 'ready', 'hash', '00000000000000000000000000000001', 1, 1)`).run()
  db.prepare("UPDATE documents SET active_version_id = 'ready' WHERE id = 'doc'").run()
  db.prepare(`INSERT INTO document_versions(
    id, document_id, version_number, status, content_hash, object_id, created_at, publication_generation
  ) VALUES ('staging', 'doc', 2, 'staging', 'hash2', '00000000000000000000000000000002', 2, 2)`).run()
  for (let index = 0; index < 9; index += 1) {
    const version = index === 8 ? 'staging' : 'ready'
    const block = `block-${index}`
    db.prepare(`INSERT INTO knowledge_blocks(id, version_id, ordinal, kind, text, coordinates_json)
      VALUES (?, ?, ?, 'txt', ?, ?)`).run(block, version, index, `合同条款第${index + 1}项`, JSON.stringify({
      kind: 'txt', lineStart: index + 1, lineEnd: index + 1, charStart: 0, charEnd: 8,
    }))
    db.prepare(`INSERT INTO kb_chunks(id, knowledge_base_id, document_id, version_id, block_id, ordinal, body, coordinates_json)
      VALUES (?, 'base', 'doc', ?, ?, ?, ?, ?)`).run(
      `chunk-${index}`, version, block, index, `合同条款第${index + 1}项`, JSON.stringify({
        kind: 'txt', lineStart: index + 1, lineEnd: index + 1, charStart: 0, charEnd: 8,
      }),
    )
  }
}

describe('local knowledge retriever', () => {
  it('uses bounded literal strategies and searches only the published ready version', async () => {
    // Catches SQL/FTS injection, unbounded two-character scans, and unpublished-version leakage.
    const memory = memoryKnowledgeStore()
    seedSearchable(memory)
    const retriever = new LocalKnowledgeRetriever(memory.database)

    await expect(retriever.search('合同条款', ['base'])).resolves.toHaveLength(8)
    await expect(retriever.search('合同', ['base'])).resolves.toMatchObject({ strategy: 'bounded-instr' })
    await expect(retriever.search('合', ['base'])).resolves.toEqual({ kind: 'query-too-short' })
    const results = await retriever.search('合同条款', ['base'])
    if (!Array.isArray(results)) throw new Error('Expected search results')
    expect(Array.from(results)).toHaveLength(8)
    expect(Array.from(results).every(item => item.versionId === 'ready')).toBe(true)
    await expect(retriever.search('" OR *', ['base'])).resolves.toEqual(expect.anything())
  })
})
