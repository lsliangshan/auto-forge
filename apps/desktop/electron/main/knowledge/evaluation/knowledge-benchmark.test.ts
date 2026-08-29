import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import type { SafeStoragePort } from '../../security/secret-store.js'
import { KnowledgeStoreFactory, type KnowledgeStore } from '../encrypted-database.js'
import { createLocalKnowledgeService } from '../knowledge-service.js'
import { LocalKnowledgeRetriever } from '../local-retriever.js'

function percentile95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? Number.POSITIVE_INFINITY
}

function reportGate(gate: string, metrics: Record<string, number | string | boolean>): void {
  process.stdout.write(`${JSON.stringify({ schema: 'autoforge.knowledge-gate.v2', gate, metrics })}\n`)
}

function safeStorage(): SafeStoragePort {
  const mask = Buffer.from('c426810d7a6e086d2892111c6f574406', 'hex')
  return {
    isAvailable: async () => true,
    encrypt: async value => Buffer.from(Buffer.from(value).map((byte, index) => byte ^ mask[index % mask.length]!)),
    decrypt: async value => ({
      value: Buffer.from(value.map((byte, index) => byte ^ mask[index % mask.length]!)).toString(),
      shouldReEncrypt: false,
    }),
  }
}

function seedTenThousandChunks(store: KnowledgeStore): void {
  const db = store.database
  db.prepare('INSERT INTO knowledge_bases(id, name, created_at, updated_at) VALUES (?, ?, 1, 1)')
    .run('benchmark-base', '加密磁盘基准库')
  const insertDocument = db.prepare(`INSERT INTO documents(
    id, knowledge_base_id, name, mime_type, active_version_id, created_at, updated_at,
    lifecycle_status, publication_generation, recycled_at
  ) VALUES (?, 'benchmark-base', ?, 'text/plain', NULL, 1, 1, 'ready', 1, NULL)`)
  const insertVersion = db.prepare(`INSERT INTO document_versions(
    id, document_id, version_number, status, content_hash, object_id, created_at, publication_generation
  ) VALUES (?, ?, 1, 'ready', ?, ?, 1, 1)`)
  const insertBlock = db.prepare(`INSERT INTO knowledge_blocks(
    id, version_id, ordinal, kind, text, coordinates_json
  ) VALUES (?, ?, 0, 'txt', ?, ?)`)
  const insertChunk = db.prepare(`INSERT INTO kb_chunks(
    id, knowledge_base_id, document_id, version_id, block_id, ordinal, body, coordinates_json
  ) VALUES (?, 'benchmark-base', ?, ?, ?, 0, ?, ?)`)
  db.transaction(() => {
    for (let index = 0; index < 10_000; index += 1) {
      const id = `benchmark-${index.toString().padStart(5, '0')}`
      const documentId = `document-${id}`
      const versionId = `version-${id}`
      const blockId = `block-${id}`
      const category = index % 20
      const body = `离线知识性能资料 类别${category.toString().padStart(2, '0')} 共同检索主题 本地加密索引 条目${index.toString().padStart(5, '0')}`
      const coordinate = JSON.stringify({
        kind: 'txt', lineStart: 1, lineEnd: 1, charStart: 0, charEnd: body.length,
      })
      insertDocument.run(documentId, `${id}.txt`)
      insertVersion.run(versionId, documentId, `hash-${id}`, index.toString(16).padStart(32, '0'))
      db.prepare('UPDATE documents SET active_version_id = ? WHERE id = ?').run(versionId, documentId)
      insertBlock.run(blockId, versionId, body, coordinate)
      insertChunk.run(`chunk-${id}`, documentId, versionId, blockId, body, coordinate)
    }
  })()
  db.pragma('wal_checkpoint(TRUNCATE)')
}

