import {
  toSafeAppError,
  type AppErrorCode,
  type SyncMutation,
  type SyncMutationResult,
} from '@autoforge/shared'
import type { UserDataStore, UserDataStoreManager } from '../database/user-data-client.js'
import type {
  CloudBaseUserDataPort,
  SyncPullData,
  SyncPushData,
  UserDataFunctionResponse,
} from '../cloud/cloudbase-user-data-port.js'
import type {
  LegacyImportBatchRequest,
  LegacyImportBatchResult,
} from './legacy-user-data-import.js'

const PROTOCOL_VERSION = 1 as const
const BATCH_LIMIT = 100
const MAX_EVENT_BYTES = 1_048_576
const MAX_RETRY_DELAY = 5 * 60 * 1_000

type TimerHandle = unknown

export type UserDataSyncStatus =
  | { state: 'idle' | 'running' }
  | { state: 'paused'; errorCode?: 'AUTH_REQUIRED' }
  | { state: 'retrying'; errorCode: 'SERVICE_UNAVAILABLE'; nextRetryAt: number }
  | { state: 'quarantined'; errorCode: AppErrorCode }

interface SyncEngineDependencies {
  now: () => number
  setTimeout: (callback: () => void, delay: number) => TimerHandle
  clearTimeout: (handle: TimerHandle) => void
  jitter: (delay: number, attempt: number) => number
  onConversationChanged: (conversationIds: readonly string[]) => void
}

interface ActiveBinding {
  generation: number
  deviceId: string
  store: UserDataStore
}

const defaultDependencies: SyncEngineDependencies = {
  now: Date.now,
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  jitter: (delay) => Math.round(delay * (0.75 + Math.random() * 0.5)),
  onConversationChanged: () => undefined,
}

function affectedConversationIds(
  mutations: readonly { kind: string; entityId: string; payload: unknown }[],
): string[] {
  const ids = new Set<string>()
  for (const mutation of mutations) {
    if (mutation.kind.startsWith('conversation.')) ids.add(mutation.entityId)
    if (mutation.kind === 'message.append'
      && typeof mutation.payload === 'object'
      && mutation.payload !== null
      && 'conversationId' in mutation.payload
      && typeof mutation.payload.conversationId === 'string') {
      ids.add(mutation.payload.conversationId)
    }
  }
  return [...ids]
}

function validIdentifier(value: string): boolean {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 128
    && value.trim() === value
    && !value.includes('\0')
}

function pushData(response: UserDataFunctionResponse): SyncPushData | undefined {
  return response.ok && 'results' in response.data ? response.data : undefined
}

function pullData(response: UserDataFunctionResponse): SyncPullData | undefined {
  return response.ok && 'mutations' in response.data ? response.data : undefined
}

function safeCode(error: unknown): AppErrorCode {
  return toSafeAppError(error).code
}

function retryDelay(attempt: number): number {
  return Math.min(MAX_RETRY_DELAY, 1_000 * (2 ** Math.min(Math.max(0, attempt - 1), 20)))
}

export class UserDataSyncEngine {
  #generation = 0
  #binding?: ActiveBinding
  #status: UserDataSyncStatus = { state: 'paused' }
  #timer?: TimerHandle
  #drainPromise?: Promise<void>
  #lifecycleTail: Promise<void> = Promise.resolve()
  #flushRequested = false
  #pullRequested = false
  #syncingIds = new Map<number, Set<string>>()
  #pullFailureAttempt = 0
  readonly #dependencies: SyncEngineDependencies

  constructor(
    private readonly port: Pick<CloudBaseUserDataPort, 'call'>,
    private readonly stores: Pick<UserDataStoreManager, 'open'>,
    dependencies: Partial<SyncEngineDependencies> = {},
  ) {
    this.#dependencies = { ...defaultDependencies, ...dependencies }
  }

