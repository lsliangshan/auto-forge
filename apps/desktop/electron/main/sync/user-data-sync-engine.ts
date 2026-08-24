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

const PROTOCOL_VERSION = 1 as const
const BATCH_LIMIT = 100
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
  #operations = new Map<number, Promise<void>>()
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

  start(userId: string, deviceId: string): void {
    if (!validIdentifier(userId) || !validIdentifier(deviceId)) {
      throw toSafeAppError({ code: 'INVALID_INPUT' })
    }
    this.#clearTimer()
    const generation = ++this.#generation
    this.#binding = { generation, deviceId, store: this.stores.open(userId) }
    this.#pullFailureAttempt = 0
    this.#status = { state: 'idle' }
  }

  flush(): Promise<void> {
    const binding = this.#binding
    if (!binding || this.#status.state === 'paused' || this.#status.state === 'quarantined') {
      return Promise.resolve()
    }
    if (this.#status.state === 'retrying') {
      return this.#operations.get(binding.generation) ?? Promise.resolve()
    }
    return this.#runExclusive(binding, () => this.#flush(binding))
  }

  pull(): Promise<void> {
    const binding = this.#binding
    if (!binding || this.#status.state === 'paused' || this.#status.state === 'quarantined') {
      return Promise.resolve()
    }
    return this.#runExclusive(binding, async () => {
      this.#status = { state: 'running' }
      const outcome = await this.#pull(binding)
      if (outcome === 'success' && this.#isCurrent(binding)) this.#status = { state: 'idle' }
    })
  }

  async pause(): Promise<void> {
    const binding = this.#binding
    const pausedGeneration = ++this.#generation
    this.#binding = undefined
    this.#clearTimer()
    this.#status = { state: 'paused' }
    await Promise.allSettled([...this.#operations.values()])
    if (binding && this.#generation === pausedGeneration) {
      for (const id of this.#syncingIds.get(binding.generation) ?? []) {
        if (binding.store.outbox.find(id)?.state === 'syncing') {
          binding.store.outbox.markPending(id)
        }
      }
      this.#syncingIds.delete(binding.generation)
    }
  }

  status(): UserDataSyncStatus {
    return { ...this.#status }
  }

  #runExclusive(binding: ActiveBinding, operation: () => Promise<void>): Promise<void> {
    const existing = this.#operations.get(binding.generation)
    if (existing) return existing
    const running = operation().finally(() => {
      if (this.#operations.get(binding.generation) === running) {
        this.#operations.delete(binding.generation)
      }
    })
    this.#operations.set(binding.generation, running)
    return running
  }

  async #flush(binding: ActiveBinding): Promise<void> {
    this.#clearTimer()
    this.#status = { state: 'running' }
    let quarantineCode: AppErrorCode | undefined

    while (this.#isCurrent(binding)) {
      const batch = binding.store.outbox.listReady(this.#dependencies.now(), BATCH_LIMIT)
      if (batch.length === 0) break
      const ids = batch.map(({ id }) => id)
      const mutations = batch.map((item): SyncMutation => ({
        id: item.id,
        kind: item.kind,
        entityId: item.entityId,
        baseRevision: item.baseRevision,
        payload: item.payload,
        occurredAt: item.occurredAt,
      } as SyncMutation))
      binding.store.outbox.markSyncing(ids)
      this.#trackSyncing(binding, ids)

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
          this.#status = { state: 'paused', errorCode: 'AUTH_REQUIRED' }
        } else {
          for (const id of ids) binding.store.outbox.markFailed(id, code)
          this.#untrackSyncing(binding, ids)
          this.#status = { state: 'quarantined', errorCode: code }
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
          this.#status = { state: 'paused', errorCode: 'AUTH_REQUIRED' }
        } else {
          for (const id of ids) binding.store.outbox.markFailed(id, code)
          this.#untrackSyncing(binding, ids)
          this.#status = { state: 'quarantined', errorCode: code }
        }
        return
      }

      const data = pushData(response)
      if (!data || !this.#validResults(ids, data.results)) {
        for (const id of ids) binding.store.outbox.markFailed(id, 'SYNC_FAILED')
        this.#untrackSyncing(binding, ids)
        this.#status = { state: 'quarantined', errorCode: 'SYNC_FAILED' }
        return
      }

      for (const result of data.results) {
        if (result.status === 'conflict') {
          const code = result.errorCode === 'SYNC_CONFLICT' ? result.errorCode : 'SYNC_CONFLICT'
          binding.store.outbox.markFailed(result.id, code)
          this.#untrackSyncing(binding, [result.id])
          quarantineCode ??= code
        } else if (result.status === 'rejected') {
          const code = result.errorCode ?? 'INVALID_INPUT'
          binding.store.outbox.markFailed(result.id, code)
          this.#untrackSyncing(binding, [result.id])
          quarantineCode ??= code
        }
      }
      if (quarantineCode) break
    }

    if (!this.#isCurrent(binding)) return
    const pullOutcome = await this.#pull(binding)
    if (!this.#isCurrent(binding)) return
    if (quarantineCode) {
      this.#status = { state: 'quarantined', errorCode: quarantineCode }
    } else if (pullOutcome === 'success') {
      this.#status = { state: 'idle' }
    }
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
        this.#status = { state: 'quarantined', errorCode: 'INTERNAL_ERROR' }
        return 'stopped'
      }
      try {
        binding.store.sync.applyRemotePage({
          protocolVersion: PROTOCOL_VERSION,
          mutations: data.mutations,
          cursor: data.cursor,
        }, this.#dependencies.now())
        this.#pruneSyncing(binding)
      } catch {
        this.#status = { state: 'quarantined', errorCode: 'INTERNAL_ERROR' }
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
      this.#status = { state: 'paused', errorCode: 'AUTH_REQUIRED' }
    } else {
      this.#status = { state: 'quarantined', errorCode: code }
    }
  }

  #retryBatch(
    binding: ActiveBinding,
    batch: readonly { id: string }[],
    attempt: number,
  ): void {
    const delay = this.#jitteredDelay(attempt)
    const nextRetryAt = this.#dependencies.now() + delay
    for (const { id } of batch) binding.store.outbox.markPending(id, nextRetryAt)
    this.#untrackSyncing(binding, batch.map(({ id }) => id))
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
        void this.flush()
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

  #clearTimer(): void {
    if (this.#timer === undefined) return
    this.#dependencies.clearTimeout(this.#timer)
    this.#timer = undefined
  }
}
