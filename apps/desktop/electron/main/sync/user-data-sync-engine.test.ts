import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SyncMutation } from '@autoforge/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UserDataStoreManager, type UserDataStore } from '../database/user-data-client.js'
import type {
  CloudBaseUserDataCall,
  RemoteSyncMutation,
  SyncPullData,
  SyncPushData,
  UserDataErrorCode,
  UserDataFunctionResponse,
} from '../cloud/cloudbase-user-data-port.js'
import { UserDataSyncEngine } from './user-data-sync-engine.js'

const roots: string[] = []
const MAX_EVENT_BYTES = 1_048_576

function createManager(): UserDataStoreManager {
  const root = mkdtempSync(join(tmpdir(), 'autoforge-sync-engine-'))
  roots.push(root)
  return new UserDataStoreManager(root)
}

type CreateMutation = Extract<SyncMutation, { kind: 'conversation.create' }>
type PulledCreateMutation = Extract<RemoteSyncMutation, { kind: 'conversation.create' }>
type RenameMutation = Extract<SyncMutation, { kind: 'conversation.rename' }>
type MessageMutation = Extract<SyncMutation, { kind: 'message.append' }>

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

function mutationAtEventSize(mutation: CreateMutation, targetBytes: number): CreateMutation {
  const emptyTitle = { ...mutation, payload: { ...mutation.payload, title: '' } }
  const fixedBytes = Buffer.byteLength(JSON.stringify({
    action: 'syncPush', protocolVersion: 1, deviceId: 'device-a', mutations: [emptyTitle],
  }), 'utf8')
  return {
    ...mutation,
    payload: { ...mutation.payload, title: 'x'.repeat(targetBytes - fixedBytes) },
  }
}

