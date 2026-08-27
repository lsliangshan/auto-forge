import type Database from 'better-sqlite3'
import type { KnowledgeEvidence, KnowledgeSearchResult } from '@autoforge/shared'

const MAX_RESULTS = 8
const MAX_TWO_CHARACTER_CANDIDATES = 200

interface ChunkRow {
  id: string
  knowledge_base_id: string
  document_id: string
  version_id: string
  body: string
  coordinates_json: string
}

function searchResult(
  rows: ChunkRow[],
  strategy: Extract<KnowledgeSearchResult, { kind: 'results' }>['strategy'],
): KnowledgeSearchResult {
  const evidence = rows.map((row, index): KnowledgeEvidence => {
    const parsed = JSON.parse(row.coordinates_json) as Record<string, unknown>
    const coordinate: KnowledgeEvidence['citation']['coordinate'] = parsed.kind === 'pdf'
      ? {
          kind: 'pdf', page: Number(parsed.page), startOffset: Number(parsed.itemStart), endOffset: Number(parsed.itemEnd),
        }
      : parsed.kind === 'docx'
        ? {
            kind: 'docx', headingPath: Array.isArray(parsed.headingPath) ? parsed.headingPath.map(String) : [],
            paragraph: Math.max(0, Number(String(parsed.paragraphId ?? 'p-1').replace(/^p-/, '')) - 1),
          }
        : parsed.kind === 'txt'
          ? {
              kind: 'text', line: Number(parsed.lineStart), startOffset: Number(parsed.charStart), endOffset: Number(parsed.charEnd),
            }
          : {
              kind: 'html', structuralPath: Array.isArray(parsed.path) && parsed.path.length > 0
                ? parsed.path.map(String).join(' > ')
                : 'document',
            }
    const id = `evidence:${row.id}`
    return {
      id,
      baseId: row.knowledge_base_id,
      documentId: row.document_id,
      versionId: row.version_id,
      snippet: row.body.slice(0, 4_000),
      score: Math.max(0, 1 - index / Math.max(rows.length, 1)),
      citation: {
        evidenceId: id,
        documentId: row.document_id,
        versionId: row.version_id,
        coordinate,
      },
    }
  })
  return { kind: 'results', strategy, evidence }
}

function selectedScope(baseIds: readonly string[]): { clause: string; values: string[] } {
  const values = [...new Set(baseIds)]
  if (values.length === 0 || values.length > 32 || values.some(id => !id || id.length > 512)) {
    throw new Error('Invalid local knowledge scope')
  }
  return { clause: values.map(() => '?').join(', '), values }
}

export class LocalKnowledgeRetriever {
  constructor(private readonly database: Database.Database) {}

  async search(
    query: string,
    baseIds: readonly string[],
    documentIds?: readonly string[],
  ): Promise<KnowledgeSearchResult> {
    const normalized = query.normalize('NFC').trim()
    const length = Array.from(normalized).length
    if (length < 2) return { kind: 'query-too-short' }
    const scope = selectedScope(baseIds)
    const documentScope = documentIds === undefined ? undefined : selectedScope(documentIds)
    const documentPredicate = documentScope
      ? `AND chunk.document_id IN (${documentScope.clause})`
      : ''
    const selected = `
      SELECT chunk.id, chunk.knowledge_base_id, chunk.document_id, chunk.version_id,
             chunk.body, chunk.coordinates_json, chunk.ordinal
      FROM kb_chunks AS chunk
      JOIN documents AS document
        ON document.id = chunk.document_id
       AND document.knowledge_base_id = chunk.knowledge_base_id
      JOIN knowledge_bases AS base ON base.id = chunk.knowledge_base_id
      JOIN document_versions AS version
        ON version.id = chunk.version_id
       AND version.document_id = chunk.document_id
      WHERE chunk.knowledge_base_id IN (${scope.clause})
        AND base.recycled_at IS NULL
        AND document.recycled_at IS NULL
        AND document.active_version_id = chunk.version_id
        AND version.status = 'ready'
        ${documentPredicate}
    `
    if (length === 2) {
      const rows = this.database.prepare(`
        WITH candidate AS MATERIALIZED (
          ${selected}
          ORDER BY chunk.version_id, chunk.ordinal
          LIMIT ${MAX_TWO_CHARACTER_CANDIDATES}
        )
        SELECT id, knowledge_base_id, document_id, version_id, body, coordinates_json
        FROM candidate
        WHERE instr(body, ?) > 0
        ORDER BY version_id, ordinal
        LIMIT ${MAX_RESULTS}
      `).all(...scope.values, ...(documentScope?.values ?? []), normalized) as ChunkRow[]
      return searchResult(rows, 'bounded-instr')
    }

    const literal = `"${normalized.replaceAll('"', '""')}"`
    const rows = this.database.prepare(`
      SELECT chunk.id, chunk.knowledge_base_id, chunk.document_id, chunk.version_id,
             chunk.body, chunk.coordinates_json
      FROM kb_chunks_fts AS search
      JOIN kb_chunks AS chunk ON chunk.rowid = search.rowid
      JOIN documents AS document
        ON document.id = chunk.document_id
       AND document.knowledge_base_id = chunk.knowledge_base_id
      JOIN knowledge_bases AS base ON base.id = chunk.knowledge_base_id
      JOIN document_versions AS version
        ON version.id = chunk.version_id
       AND version.document_id = chunk.document_id
      WHERE kb_chunks_fts MATCH ?
        AND chunk.knowledge_base_id IN (${scope.clause})
        AND base.recycled_at IS NULL
        AND document.recycled_at IS NULL
        AND document.active_version_id = chunk.version_id
        AND version.status = 'ready'
        ${documentPredicate}
      ORDER BY bm25(kb_chunks_fts), chunk.version_id, chunk.ordinal
      LIMIT ${MAX_RESULTS}
    `).all(literal, ...scope.values, ...(documentScope?.values ?? [])) as ChunkRow[]
    return searchResult(rows, 'trigram')
  }
}
