import { mkdir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { ParserStartInput } from './parser-supervisor.js'
import type { ParserFormat, ParserResponse } from './parser-protocol.js'
import type { OpenedUserKnowledgeDatabase } from './encrypted-database.js'
import { unwrapSnapshotFileKey } from './encrypted-object-store.js'
import { KnowledgeKeyStore } from './key-store.js'
import { managedKnowledgeObjectName, type PurgeEntityKind } from './purge-service.js'

export interface KnowledgeParserPort {
  parse(input: ParserStartInput): Promise<ParserResponse>
  terminateAll(): Promise<void>
}

export interface KnowledgeImportSession {
  readonly opened: OpenedUserKnowledgeDatabase
  readonly parser: KnowledgeParserPort
  readonly objectKeyStore: KnowledgeKeyStore
  readonly objectsDirectory: string
  mutationTail: Promise<void>
}

export interface ImportPublication {
  readonly knowledgeBaseId: string
  readonly documentId: string
  readonly versionId: string
  readonly objectId: string
  readonly jobId: string
  readonly format: ParserFormat
  readonly objectPath: string
  readonly sourceName: string
  readonly mimeType: string
  readonly generation: number
  readonly authorityToken: string
}

interface ActiveImport {
  readonly session: KnowledgeImportSession
  readonly documentId: string
  readonly knowledgeBaseId: string
  readonly controller?: AbortController
  readonly operation: Promise<void>
}

export interface KnowledgeSnapshotTask {
  complete(error?: unknown): void
}

export async function serializeKnowledgeMutation<T>(
  session: KnowledgeImportSession,
  operation: () => T | Promise<T>,
): Promise<T> {
  const previous = session.mutationTail
  let release!: () => void
  session.mutationTail = new Promise(resolve => { release = resolve })
  await previous
  try {
    return await operation()
  } finally {
    release()
  }
}

export interface KnowledgeImportRuntimeOptions {
  readonly now: () => number
  readonly isClosing: () => boolean
  readonly track: (operation: Promise<void>) => void
}

export class KnowledgeImportRuntime {
  private readonly active = new Map<string, ActiveImport>()

  constructor(private readonly options: KnowledgeImportRuntimeOptions) {}

  beginSnapshot(
    session: KnowledgeImportSession,
    scope: Pick<ImportPublication, 'jobId' | 'documentId' | 'knowledgeBaseId'>,
  ): KnowledgeSnapshotTask {
    if (this.active.has(scope.jobId)) throw new Error('Knowledge import task is already active')
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const operation = new Promise<void>((release, fail) => {
      resolve = release
      reject = fail
    })
    const active: ActiveImport = {
      session,
      documentId: scope.documentId,
      knowledgeBaseId: scope.knowledgeBaseId,
      operation,
    }
    this.active.set(scope.jobId, active)
    this.options.track(operation)
    let completed = false
    return {
      complete: (error?: unknown) => {
        if (completed) return
        completed = true
        if (this.active.get(scope.jobId) === active) this.active.delete(scope.jobId)
        if (error === undefined) resolve()
        else reject(error)
      },
    }
  }

  schedule(session: KnowledgeImportSession, publication: ImportPublication): void {
    if (this.options.isClosing() || this.active.has(publication.jobId)) return
    const controller = new AbortController()
    const operation = new Promise<void>((resolve) => {
      setImmediate(() => {
        void this.finish(session, publication, controller.signal).then(resolve, resolve)
      })
    })
    this.active.set(publication.jobId, {
      session,
      documentId: publication.documentId,
      knowledgeBaseId: publication.knowledgeBaseId,
      controller,
      operation,
    })
    void operation.finally(() => {
      if (this.active.get(publication.jobId)?.operation === operation) this.active.delete(publication.jobId)
    })
    this.options.track(operation)
  }

  abort(jobId: string): void {
    this.active.get(jobId)?.controller?.abort()
  }

  abortSession(session: KnowledgeImportSession): void {
    for (const active of this.active.values()) {
      if (active.session === session) active.controller?.abort()
    }
  }

  async abortAndDrainScope(
    session: KnowledgeImportSession,
    kind: PurgeEntityKind,
    id: string,
  ): Promise<void> {
    const activeTasks = [...this.active.values()].filter(active => (
      active.session === session
      && (kind === 'document' ? active.documentId === id : active.knowledgeBaseId === id)
    ))
    for (const active of activeTasks) {
      active.controller?.abort()
    }
    const outcomes = await Promise.allSettled(activeTasks.map(active => active.operation))
    const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
    if (failure) throw failure.reason
  }

  cancelJobs(
    session: KnowledgeImportSession,
    kind: PurgeEntityKind,
    id: string,
    now: number,
  ): void {
    const predicate = kind === 'document'
      ? 'local_import_jobs.document_id = ?'
      : 'local_import_jobs.knowledge_base_id = ?'
    session.opened.database.prepare(`
      UPDATE jobs SET status = 'cancelled', error_code = 'LIFECYCLE_CANCELLED', updated_at = ?
      WHERE id IN (SELECT job_id FROM local_import_jobs WHERE ${predicate})
        AND status IN ('pending', 'running')
    `).run(now, id)
    session.opened.database.prepare(`
      UPDATE document_versions SET status = 'failed'
      WHERE status = 'staging' AND id IN (
        SELECT version_id FROM local_import_jobs WHERE ${predicate}
      )
    `).run(id)
    if (kind === 'document') {
      session.opened.database.prepare('DELETE FROM document_import_heads WHERE document_id = ?').run(id)
    } else {
      session.opened.database.prepare(`
        DELETE FROM document_import_heads WHERE document_id IN (
          SELECT id FROM documents WHERE knowledge_base_id = ?
        )
      `).run(id)
    }
  }

  async reconcile(session: KnowledgeImportSession): Promise<void> {
    await mkdir(session.objectsDirectory, { recursive: true, mode: 0o700 })
    const referenced = new Set((session.opened.database.prepare(
      'SELECT relative_name AS relativeName FROM source_objects',
    ).all() as Array<{ relativeName: string }>).map(row => managedKnowledgeObjectName(row.relativeName)))
    for (const entry of await readdir(session.objectsDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || referenced.has(entry.name)) continue
      try { managedKnowledgeObjectName(entry.name) } catch { continue }
      try { await unlink(join(session.objectsDirectory, entry.name)) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }

    const resumable = await serializeKnowledgeMutation(session, () => session.opened.database.transaction(() => {
      const now = this.options.now()
      session.opened.database.prepare(`
        UPDATE jobs SET status = 'cancelled', error_code = 'STALE_GENERATION', updated_at = ?
        WHERE id IN (
          SELECT local_import_jobs.job_id FROM local_import_jobs
          JOIN jobs ON jobs.id = local_import_jobs.job_id
          LEFT JOIN document_import_heads
            ON document_import_heads.document_id = local_import_jobs.document_id
          WHERE jobs.status IN ('pending', 'running')
            AND (
              document_import_heads.authoritative_job_id IS NULL
              OR document_import_heads.authoritative_job_id <> local_import_jobs.job_id
              OR document_import_heads.generation <> local_import_jobs.generation
              OR document_import_heads.authority_token <> local_import_jobs.authority_token
            )
        )
      `).run(now)
      session.opened.database.prepare(`
        UPDATE document_versions SET status = 'failed'
        WHERE status = 'staging' AND id IN (
          SELECT local_import_jobs.version_id FROM local_import_jobs
          JOIN jobs ON jobs.id = local_import_jobs.job_id
          WHERE jobs.status = 'cancelled'
        )
      `).run()
      session.opened.database.prepare(`
        UPDATE jobs SET status = 'failed', error_code = 'SNAPSHOT_UNAVAILABLE', updated_at = ?
        WHERE id IN (SELECT job_id FROM local_import_jobs WHERE object_id IS NULL)
          AND status IN ('pending', 'running')
      `).run(now)
      session.opened.database.prepare(`
        UPDATE document_versions SET status = 'failed'
        WHERE status = 'staging' AND id IN (
          SELECT local_import_jobs.version_id FROM local_import_jobs
          JOIN jobs ON jobs.id = local_import_jobs.job_id
          WHERE jobs.status = 'failed'
        )
      `).run()
      session.opened.database.prepare(`
        UPDATE documents SET status = CASE WHEN active_version_id IS NULL THEN 'failed' ELSE 'ready' END,
          updated_at = ?
        WHERE id IN (
          SELECT local_import_jobs.document_id FROM local_import_jobs
          JOIN jobs ON jobs.id = local_import_jobs.job_id
          WHERE jobs.status = 'failed'
        ) AND status <> 'recycled'
      `).run(now)
      session.opened.database.prepare(`
        UPDATE jobs SET status = 'pending', error_code = NULL, updated_at = ?
        WHERE status = 'running' AND id IN (
          SELECT local_import_jobs.job_id FROM local_import_jobs
          JOIN document_import_heads
            ON document_import_heads.authoritative_job_id = local_import_jobs.job_id
            AND document_import_heads.generation = local_import_jobs.generation
            AND document_import_heads.authority_token = local_import_jobs.authority_token
          WHERE local_import_jobs.object_id IS NOT NULL
        )
      `).run(now)
      return session.opened.database.prepare(`
        SELECT local_import_jobs.knowledge_base_id AS knowledgeBaseId,
          local_import_jobs.document_id AS documentId,
          local_import_jobs.version_id AS versionId,
          local_import_jobs.object_id AS objectId,
          local_import_jobs.job_id AS jobId,
          local_import_jobs.format,
          source_objects.relative_name AS relativeName,
          local_import_jobs.source_name AS sourceName,
          local_import_jobs.mime_type AS mimeType,
          local_import_jobs.generation,
          local_import_jobs.authority_token AS authorityToken
        FROM local_import_jobs
        JOIN jobs ON jobs.id = local_import_jobs.job_id
        JOIN source_objects ON source_objects.id = local_import_jobs.object_id
        JOIN document_import_heads
          ON document_import_heads.authoritative_job_id = local_import_jobs.job_id
          AND document_import_heads.generation = local_import_jobs.generation
          AND document_import_heads.authority_token = local_import_jobs.authority_token
        WHERE jobs.status = 'pending'
      `).all() as Array<Omit<ImportPublication, 'objectPath'> & { relativeName: string }>
    })())
    for (const row of resumable) {
      this.schedule(session, {
        ...row,
        format: row.format as ParserFormat,
        objectPath: join(session.objectsDirectory, managedKnowledgeObjectName(row.relativeName)),
      })
    }
  }

  async fail(
    session: KnowledgeImportSession,
    publication: ImportPublication,
    errorCode: string,
  ): Promise<void> {
    await serializeKnowledgeMutation(session, () => session.opened.database.transaction(() => {
      const authoritative = session.opened.database.prepare(`
        SELECT 1 FROM document_import_heads
        WHERE document_id = ? AND generation = ?
          AND authoritative_job_id = ? AND authority_token = ?
      `).get(publication.documentId, publication.generation, publication.jobId, publication.authorityToken)
      const job = session.opened.database.prepare('SELECT status FROM jobs WHERE id = ?')
        .get(publication.jobId) as { status: string } | undefined
      if (!job || job.status === 'completed') return
      if (errorCode === 'SESSION_CLOSED' && authoritative && job.status !== 'cancelled') {
        session.opened.database.prepare(`
          UPDATE jobs SET status = 'pending', error_code = NULL, updated_at = ? WHERE id = ?
        `).run(this.options.now(), publication.jobId)
        return
      }
      session.opened.database.prepare(`
        UPDATE jobs SET status = ?, error_code = ?, updated_at = ? WHERE id = ?
      `).run(
        authoritative && job.status !== 'cancelled' ? 'failed' : 'cancelled',
        errorCode,
        this.options.now(),
        publication.jobId,
      )
      session.opened.database.prepare(
        "UPDATE document_versions SET status = 'failed' WHERE id = ? AND status = 'staging'",
      ).run(publication.versionId)
      if (authoritative) {
        session.opened.database.prepare(`
          UPDATE documents SET status = CASE WHEN active_version_id IS NULL THEN 'failed' ELSE 'ready' END,
            updated_at = ? WHERE id = ? AND status <> 'recycled'
        `).run(this.options.now(), publication.documentId)
      }
    })())
  }

  private async finish(
    session: KnowledgeImportSession,
    publication: ImportPublication,
    signal: AbortSignal,
  ): Promise<void> {
    const {
      knowledgeBaseId, documentId, versionId, objectId, jobId, format,
      objectPath, sourceName, mimeType, generation, authorityToken,
    } = publication
    try {
      const claimed = await serializeKnowledgeMutation(session, () => session.opened.database.prepare(`
        UPDATE jobs SET status = 'running', attempt = attempt + 1, updated_at = ?
        WHERE id = ? AND status = 'pending'
          AND EXISTS (
            SELECT 1 FROM document_import_heads
            WHERE document_id = ? AND generation = ?
              AND authoritative_job_id = ? AND authority_token = ?
          )
      `).run(this.options.now(), jobId, documentId, generation, jobId, authorityToken).changes === 1)
      if (!claimed) return
      const objectMasterKey = await session.objectKeyStore.loadActiveKey()
      let fileKey: Buffer
      try {
        const stored = session.opened.database.prepare(
          'SELECT wrapped_file_key AS wrappedFileKey FROM source_objects WHERE id = ?',
        ).get(objectId) as { wrappedFileKey: Buffer }
        fileKey = unwrapSnapshotFileKey(Buffer.from(stored.wrappedFileKey), objectMasterKey)
      } finally {
        objectMasterKey.fill(0)
      }
      let response: ParserResponse
      try {
        response = await session.parser.parse({ jobId, format, objectPath, fileKey, signal })
      } finally {
        fileKey.fill(0)
      }
      if (response.type === 'error') {
        await this.fail(
          session,
          publication,
          response.code === 'PARSER_CANCELLED' && this.options.isClosing() ? 'SESSION_CLOSED' : response.code,
        )
        return
      }
      await serializeKnowledgeMutation(session, () => session.opened.database.transaction(() => {
        const authoritative = session.opened.database.prepare(`
          SELECT 1 FROM jobs JOIN document_import_heads
            ON document_import_heads.authoritative_job_id = jobs.id
          WHERE jobs.id = ? AND jobs.status = 'running'
            AND document_import_heads.document_id = ?
            AND document_import_heads.generation = ?
            AND document_import_heads.authority_token = ?
        `).get(jobId, documentId, generation, authorityToken)
        if (!authoritative) {
          session.opened.database.prepare(
            "UPDATE document_versions SET status = 'failed' WHERE id = ? AND status = 'staging'",
          ).run(versionId)
          return false
        }
        const insertBlock = session.opened.database.prepare(`
          INSERT INTO knowledge_blocks (id, version_id, ordinal, kind, text, coordinates_json)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        for (const [ordinal, block] of response.blocks.entries()) {
          insertBlock.run(
            `${versionId}:${block.id}`, versionId, ordinal, block.coordinate.kind,
            block.text, JSON.stringify(block.coordinate),
          )
        }
        const insertChunk = session.opened.database.prepare(`
          INSERT INTO kb_chunks
            (id, knowledge_base_id, document_id, version_id, block_id, ordinal, body, coordinates_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        const blocks = new Map(response.blocks.map(block => [block.id, {
          ...block, storedId: `${versionId}:${block.id}`,
        }]))
        for (const chunk of response.chunks) {
          const block = blocks.get(chunk.blockIds[0]!)
          if (!block) throw new Error('Knowledge parser returned an unknown block')
          insertChunk.run(
            `${versionId}:${chunk.index}`, knowledgeBaseId, documentId, versionId,
            block.storedId, chunk.index, chunk.text, JSON.stringify(block.coordinate),
          )
        }
        const active = session.opened.database.prepare(
          'SELECT active_version_id AS activeVersionId FROM documents WHERE id = ?',
        ).get(documentId) as { activeVersionId?: string }
        if (active.activeVersionId) {
          session.opened.database.prepare(
            "UPDATE document_versions SET status = 'superseded' WHERE id = ? AND status = 'ready'",
          ).run(active.activeVersionId)
        }
        session.opened.database.prepare(
          "UPDATE document_versions SET status = 'ready' WHERE id = ?",
        ).run(versionId)
        session.opened.database.prepare(`
          UPDATE documents SET active_version_id = ?, name = ?, mime_type = ?,
            status = 'ready', updated_at = ? WHERE id = ?
        `).run(versionId, sourceName, mimeType, this.options.now(), documentId)
        session.opened.database.prepare(
          "UPDATE jobs SET status = 'completed', updated_at = ? WHERE id = ?",
        ).run(this.options.now(), jobId)
        return true
      })())
    } catch {
      try {
        await this.fail(session, publication, this.options.isClosing() ? 'SESSION_CLOSED' : 'IMPORT_FAILED')
      } catch {
        // Logout may have already closed the encrypted database after parser cleanup.
      }
    }
  }
}