function pulled(mutation: CreateMutation, resultRevision = 1): PulledCreateMutation {
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

function remoteReceipt(mutation: SyncMutation, resultRevision: number): RemoteSyncMutation {
  const { occurredAt, ...receipt } = mutation
  return { ...receipt, resultRevision, receivedAt: occurredAt } as RemoteSyncMutation
}

function renameMutation(id: string, entityId: string, baseRevision: number, title: string): RenameMutation {
  return {
    id,
    kind: 'conversation.rename',
    entityId,
    baseRevision,
    payload: {
      title,
      titleState: 'user_named',
      metadataUpdatedAt: '2026-08-25T00:02:00.000Z',
    },
    occurredAt: '2026-08-25T00:02:00.000Z',
  }
}

function messageMutation(id: string, conversationId: string, baseRevision: number): MessageMutation {
  return {
    id,
    kind: 'message.append',
    entityId: `${id}_message`,
    baseRevision,
    payload: {
      id: `${id}_message`,
      conversationId,
      role: 'user',
      blocks: [{ type: 'text', text: 'Message' }],
      createdAt: '2026-08-25T00:03:00.000Z',
    },
    occurredAt: '2026-08-25T00:03:00.000Z',
  }
}

function success(data: SyncPushData | SyncPullData): UserDataFunctionResponse {
  return { ok: true, data }
}

function failure(code: UserDataErrorCode): UserDataFunctionResponse {
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
  onConversationChanged: (conversationIds: readonly string[]) => void = () => undefined,
) {
  return {
    clock,
    engine: new UserDataSyncEngine({ call }, manager, {
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      jitter: (delay) => delay,
      onConversationChanged,
    }),
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('UserDataSyncEngine', () => {
  it('reports a 24-hour warning from durable outbox age and clears after recovery', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const manager = createManager()
    try {
      const store = manager.open('alice')
      const mutation = createMutation(1)
      store.outbox.recordWithConversation(mutation)
      const { engine, clock } = createEngine(manager, async () => (
        failure('SERVICE_UNAVAILABLE')
      ))
      await engine.start('alice', 'device-a')
      clock.nowValue = 1_000 + (24 * 60 * 60 * 1_000)

      expect(engine.status()).toMatchObject({ state: 'idle', warningSince: 1_000 })
      store.outbox.delete(mutation.id)
      expect(engine.status()).toEqual({ state: 'idle' })
    } finally {
      manager.close()
      now.mockRestore()
    }
  })

  it('serializes dedicated legacy imports on the active UID and supplies only its device binding', async () => {
    const manager = createManager()
    let releaseFirst!: () => void
    const first = new Promise<void>((resolve) => { releaseFirst = resolve })
    const calls: CloudBaseUserDataCall[] = []
    const { engine } = createEngine(manager, async (input) => {
      calls.push(input)
      if (input.action === 'importLegacyBatch') {
        if (input.batchId === 'batch_1-0') await first
        return { ok: true, data: {
          batchId: input.batchId, status: 'applied',
          importedConversations: input.conversations.length,
          importedMessages: input.messages.length,
        } }
      }
      return success({ mutations: [], cursor: null })
    })
    await engine.start('alice', 'device-a')
    const binding = engine.captureBinding('alice')
    const request = {
      includeUnowned: false,
      cloudSyncConsent: {
        purpose: 'cloud_sync' as const, documentVersion: 'cloud-sync-2026-08',
        consentedAt: '2026-08-25T00:00:00.000Z', clientVersion: '0.1.0',
      },
      conversations: [], messages: [],
    }

    const importingFirst = engine.importLegacyBatch(binding, { ...request, batchId: 'batch_1-0' })
    const importingSecond = engine.importLegacyBatch(binding, { ...request, batchId: 'batch_1-1' })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toMatchObject({
      action: 'importLegacyBatch', protocolVersion: 1, deviceId: 'device-a', batchId: 'batch_1-0',
    })
    expect(JSON.stringify(calls[0])).not.toContain('alice')
    releaseFirst()

    await expect(Promise.all([importingFirst, importingSecond])).resolves.toEqual([
      expect.objectContaining({ batchId: 'batch_1-0', status: 'applied' }),
      expect.objectContaining({ batchId: 'batch_1-1', status: 'applied' }),
    ])
    expect(calls.map((call) => call.action)).toEqual(['importLegacyBatch', 'importLegacyBatch'])
  })

  it('rejects a captured UID generation after an identity handoff instead of importing as the new UID', async () => {
    const manager = createManager()
    const calls: CloudBaseUserDataCall[] = []
    const { engine } = createEngine(manager, async (input) => {
      calls.push(input)
      return { ok: true, data: { batchId: 'batch_1-0', status: 'applied' } }
    })
    await engine.start('alice', 'device-a')
    const alice = engine.captureBinding('alice')
    await engine.start('bob', 'device-b')

    await expect(engine.importLegacyBatch(alice, {
      batchId: 'batch_1-0', includeUnowned: false,
      cloudSyncConsent: {
        purpose: 'cloud_sync', documentVersion: 'cloud-sync-2026-08',
        consentedAt: '2026-08-25T00:00:00.000Z', clientVersion: '0.1.0',
      },
      conversations: [], messages: [],
    })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    expect(calls).toEqual([])
  })

  it('notifies exact conversation projections through failure, retry, and success', async () => {
    const manager = createManager()
    const store = manager.open('alice')
    const mutation = createMutation(42)
    store.outbox.recordWithConversation(mutation)
    let rejectPush = true
    const projections: Array<{ ids: readonly string[]; state: string }> = []
    const { engine } = createEngine(manager, async (input) => {
      if (input.action === 'syncPush') {
        if (rejectPush) {
          return success({
            results: input.mutations.map(({ id }) => ({
              id, status: 'conflict' as const, errorCode: 'SYNC_CONFLICT' as const,
            })),
            cursor: 'cursor_conflict_projection',
          })
        }
        return success({
          results: input.mutations.map(({ id }) => ({
            id, status: 'applied' as const, revision: 1,
          })),
          cursor: 'cursor_applied_projection',
        })
      }
      return success({ mutations: [pulled(mutation)], cursor: 'cursor_pull_projection' })
    }, new FakeClock(), (ids) => {
      projections.push({
        ids: [...ids],
        state: store.conversations.getSummary(mutation.entityId)?.syncState ?? 'missing',
      })
    })

    await engine.start('alice', 'device-a')
    await engine.flush()
    expect(projections).toEqual(expect.arrayContaining([
      { ids: [mutation.entityId], state: 'syncing' },
      { ids: [mutation.entityId], state: 'failed' },
    ]))

    rejectPush = false
    await engine.retry(mutation.entityId)
    expect(projections).toEqual(expect.arrayContaining([
      { ids: [mutation.entityId], state: 'pending' },
      { ids: [mutation.entityId], state: 'synced' },
    ]))
  })

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

    await engine.start('alice', 'device-a')
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
    const pushed: CreateMutation[] = []
    let pullIndex = 0
    const { engine } = createEngine(manager, async (input) => {
      if (input.action === 'syncPush') {
        batchSizes.push(input.mutations.length)
        pushed.push(...input.mutations as CreateMutation[])
        return success({ results: input.mutations.map((item) => ({
          id: item.id, status: 'applied', revision: 1,
        })), cursor: `cursor_push_${batchSizes.length}` })
      }
      const page = pushed.slice(pullIndex, pullIndex + 100)
      pullIndex += page.length
      return success({ mutations: page.map((item) => pulled(item)), cursor: `cursor_pull_page_${pullIndex}` })
    })

    await engine.start('alice', 'device-a')
    await engine.flush()

    expect(batchSizes).toEqual([100, 1])
    expect(store.outbox.countPending()).toBe(0)
  })

  it('retains two applied renames until their ordered pull receipts arrive', async () => {
    const manager = createManager()
    const store = manager.open('alice')
    const create = createMutation(40)
    store.sync.applyRemotePage({
      protocolVersion: 1, cursor: 'cursor_rename_setup', mutations: [pulled(create)],
    }, 1)
    const first = renameMutation('rename_batch_first', create.entityId, 1, 'First title')
    const second = renameMutation('rename_batch_second', create.entityId, 2, 'Second title')
    store.outbox.recordWithConversation(first)
    store.outbox.recordWithConversation(second)
    const { engine } = createEngine(manager, async (input) => input.action === 'syncPush'
      ? success({
          results: [
            { id: first.id, status: 'applied', revision: 2 },
            { id: second.id, status: 'applied', revision: 3 },
          ],
          cursor: 'cursor_rename_push',
        })
      : success({
          mutations: [remoteReceipt(first, 2), remoteReceipt(second, 3)],
          cursor: 'cursor_rename_pull',
        }))

    await engine.start('alice', 'device-a')
    await engine.flush()

    expect(store.outbox.countPending()).toBe(0)
    expect(store.conversations.listPage({ limit: 50 }).items).toContainEqual(
      expect.objectContaining({
        id: create.entityId, title: 'Second title', revision: 3, syncState: 'synced',
      }),
    )
  })

  it('retains an applied create before its same-batch message receipt', async () => {
    const manager = createManager()
    const store = manager.open('alice')
    const create = createMutation(41)
    const message = messageMutation('create_message_batch', create.entityId, 1)
    store.outbox.recordWithConversation(create)
    store.outbox.recordWithMessage(message)
    const { engine } = createEngine(manager, async (input) => input.action === 'syncPush'
      ? success({
          results: [
            { id: create.id, status: 'applied', revision: 1 },
            { id: message.id, status: 'applied', revision: 2 },
          ],
          cursor: 'cursor_create_message_push',
        })
      : success({
          mutations: [remoteReceipt(create, 1), remoteReceipt(message, 2)],
          cursor: 'cursor_create_message_pull',
        }))

    await engine.start('alice', 'device-a')
    await engine.flush()

    expect(store.outbox.countPending()).toBe(0)
    expect(store.messages.get(message.payload.id)).toBeDefined()
    expect(store.conversations.listPage({ limit: 50 }).items).toContainEqual(
      expect.objectContaining({ id: create.entityId, revision: 2, syncState: 'synced' }),
    )
  })

  it('replays a dependent offline create rename and message chain without conflict', async () => {
    const manager = createManager()
    const store = manager.open('alice')
    const create = createMutation(43)
    const rename = renameMutation('dependent_rename', create.entityId, 1, 'Offline title')
    const first = messageMutation('dependent_message_first', create.entityId, 2)
    const second = messageMutation('dependent_message_second', create.entityId, 3)
    store.outbox.recordWithConversation(create)
    store.outbox.recordWithConversation(rename)
    store.outbox.recordWithMessage(first)
    store.outbox.recordWithMessage(second)
    let revision = 0
    let pushed: SyncMutation[] = []
    const { engine } = createEngine(manager, async (input) => {
      if (input.action === 'syncPush') {
        pushed = [...input.mutations]
        const results = input.mutations.map((mutation) => {
          if (mutation.baseRevision !== revision) {
            return { id: mutation.id, status: 'conflict' as const, errorCode: 'SYNC_CONFLICT' as const }
          }
          revision += 1
          return { id: mutation.id, status: 'applied' as const, revision }
        })
        return success({ results, cursor: 'cursor_dependent_push' })
      }
      return success({
        mutations: pushed.map((mutation, index) => remoteReceipt(mutation, index + 1)),
        cursor: 'cursor_dependent_pull',
      })
    })

    await engine.start('alice', 'device-a')
    await engine.flush()

    expect(engine.status()).toEqual({ state: 'idle' })
    expect(store.outbox.countPending()).toBe(0)
    expect(store.messages.listForConversation(create.entityId)).toHaveLength(2)
    expect(store.conversations.getSummary(create.entityId)).toMatchObject({
      title: 'Offline title', revision: 4, syncState: 'synced',
    })
  })

  it('builds the largest FIFO push prefix within the exact one-mebibyte event limit', async () => {
    const manager = createManager()
    const store = manager.open('alice')
    const first = mutationAtEventSize(createMutation(20), 600_000)
    const second = mutationAtEventSize(createMutation(21), 600_000)
    store.outbox.recordWithConversation(first)
    store.outbox.recordWithConversation(second)
    const eventBytes: number[] = []
    const batchIds: string[][] = []
    const pushed: SyncMutation[] = []
    const { engine } = createEngine(manager, async (input) => {
      if (input.action === 'syncPull') {
        return success({
          mutations: pushed.map((mutation) => remoteReceipt(mutation, 1)),
          cursor: 'cursor_byte_pull',
        })
      }
      if (input.action !== 'syncPush') throw new Error('Unexpected sync action')
      eventBytes.push(Buffer.byteLength(JSON.stringify(input), 'utf8'))
      batchIds.push(input.mutations.map(({ id }) => id))
      pushed.push(...input.mutations)
      return success({
        results: input.mutations.map(({ id }) => ({ id, status: 'applied', revision: 1 })),
        cursor: `cursor_byte_batch_${batchIds.length}`,
      })
    })

    await engine.start('alice', 'device-a')
    await engine.flush()

    expect(batchIds).toEqual([[first.id], [second.id]])
    expect(eventBytes.every((bytes) => bytes <= MAX_EVENT_BYTES)).toBe(true)
    expect(store.outbox.countPending()).toBe(0)
  })

  it('never sends an oversized head row and continues FIFO after quarantining it', async () => {
    const manager = createManager()
    const store = manager.open('alice')
    const oversized = mutationAtEventSize(createMutation(22), MAX_EVENT_BYTES + 1)
    const later = createMutation(23)
    store.outbox.recordWithConversation(oversized)
    store.outbox.recordWithConversation(later)
    const pushedIds: string[] = []
    const { engine } = createEngine(manager, async (input) => {
      if (input.action === 'syncPull') {
        return success({ mutations: [pulled(later)], cursor: 'cursor_after_oversize_pull' })
      }
      if (input.action !== 'syncPush') throw new Error('Unexpected sync action')
      expect(Buffer.byteLength(JSON.stringify(input), 'utf8')).toBeLessThanOrEqual(MAX_EVENT_BYTES)
      pushedIds.push(...input.mutations.map(({ id }) => id))
      return success({
        results: input.mutations.map(({ id }) => ({ id, status: 'applied', revision: 1 })),
        cursor: 'cursor_after_oversize',
      })
    })

    await engine.start('alice', 'device-a')
    await engine.flush()

    expect(pushedIds).toEqual([later.id])
    expect(store.outbox.find(oversized.id)).toMatchObject({
      state: 'failed', lastErrorCode: 'OUTBOX_LIMIT_EXCEEDED',
    })
    expect(store.outbox.find(later.id)).toBeUndefined()
    expect(store.outbox.listReady(Number.MAX_SAFE_INTEGER, 100)).toEqual([])
  })

  it('treats an identical duplicate receipt as replay-safe', async () => {
    const manager = createManager()
    const store = manager.open('alice')
    const mutation = createMutation(2)
    store.outbox.recordWithConversation(mutation)
    const { engine } = createEngine(manager, async (input) => input.action === 'syncPush'
      ? success({ results: [{ id: mutation.id, status: 'duplicate', revision: 1 }], cursor: 'cursor_duplicate_push' })
      : success({ mutations: [], cursor: null }))

    await engine.start('alice', 'device-a')
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

    await engine.start('alice', 'device-a')
    await engine.flush()

    expect(store.outbox.find(mutation.id)).toMatchObject({
      state: 'failed', lastErrorCode: 'SYNC_CONFLICT',
    })
    expect(store.outbox.listReady(Number.MAX_SAFE_INTEGER, 100)).toEqual([])
    expect(engine.status()).toEqual({ state: 'quarantined', errorCode: 'SYNC_CONFLICT' })
    expect(JSON.stringify(engine.status())).not.toContain(mutation.entityId)
  })

  it('retries transient failures at deterministic exponential delays', async () => {
    const manager = createManager()
    const store = manager.open('alice')
    store.outbox.record(createMutation(4))
    const call = vi.fn().mockRejectedValue({ code: 'SERVICE_UNAVAILABLE' })
    const { engine, clock } = createEngine(manager, call)
    await engine.start('alice', 'device-a')

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
    await engine.start('alice', 'device-a')

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

    await engine.start('alice', 'device-a')
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

    await engine.start('alice', 'device-a')
    await engine.flush()

    expect(store.outbox.find(mutation.id)).toMatchObject({ state: 'failed', lastErrorCode: 'INVALID_INPUT' })
    expect(store.outbox.listReady(Number.MAX_SAFE_INTEGER, 100)).toEqual([])
    expect(clock.timerCount()).toBe(0)
    expect(engine.status()).toEqual({ state: 'quarantined', errorCode: 'INVALID_INPUT' })
  })

  it('durably quarantines upgrade-required and rejected push rows', async () => {
    const manager = createManager()
    const store = manager.open('alice')
    const upgrade = createMutation(30)
    store.outbox.record(upgrade)
    const upgradeEngine = createEngine(manager, async () => failure('UPGRADE_REQUIRED')).engine
    await upgradeEngine.start('alice', 'device-a')
    await upgradeEngine.flush()

    expect(store.outbox.find(upgrade.id)).toMatchObject({
      state: 'failed', lastErrorCode: 'UPGRADE_REQUIRED',
    })
    expect(store.outbox.listReady(Number.MAX_SAFE_INTEGER, 100)).toEqual([])

    const rejected = createMutation(31)
    store.outbox.record(rejected)
    const rejectedEngine = createEngine(manager, async (input) => input.action === 'syncPush'
      ? success({
          results: [{ id: rejected.id, status: 'rejected', errorCode: 'INVALID_INPUT' }],
          cursor: 'cursor_rejected',
        })
      : success({ mutations: [], cursor: null })).engine
    await rejectedEngine.start('alice', 'device-b')
    await rejectedEngine.flush()

    expect(store.outbox.find(rejected.id)).toMatchObject({
      state: 'failed', lastErrorCode: 'INVALID_INPUT',
    })
    expect(store.outbox.listReady(Number.MAX_SAFE_INTEGER, 100)).toEqual([])
  })

  it('retries a failed conversation through pending to synced', async () => {
    const manager = createManager()
    const store = manager.open('alice')
    const mutation = createMutation(42)
    store.outbox.recordWithConversation(mutation)
    let resolveRetryPush!: (response: UserDataFunctionResponse) => void
    const retryPush = new Promise<UserDataFunctionResponse>((resolve) => { resolveRetryPush = resolve })
    let pushCount = 0
    const call = vi.fn(async (input: CloudBaseUserDataCall) => {
      if (input.action === 'syncPull') {
        return success({ mutations: [pulled(mutation)], cursor: 'cursor_retry_pull' })
      }
      pushCount += 1
      if (pushCount === 1) {
        return success({
          results: [{ id: mutation.id, status: 'conflict', errorCode: 'SYNC_CONFLICT' }],
          cursor: 'cursor_retry_conflict',
        })
      }
      return retryPush
    })
    const { engine } = createEngine(manager, call)
    await engine.start('alice', 'device-a')
    await engine.flush()

    expect(engine.status()).toEqual({ state: 'quarantined', errorCode: 'SYNC_CONFLICT' })
    expect(store.conversations.listPage({ limit: 50 }).items).toContainEqual(
      expect.objectContaining({ id: mutation.entityId, syncState: 'failed' }),
    )

    const retrying = engine.retry(mutation.entityId)
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2))
    expect(store.conversations.listPage({ limit: 50 }).items).toContainEqual(
      expect.objectContaining({ id: mutation.entityId, syncState: 'syncing' }),
    )
    resolveRetryPush(success({
      results: [{ id: mutation.id, status: 'applied', revision: 1 }],
      cursor: 'cursor_retry_push',
    }))
    await retrying

    expect(store.outbox.find(mutation.id)).toBeUndefined()
    expect(store.conversations.listPage({ limit: 50 }).items).toContainEqual(
      expect.objectContaining({ id: mutation.entityId, revision: 1, syncState: 'synced' }),
    )
    expect(engine.status()).toEqual({ state: 'idle' })
  })

  it('quarantines malformed remote output without advancing the checkpoint', async () => {
    const manager = createManager()
    const store = manager.open('alice')
    const { engine } = createEngine(manager, vi.fn().mockRejectedValue({ code: 'INTERNAL_ERROR' }))

    await engine.start('alice', 'device-a')
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
    const bobPushed: SyncMutation[] = []
    const { engine } = createEngine(manager, async (input) => {
      calls.push(input)
      if (input.action === 'syncPush' && input.mutations.some(({ id }) => id === aliceMutation.id)) {
        return aliceResponse
      }
      if (input.action === 'syncPush') {
        bobPushed.push(...input.mutations)
        return success({ results: input.mutations.map((item) => ({
          id: item.id, status: 'applied', revision: 1,
        })), cursor: 'cursor_bob_push' })
      }
      return success({
        mutations: bobPushed.map((mutation) => remoteReceipt(mutation, 1)), cursor: null,
      })
    })

    await engine.start('alice', 'device-a')
    const staleFlush = engine.flush()
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    const switchToBob = engine.start('bob', 'device-a')
    resolveAlice(success({
      results: [{ id: aliceMutation.id, status: 'applied', revision: 1 }], cursor: 'cursor_alice_push',
    }))
    await staleFlush
    await switchToBob
    const bob = manager.current() as UserDataStore
    const bobMutation = createMutation(1, 'bob')
    bob.outbox.recordWithConversation(bobMutation)
    await engine.flush()

    const callsAfterSwitch = calls.slice(1)
    expect(callsAfterSwitch.some((input) => (
      input.action === 'syncPush' && input.mutations.some(({ id }) => id === aliceMutation.id)
    ))).toBe(false)
    expect(callsAfterSwitch.some((input) => (
      input.action === 'syncPush' && input.mutations.some(({ id }) => id === bobMutation.id)
    ))).toBe(true)
    expect(bob.outbox.find(bobMutation.id)).toBeUndefined()
  })

  it('queues a flush requested during pull and runs it after the pull completes', async () => {
    const manager = createManager()
    const store = manager.open('alice')
    let resolvePull!: (response: UserDataFunctionResponse) => void
    const deferredPull = new Promise<UserDataFunctionResponse>((resolve) => { resolvePull = resolve })
    const actions: string[] = []
    const { engine } = createEngine(manager, async (input) => {
      actions.push(input.action)
      if (actions.length === 1) return deferredPull
      if (input.action === 'syncPush') {
        return success({
          results: input.mutations.map(({ id }) => ({ id, status: 'applied', revision: 1 })),
          cursor: 'cursor_queued_flush',
        })
      }
      return success({ mutations: [pulled(mutation)], cursor: null })
    })

    await engine.start('alice', 'device-a')
    const pulling = engine.pull()
    await vi.waitFor(() => expect(actions).toEqual(['syncPull']))
    const mutation = createMutation(24)
    store.outbox.recordWithConversation(mutation)
    const flushing = engine.flush()
    resolvePull(success({ mutations: [], cursor: null }))
    await Promise.all([pulling, flushing])

    expect(actions).toEqual(['syncPull', 'syncPush', 'syncPull'])
    expect(store.outbox.find(mutation.id)).toBeUndefined()
  })

  it('coalesces a pull requested during push into the pull after that push', async () => {
    const manager = createManager()
    const store = manager.open('alice')
    const mutation = createMutation(29)
    store.outbox.recordWithConversation(mutation)
    let resolvePush!: (response: UserDataFunctionResponse) => void
    const deferredPush = new Promise<UserDataFunctionResponse>((resolve) => { resolvePush = resolve })
    const actions: string[] = []
    const { engine } = createEngine(manager, async (input) => {
      actions.push(input.action)
      if (input.action === 'syncPush') return deferredPush
      return success({ mutations: [pulled(mutation)], cursor: null })
    })

    await engine.start('alice', 'device-a')
    const flushing = engine.flush()
    await vi.waitFor(() => expect(actions).toEqual(['syncPush']))
    const pulling = engine.pull()
    resolvePush(success({
      results: [{ id: mutation.id, status: 'applied', revision: 1 }],
      cursor: 'cursor_queued_pull',
    }))
    await Promise.all([flushing, pulling])

    expect(actions).toEqual(['syncPush', 'syncPull'])
    expect(store.outbox.find(mutation.id)).toBeUndefined()
  })

  it.each([
    { code: 'AUTH_REQUIRED' as const, state: 'paused' as const },
    { code: 'INVALID_INPUT' as const, state: 'quarantined' as const },
  ])('drops a queued flush when pull ends in $code', async ({ code, state }) => {
    const manager = createManager()
    const store = manager.open('alice')
    let resolvePull!: (response: UserDataFunctionResponse) => void
    const deferredPull = new Promise<UserDataFunctionResponse>((resolve) => { resolvePull = resolve })
    const call = vi.fn().mockReturnValue(deferredPull)
    const { engine } = createEngine(manager, call)

    await engine.start('alice', 'device-a')
    const pulling = engine.pull()
    await vi.waitFor(() => expect(call).toHaveBeenCalledOnce())
    store.outbox.recordWithConversation(createMutation(32))
    const flushing = engine.flush()
    resolvePull(failure(code))
    await Promise.all([pulling, flushing])

    expect(call).toHaveBeenCalledOnce()
    expect(engine.status()).toMatchObject({ state, errorCode: code })
  })

  it.each([
    { label: 'authentication', response: failure('AUTH_REQUIRED'), state: 'paused' as const, code: 'AUTH_REQUIRED' as const },
    {
      label: 'conflict',
      response: success({
        results: [{ id: createMutation(33).id, status: 'conflict', errorCode: 'SYNC_CONFLICT' }],
        cursor: 'cursor_conflict_stop',
      }),
      state: 'quarantined' as const,
      code: 'SYNC_CONFLICT' as const,
    },
  ])('drops a queued pull when push ends in $label', async ({ response, state, code }) => {
    const manager = createManager()
    const store = manager.open('alice')
    const mutation = createMutation(33)
    store.outbox.recordWithConversation(mutation)
    let resolvePush!: (response: UserDataFunctionResponse) => void
    const deferredPush = new Promise<UserDataFunctionResponse>((resolve) => { resolvePush = resolve })
    const call = vi.fn().mockReturnValue(deferredPush)
    const { engine } = createEngine(manager, call)

    await engine.start('alice', 'device-a')
    const flushing = engine.flush()
    await vi.waitFor(() => expect(call).toHaveBeenCalledOnce())
    const pulling = engine.pull()
    resolvePush(response)
    await Promise.all([flushing, pulling])

    expect(call).toHaveBeenCalledOnce()
    expect(engine.status()).toMatchObject({ state, errorCode: code })
  })

  it.each([
    { nextUser: 'alice', label: 'same UID' },
    { nextUser: 'bob', label: 'different UID' },
  ])('drains and restores the old generation before $label start handoff', async ({ nextUser }) => {
    const manager = createManager()
    const alice = manager.open('alice')
    const mutation = createMutation(nextUser === 'alice' ? 25 : 26)
    alice.outbox.recordWithConversation(mutation)
    let resolvePush!: (response: UserDataFunctionResponse) => void
    const deferredPush = new Promise<UserDataFunctionResponse>((resolve) => { resolvePush = resolve })
    const { engine } = createEngine(manager, vi.fn().mockReturnValue(deferredPush))

    await engine.start('alice', 'device-a')
    const flushing = engine.flush()
    await vi.waitFor(() => expect(alice.outbox.find(mutation.id)).toMatchObject({ state: 'syncing' }))
    let handedOff = false
    const handoff = Promise.resolve(engine.start(nextUser, 'device-b')).then(() => { handedOff = true })
    await Promise.resolve()
    expect(handedOff).toBe(false)
    resolvePush(success({
      results: [{ id: mutation.id, status: 'applied', revision: 1 }], cursor: 'cursor_stale_handoff',
    }))
    await flushing
    await handoff

    const reopenedAlice = manager.open('alice')
    expect(reopenedAlice.outbox.find(mutation.id)).toMatchObject({ state: 'pending' })
  })

  it('pause clears retry timers and drains an in-flight call', async () => {
    const manager = createManager()
    const store = manager.open('alice')
    store.outbox.record(createMutation(9))
    const clock = new FakeClock()
    const failed = createEngine(manager, vi.fn().mockRejectedValue({ code: 'SERVICE_UNAVAILABLE' }), clock)
    await failed.engine.start('alice', 'device-a')
    await failed.engine.flush()
    expect(clock.timerCount()).toBe(1)
    await failed.engine.pause()
    expect(clock.timerCount()).toBe(0)
    expect(clock.cleared).toHaveLength(1)

    store.outbox.record(createMutation(90))
    let resolveCall!: (response: UserDataFunctionResponse) => void
    const pending = new Promise<UserDataFunctionResponse>((resolve) => { resolveCall = resolve })
    const active = createEngine(manager, vi.fn().mockReturnValue(pending), clock)
    await active.engine.start('alice', 'device-a')
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

  it('clears an existing retry timer before a pull enters quarantine', async () => {
    const manager = createManager()
    manager.open('alice').outbox.record(createMutation(27))
    const call = vi.fn()
      .mockRejectedValueOnce({ code: 'SERVICE_UNAVAILABLE' })
      .mockRejectedValueOnce({ code: 'INTERNAL_ERROR' })
    const { engine, clock } = createEngine(manager, call)
    await engine.start('alice', 'device-a')
    await engine.flush()
    expect(clock.timerCount()).toBe(1)

    await engine.pull()

    expect(engine.status()).toEqual({ state: 'quarantined', errorCode: 'INTERNAL_ERROR' })
    expect(clock.timerCount()).toBe(0)
  })

  it('clears an existing retry timer before a pull pauses for authentication', async () => {
    const manager = createManager()
    manager.open('alice').outbox.record(createMutation(29))
    const call = vi.fn()
      .mockRejectedValueOnce({ code: 'SERVICE_UNAVAILABLE' })
      .mockResolvedValueOnce(failure('AUTH_REQUIRED'))
    const { engine, clock } = createEngine(manager, call)
    await engine.start('alice', 'device-a')
    await engine.flush()
    expect(engine.status()).toMatchObject({ state: 'retrying' })
    expect(clock.timerCount()).toBe(1)

    await engine.pull()

    expect(engine.status()).toEqual({ state: 'paused', errorCode: 'AUTH_REQUIRED' })
    expect(clock.timerCount()).toBe(0)
    await expect(clock.fireNext()).rejects.toThrow('No timer scheduled')
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('maps a timer-driven repository failure to safe quarantine without rejection', async () => {
    const manager = createManager()
    const store = manager.open('alice')
    store.outbox.record(createMutation(28))
    const { engine, clock } = createEngine(
      manager,
      vi.fn().mockRejectedValue({ code: 'SERVICE_UNAVAILABLE' }),
    )
    await engine.start('alice', 'device-a')
    await engine.flush()
    store.outbox.listReady = () => { throw new Error('private row payload') }

    await clock.fireNext()
    await vi.waitFor(() => expect(engine.status()).toEqual({
      state: 'quarantined', errorCode: 'INTERNAL_ERROR',
    }))
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

    await engine.start('alice', 'device-a')
    await engine.pull()

    expect(store.conversations.get(first.entityId)).toBeUndefined()
    expect(store.sync.getCheckpoint()).toBeUndefined()
    expect(engine.status()).toEqual({ state: 'quarantined', errorCode: 'INTERNAL_ERROR' })
  })

  it('quarantines a mismatched replay after direct duplicate acknowledgement', async () => {
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

    await engine.start('alice', 'device-a')
    await engine.flush()

    expect(store.outbox.find(local.id)).toBeUndefined()
    expect(store.sync.getCheckpoint()).toBeUndefined()
    expect(engine.status()).toEqual({ state: 'quarantined', errorCode: 'INTERNAL_ERROR' })
  })
})