describe.runIf(process.env.AUTOFORGE_KNOWLEDGE_BENCHMARK === '1')('personal knowledge release benchmarks', () => {
  it('keeps encrypted on-disk 10,000-chunk FTS queries below 300 ms p95 across cold and warm samples', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-knowledge-fts-benchmark-'))
    const factory = new KnowledgeStoreFactory(root, safeStorage())
    let store = await factory.open('fts-owner')
    try {
      seedTenThousandChunks(store)
      await store.close()
      const queries = Array.from({ length: 20 }, (_, index) => `类别${index.toString().padStart(2, '0')} 共同检索主题`)
      const cold: number[] = []
      const warm: number[] = []
      for (let index = 0; index < 12; index += 1) {
        store = await factory.open('fts-owner')
        const retriever = new LocalKnowledgeRetriever(store.database)
        const start = performance.now()
        const result = await retriever.search(queries[index % queries.length]!, ['benchmark-base'])
        cold.push(performance.now() - start)
        expect(result.kind === 'results' && result.evidence.length > 0).toBe(true)
        await store.close()
      }
      store = await factory.open('fts-owner')
      const retriever = new LocalKnowledgeRetriever(store.database)
      for (let index = 0; index < 60; index += 1) {
        const start = performance.now()
        const result = await retriever.search(queries[index % queries.length]!, ['benchmark-base'])
        warm.push(performance.now() - start)
        expect(result.kind === 'results' && result.evidence.length > 0).toBe(true)
      }
      const p95Ms = percentile95([...cold, ...warm])
      expect(p95Ms).toBeLessThanOrEqual(300)
      reportGate('fts-10000-encrypted-disk', {
        p95Ms, coldP95Ms: percentile95(cold), warmP95Ms: percentile95(warm),
        samples: cold.length + warm.length, coldSamples: cold.length, warmSamples: warm.length,
        queries: queries.length, chunks: 10_000, encryptedOnDisk: true,
      })
    } finally {
      await store.close().catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('acknowledges imports after a FULL-synchronous durable SQLite commit while the parser remains held', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-knowledge-ack-benchmark-'))
    const factory = new KnowledgeStoreFactory(root, safeStorage())
    let selected = 0
    let releaseParser!: () => void
    const parserGate = new Promise<void>(resolve => { releaseParser = resolve })
    let store: KnowledgeStore | undefined
    const service = createLocalKnowledgeService({
      openStore: async ownerId => {
        store = await factory.open(ownerId)
        store.database.pragma('synchronous = FULL')
        return store
      },
      selectImportFiles: async () => [{
        name: `durable-${selected += 1}-${randomBytes(4).toString('hex')}.txt`,
        mimeType: 'text/plain',
        bytes: Buffer.from(`durable encrypted import ${selected}`),
      }],
      createParser: () => ({
        parse: async () => {
          await parserGate
          throw new Error('benchmark parser was intentionally held')
        },
        terminateAll: async () => undefined,
      }),
      saveExport: async () => undefined,
      isMember: () => true,
    })
    const owner = { userId: 'ack-owner' }
    try {
      await service.bind(owner.userId)
      const base = await service.create(owner, '持久提交基准')
      const durations: number[] = []
      for (let index = 0; index < 40; index += 1) {
        const handle = (await service.pickImportFiles(owner))[0]!
        const start = performance.now()
        const document = await service.importDocument(owner, base.id, handle.id)
        durations.push(performance.now() - start)
        expect(document?.status).toBe('queued')
        const durable = store!.database.prepare(`
          SELECT job.status, version.object_id FROM knowledge_import_jobs AS job
          JOIN document_versions AS version ON version.id = job.version_id
          WHERE job.document_id = ?
        `).get(document!.id) as { status: string; object_id: string } | undefined
        expect(durable).toMatchObject({ status: expect.stringMatching(/queued|running/u) })
        expect(durable?.object_id).toMatch(/^[0-9a-f]{32}$/u)
      }
      const p95Ms = percentile95(durations)
      expect(store!.database.pragma('synchronous', { simple: true })).toBe(2)
      expect(p95Ms).toBeLessThanOrEqual(1_000)
      reportGate('import-ack-encrypted-durable', {
        p95Ms, samples: durations.length, synchronous: 'FULL', durableJobs: durations.length,
        encryptedObjectStore: true, parserHeld: true,
      })
    } finally {
      releaseParser()
      service.invalidate()
      await service.drain().catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
