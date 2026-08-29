import type Database from 'better-sqlite3'
import type { KnowledgeEvidence, KnowledgeSearchResult } from '@autoforge/shared'
import { reciprocalRankFusion } from './reciprocal-rank-fusion.js'
import type { LocalSemanticSearchPort } from './local-semantic-index.js'

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

export interface LocalKnowledgeVersionScope {
  readonly baseId: string
  readonly documentId: string
  readonly versionId: string
  readonly publicationGeneration: number
}

function searchResult(
  rows: ChunkRow[],
  strategy: Extract<KnowledgeSearchResult, { kind: 'results' }>['strategy'],
  query: string,
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
      snippet: centredSnippet(row.body, query),
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

function centredSnippet(body: string, query: string): string {
  const candidates = [query, questionSubject(query), fieldNameFallback(query)]
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => right.length - left.length)
  const match = candidates.map(value => ({ value, index: body.indexOf(value) }))
    .filter(candidate => candidate.index >= 0)
    .sort((left, right) => left.index - right.index)[0]
  const characters = Array.from(body)
  if (!match) return characters.slice(0, 450).join('')
  const matchStart = Array.from(body.slice(0, match.index)).length
  const matchLength = Array.from(match.value).length
  const start = Math.max(0, matchStart - 180)
  const end = Math.min(characters.length, Math.max(start + 450, matchStart + matchLength + 180))
  return characters.slice(Math.max(0, end - 450), end).join('')
}

function selectedScope(baseIds: readonly string[]): { clause: string; values: string[] } {
  const values = [...new Set(baseIds)]
  if (values.length === 0 || values.length > 32 || values.some(id => !id || id.length > 512)) {
    throw new Error('Invalid local knowledge scope')
  }
  return { clause: values.map(() => '?').join(', '), values }
}

function questionSubject(normalized: string): string {
  return normalized
    .replace(/[?？!！。．…]+$/u, '')
    .trim()
    .replace(/(?:是(?:什么|多少|哪一个|哪个|哪项|啥)?|叫什么(?:名字)?|为(?:什么|多少))$/u, '')
    .trim()
}

function literalQuery(normalized: string): string {
  const variants = [normalized]
  const subject = questionSubject(normalized)
  if (subject !== normalized && Array.from(subject).length >= 3) variants.push(subject)
  return [...new Set(variants)]
    .map(value => `"${value.replaceAll('"', '""')}"`)
    .join(' OR ')
}

function fieldNameFallback(normalized: string): string | undefined {
  const subject = questionSubject(normalized)
  const fallback = subject.replace(/(?:名称|名字)$/u, '').trim()
  return fallback !== subject && Array.from(fallback).length >= 2 ? fallback : undefined
}

export class LocalKnowledgeRetriever {
  constructor(
    private readonly database: Database.Database,
    private readonly semantic?: Pick<LocalSemanticSearchPort, 'available' | 'prepare' | 'search'>,
  ) {}

  async search(
    query: string,
    baseIds: readonly string[],
    documentIds?: readonly string[],
    versionScope?: readonly LocalKnowledgeVersionScope[],
    signal?: AbortSignal,
  ): Promise<KnowledgeSearchResult> {
    const normalized = query.normalize('NFC').trim()
    const length = Array.from(normalized).length
    if (length < 2) return { kind: 'query-too-short' }
    const scope = selectedScope(baseIds)
    const documentScope = documentIds === undefined ? undefined : selectedScope(documentIds)
    if (versionScope !== undefined && versionScope.length === 0) {
      return { kind: 'results', strategy: length === 2 ? 'bounded-instr' : 'trigram', evidence: [] }
    }
    const versionValues = versionScope?.flatMap(entry => [
      entry.baseId, entry.documentId, entry.versionId, entry.publicationGeneration,
    ]) ?? []
    const versionPredicate = versionScope === undefined
      ? `AND base.recycled_at IS NULL
        AND document.recycled_at IS NULL
        AND document.active_version_id = chunk.version_id
        AND version.status = 'ready'`
      : `AND (${versionScope.map(() => `(
          chunk.knowledge_base_id = ? AND chunk.document_id = ?
          AND chunk.version_id = ? AND version.publication_generation = ?
        )`).join(' OR ')})`
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
        ${versionPredicate}
        ${documentPredicate}
    `
    const boundedSearch = (term: string): ChunkRow[] => this.database.prepare(`
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
      `).all(...scope.values, ...versionValues, ...(documentScope?.values ?? []), term) as ChunkRow[]
    let lexicalStrategy: Extract<KnowledgeSearchResult, { kind: 'results' }>['strategy']
    let lexicalRows: ChunkRow[]
    if (length === 2) {
      lexicalStrategy = 'bounded-instr'
      lexicalRows = boundedSearch(normalized)
    } else {
      lexicalStrategy = 'trigram'
      const literal = literalQuery(normalized)
      lexicalRows = this.database.prepare(`
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
          ${versionPredicate}
          ${documentPredicate}
        ORDER BY bm25(kb_chunks_fts), chunk.version_id, chunk.ordinal
        LIMIT ${MAX_RESULTS}
      `).all(literal, ...scope.values, ...versionValues, ...(documentScope?.values ?? [])) as ChunkRow[]
      if (lexicalRows.length === 0) {
        const subject = questionSubject(normalized)
        const fallback = subject !== normalized && Array.from(subject).length === 2
          ? subject
          : fieldNameFallback(normalized)
        if (fallback !== undefined) {
          lexicalStrategy = 'bounded-instr'
          lexicalRows = boundedSearch(fallback)
        }
      }
    }

    if (!this.semantic) return searchResult(lexicalRows, lexicalStrategy, normalized)
    if (!this.semantic.available()) {
      this.semantic.prepare()
      return searchResult(lexicalRows, lexicalStrategy, normalized)
    }
    try {
      const semanticScope = this.database.prepare(`
        ${selected}
        ORDER BY chunk.knowledge_base_id, chunk.document_id, chunk.ordinal, chunk.id
      `).all(
        ...scope.values, ...versionValues, ...(documentScope?.values ?? []),
      ) as ChunkRow[]
      const semanticRows = await this.semantic.search(normalized, semanticScope, signal)
      if (semanticRows.length === 0) return searchResult(lexicalRows, lexicalStrategy, normalized)
      const byIdentity = new Map(
        [...lexicalRows, ...semanticRows].map(row => [
          `${row.knowledge_base_id.length}:${row.knowledge_base_id}${row.id}`,
          row,
        ]),
      )
      const fused = reciprocalRankFusion([
        lexicalRows.map(row => ({ knowledgeBaseId: row.knowledge_base_id, id: row.id })),
        semanticRows.map(row => ({ knowledgeBaseId: row.knowledge_base_id, id: row.id })),
      ], { limit: MAX_RESULTS })
      const rows = fused.flatMap(candidate => {
        const row = byIdentity.get(
          `${candidate.knowledgeBaseId.length}:${candidate.knowledgeBaseId}${candidate.id}`,
        )
        return row ? [row] : []
      })
      return searchResult(rows, 'hybrid', normalized)
    } catch (error) {
      console.warn(
        '[knowledge] local semantic retrieval fell back to lexical:',
        error instanceof Error ? error.message : 'unknown error',
      )
      return searchResult(lexicalRows, lexicalStrategy, normalized)
    }
  }
}
