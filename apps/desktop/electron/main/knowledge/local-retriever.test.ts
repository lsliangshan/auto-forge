import { describe, expect, it, vi } from 'vitest'
import { LocalKnowledgeRetriever } from './local-retriever.js'
import { LocalSemanticIndex } from './local-semantic-index.js'
import type { LocalTextEmbedder } from './local-embedding.js'
import { memoryKnowledgeStore } from './knowledge-test-support.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

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

    await expect(retriever.search('合同条款', ['base'])).resolves.toMatchObject({
      kind: 'results', strategy: 'trigram', evidence: expect.any(Array),
    })
    await expect(retriever.search('合同', ['base'])).resolves.toMatchObject({ strategy: 'bounded-instr' })
    await expect(retriever.search('合', ['base'])).resolves.toEqual({ kind: 'query-too-short' })
    const results = await retriever.search('合同条款', ['base'])
    if (results.kind !== 'results') throw new Error('Expected search results')
    expect(results.evidence).toHaveLength(8)
    expect(results.evidence.every(item => item.versionId === 'ready')).toBe(true)
    await expect(retriever.search('" OR *', ['base'])).resolves.toEqual(expect.anything())
  })

  it('limits the selected ready scope before applying the two-character instr predicate', async () => {
    const memory = memoryKnowledgeStore()
    seedSearchable(memory)
    const db = memory.database
    for (let index = 9; index < 250; index += 1) {
      const text = index === 220 ? '命中合同' : `普通内容${index}`
      const block = `large-block-${index}`
      db.prepare(`INSERT INTO knowledge_blocks(id, version_id, ordinal, kind, text, coordinates_json)
        VALUES (?, 'ready', ?, 'txt', ?, '{"kind":"txt","lineStart":1,"lineEnd":1,"charStart":0,"charEnd":4}')`)
        .run(block, index, text)
      db.prepare(`INSERT INTO kb_chunks(id, knowledge_base_id, document_id, version_id, block_id, ordinal, body, coordinates_json)
        VALUES (?, 'base', 'doc', 'ready', ?, ?, ?, '{"kind":"txt","lineStart":1,"lineEnd":1,"charStart":0,"charEnd":4}')`)
        .run(`large-chunk-${index}`, block, index, text)
    }

    await expect(new LocalKnowledgeRetriever(db).search('命中', ['base'])).resolves.toEqual({
      kind: 'results', strategy: 'bounded-instr', evidence: [],
    })
  })

  it('matches a Chinese field question after removing its interrogative suffix', async () => {
    const memory = memoryKnowledgeStore()
    seedSearchable(memory)
    memory.database.prepare(`
      UPDATE kb_chunks
      SET body = '班级：KA-001班'
      WHERE id = 'chunk-0'
    `).run()

    const result = await new LocalKnowledgeRetriever(memory.database)
      .search('班级名称是？', ['base'])

    expect(result).toMatchObject({
      kind: 'results',
      strategy: 'bounded-instr',
      evidence: [expect.objectContaining({ snippet: '班级：KA-001班' })],
    })
  })

  it('matches a two-character Chinese section question after removing its suffix', async () => {
    const memory = memoryKnowledgeStore()
    seedSearchable(memory)
    memory.database.prepare(`
      UPDATE kb_chunks
      SET body = '班规：\n1. 不准迟到\n2. 不准早退\n3. 不准逃课'
      WHERE id = 'chunk-0'
    `).run()

    const result = await new LocalKnowledgeRetriever(memory.database)
      .search('班规是？', ['base'])

    expect(result).toMatchObject({
      kind: 'results',
      strategy: 'bounded-instr',
      evidence: [expect.objectContaining({
        snippet: expect.stringContaining('1. 不准迟到'),
      })],
    })
  })

  it('centres the provider snippet on the actual lexical match in a long chunk', async () => {
    const memory = memoryKnowledgeStore()
    seedSearchable(memory)
    const answer = '核心验收日期为 2028-06-30'
    memory.database.prepare(`
      UPDATE kb_chunks SET body = ? WHERE id = 'chunk-0'
    `).run(`${'无关背景'.repeat(1_200)}${answer}${'附录'.repeat(400)}`)

    const result = await new LocalKnowledgeRetriever(memory.database)
      .search('核心验收日期', ['base'])

    expect(result).toMatchObject({
      kind: 'results',
      evidence: [expect.objectContaining({ snippet: expect.stringContaining(answer) })],
    })
  })

  it('recalls a semantic paraphrase through the local embedding index and hybrid fusion', async () => {
    const memory = memoryKnowledgeStore()
    seedSearchable(memory)
    memory.database.prepare("UPDATE kb_chunks SET body = '班级名称：高一三班' WHERE id = 'chunk-0'").run()
    const embedder: LocalTextEmbedder = {
      model: 'test-local-embedding',
      dimensions: 2,
      available: () => true,
      dispose: async () => undefined,
      embed: async texts => texts.map(text => (
        /(?:班级名称|班叫什么)/u.test(text)
          ? Float32Array.from([1, 0])
          : Float32Array.from([0, 1])
      )),
    }
    const semantic = new LocalSemanticIndex(memory.database, embedder)

    const result = await new LocalKnowledgeRetriever(memory.database, semantic)
      .search('这个班叫什么？', ['base'])

    expect(result.kind).toBe('results')
    if (result.kind !== 'results') throw new Error('Expected search results')
    expect(result.strategy).toBe('hybrid')
    expect(result.evidence[0]).toMatchObject({
      id: 'evidence:chunk-0',
      snippet: expect.stringContaining('高一三班'),
    })
    expect(memory.database.prepare(
      "SELECT count(*) AS count FROM kb_chunk_embeddings WHERE model = 'test-local-embedding'",
    ).get()).toEqual({ count: 8 })
  })

  it('keeps lexical retrieval available when the local embedding model cannot load', async () => {
    const memory = memoryKnowledgeStore()
    seedSearchable(memory)
    const embed = vi.fn(async () => { throw new Error('model unavailable') })
    const embedder: LocalTextEmbedder = {
      model: 'unavailable-local-embedding',
      dimensions: 2,
      available: () => false,
      dispose: async () => undefined,
      embed,
    }
    const semantic = new LocalSemanticIndex(memory.database, embedder)

    await expect(new LocalKnowledgeRetriever(
      memory.database,
      semantic,
    ).search('合同条款', ['base'])).resolves.toMatchObject({
      kind: 'results', strategy: 'trigram', evidence: expect.any(Array),
    })
    await semantic.drain()
    expect(embed).toHaveBeenCalledTimes(1)
  })

  it('does not persist late embedding results after the index owner is invalidated', async () => {
    const memory = memoryKnowledgeStore()
    seedSearchable(memory)
    const started = deferred<void>()
    const result = deferred<readonly Float32Array[]>()
    const embedder: LocalTextEmbedder = {
      model: 'cancelled-local-embedding',
      dimensions: 2,
      available: () => false,
      dispose: async () => undefined,
      embed: async () => {
        started.resolve()
        return result.promise
      },
    }
    const semantic = new LocalSemanticIndex(memory.database, embedder)

    const indexing = semantic.indexMissing()
    await started.promise
    semantic.invalidate()
    result.resolve(Array.from({ length: 8 }, () => Float32Array.from([1, 0])))

    await expect(indexing).rejects.toThrow('cancelled')
    expect(memory.database.prepare(
      "SELECT count(*) AS count FROM kb_chunk_embeddings WHERE model = 'cancelled-local-embedding'",
    ).get()).toEqual({ count: 0 })
  })
})
