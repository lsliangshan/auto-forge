import type Database from 'better-sqlite3'
import { rankByCosine } from './reciprocal-rank-fusion.js'
import type { LocalTextEmbedder } from './local-embedding.js'

const EMBEDDING_BATCH_SIZE = 8

export interface LocalSemanticChunk {
  readonly id: string
  readonly knowledge_base_id: string
  readonly document_id: string
  readonly version_id: string
  readonly body: string
  readonly coordinates_json: string
}

export interface LocalSemanticCandidate extends LocalSemanticChunk {
  readonly score: number
}

export interface LocalSemanticSearchPort {
  search(
    query: string,
    chunks: readonly LocalSemanticChunk[],
    signal?: AbortSignal,
  ): Promise<readonly LocalSemanticCandidate[]>
  indexVersion(versionId: string, signal?: AbortSignal): Promise<void>
  indexMissing(signal?: AbortSignal): Promise<void>
  prepare(): void
  available(): boolean
  invalidate(): void
  drain(): Promise<void>
  dispose(): Promise<void>
}

function vectorBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
}

function storedVector(buffer: Buffer, dimensions: number): Float32Array | undefined {
  if (buffer.byteLength !== dimensions * 4) return undefined
  const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  return new Float32Array(bytes)
}

export class LocalSemanticIndex implements LocalSemanticSearchPort {
  #tail = Promise.resolve()
  #controller = new AbortController()
  #invalidated = false
  #preparing = false

  constructor(
    private readonly database: Database.Database,
    private readonly embedder: LocalTextEmbedder,
  ) {}

  available(): boolean {
    return this.embedder.available() && !this.#invalidated
  }

  prepare(): void {
    if (this.#invalidated || this.#preparing) return
    this.#preparing = true
    void this.indexMissing().catch(() => undefined).finally(() => {
      this.#preparing = false
    })
  }

  invalidate(): void {
    if (this.#invalidated) return
    this.#invalidated = true
    this.#controller.abort()
  }

  async drain(): Promise<void> {
    await this.#tail
  }

  async dispose(): Promise<void> {
    this.invalidate()
    await this.drain()
    await this.embedder.dispose()
  }

  indexVersion(versionId: string, signal?: AbortSignal): Promise<void> {
    return this.#enqueue(async () => {
      const rows = this.database.prepare(`
        SELECT chunk.id, chunk.body FROM kb_chunks AS chunk
        LEFT JOIN kb_chunk_embeddings AS embedding
          ON embedding.chunk_id = chunk.id AND embedding.model = ?
        WHERE chunk.version_id = ? AND embedding.chunk_id IS NULL
        ORDER BY chunk.ordinal, chunk.id
      `).all(this.embedder.model, versionId) as Array<{ id: string; body: string }>
      await this.#indexRows(rows, signal)
    })
  }

