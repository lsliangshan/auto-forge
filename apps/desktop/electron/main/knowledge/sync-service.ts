import type Database from 'better-sqlite3'
import type {
  CloudKnowledgeChange,
  CloudPullChangesResult,
  CloudPushMutationResult,
  PublishGenerationInput,
  PushMutationInput,
} from './cloudbase-knowledge-client.js'

const LEASE_MS = 60_000
const MAX_ATTEMPTS = 3
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000

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
    kind: 'snapshot'
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
  getJob(input: { jobId: string }): Promise<{
    jobId: string
    state: 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
    errorCode: string | null
  }>
  cancelJob(input: { requestId: string; jobId: string }): Promise<void>
  cleanupOrphans(input: {
    requestId: string
    knowledgeBaseId: string
    storageReferences: string[]
  }): Promise<{ removed: number }>
}

export type CloudSyncMode = 'local_only' | 'syncing' | 'synced' | 'paused' | 'converting' | 'failed'

export interface KnowledgeSyncCommitGuard {
  readonly knowledgeBaseId: string
  commit(write: () => void): void
}

interface SyncServiceDependencies {
  now(): number
  id(): string
  isOnline(): boolean
  applyRemoteChange(
    change: CloudKnowledgeChange,
    guard: KnowledgeSyncCommitGuard,
  ): Promise<void>
  replaceRemoteSnapshot(
    changes: CloudKnowledgeChange[],
    guard: KnowledgeSyncCommitGuard,
  ): Promise<void>
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

interface SyncResult {
  status: 'offline' | 'paused' | 'synced' | 'failed'
  processed: number
  conflicts: number
}

interface ConversionRow {
  operationId: string
  requestId: string
  state: 'downloading' | 'verified' | 'purge_accepted' | 'completed'
  expectedPublishedGenerationId: string | null
  deletionJobId: string | null
  expectedDigest: string | null
  actualDigest: string | null
  previousMode: Exclude<CloudSyncMode, 'converting'>
}

export interface CloudRetentionState {
  knowledgeBaseId: string
  stage: 'download_window' | 'recycle' | 'purging'
  downloadUntil: number
  recycleUntil: number
  epoch: number
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
    retryable: candidate.code === 'TRANSIENT_FAILURE' && candidate.retryable === true,
  }
}

function encodePayload(value: Record<string, unknown>): string {
  let encoded: string
  try { encoded = JSON.stringify(value) } catch { throw syncError('INVALID_INPUT') }
  if (Buffer.byteLength(encoded, 'utf8') > 64 * 1_024) throw syncError('INVALID_INPUT')
  return encoded
}

export class KnowledgeSyncService {
  private readonly activeSynchronizations = new Map<string, Promise<SyncResult>>()
  private readonly activeConversions = new Map<string, Promise<void>>()
  private entitlementEpoch = 0
  private cloudAllowed = false
  private cloudAccessApplied = false

  constructor(
    private readonly database: Database.Database,
    private readonly remote: CloudKnowledgeRemote,
    private readonly dependencies: SyncServiceDependencies,
  ) {}

  /** Main entitlement/kill-switch hook. Revocation advances all durable base epochs. */
  setCloudAccess(allowed: boolean): void {
    if (this.cloudAccessApplied && this.cloudAllowed === allowed) return
    this.cloudAllowed = allowed
    this.cloudAccessApplied = true
    this.entitlementEpoch += 1
    if (!allowed) {
      const now = this.dependencies.now()
      this.database.prepare(`
        INSERT INTO cloud_sync_states (
          knowledge_base_id, mode, published_generation_id, epoch, updated_at
        ) SELECT id, 'paused', NULL, 1, ? FROM knowledge_bases WHERE 1
        ON CONFLICT(knowledge_base_id) DO UPDATE SET
          mode = CASE WHEN cloud_sync_states.mode = 'converting'
            THEN cloud_sync_states.mode ELSE 'paused' END,
          epoch = CASE WHEN cloud_sync_states.mode = 'converting'
            THEN cloud_sync_states.epoch ELSE cloud_sync_states.epoch + 1 END,
          updated_at = excluded.updated_at
      `).run(now)
    }
  }

  private captureCloudAccess(): number {
    if (!this.cloudAllowed) throw syncError('FORBIDDEN')
    return this.entitlementEpoch
  }

