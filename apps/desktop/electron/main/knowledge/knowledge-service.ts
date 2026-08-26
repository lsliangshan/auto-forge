import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type Database from 'better-sqlite3-multiple-ciphers'
import {
  toSafeAppError,
  type AppErrorCode,
  type KnowledgeBase,
  type KnowledgeChatProviderConsentState,
  knowledgeCitationReferenceSchema,
  type KnowledgeCitationPreview,
  type KnowledgeCitationReference,
  type KnowledgeConsentState,
  type KnowledgeDocument,
  type KnowledgeEmbeddingConsentState,
  type KnowledgeEntitlementState,
  type KnowledgeFeatureAvailability,
  type KnowledgeSearchResult,
  type KnowledgeSelection,
  type KnowledgeVersion,
} from '@autoforge/shared'
import type { SafeStoragePort } from '../security/secret-store.js'
import {
  createEncryptedObjectSnapshot,
  hashStableKnowledgeSource,
  unwrapSnapshotFileKey,
  type EncryptedObjectSnapshot,
} from './encrypted-object-store.js'
import { openUserKnowledgeDatabase, type OpenedUserKnowledgeDatabase } from './encrypted-database.js'
import { KnowledgeExportService } from './export-service.js'
import { KnowledgeKeyStore } from './key-store.js'
import {
  citationForKnowledgeChunk,
  LocalKnowledgeRetriever,
  type KnowledgeChunkRow,
  type LocalKnowledgeSearchOutcome,
} from './local-retriever.js'
import {
  CLOUD_RETRIEVAL_TOP_K,
  CloudRetriever,
  type CloudHybridRetrievalPort,
} from './cloud-retriever.js'
import { KnowledgeOrphanCleanupService } from './orphan-cleanup-service.js'
import type {
  KnowledgeOwner,
  KnowledgePersistence,
  KnowledgeSearchSnapshot,
} from './knowledge-types.js'
import type { ParserFormat } from './parser-protocol.js'
import { KnowledgePurgeService } from './purge-service.js'
import {
  KnowledgeImportRuntime,
  serializeKnowledgeMutation,
  type KnowledgeImportSession,
  type KnowledgeParserPort,
} from './import-job-runtime.js'

export type { KnowledgeParserPort } from './import-job-runtime.js'

const DEFAULT_BASE_NAME = '我的知识库'
const OBJECT_KEY_CHECK = 'object_master_key_check_v1'
const OBJECT_KEY_CHECK_DOMAIN = 'autoforge:knowledge:object-master-key-check:v1'
const RECYCLE_PERIOD_MS = 30 * 24 * 60 * 60 * 1_000

export interface KnowledgeEntitlementPort {
  getEntitlement(owner: KnowledgeOwner): Promise<KnowledgeEntitlementState>
}

export interface KnowledgeCloudPort extends CloudHybridRetrievalPort {
  getEntitlement(): Promise<KnowledgeEntitlementState & {
    killSwitchEnabled: boolean
    version: number
    validUntil: string | null
  }>
  getEmbeddingConsent(): Promise<KnowledgeEmbeddingConsentState>
  setEmbeddingConsent(input: {
    requestId: string
    status: 'granted' | 'denied' | 'revoked'
  }): Promise<KnowledgeEmbeddingConsentState>
}

interface OpenKnowledgeSession extends KnowledgeImportSession {
  readonly owner: KnowledgeOwner
}

export interface KnowledgeServiceOptions {
  readonly rootDirectory: string
  readonly safeStorage: SafeStoragePort
  readonly createParser: () => Promise<KnowledgeParserPort>
  readonly chooseImportFile: () => Promise<string | undefined>
  readonly chooseExportPath: (defaultName: string) => Promise<string | undefined>
  readonly ownsConversation: (owner: KnowledgeOwner, conversationId: string) => Promise<boolean>
  readonly entitlement?: KnowledgeEntitlementPort
  readonly cloud?: KnowledgeCloudPort
  readonly getChatProviderConsent?: (
    owner: KnowledgeOwner,
  ) => Promise<KnowledgeChatProviderConsentState>
  readonly now?: () => number
  readonly id?: () => string
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  readonly runtimeAvailable?: boolean
  readonly unlinkKnowledgeObject?: (path: string) => Promise<void>
  readonly vacuumKnowledgeDatabase?: (database: Database.Database) => void
  readonly rotateKnowledgeDatabaseKey?: (opened: OpenedUserKnowledgeDatabase) => Promise<void>
  readonly openKnowledgeDatabase?: typeof openUserKnowledgeDatabase
  readonly createObjectSnapshot?: typeof createEncryptedObjectSnapshot
  readonly removeKnowledgeObjectDurably?: (path: string) => Promise<void>
}

interface DocumentRow {
  id: string
  knowledgeBaseId: string
  name: string
  mimeType: string
  status: 'pending' | 'processing' | 'ready' | 'failed' | 'recycled'
  versionCount: number
  updatedAt: number
}

interface CapturedSearchScope {
  readonly ownerId: string
  readonly conversationId: string
  readonly epoch: number
  readonly allVersionIds: readonly string[]
  readonly localVersionIds: readonly string[]
  readonly cloud?: {
    readonly retriever: CloudRetriever
    readonly snapshot: Awaited<ReturnType<CloudRetriever['captureSnapshot']>>
  }
}

function failure(code: AppErrorCode): never {
  throw toSafeAppError({ code })
}

function iso(value: number): string {
  return new Date(value).toISOString()
}

function documentDto(row: DocumentRow): KnowledgeDocument {
  const status = {
    pending: 'queued',
    processing: 'parsing',
    ready: 'ready',
    failed: 'failed',
    recycled: 'deleted',
  } as const
  return {
    id: row.id,
    knowledgeBaseId: row.knowledgeBaseId,
    name: row.name,
    mimeType: row.mimeType,
    status: status[row.status],
    versionCount: row.versionCount,
    updatedAt: iso(row.updatedAt),
  }
}

function sourceType(path: string): { format: ParserFormat; mimeType: string; name: string } {
  const name = basename(path).trim()
  if (!name || name.length > 500) failure('INVALID_INPUT')
  const extension = name.toLowerCase().split('.').pop()
  switch (extension) {
    case 'pdf': return { format: 'pdf', mimeType: 'application/pdf', name }
    case 'docx': return { format: 'docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', name }
    case 'txt': return { format: 'txt', mimeType: 'text/plain', name }
    case 'md':
    case 'markdown': return { format: 'markdown', mimeType: 'text/markdown', name }
    case 'html':
    case 'htm': return { format: 'html', mimeType: 'text/html', name }
    default: failure('INVALID_INPUT')
  }
}

function objectKeyCheck(key: Buffer): Buffer {
  return createHmac('sha256', key).update(OBJECT_KEY_CHECK_DOMAIN).digest()
}

