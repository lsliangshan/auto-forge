import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { createLocalKnowledgeService } from '../knowledge-service.js'
import { LocalKnowledgeRetriever } from '../local-retriever.js'
import { memoryKnowledgeStore, parsedText } from '../knowledge-test-support.js'
import { DEFAULT_PARSER_LIMITS } from '../parser-protocol.js'
import { minimalPdf } from '../test-fixtures/document-fixtures.js'
import { parsePdf } from '../../../knowledge-parser/parsers/pdf.js'

function percentile95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? Number.POSITIVE_INFINITY
}

function reportGate(gate: string, metrics: Record<string, number>): void {
  process.stdout.write(`${JSON.stringify({ schema: 'autoforge.knowledge-gate.v1', gate, metrics })}\n`)
}

function seedTenThousandChunks() {
  const memory = memoryKnowledgeStore()
  const db = memory.database
  db.prepare('INSERT INTO knowledge_bases(id, name, created_at, updated_at) VALUES (?, ?, 1, 1)')
    .run('benchmark-base', '基准库')
  db.prepare(`INSERT INTO documents(
    id, knowledge_base_id, name, mime_type, active_version_id, created_at, updated_at,
    lifecycle_status, publication_generation, recycled_at
  ) VALUES ('benchmark-document', 'benchmark-base', '基准.txt', 'text/plain', NULL, 1, 1, 'ready', 1, NULL)`).run()
  db.prepare(`INSERT INTO document_versions(
    id, document_id, version_number, status, content_hash, object_id, created_at, publication_generation
  ) VALUES ('benchmark-version', 'benchmark-document', 1, 'ready', 'hash', '00000000000000000000000000008888', 1, 1)`).run()
  db.prepare("UPDATE documents SET active_version_id = 'benchmark-version' WHERE id = 'benchmark-document'").run()
  const coordinates = '{"kind":"txt","lineStart":1,"lineEnd":1,"charStart":0,"charEnd":32}'
  const insertBlock = db.prepare(`INSERT INTO knowledge_blocks(
    id, version_id, ordinal, kind, text, coordinates_json
  ) VALUES (?, 'benchmark-version', ?, 'txt', ?, ?)`)
  const insertChunk = db.prepare(`INSERT INTO kb_chunks(
    id, knowledge_base_id, document_id, version_id, block_id, ordinal, body, coordinates_json
  ) VALUES (?, 'benchmark-base', 'benchmark-document', 'benchmark-version', ?, ?, ?, ?)`)
  db.transaction(() => {
    for (let index = 0; index < 10_000; index += 1) {
      const id = `benchmark-${index}`
      const body = `知识基准检索条目 ${index.toString().padStart(5, '0')} 仅用于本机性能门禁`
      insertBlock.run(`block-${id}`, index, body, coordinates)
      insertChunk.run(`chunk-${id}`, `block-${id}`, index, body, coordinates)
    }
  })()
  return memory
}

describe.runIf(process.env.AUTOFORGE_KNOWLEDGE_BENCHMARK === '1')('personal knowledge release benchmarks', () => {
  it('keeps 10,000-chunk FTS Recall@8 queries below 300 ms p95', async () => {
    const memory = seedTenThousandChunks()
    const retriever = new LocalKnowledgeRetriever(memory.database)
    const durations: number[] = []
    for (let index = 0; index < 20; index += 1) {
      const start = performance.now()
      const result = await retriever.search('知识基准检索', ['benchmark-base'])
      durations.push(performance.now() - start)
      expect(result).toMatchObject({ kind: 'results', evidence: expect.any(Array) })
    }
    const p95Ms = percentile95(durations)
    expect(p95Ms).toBeLessThanOrEqual(300)
    reportGate('fts-10000', { p95Ms, samples: durations.length, chunks: 10_000 })
  }, 30_000)

  it('acknowledges durable imports below one second p95', async () => {
    const memory = memoryKnowledgeStore()
    let selected = 0
    const service = createLocalKnowledgeService({
      openStore: async () => memory.store,
      selectImportFiles: async () => [{
        name: `benchmark-${selected += 1}.txt`, mimeType: 'text/plain', bytes: Buffer.from('导入确认性能基准'),
      }],
      createParser: () => ({
        parse: async () => {
          await new Promise(resolve => setTimeout(resolve, 10))
          return parsedText('导入确认性能基准')
        },
        terminateAll: async () => undefined,
      }),
      saveExport: async () => undefined,
      isMember: () => true,
    })
    const owner = { userId: 'benchmark-owner' }
    await service.bind(owner.userId)
    const base = await service.create(owner, '性能基准')
    const durations: number[] = []
    for (let index = 0; index < 20; index += 1) {
      const handle = (await service.pickImportFiles(owner))[0]!
      const start = performance.now()
      await service.importDocument(owner, base.id, handle.id)
      durations.push(performance.now() - start)
    }
    const p95Ms = percentile95(durations)
    expect(p95Ms).toBeLessThanOrEqual(1_000)
    reportGate('import-ack', { p95Ms, samples: durations.length })
    service.invalidate()
    await service.drain()
  }, 30_000)

  it('parses a 100-page text-layer PDF below two minutes p95', async () => {
    const source = minimalPdf(Array.from({ length: 100 }, (_, index) => `Page ${index + 1} benchmark text`))
    const durations: number[] = []
    for (let index = 0; index < 3; index += 1) {
      const start = performance.now()
      const document = await parsePdf(new Uint8Array(source), DEFAULT_PARSER_LIMITS)
      durations.push(performance.now() - start)
      expect(document.blocks).toHaveLength(100)
    }
    const p95Ms = percentile95(durations)
    expect(p95Ms).toBeLessThanOrEqual(120_000)
    reportGate('pdf-100-pages', { p95Ms, samples: durations.length, pages: 100 })
  }, 180_000)
})
