import type Database from 'better-sqlite3-multiple-ciphers'
import type {
  CloudKnowledgeChange,
  CloudPullChangesResult,
  CloudPushMutationResult,
  PublishGenerationInput,
  PushMutationInput,
} from './cloudbase-knowledge-client.js'

const LEASE_MS = 60_000
const MAX_ATTEMPTS = 3

export interface CloudKnowledgeRemote {
  beginSync(input: {
    requestId: string
    knowledgeBaseId: string
    name: string
    revision: string
    generationId: string
  }): Promise<{ knowledgeBaseId: string; generationId: string; status: 'staging' }>
  pushMutation(input: PushMutationInput): Promise<CloudPushMutationResult>
  pullChanges(input: { knowledgeBaseId: string; afterSequence: number }): Promise<CloudPullChangesResult>
  fullResync(input: { knowledgeBaseId: string }): Promise<{
    kind: 'incremental'
    nextSequence: number
    changes: CloudKnowledgeChange[]
  }>
  publishGeneration(input: PublishGenerationInput): Promise<{
    generationId: string
    previousGenerationId: string | null
    sequence: number
  }>
  deleteKnowledgeBase(input: {
    requestId: string
    knowledgeBaseId: string
    expectedPublishedGenerationId: string | null
  }): Promise<{ deletionJobId: string }>
  cancelJob(input: { requestId: string; jobId: string }): Promise<void>
  cleanupOrphans(input: {
    requestId: string
    knowledgeBaseId: string
    storageReferences: string[]
  }): Promise<{ removed: number }>
}

export type CloudSyncMode = 'local_only' | 'syncing' | 'synced' | 'paused' | 'converting' | 'failed'

interface SyncServiceDependencies {
  now(): number
  id(): string
  isOnline(): boolean
  applyRemoteChange(change: CloudKnowledgeChange): Promise<void>
  replaceRemoteSnapshot(changes: CloudKnowledgeChange[]): Promise<void>
}

interface MutationRow {
  id: string
  knowledgeBaseId: string
  entityKind: PushMutationInput['entityKind']
  entityId: string
  operation: PushMutationInput['operation']
  baseRevision: string | null
  payloadJson: string
  attempt: number
  leaseToken: string
}

interface ErrorShape {
  code?: unknown
  retryable?: unknown
}

function syncError(code: string): Error & { code: string; retryable: false } {
  return Object.assign(new Error(code), { code, retryable: false as const })
}

function classified(error: unknown): { code: string; retryable: boolean } {
  const candidate = typeof error === 'object' && error !== null ? error as ErrorShape : {}
  return {
    code: typeof candidate.code === 'string' ? candidate.code : 'INTERNAL_ERROR',
    retryable: candidate.retryable === true,
  }
}

function encodePayload(value: Record<string, unknown>): string {
  let encoded: string
  try { encoded = JSON.stringify(value) } catch { throw syncError('INVALID_INPUT') }
  if (Buffer.byteLength(encoded, 'utf8') > 64 * 1_024) throw syncError('INVALID_INPUT')
  return encoded
}

export class KnowledgeSyncService {
  constructor(
    private readonly database: Database.Database,
    private readonly remote: CloudKnowledgeRemote,
    private readonly dependencies: SyncServiceDependencies,
  ) {}

  enqueue(input: PushMutationInput): void {
    const now = this.dependencies.now()
    const payloadJson = encodePayload(input.payload)
    try {
      this.database.prepare(`
        INSERT INTO cloud_sync_mutations (
          id, knowledge_base_id, entity_kind, entity_id, operation, base_revision,
          payload_json, state, attempt, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)
      `).run(
        input.mutationId, input.knowledgeBaseId, input.entityKind, input.entityId,
        input.operation, input.baseRevision, payloadJson, now, now,
      )
    } catch (error) {
      const existing = this.database.prepare(`
        SELECT knowledge_base_id AS knowledgeBaseId, entity_kind AS entityKind,
          entity_id AS entityId, operation, base_revision AS baseRevision, payload_json AS payloadJson
        FROM cloud_sync_mutations WHERE id = ?
      `).get(input.mutationId) as Omit<MutationRow, 'id' | 'attempt' | 'leaseToken'> | undefined
      if (!existing
        || existing.knowledgeBaseId !== input.knowledgeBaseId
        || existing.entityKind !== input.entityKind
        || existing.entityId !== input.entityId
        || existing.operation !== input.operation
        || existing.baseRevision !== input.baseRevision
        || existing.payloadJson !== payloadJson) throw error
    }
  }

