import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { ParsedDocument, ParserMediaType } from './parser-protocol.js'

interface ObjectReader {
  read(objectId: string): Promise<Buffer>
}

export interface KnowledgeParserPort {
  parse(input: {
    objectHandle: string
    mediaType: ParserMediaType
    oneTimeKey: Buffer
    signal?: AbortSignal
  }): Promise<ParsedDocument>
  terminateAll(): Promise<void>
}

interface ImportJobRunnerDependencies {
  database: Database.Database
  objects: ObjectReader
  parser: KnowledgeParserPort
  ownerEpoch: number
  isCurrentOwnerEpoch(epoch: number): boolean
  token(): string
  onDocumentChanged?(documentId: string): void
}

interface JobRow {
  id: string
  document_id: string
  version_id: string
  generation: number
  publication_token: string
  object_id: string
  mime_type: ParserMediaType
}

export class ImportJobRunner {
  #tail = Promise.resolve()
  #controller = new AbortController()
  #invalidated = false
  #recovered = false

  constructor(private readonly dependencies: ImportJobRunnerDependencies) {}

  recoverAndRun(): Promise<void> {
    if (!this.#recovered) {
      this.#recovered = true
      this.dependencies.database.prepare(`
        UPDATE knowledge_import_jobs SET status = 'queued', updated_at = ?
        WHERE status = 'running'
      `).run(Date.now())
    }
    return this.runQueued()
  }

  runQueued(): Promise<void> {
    const operation = this.#tail.then(async () => {
      if (!this.#isCurrent()) return
      const jobs = this.dependencies.database.prepare(`
        SELECT job.id, job.document_id, job.version_id, job.generation,
               job.publication_token, version.object_id, document.mime_type
        FROM knowledge_import_jobs AS job
        JOIN document_versions AS version
          ON version.id = job.version_id AND version.document_id = job.document_id
        JOIN documents AS document ON document.id = job.document_id
        WHERE job.status = 'queued'
        ORDER BY job.created_at, job.id
      `).all() as JobRow[]
      for (const job of jobs) {
        if (!this.#isCurrent()) return
        await this.#run(job)
      }
    })
    this.#tail = operation.catch(() => undefined)
    return operation
  }

  invalidate(): void {
    if (this.#invalidated) return
    this.#invalidated = true
    this.#controller.abort()
    void this.dependencies.parser.terminateAll().catch(() => undefined)
  }

  async drain(): Promise<void> {
    await Promise.allSettled([this.#tail, this.dependencies.parser.terminateAll()])
  }

  #isCurrent(): boolean {
    return !this.#invalidated
      && this.dependencies.isCurrentOwnerEpoch(this.dependencies.ownerEpoch)
  }

  async #run(job: JobRow): Promise<void> {
    const claimed = this.dependencies.database.prepare(`
      UPDATE knowledge_import_jobs
      SET status = 'running', attempt_count = attempt_count + 1, updated_at = ?
      WHERE id = ? AND publication_token = ? AND status = 'queued'
    `).run(Date.now(), job.id, job.publication_token)
    if (claimed.changes !== 1 || !this.#isCurrent()) return

    const oneTimeKey = randomBytes(32)
    try {
      const parsed = await this.dependencies.parser.parse({
        objectHandle: job.object_id,
        mediaType: job.mime_type,
        oneTimeKey,
        signal: this.#controller.signal,
      })
      if (!this.#isCurrent()) return
      this.#publish(job, parsed)
      if (this.#isCurrent()) this.dependencies.onDocumentChanged?.(job.document_id)
    } catch {
      if (this.#isCurrent()) {
        this.#fail(job)
        if (this.#isCurrent()) this.dependencies.onDocumentChanged?.(job.document_id)
      }
    } finally {
      oneTimeKey.fill(0)
    }
  }

  #publish(job: JobRow, parsed: ParsedDocument): void {
    this.dependencies.database.transaction(() => {
      if (!this.#isCurrent()) return
      const document = this.dependencies.database.prepare(`
        SELECT active_version_id FROM documents
        WHERE id = ? AND publication_generation = ? AND recycled_at IS NULL
      `).get(job.document_id, job.generation) as { active_version_id: string | null } | undefined
      const liveJob = this.dependencies.database.prepare(`
        SELECT id FROM knowledge_import_jobs
        WHERE id = ? AND publication_token = ? AND status = 'running'
      `).get(job.id, job.publication_token)
      if (!document || !liveJob) {
        this.#failInsideTransaction(job)
        return
      }

      this.dependencies.database.prepare('DELETE FROM knowledge_blocks WHERE version_id = ?').run(job.version_id)
      for (const [ordinal, block] of parsed.blocks.entries()) {
        const blockId = this.dependencies.token()
        this.dependencies.database.prepare(`
          INSERT INTO knowledge_blocks(id, version_id, ordinal, kind, text, coordinates_json)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(blockId, job.version_id, ordinal, block.coordinate.kind, block.text, JSON.stringify(block.coordinate))
        this.dependencies.database.prepare(`
          INSERT INTO kb_chunks(
            id, knowledge_base_id, document_id, version_id, block_id, ordinal, body, coordinates_json
          )
          SELECT ?, document.knowledge_base_id, document.id, ?, ?, ?, ?, ?
          FROM documents AS document WHERE document.id = ?
        `).run(
          this.dependencies.token(), job.version_id, blockId, ordinal, block.text,
          JSON.stringify(block.coordinate), job.document_id,
        )
      }
      if (document.active_version_id) {
        this.dependencies.database.prepare(`
          UPDATE document_versions SET status = 'superseded'
          WHERE id = ? AND status = 'ready'
        `).run(document.active_version_id)
      }
      this.dependencies.database.prepare(`
        UPDATE document_versions SET status = 'ready', error_code = NULL
        WHERE id = ? AND document_id = ? AND publication_generation = ? AND status = 'staging'
      `).run(job.version_id, job.document_id, job.generation)
      this.dependencies.database.prepare(`
        UPDATE documents
        SET active_version_id = ?, lifecycle_status = 'ready', updated_at = ?
        WHERE id = ? AND publication_generation = ? AND recycled_at IS NULL
      `).run(job.version_id, Date.now(), job.document_id, job.generation)
      this.dependencies.database.prepare(`
        UPDATE knowledge_import_jobs SET status = 'completed', updated_at = ?
        WHERE id = ? AND publication_token = ? AND status = 'running'
      `).run(Date.now(), job.id, job.publication_token)
    })()
  }

  #fail(job: JobRow): void {
    this.dependencies.database.transaction(() => this.#failInsideTransaction(job))()
  }

  #failInsideTransaction(job: JobRow): void {
    const changed = this.dependencies.database.prepare(`
      UPDATE knowledge_import_jobs SET status = 'failed', updated_at = ?
      WHERE id = ? AND publication_token = ? AND status = 'running'
    `).run(Date.now(), job.id, job.publication_token)
    if (changed.changes !== 1) return
    this.dependencies.database.prepare(`
      UPDATE document_versions SET status = 'failed', error_code = 'IMPORT_FAILED'
      WHERE id = ? AND document_id = ? AND status = 'staging'
    `).run(job.version_id, job.document_id)
    this.dependencies.database.prepare(`
      UPDATE documents
      SET lifecycle_status = CASE WHEN active_version_id IS NULL THEN 'failed' ELSE 'ready' END,
          updated_at = ?
      WHERE id = ?
    `).run(Date.now(), job.document_id)
  }
}
