import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  toSafeAppError,
  type AppError,
  type KnowledgeAvailability,
  type KnowledgeBaseSummary,
  type KnowledgeDocumentPreview,
  type KnowledgeDocumentSummary,
  type KnowledgeEvent,
  type KnowledgeEvidence,
  type KnowledgeImportHandle,
  type KnowledgeEntitlementState,
  type KnowledgeRetentionSelection,
  type KnowledgeSearchResult,
  type KnowledgeSourcePreview,
  type KnowledgeSourcePreviewRequest,
  type ModelProviderId,
  type KnowledgeVersionSummary,
  type SignedKnowledgeEntitlementSnapshot,
} from '@autoforge/shared'
import { KnowledgeExportService } from './export-service.js'
import { ImportJobRunner, type KnowledgeParserPort } from './import-job-runner.js'
import { LocalKnowledgeRetriever } from './local-retriever.js'
import type { LocalKnowledgeVersionScope } from './local-retriever.js'
import type { LocalSemanticSearchPort } from './local-semantic-index.js'
import { CloudKnowledgeRetriever, type CloudCandidate } from './cloud-retriever.js'
import type {
  CloudKnowledgeChange,
  CloudUploadAuthorization,
  CloudUploadRecoveryState,
} from './cloudbase-knowledge-client.js'
import { sanitizeKnowledgeText } from './knowledge-sanitizer.js'
import type { KnowledgeOwner, KnowledgeService } from './knowledge-types.js'
import { PARSER_MEDIA_TYPES, type ParserMediaType } from './parser-protocol.js'
import {
  KnowledgeSyncService,
  type CloudKnowledgeRemote,
  type CloudRetentionState,
} from './sync-service.js'

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
  createSemanticIndex?(store: LocalKnowledgeStore): LocalSemanticSearchPort
  saveExport(name: string, contents: Buffer): Promise<void>
  isMember(ownerId: string): boolean
  /** Main-owned verified projection. Renderer state is never consulted. */
  entitlement?(ownerId: string): KnowledgeEntitlementState
  refreshEntitlement?(ownerId: string): Promise<KnowledgeEntitlementState | undefined>
  verifyEntitlement?(
    ownerId: string,
    snapshot: SignedKnowledgeEntitlementSnapshot,
    observedAt: number,
  ): KnowledgeEntitlementState & { issuedAt?: string; keyId?: string; keyGeneration?: number }
  cloudKillSwitchEnabled?(): boolean
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
  semantic?: LocalSemanticSearchPort
  handles: Map<string, ImportHandleRecord>
  cloud: KnowledgeCloudLifecycle
  cloudOwnerInvalidated: boolean
  cloudOwnerInvalidationFailed: boolean
  cloudOwnerInvalidationFailure?: unknown
  cloudTasks: Set<Promise<unknown>>
  cloudPublications: Map<string, Promise<void>>
  cloudSyncConsentAccepted: boolean
  cloudConsentEpoch: number
}

interface UnavailableBinding {
  ownerId: string
  epoch: number
  encryptionAvailable: boolean
  parserAvailable: boolean
}

export interface LocalKnowledgeService extends KnowledgeService {
  bind(ownerId: string, cloudSyncConsentAccepted?: boolean): Promise<void>
  setCloudSyncConsent?(ownerId: string, accepted: boolean): void
  refreshEntitlement?(
    ownerId: string,
    snapshot?: SignedKnowledgeEntitlementSnapshot,
    authorizationConfirmed?: boolean,
  ): Promise<void>
  invalidate(): void
  drain(): Promise<void>
  configureCloudRemote?(remote: CloudKnowledgeRemote | undefined): void
  restoreDocument(owner: KnowledgeOwner, documentId: string): Promise<void>
  restoreBase(owner: KnowledgeOwner, baseId: string): Promise<void>
  /** Main-only Agent retrieval over the conversation selection captured before the run. */
  captureSearchScope(owner: KnowledgeOwner, baseIds: readonly string[]): Promise<KnowledgeSearchScope>
  releaseSearchScope(scope: KnowledgeSearchScope): void
  searchSelected(
    owner: KnowledgeOwner, query: string, baseIds: readonly string[], signal?: AbortSignal,
    scope?: KnowledgeSearchScope,
  ): Promise<KnowledgeSearchResult>
  sourceAvailable(
    owner: KnowledgeOwner, documentId: string, versionId: string, signal?: AbortSignal,
  ): Promise<boolean>
  sourceVerifiable?(
    owner: KnowledgeOwner, baseId: string, documentId: string, versionId: string,
    signal: AbortSignal | undefined, scope: KnowledgeSearchScope,
  ): Promise<boolean>
}

export interface KnowledgeSearchScopeEntry extends LocalKnowledgeVersionScope {
  readonly cloudGenerationId: string | null
}

export interface KnowledgeSearchScope {
  readonly scopeId: string
  readonly ownerId: string
  readonly ownerEpoch: number
  readonly baseIds: readonly string[]
  readonly entries: readonly KnowledgeSearchScopeEntry[]
  readonly cloudAllowed: boolean
  readonly cloudConsentEpoch?: number
}

interface RetentionSelection {
  baseId: string
  documentId?: string
  confirmed: boolean
}

interface RetentionRecord {
  baseId?: string
  documentId?: string
  confirmed: boolean
}

interface EntitlementProjectionRow {
  tier: KnowledgeEntitlementState['tier']
  status: KnowledgeEntitlementState['status']
  betaEnabled: number
  cloudEnabled: number
  membershipVersion: number
  planId: 'free' | 'pro'
  knowledgeBaseLimit: number
  knowledgeDocumentLimit: number
  knowledgeFileBytes: number
  expiresAt: number | null
  graceEndsAt: number | null
  epoch: number
  acceptedIssuedAt: number | null
  acceptedKeyId: string | null
  acceptedKeyGeneration: number
  acceptedSnapshotDigest: string | null
  verified: number
  explicitFree: number
  maxObservedAt: number
}

interface KnowledgeCloudLifecycle {
  setCloudAccess(allowed: boolean): void
  enableSync(input: {
    requestId: string
    knowledgeBaseId: string
    name: string
    revision: string
    generationId: string
  }): Promise<void>
  enqueue(input: Parameters<KnowledgeSyncService['enqueue']>[0]): void
  synchronize(knowledgeBaseId: string): Promise<unknown>
  synchronizeRemoteProjection(knowledgeBaseId: string): Promise<unknown>
  synchronizeOwnerCatalog(): Promise<readonly string[]>
  resume(knowledgeBaseId: string): void
  publishGeneration(input: {
    requestId: string
    knowledgeBaseId: string
    generationId: string
  }): Promise<void>
  recordOrphan(knowledgeBaseId: string, storageReference: string): void
  cleanupOrphans(knowledgeBaseId: string): Promise<void>
  beginCloudRetention(knowledgeBaseId: string, boundaryAt: number): CloudRetentionState
  advanceCloudRetention(knowledgeBaseId: string): Promise<CloudRetentionState | undefined>
  purgeCloudImmediately(knowledgeBaseId: string): Promise<void>
  invalidateOwner(): void
  drain(): Promise<void>
}

type ProductionCloudKnowledgeRemote = CloudKnowledgeRemote & Required<Pick<
  CloudKnowledgeRemote, 'beginGeneration' | 'uploadDocument' | 'search' | 'listKnowledgeBases'
>>

function productionCloudRemote(
  remote: CloudKnowledgeRemote | undefined,
): ProductionCloudKnowledgeRemote | undefined {
  return remote
    && typeof remote.beginGeneration === 'function'
    && typeof remote.uploadDocument === 'function'
    && typeof remote.search === 'function'
    && typeof remote.listKnowledgeBases === 'function'
    ? remote as ProductionCloudKnowledgeRemote
    : undefined
}

function classifyPublicationFailure(error: unknown): { code: string; retryable: boolean } {
  const candidate = typeof error === 'object' && error !== null
    ? error as { code?: unknown; retryable?: unknown }
    : {}
  const code = typeof candidate.code === 'string'
    && /^[A-Z][A-Z0-9_]{0,63}$/u.test(candidate.code)
    ? candidate.code
    : 'INTERNAL_ERROR'
  return {
    code,
    retryable: code === 'TRANSIENT_FAILURE' && candidate.retryable === true,
  }
}

function fail(code: AppError['code']): never {
  throw toSafeAppError({ code })
}

function timestamp(value: number): string {
  return new Date(value).toISOString()
}

function baseSummary(
  database: Database.Database,
  baseId: string,
  readOnly = false,
): KnowledgeBaseSummary | undefined {
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
    status: readOnly && row.lifecycle_status !== 'recycled' ? 'read_only' : row.lifecycle_status,
    searchable: !readOnly && row.lifecycle_status !== 'recycled' && row.searchable === 1,
    documentCount: row.document_count,
    updatedAt: timestamp(row.updated_at),
    ...(readOnly ? { readOnly: true } : {}),
  }
}

function documentSummary(
  database: Database.Database,
  documentId: string,
  readOnly = false,
): KnowledgeDocumentSummary | undefined {
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
    ...(readOnly ? { readOnly: true } : {}),
  }
}

function remoteBaseSummary(
  database: Database.Database,
  baseId: string,
): KnowledgeBaseSummary | undefined {
  const row = database.prepare(`
    SELECT base.id, base.name, base.updated_at,
      count(document.id) AS document_count,
      max(CASE WHEN version.id IS NOT NULL THEN 1 ELSE 0 END) AS searchable
    FROM cloud_base_projections AS base
    LEFT JOIN cloud_document_projections AS document
      ON document.knowledge_base_id = base.id AND document.status = 'ready'
    LEFT JOIN cloud_version_projections AS version
      ON version.id = document.active_version_id
      AND version.document_id = document.id
      AND version.generation_id = base.published_generation_id
      AND version.local_object_available = 0
    WHERE base.id = ?
    GROUP BY base.id
  `).get(baseId) as {
    id: string
    name: string
    updated_at: number
    document_count: number
    searchable: number
  } | undefined
  if (!row) return undefined
  return {
    id: row.id,
    name: row.name,
    kind: 'cloud',
    status: 'read_only',
    searchable: row.searchable === 1,
    documentCount: row.document_count,
    updatedAt: timestamp(row.updated_at),
    readOnly: true,
  }
}

function remoteDocumentSummary(
  database: Database.Database,
  documentId: string,
): KnowledgeDocumentSummary | undefined {
  const row = database.prepare(`
    SELECT document.id, document.knowledge_base_id, document.name, document.mime_type,
      document.status, document.updated_at, count(version.id) AS version_count
    FROM cloud_document_projections AS document
    LEFT JOIN cloud_version_projections AS version ON version.document_id = document.id
    WHERE document.id = ?
    GROUP BY document.id
  `).get(documentId) as {
    id: string
    knowledge_base_id: string
    name: string
    mime_type: string
    status: KnowledgeDocumentSummary['status']
    updated_at: number
    version_count: number
  } | undefined
  if (!row) return undefined
  return {
    id: row.id,
    baseId: row.knowledge_base_id,
    name: row.name,
    mimeType: row.mime_type,
    status: row.status,
    versionCount: row.version_count,
    updatedAt: timestamp(row.updated_at),
    readOnly: true,
  }
}

