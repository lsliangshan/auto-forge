import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type Database from 'better-sqlite3-multiple-ciphers'
import { toSafeAppError } from '@autoforge/shared'
import { removeFileDurably } from './key-store.js'
import { managedKnowledgeObjectName, type PurgeEntityKind } from './purge-service.js'

interface OrphanCleanupRow {
  readonly relativeName: string
  readonly jobId: string
  readonly documentId: string
}

export interface KnowledgeOrphanCleanupServiceOptions {
  readonly database: Database.Database
  readonly objectsDirectory: string
  readonly mutate: <T>(operation: () => T | Promise<T>) => Promise<T>
  readonly removeObjectDurably?: (path: string) => Promise<void>
}

function internalFailure(): never {
  throw toSafeAppError({ code: 'INTERNAL_ERROR' })
}

export class KnowledgeOrphanCleanupService {
  constructor(private readonly options: KnowledgeOrphanCleanupServiceOptions) {}

  async journalAndRemove(input: OrphanCleanupRow): Promise<void> {
    const row = { ...input, relativeName: managedKnowledgeObjectName(input.relativeName) }
    await this.options.mutate(() => this.options.database.transaction(() => {
      this.options.database.prepare(`
        INSERT OR IGNORE INTO orphan_object_cleanups (relative_name, job_id, document_id)
        VALUES (?, ?, ?)
      `).run(row.relativeName, row.jobId, row.documentId)
      const stored = this.options.database.prepare(`
        SELECT relative_name AS relativeName, job_id AS jobId, document_id AS documentId
        FROM orphan_object_cleanups WHERE relative_name = ?
      `).get(row.relativeName) as OrphanCleanupRow | undefined
      if (!stored || stored.jobId !== row.jobId || stored.documentId !== row.documentId) internalFailure()
    })())
    await this.remove(row)
  }

  async resumeAll(): Promise<void> {
    await this.removeRows(this.readRows())
  }

  async resumeScope(kind: PurgeEntityKind, id: string): Promise<void> {
    const rows = kind === 'document'
      ? this.readRows('document_id = ?', id)
      : this.readRows(`
          document_id IN (SELECT id FROM documents WHERE knowledge_base_id = ?)
        `, id)
    await this.removeRows(rows)
  }

  private readRows(predicate?: string, parameter?: string): OrphanCleanupRow[] {
    const rows = this.options.database.prepare(`
      SELECT relative_name AS relativeName, job_id AS jobId, document_id AS documentId
      FROM orphan_object_cleanups${predicate ? ` WHERE ${predicate}` : ''}
      ORDER BY relative_name
    `).all(...(parameter === undefined ? [] : [parameter])) as OrphanCleanupRow[]
    return rows.map(row => ({
      ...row,
      relativeName: managedKnowledgeObjectName(row.relativeName),
    }))
  }

  private async removeRows(rows: readonly OrphanCleanupRow[]): Promise<void> {
    for (const row of rows) await this.remove(row)
  }

  private async remove(row: OrphanCleanupRow): Promise<void> {
    await mkdir(this.options.objectsDirectory, { recursive: true, mode: 0o700 })
    await (this.options.removeObjectDurably ?? removeFileDurably)(
      join(this.options.objectsDirectory, managedKnowledgeObjectName(row.relativeName)),
    )
    await this.options.mutate(() => this.options.database.prepare(`
      DELETE FROM orphan_object_cleanups
      WHERE relative_name = ? AND job_id = ? AND document_id = ?
    `).run(row.relativeName, row.jobId, row.documentId))
  }
}
