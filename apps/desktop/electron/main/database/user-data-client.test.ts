import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { SyncMutation } from '@autoforge/shared'
import { openAppDatabase } from './client.js'
import { UserDataStoreManager } from './user-data-client.js'

const temporaryDirectories: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'autoforge-user-cache-'))
  temporaryDirectories.push(root)
  return root
}

function createConversationMutation(
  id: string,
  entityId: string,
): Extract<SyncMutation, { kind: 'conversation.create' }> {
  return {
    id,
    kind: 'conversation.create',
    entityId,
    baseRevision: 0,
    occurredAt: '2026-08-24T00:00:00.000Z',
    payload: {
      title: `Title ${entityId}`,
      titleState: 'pending',
      createdAt: '2026-08-24T00:00:00.000Z',
      lastActivityAt: '2026-08-24T00:00:00.000Z',
      metadataUpdatedAt: '2026-08-24T00:00:00.000Z',
    },
  }
}

function appendMessageMutation(
  id: string,
  conversationId: string,
  messageId: string,
): Extract<SyncMutation, { kind: 'message.append' }> {
  return {
    id,
    kind: 'message.append',
    entityId: messageId,
    baseRevision: 1,
    occurredAt: '2026-08-24T00:01:00.000Z',
    payload: {
      id: messageId,
      conversationId,
      role: 'user',
      blocks: [{ type: 'text', text: messageId }],
      createdAt: '2026-08-24T00:01:00.000Z',
    },
  }
}

function renameConversationMutation(
  id: string,
  conversationId: string,
  baseRevision: number,
  title: string,
): Extract<SyncMutation, { kind: 'conversation.rename' }> {
  return {
    id,
    kind: 'conversation.rename',
    entityId: conversationId,
    baseRevision,
    occurredAt: '2026-08-24T00:02:00.000Z',
    payload: {
      title,
      titleState: 'user_named',
      metadataUpdatedAt: '2026-08-24T00:02:00.000Z',
    },
  }
}

function cachePath(root: string, userId: string): string {
  const scope = createHash('sha256')
    .update('autoforge-user-cache-v1\0')
    .update(userId)
    .digest('hex')
    .slice(0, 32)
  return join(root, `${scope}.sqlite`)
}

function pulledMutation<T extends SyncMutation>(
  mutation: T,
  resultRevision: number,
  receivedAt = '2026-08-24T01:00:00.000Z',
): Omit<T, 'occurredAt'> & { resultRevision: number; receivedAt: string } {
  const stored: Partial<T> = { ...mutation }
  delete stored.occurredAt
  return { ...stored, resultRevision, receivedAt } as Omit<T, 'occurredAt'> & {
    resultRevision: number
    receivedAt: string
  }
}

function deleteConversationMutation(index: number): SyncMutation {
  return {
    id: `mutation_delete_${index}`,
    kind: 'conversation.delete',
    entityId: `conversation_delete_${index}`,
    baseRevision: 1,
    occurredAt: '2026-08-24T00:00:00.000Z',
    payload: {},
  }
}

function projectedConversation(
  store: ReturnType<UserDataStoreManager['open']>,
  id: string,
) {
  return store.conversations.listPage({ limit: 50 }).items.find((conversation) => conversation.id === id)
}

