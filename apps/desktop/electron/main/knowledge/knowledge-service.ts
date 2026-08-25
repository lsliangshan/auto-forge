import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { unlink } from 'node:fs/promises'
import type Database from 'better-sqlite3-multiple-ciphers'
import {
  toSafeAppError,
  type AppErrorCode,
  type KnowledgeBase,
  type KnowledgeConsentState,
  type KnowledgeDocument,
  type KnowledgeEntitlementState,
  type KnowledgeFeatureAvailability,
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
import { LocalKnowledgeRetriever, type LocalKnowledgeSearchOutcome } from './local-retriever.js'
import type { KnowledgeOwner, KnowledgePersistence } from './knowledge-types.js'
import type { ParserStartInput } from './parser-supervisor.js'
import type { ParserFormat, ParserResponse } from './parser-protocol.js'

const DEFAULT_BASE_NAME = '我的知识库'
const OBJECT_KEY_CHECK = 'object_master_key_check_v1'
const OBJECT_KEY_CHECK_DOMAIN = 'autoforge:knowledge:object-master-key-check:v1'
const RECYCLE_PERIOD_MS = 30 * 24 * 60 * 60 * 1_000

export interface KnowledgeParserPort {
  parse(input: ParserStartInput): Promise<ParserResponse>
  terminateAll(): Promise<void>
}

export interface KnowledgeEntitlementPort {
  getEntitlement(owner: KnowledgeOwner): Promise<KnowledgeEntitlementState>
}

interface OpenKnowledgeSession {
  readonly owner: KnowledgeOwner
  readonly opened: OpenedUserKnowledgeDatabase
  readonly parser: KnowledgeParserPort
  readonly objectKeyStore: KnowledgeKeyStore
  readonly objectsDirectory: string
}

export interface KnowledgeServiceOptions {
  readonly rootDirectory: string
  readonly safeStorage: SafeStoragePort
  readonly createParser: () => Promise<KnowledgeParserPort>
  readonly chooseImportFile: () => Promise<string | undefined>
  readonly chooseExportPath: (defaultName: string) => Promise<string | undefined>
  readonly ownsConversation: (owner: KnowledgeOwner, conversationId: string) => Promise<boolean>
  readonly entitlement?: KnowledgeEntitlementPort
  readonly getConsent?: (owner: KnowledgeOwner) => Promise<KnowledgeConsentState>
  readonly now?: () => number
  readonly id?: () => string
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  readonly runtimeAvailable?: boolean
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

const defaultEntitlement: KnowledgeEntitlementPort = {
  getEntitlement: async () => ({
    tier: 'free', status: 'active', betaEnabled: false, cloudEnabled: false,
  }),
}

function hasMemberAccess(entitlement: KnowledgeEntitlementState): boolean {
  return entitlement.tier === 'member'
    && (entitlement.status === 'active' || entitlement.status === 'offline_grace')
}

export class KnowledgeService implements KnowledgePersistence {
  private session: OpenKnowledgeSession | undefined
  private opening: Promise<OpenKnowledgeSession> | undefined
  private closePromise: Promise<void> | undefined
  private closing = false
  private readonly mutations = new Set<Promise<unknown>>()

  constructor(private readonly options: KnowledgeServiceOptions) {}

  async listBases(owner: KnowledgeOwner): Promise<KnowledgeBase[]> {
    const session = await this.ensureSession(owner)
    this.ensureDefaultBase(session)
    const rows = session.opened.database.prepare(`
      SELECT knowledge_bases.id, knowledge_bases.name, knowledge_bases.status,
        knowledge_bases.updated_at AS updatedAt,
        count(documents.id) AS documentCount,
        coalesce(sum(CASE WHEN documents.status IN ('pending', 'processing') THEN 1 ELSE 0 END), 0) AS processingCount,
        coalesce(sum(CASE WHEN documents.status = 'failed' THEN 1 ELSE 0 END), 0) AS failedCount
      FROM knowledge_bases
      LEFT JOIN documents ON documents.knowledge_base_id = knowledge_bases.id
      GROUP BY knowledge_bases.id
      ORDER BY knowledge_bases.created_at, knowledge_bases.id
    `).all() as Array<{
      id: string; name: string; status: 'active' | 'read_only' | 'recycled'; updatedAt: number
      documentCount: number; processingCount: number; failedCount: number
    }>
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      kind: 'local',
      status: row.status === 'recycled'
        ? 'recycled'
        : row.status === 'read_only'
          ? 'read_only'
          : row.processingCount > 0
            ? 'processing'
            : row.failedCount > 0
              ? 'failed'
              : 'ready',
      documentCount: row.documentCount,
      updatedAt: iso(row.updatedAt),
    }))
  }

  async createBase(owner: KnowledgeOwner, rawName: string): Promise<KnowledgeBase> {
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
    return { id, name, kind: 'local', status: 'ready', documentCount: 0, updatedAt: iso(now) }
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
    const session = await this.ensureSession(owner)
    this.requireBase(session, knowledgeBaseId, true)
    return this.track(this.performImport(session, owner, { knowledgeBaseId }))
  }

  async replaceDocument(owner: KnowledgeOwner, documentId: string): Promise<KnowledgeDocument | undefined> {
    const session = await this.ensureSession(owner)
    const document = this.requireDocument(session, documentId, true)
    return this.track(this.performImport(session, owner, {
      knowledgeBaseId: document.knowledgeBaseId,
      documentId,
    }))
  }

  async recycleDocument(owner: KnowledgeOwner, documentId: string): Promise<void> {
    const session = await this.ensureSession(owner)
    const document = this.requireDocument(session, documentId)
    const now = this.now()
    session.opened.database.transaction(() => {
      session.opened.database.prepare(
        "UPDATE documents SET status = 'recycled', updated_at = ? WHERE id = ?",
      ).run(now, documentId)
      session.opened.database.prepare(`
        INSERT INTO tombstones (id, knowledge_base_id, entity_kind, entity_id, sequence, deleted_at, expires_at)
        VALUES (?, ?, 'document', ?, 0, ?, ?)
      `).run(this.id(), document.knowledgeBaseId, documentId, now, now + RECYCLE_PERIOD_MS)
    })()
  }

  async purgeDocument(owner: KnowledgeOwner, documentId: string): Promise<void> {
    const session = await this.ensureSession(owner)
    this.requireDocument(session, documentId)
    await this.track(this.purge(session, 'document', documentId))
  }

  async recycleBase(owner: KnowledgeOwner, knowledgeBaseId: string): Promise<void> {
    const session = await this.ensureSession(owner)
    this.requireBase(session, knowledgeBaseId)
    const now = this.now()
    session.opened.database.transaction(() => {
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
  }

  async purgeBase(owner: KnowledgeOwner, knowledgeBaseId: string): Promise<void> {
    const session = await this.ensureSession(owner)
    this.requireBase(session, knowledgeBaseId)
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
    const bases = session.opened.database.prepare(`
      SELECT knowledge_base_id AS knowledgeBaseId FROM conversation_selection_bases
      WHERE conversation_id = ? ORDER BY ordinal
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
      const placeholders = selection.knowledgeBaseIds.map(() => '?').join(', ')
      const count = session.opened.database.prepare(`
        SELECT count(*) AS count FROM knowledge_bases
        WHERE id IN (${placeholders}) AND status = 'active'
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
    return new LocalKnowledgeRetriever(session.opened.database).search(selection.knowledgeBaseIds, query)
  }

  async getFeatureAvailability(owner: KnowledgeOwner): Promise<KnowledgeFeatureAvailability> {
    void owner
    const reasons: KnowledgeFeatureAvailability['local']['reasons'] = []
    if (this.options.runtimeAvailable === false) reasons.push('native_dependency_unavailable')
    if ((this.options.platform ?? process.platform) !== 'darwin'
      || (this.options.arch ?? process.arch) !== 'arm64') reasons.push('packaging_unverified')
    if (!await this.options.safeStorage.isAvailable()) reasons.push('safe_storage_unavailable')
    return {
      local: { available: reasons.length === 0, reasons },
      cloud: { available: false, reasons: ['kill_switch_enabled'] },
    }
  }

  getEntitlement(owner: KnowledgeOwner): Promise<KnowledgeEntitlementState> {
    return (this.options.entitlement ?? defaultEntitlement).getEntitlement(owner)
  }

  getConsent(owner: KnowledgeOwner): Promise<KnowledgeConsentState> {
    return this.options.getConsent?.(owner)
      ?? Promise.resolve({ provider: 'deepseek', status: 'unknown' })
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closing = true
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
    const availability = await this.getFeatureAvailability(owner)
    if (!availability.local.available) failure('SERVICE_UNAVAILABLE')
    let opened: OpenedUserKnowledgeDatabase | undefined
    let parser: KnowledgeParserPort | undefined
    try {
      opened = await openUserKnowledgeDatabase({
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
      const session = {
        owner: { userId: owner.userId },
        opened,
        parser,
        objectKeyStore,
        objectsDirectory: join(directory, 'objects'),
      }
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
    return document
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
    const now = this.now()
    let sourceObjectStored = false
    let snapshotCreated = false
    let versionNumber = 1
    session.opened.database.transaction(() => {
      const base = this.requireBase(session, target.knowledgeBaseId, true)
      void base
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
        session.opened.database.prepare(
          "UPDATE documents SET status = 'processing', updated_at = ? WHERE id = ?",
        ).run(now, documentId)
      } else {
        session.opened.database.prepare(`
          INSERT INTO documents
            (id, knowledge_base_id, name, mime_type, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'pending', ?, ?)
        `).run(documentId, target.knowledgeBaseId, source.name, source.mimeType, now, now)
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
    })()

    try {
      const objectMasterKey = await session.objectKeyStore.loadActiveKey()
      let snapshot: EncryptedObjectSnapshot
      try {
        snapshot = await createEncryptedObjectSnapshot({
          sourcePath,
          objectPath,
          userKey: objectMasterKey,
        })
        snapshotCreated = true
      } finally {
        objectMasterKey.fill(0)
      }
      if (snapshot.contentHash !== contentHash) throw new Error('Knowledge source changed between validation and snapshot')
      try {
        session.opened.database.transaction(() => {
          session.opened.database.prepare(`
            INSERT INTO source_objects
              (id, relative_name, wrapped_file_key, byte_size, content_hash, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(objectId, relativeName, snapshot.wrappedFileKey, snapshot.encryptedBytes, snapshot.contentHash, now)
          session.opened.database.prepare(
            "UPDATE documents SET status = 'processing', updated_at = ? WHERE id = ?",
          ).run(this.now(), documentId)
          session.opened.database.prepare(
            "UPDATE jobs SET status = 'running', attempt = 1, updated_at = ? WHERE id = ?",
          ).run(this.now(), jobId)
        })()
        sourceObjectStored = true
      } finally {
        snapshot.wrappedFileKey.fill(0)
      }

      const objectMasterKeyForParse = await session.objectKeyStore.loadActiveKey()
      let fileKey: Buffer
      try {
        const stored = session.opened.database.prepare(
          'SELECT wrapped_file_key AS wrappedFileKey FROM source_objects WHERE id = ?',
        ).get(objectId) as { wrappedFileKey: Buffer }
        fileKey = unwrapSnapshotFileKey(Buffer.from(stored.wrappedFileKey), objectMasterKeyForParse)
      } finally {
        objectMasterKeyForParse.fill(0)
      }
      let response: ParserResponse
      try {
        response = await session.parser.parse({
          jobId,
          format: source.format,
          objectPath,
          fileKey,
        })
      } finally {
        fileKey.fill(0)
      }
      if (response.type === 'error') {
        const code = ['PARSER_TIMEOUT', 'PARSER_INTERNAL_ERROR'].includes(response.code)
          ? 'SERVICE_UNAVAILABLE'
          : response.code === 'PARSER_CANCELLED'
            ? 'CANCELLED'
            : 'INVALID_INPUT'
        failure(code)
      }
      session.opened.database.transaction(() => {
        const insertBlock = session.opened.database.prepare(`
          INSERT INTO knowledge_blocks (id, version_id, ordinal, kind, text, coordinates_json)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        for (const [ordinal, block] of response.blocks.entries()) {
          insertBlock.run(
            `${versionId}:${block.id}`,
            versionId,
            ordinal,
            block.coordinate.kind,
            block.text,
            JSON.stringify(block.coordinate),
          )
        }
        const insertChunk = session.opened.database.prepare(`
          INSERT INTO kb_chunks
            (id, knowledge_base_id, document_id, version_id, block_id, ordinal, body, coordinates_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        const blocks = new Map(response.blocks.map(block => [block.id, {
          ...block,
          storedId: `${versionId}:${block.id}`,
        }]))
        for (const chunk of response.chunks) {
          const block = blocks.get(chunk.blockIds[0]!)
          if (!block) throw new Error('Knowledge parser returned an unknown block')
          insertChunk.run(
            `${versionId}:${chunk.index}`,
            target.knowledgeBaseId,
            documentId,
            versionId,
            block.storedId,
            chunk.index,
            chunk.text,
            JSON.stringify(block.coordinate),
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
        `).run(versionId, source.name, source.mimeType, this.now(), documentId)
        session.opened.database.prepare(
          "UPDATE jobs SET status = 'completed', updated_at = ? WHERE id = ?",
        ).run(this.now(), jobId)
      })()
      return this.readDocument(session, documentId)
    } catch (error) {
      try {
        session.opened.database.transaction(() => {
          session.opened.database.prepare(
            "UPDATE document_versions SET status = 'failed' WHERE id = ? AND status = 'staging'",
          ).run(versionId)
          session.opened.database.prepare(`
            UPDATE documents SET status =
              CASE WHEN active_version_id IS NULL THEN 'failed' ELSE 'ready' END,
              updated_at = ? WHERE id = ?
          `).run(this.now(), documentId)
          session.opened.database.prepare(`
            UPDATE jobs SET status = 'failed', error_code = ?, updated_at = ? WHERE id = ?
          `).run('IMPORT_FAILED', this.now(), jobId)
        })()
      } catch {
        // Preserve the import failure; close/logout may already be tearing the database down.
      }
      if (snapshotCreated && !sourceObjectStored) {
        try { await unlink(objectPath) } catch { /* Preserve the import failure. */ }
      }
      if (typeof error === 'object' && error !== null && 'code' in error) throw error
      failure('INTERNAL_ERROR')
    }
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
    const scope = kind === 'document' ? 'documents.id = ?' : 'documents.knowledge_base_id = ?'
    const objects = session.opened.database.prepare(`
      SELECT source_objects.id, source_objects.relative_name AS relativeName
      FROM source_objects
      JOIN document_versions ON document_versions.source_object_id = source_objects.id
      JOIN documents ON documents.id = document_versions.document_id
      WHERE ${scope}
    `).all(id) as Array<{ id: string; relativeName: string }>
    session.opened.database.transaction(() => {
      if (kind === 'document') {
        session.opened.database.prepare('DELETE FROM documents WHERE id = ?').run(id)
        session.opened.database.prepare(
          "DELETE FROM tombstones WHERE entity_kind = 'document' AND entity_id = ?",
        ).run(id)
      } else {
        session.opened.database.prepare('DELETE FROM knowledge_bases WHERE id = ?').run(id)
        session.opened.database.prepare(
          "DELETE FROM tombstones WHERE entity_kind = 'knowledge_base' AND entity_id = ?",
        ).run(id)
      }
      const deleteObject = session.opened.database.prepare('DELETE FROM source_objects WHERE id = ?')
      for (const object of objects) deleteObject.run(object.id)
    })()
    for (const object of objects) {
      if (!/^[0-9a-f-]{36}\.afobj$/.test(object.relativeName)) failure('INTERNAL_ERROR')
      try { await unlink(join(session.objectsDirectory, object.relativeName)) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    session.opened.database.exec('VACUUM')
    await session.opened.rotateKey()
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
