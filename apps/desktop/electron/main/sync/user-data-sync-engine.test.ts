import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppErrorCode, SyncMutation } from '@autoforge/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UserDataStoreManager, type UserDataStore } from '../database/user-data-client.js'
import type {
  CloudBaseUserDataCall,
  RemoteSyncMutation,
  SyncPullData,
  SyncPushData,
  UserDataFunctionResponse,
} from '../cloud/cloudbase-user-data-port.js'
import { UserDataSyncEngine } from './user-data-sync-engine.js'

const roots: string[] = []

function createManager(): UserDataStoreManager {
  const root = mkdtempSync(join(tmpdir(), 'autoforge-sync-engine-'))
  roots.push(root)
  return new UserDataStoreManager(root)
}

type CreateMutation = Extract<SyncMutation, { kind: 'conversation.create' }>

function createMutation(index: number, prefix = 'alice'): CreateMutation {
  const suffix = String(index).padStart(3, '0')
  const conversationId = `${prefix}_conversation_${suffix}`
  return {
    id: `${prefix}_mutation_${suffix}`,
    kind: 'conversation.create',
    entityId: conversationId,
    baseRevision: 0,
    payload: {
      title: `Conversation ${suffix}`,
      titleState: 'user_named',
      createdAt: '2026-08-25T00:00:00.000Z',
      lastActivityAt: '2026-08-25T00:00:00.000Z',
      metadataUpdatedAt: '2026-08-25T00:00:00.000Z',
    },
    occurredAt: '2026-08-25T00:00:00.000Z',
  }
}

function pulled(mutation: SyncMutation, resultRevision = 1): RemoteSyncMutation {
  return {
    id: mutation.id,
    kind: mutation.kind,
    entityId: mutation.entityId,
    baseRevision: mutation.baseRevision,
    resultRevision,
    payload: mutation.payload,
    receivedAt: mutation.occurredAt,
  }
}

function success(data: SyncPushData | SyncPullData): UserDataFunctionResponse {
  return { ok: true, data }
}

function failure(code: AppErrorCode): UserDataFunctionResponse {
  return { ok: false, error: { code } }
}

class FakeClock {
  nowValue = 10_000
  readonly delays: number[] = []
  readonly cleared: unknown[] = []
  #nextId = 1
  #timers = new Map<number, () => void>()

  now = () => this.nowValue
  setTimeout = (callback: () => void, delay: number): number => {
    const id = this.#nextId++
    this.delays.push(delay)
    this.#timers.set(id, callback)
    return id
  }
  clearTimeout = (id: unknown): void => {
    this.cleared.push(id)
    this.#timers.delete(id as number)
  }
  nextDelay(): number | undefined {
    return this.delays.at(-1)
  }
  async fireNext(): Promise<void> {
    const entry = this.#timers.entries().next().value as [number, () => void] | undefined
    if (!entry) throw new Error('No timer scheduled')
    const [id, callback] = entry
    this.#timers.delete(id)
    const delay = this.delays.at(-1) ?? 0
    this.nowValue += delay
    callback()
    await Promise.resolve()
  }
  timerCount(): number {
    return this.#timers.size
  }
}