  private assertCloudAccess(epoch: number): void {
    if (!this.cloudAllowed || epoch !== this.entitlementEpoch) throw syncError('CONFLICT')
  }

  enqueue(input: PushMutationInput): void {
    this.captureCloudAccess()
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
    const entitlementEpoch = this.captureCloudAccess()
    if (!this.dependencies.isOnline()) throw syncError('OFFLINE')
    const control = this.getControl(input.knowledgeBaseId)
    if (control.mode === 'paused' || control.mode === 'converting') throw syncError('CONFLICT')
    const begun = await this.remote.beginSync(input)
    this.assertCloudAccess(entitlementEpoch)
    const current = this.getControl(input.knowledgeBaseId)
    if (current.epoch !== control.epoch
      || current.mode === 'paused' || current.mode === 'converting') throw syncError('CONFLICT')
    if (begun.knowledgeBaseId !== input.knowledgeBaseId
      || begun.generationId !== input.generationId || begun.status !== 'staging') {
      throw syncError('INTERNAL_ERROR')
    }
    this.setState(input.knowledgeBaseId, 'syncing', null)
  }

  synchronize(knowledgeBaseId: string): Promise<SyncResult> {
    const active = this.activeSynchronizations.get(knowledgeBaseId)
    if (active) return active
    const synchronization = this.runSynchronization(knowledgeBaseId)
    this.activeSynchronizations.set(knowledgeBaseId, synchronization)
    const clear = () => {
      if (this.activeSynchronizations.get(knowledgeBaseId) === synchronization) {
        this.activeSynchronizations.delete(knowledgeBaseId)
      }
    }
    void synchronization.then(clear, clear)
    return synchronization
  }

