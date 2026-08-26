import type Database from 'better-sqlite3-multiple-ciphers'
import type {
  KnowledgeCitationReference,
  KnowledgeSearchOutcome,
  KnowledgeSearchResult,
} from '@autoforge/shared'

export type LocalKnowledgeSearchOutcome = KnowledgeSearchOutcome

export interface KnowledgeChunkRow {
  id: string
  knowledgeBaseId: string
  documentId: string
  versionId: string
  blockId: string
  body: string
  coordinatesJson: string
}

function literalMatch(query: string): string {
  return `"${query.replaceAll('"', '""')}"`
}

export function citationForKnowledgeChunk(row: KnowledgeChunkRow): KnowledgeCitationReference {
  const coordinate = JSON.parse(row.coordinatesJson) as Record<string, unknown>
  const common = { evidenceId: row.id, documentId: row.documentId, versionId: row.versionId }
  switch (coordinate.kind) {
    case 'pdf': {
      const startOffset = Number(coordinate.itemStart)
      const endOffset = Math.max(Number(coordinate.itemEnd), startOffset + 1)
      return { ...common, kind: 'pdf', page: Number(coordinate.page), startOffset, endOffset }
    }
    case 'docx':
      return {
        ...common,
        kind: 'docx',
        paragraphId: String(coordinate.paragraphId),
        headingPath: Array.isArray(coordinate.headingPath) ? coordinate.headingPath.map(String) : [],
      }
    case 'markdown':
    case 'html':
      return { ...common, kind: coordinate.kind, nodeId: row.blockId }
    case 'txt': {
      const startColumn = Number(coordinate.charStart)
      const endColumn = Math.max(Number(coordinate.charEnd), startColumn + 1)
      return {
        ...common,
        kind: 'txt',
        startLine: Number(coordinate.lineStart),
        endLine: Number(coordinate.lineEnd),
        startColumn,
        endColumn,
      }
    }
    default:
      throw new Error('Knowledge chunk coordinates are invalid')
  }
}

function toResults(rows: KnowledgeChunkRow[]): KnowledgeSearchResult[] {
  return rows.map((row, index) => ({
    evidenceId: row.id,
    knowledgeBaseId: row.knowledgeBaseId,
    documentId: row.documentId,
    versionId: row.versionId,
    snippet: row.body,
    score: 1 / (index + 1),
    citation: citationForKnowledgeChunk(row),
  }))
}

export class LocalKnowledgeRetriever {
  constructor(private readonly database: Database.Database, private readonly resultLimit = 8) {}

  async search(knowledgeBaseIds: readonly string[], rawQuery: string): Promise<LocalKnowledgeSearchOutcome> {
    const query = rawQuery.trim()
    const characterCount = Array.from(query).length
    if (characterCount <= 1) return { kind: 'ask_for_detail', results: [] }
    if (knowledgeBaseIds.length === 0) return { kind: 'results', results: [] }
    const placeholders = knowledgeBaseIds.map(() => '?').join(', ')
    const readyScope = `
      JOIN documents ON documents.id = kb_chunks.document_id
      JOIN document_versions ON document_versions.id = kb_chunks.version_id
      JOIN knowledge_bases ON knowledge_bases.id = kb_chunks.knowledge_base_id
      WHERE kb_chunks.knowledge_base_id IN (${placeholders})
        AND documents.status <> 'recycled'
        AND documents.active_version_id = kb_chunks.version_id
        AND document_versions.status = 'ready'
        AND knowledge_bases.status = 'active'
    `
    let rows: KnowledgeChunkRow[]
    if (characterCount === 2) {
      rows = this.database.prepare(`
        SELECT kb_chunks.id, kb_chunks.knowledge_base_id AS knowledgeBaseId,
          kb_chunks.document_id AS documentId, kb_chunks.version_id AS versionId,
          kb_chunks.block_id AS blockId, kb_chunks.body,
          kb_chunks.coordinates_json AS coordinatesJson
        FROM kb_chunks
        ${readyScope}
          AND instr(kb_chunks.body, ?) > 0
        ORDER BY documents.updated_at DESC, kb_chunks.ordinal ASC
        LIMIT ?
      `).all(...knowledgeBaseIds, query, this.resultLimit) as KnowledgeChunkRow[]
    } else {
      rows = this.database.prepare(`
        SELECT kb_chunks.id, kb_chunks.knowledge_base_id AS knowledgeBaseId,
          kb_chunks.document_id AS documentId, kb_chunks.version_id AS versionId,
          kb_chunks.block_id AS blockId, kb_chunks.body,
          kb_chunks.coordinates_json AS coordinatesJson
        FROM kb_chunks_fts
        JOIN kb_chunks ON kb_chunks.rowid = kb_chunks_fts.rowid
        ${readyScope}
          AND kb_chunks_fts MATCH ?
        ORDER BY bm25(kb_chunks_fts), documents.updated_at DESC
        LIMIT ?
      `).all(...knowledgeBaseIds, literalMatch(query), this.resultLimit) as KnowledgeChunkRow[]
    }
    return { kind: 'results', results: toResults(rows) }
  }

  async searchVersions(versionIds: readonly string[], rawQuery: string): Promise<LocalKnowledgeSearchOutcome> {
    const query = rawQuery.trim()
    const characterCount = Array.from(query).length
    if (characterCount <= 1) return { kind: 'ask_for_detail', results: [] }
    if (versionIds.length === 0) return { kind: 'results', results: [] }
    const placeholders = versionIds.map(() => '?').join(', ')
    let rows: KnowledgeChunkRow[]
    if (characterCount === 2) {
      rows = this.database.prepare(`
        SELECT kb_chunks.id, kb_chunks.knowledge_base_id AS knowledgeBaseId,
          kb_chunks.document_id AS documentId, kb_chunks.version_id AS versionId,
          kb_chunks.block_id AS blockId, kb_chunks.body,
          kb_chunks.coordinates_json AS coordinatesJson
        FROM kb_chunks
        WHERE kb_chunks.version_id IN (${placeholders})
          AND instr(kb_chunks.body, ?) > 0
        ORDER BY kb_chunks.version_id, kb_chunks.ordinal, kb_chunks.id
        LIMIT ?
      `).all(...versionIds, query, this.resultLimit) as KnowledgeChunkRow[]
    } else {
      rows = this.database.prepare(`
        SELECT kb_chunks.id, kb_chunks.knowledge_base_id AS knowledgeBaseId,
          kb_chunks.document_id AS documentId, kb_chunks.version_id AS versionId,
          kb_chunks.block_id AS blockId, kb_chunks.body,
          kb_chunks.coordinates_json AS coordinatesJson
        FROM kb_chunks_fts
        JOIN kb_chunks ON kb_chunks.rowid = kb_chunks_fts.rowid
        WHERE kb_chunks.version_id IN (${placeholders})
          AND kb_chunks_fts MATCH ?
        ORDER BY bm25(kb_chunks_fts), kb_chunks.version_id, kb_chunks.id
        LIMIT ?
      `).all(...versionIds, literalMatch(query), this.resultLimit) as KnowledgeChunkRow[]
    }
    return { kind: 'results', results: toResults(rows) }
  }
}
