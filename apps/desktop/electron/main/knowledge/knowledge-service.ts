import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  toSafeAppError,
  type AppError,
  type KnowledgeAvailability,
  type KnowledgeBaseSummary,
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
import { CloudKnowledgeRetriever, type CloudCandidate } from './cloud-retriever.js'
import type { CloudKnowledgeChange } from './cloudbase-knowledge-client.js'
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
  handles: Map<string, ImportHandleRecord>
  cloud: KnowledgeCloudLifecycle
  cloudOwnerInvalidated: boolean
  cloudOwnerInvalidationFailed: boolean
  cloudOwnerInvalidationFailure?: unknown
  cloudTasks: Set<Promise<unknown>>
  cloudPublications: Map<string, Promise<void>>
}

interface UnavailableBinding {
  ownerId: string
  epoch: number
  encryptionAvailable: boolean
  parserAvailable: boolean
}

export interface LocalKnowledgeService extends KnowledgeService {
  bind(ownerId: string): Promise<void>
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
    scope?: KnowledgeSearchScope,
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
  publishGeneration(input: {
    requestId: string
    knowledgeBaseId: string
    generationId: string
  }): Promise<void>
  beginCloudRetention(knowledgeBaseId: string, boundaryAt: number): CloudRetentionState
  advanceCloudRetention(knowledgeBaseId: string): Promise<CloudRetentionState | undefined>
  purgeCloudImmediately(knowledgeBaseId: string): Promise<void>
  invalidateOwner(): void
  drain(): Promise<void>
}

type ProductionCloudKnowledgeRemote = CloudKnowledgeRemote & Required<Pick<
  CloudKnowledgeRemote, 'beginGeneration' | 'uploadDocument' | 'search'
>>