async function initializeObjectKey(
  database: Database.Database,
  keyStore: KnowledgeKeyStore,
): Promise<void> {
  const stored = database.prepare('SELECT value FROM knowledge_metadata WHERE key = ?')
    .get(OBJECT_KEY_CHECK) as { value: Buffer } | undefined
  if (stored && !keyStore.exists()) throw new Error('Knowledge object master key is unavailable')
  const key = keyStore.exists() ? await keyStore.loadActiveKey() : await keyStore.createActiveKey()
  try {
    const check = objectKeyCheck(key)
    if (stored) {
      const expected = Buffer.from(stored.value)
      if (expected.length !== check.length || !timingSafeEqual(expected, check)) {
        throw new Error('Knowledge object master key is invalid')
      }
    } else {
      database.prepare('INSERT INTO knowledge_metadata (key, value) VALUES (?, ?)')
        .run(OBJECT_KEY_CHECK, check)
    }
  } finally {
    key.fill(0)
  }
}

async function probeKnowledgeParser(parser: KnowledgeParserPort): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'autoforge-knowledge-probe-'))
  const sourcePath = join(directory, 'probe.txt')
  const objectPath = join(directory, 'probe.afobj')
  const objectKey = randomBytes(32)
  let wrappedFileKey: Buffer | undefined
  let fileKey: Buffer | undefined
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5_000)
  timeout.unref()
  try {
    await writeFile(sourcePath, 'knowledge parser probe', { mode: 0o600 })
    const snapshot = await createEncryptedObjectSnapshot({ sourcePath, objectPath, userKey: objectKey })
    wrappedFileKey = snapshot.wrappedFileKey
    fileKey = unwrapSnapshotFileKey(wrappedFileKey, objectKey)
    const jobId = randomUUID()
    const response = await parser.parse({
      jobId,
      format: 'txt',
      objectPath,
      fileKey,
      signal: controller.signal,
      timeoutMs: 5_000,
    })
    if (response.type !== 'result' || response.jobId !== jobId) {
      throw new Error('Knowledge parser probe failed')
    }
  } finally {
    clearTimeout(timeout)
    fileKey?.fill(0)
    wrappedFileKey?.fill(0)
    objectKey.fill(0)
    await rm(directory, { recursive: true, force: true })
  }
}

const defaultEntitlement: KnowledgeEntitlementPort = {
  getEntitlement: async () => ({
    tier: 'free', status: 'active', betaEnabled: false, cloudEnabled: false,
  }),
}

const defaultEmbeddingConsent: KnowledgeEmbeddingConsentState = {
  processor: 'tokenhub', processingRegion: 'Guangzhou',
  model: 'kinfra-text-embedding-0.6b', dimensions: 1024,
  status: 'unknown', retrievalByBase: [],
}

function hasMemberAccess(entitlement: KnowledgeEntitlementState): boolean {
  return entitlement.tier === 'member'
    && (entitlement.status === 'active' || entitlement.status === 'offline_grace')
}

function stableTextOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function mergeRankedResults(
  ...rankings: readonly KnowledgeSearchResult[][]
): KnowledgeSearchResult[] {
  const fused = new Map<string, { evidence: KnowledgeSearchResult; score: number }>()
  for (const ranking of rankings) ranking.forEach((evidence, index) => {
    const current = fused.get(evidence.evidenceId) ?? { evidence, score: 0 }
    current.score += 1 / (60 + index + 1)
    fused.set(evidence.evidenceId, current)
  })
  return [...fused.values()]
    .sort((left, right) => right.score - left.score
      || stableTextOrder(left.evidence.evidenceId, right.evidence.evidenceId))
    .slice(0, CLOUD_RETRIEVAL_TOP_K)
    .map(({ evidence, score }) => ({ ...evidence, score }))
}

const SEARCHABLE_BASE_PREDICATE = `
  knowledge_bases.status = 'active'
  AND EXISTS (
    SELECT 1 FROM documents AS searchable_documents
    JOIN document_versions AS searchable_versions
      ON searchable_versions.id = searchable_documents.active_version_id
    WHERE searchable_documents.knowledge_base_id = knowledge_bases.id
      AND searchable_documents.status <> 'recycled'
      AND searchable_versions.status = 'ready'
  )
`

export class KnowledgeService implements KnowledgePersistence {
  private session: OpenKnowledgeSession | undefined
  private opening: Promise<OpenKnowledgeSession> | undefined
  private closePromise: Promise<void> | undefined
  private closing = false
  private searchSnapshotEpoch = 0
  private readonly searchSnapshots = new WeakMap<KnowledgeSearchSnapshot, CapturedSearchScope>()
  private readonly mutations = new Set<Promise<unknown>>()
  private readonly imports = new KnowledgeImportRuntime({
    now: () => this.now(),
    isClosing: () => this.closing,
    track: operation => { this.track(operation) },
  })

  constructor(private readonly options: KnowledgeServiceOptions) {}

