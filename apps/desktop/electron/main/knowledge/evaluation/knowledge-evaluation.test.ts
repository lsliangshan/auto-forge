import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { KnowledgeEvidence } from '@autoforge/shared'
import type { SafeStoragePort } from '../../security/secret-store.js'
import corpus from './corpus.json' with { type: 'json' }
import { validateKnowledgeAnswer } from '../../agent/knowledge-evidence.js'
import { KnowledgeStoreFactory } from '../encrypted-database.js'
import { LocalKnowledgeRetriever } from '../local-retriever.js'
import { memoryKnowledgeStore } from '../knowledge-test-support.js'
import { DEFAULT_PARSER_LIMITS } from '../parser-protocol.js'
import { minimalDocx, minimalPdf } from '../test-fixtures/document-fixtures.js'
import { parseDocx } from '../../../knowledge-parser/parsers/docx.js'
import { parseHtml } from '../../../knowledge-parser/parsers/html.js'
import { parseMarkdown } from '../../../knowledge-parser/parsers/markdown.js'
import { parsePdf } from '../../../knowledge-parser/parsers/pdf.js'
import { parseText } from '../../../knowledge-parser/parsers/text.js'

function evidence(snippet: string): KnowledgeEvidence {
  return {
    id: 'evaluation-evidence',
    baseId: 'evaluation-base',
    documentId: 'evaluation-document',
    versionId: 'evaluation-version',
    snippet,
    score: 1,
    citation: {
      evidenceId: 'evaluation-evidence',
      documentId: 'evaluation-document',
      versionId: 'evaluation-version',
      coordinate: { kind: 'text', line: 1, startOffset: 0, endOffset: snippet.length },
    },
  }
}

function percent(passed: number, total: number): number {
  return total === 0 ? 0 : passed / total
}

function reportGate(gate: string, metrics: Record<string, number | boolean>): void {
  process.stdout.write(`${JSON.stringify({ schema: 'autoforge.knowledge-gate.v1', gate, metrics })}\n`)
}

function artifactFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? artifactFiles(path) : [path]
  })
}

function safeStorage(): SafeStoragePort {
  const mask = Buffer.from('7e4726c66a97c1c1641466c5a932e80f', 'hex')
  return {
    isAvailable: async () => true,
    encrypt: async value => Buffer.from(Buffer.from(value).map((byte, index) => byte ^ mask[index % mask.length]!)),
    decrypt: async value => ({
      value: Buffer.from(value.map((byte, index) => byte ^ mask[index % mask.length]!)).toString(),
      shouldReEncrypt: false,
    }),
  }
}

