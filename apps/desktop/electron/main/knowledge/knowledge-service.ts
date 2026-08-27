import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  toSafeAppError,
  type AppError,
  type KnowledgeAvailability,
  type KnowledgeBaseSummary,
  type KnowledgeDocumentSummary,
  type KnowledgeEvent,
  type KnowledgeImportHandle,
  type KnowledgeVersionSummary,
} from '@autoforge/shared'
import { KnowledgeExportService } from './export-service.js'
import { ImportJobRunner, type KnowledgeParserPort } from './import-job-runner.js'
import { LocalKnowledgeRetriever } from './local-retriever.js'
import type { KnowledgeOwner, KnowledgeService } from './knowledge-types.js'
import { PARSER_MEDIA_TYPES, type ParserMediaType } from './parser-protocol.js'

export const MAX_KNOWLEDGE_IMPORT_BYTES = 64 * 1024 * 1024
const mediaTypes = new Set<string>(PARSER_MEDIA_TYPES)

export interface SelectedKnowledgeFile {
  readonly name: string
  readonly mimeType: ParserMediaType
  readonly bytes: Buffer
}

export interface LocalKnowledgeStore {
  database: Database.Database
  objects: {
    put(contents: Buffer): Promise<{ objectId: string; byteLength: number }>
    read(objectId: string): Promise<Buffer>
    delete(objectId: string): Promise<void>
  }
  close(): Promise<void>
}

export interface LocalKnowledgeServiceDependencies {
  openStore(ownerId: string): Promise<LocalKnowledgeStore>
  selectImportFiles(): Promise<SelectedKnowledgeFile[]>
  createParser(store: LocalKnowledgeStore): KnowledgeParserPort | Promise<KnowledgeParserPort>
  saveExport(name: string, contents: Buffer): Promise<void>
  isMember(ownerId: string): boolean
  emit?(event: KnowledgeEvent): void
  now?(): number
  id?(): string
}

interface ImportHandleRecord extends KnowledgeImportHandle {
  objectId: string
  contentHash: string
  epoch: number
}

interface Binding {
  ownerId: string
  epoch: number
  store: LocalKnowledgeStore
  parser: KnowledgeParserPort
  runner: ImportJobRunner
  handles: Map<string, ImportHandleRecord>
}

interface UnavailableBinding {
  ownerId: string
  epoch: number
  encryptionAvailable: boolean
  parserAvailable: boolean
}

export interface LocalKnowledgeService extends KnowledgeService {
  bind(ownerId: string): Promise<void>
  invalidate(): void
  drain(): Promise<void>
  restoreDocument(owner: KnowledgeOwner, documentId: string): Promise<void>
  restoreBase(owner: KnowledgeOwner, baseId: string): Promise<void>
}

function fail(code: AppError['code']): never {
  throw toSafeAppError({ code })
}

function timestamp(value: number): string {
  return new Date(value).toISOString()
}

function baseSummary(database: Database.Database, baseId: string): KnowledgeBaseSummary | undefined {
  const row = database.prepare(`
    SELECT base.id, base.name, base.lifecycle_status, base.updated_at,
      count(document.id) AS document_count,
      max(CASE WHEN document.recycled_at IS NULL
        AND document.active_version_id IS NOT NULL
        AND version.status = 'ready' THEN 1 ELSE 0 END) AS searchable
    FROM knowledge_bases AS base
    LEFT JOIN documents AS document ON document.knowledge_base_id = base.id
    LEFT JOIN document_versions AS version ON version.id = document.active_version_id
    WHERE base.id = ?
    GROUP BY base.id
  `).get(baseId) as {
    id: string; name: string; lifecycle_status: KnowledgeBaseSummary['status']; updated_at: number
    document_count: number; searchable: number
  } | undefined
  if (!row) return undefined
  return {
    id: row.id,
    name: row.name,
    kind: 'local',
    status: row.lifecycle_status,
    searchable: row.lifecycle_status !== 'recycled' && row.searchable === 1,
    documentCount: row.document_count,
    updatedAt: timestamp(row.updated_at),
  }
}