  async enableSync(input: {
    requestId: string
    knowledgeBaseId: string
    name: string
    revision: string
    generationId: string
  }): Promise<void> {
    if (!this.dependencies.isOnline()) throw syncError('OFFLINE')
    await this.remote.beginSync(input)
    this.setState(input.knowledgeBaseId, 'syncing', null)
  }

  async synchronize(knowledgeBaseId: string): Promise<{
    status: 'offline' | 'paused' | 'synced' | 'failed'
    processed: number
    conflicts: number
  }> {
    const state = this.getState(knowledgeBaseId)
    if (state.mode === 'paused' || state.mode === 'converting') {
      return { status: 'paused', processed: 0, conflicts: 0 }
    }
    if (!this.dependencies.isOnline()) {
      return { status: 'offline', processed: 0, conflicts: 0 }
    }
    this.setMode(knowledgeBaseId, 'syncing')
    let processed = 0
    let conflicts = 0
    while (true) {
      const mutation = this.claimMutation(knowledgeBaseId)
      if (!mutation) break
      try {
        const result = await this.remote.pushMutation({
          mutationId: mutation.id,
          knowledgeBaseId: mutation.knowledgeBaseId,
          entityKind: mutation.entityKind,
          entityId: mutation.entityId,
          operation: mutation.operation,
          baseRevision: mutation.baseRevision,
          payload: JSON.parse(mutation.payloadJson) as Record<string, unknown>,
        })
        if (result.status === 'conflict') {
          if (this.recordConflict(mutation, result)) conflicts += 1
        } else {
          if (this.completeMutation(mutation)) processed += 1
        }
      } catch (error) {
        this.failMutation(mutation, error)
      }
    }

    await this.pull(knowledgeBaseId)
    const failures = this.database.prepare(`
      SELECT count(*) AS count FROM cloud_sync_mutations
      WHERE knowledge_base_id = ? AND state = 'failed'
    `).get(knowledgeBaseId) as { count: number }
    if (failures.count > 0) {
      this.setMode(knowledgeBaseId, 'failed')
      return { status: 'failed', processed, conflicts }
    }
    this.setMode(knowledgeBaseId, 'synced')
    return { status: 'synced', processed, conflicts }
  }

  pause(knowledgeBaseId: string): void {
    this.setMode(knowledgeBaseId, 'paused')
  }

  resume(knowledgeBaseId: string): void {
    const current = this.getState(knowledgeBaseId)
    if (current.mode === 'converting') throw syncError('CONFLICT')
    this.setMode(knowledgeBaseId, 'syncing')
  }

  getState(knowledgeBaseId: string): {
    mode: CloudSyncMode
    publishedGenerationId: string | null
  } {
    const row = this.database.prepare(`
      SELECT mode, published_generation_id AS publishedGenerationId
      FROM cloud_sync_states WHERE knowledge_base_id = ?
    `).get(knowledgeBaseId) as {
      mode: CloudSyncMode
      publishedGenerationId: string | null
    } | undefined
    return row ?? { mode: 'local_only', publishedGenerationId: null }
  }