function productionCloudRemote(
  remote: CloudKnowledgeRemote | undefined,
): ProductionCloudKnowledgeRemote | undefined {
  return remote
    && typeof remote.beginGeneration === 'function'
    && typeof remote.uploadDocument === 'function'
    && typeof remote.search === 'function'
    ? remote as ProductionCloudKnowledgeRemote
    : undefined
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
    publishGeneration: async () => fail('SERVICE_UNAVAILABLE'),
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
    const applyChange = (
      change: CloudKnowledgeChange,
      guard: { readonly knowledgeBaseId: string; commit(write: () => void): void },
    ): void => guard.commit(() => {
      const payloadJson = JSON.stringify(change.payload)
      if (Buffer.byteLength(payloadJson, 'utf8') > 64 * 1_024) fail('INVALID_INPUT')
      store.database.prepare(`
        INSERT INTO cloud_entity_heads(
          knowledge_base_id, entity_kind, entity_id, revision, payload_json, deleted, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(knowledge_base_id, entity_kind, entity_id) DO UPDATE SET
          revision = excluded.revision, payload_json = excluded.payload_json,
          deleted = excluded.deleted, updated_at = excluded.updated_at
      `).run(
        guard.knowledgeBaseId, change.entityKind, change.entityId, change.revision,
        payloadJson, Number(change.operation === 'delete'), now(),
      )
    })
    return new KnowledgeSyncService(store.database, cloudRemote, {
      now,
      id,
      isOnline: () => true,
      applyRemoteChange: async (change, guard) => applyChange(change, guard),
      replaceRemoteSnapshot: async (changes, guard) => guard.commit(() => {
        store.database.transaction(() => {
          store.database.prepare(
            'DELETE FROM cloud_entity_heads WHERE knowledge_base_id = ?',
          ).run(guard.knowledgeBaseId)
          for (const change of changes) {
            const payloadJson = JSON.stringify(change.payload)
            if (Buffer.byteLength(payloadJson, 'utf8') > 64 * 1_024) fail('INVALID_INPUT')
            store.database.prepare(`
              INSERT INTO cloud_entity_heads(
                knowledge_base_id, entity_kind, entity_id, revision,
                payload_json, deleted, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(
              guard.knowledgeBaseId, change.entityKind, change.entityId, change.revision,
              payloadJson, Number(change.operation === 'delete'), now(),
            )
          }
        })()
      }),
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
    active.store.database.prepare(`
      INSERT INTO knowledge_entitlement_projection(
        singleton, tier, status, beta_enabled, cloud_enabled, expires_at,
        grace_ends_at, epoch, updated_at, accepted_issued_at, accepted_key_id,
        accepted_key_generation, accepted_snapshot_digest, verified, explicit_free, max_observed_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        tier = excluded.tier, status = excluded.status,
        beta_enabled = excluded.beta_enabled, cloud_enabled = excluded.cloud_enabled,
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
    const projected: KnowledgeEntitlementState = expiry !== undefined && graceEnd !== undefined
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
      ORDER BY base.created_at, base.id, document.created_at, document.id
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

  const assertWritableBase = (active: Binding, baseId: string): void => {
    if (isMember(active)) return
    const kept = retention(active)
    if (kept && kept.baseId !== baseId) fail('FORBIDDEN')
  }

  const assertWritableDocument = (active: Binding, documentId: string): void => {
    if (isMember(active)) return
    const kept = retention(active)
    if (!kept?.documentId || kept.documentId !== documentId) fail('FORBIDDEN')
  }

  const ordinaryCloudAllowed = (active: Binding): boolean => {
    const state = entitlement(active)
    return productionCloudRemote(cloudRemote) !== undefined
      && readProjection(active)?.verified === 1
      && state.tier === 'member'
      && (state.status === 'active' || state.status === 'offline_grace')
      && state.betaEnabled === true
      && state.cloudEnabled
      && dependencies.cloudKillSwitchEnabled?.() === false
  }

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
    recoveryAttempt: number
    nextRetryAt: number
    lastErrorCode: string | null
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
      base.name AS baseName, document.name AS documentName, version.mime_type AS mimeType,
      version.version_number AS versionNumber, version.content_hash AS contentHash
    FROM cloud_pending_publications AS pending
    JOIN knowledge_bases AS base ON base.id = pending.knowledge_base_id
    JOIN documents AS document ON document.id = pending.document_id
      AND document.knowledge_base_id = pending.knowledge_base_id
    JOIN document_versions AS version ON version.id = pending.version_id
      AND version.document_id = pending.document_id
    WHERE pending.knowledge_base_id = ?
  `).get(knowledgeBaseId) as PendingCloudPublication | undefined

  const processCloudPublication = async (
    active: Binding,
    knowledgeBaseId: string,
  ): Promise<void> => {
    const remote = productionCloudRemote(cloudRemote)
    if (!remote || !ordinaryCloudAllowed(active)) return
    let pending = pendingCloudPublication(active, knowledgeBaseId)
    if (!pending) return
    const published = active.store.database.prepare(`
      SELECT published_generation_id AS publishedGenerationId
      FROM cloud_sync_states WHERE knowledge_base_id = ?
    `).get(pending.knowledgeBaseId) as { publishedGenerationId: string | null } | undefined
    if (published?.publishedGenerationId === pending.generationId) {
      active.store.database.prepare(`
        DELETE FROM cloud_pending_publications
        WHERE knowledge_base_id = ? AND generation_id = ?
      `).run(pending.knowledgeBaseId, pending.generationId)
      return
    }
    if (!pending.uploadJobId) {
      const revision = stableCloudId(
        'revision', pending.documentId, pending.versionId, pending.contentHash,
      )
      await active.cloud.enableSync({
        requestId: stableCloudId('begin', pending.knowledgeBaseId, pending.generationId),
        knowledgeBaseId: pending.knowledgeBaseId,
        name: pending.baseName,
        revision,
        generationId: pending.generationId,
      })
      assertCurrentBinding(active)
      if (!ordinaryCloudAllowed(active)) return
      const head = active.store.database.prepare(`
        SELECT revision FROM cloud_entity_heads
        WHERE knowledge_base_id = ? AND entity_kind = 'document' AND entity_id = ?
      `).get(pending.knowledgeBaseId, pending.documentId) as { revision: string } | undefined
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
        },
      })
      const synchronization = await active.cloud.synchronize(pending.knowledgeBaseId) as {
        status?: string
      }
      assertCurrentBinding(active)
      if (synchronization.status !== 'synced' || !ordinaryCloudAllowed(active)) return
      const bytes = await active.store.objects.read(pending.objectId)
      assertCurrentBinding(active)
      try {
        const uploaded = await remote.uploadDocument({
          requestId: stableCloudId('upload', pending.documentId, pending.versionId),
          knowledgeBaseId: pending.knowledgeBaseId,
          documentId: pending.documentId,
          versionId: pending.versionId,
          byteSize: bytes.byteLength,
          sha256: pending.contentHash,
          mimeType: pending.mimeType,
          bytes,
        })
        assertCurrentBinding(active)
        if (!ordinaryCloudAllowed(active)) return
        const updated = active.store.database.prepare(`
          UPDATE cloud_pending_publications SET upload_job_id = ?, recovery_attempt = 0,
            next_retry_at = 0, last_error_code = NULL, updated_at = ?
          WHERE knowledge_base_id = ? AND generation_id = ? AND upload_job_id IS NULL
        `).run(
          uploaded.jobId, now(), pending.knowledgeBaseId, pending.generationId,
        )
        if (updated.changes !== 1) fail('CONFLICT')
        pending = { ...pending, uploadJobId: uploaded.jobId }
      } finally {
        bytes.fill(0)
      }
    }
    const uploadJobId = pending.uploadJobId
    if (!uploadJobId) return
    if (pending.nextRetryAt > now()) return
    let completed = false
    for (let poll = 0; poll < 3; poll += 1) {
      const job = await remote.getJob({ jobId: uploadJobId })
      assertCurrentBinding(active)
      if (!ordinaryCloudAllowed(active)) return
      if (job.jobId !== uploadJobId) fail('INTERNAL_ERROR')
      if (job.state === 'completed') { completed = true; break }
      if (job.state === 'failed' || job.state === 'cancelled') {
        fail('SERVICE_UNAVAILABLE')
      }
    }
    if (!completed) {
      const recoveryAttempt = pending.recoveryAttempt + 1
      const retryDelay = Math.min(60_000, 1_000 * (2 ** Math.min(recoveryAttempt - 1, 6)))
      active.store.database.prepare(`
        UPDATE cloud_pending_publications
        SET recovery_attempt = ?, next_retry_at = ?,
          last_error_code = 'GENERATION_NOT_READY', updated_at = ?
        WHERE knowledge_base_id = ? AND generation_id = ? AND upload_job_id = ?
      `).run(
        recoveryAttempt, now() + retryDelay, now(), pending.knowledgeBaseId,
        pending.generationId, uploadJobId,
      )
      return
    }
    await active.cloud.publishGeneration({
      requestId: pending.publishRequestId,
      knowledgeBaseId: pending.knowledgeBaseId,
      generationId: pending.generationId,
    })
    assertCurrentBinding(active)
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
    if (!ordinaryCloudAllowed(active)) return
    const rows = active.store.database.prepare(`
      SELECT knowledge_base_id AS knowledgeBaseId
      FROM cloud_pending_publications
      WHERE next_retry_at <= ?
      ORDER BY next_retry_at, updated_at, knowledge_base_id
      LIMIT 8
    `).all(now()) as Array<{ knowledgeBaseId: string }>
    for (const row of rows) {
      const recovery = serialCloudTask(
        active, row.knowledgeBaseId,
        () => processCloudPublication(active, row.knowledgeBaseId),
      )
      void recovery.catch(() => undefined)
    }
  }

  const stageCloudPublication = (
    active: Binding,
    knowledgeBaseId: string,
    documentId: string,
    publicationGeneration: number,
  ): void => {
    if (!ordinaryCloudAllowed(active)) return
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
    const result = await new LocalKnowledgeRetriever(active.store.database).search(
      normalized,
      allowedBases,
      kept?.documentId ? [kept.documentId] : undefined,
      admittedScope?.entries,
    )
    if (signal?.aborted) fail('CANCELLED')
    const remote = productionCloudRemote(cloudRemote)
    const liveCloudAllowed = ordinaryCloudAllowed(active)
    if (!remote || !liveCloudAllowed || (admittedScope && !admittedScope.cloudAllowed)) {
      return result
    }
    const cloudEntries = admittedScope?.entries ?? active.store.database.prepare(`
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
        await serialCloudTask(active, baseId, async () => {
          await processCloudPublication(active, baseId)
          const synchronized = await active.cloud.synchronize(baseId) as { status?: string }
          if (synchronized.status !== 'synced') fail('SERVICE_UNAVAILABLE')
        })
        assertCurrentBinding(active)
        if (!ordinaryCloudAllowed(active)) return result
      }
      const retrieved = await new CloudKnowledgeRetriever(remote).search(
        normalized, cloudBases, generations,
      )
      assertCurrentBinding(active)
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

  const bind = (ownerId: string): Promise<void> => {
    if (binding?.ownerId === ownerId && binding.epoch === epoch) return Promise.resolve()
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
      const runner = new ImportJobRunner({
        database: store.database,
        objects: store.objects,
        parser,
        ownerEpoch: bindEpoch,
        isCurrentOwnerEpoch: candidate => binding === active && epoch === candidate,
        token: id,
        onDocumentChanged: documentId => emitDocument(active, documentId),
      })
      Object.assign(active, {
        ownerId, epoch: bindEpoch, store, parser, runner, handles: new Map(),
        cloud: createCloudLifecycle(store), cloudOwnerInvalidated: false,
        cloudOwnerInvalidationFailed: false,
        cloudTasks: new Set(), cloudPublications: new Map(),
      })
      if (bindEpoch !== epoch) {
        const cleanup = await settle([() => runner.drain(), () => store.close()])
        const cleanupFailure = firstFailure(cleanup)
        if (cleanupFailure) throw cleanupFailure.reason
        fail('CONFLICT')
      }
      binding = active
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
    configureCloudRemote: (remote) => {
      if (binding && remote) fail('CONFLICT')
      if (binding) return
      cloudRemote = remote
    },
    refreshEntitlement: async (ownerId, snapshot, authorizationConfirmed = true) => {
      if (!dependencies.refreshEntitlement && !dependencies.verifyEntitlement) return
      const active = binding
      if (!active || active.ownerId !== ownerId || active.epoch !== epoch) fail('AUTH_REQUIRED')
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
      const kept = retention(active, state)
      const member = state.tier === 'member' && state.status !== 'expired'
      const ids = active.store.database.prepare(
        'SELECT id FROM knowledge_bases ORDER BY created_at, id',
      ).all() as Array<{ id: string }>
      return ids.map(row => baseSummary(
        active.store.database,
        row.id,
        !member && kept?.baseId !== row.id,
      )!)
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
      const entries = allowed.length === 0 ? [] : active.store.database.prepare(`
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
      const scope = Object.freeze({
        scopeId: id(), ownerId: active.ownerId, ownerEpoch: active.epoch,
        baseIds: Object.freeze([...allowed]),
        entries: Object.freeze(entries.map(entry => Object.freeze({ ...entry }))),
        cloudAllowed: ordinaryCloudAllowed(active),
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
      if (!member) {
        const count = active.store.database.prepare('SELECT count(*) AS count FROM knowledge_bases').get() as { count: number }
        if (count.count >= 1) fail('CONFLICT')
      }
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
      if (!baseSummary(active.store.database, baseId)) fail('NOT_FOUND')
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
      assertWritableBase(active, baseId)
      const base = active.store.database.prepare(
        'SELECT id FROM knowledge_bases WHERE id = ? AND recycled_at IS NULL',
      ).get(baseId)
      if (!base) fail('NOT_FOUND')
      if (!isMember(active)) {
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
      if (!isMember(active)) writeRetention(active, { baseId, documentId, confirmed: false })
      const parsing = active.runner.runQueued()
      const cloud = serialCloudTask(active, baseId, async () => {
        await parsing
        assertCurrentBinding(active)
        stageCloudPublication(active, baseId, documentId, 1)
        await processCloudPublication(active, baseId)
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
      const cloud = serialCloudTask(active, document.knowledge_base_id, async () => {
        await parsing
        assertCurrentBinding(active)
        stageCloudPublication(
          active, document.knowledge_base_id, documentId, publicationGeneration,
        )
        await processCloudPublication(active, document.knowledge_base_id)
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
      return searchBases(active, query, bases.map(base => base.id))
    },
    searchSelected: async (owner, query, baseIds, signal, scope) => (
      searchBases(current(owner), query, baseIds, signal, scope)
    ),
    sourceAvailable: async (owner, documentId, versionId, signal, scope) => {
      if (signal?.aborted) fail('CANCELLED')
      const active = current(owner)
      const captured = scope === undefined ? undefined : activeSearchScopes.get(scope.scopeId)
      if (scope !== undefined && (captured !== scope || scope.ownerId !== active.ownerId
        || scope.ownerEpoch !== active.epoch
        || !scope.entries.some(entry => entry.documentId === documentId
          && entry.versionId === versionId))) return false
      const state = scope === undefined ? entitlement(active) : undefined
      const kept = state === undefined ? undefined : retention(active, state)
      if (scope === undefined && (state!.tier !== 'member' || state!.status === 'expired')
        && kept?.documentId !== documentId) return false
      const row = active.store.database.prepare(`
        SELECT 1 AS available
        FROM documents AS document
        JOIN knowledge_bases AS base ON base.id = document.knowledge_base_id
        JOIN document_versions AS version
          ON version.id = ? AND version.document_id = document.id
        WHERE document.id = ?
          ${scope === undefined ? `AND document.recycled_at IS NULL
          AND base.recycled_at IS NULL
          AND document.active_version_id = version.id
          AND version.status = 'ready'` : ''}
        LIMIT 1
      `).get(versionId, documentId)
      if (signal?.aborted) fail('CANCELLED')
      return row !== undefined
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
      const cloud = beta && state.cloudEnabled && productionCloudRemote(cloudRemote) !== undefined
        && dependencies.cloudKillSwitchEnabled?.() === false
      return {
        encryption: { available: true },
        parser: { available: true },
        cloudbase: cloudbase ? { available: true } : { available: false, reason: 'cloudbase_unavailable' },
        embedding: { available: false, reason: 'embedding_unavailable' },
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