  indexMissing(signal?: AbortSignal): Promise<void> {
    return this.#enqueue(async () => {
      const rows = this.database.prepare(`
        SELECT chunk.id, chunk.body FROM kb_chunks AS chunk
        JOIN documents AS document ON document.id = chunk.document_id
          AND document.knowledge_base_id = chunk.knowledge_base_id
        JOIN document_versions AS version ON version.id = chunk.version_id
          AND version.document_id = chunk.document_id
        LEFT JOIN kb_chunk_embeddings AS embedding
          ON embedding.chunk_id = chunk.id AND embedding.model = ?
        WHERE document.recycled_at IS NULL AND document.active_version_id = chunk.version_id
          AND version.status = 'ready' AND embedding.chunk_id IS NULL
        ORDER BY chunk.knowledge_base_id, chunk.document_id, chunk.ordinal, chunk.id
      `).all(this.embedder.model) as Array<{ id: string; body: string }>
      if (rows.length > 0) {
        await this.#indexRows(rows, signal)
      } else if ((this.database.prepare(`
        SELECT count(*) AS count FROM kb_chunks AS chunk
        JOIN documents AS document ON document.id = chunk.document_id
          AND document.knowledge_base_id = chunk.knowledge_base_id
        JOIN document_versions AS version ON version.id = chunk.version_id
          AND version.document_id = chunk.document_id
        WHERE document.recycled_at IS NULL AND document.active_version_id = chunk.version_id
          AND version.status = 'ready'
      `).get() as { count: number }).count > 0) {
        await this.embedder.embed(['本地知识检索'], this.#combinedSignal(signal))
        this.#assertCurrent(signal)
      }
    })
  }

  search(
    query: string,
    chunks: readonly LocalSemanticChunk[],
    signal?: AbortSignal,
  ): Promise<readonly LocalSemanticCandidate[]> {
    return this.#enqueue(async () => {
      this.#assertCurrent(signal)
      const selected = new Set(chunks.map(chunk => chunk.id))
      const missing = chunks.filter(chunk => !this.database.prepare(`
        SELECT 1 FROM kb_chunk_embeddings WHERE chunk_id = ? AND model = ?
      `).get(chunk.id, this.embedder.model))
      await this.#indexRows(missing, signal)
      this.#assertCurrent(signal)
      const [queryVector] = await this.embedder.embed([query], this.#combinedSignal(signal))
      this.#assertCurrent(signal)
      if (!queryVector) return []
      const stored = this.database.prepare(`
        SELECT chunk_id AS chunkId, embedding FROM kb_chunk_embeddings
        WHERE model = ? AND dimensions = ?
      `).all(this.embedder.model, this.embedder.dimensions) as Array<{
        chunkId: string
        embedding: Buffer
      }>
      const byId = new Map(chunks.map(chunk => [chunk.id, chunk]))
      return rankByCosine(queryVector, stored.flatMap((row) => {
        if (!selected.has(row.chunkId)) return []
        const vector = storedVector(row.embedding, this.embedder.dimensions)
        const chunk = byId.get(row.chunkId)
        return vector && chunk ? [{
          knowledgeBaseId: chunk.knowledge_base_id,
          id: chunk.id,
          vector,
          chunk,
        }] : []
      }), this.embedder.dimensions).filter(candidate => candidate.score >= 0.25)
        .slice(0, 24).map(candidate => ({
        ...candidate.chunk,
        score: candidate.score,
      }))
    })
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const running = this.#tail.then(operation)
    this.#tail = running.then(() => undefined, () => undefined)
    return running
  }

  async #indexRows(
    rows: readonly { id: string; body: string }[],
    signal?: AbortSignal,
  ): Promise<void> {
    for (let offset = 0; offset < rows.length; offset += EMBEDDING_BATCH_SIZE) {
      this.#assertCurrent(signal)
      const batch = rows.slice(offset, offset + EMBEDDING_BATCH_SIZE)
      const vectors = await this.embedder.embed(
        batch.map(row => row.body),
        this.#combinedSignal(signal),
      )
      this.#assertCurrent(signal)
      if (vectors.length !== batch.length) throw new Error('Local embedding batch is incomplete')
      this.database.transaction(() => {
        this.#assertCurrent(signal)
        for (const [index, row] of batch.entries()) {
          const vector = vectors[index]
          if (!vector || vector.length !== this.embedder.dimensions) {
            throw new Error('Local embedding dimensions are invalid')
          }
          this.database.prepare(`
            INSERT INTO kb_chunk_embeddings(chunk_id, model, dimensions, embedding, updated_at)
            SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM kb_chunks WHERE id = ?)
            ON CONFLICT(chunk_id) DO UPDATE SET
              model = excluded.model, dimensions = excluded.dimensions,
              embedding = excluded.embedding, updated_at = excluded.updated_at
          `).run(
            row.id, this.embedder.model, this.embedder.dimensions,
            vectorBuffer(vector), Date.now(), row.id,
          )
        }
      })()
    }
  }

  #combinedSignal(signal?: AbortSignal): AbortSignal {
    return signal
      ? AbortSignal.any([signal, this.#controller.signal])
      : this.#controller.signal
  }

  #assertCurrent(signal?: AbortSignal): void {
    if (this.#invalidated || this.#controller.signal.aborted || signal?.aborted) {
      throw new Error('Local semantic indexing was cancelled')
    }
  }
}