function startVideoIntent(
  store: ReturnType<UserDataStoreManager['open']>,
  suffix: string,
  createdAt = 1_000,
) {
  const conversationId = `video_conversation_${suffix}`
  const requestId = `video_request_${suffix}`
  const assistantMessageId = `video_assistant_${suffix}`
  store.conversations.insert({
    id: conversationId,
    title: `Video ${suffix}`,
    userId: 'cloud-alice',
    createdAt,
    updatedAt: createdAt,
  })
  store.mediaGenerationJobs.startSubmissionIntent({
    userMessage: {
      id: `video_user_${suffix}`,
      conversationId,
      role: 'user',
      blocks: [{ type: 'text', text: `Generate ${suffix}` }],
      createdAt,
    },
    userAssetIds: [],
    assistantMessage: {
      id: assistantMessageId,
      conversationId,
      role: 'assistant',
      blocks: [{
        type: 'media_generation',
        blockId: `video_block_${suffix}`,
        jobId: requestId,
        kind: 'video',
        status: 'pending',
      }],
      createdAt,
    },
    run: {
      id: `video_run_${suffix}`,
      conversationId,
      requestId,
      userId: 'cloud-alice',
      provider: 'openrouter',
      model: 'video-model',
      status: 'running',
      startedAt: createdAt,
    },
    job: {
      id: requestId,
      conversationId,
      assistantMessageId,
      provider: 'openrouter',
      model: 'video-model',
      kind: 'video',
      status: 'pending',
      parameters: { version: 1, options: {}, submission: { phase: 'intent' } },
      createdAt,
      updatedAt: createdAt,
    },
  })
  return { conversationId, requestId, assistantMessageId }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('UserDataStoreManager', () => {
  it('preserves enqueue FIFO when timestamps are frozen and IDs sort in reverse', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_777_000_000_000)
    const manager = new UserDataStoreManager(temporaryRoot())
    try {
      const store = manager.open('cloud-alice')
      store.outbox.recordWithConversation(
        createConversationMutation('z_create_first', 'fifo_conversation'),
      )
      store.outbox.recordWithMessage(
        appendMessageMutation('y_message_second', 'fifo_conversation', 'fifo_message'),
      )
      store.outbox.recordWithConversation(
        renameConversationMutation('x_rename_third', 'fifo_conversation', 2, 'FIFO title'),
      )

      const expected = ['z_create_first', 'y_message_second', 'x_rename_third']
      expect(store.outbox.list(10).map(({ id }) => id)).toEqual(expected)
      expect(store.outbox.listReady(Date.now(), 10).map(({ id }) => id)).toEqual(expected)
    } finally {
      manager.close()
      now.mockRestore()
    }
  })

  it('isolates users behind domain-separated hash-only filenames', () => {
    const root = temporaryRoot()
    const manager = new UserDataStoreManager(root)
    const alice = manager.open('cloud-alice')

    expect(manager.current()).toBe(alice)
    alice.outbox.recordWithConversation(createConversationMutation('mutation_alice', 'conversation_alice'))

    const expectedScope = createHash('sha256')
      .update('autoforge-user-cache-v1\0')
      .update('cloud-alice')
      .digest('hex')
      .slice(0, 32)
    const aliceFiles = readdirSync(root)
    expect(aliceFiles).toContain(`${expectedScope}.sqlite`)
    expect(aliceFiles.join('\n')).not.toContain('cloud-alice')

    manager.closeAndDelete('cloud-alice')
    expect(manager.current()).toBeUndefined()
    const bob = manager.open('cloud-bob')
    expect(bob.conversations.listPage({ limit: 50 })).toEqual({ items: [] })
    expect(readdirSync(root).some((name) => name.includes('cloud-alice'))).toBe(false)
    manager.close()
  })

  it('rolls back conversation state when its matching outbox insertion fails', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')
    store.outbox.record(createConversationMutation('duplicate_mutation', 'existing_conversation'))

    expect(() => store.outbox.recordWithConversation(
      createConversationMutation('duplicate_mutation', 'rolled_back_conversation'),
    )).toThrow()
    expect(store.conversations.get('rolled_back_conversation')).toBeUndefined()
    expect(store.outbox.countPending()).toBe(1)
    manager.close()
  })

  it('rolls back message state when its matching outbox insertion fails', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')
    store.outbox.recordWithConversation(createConversationMutation('create_for_message', 'conversation_message'))
    store.outbox.record(appendMessageMutation('duplicate_message_mutation', 'conversation_message', 'existing_message'))

    expect(() => store.outbox.recordWithMessage(
      appendMessageMutation('duplicate_message_mutation', 'conversation_message', 'rolled_back_message'),
    )).toThrow()
    expect(store.messages.get('rolled_back_message')).toBeUndefined()
    expect(store.outbox.countPending()).toBe(2)
    manager.close()
  })

  it('moves an appended conversation ahead when both conversations share the same millisecond', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')
    store.outbox.recordWithConversation(
      createConversationMutation('create_z', 'conversation_z'),
    )
    store.outbox.recordWithConversation(
      createConversationMutation('create_a', 'conversation_a'),
    )
    expect(store.conversations.listPage({ limit: 50 }).items.map(({ id }) => id))
      .toEqual(['conversation_a', 'conversation_z'])

    const append = appendMessageMutation('append_z', 'conversation_z', 'message_z')
    store.outbox.recordWithMessage({
      ...append,
      occurredAt: '2026-08-24T00:00:00.000Z',
      payload: { ...append.payload, createdAt: '2026-08-24T00:00:00.000Z' },
    })

    expect(store.conversations.listPage({ limit: 50 }).items.map(({ id }) => id))
      .toEqual(['conversation_z', 'conversation_a'])
    manager.close()
  })

  it('atomically records an AI title completion as a rename mutation', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')
    store.outbox.recordWithConversation(
      createConversationMutation('create_title', 'conversation_title'),
    )
    expect(store.conversations.claimTitleGeneration('conversation_title')).toBe(true)

    expect(store.conversations.completeTitleGeneration('conversation_title', 'AI title'))
      .toMatchObject({ title: 'AI title', titleState: 'ai_named' })
    expect(store.outbox.list(10)).toEqual([
      expect.objectContaining({ id: 'create_title', kind: 'conversation.create' }),
      expect.objectContaining({
        kind: 'conversation.rename',
        entityId: 'conversation_title',
        payload: expect.objectContaining({ title: 'AI title', titleState: 'ai_named' }),
      }),
    ])
    expect(projectedConversation(store, 'conversation_title'))
      .toMatchObject({ title: 'AI title', titleState: 'ai_named', syncState: 'pending' })
    manager.close()
  })

  it('atomically records only the immutable user message when a video intent starts', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')
    const video = startVideoIntent(store, 'start')

    expect(store.messages.listForConversation(video.conversationId)).toHaveLength(2)
    expect(store.outbox.list(10)).toEqual([
      expect.objectContaining({
        kind: 'message.append',
        entityId: 'video_user_start',
        payload: expect.objectContaining({ role: 'user' }),
      }),
    ])
    expect(store.outbox.list(10).some(({ entityId }) => entityId === video.assistantMessageId))
      .toBe(false)
    expect(projectedConversation(store, video.conversationId)).toMatchObject({
      syncState: 'pending',
      lastActivityAt: '1970-01-01T00:00:01.001Z',
    })
    manager.close()
  })

  it('atomically records one immutable failed video message and survives restart', () => {
    const root = temporaryRoot()
    const manager = new UserDataStoreManager(root)
    const store = manager.open('cloud-alice')
    const video = startVideoIntent(store, 'failed')

    expect(store.mediaGenerationJobs.fail(
      video.requestId,
      ['pending'],
      'MEDIA_GENERATION_FAILED',
      2_000,
    )).toMatchObject({ job: { status: 'failed' } })
    expect(store.mediaGenerationJobs.fail(
      video.requestId,
      ['pending'],
      'MEDIA_GENERATION_FAILED',
      2_000,
    )).toBeUndefined()
    expect(store.outbox.list(10).map(({ entityId }) => entityId)).toEqual([
      'video_user_failed', video.assistantMessageId,
    ])
    expect(store.outbox.list(10)[1]).toMatchObject({
      kind: 'message.append',
      payload: {
        role: 'assistant',
        blocks: [expect.objectContaining({
          type: 'media_generation', status: 'failed', errorCode: 'MEDIA_GENERATION_FAILED',
        })],
      },
    })
    expect(projectedConversation(store, video.conversationId)).toMatchObject({
      syncState: 'pending',
      lastActivityAt: '1970-01-01T00:00:02.000Z',
    })
    store.outbox.markSyncing(store.outbox.list(10).map(({ id }) => id))
    manager.close()

    const reopened = manager.open('cloud-alice')
    expect(reopened.outbox.list(10).map(({ entityId }) => entityId)).toEqual([
      'video_user_failed', video.assistantMessageId,
    ])
    expect(reopened.outbox.list(10).every(({ state }) => state === 'pending')).toBe(true)
    manager.close()
  })

  it('atomically records one immutable completed video message', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')
    const video = startVideoIntent(store, 'completed')
    store.mediaGenerationJobs.bindSubmitted(video.requestId, {
      providerJobId: 'provider_video_completed',
      status: 'in_progress',
      parameters: { version: 1, options: {} },
      nextPollAt: 1_500,
      updatedAt: 1_100,
    })
    store.mediaGenerationJobs.transition(video.requestId, ['in_progress'], {
      status: 'downloading', nextPollAt: null, updatedAt: 1_500,
    })
    store.mediaAssets.insert({
      id: 'video_asset_completed',
      conversationId: video.conversationId,
      source: 'generated',
      kind: 'video',
      mimeType: 'video/mp4',
      originalName: 'completed.mp4',
      relativePath: `${video.conversationId}/completed.mp4`,
      byteSize: 24,
      sha256: 'a'.repeat(64),
      provider: 'openrouter',
      model: 'video-model',
      status: 'ready',
      createdAt: 1_500,
      updatedAt: 1_500,
    })

    const terminal = store.mediaGenerationJobs.complete(video.requestId, ['downloading'], {
      assetId: 'video_asset_completed',
      block: {
        type: 'media',
        blockId: 'video_block_completed',
        assetId: 'video_asset_completed',
        kind: 'video',
        purpose: 'output',
        name: 'completed.mp4',
        mimeType: 'video/mp4',
        byteSize: 24,
      },
      endedAt: 2_000,
    })

    expect(terminal).toMatchObject({ job: { status: 'completed' } })
    expect(store.mediaGenerationJobs.complete(video.requestId, ['downloading'], {
      assetId: 'video_asset_completed',
      block: terminal!.block,
      endedAt: 2_000,
    })).toBeUndefined()
    expect(store.outbox.list(10).map(({ entityId }) => entityId)).toEqual([
      'video_user_completed', video.assistantMessageId,
    ])
    expect(store.outbox.list(10)[1]).toMatchObject({
      kind: 'message.append',
      payload: { role: 'assistant', blocks: [expect.objectContaining({ type: 'media' })] },
    })
    expect(projectedConversation(store, video.conversationId)).toMatchObject({
      syncState: 'pending',
      lastActivityAt: '1970-01-01T00:00:02.000Z',
    })
    manager.close()
  })

  it('keeps both owner caches isolated while switching without deletion', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    manager.open('cloud-alice').outbox.recordWithConversation(
      createConversationMutation('mutation_alice_switch', 'conversation_alice_switch'),
    )
    manager.open('cloud-bob').outbox.recordWithConversation(
      createConversationMutation('mutation_bob_switch', 'conversation_bob_switch'),
    )

    expect(manager.open('cloud-alice').conversations.listPage({ limit: 50 }).items.map(({ id }) => id))
      .toEqual(['conversation_alice_switch'])
    expect(manager.open('cloud-bob').conversations.listPage({ limit: 50 }).items.map(({ id }) => id))
      .toEqual(['conversation_bob_switch'])
    manager.close()
  })

  it('uses stable keyset cursors for conversation and message pages', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')
    for (let index = 0; index < 51; index += 1) {
      store.conversations.insert({
        id: `conversation_page_${String(index).padStart(2, '0')}`,
        title: `Page ${index}`,
        createdAt: index + 1,
        updatedAt: index + 1,
      })
    }
    const firstConversations = store.conversations.listPage({ limit: 50 })
    expect(firstConversations.items).toHaveLength(50)
    expect(firstConversations.nextCursor).toBeDefined()
    const secondConversations = store.conversations.listPage({
      limit: 50,
      cursor: firstConversations.nextCursor,
    })
    expect(secondConversations.items).toHaveLength(1)
    expect(new Set([...firstConversations.items, ...secondConversations.items].map(({ id }) => id)).size)
      .toBe(51)

    for (let index = 0; index < 101; index += 1) {
      store.messages.insert({
        id: `message_page_${String(index).padStart(3, '0')}`,
        conversationId: 'conversation_page_00',
        role: 'user',
        blocks: [{ type: 'text', text: String(index) }],
        createdAt: index + 1,
      })
    }
    const latestMessages = store.messages.listPage({
      conversationId: 'conversation_page_00',
      limit: 100,
    })
    expect(latestMessages.items).toHaveLength(100)
    expect(latestMessages.previousCursor).toBeDefined()
    const oldestMessages = store.messages.listPage({
      conversationId: 'conversation_page_00',
      limit: 100,
      cursor: latestMessages.previousCursor,
    })
    expect(oldestMessages.items).toHaveLength(1)
    expect(new Set([...latestMessages.items, ...oldestMessages.items].map(({ id }) => id)).size)
      .toBe(101)
    manager.close()
  })

  it('recovers in-flight outbox rows and exposes validated find/list operations', () => {
    const root = temporaryRoot()
    const manager = new UserDataStoreManager(root)
    const store = manager.open('cloud-alice')
    store.outbox.record(createConversationMutation('mutation_recover', 'conversation_recover'))
    store.outbox.markSyncing(['mutation_recover'])
    expect(store.outbox.find('mutation_recover')).toMatchObject({ state: 'syncing', attempts: 1 })
    manager.close()

    const reopened = manager.open('cloud-alice')
    expect(reopened.outbox.find('mutation_recover')).toMatchObject({ state: 'pending', attempts: 1 })
    expect(reopened.outbox.list(10).map(({ id }) => id)).toEqual(['mutation_recover'])
    manager.close()
  })

  it('keeps quarantined failures out of ready FIFO until a due retry is explicit', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')
    const quarantined = createConversationMutation('quarantined_mutation', 'quarantined_conversation')
    const retryable = createConversationMutation('retryable_mutation', 'retryable_conversation')
    const pendingRetry = createConversationMutation('pending_retry_mutation', 'pending_retry_conversation')
    store.outbox.record(quarantined)
    store.outbox.record(retryable)
    store.outbox.record(pendingRetry)

    store.outbox.markFailed(quarantined.id, 'SYNC_CONFLICT')
    store.outbox.markFailed(retryable.id, 'SYNC_FAILED', 2_000)
    store.outbox.markPending(pendingRetry.id, 2_000)

    expect(store.outbox.listReady(1_999, 10)).toEqual([])
    expect(store.outbox.listReady(2_000, 10).map(({ id }) => id)).toEqual([
      retryable.id, pendingRetry.id,
    ])
    manager.close()
  })

  it('persists failed conversation projection and atomically requeues it for retry', () => {
    const root = temporaryRoot()
    const manager = new UserDataStoreManager(root)
    const store = manager.open('cloud-alice')
    const mutation = createConversationMutation('retry_projection_mutation', 'retry_projection_conversation')
    store.outbox.recordWithConversation(mutation)
    store.outbox.markFailed(mutation.id, 'SYNC_CONFLICT')

    expect(store.conversations.listPage({ limit: 50 }).items).toContainEqual(
      expect.objectContaining({ id: mutation.entityId, syncState: 'failed' }),
    )
    manager.close()

    const reopened = manager.open('cloud-alice')
    expect(reopened.conversations.listPage({ limit: 50 }).items).toContainEqual(
      expect.objectContaining({ id: mutation.entityId, syncState: 'failed' }),
    )
    expect(reopened.outbox.retryFailed(mutation.entityId)).toEqual([mutation.id])
    expect(reopened.outbox.find(mutation.id)).toMatchObject({ state: 'pending' })
    expect(reopened.outbox.find(mutation.id)).not.toHaveProperty('lastErrorCode')
    expect(reopened.outbox.find(mutation.id)).not.toHaveProperty('nextAttemptAt')
    expect(reopened.conversations.listPage({ limit: 50 }).items).toContainEqual(
      expect.objectContaining({ id: mutation.entityId, syncState: 'pending' }),
    )

    reopened.outbox.markSyncing([mutation.id])
    reopened.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_retry_projection',
      mutations: [pulledMutation(mutation, 1)],
    }, 2)
    expect(reopened.outbox.find(mutation.id)).toBeUndefined()
    expect(reopened.conversations.listPage({ limit: 50 }).items).toContainEqual(
      expect.objectContaining({ id: mutation.entityId, revision: 1, syncState: 'synced' }),
    )
    manager.close()
  })

  it('keeps transient conversation failures pending instead of failed', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')
    const mutation = createConversationMutation('transient_projection', 'transient_conversation')
    store.outbox.recordWithConversation(mutation)
    store.outbox.markPending(mutation.id, 2_000)

    expect(store.outbox.find(mutation.id)).toMatchObject({ state: 'pending', nextAttemptAt: 2_000 })
    expect(store.conversations.listPage({ limit: 50 }).items).toContainEqual(
      expect.objectContaining({ id: mutation.entityId, syncState: 'pending' }),
    )
    manager.close()
  })

  it('keeps a conversation failed while a later terminal row remains', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')
    const create = createConversationMutation('failed_chain_create', 'failed_chain_conversation')
    store.sync.applyRemotePage({
      protocolVersion: 1, cursor: 'cursor_failed_chain_create', mutations: [pulledMutation(create, 1)],
    }, 1)
    const first = renameConversationMutation('failed_chain_first', create.entityId, 1, 'First')
    const second = renameConversationMutation('failed_chain_second', create.entityId, 2, 'Second')
    store.outbox.recordWithConversation(first)
    store.outbox.recordWithConversation(second)
    store.outbox.markSyncing([first.id, second.id])
    store.outbox.markFailed(second.id, 'SYNC_CONFLICT')

    store.sync.applyRemotePage({
      protocolVersion: 1, cursor: 'cursor_failed_chain_first', mutations: [pulledMutation(first, 2)],
    }, 2)

    expect(store.outbox.find(first.id)).toBeUndefined()
    expect(store.outbox.find(second.id)).toMatchObject({ state: 'failed' })
    expect(store.conversations.listPage({ limit: 50 }).items).toContainEqual(
      expect.objectContaining({ id: create.entityId, revision: 2, syncState: 'failed' }),
    )
    manager.close()
  })

  it('retries a failed message by its mutation entity ID', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')
    const create = createConversationMutation('retry_message_create', 'retry_message_conversation')
    store.sync.applyRemotePage({
      protocolVersion: 1, cursor: 'cursor_retry_message_create', mutations: [pulledMutation(create, 1)],
    }, 1)
    const message = appendMessageMutation(
      'retry_message_mutation', create.entityId, 'retry_message_entity',
    )
    store.outbox.recordWithMessage(message)
    store.outbox.markFailed(message.id, 'INVALID_INPUT')

    expect(store.outbox.retryFailed(message.entityId)).toEqual([message.id])
    expect(store.outbox.find(message.id)).toMatchObject({ state: 'pending' })
    expect(store.conversations.listPage({ limit: 50 }).items).toContainEqual(
      expect.objectContaining({ id: create.entityId, syncState: 'pending' }),
    )
    manager.close()
  })

  it('acknowledges duplicate push results but retains applied evidence for pull', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')
    const first = createConversationMutation('push_ack_first', 'push_ack_conversation_first')
    const second = createConversationMutation('push_ack_second', 'push_ack_conversation_second')
    store.outbox.recordWithConversation(first)
    store.outbox.recordWithConversation(second)
    store.outbox.markSyncing([first.id, second.id])

    store.outbox.acknowledgePushResults([first, second], [
      { id: first.id, status: 'applied', revision: 1 },
      { id: second.id, status: 'duplicate', revision: 1 },
    ])

    expect(store.outbox.find(first.id)).toMatchObject({ state: 'syncing' })
    expect(store.outbox.find(second.id)).toBeUndefined()
    expect(store.conversations.listPage({ limit: 50 }).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.entityId, revision: 0, syncState: 'syncing' }),
      expect.objectContaining({ id: second.entityId, revision: 1, syncState: 'synced' }),
    ]))
    manager.close()
  })

  it('moves a duplicate acknowledgement to durable non-sendable receipt evidence', () => {
    const root = temporaryRoot()
    const manager = new UserDataStoreManager(root)
    const store = manager.open('cloud-alice')
    const create = createConversationMutation('evidence_create', 'evidence_conversation')
    store.sync.applyRemotePage({
      protocolVersion: 1, cursor: 'cursor_evidence_create', mutations: [pulledMutation(create, 1)],
    }, 1)
    const first = renameConversationMutation(
      'evidence_first', create.entityId, 1, 'First remote title',
    )
    const later = renameConversationMutation(
      'evidence_later', create.entityId, 2, 'Later local title',
    )
    store.outbox.recordWithConversation(first)
    store.outbox.recordWithConversation(later)
    store.outbox.markSyncing([first.id])
    store.outbox.markPending(first.id)
    store.outbox.markSyncing([first.id])

    store.outbox.acknowledgePushResults(
      [first],
      [{ id: first.id, status: 'duplicate', revision: 2 }],
    )

    expect(store.outbox.find(first.id)).toBeUndefined()
    expect(store.outbox.countPending()).toBe(1)
    expect(store.outbox.listReady(Date.now(), 10).map(({ id }) => id)).toEqual([later.id])
    expect(projectedConversation(store, create.entityId)).toMatchObject({
      title: 'Later local title', revision: 2, syncState: 'pending',
    })
    const inspection = new Database(cachePath(root, 'cloud-alice'))
    expect(inspection.prepare('SELECT mutation_id AS mutationId FROM sync_receipt_evidence').all())
      .toEqual([{ mutationId: first.id }])
    inspection.close()

    store.sync.applyRemotePage({
      protocolVersion: 1, cursor: 'cursor_evidence_behind', mutations: [],
    }, 2)
    manager.close()
    const behind = new Database(cachePath(root, 'cloud-alice'), { readonly: true })
    expect(behind.prepare('SELECT mutation_id AS mutationId FROM sync_receipt_evidence').all())
      .toEqual([{ mutationId: first.id }])
    behind.close()

    const reopened = manager.open('cloud-alice')
    expect(() => reopened.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_evidence_rolled_back',
      mutations: [
        pulledMutation(first, 2),
        pulledMutation(renameConversationMutation(
          'evidence_invalid_later', 'missing_conversation', 1, 'Invalid',
        ), 2),
      ],
    }, 3)).toThrow(expect.objectContaining({ code: 'INTERNAL_ERROR' }))
    expect(reopened.sync.getCheckpoint()?.remoteCursor).toBe('cursor_evidence_behind')
    const rolledBack = new Database(cachePath(root, 'cloud-alice'), { readonly: true })
    expect(rolledBack.prepare('SELECT mutation_id AS mutationId FROM sync_receipt_evidence').all())
      .toEqual([{ mutationId: first.id }])
    rolledBack.close()

    reopened.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_evidence_receipt',
      mutations: [pulledMutation(first, 2)],
    }, 4)
    expect(projectedConversation(reopened, create.entityId)).toMatchObject({
      title: 'Later local title', revision: 2, syncState: 'pending',
    })
    expect(reopened.outbox.find(later.id)).toBeDefined()
    manager.close()
    const consumed = new Database(cachePath(root, 'cloud-alice'), { readonly: true })
    expect(consumed.prepare('SELECT COUNT(*) AS count FROM sync_receipt_evidence').get())
      .toEqual({ count: 0 })
    consumed.close()
  })

  it('recomputes one conversation projection from all mixed outbox rows', () => {
    const root = temporaryRoot()
    const manager = new UserDataStoreManager(root)
    const store = manager.open('cloud-alice')
    const create = createConversationMutation('mixed_create', 'mixed_conversation')
    store.sync.applyRemotePage({
      protocolVersion: 1, cursor: 'cursor_mixed_create', mutations: [pulledMutation(create, 1)],
    }, 1)
    const first = appendMessageMutation('mixed_first', create.entityId, 'mixed_message_first')
    const second = appendMessageMutation('mixed_second', create.entityId, 'mixed_message_second')
    store.outbox.recordWithMessage(first)
    store.outbox.recordWithMessage(second)
    store.outbox.markSyncing([first.id, second.id])
    expect(projectedConversation(store, create.entityId)?.syncState).toBe('syncing')

    store.outbox.markFailed(first.id, 'SYNC_CONFLICT')
    store.outbox.markFailed(second.id, 'INVALID_INPUT')
    expect(projectedConversation(store, create.entityId)?.syncState).toBe('failed')
    manager.close()

    const reopened = manager.open('cloud-alice')
    expect(projectedConversation(reopened, create.entityId)?.syncState).toBe('failed')
    expect(reopened.outbox.retryFailed(first.entityId)).toEqual([first.id])
    expect(projectedConversation(reopened, create.entityId)?.syncState).toBe('failed')
    reopened.outbox.markSyncing([first.id])
    expect(projectedConversation(reopened, create.entityId)?.syncState).toBe('failed')
    expect(reopened.outbox.retryFailed(second.entityId)).toEqual([second.id])
    expect(projectedConversation(reopened, create.entityId)?.syncState).toBe('syncing')
    reopened.outbox.markPending(first.id)
    expect(projectedConversation(reopened, create.entityId)?.syncState).toBe('pending')

    reopened.outbox.markSyncing([first.id, second.id])
    reopened.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_mixed_receipts',
      mutations: [pulledMutation(first, 1), pulledMutation(second, 1)],
    }, 2)
    expect(projectedConversation(reopened, create.entityId)?.syncState).toBe('synced')
    manager.close()
  })

  it('rolls back all push acknowledgements when one result mismatches the sent batch', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')
    const first = createConversationMutation('push_mismatch_first', 'push_mismatch_conversation_first')
    const second = createConversationMutation('push_mismatch_second', 'push_mismatch_conversation_second')
    store.outbox.recordWithConversation(first)
    store.outbox.recordWithConversation(second)
    store.outbox.markSyncing([first.id, second.id])

    expect(() => store.outbox.acknowledgePushResults([first, second], [
      { id: first.id, status: 'applied', revision: 1 },
      { id: 'different_result', status: 'duplicate', revision: 1 },
    ])).toThrow(expect.objectContaining({ code: 'INTERNAL_ERROR' }))
    expect(store.outbox.find(first.id)).toMatchObject({ state: 'syncing' })
    expect(store.outbox.find(second.id)).toMatchObject({ state: 'syncing' })
    manager.close()
  })

  it('matches sanitized workflow args without changing local message content', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')
    const create = createConversationMutation('sanitize_create', 'sanitize_conversation')
    store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_sanitize_create',
      mutations: [pulledMutation(create, 1)],
    }, 1)
    const append: Extract<SyncMutation, { kind: 'message.append' }> = {
      ...appendMessageMutation('sanitize_append', create.entityId, 'sanitize_message'),
      payload: {
        ...appendMessageMutation('sanitize_append', create.entityId, 'sanitize_message').payload,
        blocks: [
          { type: 'text', text: 'ordinary prompt token filePath content' },
          {
            type: 'workflow_proposal',
            workflowId: 'workflow_1',
            workflowName: 'Workflow',
            args: {
              query: 'status:open', fluid: 'hydraulic',
              prompt: 'private prompt', token: 'private token', filePath: '/private/file',
            },
          },
        ],
      },
    }
    store.outbox.recordWithMessage(append)
    store.outbox.markSyncing([append.id])
    const sanitizedReceipt = pulledMutation(append, 2)
    sanitizedReceipt.payload = {
      ...sanitizedReceipt.payload,
      blocks: [
        { type: 'text', text: 'ordinary prompt token filePath content' },
        {
          type: 'workflow_proposal',
          workflowId: 'workflow_1',
          workflowName: 'Workflow',
          args: {
            query: 'status:open', fluid: 'hydraulic',
            prompt: '[REDACTED]', token: '[REDACTED]', filePath: '[REDACTED]',
          },
        },
      ],
    }

    expect(() => store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_sanitize_message',
      mutations: [sanitizedReceipt],
    }, 2)).not.toThrow()
    expect(store.outbox.find(append.id)).toBeUndefined()
    expect(store.messages.get(append.payload.id)?.blocks).toEqual(append.payload.blocks)
    manager.close()
  })

  it('accepts the exact reduced legacy-import receipt and advances the checkpoint', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')

    store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_legacy_receipt_1',
      mutations: [{
        id: 'legacy_receipt_1',
        kind: 'legacy.import',
        entityId: 'legacy_batch_1',
        baseRevision: 0,
        resultRevision: 0,
        payload: { batchId: 'legacy_batch_1', includeUnowned: false },
        receivedAt: '2026-08-24T00:00:00.000Z',
      }],
    }, 1)

    expect(store.sync.getCheckpoint()).toEqual({
      protocolVersion: 1,
      remoteCursor: 'cursor_legacy_receipt_1',
      updatedAt: 1,
    })
    manager.close()
  })

  it('applies a validated remote page and advances its checkpoint atomically', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')
    store.sync.updateCheckpoint({ protocolVersion: 1, remoteCursor: 'cursor_0000000001', updatedAt: 1 })
    const create = createConversationMutation('remote_create', 'remote_conversation')

    store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_0000000002',
      mutations: [pulledMutation(create, 1)],
    }, 2)

    expect(store.conversations.listPage({ limit: 50 }).items).toEqual([
      expect.objectContaining({ id: 'remote_conversation', revision: 1, syncState: 'synced' }),
    ])
    expect(store.sync.getCheckpoint()).toEqual({
      protocolVersion: 1,
      remoteCursor: 'cursor_0000000002',
      updatedAt: 2,
    })

    expect(() => store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_0000000003',
      mutations: [
        pulledMutation({
          ...create,
          id: 'remote_create_rollback',
          entityId: 'remote_conversation_rollback',
        }, 1),
        pulledMutation(
          appendMessageMutation('remote_missing_parent', 'missing_conversation', 'remote_message'),
          2,
        ),
      ],
    }, 3)).toThrow()
    expect(store.conversations.get('remote_conversation_rollback')).toBeUndefined()
    expect(store.sync.getCheckpoint()?.remoteCursor).toBe('cursor_0000000002')
    manager.close()
  })

  it('rejects corrupted persisted rows without advancing the checkpoint', () => {
    const root = temporaryRoot()
    const manager = new UserDataStoreManager(root)
    const store = manager.open('cloud-alice')
    store.outbox.recordWithConversation(
      createConversationMutation('mutation_corrupt', 'conversation_corrupt'),
    )
    store.sync.updateCheckpoint({ protocolVersion: 1, remoteCursor: 'cursor_0000000001', updatedAt: 1 })
    manager.close()
    const sqlite = new Database(cachePath(root, 'cloud-alice'))
    sqlite.pragma('ignore_check_constraints = ON')
    sqlite.prepare("UPDATE conversations SET title_state = 'corrupt' WHERE id = 'conversation_corrupt'").run()
    sqlite.prepare("UPDATE outbox_mutations SET payload_json = '{bad json' WHERE id = 'mutation_corrupt'").run()
    sqlite.close()

    const reopened = manager.open('cloud-alice')
    expect(() => reopened.conversations.listPage({ limit: 50 }))
      .toThrow(expect.objectContaining({ code: 'INTERNAL_ERROR' }))
    expect(() => reopened.outbox.find('mutation_corrupt'))
      .toThrow(expect.objectContaining({ code: 'INTERNAL_ERROR' }))
    expect(() => reopened.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_0000000002',
      mutations: [{ invalid: true }],
    }, 2)).toThrow(expect.objectContaining({ code: 'INTERNAL_ERROR' }))
    expect(reopened.sync.getCheckpoint()?.remoteCursor).toBe('cursor_0000000001')
    manager.close()
  })

  it('binds owner-bearing operations to the manager-selected UID', () => {
    const root = temporaryRoot()
    const manager = new UserDataStoreManager(root)
    const store = manager.open('cloud-alice')
    store.conversations.insert({ id: 'owner_conversation', title: 'Owner' })
    expect(() => store.conversations.insert({
      id: 'wrong_owner_conversation', title: 'Wrong', userId: 'cloud-bob',
    })).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => store.conversations.claimLegacyAndListForUser('cloud-bob'))
      .toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => store.chatRuns.insert({
      id: 'wrong_owner_run',
      conversationId: 'owner_conversation',
      requestId: 'wrong_owner_request',
      model: 'model',
      status: 'completed',
      startedAt: 1,
      userId: 'cloud-bob',
      provider: 'openrouter',
    })).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => store.providerUsage.start({
      id: 'wrong_owner_usage',
      operationKey: 'wrong_owner_operation',
      userId: 'cloud-bob',
      provider: 'openrouter',
      requestId: 'wrong_owner_usage_request',
      model: 'model',
      modality: 'text',
      startedAt: 1,
    })).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => store.chatRuns.summarizeTokenUsage({
      userId: 'cloud-bob',
      yesterdayStartedAt: 0,
      todayStartedAt: 0,
      weekStartedAt: 0,
      monthStartedAt: 0,
      endedAt: 1,
    })).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))

    store.providerUsage.start({
      id: 'alice_pending_usage',
      operationKey: 'alice_pending_operation',
      userId: 'cloud-alice',
      provider: 'openrouter',
      requestId: 'alice_pending_request',
      model: 'model',
      modality: 'text',
      startedAt: 1,
    })
    const raw = new Database(cachePath(root, 'cloud-alice'))
    raw.prepare(`
      INSERT INTO conversations (
        id, title, title_state, user_id, revision, sync_state,
        created_at, updated_at, last_activity_at, metadata_updated_at
      ) VALUES ('bob_conversation', 'Bob', 'user_named', 'cloud-bob', 1, 'synced', 1, 1, 1, 1)
    `).run()
    raw.prepare(`
      INSERT INTO conversation_contexts (
        conversation_id, summary_text, through_ordinal, estimated_tokens, updated_at
      ) VALUES ('bob_conversation', 'private bob context', 1, 1, 1)
    `).run()
    raw.prepare(`
      INSERT INTO messages (
        id, conversation_id, role, blocks_json, ordinal, created_at
      ) VALUES ('bob_message', 'bob_conversation', 'assistant', ?, 1, 1)
    `).run(JSON.stringify([{ type: 'text', text: 'private bob message' }]))
    raw.prepare(`
      INSERT INTO agent_workflow_approvals (execution_id, message_id, block_id)
      VALUES ('bob_execution', 'bob_message', 'bob_block')
    `).run()
    raw.prepare(`
      INSERT INTO chat_runs (
        id, conversation_id, request_id, model, status, started_at, user_id, provider
      ) VALUES ('bob_run', 'bob_conversation', 'bob_request', 'model', 'completed', 1, 'cloud-bob', 'openrouter')
    `).run()
    raw.prepare(`
      INSERT INTO provider_usage_events (
        id, operation_key, user_id, provider, request_id, generation_id,
        model, modality, status, next_reconcile_at, started_at
      ) VALUES
        ('bob_pending_usage', 'bob_pending_operation', 'cloud-bob', 'openrouter',
         'bob_pending_request', NULL, 'model', 'text', 'pending', NULL, 1),
        ('bob_unknown_usage', 'bob_unknown_operation', 'cloud-bob', 'openrouter',
         'bob_unknown_request', 'bob_generation', 'model', 'text', 'unknown', 1, 1)
    `).run()
    raw.close()

    expect(() => store.conversationContexts.get('bob_conversation'))
      .toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    for (const mutate of [
      () => store.conversations.renameByUser('bob_conversation', 'Stolen'),
      () => store.conversations.claimTitleGeneration('bob_conversation'),
      () => store.conversations.completeTitleGeneration('bob_conversation', 'Stolen'),
      () => store.conversations.failTitleGeneration('bob_conversation'),
      () => store.conversations.failPendingTitleGeneration('bob_conversation'),
      () => store.conversations.updateGenerationPreferences('bob_conversation', {} as never),
      () => store.conversations.delete('bob_conversation'),
    ]) expect(mutate).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    for (const access of [
      () => store.messages.get('bob_message'),
      () => store.messages.listForConversation('bob_conversation'),
      () => store.messages.listBeforeOrdinal('bob_conversation', 2),
      () => store.messages.listPage({ conversationId: 'bob_conversation', limit: 100 }),
      () => store.messages.insert({
        id: 'alice_message_on_bob', conversationId: 'bob_conversation', role: 'user',
        blocks: [{ type: 'text', text: 'forbidden' }], createdAt: 2,
      }),
      () => store.messages.insertWithAssets({
        id: 'alice_asset_message_on_bob', conversationId: 'bob_conversation', role: 'user',
        blocks: [{ type: 'text', text: 'forbidden' }], createdAt: 2,
      }, []),
      () => store.messages.update('bob_message', { executionId: 'stolen' }),
      () => store.messages.replaceBlock('bob_message', 'bob_block', { type: 'text', text: 'stolen' }),
      () => store.messages.hasWorkflowApproval('bob_execution'),
    ]) expect(access).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    for (const bulkMutation of [
      () => store.messages.upgradeLegacyApprovals(),
      () => store.messages.invalidatePendingAgentApprovals(),
      () => store.messages.failInterruptedMediaGenerations(),
      () => store.messages.failInterruptedBrowserStatuses(['bob_request']),
    ]) expect(bulkMutation).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => store.chatRuns.get('bob_run'))
      .toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => store.chatRuns.insert({
      id: 'alice_run_on_bob_conversation',
      conversationId: 'bob_conversation',
      requestId: 'alice_request_on_bob_conversation',
      model: 'model',
      status: 'completed',
      startedAt: 1,
      userId: 'cloud-alice',
      provider: 'openrouter',
    })).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => store.providerUsage.find('bob_pending_operation'))
      .toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => store.providerUsage.start({
      id: 'alice_usage_on_bob_run',
      operationKey: 'alice_usage_on_bob_run_operation',
      userId: 'cloud-alice',
      provider: 'openrouter',
      requestId: 'alice_usage_on_bob_run_request',
      chatRunId: 'bob_run',
      model: 'model',
      modality: 'text',
      startedAt: 1,
    })).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(store.providerUsage.recoverPending(10)).toBe(1)
    expect(store.providerUsage.listReconcilable(10)).toEqual([])

    const inspection = new Database(cachePath(root, 'cloud-alice'), { readonly: true })
    expect(inspection.prepare(`
      SELECT status FROM provider_usage_events WHERE operation_key = 'bob_pending_operation'
    `).get()).toEqual({ status: 'pending' })
    inspection.close()
    manager.close()
  })

  it('exposes media repositories only through the selected conversation owner', () => {
    const root = temporaryRoot()
    const manager = new UserDataStoreManager(root)
    const store = manager.open('cloud-alice')
    store.conversations.insert({ id: 'alice_media_conversation', title: 'Alice media' })
    store.messages.insert({
      id: 'alice_media_message', conversationId: 'alice_media_conversation', role: 'assistant',
      blocks: [{
        type: 'media_generation', blockId: 'alice_media_block', jobId: 'alice_media_job',
        kind: 'video', status: 'pending',
      }], createdAt: 1,
    })
    store.mediaAssets.insert({
      id: 'alice_media_asset', conversationId: 'alice_media_conversation', source: 'upload',
      kind: 'image', originalName: 'alice.png', status: 'staging', createdAt: 1, updatedAt: 1,
    })
    store.mediaGenerationJobs.insert({
      id: 'alice_media_job', conversationId: 'alice_media_conversation',
      assistantMessageId: 'alice_media_message', provider: 'openrouter', model: 'video-model',
      kind: 'video', providerJobId: 'provider_alice_media_job', status: 'pending',
      parameters: {}, createdAt: 1, updatedAt: 1,
    })

    expect(store.mediaAssets.get('alice_media_asset')?.conversationId)
      .toBe('alice_media_conversation')
    expect(store.mediaGenerationJobs.get('alice_media_job')?.conversationId)
      .toBe('alice_media_conversation')

    const raw = new Database(cachePath(root, 'cloud-alice'))
    raw.prepare(`
      INSERT INTO conversations (
        id, title, title_state, user_id, revision, sync_state,
        created_at, updated_at, last_activity_at, metadata_updated_at
      ) VALUES ('bob_media_conversation', 'Bob media', 'user_named', 'cloud-bob', 1, 'synced', 1, 1, 1, 1)
    `).run()
    raw.prepare(`
      INSERT INTO messages (id, conversation_id, role, blocks_json, ordinal, created_at)
      VALUES ('bob_media_message', 'bob_media_conversation', 'assistant', '[]', 1, 1)
    `).run()
    raw.prepare(`
      INSERT INTO media_assets (
        id, conversation_id, source, kind, original_name, status, created_at, updated_at
      ) VALUES ('bob_media_asset', 'bob_media_conversation', 'upload', 'image', 'bob.png', 'staging', 1, 1)
    `).run()
    raw.prepare(`
      INSERT INTO media_generation_jobs (
        id, conversation_id, assistant_message_id, provider, model, kind, provider_job_id,
        status, parameters_json, created_at, updated_at
      ) VALUES (
        'bob_media_job', 'bob_media_conversation', 'bob_media_message', 'openrouter',
        'video-model', 'video', 'provider_bob_media_job', 'pending', '{}', 1, 1
      )
    `).run()
    raw.close()

    expect(() => store.mediaAssets.get('bob_media_asset'))
      .toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => store.mediaGenerationJobs.get('bob_media_job'))
      .toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    manager.close()
  })

  it('accepts identical remote duplicates and rejects mismatched entity content atomically', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')
    const create = createConversationMutation('remote_duplicate_create', 'duplicate_conversation')
    const append = appendMessageMutation(
      'remote_duplicate_message',
      'duplicate_conversation',
      'duplicate_message',
    )
    store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_duplicate_01',
      mutations: [pulledMutation(create, 1)],
    }, 1)

    store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_duplicate_02',
      mutations: [pulledMutation({ ...create, id: 'remote_duplicate_create_replay' }, 1)],
    }, 2)
    store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_duplicate_03',
      mutations: [pulledMutation(append, 2)],
    }, 3)
    store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_duplicate_04',
      mutations: [pulledMutation({ ...append, id: 'remote_duplicate_message_replay' }, 2)],
    }, 4)
    expect(store.messages.listForConversation('duplicate_conversation')).toHaveLength(1)
    expect(store.sync.getCheckpoint()?.remoteCursor).toBe('cursor_duplicate_04')

    expect(() => store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_duplicate_05',
      mutations: [
        pulledMutation(
          createConversationMutation('rolled_back_before_duplicate', 'rolled_back_duplicate'),
          1,
        ),
        pulledMutation({
          ...create,
          id: 'remote_duplicate_create_mismatch',
          payload: { ...create.payload, title: 'Mismatched title' },
        }, 1),
      ],
    }, 5)).toThrow(expect.objectContaining({ code: 'INTERNAL_ERROR' }))
    expect(store.conversations.get('rolled_back_duplicate')).toBeUndefined()
    expect(store.conversations.get('duplicate_conversation')?.title).toBe(create.payload.title)
    expect(store.sync.getCheckpoint()?.remoteCursor).toBe('cursor_duplicate_04')

    expect(() => store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_duplicate_06',
      mutations: [pulledMutation({
        ...append,
        id: 'remote_duplicate_message_mismatch',
        payload: {
          ...append.payload,
          blocks: [{ type: 'text', text: 'mismatched message' }],
        },
      }, 2)],
    }, 6)).toThrow(expect.objectContaining({ code: 'INTERNAL_ERROR' }))
    expect(store.messages.get('duplicate_message')?.blocks)
      .toEqual([{ type: 'text', text: 'duplicate_message' }])
    expect(store.sync.getCheckpoint()?.remoteCursor).toBe('cursor_duplicate_04')
    manager.close()
  })

  it('rejects invalid conversation enums without partially applying a remote page', () => {
    const root = temporaryRoot()
    const manager = new UserDataStoreManager(root)
    const store = manager.open('cloud-alice')
    const existing = createConversationMutation('strict_existing_create', 'strict_existing')
    store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_strict_initial',
      mutations: [pulledMutation(existing, 1)],
    }, 1)
    const sqlite = new Database(cachePath(root, 'cloud-alice'))
    sqlite.pragma('ignore_check_constraints = ON')
    sqlite.prepare("UPDATE conversations SET sync_state = 'not_a_sync_state' WHERE id = 'strict_existing'")
      .run()
    sqlite.close()

    expect(() => store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_strict_rejected',
      mutations: [
        pulledMutation(
          createConversationMutation('strict_prior_create', 'strict_prior_conversation'),
          1,
        ),
        pulledMutation({ ...existing, id: 'strict_existing_replay' }, 1),
      ],
    }, 2)).toThrow(expect.objectContaining({ code: 'INTERNAL_ERROR' }))
    expect(store.conversations.get('strict_prior_conversation')).toBeUndefined()
    expect(store.sync.getCheckpoint()?.remoteCursor).toBe('cursor_strict_initial')

    expect(() => store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_bad_remote_enum',
      mutations: [
        pulledMutation(
          createConversationMutation('before_bad_enum', 'before_bad_enum_conversation'),
          1,
        ),
        {
          ...pulledMutation(
            createConversationMutation('bad_enum_create', 'bad_enum_conversation'),
            1,
          ),
          payload: {
            ...createConversationMutation('unused', 'bad_enum_conversation').payload,
            titleState: 'not_a_title_state',
          },
        },
      ],
    }, 3)).toThrow(expect.objectContaining({ code: 'INTERNAL_ERROR' }))
    expect(store.conversations.get('before_bad_enum_conversation')).toBeUndefined()
    expect(store.conversations.get('bad_enum_conversation')).toBeUndefined()
    expect(store.sync.getCheckpoint()?.remoteCursor).toBe('cursor_strict_initial')
    manager.close()
  })

  it('acknowledges only a canonically matching local outbox receipt', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')
    const matching = createConversationMutation('receipt_match', 'receipt_conversation')
    store.outbox.recordWithConversation(matching)

    store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_receipt_01',
      mutations: [pulledMutation(matching, 1)],
    }, 1)
    expect(store.outbox.find('receipt_match')).toBeUndefined()
    expect(store.conversations.listPage({ limit: 50 }).items)
      .toContainEqual(expect.objectContaining({
        id: 'receipt_conversation', revision: 1, syncState: 'synced',
      }))

    const collision = createConversationMutation('receipt_collision', 'collision_conversation')
    store.outbox.recordWithConversation(collision)
    expect(() => store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_receipt_02',
      mutations: [pulledMutation({
        ...collision,
        entityId: 'forged_collision_conversation',
        payload: { ...collision.payload, title: 'Forged collision' },
      }, 1)],
    }, 2)).toThrow(expect.objectContaining({ code: 'INTERNAL_ERROR' }))
    expect(store.outbox.find('receipt_collision')).toBeDefined()
    expect(store.sync.getCheckpoint()?.remoteCursor).toBe('cursor_receipt_01')
    manager.close()
  })

  it('acknowledges an immutable create receipt after later message and rename mutations', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')
    const createBeforeMessage = createConversationMutation(
      'create_before_message',
      'conversation_before_message',
    )
    const laterMessage = appendMessageMutation(
      'message_after_create',
      'conversation_before_message',
      'message_after_create_entity',
    )
    store.outbox.recordWithConversation(createBeforeMessage)
    store.outbox.recordWithMessage(laterMessage)

    store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_evolved_001',
      mutations: [pulledMutation(createBeforeMessage, 1)],
    }, 1)

    expect(store.outbox.find('create_before_message')).toBeUndefined()
    expect(store.outbox.find('message_after_create')).toBeDefined()
    expect(store.messages.get('message_after_create_entity')).toBeDefined()
    expect(store.conversations.listPage({ limit: 50 }).items).toContainEqual(
      expect.objectContaining({
        id: 'conversation_before_message',
        revision: 1,
        syncState: 'pending',
        lastActivityAt: laterMessage.payload.createdAt,
      }),
    )

    const createBeforeRename = createConversationMutation(
      'create_before_rename',
      'conversation_before_rename',
    )
    const laterRename = renameConversationMutation(
      'rename_after_create',
      'conversation_before_rename',
      1,
      'Later optimistic title',
    )
    store.outbox.recordWithConversation(createBeforeRename)
    store.outbox.recordWithConversation(laterRename)

    store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_evolved_002',
      mutations: [pulledMutation(createBeforeRename, 1)],
    }, 2)

    expect(store.outbox.find('create_before_rename')).toBeUndefined()
    expect(store.outbox.find('rename_after_create')).toBeDefined()
    expect(store.conversations.listPage({ limit: 50 }).items).toContainEqual(
      expect.objectContaining({
        id: 'conversation_before_rename',
        title: 'Later optimistic title',
        revision: 1,
        syncState: 'pending',
      }),
    )
    manager.close()
  })

  it('preserves a later optimistic rename when acknowledging the earlier rename', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')
    const create = createConversationMutation('rename_chain_create', 'rename_chain_conversation')
    store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_rename_chain_01',
      mutations: [pulledMutation(create, 1)],
    }, 1)
    const first = renameConversationMutation(
      'rename_chain_first', 'rename_chain_conversation', 1, 'First title',
    )
    const second = renameConversationMutation(
      'rename_chain_second', 'rename_chain_conversation', 2, 'Second title',
    )
    store.outbox.recordWithConversation(first)
    store.outbox.recordWithConversation(second)

    store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_rename_chain_02',
      mutations: [pulledMutation(first, 2)],
    }, 2)

    expect(store.outbox.find('rename_chain_first')).toBeUndefined()
    expect(store.outbox.find('rename_chain_second')).toBeDefined()
    expect(store.conversations.listPage({ limit: 50 }).items).toContainEqual(
      expect.objectContaining({
        id: 'rename_chain_conversation',
        title: 'Second title',
        revision: 2,
        syncState: 'pending',
      }),
    )
    manager.close()
  })

  it('enforces monotonic remote conversation revisions and replay identity', () => {
    const root = temporaryRoot()
    const manager = new UserDataStoreManager(root)
    const store = manager.open('cloud-alice')
    const create = createConversationMutation('monotonic_create', 'monotonic_conversation')
    store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_monotonic_01',
      mutations: [pulledMutation(create, 1)],
    }, 1)

    expect(() => store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_monotonic_bad_result',
      mutations: [pulledMutation(
        createConversationMutation('bad_result_create', 'bad_result_conversation'),
        2,
      )],
    }, 2)).toThrow(expect.objectContaining({ code: 'INTERNAL_ERROR' }))
    expect(store.conversations.get('bad_result_conversation')).toBeUndefined()
    expect(store.sync.getCheckpoint()?.remoteCursor).toBe('cursor_monotonic_01')

    const rename = renameConversationMutation(
      'monotonic_rename', 'monotonic_conversation', 1, 'Monotonic title',
    )
    expect(() => store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_monotonic_bad_rename',
      mutations: [pulledMutation(rename, 3)],
    }, 2)).toThrow(expect.objectContaining({ code: 'INTERNAL_ERROR' }))
    expect(store.sync.getCheckpoint()?.remoteCursor).toBe('cursor_monotonic_01')
    store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_monotonic_02',
      mutations: [pulledMutation(rename, 2)],
    }, 2)
    store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_monotonic_03',
      mutations: [pulledMutation({ ...rename, id: 'monotonic_rename_replay' }, 2)],
    }, 3)

    expect(() => store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_monotonic_04',
      mutations: [pulledMutation({
        ...rename,
        id: 'monotonic_rename_stale_mismatch',
        payload: { ...rename.payload, title: 'Stale overwrite' },
      }, 2)],
    }, 4)).toThrow(expect.objectContaining({ code: 'INTERNAL_ERROR' }))
    expect(store.sync.getCheckpoint()?.remoteCursor).toBe('cursor_monotonic_03')

    const deletion: SyncMutation = {
      id: 'monotonic_delete',
      kind: 'conversation.delete',
      entityId: 'monotonic_conversation',
      baseRevision: 2,
      occurredAt: '2026-08-24T00:03:00.000Z',
      payload: {},
    }
    store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_monotonic_05',
      mutations: [pulledMutation(deletion, 3)],
    }, 5)
    store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_monotonic_06',
      mutations: [pulledMutation({ ...deletion, id: 'monotonic_delete_replay' }, 3)],
    }, 6)

    const restoration: SyncMutation = {
      id: 'monotonic_restore',
      kind: 'conversation.restore',
      entityId: 'monotonic_conversation',
      baseRevision: 3,
      occurredAt: '2026-08-24T00:04:00.000Z',
      payload: {},
    }
    store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_monotonic_07',
      mutations: [pulledMutation(restoration, 4)],
    }, 7)
    store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_monotonic_08',
      mutations: [pulledMutation({ ...restoration, id: 'monotonic_restore_replay' }, 4)],
    }, 8)

    expect(() => store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_monotonic_09',
      mutations: [pulledMutation({ ...deletion, id: 'monotonic_delete_stale' }, 3)],
    }, 9)).toThrow(expect.objectContaining({ code: 'INTERNAL_ERROR' }))
    expect(store.sync.getCheckpoint()?.remoteCursor).toBe('cursor_monotonic_08')
    expect(store.conversations.listPage({ limit: 50 }).items).toContainEqual(
      expect.objectContaining({
        id: 'monotonic_conversation', title: 'Monotonic title', revision: 4,
      }),
    )

    const inspection = new Database(cachePath(root, 'cloud-alice'), { readonly: true })
    expect(inspection.prepare(`
      SELECT revision, deleted_at AS deletedAt
      FROM conversations WHERE id = 'monotonic_conversation'
    `).get()).toEqual({ revision: 4, deletedAt: null })
    inspection.close()
    manager.close()
  })

  it('validates persisted and newly assigned outbox error codes', () => {
    const root = temporaryRoot()
    const manager = new UserDataStoreManager(root)
    const store = manager.open('cloud-alice')
    store.outbox.record(createConversationMutation('error_code_mutation', 'error_code_conversation'))

    expect(() => store.outbox.markFailed(
      'error_code_mutation',
      'NOT_A_SAFE_ERROR' as never,
    )).toThrow(expect.objectContaining({ code: 'INTERNAL_ERROR' }))
    expect(store.outbox.find('error_code_mutation')).toMatchObject({ state: 'pending' })
    manager.close()

    const raw = new Database(cachePath(root, 'cloud-alice'))
    raw.prepare(`
      UPDATE outbox_mutations SET last_error_code = 'NOT_A_SAFE_ERROR'
      WHERE id = 'error_code_mutation'
    `).run()
    raw.close()
    const reopened = manager.open('cloud-alice')
    expect(() => reopened.outbox.find('error_code_mutation'))
      .toThrow(expect.objectContaining({ code: 'INTERNAL_ERROR' }))
    manager.close()
  })

  it('rejects remote mutation of a cross-owner row without advancing the checkpoint', () => {
    const root = temporaryRoot()
    const manager = new UserDataStoreManager(root)
    const store = manager.open('cloud-alice')
    store.sync.updateCheckpoint({ protocolVersion: 1, remoteCursor: 'cursor_0000000001', updatedAt: 1 })
    const raw = new Database(cachePath(root, 'cloud-alice'))
    raw.prepare(`
      INSERT INTO conversations (
        id, title, title_state, user_id, revision, sync_state,
        created_at, updated_at, last_activity_at, metadata_updated_at
      ) VALUES ('bob_remote', 'Bob', 'user_named', 'cloud-bob', 1, 'synced', 1, 1, 1, 1)
    `).run()
    raw.close()

    expect(() => store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_0000000002',
      mutations: [pulledMutation({
        id: 'bob_remote_rename',
        kind: 'conversation.rename',
        entityId: 'bob_remote',
        baseRevision: 1,
        occurredAt: '2026-08-24T00:01:00.000Z',
        payload: {
          title: 'Stolen',
          titleState: 'user_named',
          metadataUpdatedAt: '2026-08-24T00:01:00.000Z',
        },
      }, 2)],
    }, 2)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(store.sync.getCheckpoint()?.remoteCursor).toBe('cursor_0000000001')

    const inspection = new Database(cachePath(root, 'cloud-alice'), { readonly: true })
    expect(inspection.prepare("SELECT title FROM conversations WHERE id = 'bob_remote'").get())
      .toEqual({ title: 'Bob' })
    inspection.close()
    manager.close()
  })

  it('applies a missing numbered migration even when the migration table already exists', () => {
    const root = temporaryRoot()
    const path = cachePath(root, 'cloud-alice')
    const sqlite = new Database(path)
    sqlite.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)')
    sqlite.close()

    const manager = new UserDataStoreManager(root)
    manager.open('cloud-alice')
    manager.close()
    const inspection = new Database(path, { readonly: true })
    expect(inspection.prepare('SELECT version FROM schema_migrations ORDER BY version').all())
      .toEqual([{ version: 1 }, { version: 2 }, { version: 3 }])
    expect(inspection.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'outbox_mutations'").get())
      .toBeDefined()
    expect(inspection.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_receipt_evidence'").get())
      .toBeDefined()
    inspection.close()
  })

  it('enforces the pending outbox cap before optimistic conversation state commits', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')
    const acknowledged: SyncMutation = {
      id: 'acknowledged_cap_evidence',
      kind: 'privacy.consent',
      entityId: 'privacy-2026-08',
      baseRevision: 0,
      occurredAt: '2026-08-24T00:00:00.000Z',
      payload: {
        purpose: 'cloud_sync',
        documentVersion: 'privacy-2026-08',
        consentedAt: '2026-08-24T00:00:00.000Z',
        clientVersion: '2.0.0',
      },
    }
    store.outbox.record(acknowledged)
    store.outbox.markSyncing([acknowledged.id])
    store.outbox.acknowledgePushResults(
      [acknowledged],
      [{ id: acknowledged.id, status: 'duplicate', revision: 0 }],
    )
    for (let index = 0; index < 10_000; index += 1) {
      store.outbox.record(deleteConversationMutation(index))
    }

    expect(() => store.outbox.recordWithConversation(
      createConversationMutation('mutation_over_limit', 'conversation_over_limit'),
    )).toThrow(expect.objectContaining({ code: 'OUTBOX_LIMIT_EXCEEDED' }))
    expect(store.conversations.get('conversation_over_limit')).toBeUndefined()
    expect(store.outbox.countPending()).toBe(10_000)
    manager.close()
  })

  it('deletes only the exact validated database and SQLite sidecars', () => {
    const root = temporaryRoot()
    const manager = new UserDataStoreManager(root)
    manager.open('cloud-alice')
    const databaseName = readdirSync(root).find((name) => name.endsWith('.sqlite'))
    expect(databaseName).toBeDefined()
    const databasePath = join(root, databaseName!)
    const preserved = join(root, `${databaseName}.backup`)
    const uidDecoy = join(root, 'cloud-alice.sqlite')
    manager.close()
    writeFileSync(`${databasePath}-wal`, '')
    writeFileSync(`${databasePath}-shm`, '')
    writeFileSync(`${databasePath}-journal`, '')
    writeFileSync(preserved, 'keep')
    writeFileSync(uidDecoy, 'keep')

    manager.closeAndDelete('cloud-alice')

    expect(existsSync(databasePath)).toBe(false)
    expect(existsSync(`${databasePath}-wal`)).toBe(false)
    expect(existsSync(`${databasePath}-shm`)).toBe(false)
    expect(existsSync(`${databasePath}-journal`)).toBe(false)
    expect(existsSync(preserved)).toBe(true)
    expect(existsSync(uidDecoy)).toBe(true)
    expect(basename(databasePath)).toMatch(/^[0-9a-f]{32}\.sqlite$/)
  })
})

describe('global legacy conversation storage', () => {
  it('does not auto-claim or clear legacy conversation rows from production paths', () => {
    const root = temporaryRoot()
    const path = join(root, 'autoforge.sqlite')
    openAppDatabase(path).close()
    const seed = new Database(path)
    seed.prepare(`
      INSERT INTO conversations (id, title, created_at, updated_at)
      VALUES ('legacy_unowned', 'Legacy', 1, 1)
    `).run()
    seed.close()
    const database = openAppDatabase(path)

    expect(() => database.conversations.claimLegacyAndListForUser('cloud-alice'))
      .toThrow(expect.objectContaining({ code: 'CONFLICT' }))
    expect(database.conversations.get('legacy_unowned')?.userId).toBeUndefined()

    expect(() => database.clearConversations()).toThrow(expect.objectContaining({ code: 'CONFLICT' }))
    expect(() => database.clearLocalData('conversations'))
      .toThrow(expect.objectContaining({ code: 'CONFLICT' }))
    expect(() => database.clearLocalData('all')).toThrow(expect.objectContaining({ code: 'CONFLICT' }))
    expect(database.conversations.get('legacy_unowned')).toMatchObject({ id: 'legacy_unowned' })
    database.close()
  })
})
