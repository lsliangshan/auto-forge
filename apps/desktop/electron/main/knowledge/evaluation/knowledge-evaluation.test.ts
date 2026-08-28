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
import { minimalDocxWithText, minimalPdf } from '../test-fixtures/document-fixtures.js'
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
  process.stdout.write(`${JSON.stringify({ schema: 'autoforge.knowledge-gate.v2', gate, metrics })}\n`)
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
  const insertDocument = db.prepare(`INSERT INTO documents(
    id, knowledge_base_id, name, mime_type, active_version_id, created_at, updated_at,
    lifecycle_status, publication_generation, recycled_at
  ) VALUES (?, 'evaluation-base', ?, 'text/plain', NULL, 1, 1, 'ready', 1, NULL)`)
  const insertVersion = db.prepare(`INSERT INTO document_versions(
    id, document_id, version_number, status, content_hash, object_id, created_at, publication_generation
  ) VALUES (?, ?, 1, 'ready', ?, ?, 1, 1)`)
  const insertBlock = db.prepare(`INSERT INTO knowledge_blocks(
    id, version_id, ordinal, kind, text, coordinates_json
  ) VALUES (?, ?, 0, 'txt', ?, ?)`)
  const insertChunk = db.prepare(`INSERT INTO kb_chunks(
    id, knowledge_base_id, document_id, version_id, block_id, ordinal, body, coordinates_json
  ) VALUES (?, 'evaluation-base', ?, ?, ?, 0, ?, ?)`)
  db.transaction(() => {
    corpus.retrievalDocuments.forEach((item, index) => {
      const versionId = `version-${item.id}`
      const blockId = `block-${item.id}`
      const coordinates = JSON.stringify({
        kind: 'txt', lineStart: index + 1, lineEnd: index + 1, charStart: 0, charEnd: item.body.length,
      })
      insertDocument.run(item.id, `${item.id}.txt`)
      insertVersion.run(versionId, item.id, `hash-${item.id}`, index.toString(16).padStart(32, '0'))
      db.prepare('UPDATE documents SET active_version_id = ? WHERE id = ?').run(versionId, item.id)
      insertBlock.run(blockId, versionId, item.body, coordinates)
      insertChunk.run(`chunk-${item.id}`, item.id, versionId, blockId, item.body, coordinates)
    })
  })()
  return memory
}