  private async runSynchronization(knowledgeBaseId: string): Promise<SyncResult> {
    const entitlementEpoch = this.captureCloudAccess()
    const state = this.getState(knowledgeBaseId)
    if (state.mode === 'paused' || state.mode === 'converting') {
      return { status: 'paused', processed: 0, conflicts: 0 }
    }
    if (!this.dependencies.isOnline()) {
      return { status: 'offline', processed: 0, conflicts: 0 }
    }
    const epoch = this.setMode(knowledgeBaseId, 'syncing')
    this.expireTerminalLeases(knowledgeBaseId)
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
        this.assertCloudAccess(entitlementEpoch)
        if (!this.isActive(knowledgeBaseId, epoch)) {
          return { status: 'paused', processed, conflicts }
        }
        if (result.mutationId !== mutation.id) throw syncError('INTERNAL_ERROR')
        if (result.status === 'conflict') {
          if (this.recordConflict(mutation, result)) conflicts += 1
        } else {
          if (this.completeMutation(mutation)) processed += 1
        }
      } catch (error) {
        if (!this.isActive(knowledgeBaseId, epoch)) {
          return { status: 'paused', processed, conflicts }
        }
        this.failMutation(mutation, error)
      }
    }

    await this.pull(knowledgeBaseId, epoch)
    if (!this.isActive(knowledgeBaseId, epoch)) {
      return { status: 'paused', processed, conflicts }
    }
    this.assertCloudAccess(entitlementEpoch)
    const failures = this.database.prepare(`
      SELECT count(*) AS count FROM cloud_sync_mutations
      WHERE knowledge_base_id = ? AND state = 'failed'
    `).get(knowledgeBaseId) as { count: number }
    if (failures.count > 0) {
      this.compareAndSetMode(knowledgeBaseId, epoch, 'failed')
      return { status: 'failed', processed, conflicts }
    }
    this.compareAndSetMode(knowledgeBaseId, epoch, 'synced')
    return { status: 'synced', processed, conflicts }
  }

  pause(knowledgeBaseId: string): void {
    this.setMode(knowledgeBaseId, 'paused')
  }

  cancel(knowledgeBaseId: string): void {
    const now = this.dependencies.now()
    this.database.transaction(() => {
      this.setMode(knowledgeBaseId, 'paused')
      this.database.prepare(`
        UPDATE cloud_sync_mutations
        SET state = 'cancelled', lease_token = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE knowledge_base_id = ?
          AND state NOT IN ('completed', 'cancelled', 'failed', 'conflict')
      `).run(now, knowledgeBaseId)
    })()
  }

  invalidateOwner(): void {
    this.cloudAllowed = false
    this.cloudAccessApplied = true
    this.entitlementEpoch += 1
    const now = this.dependencies.now()
    this.database.prepare(`
      INSERT INTO cloud_sync_states (
        knowledge_base_id, mode, published_generation_id, epoch, updated_at
      ) SELECT id, 'paused', NULL, 1, ? FROM knowledge_bases WHERE 1
      ON CONFLICT(knowledge_base_id) DO UPDATE SET
        mode = 'paused', epoch = cloud_sync_states.epoch + 1, updated_at = excluded.updated_at
    `).run(now)
  }

  resume(knowledgeBaseId: string): void {
    this.captureCloudAccess()
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

  beginCloudRetention(
    knowledgeBaseId: string,
    entitlementBoundaryAt = this.dependencies.now(),
  ): CloudRetentionState {
    const existing = this.getCloudRetention(knowledgeBaseId)
    if (existing) return existing
    if (!Number.isSafeInteger(entitlementBoundaryAt) || entitlementBoundaryAt < 0) {
      throw syncError('INVALID_INPUT')
    }
    const exists = this.database.prepare(
      'SELECT 1 AS present FROM knowledge_bases WHERE id = ?',
    ).get(knowledgeBaseId)
    if (!exists) throw syncError('NOT_FOUND')
    const now = this.dependencies.now()
    const operationId = this.dependencies.id()
    const generatedRequestId = this.dependencies.id()
    const requestId = generatedRequestId === operationId
      ? `retention:${operationId}`.slice(0, 128)
      : generatedRequestId
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO knowledge_cloud_retention(
          knowledge_base_id, stage, download_until, recycle_until,
          operation_id, request_id, deletion_job_id, epoch, updated_at
        ) VALUES (?, 'download_window', ?, ?, ?, ?, NULL, 1, ?)
      `).run(
        knowledgeBaseId,
        entitlementBoundaryAt + THIRTY_DAYS_MS,
        entitlementBoundaryAt + (2 * THIRTY_DAYS_MS),
        operationId, requestId, now,
      )
      this.setMode(knowledgeBaseId, 'paused')
    })()
    return this.getCloudRetention(knowledgeBaseId)!
  }

  getCloudRetention(knowledgeBaseId: string): CloudRetentionState | undefined {
    return this.database.prepare(`
      SELECT knowledge_base_id AS knowledgeBaseId, stage,
        download_until AS downloadUntil, recycle_until AS recycleUntil, epoch
      FROM knowledge_cloud_retention WHERE knowledge_base_id = ?
    `).get(knowledgeBaseId) as CloudRetentionState | undefined
  }

  recycleCloud(knowledgeBaseId: string): CloudRetentionState {
    const current = this.beginCloudRetention(knowledgeBaseId)
    if (current.stage === 'purging') throw syncError('CONFLICT')
    if (current.stage !== 'recycle') {
      this.database.prepare(`
        UPDATE knowledge_cloud_retention
        SET stage = 'recycle', epoch = epoch + 1, updated_at = ?
        WHERE knowledge_base_id = ? AND epoch = ?
      `).run(this.dependencies.now(), knowledgeBaseId, current.epoch)
    }
    return this.getCloudRetention(knowledgeBaseId)!
  }

  async advanceCloudRetention(knowledgeBaseId: string): Promise<CloudRetentionState | undefined> {
    const current = this.getCloudRetention(knowledgeBaseId)
    if (!current) return undefined
    const now = this.dependencies.now()
    if (now >= current.recycleUntil) {
      await this.purgeCloudImmediately(knowledgeBaseId)
      return undefined
    }
    if (now >= current.downloadUntil && current.stage === 'download_window') {
      return this.recycleCloud(knowledgeBaseId)
    }
    return current
  }

  /** GDPR-style deletion remains available even while sync/search gates are closed. */
  async purgeCloudImmediately(knowledgeBaseId: string): Promise<void> {
    let row = this.database.prepare(`
      SELECT request_id AS requestId, deletion_job_id AS deletionJobId, epoch
      FROM knowledge_cloud_retention WHERE knowledge_base_id = ?
    `).get(knowledgeBaseId) as {
      requestId: string; deletionJobId: string | null; epoch: number
    } | undefined
    if (!row) row = (() => {
      this.beginCloudRetention(knowledgeBaseId)
      return this.database.prepare(`
        SELECT request_id AS requestId, deletion_job_id AS deletionJobId, epoch
        FROM knowledge_cloud_retention WHERE knowledge_base_id = ?
      `).get(knowledgeBaseId) as { requestId: string; deletionJobId: string | null; epoch: number }
    })()
    if (!row.deletionJobId) {
      const expected = this.getState(knowledgeBaseId).publishedGenerationId
      const accepted = await this.remote.deleteKnowledgeBase({
        requestId: row.requestId,
        knowledgeBaseId,
        expectedPublishedGenerationId: expected,
      })
      const updated = this.database.prepare(`
        UPDATE knowledge_cloud_retention
        SET stage = 'purging', deletion_job_id = ?, epoch = epoch + 1, updated_at = ?
        WHERE knowledge_base_id = ? AND epoch = ?
      `).run(accepted.deletionJobId, this.dependencies.now(), knowledgeBaseId, row.epoch)
      if (updated.changes !== 1) throw syncError('CONFLICT')
      row = { ...row, deletionJobId: accepted.deletionJobId, epoch: row.epoch + 1 }
    }
    const deletionJobId = row.deletionJobId
    if (!deletionJobId) throw syncError('INTERNAL_ERROR')
    let completed = false
    for (let poll = 0; poll < 3; poll += 1) {
      const job = await this.remote.getJob({ jobId: deletionJobId })
      const current = this.database.prepare(`
        SELECT epoch, deletion_job_id AS deletionJobId
        FROM knowledge_cloud_retention WHERE knowledge_base_id = ?
      `).get(knowledgeBaseId) as { epoch: number; deletionJobId: string | null } | undefined
      if (!current || current.epoch !== row.epoch || current.deletionJobId !== row.deletionJobId) {
        throw syncError('CONFLICT')
      }
      if (job.jobId !== deletionJobId) throw syncError('INTERNAL_ERROR')
      if (job.state === 'completed') { completed = true; break }
      if (job.state === 'failed' || job.state === 'cancelled') {
        throw syncError(job.errorCode ?? 'INTERNAL_ERROR')
      }
    }
    if (!completed) throw Object.assign(new Error('TRANSIENT_FAILURE'), {
      code: 'TRANSIENT_FAILURE', retryable: true as const,
    })
    this.database.transaction(() => {
      const removed = this.database.prepare(`
        DELETE FROM knowledge_cloud_retention
        WHERE knowledge_base_id = ? AND epoch = ? AND deletion_job_id = ?
      `).run(knowledgeBaseId, row.epoch, row.deletionJobId)
      if (removed.changes !== 1) throw syncError('CONFLICT')
      this.setState(knowledgeBaseId, 'local_only', null)
    })()
  }

  async publishGeneration(input: {
    requestId: string
    knowledgeBaseId: string
    generationId: string
  }): Promise<void> {
    const entitlementEpoch = this.captureCloudAccess()
    const current = this.getControl(input.knowledgeBaseId)
    const published = await this.remote.publishGeneration({
      ...input,
      expectedPublishedGenerationId: current.publishedGenerationId,
    })
    this.assertCloudAccess(entitlementEpoch)
    if (!this.isEpochCurrent(input.knowledgeBaseId, current.epoch)
      || ['paused', 'converting'].includes(this.getState(input.knowledgeBaseId).mode)) {
      throw syncError('CONFLICT')
    }
    if (published.generationId !== input.generationId) throw syncError('INTERNAL_ERROR')
    const now = this.dependencies.now()
    this.database.transaction(() => {
      const updated = this.database.prepare(`
        INSERT INTO cloud_sync_states (
          knowledge_base_id, mode, published_generation_id, epoch, updated_at
        ) VALUES (?, 'synced', ?, 1, ?)
        ON CONFLICT(knowledge_base_id) DO UPDATE SET
          mode = 'synced', published_generation_id = excluded.published_generation_id,
          epoch = cloud_sync_states.epoch + 1, updated_at = excluded.updated_at
        WHERE cloud_sync_states.epoch = ?
      `).run(input.knowledgeBaseId, published.generationId, now, current.epoch)
      if (updated.changes !== 1) throw syncError('CONFLICT')
      this.upsertCursor(input.knowledgeBaseId, published.sequence, now)
    })()
  }

  convertToLocalOnly(
    knowledgeBaseId: string,
    downloadAndVerify: (guard: KnowledgeSyncCommitGuard) => Promise<{
      complete: boolean
      expectedDigest: string
      actualDigest: string
    }>,
  ): Promise<void> {
    const active = this.activeConversions.get(knowledgeBaseId)
    if (active) return active
    const retention = this.getCloudRetention(knowledgeBaseId)
    const durableConversion = this.database.prepare(
      'SELECT 1 AS present FROM cloud_sync_conversions WHERE knowledge_base_id = ?',
    ).get(knowledgeBaseId)
    if (retention && !durableConversion
      && (retention.stage !== 'download_window'
        || this.dependencies.now() >= retention.downloadUntil)) {
      return Promise.reject(syncError('FORBIDDEN'))
    }
    const conversion = this.runConversion(knowledgeBaseId, downloadAndVerify)
    this.activeConversions.set(knowledgeBaseId, conversion)
    const clear = () => {
      if (this.activeConversions.get(knowledgeBaseId) === conversion) {
        this.activeConversions.delete(knowledgeBaseId)
      }
    }
    void conversion.then(clear, clear)
    return conversion
  }

  private async runConversion(
    knowledgeBaseId: string,
    downloadAndVerify: (guard: KnowledgeSyncCommitGuard) => Promise<{
      complete: boolean
      expectedDigest: string
      actualDigest: string
    }>,
  ): Promise<void> {
    let conversion = this.database.prepare(`
      SELECT operation_id AS operationId, request_id AS requestId, state,
        expected_published_generation_id AS expectedPublishedGenerationId,
        deletion_job_id AS deletionJobId, expected_digest AS expectedDigest,
        actual_digest AS actualDigest, previous_mode AS previousMode
      FROM cloud_sync_conversions WHERE knowledge_base_id = ?
    `).get(knowledgeBaseId) as ConversionRow | undefined
    if (conversion?.state === 'completed') {
      if (this.getState(knowledgeBaseId).mode !== 'local_only') {
        this.setState(knowledgeBaseId, 'local_only', null)
      }
      return
    }
    if (!conversion) {
      const previous = this.getState(knowledgeBaseId)
      if (previous.mode === 'converting') throw syncError('CONFLICT')
      const operationId = this.dependencies.id()
      const generatedRequestId = this.dependencies.id()
      const requestId = generatedRequestId === operationId
        ? `request:${operationId}`.slice(0, 128)
        : generatedRequestId
      const now = this.dependencies.now()
      this.database.transaction(() => {
        this.database.prepare(`
          INSERT INTO cloud_sync_conversions (
            knowledge_base_id, operation_id, request_id, state,
            expected_published_generation_id, previous_mode, created_at, updated_at
          ) VALUES (?, ?, ?, 'downloading', ?, ?, ?, ?)
        `).run(
          knowledgeBaseId, operationId, requestId, previous.publishedGenerationId,
          previous.mode, now, now,
        )
        this.setMode(knowledgeBaseId, 'converting')
      })()
      conversion = {
        operationId, requestId, state: 'downloading',
        expectedPublishedGenerationId: previous.publishedGenerationId,
        deletionJobId: null, expectedDigest: null, actualDigest: null,
        previousMode: previous.mode,
      }
    } else if (this.getState(knowledgeBaseId).mode !== 'converting') {
      this.setMode(knowledgeBaseId, 'converting')
    }
    const epoch = this.getControl(knowledgeBaseId).epoch
    const assertConverting = () => {
      const control = this.getControl(knowledgeBaseId)
      if (control.epoch !== epoch || control.mode !== 'converting') throw syncError('CONFLICT')
    }
    const conversionGuard = this.createCommitGuard(knowledgeBaseId, epoch, 'converting')
    if (conversion.state === 'downloading') {
      const verification = await downloadAndVerify(conversionGuard)
      assertConverting()
      if (!verification.complete
        || !verification.expectedDigest
        || verification.expectedDigest !== verification.actualDigest) {
        const previousMode = conversion.previousMode
        const expectedPublishedGenerationId = conversion.expectedPublishedGenerationId
        this.database.transaction(() => {
          this.database.prepare(
            'DELETE FROM cloud_sync_conversions WHERE knowledge_base_id = ?',
          ).run(knowledgeBaseId)
          this.setState(
            knowledgeBaseId, previousMode, expectedPublishedGenerationId,
          )
        })()
        throw syncError('INTEGRITY_FAILED')
      }
      this.database.prepare(`
        UPDATE cloud_sync_conversions SET state = 'verified', expected_digest = ?,
          actual_digest = ?, error_code = NULL, updated_at = ? WHERE knowledge_base_id = ?
      `).run(
        verification.expectedDigest, verification.actualDigest,
        this.dependencies.now(), knowledgeBaseId,
      )
      conversion = { ...conversion, state: 'verified',
        expectedDigest: verification.expectedDigest, actualDigest: verification.actualDigest }
    }
    if (conversion.state === 'verified') {
      const accepted = await this.remote.deleteKnowledgeBase({
        requestId: conversion.requestId,
        knowledgeBaseId,
        expectedPublishedGenerationId: conversion.expectedPublishedGenerationId,
      })
      assertConverting()
      this.database.prepare(`
        UPDATE cloud_sync_conversions SET state = 'purge_accepted', deletion_job_id = ?,
          error_code = NULL, updated_at = ? WHERE knowledge_base_id = ? AND state = 'verified'
      `).run(accepted.deletionJobId, this.dependencies.now(), knowledgeBaseId)
      conversion = { ...conversion, state: 'purge_accepted', deletionJobId: accepted.deletionJobId }
    }
    if (!conversion.deletionJobId) throw syncError('INTERNAL_ERROR')
    let job: Awaited<ReturnType<CloudKnowledgeRemote['getJob']>> | undefined
    for (let poll = 0; poll < 3; poll += 1) {
      job = await this.remote.getJob({ jobId: conversion.deletionJobId })
      assertConverting()
      if (job.jobId !== conversion.deletionJobId) throw syncError('INTERNAL_ERROR')
      if (job.state === 'completed') break
      if (job.state === 'failed' || job.state === 'cancelled') {
        this.setMode(knowledgeBaseId, 'failed')
        throw syncError(job.errorCode ?? 'INTERNAL_ERROR')
      }
    }
    if (job?.state !== 'completed') throw Object.assign(new Error('TRANSIENT_FAILURE'), {
      code: 'TRANSIENT_FAILURE', retryable: true as const,
    })
    assertConverting()
    const now = this.dependencies.now()
    this.database.transaction(() => {
      this.database.prepare(`
        UPDATE cloud_sync_conversions SET state = 'completed', error_code = NULL, updated_at = ?
        WHERE knowledge_base_id = ? AND state = 'purge_accepted' AND deletion_job_id = ?
      `).run(now, knowledgeBaseId, conversion.deletionJobId)
      this.database.prepare('DELETE FROM sync_cursors WHERE knowledge_base_id = ?').run(knowledgeBaseId)
      this.setState(knowledgeBaseId, 'local_only', null)
    })()
  }

  private expireTerminalLeases(knowledgeBaseId: string): void {
    const now = this.dependencies.now()
    this.database.prepare(`
      UPDATE cloud_sync_mutations SET state = 'failed', error_code = 'LEASE_EXPIRED',
        lease_token = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE knowledge_base_id = ? AND state = 'leased' AND attempt >= ?
        AND lease_expires_at <= ?
    `).run(now, knowledgeBaseId, MAX_ATTEMPTS, now)
  }

  private isActive(knowledgeBaseId: string, epoch: number): boolean {
    const state = this.getControl(knowledgeBaseId)
    return state.epoch === epoch && state.mode === 'syncing'
  }

  private isEpochCurrent(knowledgeBaseId: string, epoch: number): boolean {
    return this.getControl(knowledgeBaseId).epoch === epoch
  }

  private createCommitGuard(
    knowledgeBaseId: string,
    epoch: number,
    mode: Extract<CloudSyncMode, 'syncing' | 'converting'>,
  ): KnowledgeSyncCommitGuard {
    const isCurrent = () => {
      const current = this.getControl(knowledgeBaseId)
      return current.epoch === epoch && current.mode === mode
    }
    return Object.freeze({
      knowledgeBaseId,
      commit: (write: () => void) => {
        if (!isCurrent()) throw syncError('CONFLICT')
        let failed = false
        let failure: unknown
        try {
          write()
        } catch (error) {
          failed = true
          failure = error
        }
        if (!isCurrent()) throw syncError('CONFLICT')
        if (failed) throw failure
      },
    })
  }

  private compareAndSetMode(knowledgeBaseId: string, epoch: number, mode: CloudSyncMode): boolean {
    const updated = this.database.prepare(`
      UPDATE cloud_sync_states SET mode = ?, epoch = epoch + 1, updated_at = ?
      WHERE knowledge_base_id = ? AND epoch = ?
    `).run(mode, this.dependencies.now(), knowledgeBaseId, epoch)
    return updated.changes === 1
  }

  private getControl(knowledgeBaseId: string): {
    mode: CloudSyncMode
    publishedGenerationId: string | null
    epoch: number
  } {
    const row = this.database.prepare(`
      SELECT mode, published_generation_id AS publishedGenerationId, epoch
      FROM cloud_sync_states WHERE knowledge_base_id = ?
    `).get(knowledgeBaseId) as {
      mode: CloudSyncMode
      publishedGenerationId: string | null
      epoch: number
    } | undefined
    return row ?? { mode: 'local_only', publishedGenerationId: null, epoch: 0 }
  }

  async cancelMutation(mutationId: string): Promise<void> {
    const row = this.database.prepare(`
      SELECT state, knowledge_base_id AS knowledgeBaseId
      FROM cloud_sync_mutations WHERE id = ?
    `).get(mutationId) as { state: string; knowledgeBaseId: string } | undefined
    if (!row || ['completed', 'cancelled', 'failed', 'conflict'].includes(row.state)) return
    this.database.transaction(() => {
      this.setMode(row.knowledgeBaseId, 'paused')
      this.database.prepare(`
        UPDATE cloud_sync_mutations
        SET state = 'cancelled', lease_token = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND state NOT IN ('completed', 'cancelled', 'failed', 'conflict')
      `).run(this.dependencies.now(), mutationId)
    })()
  }

  async cancelRemoteJob(jobId: string): Promise<void> {
    await this.remote.cancelJob({ requestId: this.dependencies.id(), jobId })
  }

  recordOrphan(knowledgeBaseId: string, storageReference: string): void {
    this.database.prepare(`
      INSERT OR IGNORE INTO cloud_sync_orphans (
        storage_reference, knowledge_base_id, request_id, created_at
      ) VALUES (?, ?, ?, ?)
    `).run(storageReference, knowledgeBaseId, this.dependencies.id(), this.dependencies.now())
  }

  async cleanupOrphans(knowledgeBaseId: string): Promise<void> {
    const entitlementEpoch = this.captureCloudAccess()
    const rows = this.database.prepare(`
      SELECT storage_reference AS storageReference, request_id AS requestId
      FROM cloud_sync_orphans WHERE knowledge_base_id = ?
      ORDER BY created_at, storage_reference LIMIT 1
    `).all(knowledgeBaseId) as Array<{ storageReference: string; requestId: string }>
    if (rows.length === 0) return
    const epoch = this.getControl(knowledgeBaseId).epoch
    const references = rows.map(row => row.storageReference)
    await this.remote.cleanupOrphans({
      requestId: rows[0]!.requestId,
      knowledgeBaseId,
      storageReferences: references,
    })
    this.assertCloudAccess(entitlementEpoch)
    if (!this.isEpochCurrent(knowledgeBaseId, epoch)) throw syncError('CONFLICT')
    const placeholders = references.map(() => '?').join(', ')
    this.database.prepare(`
      DELETE FROM cloud_sync_orphans
      WHERE knowledge_base_id = ? AND storage_reference IN (${placeholders})
    `).run(knowledgeBaseId, ...references)
  }

  async drain(): Promise<void> {
    await Promise.allSettled([
      ...this.activeSynchronizations.values(),
      ...this.activeConversions.values(),
    ])
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
          id, knowledge_base_id, entity_kind, conflict_kind, entity_id,
          local_version, remote_version, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)
        ON CONFLICT(id) DO NOTHING
      `).run(
        `cloud:${mutation.id}`, mutation.knowledgeBaseId, mutation.entityKind,
        result.conflictKind, mutation.entityId, result.localRevision, result.remoteRevision, now,
      )
      return true
    })()
  }

  private async pull(knowledgeBaseId: string, epoch: number): Promise<void> {
    const cursor = this.database.prepare(`
      SELECT sequence FROM sync_cursors WHERE knowledge_base_id = ?
    `).get(knowledgeBaseId) as { sequence: number } | undefined
    let afterSequence = cursor?.sequence ?? 0
    const commitGuard = this.createCommitGuard(knowledgeBaseId, epoch, 'syncing')
    if (afterSequence === 0) {
      const snapshot = await this.remote.fullResync({ knowledgeBaseId })
      if (!this.isActive(knowledgeBaseId, epoch)) return
      try {
        await this.dependencies.replaceRemoteSnapshot(snapshot.changes, commitGuard)
      } catch (error) {
        if (!this.isActive(knowledgeBaseId, epoch)) return
        throw error
      }
      if (!this.isActive(knowledgeBaseId, epoch)) return
      this.replaceCursor(knowledgeBaseId, snapshot.nextSequence, this.dependencies.now())
      return
    }
    while (true) {
      const result = await this.remote.pullChanges({ knowledgeBaseId, afterSequence })
      if (!this.isActive(knowledgeBaseId, epoch)) return
      if (result.kind === 'cursor_stale') {
        const snapshot = await this.remote.fullResync({ knowledgeBaseId })
        if (!this.isActive(knowledgeBaseId, epoch)) return
        try {
          await this.dependencies.replaceRemoteSnapshot(snapshot.changes, commitGuard)
        } catch (error) {
          if (!this.isActive(knowledgeBaseId, epoch)) return
          throw error
        }
        if (!this.isActive(knowledgeBaseId, epoch)) return
        this.replaceCursor(knowledgeBaseId, snapshot.nextSequence, this.dependencies.now())
        return
      }
      if (result.nextSequence < afterSequence
        || (result.hasMore && result.nextSequence <= afterSequence)
        || (result.changes.length === 0 && result.nextSequence !== afterSequence)) {
        throw syncError('INTERNAL_ERROR')
      }
      for (const change of result.changes) {
        if (change.sequence <= afterSequence || change.sequence > result.nextSequence) {
          throw syncError('INTERNAL_ERROR')
        }
        if (!this.isActive(knowledgeBaseId, epoch)) return
        try {
          await this.dependencies.applyRemoteChange(change, commitGuard)
        } catch (error) {
          if (!this.isActive(knowledgeBaseId, epoch)) return
          throw error
        }
        if (!this.isActive(knowledgeBaseId, epoch)) return
        afterSequence = change.sequence
      }
      if (result.nextSequence !== afterSequence) throw syncError('INTERNAL_ERROR')
      if (!this.isActive(knowledgeBaseId, epoch)) return
      this.upsertCursor(knowledgeBaseId, result.nextSequence, this.dependencies.now())
      if (!result.hasMore) return
    }
  }

  private upsertCursor(knowledgeBaseId: string, sequence: number, now: number): void {
    this.database.prepare(`
      INSERT INTO sync_cursors (knowledge_base_id, sequence, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(knowledge_base_id) DO UPDATE SET
        sequence = max(sync_cursors.sequence, excluded.sequence), updated_at = excluded.updated_at
    `).run(knowledgeBaseId, sequence, now)
  }

  private replaceCursor(knowledgeBaseId: string, sequence: number, now: number): void {
    this.database.prepare(`
      INSERT INTO sync_cursors (knowledge_base_id, sequence, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(knowledge_base_id) DO UPDATE SET
        sequence = excluded.sequence, updated_at = excluded.updated_at
    `).run(knowledgeBaseId, sequence, now)
  }

  private setMode(knowledgeBaseId: string, mode: CloudSyncMode): number {
    this.setState(knowledgeBaseId, mode, this.getState(knowledgeBaseId).publishedGenerationId)
    return this.getControl(knowledgeBaseId).epoch
  }

  private setState(
    knowledgeBaseId: string,
    mode: CloudSyncMode,
    publishedGenerationId: string | null,
  ): void {
    this.database.prepare(`
      INSERT INTO cloud_sync_states (
        knowledge_base_id, mode, published_generation_id, epoch, updated_at
      ) VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(knowledge_base_id) DO UPDATE SET
        mode = excluded.mode, published_generation_id = excluded.published_generation_id,
        epoch = cloud_sync_states.epoch + 1, updated_at = excluded.updated_at
    `).run(knowledgeBaseId, mode, publishedGenerationId, this.dependencies.now())
  }
}