  start(userId: string, deviceId: string): Promise<void> {
    if (!validIdentifier(userId) || !validIdentifier(deviceId)) {
      return Promise.reject(toSafeAppError({ code: 'INVALID_INPUT' }))
    }
    return this.#queueLifecycle(async () => {
      await this.#handoff()
      const generation = ++this.#generation
      this.#binding = { generation, deviceId, store: this.stores.open(userId) }
      this.#pullFailureAttempt = 0
      this.#status = { state: 'idle' }
    })
  }

  flush(): Promise<void> {
    const binding = this.#binding
    if (!binding || this.#status.state === 'paused' || this.#status.state === 'quarantined') {
      return Promise.resolve()
    }
    if (this.#status.state === 'retrying') {
      return this.#drainPromise ?? Promise.resolve()
    }
    this.#flushRequested = true
    return this.#ensureDrain(binding)
  }

  pull(): Promise<void> {
    const binding = this.#binding
    if (!binding || this.#status.state === 'paused' || this.#status.state === 'quarantined') {
      return Promise.resolve()
    }
    this.#pullRequested = true
    return this.#ensureDrain(binding)
  }

  async importLegacyBatch(input: LegacyImportBatchRequest): Promise<LegacyImportBatchResult> {
    let result: LegacyImportBatchResult | undefined
    await this.#queueLifecycle(async () => {
      const binding = this.#binding
      if (!binding) throw toSafeAppError({ code: 'AUTH_REQUIRED' })
      await this.#drainPromise
      if (!this.#isCurrent(binding)) throw toSafeAppError({ code: 'AUTH_REQUIRED' })
      const response = await this.port.call({
        action: 'importLegacyBatch',
        protocolVersion: PROTOCOL_VERSION,
        deviceId: binding.deviceId,
        ...input,
      })
      if (!response.ok) throw toSafeAppError({ code: response.error.code })
      if (!('batchId' in response.data) || !('status' in response.data)) {
        throw toSafeAppError({ code: 'INTERNAL_ERROR' })
      }
      result = response.data
    })
    if (!result) throw toSafeAppError({ code: 'INTERNAL_ERROR' })
    return result
  }

  retry(entityId?: string): Promise<void> {
    if (entityId !== undefined && !validIdentifier(entityId)) {
      return Promise.reject(toSafeAppError({ code: 'INVALID_INPUT' }))
    }
    return this.#queueLifecycle(async () => {
      const binding = this.#binding
      if (!binding) return
      await this.#drainPromise
      if (!this.#isCurrent(binding)) return
      this.#clearTimer()
      this.#flushRequested = false
      this.#pullRequested = false
      binding.store.outbox.retryFailed(entityId)
      if (entityId !== undefined) this.#notify(binding, [entityId])
      this.#status = { state: 'idle' }
      this.#flushRequested = true
      await this.#ensureDrain(binding)
    })
  }

  pause(): Promise<void> {
    return this.#queueLifecycle(async () => {
      await this.#handoff()
      this.#status = { state: 'paused' }
    })
  }

  status(): UserDataSyncStatus {
    return { ...this.#status }
  }

  #queueLifecycle(operation: () => Promise<void>): Promise<void> {
    const queued = this.#lifecycleTail.then(operation, operation)
    this.#lifecycleTail = queued.catch(() => undefined)
    return queued
  }

  async #handoff(): Promise<void> {
    const binding = this.#binding
    ++this.#generation
    this.#binding = undefined
    this.#flushRequested = false
    this.#pullRequested = false
    this.#clearTimer()
    await this.#drainPromise
    if (binding) {
      for (const id of this.#syncingIds.get(binding.generation) ?? []) {
        if (binding.store.outbox.find(id)?.state === 'syncing') binding.store.outbox.markPending(id)
      }
      this.#syncingIds.delete(binding.generation)
    }
  }

  #ensureDrain(binding: ActiveBinding): Promise<void> {
    if (this.#drainPromise) return this.#drainPromise
    const drain = this.#drain(binding)
      .catch(() => {
        if (this.#isCurrent(binding)) this.#quarantine('INTERNAL_ERROR')
      })
      .finally(() => {
        if (this.#drainPromise === drain) this.#drainPromise = undefined
      })
    this.#drainPromise = drain
    return drain
  }

  async #drain(binding: ActiveBinding): Promise<void> {
    while (this.#isCurrent(binding)) {
      if (this.#flushRequested) {
        this.#flushRequested = false
        await this.#flush(binding)
        if (this.#stopRequestedWork()) return
        continue
      }
      if (this.#pullRequested) {
        this.#pullRequested = false
        this.#status = { state: 'running' }
        const outcome = await this.#pull(binding)
        if (outcome === 'success' && this.#isCurrent(binding)) this.#status = { state: 'idle' }
        if (this.#stopRequestedWork()) return
        continue
      }
      return
    }
  }

  async #flush(binding: ActiveBinding): Promise<void> {
    this.#clearTimer()
    this.#status = { state: 'running' }
    let quarantineCode: AppErrorCode | undefined

    while (this.#isCurrent(binding)) {
      const ready = binding.store.outbox.listReady(this.#dependencies.now(), BATCH_LIMIT)
      if (ready.length === 0) break
      const candidates = ready.map((item): SyncMutation => ({
        id: item.id,
        kind: item.kind,
        entityId: item.entityId,
        baseRevision: item.baseRevision,
        payload: item.payload,
        occurredAt: item.occurredAt,
      } as SyncMutation))
      let batchLength = 0
      while (batchLength < candidates.length) {
        const nextLength = batchLength + 1
        if (this.#pushEventBytes(binding.deviceId, candidates.slice(0, nextLength)) > MAX_EVENT_BYTES) break
        batchLength = nextLength
      }
      if (batchLength === 0) {
        binding.store.outbox.markFailed(ready[0]!.id, 'OUTBOX_LIMIT_EXCEEDED')
        this.#notify(binding, affectedConversationIds([ready[0]!]))
        quarantineCode ??= 'OUTBOX_LIMIT_EXCEEDED'
        continue
      }
      const batch = ready.slice(0, batchLength)
      const mutations = candidates.slice(0, batchLength)
      const ids = batch.map(({ id }) => id)
      binding.store.outbox.markSyncing(ids)
      this.#trackSyncing(binding, ids)
      const conversationIds = affectedConversationIds(batch)
      this.#notify(binding, conversationIds)

      let response: UserDataFunctionResponse
      try {
        response = await this.port.call({
          action: 'syncPush',
          protocolVersion: PROTOCOL_VERSION,
          deviceId: binding.deviceId,
          mutations,
        })
      } catch (error) {
        if (!this.#isCurrent(binding)) return
        const code = safeCode(error)
        if (code === 'SERVICE_UNAVAILABLE') {
          this.#retryBatch(binding, batch, Math.max(...batch.map(({ attempts }) => attempts + 1)))
        } else if (code === 'AUTH_REQUIRED') {
          for (const id of ids) binding.store.outbox.markPending(id)
          this.#untrackSyncing(binding, ids)
          this.#notify(binding, conversationIds)
          this.#pauseForAuth()
        } else {
          for (const id of ids) binding.store.outbox.markFailed(id, code)
          this.#untrackSyncing(binding, ids)
          this.#notify(binding, conversationIds)
          this.#quarantine(code)
        }
        return
      }
      if (!this.#isCurrent(binding)) return

      if (!response.ok) {
        const code = response.error.code
        if (code === 'SERVICE_UNAVAILABLE') {
          this.#retryBatch(binding, batch, Math.max(...batch.map(({ attempts }) => attempts + 1)))
        } else if (code === 'AUTH_REQUIRED') {
          for (const id of ids) binding.store.outbox.markPending(id)
          this.#untrackSyncing(binding, ids)
          this.#notify(binding, conversationIds)
          this.#pauseForAuth()
        } else {
          for (const id of ids) binding.store.outbox.markFailed(id, code)
          this.#untrackSyncing(binding, ids)
          this.#notify(binding, conversationIds)
          this.#quarantine(code)
        }
        return
      }

      const data = pushData(response)
      if (!data || !this.#validResults(ids, data.results)) {
        for (const id of ids) binding.store.outbox.markFailed(id, 'SYNC_FAILED')
        this.#untrackSyncing(binding, ids)
        this.#notify(binding, conversationIds)
        this.#quarantine('SYNC_FAILED')
        return
      }

      try {
        binding.store.outbox.acknowledgePushResults(mutations, data.results)
        this.#pruneSyncing(binding)
        this.#notify(binding, conversationIds)
      } catch {
        for (const id of ids) {
          if (binding.store.outbox.find(id)?.state === 'syncing') {
            binding.store.outbox.markFailed(id, 'SYNC_FAILED')
          }
        }
        this.#untrackSyncing(binding, ids)
        this.#notify(binding, conversationIds)
        this.#quarantine('SYNC_FAILED')
        return
      }

      let terminalResultCode: AppErrorCode | undefined
      for (const result of data.results) {
        if (result.status === 'conflict') {
          const code = result.errorCode === 'SYNC_CONFLICT' ? result.errorCode : 'SYNC_CONFLICT'
          binding.store.outbox.markFailed(result.id, code)
          this.#untrackSyncing(binding, [result.id])
          terminalResultCode ??= code
        } else if (result.status === 'rejected') {
          const code = result.errorCode ?? 'INVALID_INPUT'
          binding.store.outbox.markFailed(result.id, code)
          this.#untrackSyncing(binding, [result.id])
          terminalResultCode ??= code
        }
      }
      if (terminalResultCode) {
        this.#notify(binding, conversationIds)
        this.#quarantine(terminalResultCode)
        return
      }
    }

    if (!this.#isCurrent(binding)) return
    this.#pullRequested = false
    const pullOutcome = await this.#pull(binding)
    if (!this.#isCurrent(binding)) return
    if (quarantineCode) {
      this.#quarantine(quarantineCode)
    } else if (pullOutcome === 'success') {
      this.#status = { state: 'idle' }
    }
  }

  #pushEventBytes(deviceId: string, mutations: readonly SyncMutation[]): number {
    return Buffer.byteLength(JSON.stringify({
      action: 'syncPush',
      protocolVersion: PROTOCOL_VERSION,
      deviceId,
      mutations,
    }), 'utf8')
  }

  #validResults(ids: readonly string[], results: readonly SyncMutationResult[]): boolean {
    if (results.length !== ids.length) return false
    const expected = new Set(ids)
    const received = new Set<string>()
    for (const result of results) {
      if (!expected.has(result.id) || received.has(result.id)) return false
      received.add(result.id)
      if ((result.status === 'applied' || result.status === 'duplicate')
        && result.revision === undefined) return false
    }
    return true
  }

  async #pull(binding: ActiveBinding): Promise<'success' | 'stopped'> {
    let previousCursor = binding.store.sync.getCheckpoint()?.remoteCursor
    while (this.#isCurrent(binding)) {
      let response: UserDataFunctionResponse
      try {
        response = await this.port.call({
          action: 'syncPull',
          protocolVersion: PROTOCOL_VERSION,
          deviceId: binding.deviceId,
          ...(previousCursor === undefined ? {} : { cursor: previousCursor }),
          limit: BATCH_LIMIT,
        })
      } catch (error) {
        if (!this.#isCurrent(binding)) return 'stopped'
        this.#handlePullFailure(binding, safeCode(error))
        return 'stopped'
      }
      if (!this.#isCurrent(binding)) return 'stopped'
      if (!response.ok) {
        this.#handlePullFailure(binding, response.error.code)
        return 'stopped'
      }
      const data = pullData(response)
      if (!data || (data.mutations.length === BATCH_LIMIT && data.cursor === previousCursor)) {
        this.#quarantine('INTERNAL_ERROR')
        return 'stopped'
      }
      try {
        binding.store.sync.applyRemotePage({
          protocolVersion: PROTOCOL_VERSION,
          mutations: data.mutations,
          cursor: data.cursor,
        }, this.#dependencies.now())
        this.#pruneSyncing(binding)
        this.#notify(binding, affectedConversationIds(data.mutations))
      } catch {
        this.#quarantine('INTERNAL_ERROR')
        return 'stopped'
      }
      this.#pullFailureAttempt = 0
      if (data.mutations.length < BATCH_LIMIT) return 'success'
      previousCursor = data.cursor ?? undefined
    }
    return 'stopped'
  }

  #handlePullFailure(binding: ActiveBinding, code: AppErrorCode): void {
    if (code === 'SERVICE_UNAVAILABLE') {
      this.#pullFailureAttempt += 1
      this.#scheduleRetry(binding, this.#pullFailureAttempt)
    } else if (code === 'AUTH_REQUIRED') {
      this.#pauseForAuth()
    } else {
      this.#quarantine(code)
    }
  }

  #retryBatch(
    binding: ActiveBinding,
    batch: readonly { id: string; kind: string; entityId: string; payload: unknown }[],
    attempt: number,
  ): void {
    const delay = this.#jitteredDelay(attempt)
    const nextRetryAt = this.#dependencies.now() + delay
    for (const { id } of batch) binding.store.outbox.markPending(id, nextRetryAt)
    this.#untrackSyncing(binding, batch.map(({ id }) => id))
    this.#notify(binding, affectedConversationIds(batch))
    this.#scheduleRetry(binding, attempt, delay)
  }

  #scheduleRetry(binding: ActiveBinding, attempt: number, knownDelay?: number): void {
    this.#clearTimer()
    const delay = knownDelay ?? this.#jitteredDelay(attempt)
    const nextRetryAt = this.#dependencies.now() + delay
    this.#status = { state: 'retrying', errorCode: 'SERVICE_UNAVAILABLE', nextRetryAt }
    this.#timer = this.#dependencies.setTimeout(() => {
      this.#timer = undefined
      if (this.#isCurrent(binding)) {
        this.#status = { state: 'idle' }
        void this.flush().catch(() => {
          if (this.#isCurrent(binding)) this.#quarantine('INTERNAL_ERROR')
        })
      }
    }, delay)
  }

  #jitteredDelay(attempt: number): number {
    const jittered = this.#dependencies.jitter(retryDelay(attempt), attempt)
    if (!Number.isFinite(jittered)) return retryDelay(attempt)
    return Math.min(MAX_RETRY_DELAY, Math.max(0, Math.round(jittered)))
  }

  #isCurrent(binding: ActiveBinding): boolean {
    return this.#binding === binding && this.#generation === binding.generation
  }

  #quarantine(errorCode: AppErrorCode): void {
    this.#clearTimer()
    this.#status = { state: 'quarantined', errorCode }
  }

  #pauseForAuth(): void {
    this.#clearTimer()
    this.#status = { state: 'paused', errorCode: 'AUTH_REQUIRED' }
  }

  #stopRequestedWork(): boolean {
    if (this.#status.state !== 'paused' && this.#status.state !== 'quarantined') return false
    this.#flushRequested = false
    this.#pullRequested = false
    return true
  }

  #trackSyncing(binding: ActiveBinding, ids: readonly string[]): void {
    const tracked = this.#syncingIds.get(binding.generation) ?? new Set<string>()
    for (const id of ids) tracked.add(id)
    this.#syncingIds.set(binding.generation, tracked)
  }

  #untrackSyncing(binding: ActiveBinding, ids: readonly string[]): void {
    const tracked = this.#syncingIds.get(binding.generation)
    if (!tracked) return
    for (const id of ids) tracked.delete(id)
    if (tracked.size === 0) this.#syncingIds.delete(binding.generation)
  }

  #pruneSyncing(binding: ActiveBinding): void {
    const tracked = this.#syncingIds.get(binding.generation)
    if (!tracked) return
    for (const id of tracked) {
      if (binding.store.outbox.find(id)?.state !== 'syncing') tracked.delete(id)
    }
    if (tracked.size === 0) this.#syncingIds.delete(binding.generation)
  }

  #notify(binding: ActiveBinding, conversationIds: readonly string[]): void {
    if (!this.#isCurrent(binding) || conversationIds.length === 0) return
    try {
      this.#dependencies.onConversationChanged([...new Set(conversationIds)])
    } catch { /* Projection notifications are observational. */ }
  }

  #clearTimer(): void {
    if (this.#timer === undefined) return
    this.#dependencies.clearTimeout(this.#timer)
    this.#timer = undefined
  }
}