describe('personal knowledge release evaluation corpus', () => {
  it('meets citation support, grounding, and no-evidence thresholds on an untouched holdout', () => {
    const unsupportedPositiveIds = corpus.holdout.support.filter(item => validateKnowledgeAnswer(
      `${item.claim}[[kb:evaluation-evidence]]`, [evidence(item.evidence)], 'strict', 1,
    ).kind !== 'valid').map(item => item.id)
    const ungroundedAdversarialIds = corpus.holdout.grounding.filter(item => {
      const result = validateKnowledgeAnswer(
        `${item.claim}[[kb:evaluation-evidence]]`, [evidence(item.evidence)], 'strict', 1,
      )
      return result.kind !== 'insufficient' || result.reason !== 'unsupported-claim'
    }).map(item => item.id)
    const noEvidence = corpus.holdout.noEvidence.filter(claim => {
      const result = validateKnowledgeAnswer(claim, [], 'strict', 1)
      return result.kind === 'insufficient' && result.reason === 'no-evidence'
    }).length

    expect(
      percent(corpus.holdout.support.length - unsupportedPositiveIds.length, corpus.holdout.support.length),
      `citation support misses: ${unsupportedPositiveIds.join(', ')}`,
    ).toBeGreaterThanOrEqual(
      corpus.thresholds.citationSupport,
    )
    expect(
      percent(corpus.holdout.grounding.length - ungroundedAdversarialIds.length, corpus.holdout.grounding.length),
      `grounding misses: ${ungroundedAdversarialIds.join(', ')}`,
    ).toBeGreaterThanOrEqual(
      corpus.thresholds.grounding,
    )
    expect(percent(noEvidence, corpus.holdout.noEvidence.length), 'no evidence').toBeGreaterThanOrEqual(
      corpus.thresholds.noEvidence,
    )
    reportGate('grounding', {
      citationSupport: percent(corpus.holdout.support.length - unsupportedPositiveIds.length, corpus.holdout.support.length),
      grounding: percent(corpus.holdout.grounding.length - ungroundedAdversarialIds.length, corpus.holdout.grounding.length),
      noEvidence: percent(noEvidence, corpus.holdout.noEvidence.length),
      holdout: true,
    })
  })

  it('meets Recall@8 against a real published-ready FTS corpus', async () => {
    const memory = seedRetrievalCorpus()
    const retriever = new LocalKnowledgeRetriever(memory.database)
    const missed: string[] = []
    let queries = 0
    expect(corpus.retrievalDocuments.length).toBeGreaterThan(8)
    for (const item of corpus.retrievalCases) {
      expect(item.queries.length).toBeGreaterThan(1)
      for (const query of item.queries) {
        queries += 1
        const literalMatches = corpus.retrievalDocuments.filter(document => document.body.includes(query))
        expect(literalMatches.length, `query must not be a unique body fingerprint: ${query}`).toBeGreaterThan(1)
        const result = await retriever.search(query, ['evaluation-base'])
        if (
          result.kind !== 'results'
          || !result.evidence.some(value => item.relevantDocumentIds.includes(value.documentId))
        ) missed.push(`${item.id}:${query}`)
      }
    }
    expect(
      percent(queries - missed.length, queries),
      `Recall@8 misses: ${missed.join(', ')}`,
    ).toBeGreaterThanOrEqual(corpus.thresholds.recallAt8)
    reportGate('retrieval', {
      recallAt8: percent(queries - missed.length, queries),
      queries,
      documents: corpus.retrievalDocuments.length,
      minimumDistractors: corpus.retrievalDocuments.length - 1,
    })
  })

  it('parses 100 varied deterministic documents with exact text and coordinates', async () => {
    let passed = 0
    let total = 0
    for (const format of corpus.supportedDocumentMatrix.formats) {
      for (let index = 0; index < corpus.supportedDocumentMatrix.samplesPerFormat; index += 1) {
        const serial = index.toString().padStart(2, '0')
        const heading = `${format.toUpperCase()} section ${serial}`
        const paragraph = `Deterministic content ${serial} has value ${1000 + index}.`
        let parsed
        let expected
        if (format === 'pdf') {
          parsed = await parsePdf(new Uint8Array(minimalPdf([paragraph])), DEFAULT_PARSER_LIMITS)
          expected = {
            mediaType: 'application/pdf', text: paragraph,
            blocks: [{ id: 'page-1', text: paragraph, coordinate: { kind: 'pdf', page: 1, itemStart: 0, itemEnd: 1 } }],
          }
        } else if (format === 'docx') {
          parsed = await parseDocx(minimalDocxWithText(heading, paragraph), DEFAULT_PARSER_LIMITS)
          expected = {
            mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            text: `${heading}\n${paragraph}`,
            blocks: [
              { id: 'p-1', text: heading, coordinate: { kind: 'docx', paragraphId: 'p-1', headingPath: [heading] } },
              { id: 'p-2', text: paragraph, coordinate: { kind: 'docx', paragraphId: 'p-2', headingPath: [heading] } },
            ],
          }
        } else if (format === 'txt') {
          parsed = parseText(Buffer.from(`${heading}\n${paragraph}`))
          expected = {
            mediaType: 'text/plain', text: `${heading}\n${paragraph}`,
            blocks: [
              { id: 'line-1', text: heading, coordinate: { kind: 'txt', lineStart: 1, lineEnd: 1, charStart: 0, charEnd: heading.length } },
              { id: 'line-2', text: paragraph, coordinate: { kind: 'txt', lineStart: 2, lineEnd: 2, charStart: heading.length + 1, charEnd: heading.length + 1 + paragraph.length } },
            ],
          }
        } else if (format === 'markdown') {
          parsed = parseMarkdown(Buffer.from(`# ${heading}\n\n${paragraph}`))
          expected = {
            mediaType: 'text/markdown', text: `${heading}\n${paragraph}`,
            blocks: [
              { id: 'md-1', text: heading, coordinate: { kind: 'markdown', path: [heading], blockIndex: 0 } },
              { id: 'md-2', text: paragraph, coordinate: { kind: 'markdown', path: [heading], blockIndex: 1 } },
            ],
          }
        } else {
          parsed = parseHtml(Buffer.from(`<main><h1>${heading}</h1><p>${paragraph}</p></main>`))
          expected = {
            mediaType: 'text/html', text: `${heading}\n${paragraph}`,
            blocks: [
              { id: 'html-1', text: heading, coordinate: { kind: 'html', path: [heading], blockIndex: 0 } },
              { id: 'html-2', text: paragraph, coordinate: { kind: 'html', path: [heading], blockIndex: 1 } },
            ],
          }
        }
        total += 1
        expect(parsed, `${format}-${serial}`).toEqual(expected)
        passed += 1
      }
    }
    expect(total).toBe(100)
    expect(percent(passed, total)).toBeGreaterThanOrEqual(corpus.thresholds.supportedDocumentSuccess)
    reportGate('supported-documents', {
      success: percent(passed, total), samples: total, formats: corpus.supportedDocumentMatrix.formats.length,
      exactTextAndCoordinates: true,
    })
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