function documentSummary(database: Database.Database, documentId: string): KnowledgeDocumentSummary | undefined {
  const row = database.prepare(`
    SELECT document.id, document.knowledge_base_id, document.name, document.mime_type,
           document.lifecycle_status, document.updated_at, count(version.id) AS version_count
    FROM documents AS document
    LEFT JOIN document_versions AS version ON version.document_id = document.id
    WHERE document.id = ?
    GROUP BY document.id
  `).get(documentId) as {
    id: string; knowledge_base_id: string; name: string; mime_type: string
    lifecycle_status: KnowledgeDocumentSummary['status']; updated_at: number; version_count: number
  } | undefined
  if (!row) return undefined
  return {
    id: row.id,
    baseId: row.knowledge_base_id,
    name: row.name,
    mimeType: row.mime_type,
    status: row.lifecycle_status,
    versionCount: row.version_count,
    updatedAt: timestamp(row.updated_at),
  }
}

export function createLocalKnowledgeService(
  dependencies: LocalKnowledgeServiceDependencies,
): LocalKnowledgeService {
  let epoch = 0
  let binding: Binding | undefined
  let unavailable: UnavailableBinding | undefined
  let lifecycleTail = Promise.resolve()
  const retiring = new Set<Promise<void>>()
  const pendingRetirements = new Set<Binding>()
  const now = dependencies.now ?? Date.now
  const id = dependencies.id ?? randomUUID

  const retire = (current: Binding): void => {
    current.runner.invalidate()
    const closing = (async () => {
      await current.runner.drain()
      for (const handle of current.handles.values()) {
        await current.store.objects.delete(handle.objectId).catch(() => undefined)
      }
      current.handles.clear()
      await current.store.close()
    })().finally(() => { retiring.delete(closing) })
    retiring.add(closing)
  }

  const beginRetirements = (): void => {
    for (const pending of pendingRetirements) {
      pendingRetirements.delete(pending)
      retire(pending)
    }
  }

  const invalidate = (): void => {
    epoch += 1
    const current = binding
    binding = undefined
    unavailable = undefined
    if (current) {
      current.runner.invalidate()
      pendingRetirements.add(current)
    }
  }

  const current = (owner: KnowledgeOwner): Binding => {
    const active = binding
    if (!active) {
      if (unavailable?.ownerId === owner.userId && unavailable.epoch === epoch) fail('SERVICE_UNAVAILABLE')
      if (unavailable) fail('FORBIDDEN')
      fail('AUTH_REQUIRED')
    }
    if (owner.userId !== active.ownerId) fail('FORBIDDEN')
    if (active.epoch !== epoch) fail('CONFLICT')
    return active
  }

  const emitDocument = (active: Binding, documentId: string): void => {
    if (binding !== active || active.epoch !== epoch) return
    const document = documentSummary(active.store.database, documentId)
    if (document) dependencies.emit?.({ type: 'document_updated', document })
  }

  const recoverCleanup = async (store: LocalKnowledgeStore): Promise<void> => {
    const records = store.database.prepare(
      'SELECT object_id FROM knowledge_cleanup_records ORDER BY created_at, object_id',
    ).all() as Array<{ object_id: string }>
    for (const record of records) {
      await store.objects.delete(record.object_id)
      store.database.prepare('DELETE FROM knowledge_cleanup_records WHERE object_id = ?').run(record.object_id)
    }
  }

  const bind = (ownerId: string): Promise<void> => {
    if (binding?.ownerId === ownerId && binding.epoch === epoch) return Promise.resolve()
    if (unavailable?.ownerId === ownerId && unavailable.epoch === epoch) return Promise.resolve()
    invalidate()
    const bindEpoch = epoch
    const operation = lifecycleTail.then(async () => {
      beginRetirements()
      await Promise.allSettled([...retiring])
      let store: LocalKnowledgeStore
      try {
        store = await dependencies.openStore(ownerId)
      } catch {
        if (bindEpoch === epoch) unavailable = {
          ownerId, epoch: bindEpoch, encryptionAvailable: false, parserAvailable: false,
        }
        return
      }
      if (bindEpoch !== epoch) {
        await store.close()
        fail('CONFLICT')
      }
      let parser: KnowledgeParserPort
      try {
        await recoverCleanup(store)
        parser = await dependencies.createParser(store)
      } catch {
        await store.close()
        if (bindEpoch === epoch) unavailable = {
          ownerId, epoch: bindEpoch, encryptionAvailable: true, parserAvailable: false,
        }
        return
      }
      const active = {} as Binding
      const runner = new ImportJobRunner({
        database: store.database,
        objects: store.objects,
        parser,
        ownerEpoch: bindEpoch,
        isCurrentOwnerEpoch: candidate => binding === active && epoch === candidate,
        token: id,
        onDocumentChanged: documentId => emitDocument(active, documentId),
      })
      Object.assign(active, { ownerId, epoch: bindEpoch, store, parser, runner, handles: new Map() })
      binding = active
      void runner.recoverAndRun().catch(() => undefined)
    })
    lifecycleTail = operation.catch(() => undefined)
    return operation
  }

  const consumeHandle = (active: Binding, handleId: string): ImportHandleRecord => {
    const handle = active.handles.get(handleId)
    if (!handle || handle.epoch !== active.epoch) fail('NOT_FOUND')
    active.handles.delete(handleId)
    return handle
  }

  const enqueue = (
    active: Binding,
    documentId: string,
    handle: ImportHandleRecord,
    versionNumber: number,
    generation: number,
  ): void => {
    const createdAt = now()
    const versionId = id()
    active.store.database.prepare(`
      INSERT INTO document_versions(
        id, document_id, version_number, status, content_hash, object_id, created_at, publication_generation
      ) VALUES (?, ?, ?, 'staging', ?, ?, ?, ?)
    `).run(versionId, documentId, versionNumber, handle.contentHash, handle.objectId, createdAt, generation)
    active.store.database.prepare(`
      INSERT INTO knowledge_import_jobs(
        id, document_id, version_id, generation, publication_token, status,
        attempt_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?)
    `).run(id(), documentId, versionId, generation, id(), createdAt, createdAt)
  }

  const purgeObjects = async (active: Binding, objectIds: readonly string[]): Promise<void> => {
    for (const objectId of objectIds) {
      await active.store.objects.delete(objectId)
      if (binding === active && active.epoch === epoch) {
        active.store.database.prepare('DELETE FROM knowledge_cleanup_records WHERE object_id = ?').run(objectId)
      }
    }
  }

  return {
    bind,
    invalidate,
    drain: async () => {
      await lifecycleTail.catch(() => undefined)
      beginRetirements()
      await Promise.allSettled([...retiring])
    },
    list: async (owner) => {
      const active = current(owner)
      const ids = active.store.database.prepare(
        'SELECT id FROM knowledge_bases ORDER BY created_at, id',
      ).all() as Array<{ id: string }>
      return ids.map(row => baseSummary(active.store.database, row.id)!)
    },
    create: async (owner, rawName) => {
      const active = current(owner)
      const name = rawName.trim()
      if (!name || name.length > 200) fail('INVALID_INPUT')
      if (!dependencies.isMember(active.ownerId)) {
        const count = active.store.database.prepare('SELECT count(*) AS count FROM knowledge_bases').get() as { count: number }
        if (count.count >= 1) fail('CONFLICT')
      }
      const baseId = id()
      const createdAt = now()
      active.store.database.prepare(`
        INSERT INTO knowledge_bases(id, name, created_at, updated_at, lifecycle_status, recycled_at)
        VALUES (?, ?, ?, ?, 'ready', NULL)
      `).run(baseId, name, createdAt, createdAt)
      return baseSummary(active.store.database, baseId)!
    },
    listDocuments: async (owner, baseId) => {
      const active = current(owner)
      if (!baseSummary(active.store.database, baseId)) fail('NOT_FOUND')
      const rows = active.store.database.prepare(`
        SELECT id FROM documents WHERE knowledge_base_id = ? ORDER BY created_at, id
      `).all(baseId) as Array<{ id: string }>
      return rows.map(row => documentSummary(active.store.database, row.id)!)
    },
    listVersions: async (owner, documentId) => {
      const active = current(owner)
      if (!documentSummary(active.store.database, documentId)) fail('NOT_FOUND')
      const rows = active.store.database.prepare(`
        SELECT id, document_id, version_number, status, created_at
        FROM document_versions WHERE document_id = ? ORDER BY version_number DESC
      `).all(documentId) as Array<{
        id: string; document_id: string; version_number: number; status: string; created_at: number
      }>
      return rows.map((row): KnowledgeVersionSummary => ({
        id: row.id,
        documentId: row.document_id,
        number: row.version_number,
        status: row.status === 'superseded' ? 'retired' : row.status as KnowledgeVersionSummary['status'],
        createdAt: timestamp(row.created_at),
      }))
    },
    pickImportFiles: async (owner) => {
      const active = current(owner)
      const selected = await dependencies.selectImportFiles()
      if (binding !== active || active.epoch !== epoch) {
        for (const file of selected) file.bytes.fill(0)
        fail('CONFLICT')
      }
      const result: KnowledgeImportHandle[] = []
      for (const file of selected) {
        try {
          if (!file.name.trim() || file.name.length > 500
            || !mediaTypes.has(file.mimeType)
            || file.bytes.length === 0 || file.bytes.length > MAX_KNOWLEDGE_IMPORT_BYTES) fail('INVALID_INPUT')
          const stored = await active.store.objects.put(file.bytes)
          if (binding !== active || active.epoch !== epoch) {
            await active.store.objects.delete(stored.objectId).catch(() => undefined)
            fail('CONFLICT')
          }
          const handle: ImportHandleRecord = {
            id: id(),
            name: file.name,
            mimeType: file.mimeType,
            byteSize: stored.byteLength,
            objectId: stored.objectId,
            contentHash: createHash('sha256').update(file.bytes).digest('hex'),
            epoch: active.epoch,
          }
          active.handles.set(handle.id, handle)
          result.push({ id: handle.id, name: handle.name, mimeType: handle.mimeType, byteSize: handle.byteSize })
        } finally {
          file.bytes.fill(0)
        }
      }
      return result
    },
    importDocument: async (owner, baseId, handleId) => {
      const active = current(owner)
      const base = active.store.database.prepare(
        'SELECT id FROM knowledge_bases WHERE id = ? AND recycled_at IS NULL',
      ).get(baseId)
      if (!base) fail('NOT_FOUND')
      if (!dependencies.isMember(active.ownerId)) {
        const count = active.store.database.prepare(
          'SELECT count(*) AS count FROM documents WHERE recycled_at IS NULL',
        ).get() as { count: number }
        if (count.count >= 1) fail('CONFLICT')
      }
      const handle = consumeHandle(active, handleId)
      const documentId = id()
      const createdAt = now()
      active.store.database.transaction(() => {
        active.store.database.prepare(`
          INSERT INTO documents(
            id, knowledge_base_id, name, mime_type, active_version_id, created_at, updated_at,
            lifecycle_status, publication_generation, recycled_at
          ) VALUES (?, ?, ?, ?, NULL, ?, ?, 'queued', 1, NULL)
        `).run(documentId, baseId, handle.name, handle.mimeType, createdAt, createdAt)
        enqueue(active, documentId, handle, 1, 1)
      })()
      void active.runner.runQueued().catch(() => undefined)
      return documentSummary(active.store.database, documentId)
    },
    replaceDocument: async (owner, documentId, handleId) => {
      const active = current(owner)
      const document = active.store.database.prepare(`
        SELECT publication_generation FROM documents WHERE id = ? AND recycled_at IS NULL
      `).get(documentId) as { publication_generation: number } | undefined
      if (!document) fail('NOT_FOUND')
      const handle = consumeHandle(active, handleId)
      active.store.database.transaction(() => {
        const latest = active.store.database.prepare(`
          SELECT coalesce(max(version_number), 0) AS version_number
          FROM document_versions WHERE document_id = ?
        `).get(documentId) as { version_number: number }
        const generation = document.publication_generation + 1
        active.store.database.prepare(`
          UPDATE documents SET name = ?, mime_type = ?, lifecycle_status = 'queued',
            publication_generation = ?, updated_at = ? WHERE id = ? AND publication_generation = ?
        `).run(handle.name, handle.mimeType, generation, now(), documentId, document.publication_generation)
        enqueue(active, documentId, handle, latest.version_number + 1, generation)
      })()
      void active.runner.runQueued().catch(() => undefined)
      return documentSummary(active.store.database, documentId)
    },
    recycleDocument: async (owner, documentId) => {
      const active = current(owner)
      const changed = active.store.database.transaction(() => {
        const result = active.store.database.prepare(`
          UPDATE documents SET recycled_at = ?, lifecycle_status = 'deleted', updated_at = ?
          WHERE id = ? AND recycled_at IS NULL
        `).run(now(), now(), documentId)
        if (result.changes === 1) active.store.database.prepare(`
          UPDATE knowledge_import_jobs SET status = 'cancelled', updated_at = ?
          WHERE document_id = ? AND status IN ('queued', 'running')
        `).run(now(), documentId)
        return result.changes
      })()
      if (changed !== 1) fail('NOT_FOUND')
      emitDocument(active, documentId)
    },
    restoreDocument: async (owner, documentId) => {
      const active = current(owner)
      const document = active.store.database.prepare(`
        SELECT active_version_id FROM documents WHERE id = ? AND recycled_at IS NOT NULL
      `).get(documentId) as { active_version_id: string | null } | undefined
      if (!document) fail('NOT_FOUND')
      if (!dependencies.isMember(active.ownerId)) {
        const count = active.store.database.prepare(
          'SELECT count(*) AS count FROM documents WHERE recycled_at IS NULL',
        ).get() as { count: number }
        if (count.count >= 1) fail('CONFLICT')
      }
      const status = document.active_version_id ? 'ready' : 'failed'
      active.store.database.prepare(`
        UPDATE documents SET recycled_at = NULL, lifecycle_status = ?, updated_at = ? WHERE id = ?
      `).run(status, now(), documentId)
      emitDocument(active, documentId)
    },
    purgeDocument: async (owner, documentId) => {
      const active = current(owner)
      const document = active.store.database.prepare(
        'SELECT id FROM documents WHERE id = ? AND recycled_at IS NOT NULL',
      ).get(documentId)
      if (!document) fail('NOT_FOUND')
      const objects = active.store.database.prepare(
        'SELECT object_id FROM document_versions WHERE document_id = ?',
      ).all(documentId) as Array<{ object_id: string }>
      active.store.database.transaction(() => {
        for (const object of objects) active.store.database.prepare(`
          INSERT OR IGNORE INTO knowledge_cleanup_records(object_id, created_at) VALUES (?, ?)
        `).run(object.object_id, now())
        active.store.database.prepare('DELETE FROM documents WHERE id = ?').run(documentId)
      })()
      await purgeObjects(active, objects.map(object => object.object_id))
      if (binding === active && active.epoch === epoch) dependencies.emit?.({ type: 'document_removed', documentId })
    },
    recycleBase: async (owner, baseId) => {
      const active = current(owner)
      const recycledAt = now()
      const changed = active.store.database.transaction(() => {
        const result = active.store.database.prepare(`
          UPDATE knowledge_bases SET lifecycle_status = 'recycled', recycled_at = ?, updated_at = ?
          WHERE id = ? AND recycled_at IS NULL
        `).run(recycledAt, recycledAt, baseId)
        if (result.changes === 1) {
          active.store.database.prepare(`
            UPDATE documents SET lifecycle_status = 'deleted', recycled_at = coalesce(recycled_at, ?), updated_at = ?
            WHERE knowledge_base_id = ?
          `).run(recycledAt, recycledAt, baseId)
          active.store.database.prepare(`
            UPDATE knowledge_import_jobs SET status = 'cancelled', updated_at = ?
            WHERE document_id IN (SELECT id FROM documents WHERE knowledge_base_id = ?)
              AND status IN ('queued', 'running')
          `).run(recycledAt, baseId)
        }
        return result.changes
      })()
      if (changed !== 1) fail('NOT_FOUND')
    },
    restoreBase: async (owner, baseId) => {
      const active = current(owner)
      const exists = active.store.database.prepare(
        'SELECT id FROM knowledge_bases WHERE id = ? AND recycled_at IS NOT NULL',
      ).get(baseId)
      if (!exists) fail('NOT_FOUND')
      if (!dependencies.isMember(active.ownerId)) {
        const count = active.store.database.prepare(
          'SELECT count(*) AS count FROM knowledge_bases WHERE recycled_at IS NULL',
        ).get() as { count: number }
        if (count.count >= 1) fail('CONFLICT')
      }
      active.store.database.prepare(`
        UPDATE knowledge_bases SET lifecycle_status = 'ready', recycled_at = NULL, updated_at = ? WHERE id = ?
      `).run(now(), baseId)
    },
    purgeBase: async (owner, baseId) => {
      const active = current(owner)
      const exists = active.store.database.prepare(
        'SELECT id FROM knowledge_bases WHERE id = ? AND recycled_at IS NOT NULL',
      ).get(baseId)
      if (!exists) fail('NOT_FOUND')
      const objects = active.store.database.prepare(`
        SELECT version.object_id FROM document_versions AS version
        JOIN documents AS document ON document.id = version.document_id
        WHERE document.knowledge_base_id = ?
      `).all(baseId) as Array<{ object_id: string }>
      active.store.database.transaction(() => {
        for (const object of objects) active.store.database.prepare(`
          INSERT OR IGNORE INTO knowledge_cleanup_records(object_id, created_at) VALUES (?, ?)
        `).run(object.object_id, now())
        active.store.database.prepare('DELETE FROM knowledge_bases WHERE id = ?').run(baseId)
      })()
      await purgeObjects(active, objects.map(object => object.object_id))
    },
    exportBase: async (owner, baseId) => {
      const active = current(owner)
      if (!baseSummary(active.store.database, baseId)) fail('NOT_FOUND')
      const exporter = new KnowledgeExportService({
        database: active.store.database,
        objects: active.store.objects,
        save: dependencies.saveExport,
      })
      await exporter.exportBase(baseId)
    },
    getSelection: async () => fail('SERVICE_UNAVAILABLE'),
    updateSelection: async () => fail('SERVICE_UNAVAILABLE'),
    search: async (owner, query) => {
      const active = current(owner)
      const bases = active.store.database.prepare(`
        SELECT id FROM knowledge_bases WHERE recycled_at IS NULL ORDER BY created_at, id
      `).all() as Array<{ id: string }>
      if (bases.length === 0) return []
      const result = await new LocalKnowledgeRetriever(active.store.database)
        .search(query, bases.map(base => base.id))
      return Array.isArray(result) ? Array.from(result) : []
    },
    getAvailability: async (owner): Promise<KnowledgeAvailability> => {
      const disabled = unavailable
      if (disabled) {
        if (disabled.ownerId !== owner.userId || disabled.epoch !== epoch) fail('FORBIDDEN')
        return {
          encryption: disabled.encryptionAvailable
            ? { available: true }
            : { available: false, reason: 'encryption_unavailable' },
          parser: disabled.parserAvailable
            ? { available: true }
            : { available: false, reason: 'parser_unavailable' },
          cloudbase: { available: false, reason: 'cloudbase_unavailable' },
          embedding: { available: false, reason: 'embedding_unavailable' },
          entitlement: { available: false, reason: 'entitlement_unavailable' },
          beta: { available: false, reason: 'beta_disabled' },
          cloud: { available: false, reason: 'cloud_disabled' },
        }
      }
      current(owner)
      return {
        encryption: { available: true },
        parser: { available: true },
        cloudbase: { available: false, reason: 'cloudbase_unavailable' },
        embedding: { available: false, reason: 'embedding_unavailable' },
        entitlement: { available: false, reason: 'entitlement_unavailable' },
        beta: { available: false, reason: 'beta_disabled' },
        cloud: { available: false, reason: 'cloud_disabled' },
      }
    },
    getEntitlement: async (owner) => {
      if (unavailable?.ownerId === owner.userId && unavailable.epoch === epoch) {
        return { tier: 'free', status: 'unavailable', localEnabled: false, cloudEnabled: false }
      }
      const active = current(owner)
      const member = dependencies.isMember(active.ownerId)
      return { tier: member ? 'member' : 'free', status: 'active', localEnabled: true, cloudEnabled: false }
    },
    getConsent: async (owner) => {
      if (unavailable?.ownerId === owner.userId && unavailable.epoch === epoch) {
        return { provider: 'openrouter', status: 'unknown' }
      }
      current(owner)
      return { provider: 'openrouter', status: 'unknown' }
    },
  }
}
