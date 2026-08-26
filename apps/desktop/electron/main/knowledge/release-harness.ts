import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SafeStoragePort } from '../security/secret-store.js'
import { openUserKnowledgeDatabase } from './encrypted-database.js'
import {
  evaluateGroundingCases,
  evaluateProcessingCases,
  evaluateRetrievalCases,
  percentile,
} from './release-evaluation.js'
import { LocalKnowledgeRetriever } from './local-retriever.js'
import { DEFAULT_PARSER_LIMITS, type ParserFormat } from './parser-protocol.js'
import { parseDocument } from './parsers/document-parsers.js'

interface LocalHarnessOptions {
  readonly rootDirectory: string
  readonly safeStorage: SafeStoragePort
}

const require = createRequire(import.meta.url)

function minimalPdf(value: string): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td (${value}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ]
  let body = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(body)
}

async function processingCases() {
  const mammothEntry = require.resolve('mammoth')
  const docx = await readFile(join(dirname(mammothEntry), '../test/test-data/single-paragraph.docx'))
  const inputs: Array<{ id: string; format: ParserFormat; bytes: Uint8Array }> = [
    { id: 'txt', format: 'txt', bytes: new TextEncoder().encode('Synthetic text.') },
    { id: 'markdown', format: 'markdown', bytes: new TextEncoder().encode('# Synthetic\n\nContent.') },
    { id: 'html', format: 'html', bytes: new TextEncoder().encode('<h1>Synthetic</h1><p>Content.</p>') },
    { id: 'pdf', format: 'pdf', bytes: minimalPdf('Synthetic PDF') },
    { id: 'docx', format: 'docx', bytes: Uint8Array.from(docx) },
  ]
  return Promise.all(inputs.map(async ({ id, format, bytes }) => {
    try {
      const parsed = await parseDocument(format, bytes, DEFAULT_PARSER_LIMITS)
      return { id, supported: true, ready: parsed.blocks.length > 0 }
    } catch {
      return { id, supported: true, ready: false }
    }
  }))
}

async function filesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? filesBelow(path) : [path]
  }))
  return nested.flat()
}

async function countArtifactMatches(directory: string, value: Buffer): Promise<number> {
  let count = 0
  for (const path of await filesBelow(directory)) {
    if ((await readFile(path)).includes(value)) count += 1
  }
  return count
}

export async function runLocalKnowledgeReleaseHarness(options: LocalHarnessOptions) {
  const owner = await openUserKnowledgeDatabase({
    rootDirectory: options.rootDirectory,
    userId: 'synthetic_owner_a',
    safeStorage: options.safeStorage,
  })
  const other = await openUserKnowledgeDatabase({
    rootDirectory: options.rootDirectory,
    userId: 'synthetic_owner_b',
    safeStorage: options.safeStorage,
  })
  const artifactProbe = randomBytes(32).toString('hex')
  try {
    owner.database.exec(`
      INSERT INTO knowledge_bases (id, name, created_at, updated_at)
      VALUES ('base', 'Synthetic', 1, 1);
      INSERT INTO documents (
        id, knowledge_base_id, name, mime_type, active_version_id, status, created_at, updated_at
      ) VALUES ('document', 'base', 'fixture.bin', 'text/plain', NULL, 'ready', 1, 1);
      INSERT INTO document_versions (
        id, document_id, version_number, status, content_hash, created_at
      ) VALUES ('version', 'document', 1, 'ready', 'synthetic', 1);
      UPDATE documents SET active_version_id = 'version' WHERE id = 'document';
    `)
    const insertBlock = owner.database.prepare(`
      INSERT INTO knowledge_blocks (id, version_id, ordinal, kind, text, coordinates_json)
      VALUES (?, 'version', ?, 'txt', ?, ?)
    `)
    const insertChunk = owner.database.prepare(`
      INSERT INTO kb_chunks (
        id, knowledge_base_id, document_id, version_id, block_id, ordinal, body, coordinates_json
      ) VALUES (?, 'base', 'document', 'version', ?, ?, ?, ?)
    `)
    owner.database.transaction(() => {
      for (let index = 0; index < 10_000; index += 1) {
        const id = String(index).padStart(5, '0')
        const blockId = `block_${id}`
        const body = `fixture token${id} item${id}${index === 9_999 ? ` ${artifactProbe}` : ''}`
        const coordinates = JSON.stringify({
          kind: 'txt', lineStart: index + 1, lineEnd: index + 1,
          charStart: 0, charEnd: body.length,
        })
        insertBlock.run(blockId, index, body, coordinates)
        insertChunk.run(`evidence_${id}`, blockId, index, body, coordinates)
      }
    })()

    const retriever = new LocalKnowledgeRetriever(owner.database)
    const retrievalCases = Array.from({ length: 20 }, (_, index) => {
      const id = String(index * 499).padStart(5, '0')
      return { id: `case_${index}`, query: `token${id}`, expectedEvidenceIds: [`evidence_${id}`] }
    })
    const retrieval = await evaluateRetrievalCases(retrievalCases, async query => (
      await retriever.search(['base'], query)
    ).results)

    const timings: number[] = []
    for (let index = 0; index < 40; index += 1) {
      const id = String((index * 251) % 10_000).padStart(5, '0')
      const started = performance.now()
      await retriever.search(['base'], `token${id}`)
      timings.push(performance.now() - started)
    }

    const otherRetriever = new LocalKnowledgeRetriever(other.database)
    const crossUserLeakCount = (await otherRetriever.search(['base'], 'token00000')).results.length
    const plaintextBeforeCheckpoint = await countArtifactMatches(
      options.rootDirectory,
      Buffer.from(artifactProbe),
    )
    owner.database.pragma('wal_checkpoint(TRUNCATE)')
    const plaintextAfterCheckpoint = await countArtifactMatches(
      options.rootDirectory,
      Buffer.from(artifactProbe),
    )

    const grounding = evaluateGroundingCases([
      {
        id: 'grounded', expectedEvidence: true,
        evidence: [{ id: 'evidence', text: 'Synthetic evidence is available.' }],
        outcome: 'answered' as const,
        claims: [{ text: 'Synthetic evidence is available.', citationIds: ['evidence'] }],
      },
      {
        id: 'no_evidence', expectedEvidence: false, evidence: [],
        outcome: 'refused' as const, claims: [],
      },
    ])
    const processing = evaluateProcessingCases(await processingCases())

    return {
      fixtureClass: 'synthetic_local' as const,
      officialAcceptanceEligible: false as const,
      security: {
        encryptedArtifactPlaintextMatches: plaintextBeforeCheckpoint + plaintextAfterCheckpoint,
        crossUserLeakCount,
      },
      retrieval,
      grounding,
      processing,
      performance: {
        chunkCount: 10_000,
        sampleCount: timings.length,
        localFtsP95Ms: percentile(timings, 0.95),
      },
    }
  } finally {
    owner.close()
    other.close()
  }
}