  async listBases(owner: KnowledgeOwner): Promise<KnowledgeBase[]> {
    const session = await this.ensureSession(owner)
    this.ensureDefaultBase(session)
    const rows = session.opened.database.prepare(`
      SELECT knowledge_bases.id, knowledge_bases.name, knowledge_bases.status,
        knowledge_bases.updated_at AS updatedAt,
        cloud_sync_states.mode AS syncMode,
        count(documents.id) AS documentCount,
        coalesce(sum(CASE WHEN documents.status IN ('pending', 'processing') THEN 1 ELSE 0 END), 0) AS processingCount,
        coalesce(sum(CASE WHEN documents.status = 'failed' THEN 1 ELSE 0 END), 0) AS failedCount,
        CASE WHEN ${SEARCHABLE_BASE_PREDICATE} THEN 1 ELSE 0 END AS searchable
      FROM knowledge_bases
      LEFT JOIN documents ON documents.knowledge_base_id = knowledge_bases.id
      LEFT JOIN cloud_sync_states ON cloud_sync_states.knowledge_base_id = knowledge_bases.id
      GROUP BY knowledge_bases.id
      ORDER BY knowledge_bases.created_at, knowledge_bases.id
    `).all() as Array<{
      id: string; name: string; status: 'active' | 'read_only' | 'recycled'; updatedAt: number
      documentCount: number; processingCount: number; failedCount: number; searchable: number
      syncMode: 'local_only' | 'syncing' | 'synced' | 'paused' | 'converting' | 'failed' | null
    }>
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      kind: row.syncMode && row.syncMode !== 'local_only' ? 'cloud' : 'local',
      status: row.status === 'recycled'
        ? 'recycled'
        : row.status === 'read_only'
          ? 'read_only'
          : row.processingCount > 0 || ['syncing', 'converting'].includes(row.syncMode ?? '')
            ? 'processing'
            : row.failedCount > 0 || row.syncMode === 'failed'
              ? 'failed'
              : row.syncMode === 'paused'
                ? 'paused'
                : 'ready',
      searchable: Boolean(row.searchable),
      documentCount: row.documentCount,
      updatedAt: iso(row.updatedAt),
    }))
  }

  async createBase(owner: KnowledgeOwner, rawName: string): Promise<KnowledgeBase> {
    await this.requireLocalWriteAccess(owner)
    const session = await this.ensureSession(owner)
    const name = rawName.trim()
    if (!name || name.length > 200) failure('INVALID_INPUT')
    const entitlement = await this.getEntitlement(owner)
    const now = this.now()
    const id = this.id()
    session.opened.database.transaction(() => {
      if (!hasMemberAccess(entitlement)) {
        const count = session.opened.database.prepare(
          "SELECT count(*) AS count FROM knowledge_bases WHERE status <> 'recycled'",
        ).get() as { count: number }
        if (count.count >= 1) failure('CONFLICT')
      }
      session.opened.database.prepare(`
        INSERT INTO knowledge_bases (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
      `).run(id, name, now, now)
    })()
    return { id, name, kind: 'local', status: 'ready', searchable: false, documentCount: 0, updatedAt: iso(now) }
  }

  async listDocuments(owner: KnowledgeOwner, knowledgeBaseId: string): Promise<KnowledgeDocument[]> {
    const session = await this.ensureSession(owner)
    this.requireBase(session, knowledgeBaseId)
    return (session.opened.database.prepare(`
      SELECT documents.id, documents.knowledge_base_id AS knowledgeBaseId,
        documents.name, documents.mime_type AS mimeType, documents.status,
        count(document_versions.id) AS versionCount, documents.updated_at AS updatedAt
      FROM documents
      JOIN document_versions ON document_versions.document_id = documents.id
      WHERE documents.knowledge_base_id = ?
      GROUP BY documents.id
      ORDER BY documents.updated_at DESC, documents.id
    `).all(knowledgeBaseId) as DocumentRow[]).map(documentDto)
  }

  async listVersions(owner: KnowledgeOwner, documentId: string): Promise<KnowledgeVersion[]> {
    const session = await this.ensureSession(owner)
    this.requireDocument(session, documentId)
    const rows = session.opened.database.prepare(`
      SELECT id, document_id AS documentId, version_number AS number, status, created_at AS createdAt
      FROM document_versions WHERE document_id = ? ORDER BY version_number DESC
    `).all(documentId) as Array<{
      id: string; documentId: string; number: number
      status: 'staging' | 'ready' | 'failed' | 'superseded'; createdAt: number
    }>
    return rows.map(row => ({
      id: row.id,
      documentId: row.documentId,
      number: row.number,
      status: row.status === 'superseded' ? 'retired' : row.status,
      createdAt: iso(row.createdAt),
    }))
  }

  async importDocument(owner: KnowledgeOwner, knowledgeBaseId: string): Promise<KnowledgeDocument | undefined> {
    await this.requireLocalWriteAccess(owner)
    const session = await this.ensureSession(owner)
    this.requireBase(session, knowledgeBaseId, true)
    return this.track(this.performImport(session, owner, { knowledgeBaseId }))
  }

  async replaceDocument(owner: KnowledgeOwner, documentId: string): Promise<KnowledgeDocument | undefined> {
    await this.requireLocalWriteAccess(owner)
    const session = await this.ensureSession(owner)
    const document = this.requireDocument(session, documentId, true)
    return this.track(this.performImport(session, owner, {
      knowledgeBaseId: document.knowledgeBaseId,
      documentId,
    }))
  }

  async recycleDocument(owner: KnowledgeOwner, documentId: string): Promise<void> {
    await this.requireLocalScopeAvailable()
    const session = await this.ensureSession(owner)
    await this.mutate(session, () => {
      const document = this.requireDocument(session, documentId)
      const now = this.now()
      session.opened.database.transaction(() => {
        this.imports.cancelJobs(session, 'document', documentId, now)
        session.opened.database.prepare(
          "UPDATE documents SET status = 'recycled', updated_at = ? WHERE id = ?",
        ).run(now, documentId)
        session.opened.database.prepare(`
          INSERT INTO tombstones (id, knowledge_base_id, entity_kind, entity_id, sequence, deleted_at, expires_at)
          VALUES (?, ?, 'document', ?, 0, ?, ?)
        `).run(this.id(), document.knowledgeBaseId, documentId, now, now + RECYCLE_PERIOD_MS)
      })()
    })
    await this.imports.abortAndDrainScope(session, 'document', documentId)
    await this.orphanCleanup(session).resumeScope('document', documentId)
  }

  async purgeDocument(owner: KnowledgeOwner, documentId: string): Promise<void> {
    const session = await this.ensureSession(owner)
    await this.track(this.purge(session, 'document', documentId))
  }

  async recycleBase(owner: KnowledgeOwner, knowledgeBaseId: string): Promise<void> {
    await this.requireLocalScopeAvailable()
    const session = await this.ensureSession(owner)
    await this.mutate(session, () => {
      this.requireBase(session, knowledgeBaseId)
      const now = this.now()
      session.opened.database.transaction(() => {
        this.imports.cancelJobs(session, 'knowledge_base', knowledgeBaseId, now)
        session.opened.database.prepare(
          "UPDATE knowledge_bases SET status = 'recycled', updated_at = ? WHERE id = ?",
        ).run(now, knowledgeBaseId)
        session.opened.database.prepare(
          "UPDATE documents SET status = 'recycled', updated_at = ? WHERE knowledge_base_id = ?",
        ).run(now, knowledgeBaseId)
        session.opened.database.prepare(
          'DELETE FROM conversation_selection_bases WHERE knowledge_base_id = ?',
        ).run(knowledgeBaseId)
        session.opened.database.prepare(`
          INSERT INTO tombstones (id, knowledge_base_id, entity_kind, entity_id, sequence, deleted_at, expires_at)
          VALUES (?, ?, 'knowledge_base', ?, 0, ?, ?)
        `).run(this.id(), knowledgeBaseId, knowledgeBaseId, now, now + RECYCLE_PERIOD_MS)
      })()
    })
    await this.imports.abortAndDrainScope(session, 'knowledge_base', knowledgeBaseId)
    await this.orphanCleanup(session).resumeScope('knowledge_base', knowledgeBaseId)
  }

  async purgeBase(owner: KnowledgeOwner, knowledgeBaseId: string): Promise<void> {
    const session = await this.ensureSession(owner)
    await this.track(this.purge(session, 'knowledge_base', knowledgeBaseId))
  }

  async exportBase(owner: KnowledgeOwner, knowledgeBaseId: string): Promise<void> {
    const session = await this.ensureSession(owner)
    const base = this.requireBase(session, knowledgeBaseId)
    const outputPath = await this.options.chooseExportPath(`${base.name}.zip`)
    if (!outputPath) return
    await this.track(new KnowledgeExportService({
      database: session.opened.database,
      objectsDirectory: session.objectsDirectory,
      loadObjectMasterKey: () => session.objectKeyStore.loadActiveKey(),
      now: this.options.now,
    }).exportBase(knowledgeBaseId, outputPath))
  }

  async getConversationSelection(owner: KnowledgeOwner, conversationId: string): Promise<KnowledgeSelection> {
    const session = await this.ensureSession(owner)
    await this.requireConversation(owner, conversationId)
    const selection = session.opened.database.prepare(`
      SELECT knowledge_mode AS knowledgeMode FROM conversation_selections WHERE conversation_id = ?
    `).get(conversationId) as { knowledgeMode: 'mixed' | 'strict' } | undefined
    if (!selection) return { knowledgeBaseIds: [], knowledgeMode: 'mixed' }
    const entitlement = await this.getEntitlement(owner)
    if (!['active', 'offline_grace'].includes(entitlement.status)) {
      return { knowledgeBaseIds: [], knowledgeMode: selection.knowledgeMode }
    }
    const bases = session.opened.database.prepare(`
      SELECT conversation_selection_bases.knowledge_base_id AS knowledgeBaseId
      FROM conversation_selection_bases
      JOIN knowledge_bases ON knowledge_bases.id = conversation_selection_bases.knowledge_base_id
      WHERE conversation_selection_bases.conversation_id = ?
        AND ${SEARCHABLE_BASE_PREDICATE}
      ORDER BY conversation_selection_bases.ordinal
    `).all(conversationId) as Array<{ knowledgeBaseId: string }>
    return { knowledgeBaseIds: bases.map(row => row.knowledgeBaseId), knowledgeMode: selection.knowledgeMode }
  }

  async updateConversationSelection(
    owner: KnowledgeOwner,
    conversationId: string,
    selection: KnowledgeSelection,
  ): Promise<KnowledgeSelection> {
    const session = await this.ensureSession(owner)
    await this.requireConversation(owner, conversationId)
    const unique = new Set(selection.knowledgeBaseIds)
    if (unique.size !== selection.knowledgeBaseIds.length || selection.knowledgeBaseIds.length > 32) {
      failure('INVALID_INPUT')
    }
    if (selection.knowledgeBaseIds.length > 0) {
      const entitlement = await this.getEntitlement(owner)
      if (!['active', 'offline_grace'].includes(entitlement.status)) failure('FORBIDDEN')
      const placeholders = selection.knowledgeBaseIds.map(() => '?').join(', ')
      const count = session.opened.database.prepare(`
        SELECT count(*) AS count FROM knowledge_bases
        WHERE id IN (${placeholders}) AND ${SEARCHABLE_BASE_PREDICATE}
      `).get(...selection.knowledgeBaseIds) as { count: number }
      if (count.count !== selection.knowledgeBaseIds.length) failure('NOT_FOUND')
    }
    const now = this.now()
    session.opened.database.transaction(() => {
      session.opened.database.prepare(`
        INSERT INTO conversation_selections (conversation_id, knowledge_mode, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET
          knowledge_mode = excluded.knowledge_mode, updated_at = excluded.updated_at
      `).run(conversationId, selection.knowledgeMode, now)
      session.opened.database.prepare(
        'DELETE FROM conversation_selection_bases WHERE conversation_id = ?',
      ).run(conversationId)
      const insert = session.opened.database.prepare(`
        INSERT INTO conversation_selection_bases (conversation_id, knowledge_base_id, ordinal)
        VALUES (?, ?, ?)
      `)
      selection.knowledgeBaseIds.forEach((baseId, ordinal) => insert.run(conversationId, baseId, ordinal))
    })()
    return { knowledgeBaseIds: [...selection.knowledgeBaseIds], knowledgeMode: selection.knowledgeMode }
  }

  async search(owner: KnowledgeOwner, conversationId: string, query: string): Promise<LocalKnowledgeSearchOutcome> {
    const session = await this.ensureSession(owner)
    const selection = await this.getConversationSelection(owner, conversationId)
    const normalizedQuery = query.trim()
    if (Array.from(normalizedQuery).length <= 1) return { kind: 'ask_for_detail', results: [] }
    if (selection.knowledgeBaseIds.length === 0) return { kind: 'results', results: [] }
    const localRetriever = new LocalKnowledgeRetriever(session.opened.database)
    const placeholders = selection.knowledgeBaseIds.map(() => '?').join(', ')
    const synced = session.opened.database.prepare(`
      SELECT cloud_sync_states.knowledge_base_id AS knowledgeBaseId
      FROM cloud_sync_states
      JOIN knowledge_bases ON knowledge_bases.id = cloud_sync_states.knowledge_base_id
      WHERE cloud_sync_states.knowledge_base_id IN (${placeholders})
        AND cloud_sync_states.mode = 'synced'
        AND cloud_sync_states.published_generation_id IS NOT NULL
        AND knowledge_bases.status = 'active'
    `).all(...selection.knowledgeBaseIds) as Array<{ knowledgeBaseId: string }>
    const syncedIds = new Set(synced.map(({ knowledgeBaseId }) => knowledgeBaseId))
    const cloudIds = selection.knowledgeBaseIds.filter(id => syncedIds.has(id))
    if (cloudIds.length === 0 || !this.options.cloud) {
      return localRetriever.search(selection.knowledgeBaseIds, normalizedQuery)
    }
    if (!await this.cloudRetrievalEnabled()) {
      return localRetriever.search(selection.knowledgeBaseIds, normalizedQuery)
    }
    const localIds = selection.knowledgeBaseIds.filter(id => !syncedIds.has(id))
    const localResults = localIds.length === 0
      ? []
      : (await localRetriever.search(localIds, normalizedQuery)).results
    let cloudResults: KnowledgeSearchResult[]
    try {
      const retriever = new CloudRetriever(this.options.cloud)
      const snapshot = await retriever.captureSnapshot(cloudIds)
      cloudResults = (await retriever.search(snapshot, normalizedQuery)).results
    } catch {
      cloudResults = (await localRetriever.search(cloudIds, normalizedQuery)).results
    }
    return { kind: 'results', results: mergeRankedResults(localResults, cloudResults) }
  }

  async captureSearchSnapshot(
    owner: KnowledgeOwner,
    conversationId: string,
  ): Promise<KnowledgeSearchSnapshot> {
    const session = await this.ensureSession(owner)
    const selection = await this.getConversationSelection(owner, conversationId)
    const snapshot = Object.freeze({
      selected: selection.knowledgeBaseIds.length > 0,
      knowledgeMode: selection.knowledgeMode,
    })
    if (selection.knowledgeBaseIds.length === 0) {
      this.searchSnapshots.set(snapshot, {
        ownerId: owner.userId, conversationId, epoch: this.searchSnapshotEpoch,
        allVersionIds: Object.freeze([]), localVersionIds: Object.freeze([]),
      })
      return snapshot
    }

    const placeholders = selection.knowledgeBaseIds.map(() => '?').join(', ')
    const versionRows = session.opened.database.prepare(`
      SELECT documents.knowledge_base_id AS knowledgeBaseId,
        documents.active_version_id AS versionId
      FROM documents
      JOIN document_versions ON document_versions.id = documents.active_version_id
      WHERE documents.knowledge_base_id IN (${placeholders})
        AND documents.status <> 'recycled'
        AND document_versions.status = 'ready'
      ORDER BY documents.knowledge_base_id, documents.id
    `).all(...selection.knowledgeBaseIds) as Array<{ knowledgeBaseId: string; versionId: string }>
    const syncedRows = session.opened.database.prepare(`
      SELECT cloud_sync_states.knowledge_base_id AS knowledgeBaseId
      FROM cloud_sync_states
      WHERE cloud_sync_states.knowledge_base_id IN (${placeholders})
        AND cloud_sync_states.mode = 'synced'
        AND cloud_sync_states.published_generation_id IS NOT NULL
      ORDER BY cloud_sync_states.knowledge_base_id
    `).all(...selection.knowledgeBaseIds) as Array<{ knowledgeBaseId: string }>
    const syncedIds = new Set(syncedRows.map(({ knowledgeBaseId }) => knowledgeBaseId))
    let cloud: CapturedSearchScope['cloud']
    if (syncedIds.size > 0 && this.options.cloud && await this.cloudRetrievalEnabled()) {
      try {
        const retriever = new CloudRetriever(this.options.cloud)
        cloud = {
          retriever,
          snapshot: await retriever.captureSnapshot(
            selection.knowledgeBaseIds.filter(id => syncedIds.has(id)),
          ),
        }
      } catch {
        cloud = undefined
      }
    }
    const allVersionIds = Object.freeze(versionRows.map(({ versionId }) => versionId))
    const localVersionIds = Object.freeze(versionRows
      .filter(({ knowledgeBaseId }) => cloud === undefined || !syncedIds.has(knowledgeBaseId))
      .map(({ versionId }) => versionId))
    this.searchSnapshots.set(snapshot, {
      ownerId: owner.userId,
      conversationId,
      epoch: this.searchSnapshotEpoch,
      allVersionIds,
      localVersionIds,
      ...(cloud === undefined ? {} : { cloud }),
    })
    return snapshot
  }

  async searchSnapshot(
    owner: KnowledgeOwner,
    snapshot: KnowledgeSearchSnapshot,
    rawQuery: string,
  ): Promise<LocalKnowledgeSearchOutcome> {
    const scope = this.searchSnapshots.get(snapshot)
    if (!scope
      || scope.ownerId !== owner.userId
      || scope.epoch !== this.searchSnapshotEpoch) failure('INVALID_INPUT')
    const session = await this.ensureSession(owner)
    const query = rawQuery.trim()
    if (Array.from(query).length <= 1) return { kind: 'ask_for_detail', results: [] }
    if (!snapshot.selected) return { kind: 'results', results: [] }
    const local = new LocalKnowledgeRetriever(session.opened.database)
    if (!scope.cloud) return local.searchVersions(scope.allVersionIds, query)
    const localResults = scope.localVersionIds.length === 0
      ? []
      : (await local.searchVersions(scope.localVersionIds, query)).results
    try {
      const cloudResults = (await scope.cloud.retriever.search(scope.cloud.snapshot, query)).results
      return { kind: 'results', results: mergeRankedResults(localResults, cloudResults) }
    } catch {
      return local.searchVersions(scope.allVersionIds, query)
    }
  }

  async previewCitation(
    owner: KnowledgeOwner,
    rawCitation: KnowledgeCitationReference,
  ): Promise<KnowledgeCitationPreview> {
    const parsed = knowledgeCitationReferenceSchema.safeParse(rawCitation)
    if (!parsed.success) failure('INVALID_INPUT')
    const session = await this.ensureSession(owner)
    const row = session.opened.database.prepare(`
      SELECT kb_chunks.id, kb_chunks.knowledge_base_id AS knowledgeBaseId,
        kb_chunks.document_id AS documentId, kb_chunks.version_id AS versionId,
        kb_chunks.block_id AS blockId, kb_chunks.body,
        kb_chunks.coordinates_json AS coordinatesJson
      FROM kb_chunks
      JOIN documents ON documents.id = kb_chunks.document_id
      JOIN knowledge_bases ON knowledge_bases.id = kb_chunks.knowledge_base_id
      WHERE kb_chunks.id = ?
        AND kb_chunks.document_id = ?
        AND kb_chunks.version_id = ?
        AND documents.status <> 'recycled'
        AND knowledge_bases.status <> 'recycled'
    `).get(
      parsed.data.evidenceId,
      parsed.data.documentId,
      parsed.data.versionId,
    ) as KnowledgeChunkRow | undefined
    if (!row) return { status: 'unavailable' }
    const citation = citationForKnowledgeChunk(row)
    if (!isDeepStrictEqual(citation, parsed.data)) return { status: 'unavailable' }
    const excerpt = row.body.trim().slice(0, 1_000)
    if (!excerpt) return { status: 'unavailable' }
    if (citation.kind === 'pdf') {
      return {
        status: 'available', excerpt, kind: citation.kind, page: citation.page,
        startOffset: citation.startOffset, endOffset: citation.endOffset,
      }
    }
    if (citation.kind === 'docx') {
      return {
        status: 'available', excerpt, kind: citation.kind,
        headingPath: citation.headingPath, paragraphId: citation.paragraphId,
      }
    }
    if (citation.kind === 'txt') {
      return {
        status: 'available', excerpt, kind: citation.kind,
        startLine: citation.startLine, endLine: citation.endLine,
        startColumn: citation.startColumn, endColumn: citation.endColumn,
      }
    }
    return { status: 'available', excerpt, kind: citation.kind, nodeId: citation.nodeId }
  }

  async getFeatureAvailability(owner: KnowledgeOwner): Promise<KnowledgeFeatureAvailability> {
    const reasons = await this.preflightAvailability()
    if (reasons.length === 0) {
      let opened: OpenedUserKnowledgeDatabase | undefined
      let parser: KnowledgeParserPort | undefined
      let stage: 'storage' | 'parser' = 'storage'
      try {
        opened = await (this.options.openKnowledgeDatabase ?? openUserKnowledgeDatabase)({
          rootDirectory: this.options.rootDirectory,
          userId: owner.userId,
          safeStorage: this.options.safeStorage,
        })
        const directory = dirname(opened.databasePath)
        await initializeObjectKey(
          opened.database,
          new KnowledgeKeyStore(join(directory, 'knowledge-object-key.json'), this.options.safeStorage),
        )
        stage = 'parser'
        parser = await this.options.createParser()
        await probeKnowledgeParser(parser)
      } catch (error) {
        if (stage === 'parser') reasons.push('native_dependency_unavailable')
        else if (String((error as Error).message).toLowerCase().match(/fts|trigram/)) reasons.push('fts_unavailable')
        else reasons.push('encrypted_storage_unavailable')
      } finally {
        try { await parser?.terminateAll() } catch {
          if (reasons.length === 0) reasons.push('native_dependency_unavailable')
        }
        try { opened?.close() } catch {
          if (reasons.length === 0) reasons.push('encrypted_storage_unavailable')
        }
      }
    }
    const cloudAvailable = await this.cloudRetrievalEnabled()
    return {
      local: { available: reasons.length === 0, reasons },
      cloud: cloudAvailable
        ? { available: true, reasons: [] }
        : { available: false, reasons: ['kill_switch_enabled'] },
    }
  }

  async getEntitlement(owner: KnowledgeOwner): Promise<KnowledgeEntitlementState> {
    this.assertOwner(owner)
    if (this.options.entitlement) return this.options.entitlement.getEntitlement(owner)
    if (!this.options.cloud) return defaultEntitlement.getEntitlement(owner)
    try {
      const entitlement = await this.options.cloud.getEntitlement()
      return {
        tier: entitlement.tier,
        status: entitlement.status,
        betaEnabled: entitlement.betaEnabled,
        cloudEnabled: entitlement.cloudEnabled,
      }
    } catch {
      return { tier: 'free', status: 'unavailable', betaEnabled: false, cloudEnabled: false }
    }
  }

  async getConsent(owner: KnowledgeOwner): Promise<KnowledgeConsentState> {
    this.assertOwner(owner)
    const chatProvider = await (this.options.getChatProviderConsent?.(owner)
      ?? Promise.resolve({ provider: 'deepseek' as const, status: 'unknown' as const }))
    let embedding = defaultEmbeddingConsent
    if (this.options.cloud) {
      try { embedding = await this.options.cloud.getEmbeddingConsent() } catch {
        embedding = defaultEmbeddingConsent
      }
    }
    return { chatProvider, embedding }
  }

  async setEmbeddingConsent(
    owner: KnowledgeOwner,
    status: 'granted' | 'denied' | 'revoked',
  ): Promise<KnowledgeConsentState> {
    this.assertOwner(owner)
    if (!this.options.cloud) failure('SERVICE_UNAVAILABLE')
    if (status === 'granted' && !await this.cloudRetrievalEnabled()) failure('SERVICE_UNAVAILABLE')
    let embedding: KnowledgeEmbeddingConsentState
    try {
      embedding = await this.options.cloud.setEmbeddingConsent({ requestId: this.id(), status })
    } catch {
      failure('SERVICE_UNAVAILABLE')
    }
    const chatProvider = await (this.options.getChatProviderConsent?.(owner)
      ?? Promise.resolve({ provider: 'deepseek' as const, status: 'unknown' as const }))
    return { chatProvider, embedding }
  }

  private assertOwner(owner: KnowledgeOwner): void {
    if (!owner.userId.trim()) failure('AUTH_REQUIRED')
    if (this.session && this.session.owner.userId !== owner.userId) failure('FORBIDDEN')
  }

  private async cloudRetrievalEnabled(): Promise<boolean> {
    if (!this.options.cloud) return false
    try {
      const entitlement = await this.options.cloud.getEntitlement()
      return !entitlement.killSwitchEnabled
        && entitlement.tier === 'member'
        && ['active', 'offline_grace'].includes(entitlement.status)
        && entitlement.betaEnabled
        && entitlement.cloudEnabled
    } catch {
      return false
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closing = true
    this.searchSnapshotEpoch += 1
    const initialSession = this.session
    const pendingOpening = this.opening
    const operation = (async () => {
      let session = initialSession
      try {
        if (!session && pendingOpening) {
          try { session = await pendingOpening } catch { /* Opening caller receives the authoritative error. */ }
        }
        if (session) {
          let teardownError: unknown
          this.imports.abortSession(session)
          try { await session.parser.terminateAll() } catch (error) { teardownError = error }
          await Promise.allSettled([...this.mutations])
          try { session.opened.close() } catch (error) { teardownError ??= error }
          if (teardownError) throw teardownError
        }
      } finally {
        if (this.session === session) this.session = undefined
        this.opening = undefined
        this.closing = false
      }
    })()
    this.closePromise = operation
    void operation.then(
      () => { if (this.closePromise === operation) this.closePromise = undefined },
      () => { if (this.closePromise === operation) this.closePromise = undefined },
    )
    return operation
  }

  private async ensureSession(owner: KnowledgeOwner): Promise<OpenKnowledgeSession> {
    if (!owner.userId.trim()) failure('AUTH_REQUIRED')
    if (this.closing) failure('CONFLICT')
    if (this.session) {
      if (this.session.owner.userId !== owner.userId) failure('FORBIDDEN')
      return this.session
    }
    if (!this.opening) this.opening = this.openSession(owner)
    const session = await this.opening
    if (session.owner.userId !== owner.userId) failure('FORBIDDEN')
    return session
  }

  private async openSession(owner: KnowledgeOwner): Promise<OpenKnowledgeSession> {
    if ((await this.preflightAvailability()).length > 0) failure('SERVICE_UNAVAILABLE')
    let opened: OpenedUserKnowledgeDatabase | undefined
    let parser: KnowledgeParserPort | undefined
    try {
      opened = await (this.options.openKnowledgeDatabase ?? openUserKnowledgeDatabase)({
        rootDirectory: this.options.rootDirectory,
        userId: owner.userId,
        safeStorage: this.options.safeStorage,
      })
      const directory = dirname(opened.databasePath)
      const objectKeyStore = new KnowledgeKeyStore(
        join(directory, 'knowledge-object-key.json'),
        this.options.safeStorage,
      )
      await initializeObjectKey(opened.database, objectKeyStore)
      parser = await this.options.createParser()
      const session: OpenKnowledgeSession = {
        owner: { userId: owner.userId },
        opened,
        parser,
        objectKeyStore,
        objectsDirectory: join(directory, 'objects'),
        mutationTail: Promise.resolve(),
      }
      await this.orphanCleanup(session).resumeAll()
      await this.purgeService(session).resumeAll()
      await this.imports.reconcile(session)
      this.session = session
      return session
    } catch (error) {
      try { await parser?.terminateAll() } catch { /* Preserve initialization failure. */ }
      try { opened?.close() } catch { /* Preserve initialization failure. */ }
      this.opening = undefined
      if (typeof error === 'object' && error !== null && 'code' in error) throw error
      failure('SERVICE_UNAVAILABLE')
    }
  }

  private async preflightAvailability(): Promise<KnowledgeFeatureAvailability['local']['reasons']> {
    const reasons: KnowledgeFeatureAvailability['local']['reasons'] = []
    if (this.options.runtimeAvailable === false) reasons.push('native_dependency_unavailable')
    if ((this.options.platform ?? process.platform) !== 'darwin'
      || (this.options.arch ?? process.arch) !== 'arm64') reasons.push('packaging_unverified')
    if (!await this.options.safeStorage.isAvailable()) reasons.push('safe_storage_unavailable')
    return reasons
  }

  private async requireLocalScopeAvailable(): Promise<void> {
    if ((await this.preflightAvailability()).length > 0) failure('SERVICE_UNAVAILABLE')
  }

  private async requireLocalWriteAccess(owner: KnowledgeOwner): Promise<void> {
    await this.requireLocalScopeAvailable()
    const entitlement = await this.getEntitlement(owner)
    if (!['active', 'offline_grace'].includes(entitlement.status)) failure('FORBIDDEN')
  }

  private ensureDefaultBase(session: OpenKnowledgeSession): void {
    const current = session.opened.database.prepare(
      "SELECT count(*) AS count FROM knowledge_bases WHERE status <> 'recycled'",
    ).get() as { count: number }
    if (current.count > 0) return
    const now = this.now()
    session.opened.database.prepare(`
      INSERT INTO knowledge_bases (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
    `).run(this.id(), DEFAULT_BASE_NAME, now, now)
  }

  private requireBase(session: OpenKnowledgeSession, id: string, writable = false): {
    id: string; name: string; status: 'active' | 'read_only' | 'recycled'
  } {
    const base = session.opened.database.prepare(
      'SELECT id, name, status FROM knowledge_bases WHERE id = ?',
    ).get(id) as { id: string; name: string; status: 'active' | 'read_only' | 'recycled' } | undefined
    if (!base) failure('NOT_FOUND')
    if (writable && base.status !== 'active') failure('FORBIDDEN')
    if (writable && this.hasPurgeJournal(session, 'knowledge_base', id)) failure('CONFLICT')
    return base
  }

  private requireDocument(session: OpenKnowledgeSession, id: string, writable = false): {
    id: string; knowledgeBaseId: string; activeVersionId?: string
  } {
    const document = session.opened.database.prepare(`
      SELECT documents.id, documents.knowledge_base_id AS knowledgeBaseId,
        documents.active_version_id AS activeVersionId, documents.status,
        knowledge_bases.status AS baseStatus
      FROM documents JOIN knowledge_bases ON knowledge_bases.id = documents.knowledge_base_id
      WHERE documents.id = ?
    `).get(id) as {
      id: string; knowledgeBaseId: string; activeVersionId?: string
      status: string; baseStatus: string
    } | undefined
    if (!document) failure('NOT_FOUND')
    if (writable && (document.status === 'recycled' || document.baseStatus !== 'active')) failure('FORBIDDEN')
    if (writable && (
      this.hasPurgeJournal(session, 'document', id)
      || this.hasPurgeJournal(session, 'knowledge_base', document.knowledgeBaseId)
    )) failure('CONFLICT')
    return document
  }

  private hasPurgeJournal(
    session: OpenKnowledgeSession,
    kind: 'document' | 'knowledge_base',
    targetId: string,
  ): boolean {
    return session.opened.database.prepare(
      'SELECT 1 FROM purge_operations WHERE entity_kind = ? AND target_id = ?',
    ).get(kind, targetId) !== undefined
  }

  private async requireConversation(owner: KnowledgeOwner, conversationId: string): Promise<void> {
    if (!await this.options.ownsConversation(owner, conversationId)) failure('NOT_FOUND')
  }

  private async performImport(
    session: OpenKnowledgeSession,
    owner: KnowledgeOwner,
    target: { knowledgeBaseId: string; documentId?: string },
  ): Promise<KnowledgeDocument | undefined> {
    const sourcePath = await this.options.chooseImportFile()
    if (!sourcePath) return undefined
    const source = sourceType(sourcePath)
    const contentHash = await hashStableKnowledgeSource(sourcePath)
    const entitlement = await this.getEntitlement(owner)
    const documentId = target.documentId ?? this.id()
    const versionId = this.id()
    const objectId = this.id()
    const relativeName = `${objectId}.afobj`
    const objectPath = join(session.objectsDirectory, relativeName)
    const jobId = this.id()
    const authorityToken = this.id()
    const now = this.now()
    let sourceObjectStored = false
    let versionNumber = 1
    let generation = 1
    let priorJobId: string | undefined
    let finishSnapshotTask: ((error?: unknown) => void) | undefined
    let snapshotTaskFailure: unknown
    try {
      await this.mutate(session, () => session.opened.database.transaction(() => {
        this.requireBase(session, target.knowledgeBaseId, true)
        if (!target.documentId && !hasMemberAccess(entitlement)) {
          const count = session.opened.database.prepare(`
            SELECT count(*) AS count FROM documents
            JOIN knowledge_bases ON knowledge_bases.id = documents.knowledge_base_id
            WHERE documents.status <> 'recycled' AND knowledge_bases.status <> 'recycled'
          `).get() as { count: number }
          if (count.count >= 1) failure('CONFLICT')
        }
        if (target.documentId) {
          const current = this.requireDocument(session, target.documentId, true)
          if (current.knowledgeBaseId !== target.knowledgeBaseId) failure('NOT_FOUND')
          versionNumber = (session.opened.database.prepare(`
            SELECT coalesce(max(version_number), 0) + 1 AS number
            FROM document_versions WHERE document_id = ?
          `).get(documentId) as { number: number }).number
        } else {
          session.opened.database.prepare(`
            INSERT INTO documents
              (id, knowledge_base_id, name, mime_type, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'pending', ?, ?)
          `).run(documentId, target.knowledgeBaseId, source.name, source.mimeType, now, now)
        }
        const head = session.opened.database.prepare(`
          SELECT generation, authoritative_job_id AS jobId
          FROM document_import_heads WHERE document_id = ?
        `).get(documentId) as { generation: number; jobId: string } | undefined
        generation = (head?.generation ?? 0) + 1
        priorJobId = head?.jobId
        if (priorJobId) {
          session.opened.database.prepare(`
            UPDATE jobs SET status = 'cancelled', error_code = 'SUPERSEDED', updated_at = ?
            WHERE id = ? AND status IN ('pending', 'running')
          `).run(now, priorJobId)
          session.opened.database.prepare(`
            UPDATE document_versions SET status = 'failed'
            WHERE id = (SELECT version_id FROM local_import_jobs WHERE job_id = ?)
              AND status = 'staging'
          `).run(priorJobId)
        }
        session.opened.database.prepare(`
          INSERT INTO document_versions
            (id, document_id, version_number, status, content_hash, source_object_id, created_at)
          VALUES (?, ?, ?, 'staging', ?, ?, ?)
        `).run(versionId, documentId, versionNumber, contentHash, objectId, now)
        session.opened.database.prepare(`
          INSERT INTO jobs (id, kind, entity_id, status, created_at, updated_at)
          VALUES (?, 'local_import', ?, 'pending', ?, ?)
        `).run(jobId, versionId, now, now)
        session.opened.database.prepare(`
          INSERT INTO local_import_jobs
            (job_id, authority_token, knowledge_base_id, document_id, version_id, object_id,
              generation, format, source_name, mime_type, created_at)
          VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
        `).run(
          jobId, authorityToken, target.knowledgeBaseId, documentId, versionId,
          generation, source.format, source.name, source.mimeType, now,
        )
        session.opened.database.prepare(`
          INSERT INTO document_import_heads
            (document_id, generation, authoritative_job_id, authority_token)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(document_id) DO UPDATE SET
            generation = excluded.generation,
            authoritative_job_id = excluded.authoritative_job_id,
            authority_token = excluded.authority_token
        `).run(documentId, generation, jobId, authorityToken)
        session.opened.database.prepare(
          "UPDATE documents SET status = 'processing', updated_at = ? WHERE id = ?",
        ).run(now, documentId)
        const snapshotTask = this.imports.beginSnapshot(session, {
          jobId, documentId, knowledgeBaseId: target.knowledgeBaseId,
        })
        finishSnapshotTask = error => snapshotTask.complete(error)
      })())
    } catch (error) {
      finishSnapshotTask?.()
      throw error
    }
    if (priorJobId) this.imports.abort(priorJobId)

    try {
      const objectMasterKey = await session.objectKeyStore.loadActiveKey()
      let snapshot: EncryptedObjectSnapshot
      try {
        snapshot = await (this.options.createObjectSnapshot ?? createEncryptedObjectSnapshot)({
          sourcePath,
          objectPath,
          userKey: objectMasterKey,
        })
      } finally {
        objectMasterKey.fill(0)
      }
      if (snapshot.contentHash !== contentHash) throw new Error('Knowledge source changed between validation and snapshot')
      try {
        const accepted = await this.mutate(session, () => session.opened.database.transaction(() => {
          const authoritative = session.opened.database.prepare(`
            SELECT 1 FROM document_import_heads
            JOIN jobs ON jobs.id = document_import_heads.authoritative_job_id
            JOIN local_import_jobs ON local_import_jobs.job_id = jobs.id
            JOIN documents ON documents.id = document_import_heads.document_id
            JOIN knowledge_bases ON knowledge_bases.id = documents.knowledge_base_id
            LEFT JOIN purge_operations AS document_purge
              ON document_purge.entity_kind = 'document' AND document_purge.target_id = documents.id
            LEFT JOIN purge_operations AS base_purge
              ON base_purge.entity_kind = 'knowledge_base'
              AND base_purge.target_id = knowledge_bases.id
            WHERE document_import_heads.document_id = ?
              AND document_import_heads.generation = ?
              AND document_import_heads.authoritative_job_id = ?
              AND document_import_heads.authority_token = ?
              AND jobs.status = 'pending'
              AND local_import_jobs.object_id IS NULL
              AND documents.status <> 'recycled'
              AND knowledge_bases.status = 'active'
              AND document_purge.id IS NULL AND base_purge.id IS NULL
          `).get(documentId, generation, jobId, authorityToken)
          if (!authoritative) return false
          session.opened.database.prepare(`
            INSERT INTO source_objects
              (id, relative_name, wrapped_file_key, byte_size, content_hash, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(objectId, relativeName, snapshot.wrappedFileKey, snapshot.encryptedBytes, snapshot.contentHash, now)
          session.opened.database.prepare(
            "UPDATE documents SET status = 'processing', updated_at = ? WHERE id = ?",
          ).run(this.now(), documentId)
          session.opened.database.prepare(
            'UPDATE local_import_jobs SET object_id = ? WHERE job_id = ?',
          ).run(objectId, jobId)
          return true
        })())
        sourceObjectStored = accepted
        if (!accepted) failure('CANCELLED')
      } finally {
        snapshot.wrappedFileKey.fill(0)
      }
      finishSnapshotTask?.()
      finishSnapshotTask = undefined
      this.imports.schedule(session, {
        knowledgeBaseId: target.knowledgeBaseId,
        documentId,
        versionId,
        objectId,
        jobId,
        format: source.format,
        objectPath,
        sourceName: source.name,
        mimeType: source.mimeType,
        generation,
        authorityToken,
      })
      return this.readDocument(session, documentId)
    } catch (error) {
      try {
        await this.imports.fail(session, {
          knowledgeBaseId: target.knowledgeBaseId,
          documentId,
          versionId,
          objectId,
          jobId,
          format: source.format,
          objectPath,
          sourceName: source.name,
          mimeType: source.mimeType,
          generation,
          authorityToken,
        }, 'IMPORT_FAILED')
      } catch {
        // Preserve the import failure; close/logout may already be tearing the database down.
      }
      let cleanupFailure: unknown
      if (!sourceObjectStored) {
        try {
          await this.orphanCleanup(session).journalAndRemove({ relativeName, jobId, documentId })
        } catch (cleanupError) {
          cleanupFailure = cleanupError
          snapshotTaskFailure = cleanupError
        }
      }
      if (cleanupFailure !== undefined) throw cleanupFailure
      if (typeof error === 'object' && error !== null && 'code' in error) throw error
      failure('INTERNAL_ERROR')
    } finally {
      finishSnapshotTask?.(snapshotTaskFailure)
    }
  }

  private async mutate<T>(session: OpenKnowledgeSession, operation: () => T | Promise<T>): Promise<T> {
    return serializeKnowledgeMutation(session, operation)
  }

  private readDocument(session: OpenKnowledgeSession, documentId: string): KnowledgeDocument {
    const row = session.opened.database.prepare(`
      SELECT documents.id, documents.knowledge_base_id AS knowledgeBaseId,
        documents.name, documents.mime_type AS mimeType, documents.status,
        count(document_versions.id) AS versionCount, documents.updated_at AS updatedAt
      FROM documents JOIN document_versions ON document_versions.document_id = documents.id
      WHERE documents.id = ? GROUP BY documents.id
    `).get(documentId) as DocumentRow | undefined
    if (!row) failure('NOT_FOUND')
    return documentDto(row)
  }

  private async purge(
    session: OpenKnowledgeSession,
    kind: 'document' | 'knowledge_base',
    id: string,
  ): Promise<void> {
    await this.purgeService(session).purge(kind, id)
  }

  private purgeService(session: OpenKnowledgeSession): KnowledgePurgeService {
    return new KnowledgePurgeService({
      opened: session.opened,
      objectsDirectory: session.objectsDirectory,
      now: () => this.now(),
      id: () => this.id(),
      mutate: operation => this.mutate(session, operation),
      requireTarget: (entityKind, targetId) => {
        if (entityKind === 'document') this.requireDocument(session, targetId)
        else this.requireBase(session, targetId)
      },
      cancelImportJobs: (entityKind, targetId, now) => (
        this.imports.cancelJobs(session, entityKind, targetId, now)
      ),
      abortAndDrain: (kind, id) => this.imports.abortAndDrainScope(session, kind, id),
      reconcileOrphans: (kind, id) => this.orphanCleanup(session).resumeScope(kind, id),
      unlinkObject: this.options.unlinkKnowledgeObject,
      vacuumDatabase: this.options.vacuumKnowledgeDatabase,
      rotateDatabaseKey: this.options.rotateKnowledgeDatabaseKey,
    })
  }

  private orphanCleanup(session: OpenKnowledgeSession): KnowledgeOrphanCleanupService {
    return new KnowledgeOrphanCleanupService({
      database: session.opened.database,
      objectsDirectory: session.objectsDirectory,
      mutate: operation => this.mutate(session, operation),
      removeObjectDurably: this.options.removeKnowledgeObjectDurably,
    })
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.mutations.add(operation)
    void operation.then(
      () => this.mutations.delete(operation),
      () => this.mutations.delete(operation),
    )
    return operation
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private id(): string {
    return this.options.id?.() ?? randomUUID()
  }
}