function createEngine(
  manager: UserDataStoreManager,
  call: (input: CloudBaseUserDataCall) => Promise<UserDataFunctionResponse>,
  clock = new FakeClock(),
) {
  return {
    clock,
    engine: new UserDataSyncEngine({ call }, manager, {
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      jitter: (delay) => delay,
    }),
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('UserDataSyncEngine', () => {
  it('pushes local rows, pulls receipts, and advances the checkpoint atomically', async () => {
    const manager = createManager()
    const store = manager.open('alice')
    const mutation = createMutation(1)
    store.outbox.recordWithConversation(mutation)
    const calls: CloudBaseUserDataCall[] = []
    const { engine } = createEngine(manager, async (input) => {
      calls.push(input)
      if (input.action === 'syncPush') {
        return success({
          results: input.mutations.map((item) => ({ id: item.id, status: 'applied', revision: 1 })),
          cursor: 'cursor_push_0001',
        })
      }
      return success({ mutations: [pulled(mutation)], cursor: 'cursor_pull_0001' })
    })

    engine.start('alice', 'device-a')
    await engine.flush()

    expect(store.outbox.find(mutation.id)).toBeUndefined()
    expect(store.conversations.listPage({ limit: 50 }).items).toContainEqual(
      expect.objectContaining({ id: mutation.entityId, revision: 1, syncState: 'synced' }),
    )
    expect(store.sync.getCheckpoint()).toMatchObject({ protocolVersion: 1, remoteCursor: 'cursor_pull_0001' })
    expect(calls.map(({ action }) => action)).toEqual(['syncPush', 'syncPull'])
    expect(engine.status()).toEqual({ state: 'idle' })
  })

  it('pushes pending outbox rows in FIFO batches of at most 100', async () => {
    const manager = createManager()
    const store = manager.open('alice')
    for (let index = 0; index < 101; index += 1) {
      store.outbox.recordWithConversation(createMutation(index))
    }
    const batchSizes: number[] = []
    const pushed: SyncMutation[] = []
    let pullIndex = 0
    const { engine } = createEngine(manager, async (input) => {
      if (input.action === 'syncPush') {
        batchSizes.push(input.mutations.length)
        pushed.push(...input.mutations)
        return success({ results: input.mutations.map((item) => ({
          id: item.id, status: 'applied', revision: 1,
        })), cursor: `cursor_push_${batchSizes.length}` })
      }
      const page = pushed.slice(pullIndex, pullIndex + 100)
      pullIndex += page.length
      return success({ mutations: page.map((item) => pulled(item)), cursor: `cursor_pull_page_${pullIndex}` })
    })

    engine.start('alice', 'device-a')
    await engine.flush()

    expect(batchSizes).toEqual([100, 1])
    expect(store.outbox.countPending()).toBe(0)
  })

  it('treats an identical duplicate receipt as replay-safe', async () => {
    const manager = createManager()
    const store = manager.open('alice')
    const mutation = createMutation(2)
    store.outbox.recordWithConversation(mutation)
    const { engine } = createEngine(manager, async (input) => input.action === 'syncPush'
      ? success({ results: [{ id: mutation.id, status: 'duplicate', revision: 1 }], cursor: 'cursor_duplicate_push' })
      : success({ mutations: [pulled(mutation)], cursor: 'cursor_duplicate_pull' }))

    engine.start('alice', 'device-a')
    await engine.flush()

    expect(store.outbox.find(mutation.id)).toBeUndefined()
    expect(engine.status()).toEqual({ state: 'idle' })
  })

  it('quarantines a conflicting mutation with stable metadata', async () => {
    const manager = createManager()
    const store = manager.open('alice')
    const mutation = createMutation(3)
    store.outbox.recordWithConversation(mutation)
    const { engine } = createEngine(manager, async () => success({
      results: [{ id: mutation.id, status: 'conflict', errorCode: 'SYNC_CONFLICT' }],
      cursor: 'cursor_conflict',
    }))

    engine.start('alice', 'device-a')
    await engine.flush()

    expect(store.outbox.find(mutation.id)).toMatchObject({
      state: 'failed', lastErrorCode: 'SYNC_CONFLICT',
    })
    expect(engine.status()).toEqual({ state: 'quarantined', errorCode: 'SYNC_CONFLICT' })
    expect(JSON.stringify(engine.status())).not.toContain(mutation.entityId)
  })

  it('retries transient failures at deterministic exponential delays', async () => {
    const manager = createManager()
    const store = manager.open('alice')
    store.outbox.record(createMutation(4))
    const call = vi.fn().mockRejectedValue({ code: 'SERVICE_UNAVAILABLE' })
    const { engine, clock } = createEngine(manager, call)
    engine.start('alice', 'device-a')

    for (const expectedDelay of [1_000, 2_000, 4_000, 8_000]) {
      await engine.flush()
      expect(clock.nextDelay()).toBe(expectedDelay)
      expect(engine.status()).toMatchObject({ state: 'retrying', errorCode: 'SERVICE_UNAVAILABLE' })
      await clock.fireNext()
    }
    await engine.flush()

    expect(call).toHaveBeenCalledTimes(5)
    expect(clock.nextDelay()).toBe(16_000)
    expect(store.outbox.find(createMutation(4).id)).toMatchObject({ state: 'pending', attempts: 5 })
  })

  it('caps transient retry delays at five minutes', async () => {
    const manager = createManager()
    const store = manager.open('alice')
    store.outbox.record(createMutation(5))
    const { engine, clock } = createEngine(manager, vi.fn().mockRejectedValue({ code: 'SERVICE_UNAVAILABLE' }))
    engine.start('alice', 'device-a')

    for (let attempt = 0; attempt < 11; attempt += 1) {
      await engine.flush()
      if (attempt < 10) await clock.fireNext()
    }

    expect(clock.nextDelay()).toBe(300_000)
  })

  it('pauses without retrying when authentication is required', async () => {
    const manager = createManager()
    const store = manager.open('alice')
    const mutation = createMutation(6)
    store.outbox.record(mutation)
    const { engine, clock } = createEngine(manager, async () => failure('AUTH_REQUIRED'))

    engine.start('alice', 'device-a')
    await engine.flush()

    expect(engine.status()).toEqual({ state: 'paused', errorCode: 'AUTH_REQUIRED' })
    expect(clock.timerCount()).toBe(0)
    expect(store.outbox.find(mutation.id)).toMatchObject({ state: 'pending' })
  })

  it('isolates a non-retryable 4xx error to failed outbox rows', async () => {
    const manager = createManager()
    const store = manager.open('alice')
    const mutation = createMutation(7)
    store.outbox.record(mutation)
    const { engine, clock } = createEngine(manager, vi.fn().mockRejectedValue({ code: 'INVALID_INPUT' }))

    engine.start('alice', 'device-a')
    await engine.flush()

    expect(store.outbox.find(mutation.id)).toMatchObject({ state: 'failed', lastErrorCode: 'INVALID_INPUT' })
    expect(clock.timerCount()).toBe(0)
    expect(engine.status()).toEqual({ state: 'quarantined', errorCode: 'INVALID_INPUT' })
  })

  it('quarantines malformed remote output without advancing the checkpoint', async () => {
    const manager = createManager()
    const store = manager.open('alice')
    const { engine } = createEngine(manager, vi.fn().mockRejectedValue({ code: 'INTERNAL_ERROR' }))

    engine.start('alice', 'device-a')
    await engine.pull()

    expect(store.sync.getCheckpoint()).toBeUndefined()
    expect(engine.status()).toEqual({ state: 'quarantined', errorCode: 'INTERNAL_ERROR' })
  })

  it('never applies an Alice completion or sends Alice rows after switching to Bob', async () => {
    const manager = createManager()
    const alice = manager.open('alice')
    const aliceMutation = createMutation(8, 'alice')
    alice.outbox.record(aliceMutation)
    let resolveAlice!: (response: UserDataFunctionResponse) => void
    const aliceResponse = new Promise<UserDataFunctionResponse>((resolve) => { resolveAlice = resolve })
    const calls: CloudBaseUserDataCall[] = []
    const { engine } = createEngine(manager, async (input) => {
      calls.push(input)
      if (input.action === 'syncPush' && input.mutations.some(({ id }) => id === aliceMutation.id)) {
        return aliceResponse
      }
      if (input.action === 'syncPush') {
        return success({ results: input.mutations.map((item) => ({
          id: item.id, status: 'applied', revision: 1,
        })), cursor: 'cursor_bob_push' })
      }
      return success({ mutations: [], cursor: null })
    })

    engine.start('alice', 'device-a')
    const staleFlush = engine.flush()
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    engine.start('bob', 'device-a')
    const bob = manager.current() as UserDataStore
    const bobMutation = createMutation(1, 'bob')
    bob.outbox.record(bobMutation)
    resolveAlice(success({
      results: [{ id: aliceMutation.id, status: 'applied', revision: 1 }], cursor: 'cursor_alice_push',
    }))
    await staleFlush
    await engine.flush()

    const callsAfterSwitch = calls.slice(1)
    expect(callsAfterSwitch.some((input) => (
      input.action === 'syncPush' && input.mutations.some(({ id }) => id === aliceMutation.id)
    ))).toBe(false)
    expect(callsAfterSwitch.some((input) => (
      input.action === 'syncPush' && input.mutations.some(({ id }) => id === bobMutation.id)
    ))).toBe(true)
    expect(bob.outbox.find(bobMutation.id)).toMatchObject({ state: 'syncing' })
  })

  it('pause clears retry timers and drains an in-flight call', async () => {
    const manager = createManager()
    const store = manager.open('alice')
    store.outbox.record(createMutation(9))
    const clock = new FakeClock()
    const failed = createEngine(manager, vi.fn().mockRejectedValue({ code: 'SERVICE_UNAVAILABLE' }), clock)
    failed.engine.start('alice', 'device-a')
    await failed.engine.flush()
    expect(clock.timerCount()).toBe(1)
    await failed.engine.pause()
    expect(clock.timerCount()).toBe(0)
    expect(clock.cleared).toHaveLength(1)

    store.outbox.record(createMutation(90))
    let resolveCall!: (response: UserDataFunctionResponse) => void
    const pending = new Promise<UserDataFunctionResponse>((resolve) => { resolveCall = resolve })
    const active = createEngine(manager, vi.fn().mockReturnValue(pending), clock)
    active.engine.start('alice', 'device-a')
    const flush = active.engine.flush()
    let paused = false
    const pause = active.engine.pause().then(() => { paused = true })
    await Promise.resolve()
    expect(paused).toBe(false)
    resolveCall(failure('SERVICE_UNAVAILABLE'))
    await flush
    await pause
    expect(paused).toBe(true)
    expect(clock.timerCount()).toBe(0)
    expect(store.outbox.find(createMutation(90).id)).toMatchObject({ state: 'pending' })
  })

  it('rolls back an earlier remote mutation and checkpoint when a later row is inconsistent', async () => {
    const manager = createManager()
    const store = manager.open('alice')
    const first = createMutation(10, 'remote')
    const invalid = {
      ...pulled(createMutation(11, 'remote')),
      kind: 'conversation.rename' as const,
      baseRevision: 4,
      resultRevision: 5,
      payload: {
        title: 'Private title', titleState: 'user_named' as const,
        metadataUpdatedAt: '2026-08-25T00:00:00.000Z',
      },
    }
    const { engine } = createEngine(manager, async () => success({
      mutations: [pulled(first), invalid], cursor: 'cursor_must_rollback',
    }))

    engine.start('alice', 'device-a')
    await engine.pull()

    expect(store.conversations.get(first.entityId)).toBeUndefined()
    expect(store.sync.getCheckpoint()).toBeUndefined()
    expect(engine.status()).toEqual({ state: 'quarantined', errorCode: 'INTERNAL_ERROR' })
  })

  it('quarantines a mismatched duplicate receipt instead of deleting the local row', async () => {
    const manager = createManager()
    const store = manager.open('alice')
    const local = createMutation(12)
    store.outbox.recordWithConversation(local)
    const mismatched = {
      ...pulled(local),
      payload: { ...local.payload, title: 'Different title' },
    }
    const { engine } = createEngine(manager, async (input) => input.action === 'syncPush'
      ? success({ results: [{ id: local.id, status: 'duplicate', revision: 1 }], cursor: 'cursor_duplicate' })
      : success({ mutations: [mismatched], cursor: 'cursor_collision' }))

    engine.start('alice', 'device-a')
    await engine.flush()

    expect(store.outbox.find(local.id)).toBeDefined()
    expect(store.sync.getCheckpoint()).toBeUndefined()
    expect(engine.status()).toEqual({ state: 'quarantined', errorCode: 'INTERNAL_ERROR' })
  })
})
