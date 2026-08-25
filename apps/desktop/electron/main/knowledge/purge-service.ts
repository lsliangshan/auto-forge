import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type Database from 'better-sqlite3-multiple-ciphers'
import { toSafeAppError } from '@autoforge/shared'
import type { OpenedUserKnowledgeDatabase } from './encrypted-database.js'

export type PurgeEntityKind = 'document' | 'knowledge_base'

interface PurgeJournal {
  readonly id: string
  readonly kind: PurgeEntityKind
  readonly targetId: string
  readonly state: 'prepared' | 'graph_deleted' | 'objects_unlinked' | 'vacuumed'
  readonly objectIds: string[]
  readonly objectNames: string[]
}

function internalFailure(): never {
  throw toSafeAppError({ code: 'INTERNAL_ERROR' })
}

export function managedKnowledgeObjectName(name: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.afobj$/.test(name)) {
    internalFailure()
  }
  return name
}

export interface KnowledgePurgeServiceOptions {
  readonly opened: OpenedUserKnowledgeDatabase
  readonly objectsDirectory: string
  readonly now: () => number
  readonly id: () => string
  readonly mutate: <T>(operation: () => T | Promise<T>) => Promise<T>
  readonly requireTarget: (kind: PurgeEntityKind, id: string) => void
  readonly cancelImportJobs: (kind: PurgeEntityKind, id: string, now: number) => string[]
  readonly abortAndDrain: (jobIds: readonly string[]) => Promise<void>
  readonly unlinkObject?: (path: string) => Promise<void>
  readonly vacuumDatabase?: (database: Database.Database) => void
  readonly rotateDatabaseKey?: (opened: OpenedUserKnowledgeDatabase) => Promise<void>
}

export class KnowledgePurgeService {
  constructor(private readonly options: KnowledgePurgeServiceOptions) {}

  async purge(kind: PurgeEntityKind, id: string): Promise<void> {
    const prepared = await this.options.mutate(() => this.database.transaction(() => {
      const existing = this.readJournal(kind, id)
      if (existing) return { journal: existing, cancelledJobIds: [] as string[] }
      this.options.requireTarget(kind, id)
      const scope = kind === 'document' ? 'documents.id = ?' : 'documents.knowledge_base_id = ?'
      const objects = this.database.prepare(`
        SELECT DISTINCT source_objects.id, source_objects.relative_name AS relativeName
        FROM source_objects
        JOIN document_versions ON document_versions.source_object_id = source_objects.id
        JOIN documents ON documents.id = document_versions.document_id
        WHERE ${scope}
      `).all(id) as Array<{ id: string; relativeName: string }>
      const objectNames = objects.map(object => managedKnowledgeObjectName(object.relativeName))
      const objectIds = objects.map(object => object.id)
      const now = this.options.now()
      const journal: PurgeJournal = {
        id: this.options.id(), kind, targetId: id, state: 'prepared', objectIds, objectNames,
      }
      this.database.prepare(`
        INSERT INTO purge_operations
          (id, entity_kind, target_id, state, object_ids_json, object_names_json, created_at, updated_at)
        VALUES (?, ?, ?, 'prepared', ?, ?, ?, ?)
      `).run(journal.id, kind, id, JSON.stringify(objectIds), JSON.stringify(objectNames), now, now)
      const cancelledJobIds = this.options.cancelImportJobs(kind, id, now)
      return { journal, cancelledJobIds }
    })())
    await this.options.abortAndDrain(prepared.cancelledJobIds)

    let journal = prepared.journal
    if (journal.state === 'prepared') {
      await this.options.mutate(() => this.database.transaction(() => {
        const current = this.readJournal(kind, id)
        if (!current || current.state !== 'prepared') return
        if (kind === 'document') {
          this.database.prepare('DELETE FROM documents WHERE id = ?').run(id)
          this.database.prepare(
            "DELETE FROM tombstones WHERE entity_kind = 'document' AND entity_id = ?",
          ).run(id)
        } else {
          this.database.prepare('DELETE FROM knowledge_bases WHERE id = ?').run(id)
          this.database.prepare('DELETE FROM tombstones WHERE knowledge_base_id = ?').run(id)
        }
        const deleteObject = this.database.prepare('DELETE FROM source_objects WHERE id = ?')
        for (const objectId of current.objectIds) deleteObject.run(objectId)
        this.database.prepare(`
          UPDATE purge_operations SET state = 'graph_deleted', updated_at = ?
          WHERE id = ? AND state = 'prepared'
        `).run(this.options.now(), current.id)
      })())
      journal = this.readJournal(kind, id) ?? internalFailure()
    }
    if (journal.state === 'graph_deleted') {
      const unlinkObject = this.options.unlinkObject ?? unlink
      for (const objectName of journal.objectNames) {
        try {
          await unlinkObject(join(this.options.objectsDirectory, managedKnowledgeObjectName(objectName)))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      await this.options.mutate(() => this.database.prepare(`
        UPDATE purge_operations SET state = 'objects_unlinked', updated_at = ?
        WHERE id = ? AND state = 'graph_deleted'
      `).run(this.options.now(), journal.id))
      journal = this.readJournal(kind, id) ?? internalFailure()
    }
    if (journal.state === 'objects_unlinked') {
      (this.options.vacuumDatabase ?? (database => database.exec('VACUUM')))(this.database)
      await this.options.mutate(() => this.database.prepare(`
        UPDATE purge_operations SET state = 'vacuumed', updated_at = ?
        WHERE id = ? AND state = 'objects_unlinked'
      `).run(this.options.now(), journal.id))
      journal = this.readJournal(kind, id) ?? internalFailure()
    }
    if (journal.state === 'vacuumed') {
      await (this.options.rotateDatabaseKey ?? (opened => opened.rotateKey()))(this.options.opened)
      await this.options.mutate(() => this.database.prepare(
        'DELETE FROM purge_operations WHERE id = ? AND state = ?',
      ).run(journal.id, 'vacuumed'))
    }
  }

  private readJournal(kind: PurgeEntityKind, targetId: string): PurgeJournal | undefined {
    const row = this.database.prepare(`
      SELECT id, entity_kind AS kind, target_id AS targetId, state,
        object_ids_json AS objectIdsJson, object_names_json AS objectNamesJson
      FROM purge_operations WHERE entity_kind = ? AND target_id = ?
    `).get(kind, targetId) as {
      id: string
      kind: PurgeJournal['kind']
      targetId: string
      state: PurgeJournal['state']
      objectIdsJson: string
      objectNamesJson: string
    } | undefined
    if (!row) return undefined
    let objectIds: unknown
    let objectNames: unknown
    try {
      objectIds = JSON.parse(row.objectIdsJson)
      objectNames = JSON.parse(row.objectNamesJson)
    } catch {
      internalFailure()
    }
    if (!Array.isArray(objectIds) || objectIds.some(value => typeof value !== 'string' || !value)) {
      internalFailure()
    }
    if (!Array.isArray(objectNames) || objectNames.some(value => typeof value !== 'string')) {
      internalFailure()
    }
    return {
      id: row.id,
      kind: row.kind,
      targetId: row.targetId,
      state: row.state,
      objectIds: objectIds as string[],
      objectNames: (objectNames as string[]).map(managedKnowledgeObjectName),
    }
  }

  private get database(): Database.Database {
    return this.options.opened.database
  }
}