function seedRetrievalCorpus(): ReturnType<typeof memoryKnowledgeStore> {
  const memory = memoryKnowledgeStore()
  const db = memory.database
  db.prepare('INSERT INTO knowledge_bases(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('evaluation-base', '评估库', 1, 1)
  db.prepare(`INSERT INTO documents(
    id, knowledge_base_id, name, mime_type, active_version_id, created_at, updated_at,
    lifecycle_status, publication_generation, recycled_at
  ) VALUES ('evaluation-document', 'evaluation-base', '评估.txt', 'text/plain', NULL, 1, 1, 'ready', 1, NULL)`).run()
  db.prepare(`INSERT INTO document_versions(
    id, document_id, version_number, status, content_hash, object_id, created_at, publication_generation
  ) VALUES ('evaluation-version', 'evaluation-document', 1, 'ready', 'hash', '00000000000000000000000000009999', 1, 1)`).run()
  db.prepare("UPDATE documents SET active_version_id = 'evaluation-version' WHERE id = 'evaluation-document'").run()
  const insertBlock = db.prepare(`INSERT INTO knowledge_blocks(
    id, version_id, ordinal, kind, text, coordinates_json
  ) VALUES (?, 'evaluation-version', ?, 'txt', ?, ?)`)
  const insertChunk = db.prepare(`INSERT INTO kb_chunks(
    id, knowledge_base_id, document_id, version_id, block_id, ordinal, body, coordinates_json
  ) VALUES (?, 'evaluation-base', 'evaluation-document', 'evaluation-version', ?, ?, ?, ?)`)
  db.transaction(() => {
    corpus.retrievalCases.forEach((item, index) => {
      const coordinates = JSON.stringify({
        kind: 'txt', lineStart: index + 1, lineEnd: index + 1, charStart: 0, charEnd: item.body.length,
      })
      insertBlock.run(`block-${item.id}`, index, item.body, coordinates)
      insertChunk.run(`chunk-${item.id}`, `block-${item.id}`, index, item.body, coordinates)
    })
  })()
  return memory
}

describe('personal knowledge release evaluation corpus', () => {
  it('meets citation support, grounding, and no-evidence thresholds on independent literal cases', () => {
    const unsupportedPositiveIds = corpus.supportCases.filter(item => validateKnowledgeAnswer(
      `${item.claim}[[kb:evaluation-evidence]]`, [evidence(item.evidence)], 'strict', 1,
    ).kind !== 'valid').map(item => item.id)
    const ungroundedAdversarialIds = corpus.groundingCases.filter(item => {
      const result = validateKnowledgeAnswer(
        `${item.claim}[[kb:evaluation-evidence]]`, [evidence(item.evidence)], 'strict', 1,
      )
      return result.kind !== 'insufficient' || result.reason !== 'unsupported-claim'
    }).map(item => item.id)
    const noEvidence = corpus.noEvidenceCases.filter(claim => {
      const result = validateKnowledgeAnswer(claim, [], 'strict', 1)
      return result.kind === 'insufficient' && result.reason === 'no-evidence'
    }).length

    expect(
      percent(corpus.supportCases.length - unsupportedPositiveIds.length, corpus.supportCases.length),
      `citation support misses: ${unsupportedPositiveIds.join(', ')}`,
    ).toBeGreaterThanOrEqual(
      corpus.thresholds.citationSupport,
    )
    expect(
      percent(corpus.groundingCases.length - ungroundedAdversarialIds.length, corpus.groundingCases.length),
      `grounding misses: ${ungroundedAdversarialIds.join(', ')}`,
    ).toBeGreaterThanOrEqual(
      corpus.thresholds.grounding,
    )
    expect(percent(noEvidence, corpus.noEvidenceCases.length), 'no evidence').toBeGreaterThanOrEqual(
      corpus.thresholds.noEvidence,
    )
    reportGate('grounding', {
      citationSupport: percent(corpus.supportCases.length - unsupportedPositiveIds.length, corpus.supportCases.length),
      grounding: percent(corpus.groundingCases.length - ungroundedAdversarialIds.length, corpus.groundingCases.length),
      noEvidence: percent(noEvidence, corpus.noEvidenceCases.length),
    })
  })

  it('meets Recall@8 against a real published-ready FTS corpus', async () => {
    const memory = seedRetrievalCorpus()
    const retriever = new LocalKnowledgeRetriever(memory.database)
    const missed: string[] = []
    for (const item of corpus.retrievalCases) {
      const result = await retriever.search(item.query, ['evaluation-base'])
      if (result.kind !== 'results' || !result.evidence.some(value => value.snippet === item.body)) missed.push(item.id)
    }
    expect(
      percent(corpus.retrievalCases.length - missed.length, corpus.retrievalCases.length),
      `Recall@8 misses: ${missed.join(', ')}`,
    ).toBeGreaterThanOrEqual(corpus.thresholds.recallAt8)
    reportGate('retrieval', {
      recallAt8: percent(corpus.retrievalCases.length - missed.length, corpus.retrievalCases.length),
    })
  })

  it('parses at least 99% of a deterministic 100-document supported-format matrix', async () => {
    let passed = 0
    let total = 0
    for (const template of corpus.supportedDocumentTemplates) {
      for (let index = 0; index < corpus.samplesPerDocumentTemplate; index += 1) {
        const marker = `supported-${template.label}-${index}`
        let text: string
        if (template.mediaType === 'application/pdf') {
          text = (await parsePdf(new Uint8Array(minimalPdf([marker])), DEFAULT_PARSER_LIMITS)).text
        } else if (template.mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
          text = (await parseDocx(minimalDocx(index), DEFAULT_PARSER_LIMITS)).text
        } else if (template.mediaType === 'text/plain') {
          text = parseText(Buffer.from(marker)).text
        } else if (template.mediaType === 'text/markdown') {
          text = parseMarkdown(Buffer.from(`# ${marker}\n\nbody`)).text
        } else {
          text = parseHtml(Buffer.from(`<h1>${marker}</h1><p>body</p>`)).text
        }
        total += 1
        if (text.length > 0) passed += 1
      }
    }
    expect(total).toBe(100)
    expect(percent(passed, total)).toBeGreaterThanOrEqual(corpus.thresholds.supportedDocumentSuccess)
    reportGate('supported-documents', { success: percent(passed, total), samples: total })
  }, 30_000)

  it('keeps cross-owner rows, objects, and persisted encrypted artifacts at zero plaintext leakage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-knowledge-evaluation-'))
    const aliceSentinel = `ALICE-${randomBytes(18).toString('hex')}-私有知识`
    const bobSentinel = `BOB-${randomBytes(18).toString('hex')}-私有知识`
    try {
      const factory = new KnowledgeStoreFactory(root, safeStorage())
      const alice = await factory.open('evaluation-alice')
      const bob = await factory.open('evaluation-bob')
      alice.database.prepare(
        'INSERT INTO knowledge_bases(id, name, created_at, updated_at) VALUES (?, ?, 1, 1)',
      ).run('alice-base', aliceSentinel)
      bob.database.prepare(
        'INSERT INTO knowledge_bases(id, name, created_at, updated_at) VALUES (?, ?, 1, 1)',
      ).run('bob-base', bobSentinel)
      const aliceObject = await alice.objects.put(Buffer.from(aliceSentinel))
      const bobObject = await bob.objects.put(Buffer.from(bobSentinel))

      expect(alice.database.prepare('SELECT name FROM knowledge_bases').all()).toEqual([{ name: aliceSentinel }])
      expect(bob.database.prepare('SELECT name FROM knowledge_bases').all()).toEqual([{ name: bobSentinel }])
      await expect(bob.objects.read(aliceObject.objectId)).rejects.toThrow()
      await expect(alice.objects.read(bobObject.objectId)).rejects.toThrow()

      alice.database.pragma('wal_checkpoint(TRUNCATE)')
      bob.database.pragma('wal_checkpoint(TRUNCATE)')
      await alice.close()
      await bob.close()
      const persisted = artifactFiles(root).map(path => readFileSync(path))
      expect(persisted.some(bytes => bytes.includes(Buffer.from(aliceSentinel)))).toBe(false)
      expect(persisted.some(bytes => bytes.includes(Buffer.from(bobSentinel)))).toBe(false)
      reportGate('owner-artifact-isolation', { crossOwnerLeaks: 0, plaintextArtifactLeaks: 0 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