export function createLocalKnowledgeService(
  dependencies: LocalKnowledgeServiceDependencies,
): LocalKnowledgeService {
  let epoch = 0
  let binding: Binding | undefined
  let unavailable: UnavailableBinding | undefined
  let lifecycleTail = Promise.resolve()
  let refreshedEntitlement: { ownerId: string; epoch: number; state: KnowledgeEntitlementState } | undefined
  let cloudRemote: CloudKnowledgeRemote | undefined
  const activeSearchScopes = new Map<string, KnowledgeSearchScope>()
  let lifecycleFailure: unknown
  let hasLifecycleFailure = false
  const retiring = new Set<Promise<void>>()
  const pendingRetirements = new Set<Binding>()
  const now = dependencies.now ?? Date.now
  const id = dependencies.id ?? randomUUID

  const failClosedCloudLifecycle = (database: Database.Database): KnowledgeCloudLifecycle => {
    let appliedCloudAccess = false
    return {
    setCloudAccess: () => {
      if (appliedCloudAccess) return
      appliedCloudAccess = true
      database.prepare(`
        UPDATE cloud_sync_states SET mode = CASE WHEN mode = 'converting' THEN mode ELSE 'paused' END,
          epoch = epoch + 1, updated_at = ? WHERE mode <> 'local_only'
      `).run(now())
    },
    enableSync: async () => fail('SERVICE_UNAVAILABLE'),
    enqueue: () => fail('SERVICE_UNAVAILABLE'),
    synchronize: async () => fail('SERVICE_UNAVAILABLE'),
    synchronizeRemoteProjection: async () => fail('SERVICE_UNAVAILABLE'),
    synchronizeOwnerCatalog: async () => fail('SERVICE_UNAVAILABLE'),
    resume: () => fail('SERVICE_UNAVAILABLE'),
    publishGeneration: async () => fail('SERVICE_UNAVAILABLE'),
    recordOrphan: () => fail('SERVICE_UNAVAILABLE'),
    cleanupOrphans: async () => fail('SERVICE_UNAVAILABLE'),
    beginCloudRetention: (knowledgeBaseId, boundaryAt) => {
      const select = () => database.prepare(`
        SELECT knowledge_base_id AS knowledgeBaseId, stage, download_until AS downloadUntil,
          recycle_until AS recycleUntil, epoch FROM knowledge_cloud_retention
        WHERE knowledge_base_id = ?
      `).get(knowledgeBaseId) as CloudRetentionState | undefined
      const existing = select()
      if (existing) return existing
      const operationId = id()
      const generatedRequestId = id()
      const requestId = generatedRequestId === operationId
        ? `retention:${operationId}`.slice(0, 128)
        : generatedRequestId
      database.prepare(`
        INSERT INTO knowledge_cloud_retention(
          knowledge_base_id, stage, download_until, recycle_until, operation_id,
          request_id, deletion_job_id, epoch, updated_at
        ) VALUES (?, 'download_window', ?, ?, ?, ?, NULL, 1, ?)
      `).run(
        knowledgeBaseId,
        boundaryAt + (30 * 24 * 60 * 60 * 1_000),
        boundaryAt + (60 * 24 * 60 * 60 * 1_000),
        operationId, requestId, now(),
      )
      return select()!
    },
    advanceCloudRetention: async (knowledgeBaseId) => {
      const select = () => database.prepare(`
        SELECT knowledge_base_id AS knowledgeBaseId, stage, download_until AS downloadUntil,
          recycle_until AS recycleUntil, epoch FROM knowledge_cloud_retention
        WHERE knowledge_base_id = ?
      `).get(knowledgeBaseId) as CloudRetentionState | undefined
      const current = select()
      if (!current) return undefined
      const stage = now() >= current.recycleUntil
        ? 'purging'
        : now() >= current.downloadUntil ? 'recycle' : current.stage
      if (stage !== current.stage) database.prepare(`
        UPDATE knowledge_cloud_retention SET stage = ?, epoch = epoch + 1, updated_at = ?
        WHERE knowledge_base_id = ? AND epoch = ?
      `).run(stage, now(), knowledgeBaseId, current.epoch)
      return select()
    },
    purgeCloudImmediately: async (knowledgeBaseId) => {
      const completed = database.prepare(`
        SELECT 1 AS completed FROM knowledge_cloud_deletion_receipts
        WHERE knowledge_base_id = ?
      `).get(knowledgeBaseId)
      if (completed) return
      fail('SERVICE_UNAVAILABLE')
    },
    invalidateOwner: () => {
      database.prepare(`
        UPDATE cloud_sync_states SET mode = 'paused', epoch = epoch + 1, updated_at = ?
        WHERE mode <> 'local_only'
      `).run(now())
    },
    drain: async () => undefined,
    }
  }

  const createCloudLifecycle = (store: LocalKnowledgeStore): KnowledgeCloudLifecycle => {
    if (!cloudRemote) return failClosedCloudLifecycle(store.database)
    type RemoteBasePayload = {
      name?: string
      publishedGenerationId?: string | null
    }
    type RemoteDocumentPayload = {
      name: string
      mimeType: string
      versionId: string
      versionNumber: number
      contentHash: string
      generationId: string
      createdAt: number
    }
    const isRecord = (value: unknown): value is Record<string, unknown> => (
      typeof value === 'object' && value !== null && !Array.isArray(value)
    )
    const exactKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => {
      const expected = new Set(allowed)
      return Object.keys(value).every(key => expected.has(key))
    }
    const identifier = (value: unknown): value is string => (
      typeof value === 'string' && value.length > 0 && value.length <= 128
      && value.trim() === value
    )
    const basePayload = (value: unknown): RemoteBasePayload | undefined => {
      if (!isRecord(value) || !exactKeys(value, ['name', 'publishedGenerationId'])) {
        return undefined
      }
      if (!Object.hasOwn(value, 'name') && !Object.hasOwn(value, 'publishedGenerationId')) {
        return undefined
      }
      if (Object.hasOwn(value, 'name')
        && (typeof value.name !== 'string' || value.name.length === 0
          || value.name.length > 200 || value.name.trim() !== value.name)) return undefined
      if (Object.hasOwn(value, 'publishedGenerationId')
        && value.publishedGenerationId !== null
        && !identifier(value.publishedGenerationId)) return undefined
      return value as RemoteBasePayload
    }
    const documentPayload = (value: unknown): RemoteDocumentPayload | undefined => {
      if (!isRecord(value) || !exactKeys(value, [
        'name', 'mimeType', 'versionId', 'versionNumber', 'contentHash',
        'generationId', 'createdAt',
      ]) || Object.keys(value).length !== 7
        || typeof value.name !== 'string' || value.name.length === 0
        || value.name.length > 500 || value.name.trim() !== value.name
        || typeof value.mimeType !== 'string' || !mediaTypes.has(value.mimeType)
        || !identifier(value.versionId) || !identifier(value.generationId)
        || !Number.isSafeInteger(value.versionNumber) || Number(value.versionNumber) <= 0
        || typeof value.contentHash !== 'string'
        || !/^[a-f0-9]{64}$/u.test(value.contentHash)
        || !Number.isSafeInteger(value.createdAt) || Number(value.createdAt) < 0) {
        return undefined
      }
      return value as unknown as RemoteDocumentPayload
    }
    const storedHeadPayload = (
      knowledgeBaseId: string,
      entityKind: CloudKnowledgeChange['entityKind'],
      entityId: string,
    ): Record<string, unknown> | undefined => {
      const row = store.database.prepare(`
        SELECT payload_json AS payloadJson FROM cloud_remote_entity_heads
        WHERE knowledge_base_id = ? AND entity_kind = ? AND entity_id = ? AND deleted = 0
      `).get(knowledgeBaseId, entityKind, entityId) as { payloadJson: string } | undefined
      if (!row) return undefined
      try {
        const parsed: unknown = JSON.parse(row.payloadJson)
        return isRecord(parsed) ? parsed : undefined
      } catch {
        return undefined
      }
    }
    const rebuildRemoteProjection = (knowledgeBaseId: string): void => {
      store.database.prepare(
        'DELETE FROM cloud_base_projections WHERE id = ?',
      ).run(knowledgeBaseId)
      const baseHead = store.database.prepare(`
        SELECT revision, payload_json AS payloadJson, updated_at AS updatedAt
        FROM cloud_remote_entity_heads
        WHERE knowledge_base_id = ? AND entity_kind = 'knowledge_base'
          AND entity_id = ? AND deleted = 0
      `).get(knowledgeBaseId, knowledgeBaseId) as {
        revision: string
        payloadJson: string
        updatedAt: number
      } | undefined
      if (!baseHead) return
      let parsedBase: unknown
      try { parsedBase = JSON.parse(baseHead.payloadJson) } catch { fail('INVALID_INPUT') }
      const base = basePayload(parsedBase)
      if (!base || typeof base.name !== 'string'
        || !Object.hasOwn(base, 'publishedGenerationId')) return
      store.database.prepare(`
        INSERT INTO cloud_base_projections(
          id, name, status, published_generation_id, revision, updated_at
        ) VALUES (?, ?, 'ready', ?, ?, ?)
      `).run(
        knowledgeBaseId, base.name, base.publishedGenerationId,
        baseHead.revision, baseHead.updatedAt,
      )
      if (!base.publishedGenerationId) return
      store.database.prepare(`
        INSERT INTO cloud_generation_projections(
          id, knowledge_base_id, status, revision, updated_at
        ) VALUES (?, ?, 'published', ?, ?)
      `).run(
        base.publishedGenerationId, knowledgeBaseId,
        baseHead.revision, baseHead.updatedAt,
      )
      const documentHeads = store.database.prepare(`
        SELECT entity_id AS entityId, revision, payload_json AS payloadJson,
          updated_at AS updatedAt
        FROM cloud_remote_entity_heads
        WHERE knowledge_base_id = ? AND entity_kind = 'document' AND deleted = 0
        ORDER BY entity_id
      `).all(knowledgeBaseId) as Array<{
        entityId: string
        revision: string
        payloadJson: string
        updatedAt: number
      }>
      for (const head of documentHeads) {
        let parsed: unknown
        try { parsed = JSON.parse(head.payloadJson) } catch { fail('INVALID_INPUT') }
        const document = documentPayload(parsed)
        if (!document || document.generationId !== base.publishedGenerationId) continue
        store.database.prepare(`
          INSERT INTO cloud_document_projections(
            id, knowledge_base_id, name, mime_type, active_version_id,
            status, revision, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'ready', ?, ?)
        `).run(
          head.entityId, knowledgeBaseId, document.name, document.mimeType,
          document.versionId, head.revision, head.updatedAt,
        )
        store.database.prepare(`
          INSERT INTO cloud_version_projections(
            id, knowledge_base_id, document_id, version_number, status,
            content_hash, generation_id, created_at, local_object_available,
            revision, updated_at
          ) VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, 0, ?, ?)
        `).run(
          document.versionId, knowledgeBaseId, head.entityId, document.versionNumber,
          document.contentHash, document.generationId, document.createdAt,
          head.revision, head.updatedAt,
        )
      }
    }
    const writeHead = (
      change: CloudKnowledgeChange,
      guard: {
        readonly knowledgeBaseId: string
        readonly projection: 'local' | 'remote'
      },
    ): void => {
      let payload = change.payload
      if (guard.projection === 'remote' && change.operation === 'upsert') {
        if (change.entityKind === 'knowledge_base') {
          if (change.entityId !== guard.knowledgeBaseId || !basePayload(payload)) {
            fail('INVALID_INPUT')
          }
          payload = {
            ...storedHeadPayload(
              guard.knowledgeBaseId, change.entityKind, change.entityId,
            ),
            ...payload,
          }
          if (!basePayload(payload)) fail('INVALID_INPUT')
        } else if (change.entityKind === 'document' && !documentPayload(payload)) {
          fail('INVALID_INPUT')
        }
      }
      const payloadJson = JSON.stringify(payload)
      if (Buffer.byteLength(payloadJson, 'utf8') > 64 * 1_024) fail('INVALID_INPUT')
      store.database.prepare(`
        INSERT INTO ${guard.projection === 'remote'
          ? 'cloud_remote_entity_heads' : 'cloud_entity_heads'}(
          knowledge_base_id, entity_kind, entity_id, revision, payload_json, deleted, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(knowledge_base_id, entity_kind, entity_id) DO UPDATE SET
          revision = excluded.revision, payload_json = excluded.payload_json,
          deleted = excluded.deleted, updated_at = excluded.updated_at
      `).run(
        guard.knowledgeBaseId, change.entityKind, change.entityId, change.revision,
        payloadJson, Number(change.operation === 'delete'), now(),
      )
      if (guard.projection === 'remote') rebuildRemoteProjection(guard.knowledgeBaseId)
    }
    return new KnowledgeSyncService(store.database, cloudRemote, {
      now,
      id,
      isOnline: () => true,
      applyRemoteChange: async (change, guard) => guard.commitIncremental(
        change.sequence, () => writeHead(change, guard),
      ),
      replaceRemoteSnapshot: async (changes, guard, nextSequence) => (
        guard.commitSnapshot(nextSequence, () => {
          store.database.prepare(`
            DELETE FROM ${guard.projection === 'remote'
              ? 'cloud_remote_entity_heads' : 'cloud_entity_heads'}
            WHERE knowledge_base_id = ?
          `).run(guard.knowledgeBaseId)
          for (const change of changes) writeHead(change, guard)
          if (guard.projection === 'remote') rebuildRemoteProjection(guard.knowledgeBaseId)
        })
      ),
    })
  }

  const beginDurableCloudRetention = (active: Binding, boundaryAt: number): void => {
    const database = active.store.database
    const rows = database.prepare(`
      SELECT knowledge_base_id AS knowledgeBaseId FROM cloud_sync_states
      WHERE mode <> 'local_only'
      UNION SELECT knowledge_base_id AS knowledgeBaseId FROM knowledge_cloud_retention
    `).all() as Array<{ knowledgeBaseId: string }>
    for (const row of rows) {
      const operationId = id()
      const generatedRequestId = id()
      const requestId = generatedRequestId === operationId
        ? `retention:${operationId}`.slice(0, 128)
        : generatedRequestId
      database.prepare(`
        INSERT INTO knowledge_cloud_retention(
          knowledge_base_id, stage, download_until, recycle_until, operation_id,
          request_id, deletion_job_id, epoch, updated_at
        ) VALUES (?, 'download_window', ?, ?, ?, ?, NULL, 1, ?)
        ON CONFLICT(knowledge_base_id) DO NOTHING
      `).run(
        row.knowledgeBaseId,
        boundaryAt + (30 * 24 * 60 * 60 * 1_000),
        boundaryAt + (60 * 24 * 60 * 60 * 1_000),
        operationId, requestId, boundaryAt,
      )
    }
    database.prepare(`
      UPDATE cloud_sync_states SET mode = CASE WHEN mode = 'converting' THEN mode ELSE 'paused' END,
        epoch = epoch + 1, updated_at = ? WHERE mode <> 'local_only' AND mode <> 'paused'
    `).run(boundaryAt)
  }

  const reconcileCloud = (active: Binding, state: KnowledgeEntitlementState): void => {
    const verified = (active.store.database.prepare(`
      SELECT verified FROM knowledge_entitlement_projection WHERE singleton = 1
    `).get() as { verified: number } | undefined)?.verified === 1
    const allowed = productionCloudRemote(cloudRemote) !== undefined
      && active.cloudSyncConsentAccepted
      && verified
      && state.cloudEnabled
      && state.betaEnabled === true
      && state.tier === 'member'
      && (state.status === 'active' || state.status === 'offline_grace')
      && dependencies.cloudKillSwitchEnabled?.() === false
    active.cloud.setCloudAccess(allowed)
    const projection = active.store.database.prepare(`
      SELECT explicit_free AS explicitFree, accepted_issued_at AS acceptedIssuedAt
      FROM knowledge_entitlement_projection WHERE singleton = 1
    `).get() as { explicitFree: number; acceptedIssuedAt: number | null } | undefined
    const boundaryAt = state.status === 'expired'
      ? state.graceEndsAt ? Date.parse(state.graceEndsAt) : NaN
      : projection?.explicitFree === 1 ? projection.acceptedIssuedAt ?? NaN : NaN
    if (!Number.isSafeInteger(boundaryAt) || boundaryAt < 0) return
    beginDurableCloudRetention(active, boundaryAt)
    const rows = active.store.database.prepare(`
      SELECT knowledge_base_id AS knowledgeBaseId FROM knowledge_cloud_retention
    `).all() as Array<{ knowledgeBaseId: string }>
    for (const row of rows) {
      const advancing = active.cloud.advanceCloudRetention(row.knowledgeBaseId)
      active.cloudTasks.add(advancing)
      void advancing.then(
        () => active.cloudTasks.delete(advancing),
        () => active.cloudTasks.delete(advancing),
      )
    }
  }

  const readProjection = (active: Binding): EntitlementProjectionRow | undefined => (
    active.store.database.prepare(`
      SELECT tier, status, beta_enabled AS betaEnabled, cloud_enabled AS cloudEnabled,
        membership_version AS membershipVersion, plan_id AS planId,
        knowledge_base_limit AS knowledgeBaseLimit,
        knowledge_document_limit AS knowledgeDocumentLimit,
        knowledge_file_bytes AS knowledgeFileBytes,
        expires_at AS expiresAt, grace_ends_at AS graceEndsAt, epoch,
        accepted_issued_at AS acceptedIssuedAt, accepted_key_id AS acceptedKeyId,
        accepted_key_generation AS acceptedKeyGeneration,
        accepted_snapshot_digest AS acceptedSnapshotDigest, verified, explicit_free AS explicitFree,
        max_observed_at AS maxObservedAt
      FROM knowledge_entitlement_projection WHERE singleton = 1
    `).get() as EntitlementProjectionRow | undefined
  )

  const writeProjection = (
    active: Binding,
    state: KnowledgeEntitlementState,
    options: {
      verified?: boolean
      explicitFree?: boolean
      acceptedIssuedAt?: number | null
      acceptedKeyId?: string | null
      acceptedKeyGeneration?: number
      acceptedSnapshotDigest?: string | null
      observedAt: number
    },
  ): void => {
    const current = readProjection(active)
    const expiresAt = state.expiresAt ? Date.parse(state.expiresAt) : null
    const graceEndsAt = state.graceEndsAt ? Date.parse(state.graceEndsAt) : null
    const limits = state.limits ?? (state.tier === 'member'
      ? { knowledgeBases: 20, knowledgeDocuments: 500, knowledgeFileBytes: 67_108_864 }
      : { knowledgeBases: 1, knowledgeDocuments: 1, knowledgeFileBytes: 67_108_864 })
    active.store.database.prepare(`
      INSERT INTO knowledge_entitlement_projection(
        singleton, tier, status, beta_enabled, cloud_enabled, membership_version, plan_id,
        knowledge_base_limit, knowledge_document_limit, knowledge_file_bytes, expires_at,
        grace_ends_at, epoch, updated_at, accepted_issued_at, accepted_key_id,
        accepted_key_generation, accepted_snapshot_digest, verified, explicit_free, max_observed_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        tier = excluded.tier, status = excluded.status,
        beta_enabled = excluded.beta_enabled, cloud_enabled = excluded.cloud_enabled,
        membership_version = excluded.membership_version, plan_id = excluded.plan_id,
        knowledge_base_limit = excluded.knowledge_base_limit,
        knowledge_document_limit = excluded.knowledge_document_limit,
        knowledge_file_bytes = excluded.knowledge_file_bytes,
        expires_at = excluded.expires_at, grace_ends_at = excluded.grace_ends_at,
        epoch = knowledge_entitlement_projection.epoch + 1, updated_at = excluded.updated_at,
        accepted_issued_at = excluded.accepted_issued_at,
        accepted_key_id = excluded.accepted_key_id,
        accepted_key_generation = excluded.accepted_key_generation,
        accepted_snapshot_digest = excluded.accepted_snapshot_digest,
        verified = excluded.verified, explicit_free = excluded.explicit_free,
        max_observed_at = excluded.max_observed_at
    `).run(
      state.tier, state.status, Number(state.betaEnabled === true), Number(state.cloudEnabled),
      state.membershipVersion ?? 0, state.planId ?? (state.tier === 'member' ? 'pro' : 'free'),
      limits.knowledgeBases, limits.knowledgeDocuments, limits.knowledgeFileBytes,
      expiresAt, graceEndsAt, options.observedAt,
      options.acceptedIssuedAt ?? current?.acceptedIssuedAt ?? null,
      options.acceptedKeyId ?? current?.acceptedKeyId ?? null,
      options.acceptedKeyGeneration ?? current?.acceptedKeyGeneration ?? 0,
      options.acceptedSnapshotDigest ?? current?.acceptedSnapshotDigest ?? null,
      Number(options.verified === true), Number(options.explicitFree === true),
      Math.max(options.observedAt, current?.maxObservedAt ?? 0),
    )
  }

  const entitlement = (active: Binding): KnowledgeEntitlementState => {
    const current = readProjection(active)
    const observedAt = Math.max(now(), current?.maxObservedAt ?? 0)
    const persisted = current && (current.verified === 1 || current.explicitFree === 1)
      ? {
          tier: current.tier,
          status: current.status,
          localEnabled: true as const,
          betaEnabled: current.betaEnabled === 1,
          cloudEnabled: current.cloudEnabled === 1,
          planId: current.planId,
          membershipVersion: current.membershipVersion,
          limits: {
            knowledgeBases: current.knowledgeBaseLimit,
            knowledgeDocuments: current.knowledgeDocumentLimit,
            knowledgeFileBytes: current.knowledgeFileBytes,
          },
          ...(current.expiresAt !== null ? { expiresAt: timestamp(current.expiresAt) } : {}),
          ...(current.graceEndsAt !== null ? { graceEndsAt: timestamp(current.graceEndsAt) } : {}),
        }
      : undefined
    const raw = persisted ?? (refreshedEntitlement?.ownerId === active.ownerId
      && refreshedEntitlement.epoch === active.epoch
      ? refreshedEntitlement.state
      : dependencies.entitlement?.(active.ownerId)) ?? {
      tier: dependencies.isMember(active.ownerId) ? 'member' as const : 'free' as const,
      status: 'active' as const,
      localEnabled: true,
      cloudEnabled: false,
    }
    const expiry = raw.expiresAt ? Date.parse(raw.expiresAt) : undefined
    const graceEnd = raw.graceEndsAt ? Date.parse(raw.graceEndsAt) : undefined
    const checkedAt = observedAt
    const projected: KnowledgeEntitlementState = (raw.status === 'active' || raw.status === 'offline_grace')
      && expiry !== undefined && graceEnd !== undefined
      && Number.isFinite(expiry) && Number.isFinite(graceEnd)
      ? checkedAt <= expiry
        ? { ...raw, status: 'active' }
        : checkedAt <= graceEnd
          ? { ...raw, status: 'offline_grace' }
          : { ...raw, tier: 'free', status: 'expired', betaEnabled: false, cloudEnabled: false }
      : raw
    const expiresAt = projected.expiresAt ? Date.parse(projected.expiresAt) : null
    const graceEndsAt = projected.graceEndsAt ? Date.parse(projected.graceEndsAt) : null
    const betaEnabled = projected.betaEnabled === true
    const changed = !current
      || current.tier !== projected.tier || current.status !== projected.status
      || current.betaEnabled !== Number(betaEnabled)
      || current.cloudEnabled !== Number(projected.cloudEnabled)
      || current.membershipVersion !== (projected.membershipVersion ?? 0)
      || current.planId !== (projected.planId ?? (projected.tier === 'member' ? 'pro' : 'free'))
      || current.knowledgeBaseLimit !== (projected.limits?.knowledgeBases
        ?? (projected.tier === 'member' ? 20 : 1))
      || current.knowledgeDocumentLimit !== (projected.limits?.knowledgeDocuments
        ?? (projected.tier === 'member' ? 500 : 1))
      || current.knowledgeFileBytes !== (projected.limits?.knowledgeFileBytes ?? 67_108_864)
      || current.expiresAt !== expiresAt || current.graceEndsAt !== graceEndsAt
      || current.maxObservedAt !== observedAt
    if (changed) {
      writeProjection(active, projected, {
        verified: current?.verified === 1,
        explicitFree: current?.explicitFree === 1,
        observedAt,
      })
    }
    reconcileCloud(active, projected)
    return projected
  }

  const storedRetention = (active: Binding): RetentionRecord | undefined => {
    const row = active.store.database.prepare(`
      SELECT retention.knowledge_base_id AS baseId, retention.document_id AS documentId,
        retention.confirmed
      FROM knowledge_free_retention AS retention
      WHERE retention.singleton = 1
    `).get() as { baseId: string | null; documentId: string | null; confirmed: number } | undefined
    return row ? {
      ...(row.baseId ? { baseId: row.baseId } : {}),
      ...(row.documentId ? { documentId: row.documentId } : {}),
      confirmed: row.confirmed === 1,
    } : undefined
  }

  const writeRetention = (active: Binding, selection: RetentionSelection): void => {
    const epochRow = active.store.database.prepare(
      'SELECT epoch FROM knowledge_entitlement_projection WHERE singleton = 1',
    ).get() as { epoch: number } | undefined
    active.store.database.prepare(`
      INSERT INTO knowledge_free_retention(
        singleton, knowledge_base_id, document_id, confirmed, entitlement_epoch, updated_at
      ) VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        knowledge_base_id = excluded.knowledge_base_id,
        document_id = excluded.document_id,
        confirmed = excluded.confirmed,
        entitlement_epoch = excluded.entitlement_epoch,
        updated_at = excluded.updated_at
    `).run(
      selection.baseId, selection.documentId ?? null, Number(selection.confirmed),
      epochRow?.epoch ?? 0, now(),
    )
  }

  const retention = (active: Binding, state = entitlement(active)): RetentionSelection | undefined => {
    if (state.tier === 'member' && state.status !== 'expired') return undefined
    const stored = storedRetention(active)
    if (stored) return stored.baseId ? stored as RetentionSelection : undefined
    const selected = active.store.database.prepare(`
      SELECT base.id AS baseId, document.id AS documentId
      FROM knowledge_bases AS base
      LEFT JOIN documents AS document
        ON document.knowledge_base_id = base.id AND document.recycled_at IS NULL
      WHERE base.recycled_at IS NULL
      ORDER BY base.created_at, base.rowid, document.created_at, document.rowid
      LIMIT 1
    `).get() as { baseId: string; documentId: string | null } | undefined
    const normalized = selected
      ? {
          baseId: selected.baseId,
          ...(selected.documentId ? { documentId: selected.documentId } : {}),
          confirmed: false,
        }
      : undefined
    if (normalized) writeRetention(active, normalized)
    return normalized
  }

  const isMember = (active: Binding): boolean => {
    const state = entitlement(active)
    return state.tier === 'member' && state.status !== 'expired'
  }

  const limits = (active: Binding) => {
    const state = entitlement(active)
    return state.limits ?? (state.tier === 'member'
      ? { knowledgeBases: 20, knowledgeDocuments: 500, knowledgeFileBytes: 67_108_864 }
      : { knowledgeBases: 1, knowledgeDocuments: 1, knowledgeFileBytes: 67_108_864 })
  }

  const assertWritableBase = (active: Binding, baseId: string): void => {
    if (isMember(active)) return
    const kept = retention(active)
    if (!kept || kept.baseId !== baseId || (!kept.confirmed && kept.documentId !== undefined)) {
      fail('FORBIDDEN')
    }
  }

  const assertWritableDocument = (active: Binding, documentId: string): void => {
    if (isMember(active)) return
    const kept = retention(active)
    if (!kept?.confirmed || !kept.documentId || kept.documentId !== documentId) fail('FORBIDDEN')
  }

  const ordinaryCloudAllowed = (active: Binding): boolean => {
    const state = entitlement(active)
    return productionCloudRemote(cloudRemote) !== undefined
      && active.cloudSyncConsentAccepted
      && readProjection(active)?.verified === 1
      && state.tier === 'member'
      && (state.status === 'active' || state.status === 'offline_grace')
      && state.betaEnabled === true
      && state.cloudEnabled
      && dependencies.cloudKillSwitchEnabled?.() === false
  }

  const isCloudConsentCurrent = (active: Binding, consentEpoch: number): boolean => (
    active.cloudSyncConsentAccepted && active.cloudConsentEpoch === consentEpoch
  )

  const assertCurrentBinding = (active: Binding): void => {
    if (binding !== active || active.epoch !== epoch) fail('CONFLICT')
  }

  const stableCloudId = (prefix: string, ...parts: readonly string[]): string => (
    `${prefix}:${createHash('sha256').update(parts.join('\u0000')).digest('hex')}`
  )

  interface PendingCloudPublication {
    knowledgeBaseId: string
    generationId: string
    documentId: string
    versionId: string
    objectId: string
    uploadJobId: string | null
    publishRequestId: string
    baseName: string
    documentName: string
    mimeType: string
    versionNumber: number
    contentHash: string
    createdAt: number
    recoveryAttempt: number
    nextRetryAt: number
    lastErrorCode: string | null
    uploadAttempt: number
    uploadRequestId: string | null
    uploadTicket: string | null
    storageReference: string | null
    uploadAuthorizationJson: string | null
    uploadAuthorizationExpiresAt: number | null
    uploadPutCompleted: number
    uploadVerified: number
    uploadRetiring: number
  }

  const pendingCloudPublication = (
    active: Binding,
    knowledgeBaseId: string,
  ): PendingCloudPublication | undefined => active.store.database.prepare(`
    SELECT pending.knowledge_base_id AS knowledgeBaseId,
      pending.generation_id AS generationId, pending.document_id AS documentId,
      pending.version_id AS versionId, pending.object_id AS objectId,
      pending.upload_job_id AS uploadJobId, pending.publish_request_id AS publishRequestId,
      pending.recovery_attempt AS recoveryAttempt, pending.next_retry_at AS nextRetryAt,
      pending.last_error_code AS lastErrorCode,
      pending.upload_attempt AS uploadAttempt,
      pending.upload_request_id AS uploadRequestId,
      pending.upload_ticket AS uploadTicket,
      pending.storage_reference AS storageReference,
      pending.upload_authorization_json AS uploadAuthorizationJson,
      pending.upload_authorization_expires_at AS uploadAuthorizationExpiresAt,
      pending.upload_put_completed AS uploadPutCompleted,
      pending.upload_verified AS uploadVerified,
      pending.upload_retiring AS uploadRetiring,
      base.name AS baseName, document.name AS documentName, version.mime_type AS mimeType,
      version.version_number AS versionNumber, version.content_hash AS contentHash,
      version.created_at AS createdAt
    FROM cloud_pending_publications AS pending
    JOIN knowledge_bases AS base ON base.id = pending.knowledge_base_id
    JOIN documents AS document ON document.id = pending.document_id
      AND document.knowledge_base_id = pending.knowledge_base_id
    JOIN document_versions AS version ON version.id = pending.version_id
      AND version.document_id = pending.document_id
    WHERE pending.knowledge_base_id = ?
  `).get(knowledgeBaseId) as PendingCloudPublication | undefined

  const persistedUploadRecovery = (
    pending: PendingCloudPublication,
  ): CloudUploadRecoveryState | undefined => {
    if (!pending.uploadAuthorizationJson) return undefined
    let candidate: unknown
    try { candidate = JSON.parse(pending.uploadAuthorizationJson) } catch { fail('INTERNAL_ERROR') }
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      fail('INTERNAL_ERROR')
    }
    const authorization = candidate as Partial<CloudUploadAuthorization>
    const expiresAt = typeof authorization.expiresAt === 'string'
      ? Date.parse(authorization.expiresAt)
      : Number.NaN
    if (!pending.uploadRequestId || !pending.uploadTicket || !pending.storageReference
      || pending.uploadJobId === null || !Number.isSafeInteger(expiresAt)
      || authorization.uploadTicket !== pending.uploadTicket
      || authorization.storageReference !== pending.storageReference
      || authorization.jobId !== pending.uploadJobId
      || expiresAt !== pending.uploadAuthorizationExpiresAt) {
      fail('INTERNAL_ERROR')
    }
    return {
      authorization: authorization as CloudUploadAuthorization,
      putCompleted: pending.uploadPutCompleted === 1,
    }
  }

  const finalizeRetiredCloudPublication = (active: Binding, knowledgeBaseId: string): void => {
    active.store.database.prepare(`
      UPDATE cloud_pending_publications
      SET upload_request_id = NULL, upload_ticket = NULL, upload_job_id = NULL,
        storage_reference = NULL, upload_authorization_json = NULL,
        upload_authorization_expires_at = NULL, upload_put_completed = 0,
        upload_retiring = 0, updated_at = ?
      WHERE knowledge_base_id = ? AND upload_verified = 0 AND upload_retiring = 1
        AND NOT EXISTS (
          SELECT 1 FROM cloud_sync_orphans orphan
          WHERE orphan.storage_reference = cloud_pending_publications.storage_reference
        )
    `).run(now(), knowledgeBaseId)
  }

  const processCloudPublication = async (
    active: Binding,
    knowledgeBaseId: string,
    consentEpoch: number,
  ): Promise<void> => {
    const remote = productionCloudRemote(cloudRemote)
    const cloudAllowed = () => ordinaryCloudAllowed(active)
      && isCloudConsentCurrent(active, consentEpoch)
    if (!remote || !cloudAllowed()) return
    const initialPending = pendingCloudPublication(active, knowledgeBaseId)
    if (!initialPending) return
    let pending: PendingCloudPublication = initialPending
    if (pending.uploadRetiring === 1) return
    const reloadPending = (): PendingCloudPublication => {
      const reloaded = pendingCloudPublication(active, knowledgeBaseId)
      if (!reloaded) fail('CONFLICT')
      return reloaded
    }
    if (pending.nextRetryAt > now()) return
    const deferPublication = (errorCode: string): void => {
      const recoveryAttempt = pending!.recoveryAttempt + 1
      const retryDelay = Math.min(60_000, 1_000 * (2 ** Math.min(recoveryAttempt - 1, 6)))
      const observedAt = now()
      active.store.database.prepare(`
        UPDATE cloud_pending_publications
        SET recovery_attempt = ?, next_retry_at = ?, last_error_code = ?, updated_at = ?
        WHERE knowledge_base_id = ? AND generation_id = ?
      `).run(
        recoveryAttempt, observedAt + retryDelay, errorCode, observedAt,
        pending!.knowledgeBaseId, pending!.generationId,
      )
    }
    const terminalPublication = (errorCode: string): void => {
      const observedAt = now()
      active.store.database.prepare(`
        UPDATE cloud_pending_publications
        SET recovery_attempt = 0, next_retry_at = 0, last_error_code = ?, updated_at = ?
        WHERE knowledge_base_id = ? AND generation_id = ?
      `).run(
        errorCode, observedAt, pending!.knowledgeBaseId, pending!.generationId,
      )
    }
    const recordPublicationFailure = (error: unknown): void => {
      const failure = classifyPublicationFailure(error)
      if (failure.retryable) deferPublication(failure.code)
      else terminalPublication(failure.code)
    }
    const finalizePublishedHead = async (): Promise<boolean> => {
      const currentMode = active.store.database.prepare(`
        SELECT mode FROM cloud_sync_states WHERE knowledge_base_id = ?
      `).get(pending!.knowledgeBaseId) as { mode: string } | undefined
      if (currentMode?.mode === 'paused') active.cloud.resume(pending!.knowledgeBaseId)
      const head = active.store.database.prepare(`
        SELECT revision FROM cloud_entity_heads
        WHERE knowledge_base_id = ? AND entity_kind = 'knowledge_base' AND entity_id = ?
      `).get(
        pending!.knowledgeBaseId, pending!.knowledgeBaseId,
      ) as { revision: string } | undefined
      active.cloud.enqueue({
        mutationId: stableCloudId(
          'base-mutation', pending!.knowledgeBaseId, pending!.generationId,
        ),
        knowledgeBaseId: pending!.knowledgeBaseId,
        entityKind: 'knowledge_base',
        entityId: pending!.knowledgeBaseId,
        operation: 'upsert',
        baseRevision: head?.revision ?? null,
        payload: {
          name: pending!.baseName,
          publishedGenerationId: pending!.generationId,
        },
      })
      const synchronization = await active.cloud.synchronize(
        pending!.knowledgeBaseId,
      ) as { status?: string }
      assertCurrentBinding(active)
      if (!cloudAllowed()) return false
      if (synchronization.status !== 'synced') {
        throw Object.assign(new Error('SYNC_FAILED'), {
          code: 'SYNC_FAILED', retryable: false as const,
        })
      }
      return true
    }
    const published = active.store.database.prepare(`
      SELECT published_generation_id AS publishedGenerationId
      FROM cloud_sync_states WHERE knowledge_base_id = ?
    `).get(pending.knowledgeBaseId) as { publishedGenerationId: string | null } | undefined
    if (published?.publishedGenerationId === pending.generationId) {
      try {
        if (!await finalizePublishedHead()) return
      } catch (error) {
        assertCurrentBinding(active)
        if (cloudAllowed()) recordPublicationFailure(error)
        return
      }
      active.store.database.prepare(`
        DELETE FROM cloud_pending_publications
        WHERE knowledge_base_id = ? AND generation_id = ?
      `).run(pending.knowledgeBaseId, pending.generationId)
      return
    }
    if (pending.uploadAttempt === 0 && pending.uploadVerified === 0) {
      const revision = stableCloudId(
        'revision', pending.documentId, pending.versionId, pending.contentHash,
      )
      try {
        await active.cloud.enableSync({
          requestId: stableCloudId('begin', pending.knowledgeBaseId, pending.generationId),
          knowledgeBaseId: pending.knowledgeBaseId,
          name: pending.baseName,
          revision,
          generationId: pending.generationId,
        })
      } catch (error) {
        assertCurrentBinding(active)
        if (cloudAllowed()) recordPublicationFailure(error)
        return
      }
      assertCurrentBinding(active)
      if (!cloudAllowed()) return
      const head = active.store.database.prepare(`
        SELECT revision FROM cloud_entity_heads
        WHERE knowledge_base_id = ? AND entity_kind = 'document' AND entity_id = ?
      `).get(pending.knowledgeBaseId, pending.documentId) as { revision: string } | undefined
      let synchronization: { status?: string }
      try {
        active.cloud.enqueue({
          mutationId: stableCloudId('mutation', pending.documentId, pending.versionId),
          knowledgeBaseId: pending.knowledgeBaseId,
          entityKind: 'document',
          entityId: pending.documentId,
          operation: 'upsert',
          baseRevision: head?.revision ?? null,
          payload: {
            name: pending.documentName,
            mimeType: pending.mimeType,
            versionId: pending.versionId,
            versionNumber: pending.versionNumber,
            contentHash: pending.contentHash,
            generationId: pending.generationId,
            createdAt: pending.createdAt,
          },
        })
        synchronization = await active.cloud.synchronize(pending.knowledgeBaseId) as {
          status?: string
        }
      } catch (error) {
        assertCurrentBinding(active)
        if (cloudAllowed()) recordPublicationFailure(error)
        return
      }
      assertCurrentBinding(active)
      if (!cloudAllowed()) return
      if (synchronization.status !== 'synced') {
        terminalPublication('SYNC_FAILED')
        return
      }
    }
    while (pending.uploadVerified === 0) {
      let recovery = persistedUploadRecovery(pending)
      const retireAuthorization = async (): Promise<void> => {
        if (!recovery) return
        active.cloud.recordOrphan(
          pending!.knowledgeBaseId, recovery.authorization.storageReference,
        )
        const retired = active.store.database.prepare(`
          UPDATE cloud_pending_publications SET upload_retiring = 1, updated_at = ?
          WHERE knowledge_base_id = ? AND generation_id = ?
            AND upload_verified = 0 AND upload_ticket = ? AND upload_retiring = 0
        `).run(now(), pending!.knowledgeBaseId, pending!.generationId, recovery.authorization.uploadTicket)
        if (retired.changes !== 1) fail('CONFLICT')
        await active.cloud.cleanupOrphans(pending!.knowledgeBaseId)
        assertCurrentBinding(active)
        finalizeRetiredCloudPublication(active, pending!.knowledgeBaseId)
        if (!cloudAllowed()) return
        pending = reloadPending()
        recovery = undefined
      }
      if (recovery && !recovery.putCompleted
        && pending.uploadAuthorizationExpiresAt! <= now()) {
        try {
          await retireAuthorization()
          if (!cloudAllowed()) return
        } catch (error) {
          assertCurrentBinding(active)
          if (cloudAllowed()) recordPublicationFailure(error)
          return
        }
      }
      if (!recovery && pending.uploadAttempt >= 3) {
        terminalPublication('UPLOAD_AUTHORIZATION_EXPIRED')
        return
      }
      let bytes: Buffer
      try {
        bytes = await active.store.objects.read(pending.objectId)
      } catch (error) {
        assertCurrentBinding(active)
        if (cloudAllowed()) recordPublicationFailure(error)
        return
      }
      assertCurrentBinding(active)
      try {
        const uploadAttempt = recovery ? pending.uploadAttempt : pending.uploadAttempt + 1
        const uploadRequestId = recovery
          ? pending.uploadRequestId!
          : stableCloudId(
              'upload', pending.documentId, pending.versionId, String(uploadAttempt),
            )
        let observedAuthorization = recovery !== undefined
        const uploaded = await remote.uploadDocument({
          requestId: uploadRequestId,
          knowledgeBaseId: pending.knowledgeBaseId,
          documentId: pending.documentId,
          versionId: pending.versionId,
          byteSize: bytes.byteLength,
          sha256: pending.contentHash,
          mimeType: pending.mimeType,
          bytes,
        }, {
          ...(recovery ? { resume: recovery } : {}),
          onRecoveryState: async state => {
            assertCurrentBinding(active)
            if (!observedAuthorization && state.putCompleted) fail('INTERNAL_ERROR')
            const authorization = state.authorization
            const expiresAt = Date.parse(authorization.expiresAt)
            const encoded = JSON.stringify(authorization)
            if (!Number.isSafeInteger(expiresAt) || Buffer.byteLength(encoded, 'utf8') > 8_192
              || authorization.mimeType !== pending!.mimeType
              || authorization.uploadAuthorization.expiresAt !== authorization.expiresAt
              || authorization.uploadAuthorization.headers['content-length'] !== String(bytes.byteLength)
              || authorization.uploadAuthorization.headers['content-type'] !== pending!.mimeType
              || authorization.uploadAuthorization.headers['x-content-sha256'] !== pending!.contentHash
              || authorization.uploadAuthorization.headers['x-upload-ticket']
                !== authorization.uploadTicket) {
              fail('INTERNAL_ERROR')
            }
            const updated = active.store.database.prepare(`
              UPDATE cloud_pending_publications
              SET upload_attempt = ?, upload_request_id = ?, upload_ticket = ?,
                upload_job_id = ?, storage_reference = ?, upload_authorization_json = ?,
                upload_authorization_expires_at = ?, upload_put_completed = ?,
                recovery_attempt = 0, next_retry_at = 0, last_error_code = NULL,
                updated_at = ?
              WHERE knowledge_base_id = ? AND generation_id = ? AND upload_verified = 0
                AND (upload_ticket IS NULL OR upload_ticket = ?)
            `).run(
              uploadAttempt, uploadRequestId, authorization.uploadTicket,
              authorization.jobId, authorization.storageReference, encoded, expiresAt,
              Number(state.putCompleted), now(), pending!.knowledgeBaseId,
              pending!.generationId, authorization.uploadTicket,
            )
            if (updated.changes !== 1) fail('CONFLICT')
            observedAuthorization = true
            pending = reloadPending()
            recovery = state
            if (!cloudAllowed()) fail('CONFLICT')
          },
        })
        assertCurrentBinding(active)
        if (!cloudAllowed()) {
          await retireAuthorization()
          return
        }
        if (!observedAuthorization || pending.uploadPutCompleted !== 1
          || pending.uploadJobId !== uploaded.jobId
          || pending.storageReference !== uploaded.storageReference) {
          fail('INTERNAL_ERROR')
        }
        const updated = active.store.database.prepare(`
          UPDATE cloud_pending_publications SET upload_verified = 1, recovery_attempt = 0,
            next_retry_at = 0, last_error_code = NULL, updated_at = ?
          WHERE knowledge_base_id = ? AND generation_id = ? AND upload_job_id = ?
            AND storage_reference = ? AND upload_put_completed = 1 AND upload_verified = 0
        `).run(
          now(), pending.knowledgeBaseId, pending.generationId,
          uploaded.jobId, uploaded.storageReference,
        )
        if (updated.changes !== 1) fail('CONFLICT')
        pending = reloadPending()
      } catch (error) {
        assertCurrentBinding(active)
        if (!cloudAllowed()) {
          try { await retireAuthorization() } catch { /* durable orphan retry remains */ }
          return
        }
        const failure = classifyPublicationFailure(error)
        if (recovery && (failure.code === 'CONFLICT' || failure.code === 'FORBIDDEN')) {
          try {
            await retireAuthorization()
            if (!cloudAllowed()) return
          } catch (retirementError) {
            assertCurrentBinding(active)
            if (cloudAllowed()) recordPublicationFailure(retirementError)
            return
          }
          continue
        }
        recordPublicationFailure(error)
        return
      } finally {
        bytes.fill(0)
      }
    }
    const uploadJobId = pending.uploadJobId
    if (!uploadJobId) return
    const currentMode = active.store.database.prepare(`
      SELECT mode FROM cloud_sync_states WHERE knowledge_base_id = ?
    `).get(pending.knowledgeBaseId) as { mode: string } | undefined
    if (currentMode?.mode === 'paused') {
      try {
        active.cloud.resume(pending.knowledgeBaseId)
      } catch (error) {
        assertCurrentBinding(active)
        if (cloudAllowed()) recordPublicationFailure(error)
        return
      }
      assertCurrentBinding(active)
      if (!cloudAllowed()) return
    }
    let completed = false
    for (let poll = 0; poll < 3; poll += 1) {
      let job: Awaited<ReturnType<ProductionCloudKnowledgeRemote['getJob']>>
      try {
        job = await remote.getJob({ jobId: uploadJobId })
      } catch (error) {
        assertCurrentBinding(active)
        if (!cloudAllowed()) return
        recordPublicationFailure(error)
        return
      }
      assertCurrentBinding(active)
      if (!cloudAllowed()) return
      if (job.jobId !== uploadJobId) fail('INTERNAL_ERROR')
      if (job.state === 'completed') { completed = true; break }
      if (job.state === 'failed' || job.state === 'cancelled') {
        recordPublicationFailure(Object.assign(new Error(job.state), {
          code: job.errorCode ?? (job.state === 'failed' ? 'SERVICE_UNAVAILABLE' : 'CANCELLED'),
          retryable: false as const,
        }))
        return
      }
    }
    if (!completed) {
      deferPublication('GENERATION_NOT_READY')
      return
    }
    try {
      await active.cloud.publishGeneration({
        requestId: pending.publishRequestId,
        knowledgeBaseId: pending.knowledgeBaseId,
        generationId: pending.generationId,
      })
    } catch (error) {
      assertCurrentBinding(active)
      if (cloudAllowed()) recordPublicationFailure(error)
      return
    }
    assertCurrentBinding(active)
    if (!cloudAllowed()) return
    try {
      if (!await finalizePublishedHead()) return
    } catch (error) {
      assertCurrentBinding(active)
      if (cloudAllowed()) recordPublicationFailure(error)
      return
    }
    active.store.database.prepare(`
      DELETE FROM cloud_pending_publications
      WHERE knowledge_base_id = ? AND generation_id = ? AND upload_job_id = ?
    `).run(pending.knowledgeBaseId, pending.generationId, uploadJobId)
  }

  const serialCloudTask = (
    active: Binding,
    knowledgeBaseId: string,
    operation: () => Promise<void>,
  ): Promise<void> => {
    const preceding = active.cloudPublications.get(knowledgeBaseId) ?? Promise.resolve()
    const task = preceding.catch(() => undefined).then(operation)
    active.cloudPublications.set(knowledgeBaseId, task)
    active.cloudTasks.add(task)
    void task.finally(() => {
      active.cloudTasks.delete(task)
      if (active.cloudPublications.get(knowledgeBaseId) === task) {
        active.cloudPublications.delete(knowledgeBaseId)
      }
    }).catch(() => undefined)
    return task
  }

  const recoverDueCloudPublications = (active: Binding): void => {
    const orphaned = active.store.database.prepare(`
      SELECT DISTINCT knowledge_base_id AS knowledgeBaseId
      FROM cloud_sync_orphans ORDER BY knowledge_base_id LIMIT 8
    `).all() as Array<{ knowledgeBaseId: string }>
    for (const row of orphaned) {
      const cleanup = serialCloudTask(active, row.knowledgeBaseId, async () => {
        await active.cloud.cleanupOrphans(row.knowledgeBaseId)
        assertCurrentBinding(active)
        finalizeRetiredCloudPublication(active, row.knowledgeBaseId)
      })
      void cleanup.catch(() => undefined)
    }
    if (!ordinaryCloudAllowed(active)) return
    const consentEpoch = active.cloudConsentEpoch
    const rows = active.store.database.prepare(`
      SELECT knowledge_base_id AS knowledgeBaseId
      FROM cloud_pending_publications
      WHERE next_retry_at <= ?
        AND (last_error_code IS NULL
          OR (last_error_code IN ('GENERATION_NOT_READY', 'TRANSIENT_FAILURE')
            AND recovery_attempt > 0))
      ORDER BY next_retry_at, updated_at, knowledge_base_id
      LIMIT 8
    `).all(now()) as Array<{ knowledgeBaseId: string }>
    for (const row of rows) {
      const recovery = serialCloudTask(
        active, row.knowledgeBaseId,
        () => processCloudPublication(active, row.knowledgeBaseId, consentEpoch),
      )
      void recovery.catch(() => undefined)
    }
  }

  const stageCloudPublication = (
    active: Binding,
    knowledgeBaseId: string,
    documentId: string,
    publicationGeneration: number,
    consentEpoch: number,
  ): void => {
    if (!ordinaryCloudAllowed(active) || !isCloudConsentCurrent(active, consentEpoch)) return
    const version = active.store.database.prepare(`
      SELECT version.id AS versionId, version.object_id AS objectId,
        version.content_hash AS contentHash
      FROM documents AS document
      JOIN document_versions AS version ON version.id = document.active_version_id
        AND version.document_id = document.id
      WHERE document.id = ? AND document.knowledge_base_id = ?
        AND document.recycled_at IS NULL AND version.status = 'ready'
        AND version.publication_generation = ?
    `).get(documentId, knowledgeBaseId, publicationGeneration) as {
      versionId: string; objectId: string; contentHash: string
    } | undefined
    if (!version) return
    const generationId = stableCloudId(
      'generation', knowledgeBaseId, documentId, version.versionId, version.contentHash,
    )
    const inserted = active.store.database.prepare(`
      INSERT INTO cloud_pending_publications(
        knowledge_base_id, generation_id, document_id, version_id, object_id,
        upload_job_id, publish_request_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(knowledge_base_id) DO NOTHING
    `).run(
      knowledgeBaseId, generationId, documentId, version.versionId, version.objectId,
      stableCloudId('publish', knowledgeBaseId, generationId), now(),
    )
    if (inserted.changes !== 1) {
      const existing = pendingCloudPublication(active, knowledgeBaseId)
      if (existing?.generationId !== generationId) fail('CONFLICT')
    }
  }

  const cloudCoordinate = (
    candidate: CloudCandidate,
  ): KnowledgeEvidence['citation']['coordinate'] | undefined => {
    const raw = candidate.coordinates
    if (raw.kind === 'pdf'
      && Number.isSafeInteger(raw.page) && Number(raw.page) > 0
      && Number.isSafeInteger(raw.itemStart) && Number(raw.itemStart) >= 0
      && Number.isSafeInteger(raw.itemEnd) && Number(raw.itemEnd) >= Number(raw.itemStart)) {
      return {
        kind: 'pdf', page: Number(raw.page), startOffset: Number(raw.itemStart),
        endOffset: Number(raw.itemEnd),
      }
    }
    if (raw.kind === 'docx' && Array.isArray(raw.headingPath)
      && raw.headingPath.length <= 32 && raw.headingPath.every(item => typeof item === 'string' && item)
      && typeof raw.paragraphId === 'string' && /^p-[1-9][0-9]*$/u.test(raw.paragraphId)) {
      return {
        kind: 'docx', headingPath: raw.headingPath as string[],
        paragraph: Number(raw.paragraphId.slice(2)) - 1,
      }
    }
    if (raw.kind === 'txt'
      && Number.isSafeInteger(raw.lineStart) && Number(raw.lineStart) > 0
      && Number.isSafeInteger(raw.charStart) && Number(raw.charStart) >= 0
      && Number.isSafeInteger(raw.charEnd) && Number(raw.charEnd) >= Number(raw.charStart)) {
      return {
        kind: 'text', line: Number(raw.lineStart), startOffset: Number(raw.charStart),
        endOffset: Number(raw.charEnd),
      }
    }
    if (raw.kind === 'html' && Array.isArray(raw.path) && raw.path.length > 0
      && raw.path.every(item => typeof item === 'string' && item)) {
      const structuralPath = raw.path.join(' > ')
      if (structuralPath.length <= 500) return { kind: 'html', structuralPath }
    }
    return undefined
  }

  const searchBases = async (
    active: Binding,
    query: string,
    baseIds: readonly string[],
    signal?: AbortSignal,
    admittedScope?: KnowledgeSearchScope,
  ): Promise<KnowledgeSearchResult> => {
    if (signal?.aborted) fail('CANCELLED')
    const normalized = query.normalize('NFC').trim()
    const length = Array.from(normalized).length
    if (length < 2) return { kind: 'query-too-short' }
    const unique = [...new Set(baseIds)]
    if (unique.length === 0) {
      return { kind: 'results', strategy: length === 2 ? 'bounded-instr' : 'trigram', evidence: [] }
    }
    const captured = admittedScope === undefined ? undefined : activeSearchScopes.get(admittedScope.scopeId)
    if (admittedScope !== undefined && (captured !== admittedScope
      || admittedScope.ownerId !== active.ownerId || admittedScope.ownerEpoch !== active.epoch)) {
      fail('CONFLICT')
    }
    const state = admittedScope === undefined ? entitlement(active) : undefined
    const kept = state === undefined ? undefined : retention(active, state)
    const allowedBases = admittedScope
      ? unique.filter(baseId => admittedScope.baseIds.includes(baseId))
      : state!.tier === 'member' && state!.status !== 'expired'
        ? unique
        : kept && unique.includes(kept.baseId) ? [kept.baseId] : []
    if (allowedBases.length === 0) {
      return { kind: 'results', strategy: length === 2 ? 'bounded-instr' : 'trigram', evidence: [] }
    }
    if (kept && !kept.documentId) {
      return { kind: 'results', strategy: length === 2 ? 'bounded-instr' : 'trigram', evidence: [] }
    }
    recoverDueCloudPublications(active)
    const result = await new LocalKnowledgeRetriever(active.store.database, active.semantic).search(
      normalized,
      allowedBases,
      kept?.documentId ? [kept.documentId] : undefined,
      admittedScope?.entries,
      signal,
    )
    if (signal?.aborted) fail('CANCELLED')
    const remote = productionCloudRemote(cloudRemote)
    const liveCloudAllowed = ordinaryCloudAllowed(active)
    const cloudConsentEpoch = admittedScope?.cloudConsentEpoch ?? active.cloudConsentEpoch
    const cloudConsentCurrent = () => active.cloudSyncConsentAccepted
      && active.cloudConsentEpoch === cloudConsentEpoch
    if (!remote || !liveCloudAllowed || !cloudConsentCurrent()
      || (admittedScope && !admittedScope.cloudAllowed)) {
      return result
    }
    if (!admittedScope) {
      for (const baseId of allowedBases) {
        const local = active.store.database.prepare(
          'SELECT 1 AS present FROM knowledge_bases WHERE id = ?',
        ).get(baseId)
        if (local) continue
        try {
          await active.cloud.synchronizeRemoteProjection(baseId)
          assertCurrentBinding(active)
          if (!ordinaryCloudAllowed(active) || !cloudConsentCurrent()) return result
        } catch {
          assertCurrentBinding(active)
        }
      }
    }
    const localCloudEntries = active.store.database.prepare(`
      SELECT base.id AS baseId, document.id AS documentId,
        version.id AS versionId, version.publication_generation AS publicationGeneration,
        sync.published_generation_id AS cloudGenerationId
      FROM knowledge_bases AS base
      JOIN documents AS document ON document.knowledge_base_id = base.id
      JOIN document_versions AS version ON version.id = document.active_version_id
        AND version.document_id = document.id
      JOIN cloud_sync_states AS sync ON sync.knowledge_base_id = base.id
      WHERE base.id IN (${allowedBases.map(() => '?').join(', ')})
        AND base.recycled_at IS NULL AND document.recycled_at IS NULL
        AND version.status = 'ready' AND sync.published_generation_id IS NOT NULL
      ORDER BY base.id, document.id, version.id
    `).all(...allowedBases) as KnowledgeSearchScopeEntry[]
    const remoteCloudEntries = active.store.database.prepare(`
      SELECT base.id AS baseId, document.id AS documentId,
        version.id AS versionId, 0 AS publicationGeneration,
        base.published_generation_id AS cloudGenerationId
      FROM cloud_base_projections AS base
      JOIN cloud_document_projections AS document
        ON document.knowledge_base_id = base.id
      JOIN cloud_version_projections AS version
        ON version.id = document.active_version_id
        AND version.document_id = document.id
        AND version.generation_id = base.published_generation_id
      WHERE base.id IN (${allowedBases.map(() => '?').join(', ')})
        AND document.status = 'ready' AND version.status = 'ready'
        AND version.local_object_available = 0
      ORDER BY base.id, document.id, version.id
    `).all(...allowedBases) as KnowledgeSearchScopeEntry[]
    const cloudEntries = admittedScope?.entries
      ?? [...localCloudEntries, ...remoteCloudEntries]
    const generations = new Map<string, string>()
    for (const baseId of allowedBases) {
      const selected = new Set(cloudEntries
        .filter(entry => entry.baseId === baseId && entry.cloudGenerationId)
        .map(entry => entry.cloudGenerationId!))
      if (selected.size === 1) generations.set(baseId, [...selected][0]!)
    }
    const cloudBases = allowedBases.filter(baseId => generations.has(baseId))
    if (cloudBases.length === 0) return result
    try {
      for (const baseId of cloudBases) {
        const local = active.store.database.prepare(
          'SELECT 1 AS present FROM knowledge_bases WHERE id = ?',
        ).get(baseId)
        if (local || !admittedScope) {
          await serialCloudTask(active, baseId, async () => {
            if (local) await processCloudPublication(active, baseId, cloudConsentEpoch)
            if (!cloudConsentCurrent()) fail('SERVICE_UNAVAILABLE')
            const synchronized = await (local
              ? active.cloud.synchronize(baseId)
              : active.cloud.synchronizeRemoteProjection(baseId)) as { status?: string }
            if (synchronized.status !== 'synced') fail('SERVICE_UNAVAILABLE')
          })
        }
        assertCurrentBinding(active)
        if (!ordinaryCloudAllowed(active) || !cloudConsentCurrent()) return result
      }
      const retrieved = await new CloudKnowledgeRetriever(remote).search(
        normalized, cloudBases, generations,
      )
      assertCurrentBinding(active)
      if (!ordinaryCloudAllowed(active) || !cloudConsentCurrent()) return result
      if (signal?.aborted) fail('CANCELLED')
      const cloudEvidence = retrieved.evidence.flatMap((candidate, index): KnowledgeEvidence[] => {
        const admitted = cloudEntries.some(entry => entry.baseId === candidate.knowledgeBaseId
          && entry.documentId === candidate.documentId && entry.versionId === candidate.versionId
          && entry.cloudGenerationId === candidate.generationId)
        const coordinate = admitted ? cloudCoordinate(candidate) : undefined
        if (!coordinate) return []
        const evidenceId = `evidence:cloud:${candidate.id}`
        return [{
          id: evidenceId,
          baseId: candidate.knowledgeBaseId,
          documentId: candidate.documentId,
          versionId: candidate.versionId,
          snippet: candidate.body.slice(0, 4_000),
          score: Math.max(0, 1 - index / Math.max(retrieved.evidence.length, 1)),
          citation: {
            evidenceId,
            documentId: candidate.documentId,
            versionId: candidate.versionId,
            coordinate,
          },
        }]
      })
      if (result.kind !== 'results' || cloudEvidence.length === 0) return result
      const identities = new Set(cloudEvidence.map(
        item => `${item.documentId}:${item.versionId}:${item.snippet}`,
      ))
      return {
        ...result,
        evidence: [...cloudEvidence, ...result.evidence.filter(item => {
          const identity = `${item.documentId}:${item.versionId}:${item.snippet}`
          if (identities.has(identity)) return false
          identities.add(identity)
          return true
        })].slice(0, 8),
      }
    } catch {
      if (signal?.aborted) fail('CANCELLED')
      return result
    }
  }

  const firstFailure = (
    results: readonly PromiseSettledResult<unknown>[],
  ): PromiseRejectedResult | undefined => (
    results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  )
  const settle = (operations: readonly (() => unknown | Promise<unknown>)[]) => Promise.allSettled(
    operations.map(operation => Promise.resolve().then(operation)),
  )
  const rememberLifecycleFailure = (error: unknown): void => {
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'CONFLICT') return
    if (hasLifecycleFailure) return
    lifecycleFailure = error
    hasLifecycleFailure = true
  }
  const takeLifecycleFailure = (): { failed: boolean; error: unknown } => {
    const recorded = { failed: hasLifecycleFailure, error: lifecycleFailure }
    hasLifecycleFailure = false
    lifecycleFailure = undefined
    return recorded
  }

  const invalidateBinding = (current: Binding): void => {
    try {
      if (!current.cloudOwnerInvalidated) {
        current.cloud.invalidateOwner()
        current.cloudOwnerInvalidated = true
      }
    } catch (error) {
      if (!current.cloudOwnerInvalidationFailed) {
        current.cloudOwnerInvalidationFailed = true
        current.cloudOwnerInvalidationFailure = error
      }
    } finally {
      current.runner.invalidate()
      current.semantic?.invalidate()
    }
  }

  const retire = (current: Binding): void => {
    invalidateBinding(current)
    const closing = (async () => {
      const failures: PromiseSettledResult<unknown>[] = current.cloudOwnerInvalidationFailed
        ? [{ status: 'rejected', reason: current.cloudOwnerInvalidationFailure }]
        : []
      failures.push(...await settle([
        () => current.runner.drain(),
        () => current.semantic?.dispose(),
        () => current.cloud.drain(),
        () => Promise.allSettled([...current.cloudTasks]),
      ]))
      for (const handle of current.handles.values()) {
        try {
          current.store.database.prepare(`
            INSERT OR IGNORE INTO knowledge_cleanup_records(object_id, created_at) VALUES (?, ?)
          `).run(handle.objectId, now())
        } catch (error) {
          failures.push({ status: 'rejected', reason: error })
        }
        const deleted = await settle([() => current.store.objects.delete(handle.objectId)])
        failures.push(...deleted)
        if (deleted[0]?.status === 'fulfilled') {
          try {
            current.store.database.prepare(
              'DELETE FROM knowledge_cleanup_records WHERE object_id = ?',
            ).run(handle.objectId)
          } catch (error) {
            failures.push({ status: 'rejected', reason: error })
          }
        }
      }
      current.handles.clear()
      failures.push(...await settle([() => current.store.close()]))
      const failure = firstFailure(failures)
      if (failure) throw failure.reason
    })()
    void closing.catch(() => undefined)
    retiring.add(closing)
  }

  const beginRetirements = (): void => {
    for (const pending of pendingRetirements) {
      retire(pending)
      pendingRetirements.delete(pending)
    }
  }

  const waitForRetirements = async (): Promise<void> => {
    const active = [...retiring]
    const results = await Promise.allSettled(active)
    for (const settled of active) retiring.delete(settled)
    const failure = firstFailure(results)
    if (failure) throw failure.reason
  }

  const invalidate = (): void => {
    epoch += 1
    const current = binding
    binding = undefined
    unavailable = undefined
    refreshedEntitlement = undefined
    activeSearchScopes.clear()
    if (current) {
      pendingRetirements.add(current)
      invalidateBinding(current)
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

  const applyCloudSyncConsent = (active: Binding, accepted: boolean): void => {
    if (active.cloudSyncConsentAccepted === accepted) return
    active.cloudSyncConsentAccepted = accepted
    active.cloudConsentEpoch += 1
    entitlement(active)
    if (!accepted || !ordinaryCloudAllowed(active)) return
    const paused = active.store.database.prepare(`
      SELECT knowledge_base_id AS knowledgeBaseId FROM cloud_sync_states
      WHERE mode = 'paused' ORDER BY knowledge_base_id
    `).all() as Array<{ knowledgeBaseId: string }>
    for (const row of paused) active.cloud.resume(row.knowledgeBaseId)
    recoverDueCloudPublications(active)
  }

  const emitDocument = (active: Binding, documentId: string): void => {
    if (binding !== active || active.epoch !== epoch) return
    const document = documentSummary(active.store.database, documentId)
    if (document) dependencies.emit?.({ type: 'document_updated', document })
  }

  const recoverCleanup = async (
    store: LocalKnowledgeStore,
    isCurrentEpoch: () => boolean,
  ): Promise<void> => {
    const records = store.database.prepare(
      'SELECT object_id FROM knowledge_cleanup_records ORDER BY created_at, object_id',
    ).all() as Array<{ object_id: string }>
    for (const record of records) {
      if (!isCurrentEpoch()) fail('CONFLICT')
      await store.objects.delete(record.object_id)
      if (!isCurrentEpoch()) fail('CONFLICT')
      store.database.prepare('DELETE FROM knowledge_cleanup_records WHERE object_id = ?').run(record.object_id)
    }
  }

  const bind = (ownerId: string, cloudSyncConsentAccepted = false): Promise<void> => {
    if (binding?.ownerId === ownerId && binding.epoch === epoch) {
      applyCloudSyncConsent(binding, cloudSyncConsentAccepted)
      return Promise.resolve()
    }
    if (unavailable?.ownerId === ownerId && unavailable.epoch === epoch) return Promise.resolve()
    invalidate()
    const bindEpoch = epoch
    const operation = lifecycleTail.then(async () => {
      beginRetirements()
      await waitForRetirements()
      if (bindEpoch !== epoch) fail('CONFLICT')
      let store: LocalKnowledgeStore
      try {
        store = await dependencies.openStore(ownerId)
      } catch {
        if (bindEpoch !== epoch) fail('CONFLICT')
        if (bindEpoch === epoch) unavailable = {
          ownerId, epoch: bindEpoch, encryptionAvailable: false, parserAvailable: false,
        }
        return
      }
      if (bindEpoch !== epoch) {
        await store.close()
        fail('CONFLICT')
      }
      let parser: KnowledgeParserPort | undefined
      try {
        await recoverCleanup(store, () => bindEpoch === epoch)
        if (bindEpoch !== epoch) fail('CONFLICT')
        parser = await dependencies.createParser(store)
        if (bindEpoch !== epoch) fail('CONFLICT')
      } catch {
        if (parser) {
          const cleanup = await settle([() => parser!.terminateAll(), () => store.close()])
          const cleanupFailure = firstFailure(cleanup)
          if (cleanupFailure) throw cleanupFailure.reason
        } else {
          await store.close()
        }
        if (bindEpoch !== epoch) fail('CONFLICT')
        if (bindEpoch === epoch) unavailable = {
          ownerId, epoch: bindEpoch, encryptionAvailable: true, parserAvailable: false,
        }
        return
      }
      if (!parser) fail('SERVICE_UNAVAILABLE')
      const active = {} as Binding
      let semantic: LocalSemanticSearchPort | undefined
      try { semantic = dependencies.createSemanticIndex?.(store) } catch { /* lexical search remains available */ }
      const runner = new ImportJobRunner({
        database: store.database,
        objects: store.objects,
        parser,
        ownerEpoch: bindEpoch,
        isCurrentOwnerEpoch: candidate => binding === active && epoch === candidate,
        token: id,
        ...(semantic ? { semantic } : {}),
        onDocumentChanged: documentId => emitDocument(active, documentId),
      })
      Object.assign(active, {
        ownerId, epoch: bindEpoch, store, parser, runner, semantic, handles: new Map(),
        cloud: createCloudLifecycle(store), cloudOwnerInvalidated: false,
        cloudOwnerInvalidationFailed: false,
        cloudTasks: new Set(), cloudPublications: new Map(),
        cloudSyncConsentAccepted, cloudConsentEpoch: 0,
      })
      if (bindEpoch !== epoch) {
        const cleanup = await settle([() => runner.drain(), () => store.close()])
        const cleanupFailure = firstFailure(cleanup)
        if (cleanupFailure) throw cleanupFailure.reason
        fail('CONFLICT')
      }
      binding = active
      active.cloud.setCloudAccess(false)
      void runner.recoverAndRun().catch(() => undefined)
    })
    lifecycleTail = operation.catch((error: unknown) => { rememberLifecycleFailure(error) })
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
        id, document_id, version_number, status, content_hash, object_id, created_at,
        publication_generation, name, mime_type
      ) VALUES (?, ?, ?, 'staging', ?, ?, ?, ?, ?, ?)
    `).run(
      versionId, documentId, versionNumber, handle.contentHash, handle.objectId,
      createdAt, generation, handle.name, handle.mimeType,
    )
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
    setCloudSyncConsent: (ownerId, accepted) => {
      const active = binding
      if (!active || active.ownerId !== ownerId || active.epoch !== epoch) {
        if (unavailable?.ownerId === ownerId && unavailable.epoch === epoch) return
        fail('AUTH_REQUIRED')
      }
      applyCloudSyncConsent(active, accepted)
    },
    configureCloudRemote: (remote) => {
      if (binding && remote) fail('CONFLICT')
      if (binding) return
      cloudRemote = remote
    },
    refreshEntitlement: async (ownerId, snapshot, authorizationConfirmed = true) => {
      if (!dependencies.refreshEntitlement && !dependencies.verifyEntitlement) return
      const active = binding
      if (!active || active.ownerId !== ownerId || active.epoch !== epoch) {
        if (unavailable?.ownerId === ownerId && unavailable.epoch === epoch) return
        fail('AUTH_REQUIRED')
      }
      const refreshEpoch = epoch
      if (!authorizationConfirmed) {
        entitlement(active)
        return
      }
      const currentProjection = readProjection(active)
      const observedAt = Math.max(now(), currentProjection?.maxObservedAt ?? 0)
      let state: KnowledgeEntitlementState | undefined
      if (snapshot && dependencies.verifyEntitlement) {
        const verified = dependencies.verifyEntitlement(ownerId, snapshot, observedAt)
        const issuedAt = verified.issuedAt ? Date.parse(verified.issuedAt) : NaN
        const keyId = verified.keyId
        const keyGeneration = verified.keyGeneration
        if (!Number.isFinite(issuedAt) || !keyId || typeof keyGeneration !== 'number'
          || !Number.isSafeInteger(keyGeneration) || keyGeneration <= 0) fail('INVALID_INPUT')
        const digest = createHash('sha256')
          .update(snapshot.payload).update('.').update(snapshot.signature).digest('hex')
        if (currentProjection?.acceptedIssuedAt !== null
          && currentProjection?.acceptedIssuedAt !== undefined) {
          if (issuedAt < currentProjection.acceptedIssuedAt
            || (issuedAt === currentProjection.acceptedIssuedAt
              && digest !== currentProjection.acceptedSnapshotDigest)) fail('FORBIDDEN')
        }
        if (currentProjection && keyGeneration < currentProjection.acceptedKeyGeneration) fail('FORBIDDEN')
        if (currentProjection && keyGeneration === currentProjection.acceptedKeyGeneration
          && currentProjection.acceptedKeyId !== null
          && keyId !== currentProjection.acceptedKeyId) fail('FORBIDDEN')
        state = verified
        writeProjection(active, state, {
          verified: true,
          acceptedIssuedAt: issuedAt,
          acceptedKeyId: keyId,
          acceptedKeyGeneration: keyGeneration,
          acceptedSnapshotDigest: digest,
          observedAt,
        })
      } else if (dependencies.refreshEntitlement) {
        try {
          state = await dependencies.refreshEntitlement(ownerId)
        } catch {
          state = undefined
        }
        if (binding !== active || epoch !== refreshEpoch || active.ownerId !== ownerId) fail('CONFLICT')
        if (state) writeProjection(active, state, { observedAt })
      } else {
        state = { tier: 'free', status: 'active', localEnabled: true, cloudEnabled: false }
        active.store.database.transaction(() => {
          writeProjection(active, state!, {
            explicitFree: true,
            acceptedIssuedAt: observedAt,
            observedAt,
          })
          beginDurableCloudRetention(active, observedAt)
        })()
      }
      if (binding !== active || epoch !== refreshEpoch || active.ownerId !== ownerId) fail('CONFLICT')
      if (state) refreshedEntitlement = { ownerId, epoch: refreshEpoch, state }
      else if (!currentProjection?.verified) refreshedEntitlement = {
          ownerId,
          epoch: refreshEpoch,
          state: { tier: 'free', status: 'unavailable', localEnabled: true, cloudEnabled: false },
        }
      entitlement(active)
    },
    invalidate,
    drain: async () => {
      await lifecycleTail
      beginRetirements()
      const retirement = await settle([waitForRetirements])
      const lifecycle = takeLifecycleFailure()
      if (lifecycle.failed) throw lifecycle.error
      const retirementFailure = firstFailure(retirement)
      if (retirementFailure) throw retirementFailure.reason
    },
    list: async (owner) => {
      const active = current(owner)
      const state = entitlement(active)
      recoverDueCloudPublications(active)
      if (ordinaryCloudAllowed(active)) {
        try {
          await active.cloud.synchronizeOwnerCatalog()
          assertCurrentBinding(active)
        } catch {
          assertCurrentBinding(active)
        }
      }
      const kept = retention(active, state)
      const member = state.tier === 'member' && state.status !== 'expired'
      const ids = active.store.database.prepare(
        'SELECT id FROM knowledge_bases ORDER BY created_at, id',
      ).all() as Array<{ id: string }>
      const local = ids.map(row => baseSummary(
        active.store.database,
        row.id,
        !member && kept?.baseId !== row.id,
      )!)
      const remoteIds = active.store.database.prepare(`
        SELECT remote.id FROM cloud_base_projections AS remote
        LEFT JOIN knowledge_bases AS local ON local.id = remote.id
        WHERE local.id IS NULL ORDER BY remote.updated_at, remote.id
      `).all() as Array<{ id: string }>
      return [...local, ...remoteIds.map(row => remoteBaseSummary(
        active.store.database, row.id,
      )!)]
    },
    captureSearchScope: async (owner, requestedBaseIds) => {
      const active = current(owner)
      recoverDueCloudPublications(active)
      const unique = [...new Set(requestedBaseIds)]
      if (unique.length === 0 || unique.length > 32
        || unique.some(baseId => !baseId || baseId.length > 512)) fail('INVALID_INPUT')
      const state = entitlement(active)
      const kept = retention(active, state)
      const allowed = state.tier === 'member' && state.status !== 'expired'
        ? unique
        : kept && unique.includes(kept.baseId) ? [kept.baseId] : []
      if (ordinaryCloudAllowed(active)) {
        for (const baseId of allowed) {
          const local = active.store.database.prepare(
            'SELECT 1 AS present FROM knowledge_bases WHERE id = ?',
          ).get(baseId)
          if (local) continue
          try {
            await active.cloud.synchronizeRemoteProjection(baseId)
            assertCurrentBinding(active)
            if (!ordinaryCloudAllowed(active)) break
          } catch {
            assertCurrentBinding(active)
          }
        }
      }
      const localEntries = allowed.length === 0 ? [] : active.store.database.prepare(`
        SELECT base.id AS baseId, document.id AS documentId,
          version.id AS versionId, version.publication_generation AS publicationGeneration,
          sync.published_generation_id AS cloudGenerationId
        FROM knowledge_bases AS base
        JOIN documents AS document ON document.knowledge_base_id = base.id
        JOIN document_versions AS version ON version.id = document.active_version_id
          AND version.document_id = document.id
        LEFT JOIN cloud_sync_states AS sync ON sync.knowledge_base_id = base.id
        WHERE base.id IN (${allowed.map(() => '?').join(', ')})
          AND base.recycled_at IS NULL AND document.recycled_at IS NULL
          AND version.status = 'ready'
          ${kept?.documentId ? 'AND document.id = ?' : ''}
        ORDER BY base.id, document.id, version.id
      `).all(...allowed, ...(kept?.documentId ? [kept.documentId] : [])) as KnowledgeSearchScopeEntry[]
      const remoteEntries = allowed.length === 0 || kept?.documentId ? []
        : active.store.database.prepare(`
          SELECT base.id AS baseId, document.id AS documentId,
            version.id AS versionId, 0 AS publicationGeneration,
            base.published_generation_id AS cloudGenerationId
          FROM cloud_base_projections AS base
          JOIN cloud_document_projections AS document
            ON document.knowledge_base_id = base.id
          JOIN cloud_version_projections AS version
            ON version.id = document.active_version_id
            AND version.document_id = document.id
            AND version.generation_id = base.published_generation_id
          WHERE base.id IN (${allowed.map(() => '?').join(', ')})
            AND document.status = 'ready' AND version.status = 'ready'
            AND version.local_object_available = 0
          ORDER BY base.id, document.id, version.id
        `).all(...allowed) as KnowledgeSearchScopeEntry[]
      const entries = [...localEntries, ...remoteEntries]
      const scope = Object.freeze({
        scopeId: id(), ownerId: active.ownerId, ownerEpoch: active.epoch,
        baseIds: Object.freeze([...allowed]),
        entries: Object.freeze(entries.map(entry => Object.freeze({ ...entry }))),
        cloudAllowed: ordinaryCloudAllowed(active),
        cloudConsentEpoch: active.cloudConsentEpoch,
      })
      activeSearchScopes.set(scope.scopeId, scope)
      return scope
    },
    releaseSearchScope: (scope) => {
      if (activeSearchScopes.get(scope.scopeId) === scope) activeSearchScopes.delete(scope.scopeId)
    },
    create: async (owner, rawName) => {
      const active = current(owner)
      const name = rawName.trim()
      if (!name || name.length > 200) fail('INVALID_INPUT')
      const member = isMember(active)
      const count = active.store.database.prepare(
        'SELECT count(*) AS count FROM knowledge_bases',
      ).get() as { count: number }
      if (count.count >= limits(active).knowledgeBases) fail('KNOWLEDGE_BASE_LIMIT_EXCEEDED')
      const baseId = id()
      const createdAt = now()
      active.store.database.prepare(`
        INSERT INTO knowledge_bases(id, name, created_at, updated_at, lifecycle_status, recycled_at)
        VALUES (?, ?, ?, ?, 'ready', NULL)
      `).run(baseId, name, createdAt, createdAt)
      if (!member && !storedRetention(active)) {
        writeRetention(active, { baseId, confirmed: false })
      }
      return baseSummary(active.store.database, baseId)!
    },
    listDocuments: async (owner, baseId) => {
      const active = current(owner)
      recoverDueCloudPublications(active)
      const localBase = baseSummary(active.store.database, baseId)
      if (!localBase) {
        if (!remoteBaseSummary(active.store.database, baseId)) fail('NOT_FOUND')
        const remoteRows = active.store.database.prepare(`
          SELECT id FROM cloud_document_projections
          WHERE knowledge_base_id = ? ORDER BY updated_at, id
        `).all(baseId) as Array<{ id: string }>
        return remoteRows.map(row => remoteDocumentSummary(active.store.database, row.id)!)
      }
      const state = entitlement(active)
      const kept = retention(active, state)
      const member = state.tier === 'member' && state.status !== 'expired'
      const rows = active.store.database.prepare(`
        SELECT id FROM documents WHERE knowledge_base_id = ? ORDER BY created_at, id
      `).all(baseId) as Array<{ id: string }>
      return rows.map(row => documentSummary(
        active.store.database,
        row.id,
        !member && kept?.documentId !== row.id,
      )!)
    },
    listVersions: async (owner, documentId) => {
      const active = current(owner)
      if (!documentSummary(active.store.database, documentId)) {
        if (!remoteDocumentSummary(active.store.database, documentId)) fail('NOT_FOUND')
        const remoteRows = active.store.database.prepare(`
          SELECT id, document_id, version_number, status, created_at
          FROM cloud_version_projections
          WHERE document_id = ? ORDER BY version_number DESC
        `).all(documentId) as Array<{
          id: string
          document_id: string
          version_number: number
          status: KnowledgeVersionSummary['status']
          created_at: number
        }>
        return remoteRows.map((row): KnowledgeVersionSummary => ({
          id: row.id,
          documentId: row.document_id,
          number: row.version_number,
          status: row.status,
          createdAt: timestamp(row.created_at),
        }))
      }
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
      assertWritableBase(active, baseId)
      const base = active.store.database.prepare(
        'SELECT id FROM knowledge_bases WHERE id = ? AND recycled_at IS NULL',
      ).get(baseId)
      if (!base) fail('NOT_FOUND')
      const count = active.store.database.prepare(
        'SELECT count(*) AS count FROM documents',
      ).get() as { count: number }
      if (count.count >= limits(active).knowledgeDocuments) fail('KNOWLEDGE_DOCUMENT_LIMIT_EXCEEDED')
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
      if (!isMember(active)) writeRetention(active, { baseId, documentId, confirmed: true })
      const parsing = active.runner.runQueued()
      const cloudConsentEpoch = active.cloudConsentEpoch
      const cloud = serialCloudTask(active, baseId, async () => {
        await parsing
        assertCurrentBinding(active)
        stageCloudPublication(active, baseId, documentId, 1, cloudConsentEpoch)
        await processCloudPublication(active, baseId, cloudConsentEpoch)
      })
      void cloud.catch(() => undefined)
      return documentSummary(active.store.database, documentId)
    },
    replaceDocument: async (owner, documentId, handleId) => {
      const active = current(owner)
      assertWritableDocument(active, documentId)
      const document = active.store.database.prepare(`
        SELECT knowledge_base_id, publication_generation
        FROM documents WHERE id = ? AND recycled_at IS NULL
      `).get(documentId) as {
        knowledge_base_id: string; publication_generation: number
      } | undefined
      if (!document) fail('NOT_FOUND')
      const handle = consumeHandle(active, handleId)
      active.store.database.transaction(() => {
        const latest = active.store.database.prepare(`
          SELECT coalesce(max(version_number), 0) AS version_number
          FROM document_versions WHERE document_id = ?
        `).get(documentId) as { version_number: number }
        const generation = document.publication_generation + 1
        const changed = active.store.database.prepare(`
          UPDATE documents SET lifecycle_status = CASE WHEN active_version_id IS NULL THEN 'queued' ELSE lifecycle_status END,
            publication_generation = ?, updated_at = ? WHERE id = ? AND publication_generation = ?
        `).run(generation, now(), documentId, document.publication_generation)
        if (changed.changes !== 1) fail('CONFLICT')
        enqueue(active, documentId, handle, latest.version_number + 1, generation)
      })()
      const publicationGeneration = document.publication_generation + 1
      const parsing = active.runner.runQueued()
      const cloudConsentEpoch = active.cloudConsentEpoch
      const cloud = serialCloudTask(active, document.knowledge_base_id, async () => {
        await parsing
        assertCurrentBinding(active)
        stageCloudPublication(
          active, document.knowledge_base_id, documentId, publicationGeneration,
          cloudConsentEpoch,
        )
        await processCloudPublication(active, document.knowledge_base_id, cloudConsentEpoch)
      })
      void cloud.catch(() => undefined)
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
      if (!isMember(active)) {
        const kept = storedRetention(active)
        if (kept?.documentId !== documentId) fail('FORBIDDEN')
      }
      const status = document.active_version_id ? 'ready' : 'failed'
      active.store.database.prepare(`
        UPDATE documents SET recycled_at = NULL, lifecycle_status = ?, updated_at = ? WHERE id = ?
      `).run(status, now(), documentId)
      emitDocument(active, documentId)
    },
    purgeDocument: async (owner, documentId) => {
      const active = current(owner)
      if ([...activeSearchScopes.values()].some(scope => scope.ownerId === active.ownerId
        && scope.ownerEpoch === active.epoch
        && scope.entries.some(entry => entry.documentId === documentId))) fail('CONFLICT')
      const document = active.store.database.prepare(
        'SELECT id FROM documents WHERE id = ? AND recycled_at IS NOT NULL',
      ).get(documentId)
      if (!document) fail('NOT_FOUND')
      const objects = active.store.database.prepare(
        'SELECT object_id FROM document_versions WHERE document_id = ?',
      ).all(documentId) as Array<{ object_id: string }>
      active.store.database.transaction(() => {
        if (storedRetention(active)?.documentId === documentId) {
          const epochRow = readProjection(active)
          active.store.database.prepare(`
            UPDATE knowledge_free_retention SET knowledge_base_id = NULL, document_id = NULL,
              confirmed = 0, entitlement_epoch = ?, updated_at = ? WHERE singleton = 1
          `).run(epochRow?.epoch ?? 0, now())
        }
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
      if (!isMember(active)) {
        const kept = storedRetention(active)
        if (kept?.baseId !== baseId) fail('FORBIDDEN')
      }
      active.store.database.prepare(`
        UPDATE knowledge_bases SET lifecycle_status = 'ready', recycled_at = NULL, updated_at = ? WHERE id = ?
      `).run(now(), baseId)
    },
    purgeBase: async (owner, baseId) => {
      const active = current(owner)
      if ([...activeSearchScopes.values()].some(scope => scope.ownerId === active.ownerId
        && scope.ownerEpoch === active.epoch && scope.baseIds.includes(baseId))) fail('CONFLICT')
      const exists = active.store.database.prepare(
        'SELECT recycled_at AS recycledAt FROM knowledge_bases WHERE id = ?',
      ).get(baseId) as { recycledAt: number | null } | undefined
      if (!exists) return
      if (exists.recycledAt === null) fail('NOT_FOUND')
      const cloud = active.store.database.prepare(`
        SELECT 1 AS required FROM knowledge_cloud_retention WHERE knowledge_base_id = ?
        UNION SELECT 1 AS required FROM knowledge_cloud_deletion_receipts WHERE knowledge_base_id = ?
        UNION SELECT 1 AS required FROM cloud_sync_states
          WHERE knowledge_base_id = ? AND mode <> 'local_only'
        LIMIT 1
      `).get(baseId, baseId, baseId)
      if (cloud) {
        await active.cloud.purgeCloudImmediately(baseId)
        if (binding !== active || active.epoch !== epoch) fail('CONFLICT')
      }
      const objects = active.store.database.prepare(`
        SELECT version.object_id FROM document_versions AS version
        JOIN documents AS document ON document.id = version.document_id
        WHERE document.knowledge_base_id = ?
      `).all(baseId) as Array<{ object_id: string }>
      active.store.database.transaction(() => {
        if (storedRetention(active)?.baseId === baseId) {
          const epochRow = readProjection(active)
          active.store.database.prepare(`
            UPDATE knowledge_free_retention SET knowledge_base_id = NULL, document_id = NULL,
              confirmed = 0, entitlement_epoch = ?, updated_at = ? WHERE singleton = 1
          `).run(epochRow?.epoch ?? 0, now())
        }
        for (const object of objects) active.store.database.prepare(`
          INSERT OR IGNORE INTO knowledge_cleanup_records(object_id, created_at) VALUES (?, ?)
        `).run(object.object_id, now())
        active.store.database.prepare('DELETE FROM knowledge_bases WHERE id = ?').run(baseId)
      })()
      await purgeObjects(active, objects.map(object => object.object_id))
    },
    exportBase: async (owner, baseId) => {
      const active = current(owner)
      if (!baseSummary(active.store.database, baseId)) {
        if (remoteBaseSummary(active.store.database, baseId)) fail('SERVICE_UNAVAILABLE')
        fail('NOT_FOUND')
      }
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
        SELECT id FROM knowledge_bases WHERE recycled_at IS NULL
        UNION SELECT remote.id FROM cloud_base_projections AS remote
          LEFT JOIN knowledge_bases AS local ON local.id = remote.id
          WHERE local.id IS NULL
        ORDER BY id
      `).all() as Array<{ id: string }>
      return searchBases(active, query, bases.map(base => base.id))
    },
    searchSelected: async (owner, query, baseIds, signal, scope) => (
      searchBases(current(owner), query, baseIds, signal, scope)
    ),
    sourceAvailable: async (owner, documentId, versionId, signal) => {
      if (signal?.aborted) fail('CANCELLED')
      const active = current(owner)
      const state = entitlement(active)
      const kept = retention(active, state)
      if ((state.tier !== 'member' || state.status === 'expired')
        && kept?.documentId !== documentId) return false
      const row = active.store.database.prepare(`
        SELECT version.object_id AS objectId
        FROM documents AS document
        JOIN knowledge_bases AS base ON base.id = document.knowledge_base_id
        JOIN document_versions AS version
          ON version.id = ? AND version.document_id = document.id
        WHERE document.id = ?
          AND document.recycled_at IS NULL
          AND base.recycled_at IS NULL
          AND document.active_version_id = version.id
          AND version.status = 'ready'
        LIMIT 1
      `).get(versionId, documentId) as { objectId: string } | undefined
      if (!row) return false
      try {
        await active.store.objects.read(row.objectId)
      } catch {
        return false
      }
      assertCurrentBinding(active)
      if (signal?.aborted) fail('CANCELLED')
      return true
    },
    sourceVerifiable: async (owner, baseId, documentId, versionId, signal, scope) => {
      if (signal?.aborted) fail('CANCELLED')
      const active = current(owner)
      const captured = activeSearchScopes.get(scope.scopeId)
      if (captured !== scope || scope.ownerId !== active.ownerId
        || scope.ownerEpoch !== active.epoch) return false
      const entry = scope.entries.find(candidate => candidate.baseId === baseId
        && candidate.documentId === documentId && candidate.versionId === versionId)
      if (!entry) return false
      const local = active.store.database.prepare(`
        SELECT 1 AS verifiable
        FROM knowledge_bases AS base
        JOIN documents AS document ON document.knowledge_base_id = base.id
        JOIN document_versions AS version
          ON version.document_id = document.id AND version.id = ?
        WHERE base.id = ? AND document.id = ?
          AND version.publication_generation = ?
        LIMIT 1
      `).get(versionId, baseId, documentId, entry.publicationGeneration)
      if (local) return true
      if (!entry.cloudGenerationId || !scope.cloudAllowed || !ordinaryCloudAllowed(active)
        || scope.cloudConsentEpoch === undefined
        || !isCloudConsentCurrent(active, scope.cloudConsentEpoch)) return false
      const remote = active.store.database.prepare(`
        SELECT 1 AS verifiable
        FROM cloud_base_projections AS base
        JOIN cloud_document_projections AS document
          ON document.knowledge_base_id = base.id
        JOIN cloud_version_projections AS version
          ON version.document_id = document.id
        WHERE base.id = ? AND base.published_generation_id = ?
          AND document.id = ? AND document.status = 'ready'
          AND document.active_version_id = ?
          AND version.id = ? AND version.generation_id = ?
          AND version.status = 'ready'
        LIMIT 1
      `).get(
        baseId, entry.cloudGenerationId, documentId, versionId,
        versionId, entry.cloudGenerationId,
      )
      if (signal?.aborted) fail('CANCELLED')
      return remote !== undefined
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
      const active = current(owner)
      const state = entitlement(active)
      const projection = readProjection(active)
      const verified = projection?.verified === 1
        && state.tier === 'member'
        && (state.status === 'active' || state.status === 'offline_grace')
      const beta = verified && state.betaEnabled === true
      const cloudbase = cloudRemote !== undefined
      const cloud = active.cloudSyncConsentAccepted
        && beta && state.cloudEnabled && productionCloudRemote(cloudRemote) !== undefined
        && dependencies.cloudKillSwitchEnabled?.() === false
      return {
        encryption: { available: true },
        parser: { available: true },
        cloudbase: cloudbase ? { available: true } : { available: false, reason: 'cloudbase_unavailable' },
        embedding: active.semantic?.available()
          ? { available: true }
          : { available: false, reason: 'embedding_unavailable' },
        entitlement: verified ? { available: true } : { available: false, reason: 'entitlement_unavailable' },
        beta: beta ? { available: true } : { available: false, reason: 'beta_disabled' },
        cloud: cloud ? { available: true } : { available: false, reason: 'cloud_disabled' },
      }
    },
    getEntitlement: async (owner) => {
      if (unavailable?.ownerId === owner.userId && unavailable.epoch === epoch) {
        return { tier: 'free', status: 'unavailable', localEnabled: false, cloudEnabled: false }
      }
      const active = current(owner)
      const state = entitlement(active)
      const kept = retention(active, state)
      const retained = storedRetention(active)
      return {
        ...state,
        ...((state.tier !== 'member' || state.status === 'expired')
          ? { retentionConfirmed: retained?.confirmed === true }
          : {}),
        ...(kept ? {
          retainedBaseId: kept.baseId,
          ...(kept.documentId ? { retainedDocumentId: kept.documentId } : {}),
        } : {}),
      }
    },
    retainFreeAllowance: async (owner, input: KnowledgeRetentionSelection) => {
      const active = current(owner)
      const state = entitlement(active)
      if (state.tier === 'member' && state.status !== 'expired') fail('CONFLICT')
      const selected = active.store.database.prepare(`
        SELECT document.id AS documentId, base.id AS baseId
        FROM documents AS document
        JOIN knowledge_bases AS base ON base.id = document.knowledge_base_id
        WHERE base.id = ? AND document.id = ?
          AND base.recycled_at IS NULL AND document.recycled_at IS NULL
      `).get(input.baseId, input.documentId) as Omit<RetentionSelection, 'confirmed'> | undefined
      if (!selected) fail('NOT_FOUND')
      const existing = storedRetention(active)
      if (existing?.confirmed
        && (existing.baseId !== selected.baseId || existing.documentId !== selected.documentId)) {
        fail('CONFLICT')
      }
      active.store.database.transaction(() => {
        writeRetention(active, { ...selected, confirmed: true })
        active.store.database.prepare(`
          UPDATE cloud_sync_states
          SET mode = 'paused', epoch = epoch + 1, updated_at = ?
          WHERE knowledge_base_id <> ? AND mode NOT IN ('local_only', 'paused')
        `).run(now(), selected.baseId)
      })()
      return {
        ...state,
        retainedBaseId: selected.baseId,
        retainedDocumentId: selected.documentId,
        retentionConfirmed: true,
      }
    },
    getConsent: async (owner, provider: ModelProviderId = 'openrouter') => {
      if (unavailable?.ownerId === owner.userId && unavailable.epoch === epoch) {
        return { provider, status: 'unknown' }
      }
      const active = current(owner)
      const row = active.store.database.prepare(
        'SELECT status, updated_at FROM knowledge_provider_consents WHERE provider = ?',
      ).get(provider) as { status: 'granted' | 'denied'; updated_at: number } | undefined
      return row
        ? { provider, status: row.status, updatedAt: timestamp(row.updated_at) }
        : { provider, status: 'unknown' }
    },
    setConsent: async (owner, provider, status) => {
      const active = current(owner)
      const updatedAt = now()
      active.store.database.prepare(`
        INSERT INTO knowledge_provider_consents(provider, status, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(provider) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at
      `).run(provider, status, updatedAt)
      return { provider, status, updatedAt: timestamp(updatedAt) }
    },
    revokeConsent: async (owner, provider) => {
      const active = current(owner)
      active.store.database.prepare('DELETE FROM knowledge_provider_consents WHERE provider = ?').run(provider)
      return { provider, status: 'unknown' }
    },
    getDocumentPreview: async (owner, documentId): Promise<KnowledgeDocumentPreview> => {
      const active = current(owner)
      const document = documentSummary(active.store.database, documentId)
      if (!document || document.status !== 'ready') return { kind: 'unavailable' }
      const state = entitlement(active)
      const kept = retention(active, state)
      if ((state.tier !== 'member' || state.status === 'expired')
        && (kept?.baseId !== document.baseId || kept.documentId !== document.id)) {
        return { kind: 'unavailable' }
      }
      const rows = active.store.database.prepare(`
        SELECT chunk.body
        FROM kb_chunks AS chunk
        JOIN documents AS document ON document.id = chunk.document_id
        JOIN knowledge_bases AS base ON base.id = chunk.knowledge_base_id
        JOIN document_versions AS version
          ON version.id = chunk.version_id AND version.document_id = chunk.document_id
        WHERE document.id = ?
          AND base.recycled_at IS NULL AND document.recycled_at IS NULL
          AND document.active_version_id = version.id AND version.status = 'ready'
        ORDER BY chunk.ordinal
        LIMIT 129
      `).all(documentId) as Array<{ body: string }>
      const normalized = rows.slice(0, 128)
        .map(row => sanitizeKnowledgeText(row.body).trim())
        .filter(Boolean)
        .join('\n\n')
        .trim()
      const content = normalized.slice(0, 20_000).trim()
      const fallback = content ? {
        content,
        truncated: rows.length > 128 || normalized.length > content.length,
      } : undefined
      const version = active.store.database.prepare(`
        SELECT version.object_id AS objectId, version.mime_type AS mimeType
        FROM documents AS document
        JOIN knowledge_bases AS base ON base.id = document.knowledge_base_id
        JOIN document_versions AS version
          ON version.id = document.active_version_id AND version.document_id = document.id
        WHERE document.id = ?
          AND base.recycled_at IS NULL AND document.recycled_at IS NULL
          AND version.status = 'ready'
        LIMIT 1
      `).get(documentId) as { objectId: string; mimeType: ParserMediaType } | undefined
      if (!version || !mediaTypes.has(version.mimeType)) {
        return fallback ? { kind: 'available', ...fallback } : { kind: 'unavailable' }
      }

      let cleartext: Buffer | undefined
      let previewBytes: Uint8Array | undefined
      let delivered = false
      try {
        cleartext = await active.store.objects.read(version.objectId)
        assertCurrentBinding(active)
        if (cleartext.byteLength < 1 || cleartext.byteLength > MAX_KNOWLEDGE_IMPORT_BYTES) {
          return fallback ? { kind: 'available', ...fallback } : { kind: 'unavailable' }
        }
        previewBytes = Uint8Array.from(cleartext)
        delivered = true
        return {
          kind: 'original',
          mimeType: version.mimeType,
          bytes: previewBytes,
          ...(fallback ? { fallback } : {}),
        }
      } catch {
        assertCurrentBinding(active)
        return fallback ? { kind: 'available', ...fallback } : { kind: 'unavailable' }
      } finally {
        cleartext?.fill(0)
        if (!delivered) previewBytes?.fill(0)
      }
    },
    getSourcePreview: async (owner, input: KnowledgeSourcePreviewRequest): Promise<KnowledgeSourcePreview> => {
      const active = current(owner)
      const state = entitlement(active)
      const kept = retention(active, state)
      if ((state.tier !== 'member' || state.status === 'expired')
        && (kept?.baseId !== input.baseId || kept.documentId !== input.documentId)) {
        return { kind: 'unavailable' }
      }
      if (input.evidenceId !== `evidence:${input.evidenceId.slice('evidence:'.length)}`
        || !input.evidenceId.startsWith('evidence:')) return { kind: 'unavailable' }
      const row = active.store.database.prepare(`
        SELECT chunk.body
        FROM kb_chunks AS chunk
        JOIN documents AS document ON document.id = chunk.document_id
        JOIN knowledge_bases AS base ON base.id = chunk.knowledge_base_id
        JOIN document_versions AS version
          ON version.id = chunk.version_id AND version.document_id = chunk.document_id
        WHERE chunk.id = ? AND chunk.knowledge_base_id = ? AND chunk.document_id = ? AND chunk.version_id = ?
          AND base.recycled_at IS NULL AND document.recycled_at IS NULL
          AND document.active_version_id = version.id AND version.status = 'ready'
        LIMIT 1
      `).get(input.evidenceId.slice('evidence:'.length), input.baseId, input.documentId, input.versionId) as {
        body: string
      } | undefined
      if (!row) return { kind: 'unavailable' }
      const preview = sanitizeKnowledgeText(row.body)
        .slice(0, 4_000)
        .trim()
      return preview ? { kind: 'available', preview } : { kind: 'unavailable' }
    },
  }
}