  async publishGeneration(input: {
    requestId: string
    knowledgeBaseId: string
    generationId: string
  }): Promise<void> {
    const current = this.getState(input.knowledgeBaseId)
    const published = await this.remote.publishGeneration({
      ...input,
      expectedPublishedGenerationId: current.publishedGenerationId,
    })
    const now = this.dependencies.now()
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO cloud_sync_states (
          knowledge_base_id, mode, published_generation_id, updated_at
        ) VALUES (?, 'synced', ?, ?)
        ON CONFLICT(knowledge_base_id) DO UPDATE SET
          mode = 'synced', published_generation_id = excluded.published_generation_id,
          updated_at = excluded.updated_at
      `).run(input.knowledgeBaseId, published.generationId, now)
      this.upsertCursor(input.knowledgeBaseId, published.sequence, now)
    })()
  }

  async convertToLocalOnly(
    knowledgeBaseId: string,
    downloadAndVerify: () => Promise<{
      complete: boolean
      expectedDigest: string
      actualDigest: string
    }>,
  ): Promise<void> {
    const previous = this.getState(knowledgeBaseId)
    this.setMode(knowledgeBaseId, 'converting')
    try {
      const verification = await downloadAndVerify()
      if (!verification.complete
        || !verification.expectedDigest
        || verification.expectedDigest !== verification.actualDigest) {
        throw syncError('INTEGRITY_FAILED')
      }
      await this.remote.deleteKnowledgeBase({
        requestId: this.dependencies.id(),
        knowledgeBaseId,
        expectedPublishedGenerationId: previous.publishedGenerationId,
      })
      const now = this.dependencies.now()
      this.database.transaction(() => {
        this.database.prepare('DELETE FROM sync_cursors WHERE knowledge_base_id = ?').run(knowledgeBaseId)
        this.database.prepare(`
          INSERT INTO cloud_sync_states (
            knowledge_base_id, mode, published_generation_id, updated_at
          ) VALUES (?, 'local_only', NULL, ?)
          ON CONFLICT(knowledge_base_id) DO UPDATE SET
            mode = 'local_only', published_generation_id = NULL, updated_at = excluded.updated_at
        `).run(knowledgeBaseId, now)
      })()
    } catch (error) {
      this.setState(knowledgeBaseId, previous.mode, previous.publishedGenerationId)
      throw error
    }
  }

  async cancelMutation(mutationId: string): Promise<void> {
    const row = this.database.prepare(`
      SELECT state FROM cloud_sync_mutations WHERE id = ?
    `).get(mutationId) as { state: string } | undefined
    if (!row || ['completed', 'cancelled', 'failed', 'conflict'].includes(row.state)) return
    this.database.prepare(`
      UPDATE cloud_sync_mutations
      SET state = 'cancelled', lease_token = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND state NOT IN ('completed', 'cancelled', 'failed', 'conflict')
    `).run(this.dependencies.now(), mutationId)
  }

  async cancelRemoteJob(jobId: string): Promise<void> {
    await this.remote.cancelJob({ requestId: this.dependencies.id(), jobId })
  }

  recordOrphan(knowledgeBaseId: string, storageReference: string): void {
    this.database.prepare(`
      INSERT OR IGNORE INTO cloud_sync_orphans (
        storage_reference, knowledge_base_id, request_id, created_at
      ) VALUES (?, ?, ?, ?)
    `).run(storageReference, knowledgeBaseId, `cleanup:${storageReference}`, this.dependencies.now())
  }

  async cleanupOrphans(knowledgeBaseId: string): Promise<void> {
    const rows = this.database.prepare(`
      SELECT storage_reference AS storageReference
      FROM cloud_sync_orphans WHERE knowledge_base_id = ?
      ORDER BY created_at LIMIT 100
    `).all(knowledgeBaseId) as Array<{ storageReference: string }>
    if (rows.length === 0) return
    const references = rows.map(row => row.storageReference)
    await this.remote.cleanupOrphans({
      requestId: this.dependencies.id(),
      knowledgeBaseId,
      storageReferences: references,
    })
    const placeholders = references.map(() => '?').join(', ')
    this.database.prepare(`
      DELETE FROM cloud_sync_orphans
      WHERE knowledge_base_id = ? AND storage_reference IN (${placeholders})
    `).run(knowledgeBaseId, ...references)
  }

  private claimMutation(knowledgeBaseId: string): MutationRow | undefined {
    return this.database.transaction(() => {
      const now = this.dependencies.now()
      const candidate = this.database.prepare(`
        SELECT id FROM cloud_sync_mutations
        WHERE knowledge_base_id = ?
          AND attempt < ?
          AND (state IN ('queued', 'retry')
            OR (state = 'leased' AND lease_expires_at <= ?))
        ORDER BY created_at, id LIMIT 1
      `).get(knowledgeBaseId, MAX_ATTEMPTS, now) as { id: string } | undefined
      if (!candidate) return undefined
      const token = this.dependencies.id()
      const updated = this.database.prepare(`
        UPDATE cloud_sync_mutations
        SET state = 'leased', attempt = attempt + 1, lease_token = ?, lease_expires_at = ?,
          error_code = NULL, updated_at = ?
        WHERE id = ? AND attempt < ?
          AND (state IN ('queued', 'retry') OR (state = 'leased' AND lease_expires_at <= ?))
      `).run(token, now + LEASE_MS, now, candidate.id, MAX_ATTEMPTS, now)
      if (updated.changes !== 1) return undefined
      return this.database.prepare(`
        SELECT id, knowledge_base_id AS knowledgeBaseId, entity_kind AS entityKind,
          entity_id AS entityId, operation, base_revision AS baseRevision,
          payload_json AS payloadJson, attempt, lease_token AS leaseToken
        FROM cloud_sync_mutations WHERE id = ?
      `).get(candidate.id) as MutationRow
    })()
  }

  private completeMutation(mutation: MutationRow): boolean {
    const updated = this.database.prepare(`
      UPDATE cloud_sync_mutations SET state = 'completed', lease_token = NULL,
        lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND state = 'leased' AND lease_token = ?
    `).run(this.dependencies.now(), mutation.id, mutation.leaseToken)
    return updated.changes === 1
  }

  private failMutation(mutation: MutationRow, error: unknown): void {
    const failure = classified(error)
    const nextState = failure.retryable && mutation.attempt < MAX_ATTEMPTS ? 'retry' : 'failed'
    this.database.prepare(`
      UPDATE cloud_sync_mutations SET state = ?, error_code = ?, lease_token = NULL,
        lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND state = 'leased' AND lease_token = ?
    `).run(nextState, failure.code, this.dependencies.now(), mutation.id, mutation.leaseToken)
  }

  private recordConflict(
    mutation: MutationRow,
    result: Extract<CloudPushMutationResult, { status: 'conflict' }>,
  ): boolean {
    const now = this.dependencies.now()
    return this.database.transaction(() => {
      const updated = this.database.prepare(`
        UPDATE cloud_sync_mutations SET state = 'conflict', lease_token = NULL,
          lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND state = 'leased' AND lease_token = ?
      `).run(now, mutation.id, mutation.leaseToken)
      if (updated.changes !== 1) return false
      this.database.prepare(`
        INSERT INTO conflicts (
          id, knowledge_base_id, entity_kind, entity_id, local_version,
          remote_version, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)
        ON CONFLICT(id) DO NOTHING
      `).run(
        `cloud:${mutation.id}`, mutation.knowledgeBaseId,
        result.conflictKind === 'delete_vs_update' ? 'delete_vs_update' : mutation.entityKind,
        mutation.entityId, result.localRevision, result.remoteRevision, now,
      )
      return true
    })()
  }

  private async pull(knowledgeBaseId: string): Promise<void> {
    const cursor = this.database.prepare(`
      SELECT sequence FROM sync_cursors WHERE knowledge_base_id = ?
    `).get(knowledgeBaseId) as { sequence: number } | undefined
    let result = await this.remote.pullChanges({
      knowledgeBaseId,
      afterSequence: cursor?.sequence ?? 0,
    })
    let full = false
    if (result.kind === 'cursor_stale') {
      result = await this.remote.fullResync({ knowledgeBaseId })
      full = true
    }
    if (full) await this.dependencies.replaceRemoteSnapshot(result.changes)
    else for (const change of result.changes) await this.dependencies.applyRemoteChange(change)
    this.upsertCursor(knowledgeBaseId, result.nextSequence, this.dependencies.now())
  }

  private upsertCursor(knowledgeBaseId: string, sequence: number, now: number): void {
    this.database.prepare(`
      INSERT INTO sync_cursors (knowledge_base_id, sequence, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(knowledge_base_id) DO UPDATE SET
        sequence = max(sync_cursors.sequence, excluded.sequence), updated_at = excluded.updated_at
    `).run(knowledgeBaseId, sequence, now)
  }

  private setMode(knowledgeBaseId: string, mode: CloudSyncMode): void {
    this.setState(knowledgeBaseId, mode, this.getState(knowledgeBaseId).publishedGenerationId)
  }

  private setState(
    knowledgeBaseId: string,
    mode: CloudSyncMode,
    publishedGenerationId: string | null,
  ): void {
    this.database.prepare(`
      INSERT INTO cloud_sync_states (
        knowledge_base_id, mode, published_generation_id, updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(knowledge_base_id) DO UPDATE SET
        mode = excluded.mode, published_generation_id = excluded.published_generation_id,
        updated_at = excluded.updated_at
    `).run(knowledgeBaseId, mode, publishedGenerationId, this.dependencies.now())
  }
}
