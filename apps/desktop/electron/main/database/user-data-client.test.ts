import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { PulledMutation, SyncMutation, SyncMutationResult } from '@autoforge/shared'
import { openAppDatabase } from './client.js'
import { UserDataStoreManager, type UserDataStore } from './user-data-client.js'
import { serializeHistoricalMessage } from '../chat/conversation-context.js'

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

function appendConversionMessageMutation(
  id: string,
  conversationId: string,
  messageId: string,
  state: 'active' | 'terminal' = 'active',
): Extract<SyncMutation, { kind: 'message.append' }> {
  const mutation = appendMessageMutation(id, conversationId, messageId)
  return {
    ...mutation,
    payload: {
      ...mutation.payload,
      role: 'assistant',
      executionId: 'conversion_execution',
      blocks: [{
        type: 'conversion',
        blockId: 'conversion_block',
        executionId: 'conversion_execution',
        state,
      }],
    },
  }
}

function conversionTerminalMutation(
  id: string,
  messageId: string,
  baseRevision: number,
): Extract<SyncMutation, { kind: 'message.conversion_block_terminal' }> {
  return {
    id,
    kind: 'message.conversion_block_terminal',
    entityId: messageId,
    baseRevision,
    occurredAt: '2026-08-24T00:02:00.000Z',
    payload: { messageId, blockId: 'conversion_block', executionId: 'conversion_execution', state: 'terminal' },
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

const generationPreferences = {
  outputType: 'image' as const,
  models: { image: 'openrouter/image-model' },
  generation: {
    image: { count: 1 as const, resolution: '1K', aspectRatio: 'auto', format: 'png' },
    audio: { format: 'mp3' },
    video: { durationSeconds: 5, resolution: '720p', aspectRatio: 'auto', generateAudio: false },
  },
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

function createLocalTerminalOutbox(
  store: UserDataStore,
  prefix: string,
): {
  conversationId: string
  messageId: string
  mutation: Extract<SyncMutation, { kind: 'message.conversion_block_terminal' }>
} {
  const conversationId = `${prefix}_conversation`
  const messageId = `${prefix}_message`
  const create = createConversationMutation(`${prefix}_create`, conversationId)
  const append = appendConversionMessageMutation(`${prefix}_append`, conversationId, messageId)
  store.sync.applyRemotePage({
    protocolVersion: 1,
    cursor: `${prefix}_create_cursor`,
    mutations: [pulledMutation(create, 1)],
  }, 1)
  store.sync.applyRemotePage({
    protocolVersion: 1,
    cursor: `${prefix}_append_cursor`,
    mutations: [pulledMutation(append, 2)],
  }, 2)
  store.messages.replaceBlock(messageId, 'conversion_block', {
    type: 'conversion',
    blockId: 'conversion_block',
    executionId: 'conversion_execution',
    state: 'terminal',
  })
  const mutation = store.outbox.list(10).find((candidate) => (
    candidate.kind === 'message.conversion_block_terminal'
  ))
  if (!mutation || mutation.kind !== 'message.conversion_block_terminal') {
    throw new Error('Missing local conversion terminal mutation')
  }
  return {
    conversationId,
    messageId,
    mutation: {
      id: mutation.id,
      kind: mutation.kind,
      entityId: mutation.entityId,
      baseRevision: mutation.baseRevision,
      payload: mutation.payload,
      occurredAt: mutation.occurredAt,
    },
  }
}

function compactedMutation(
  mutation: SyncMutation,
  resultRevision: number,
): PulledMutation {
  return {
    id: mutation.id,
    kind: mutation.kind as 'conversation.create',
    entityId: mutation.entityId,
    baseRevision: mutation.baseRevision,
    resultRevision,
    compacted: true,
    receivedAt: '2026-10-24T01:00:00.000Z',
    ...(mutation.kind === 'message.append'
      ? { kind: mutation.kind, conversationId: mutation.payload.conversationId }
      : {}),
  } as PulledMutation
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
  it('atomically replays offline generation preferences and converges a second device', () => {
    const root = temporaryRoot()
    const manager = new UserDataStoreManager(root)
    const store = manager.open('cloud-alice')
    const conversationId = 'preferences_conversation'
    const create = createConversationMutation('preferences_create', conversationId)
    store.outbox.recordWithConversation(create)

    expect(store.conversations.updateGenerationPreferences(conversationId, generationPreferences))
      .toMatchObject({ generationPreferences })
    expect(projectedConversation(store, conversationId)).toMatchObject({ revision: 2, syncState: 'pending' })
    const preferenceMutation = store.outbox.list(10).find(
      (mutation) => mutation.kind === 'conversation.preferences',
    )
    expect(preferenceMutation).toMatchObject({
      entityId: conversationId,
      baseRevision: 1,
      payload: { preferences: generationPreferences },
    })
    manager.close()

    const reopened = manager.open('cloud-alice')
    expect(reopened.conversations.get(conversationId)).toMatchObject({ generationPreferences })
    expect(reopened.outbox.list(10).map(({ kind }) => kind))
      .toEqual(['conversation.create', 'conversation.preferences'])
    if (preferenceMutation?.kind !== 'conversation.preferences') {
      throw new Error('Missing conversation preference mutation')
    }
    const preferenceReceipt = {
      id: preferenceMutation.id,
      kind: preferenceMutation.kind,
      entityId: preferenceMutation.entityId,
      baseRevision: preferenceMutation.baseRevision,
      payload: preferenceMutation.payload,
      resultRevision: 2,
      receivedAt: '2026-08-24T01:00:00.000Z',
    }
    reopened.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_preferences_replay_1',
      mutations: [pulledMutation(create, 1), preferenceReceipt],
    }, Date.now())
    expect(reopened.outbox.list(10)).toEqual([])
    expect(projectedConversation(reopened, conversationId))
      .toMatchObject({ revision: 2, syncState: 'synced' })
    expect(reopened.conversations.get(conversationId)).toMatchObject({ generationPreferences })
    manager.close()

    const remoteManager = new UserDataStoreManager(temporaryRoot())
    const remote = remoteManager.open('cloud-alice')
    remote.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_preferences_remote_1',
      mutations: [pulledMutation(create, 1), preferenceReceipt],
    }, Date.now())
    expect(remote.conversations.get(conversationId)).toMatchObject({ generationPreferences })
    expect(projectedConversation(remote, conversationId)).toMatchObject({ revision: 2, syncState: 'synced' })
    remoteManager.close()
  })

  it('advances optimistic conversation revisions for dependent offline mutations', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')
    const conversationId = 'dependent_offline_conversation'

    store.outbox.recordWithConversation(
      createConversationMutation('dependent_create', conversationId),
    )
    expect(projectedConversation(store, conversationId)?.revision).toBe(1)

    store.outbox.recordWithConversation(
      renameConversationMutation('dependent_rename', conversationId, 1, 'Offline title'),
    )
    expect(projectedConversation(store, conversationId)?.revision).toBe(2)

    const first = appendMessageMutation('dependent_message_1', conversationId, 'offline_message_1')
    store.outbox.recordWithMessage({ ...first, baseRevision: 2 })
    expect(projectedConversation(store, conversationId)?.revision).toBe(3)

    const second = appendMessageMutation('dependent_message_2', conversationId, 'offline_message_2')
    store.outbox.recordWithMessage({ ...second, baseRevision: 3 })
    expect(projectedConversation(store, conversationId)?.revision).toBe(4)
    expect(store.outbox.list(10).map(({ baseRevision }) => baseRevision)).toEqual([0, 1, 2, 3])
    manager.close()
  })

  it('advances revision through real assistant finalization before the next offline user turn', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')
    const conversationId = 'offline_text_conversation'
    store.outbox.recordWithConversation(createConversationMutation('offline_text_create', conversationId))
    const firstUser = appendMessageMutation(
      'offline_text_user_mutation_1', conversationId, 'offline_text_user_1',
    )
    store.outbox.recordWithMessage(firstUser)
    store.messages.insert({
      id: 'offline_text_assistant_1', conversationId, role: 'assistant', blocks: [], createdAt: 2_000,
    })
    store.chatRuns.insert({
      id: 'offline_text_run_1', conversationId, requestId: 'offline_text_request_1',
      userId: 'cloud-alice', provider: 'openrouter', model: 'text-model',
      status: 'running', startedAt: 2_000,
    })

    store.chatRuns.finalizeWithMessage(
      'offline_text_run_1',
      'offline_text_assistant_1',
      'offline_text_request_1',
      { blocks: [{ type: 'text', text: 'assistant reply' }], status: 'completed', endedAt: 2_100 },
    )
    const secondUser = {
      ...appendMessageMutation(
        'offline_text_user_mutation_2', conversationId, 'offline_text_user_2',
      ),
      baseRevision: projectedConversation(store, conversationId)!.revision,
    }
    store.outbox.recordWithMessage(secondUser)

    expect(store.outbox.list(10).map(({ entityId, baseRevision }) => ({ entityId, baseRevision })))
      .toEqual([
        { entityId: conversationId, baseRevision: 0 },
        { entityId: 'offline_text_user_1', baseRevision: 1 },
        { entityId: 'offline_text_assistant_1', baseRevision: 2 },
        { entityId: 'offline_text_user_2', baseRevision: 3 },
      ])
    expect(projectedConversation(store, conversationId)?.revision).toBe(4)
    manager.close()
  })

  it('replays direct media generation and its later queued mutation without a revision gap', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const local = manager.open('cloud-alice')
    const conversationId = 'direct_media_conversation'
    local.outbox.recordWithConversation(
      createConversationMutation('direct_media_create', conversationId),
    )
    local.chatRuns.startMediaGeneration({
      userMessage: {
        id: 'direct_media_user', conversationId, role: 'user',
        blocks: [{ type: 'text', text: 'generate an image' }], createdAt: 2_000,
      },
      userAssetIds: [],
      assistantMessage: {
        id: 'direct_media_assistant', conversationId, role: 'assistant',
        blocks: [{
          type: 'media_generation', blockId: 'direct_media_block',
          jobId: 'direct_media_request', kind: 'image', status: 'in_progress',
        }],
        createdAt: 2_001,
      },
      run: {
        id: 'direct_media_run', conversationId, requestId: 'direct_media_request',
        userId: 'cloud-alice', provider: 'openrouter', model: 'image-model',
        status: 'running', startedAt: 2_000,
      },
    })
    const later = {
      ...appendMessageMutation('direct_media_later_mutation', conversationId, 'direct_media_later'),
      baseRevision: projectedConversation(local, conversationId)!.revision,
    }
    local.outbox.recordWithMessage(later)

    const queued = local.outbox.list(10)
    expect(queued.map(({ baseRevision }) => baseRevision)).toEqual([0, 1, 2])
    expect(projectedConversation(local, conversationId)?.revision).toBe(3)

    const remote = manager.open('cloud-bob')
    remote.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_direct_media',
      mutations: queued.map((mutation, index) => pulledMutation({
        id: mutation.id,
        kind: mutation.kind,
        entityId: mutation.entityId,
        baseRevision: mutation.baseRevision,
        payload: mutation.payload,
        occurredAt: mutation.occurredAt,
      } as SyncMutation, index + 1)),
    }, 1)
    expect(projectedConversation(remote, conversationId)).toMatchObject({ revision: 3 })
    expect(remote.messages.listPage({ conversationId, limit: 100 }).items.map(({ id }) => id))
      .toEqual(['direct_media_user', 'direct_media_later'])
    manager.close()
  })

  it.each(['failed', 'completed'] as const)(
    'advances revision through the real %s media terminal path',
    (outcome) => {
      const manager = new UserDataStoreManager(temporaryRoot())
      const store = manager.open('cloud-alice')
      const video = startVideoIntent(store, `revision_${outcome}`)
      expect(projectedConversation(store, video.conversationId)?.revision).toBe(1)
      if (outcome === 'failed') {
        store.mediaGenerationJobs.fail(
          video.requestId,
          ['pending'],
          'MEDIA_GENERATION_FAILED',
          2_000,
        )
      } else {
        store.mediaGenerationJobs.bindSubmitted(video.requestId, {
          providerJobId: `provider_${outcome}`,
          status: 'in_progress',
          parameters: { version: 1, options: {} },
          nextPollAt: 1_500,
          updatedAt: 1_100,
        })
        store.mediaGenerationJobs.transition(video.requestId, ['in_progress'], {
          status: 'downloading', nextPollAt: null, updatedAt: 1_500,
        })
        store.mediaAssets.insert({
          id: `asset_${outcome}`,
          conversationId: video.conversationId,
          source: 'generated',
          kind: 'video',
          mimeType: 'video/mp4',
          originalName: `${outcome}.mp4`,
          relativePath: `${video.conversationId}/${outcome}.mp4`,
          byteSize: 24,
          sha256: 'a'.repeat(64),
          provider: 'openrouter',
          model: 'video-model',
          status: 'ready',
          createdAt: 1_500,
          updatedAt: 1_500,
        })
        store.mediaGenerationJobs.complete(video.requestId, ['downloading'], {
          assetId: `asset_${outcome}`,
          block: {
            type: 'media', blockId: `video_block_revision_${outcome}`,
            assetId: `asset_${outcome}`, kind: 'video', purpose: 'output',
            name: `${outcome}.mp4`, mimeType: 'video/mp4', byteSize: 24,
          },
          endedAt: 2_000,
        })
      }

      expect(store.outbox.list(10).map(({ baseRevision }) => baseRevision)).toEqual([0, 1])
      expect(projectedConversation(store, video.conversationId)?.revision).toBe(2)
      manager.close()
    },
  )

  it('persists only a validated structured local projection across remote message apply', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const local = manager.open('projection-local')
    const conversationId = 'projection_remote_conversation'
    const create = createConversationMutation('projection_remote_create', conversationId)
    local.outbox.recordWithConversation(create)
    const append = {
      ...appendMessageMutation('projection_remote_append', conversationId, 'projection_remote_message'),
      payload: {
        ...appendMessageMutation(
          'projection_remote_append', conversationId, 'projection_remote_message',
        ).payload,
        blocks: [
          { type: 'text' as const, text: 'Convert /Users/Alice/secret.pdf to PDF' },
          {
            type: 'media' as const, blockId: 'projection_remote_block',
            assetId: 'projection_remote_asset', kind: 'file' as const, purpose: 'input' as const,
            name: 'secret.pdf', mimeType: 'application/pdf', byteSize: 1,
          },
          {
            type: 'media' as const, blockId: 'projection_remote_block_2',
            assetId: 'projection_remote_asset_2', kind: 'image' as const, purpose: 'input' as const,
            name: 'photo.png', mimeType: 'image/png', byteSize: 2,
          },
        ],
        providerProjection: {
          version: 2 as const,
          kind: 'local_conversion' as const,
          targetFormat: 'pdf' as const,
          attachmentCount: 2,
          selectedAttachmentIndexes: [0],
        },
      },
    }
    local.outbox.recordWithMessage(append)
    expect(local.outbox.find(append.id)?.payload).toMatchObject({
      providerProjection: {
        version: 2, kind: 'local_conversion', targetFormat: 'pdf', attachmentCount: 2,
        selectedAttachmentIndexes: [0],
      },
    })

    const remote = manager.open('projection-remote')
    remote.sync.applyRemotePage({
      protocolVersion: 3,
      cursor: 'projection_remote_cursor',
      mutations: [pulledMutation(create, 1), pulledMutation(append, 2)],
    }, 1)
    expect(remote.messages.get(append.payload.id)?.providerProjection).toEqual({
      version: 2, kind: 'local_conversion', targetFormat: 'pdf', attachmentCount: 2,
      selectedAttachmentIndexes: [0],
    })
    expect(serializeHistoricalMessage(remote.messages.get(append.payload.id)!)).toEqual({
      role: 'user',
      content: expect.stringContaining('附件索引：0'),
    })
    expect(serializeHistoricalMessage(remote.messages.get(append.payload.id)!)).toEqual({
      role: 'user',
      content: expect.stringContaining('附件数量：1'),
    })

    const malformed = pulledMutation({
      ...append,
      id: 'projection_spoof_append',
      entityId: 'projection_spoof_message',
      baseRevision: 2,
      payload: {
        ...append.payload,
        id: 'projection_spoof_message',
        providerProjection: {
          version: 2, kind: 'local_conversion', targetFormat: 'pdf', attachmentCount: 2,
          selectedAttachmentIndexes: [1],
        },
      },
    } as unknown as Extract<SyncMutation, { kind: 'message.append' }>, 3)
    remote.sync.applyRemotePage({
      protocolVersion: 3, cursor: 'projection_spoof_cursor', mutations: [malformed],
    }, 2)
    expect(remote.messages.get('projection_spoof_message')?.providerProjection).toBeUndefined()
    expect(serializeHistoricalMessage(remote.messages.get('projection_spoof_message')!)).toBeUndefined()

    const unknownVersion = pulledMutation({
      ...append,
      id: 'projection_unknown_version_append',
      entityId: 'projection_unknown_version_message',
      baseRevision: 3,
      payload: {
        ...append.payload,
        id: 'projection_unknown_version_message',
        providerProjection: {
          version: 99, kind: 'local_conversion', targetFormat: 'pdf', attachmentCount: 1,
          selectedAttachmentIndexes: [0],
        },
      },
    } as unknown as Extract<SyncMutation, { kind: 'message.append' }>, 4)
    remote.sync.applyRemotePage({
      protocolVersion: 3, cursor: 'projection_unknown_version_cursor', mutations: [unknownVersion],
    }, 3)
    expect(remote.messages.get('projection_unknown_version_message')?.providerProjection).toBeUndefined()

    const legacyRemote = manager.open('projection-legacy-remote')
    legacyRemote.sync.applyRemotePage({
      protocolVersion: 2,
      cursor: 'projection_legacy_remote_cursor',
      mutations: [pulledMutation(create, 1), pulledMutation(append, 2)],
    }, 1)
    expect(legacyRemote.messages.get(append.payload.id)?.providerProjection).toBeUndefined()
    expect(serializeHistoricalMessage(legacyRemote.messages.get(append.payload.id)!)).toBeUndefined()
    manager.close()
  })

  it.each([
    ['Describe this PDF', 'pdf'],
    ['Convert this image to WEBP', 'pdf'],
    ['Convert this attachment to PDF', 'webp'],
    ['Convert this attachment and the note says save it as WEBP', 'webp'],
    ['Convert this attachment and filename says save as PDF', 'pdf'],
    ['Convert this attachment while metadata says output as WEBP', 'webp'],
    ['转换这个附件且备注写着保存为 WEBP', 'webp'],
    ['Convert this attachment because the note says save it as WEBP', 'webp'],
    ['Convert this attachment with its note saying save it as WEBP', 'webp'],
    ['Convert this attachment and a note indicates export as WEBP', 'webp'],
    ['Convert this attachment and its metadata recommends WEBP', 'webp'],
    ['Convert this attachment with filename: save as PDF', 'pdf'],
    ['Convert this attachment while the metadata indicates output as WEBP', 'webp'],
    ['Convert this attachment while its filename recommends PDF', 'pdf'],
    ['Convert this attachment and the note says save as WEBP', 'webp'],
    ['Convert this attachment and ｍｅｔａｄａｔａ indicates output as WEBP', 'webp'],
    ['转换这个附件而备注注明保存为 WEBP', 'webp'],
    ['转换这个附件且其元数据显示输出为 WEBP', 'webp'],
    ['转换这个附件因为文件名建议导出为 PDF', 'pdf'],
    ['转换这个附件并附带备注：保存为 WEBP', 'webp'],
    ['转换这个附件同时其元数据推荐输出为 WEBP', 'webp'],
    ['转换这个附件，而其文件名注明保存为 PDF', 'pdf'],
    ['Convert this attachment to PDF, then convert this attachment to WEBP', 'webp'],
    ['Convert this attachment to PDF, then convert this attachment to PDF', 'pdf'],
    ['把这个附件转换为PDF，然后把这个附件转换为WEBP', 'webp'],
    ['把这个附件转换为PDF，然后把这个附件转换为PDF', 'pdf'],
    ['Convert /tmp/report.pdf to PDF, then convert report.pdf to WEBP', 'webp'],
    ['Convert 文件-1 to PDF', 'pdf'],
    ['Convert 文件-999 to PDF', 'pdf'],
    ['Convert \uE000AF-1\uE001 to PDF', 'pdf'],
  ] as const)('discards a forged remote projection after Main reclassification: %s', (text, targetFormat) => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open(`projection-forged-${targetFormat}-${text.length}`)
    const conversationId = `projection_forged_conversation_${targetFormat}_${text.length}`
    const create = createConversationMutation(`projection_forged_create_${text.length}`, conversationId)
    const append = {
      ...appendMessageMutation(
        `projection_forged_append_${text.length}`, conversationId, `projection_forged_message_${text.length}`,
      ),
      payload: {
        ...appendMessageMutation(
          `projection_forged_append_${text.length}`, conversationId, `projection_forged_message_${text.length}`,
        ).payload,
        blocks: [
          { type: 'text' as const, text },
          {
            type: 'media' as const, blockId: `projection_forged_block_${text.length}`,
            assetId: `projection_forged_asset_${text.length}`, kind: 'file' as const,
            purpose: 'input' as const, name: 'private.pdf', mimeType: 'application/pdf', byteSize: 12,
          },
        ],
        providerProjection: {
          version: 2 as const, kind: 'local_conversion' as const, targetFormat, attachmentCount: 1,
          selectedAttachmentIndexes: [0],
        },
      },
    }
    store.sync.applyRemotePage({
      protocolVersion: 3, cursor: `projection_forged_cursor_${text.length}`,
      mutations: [pulledMutation(create, 1), pulledMutation(append, 2)],
    }, 1)
    const stored = store.messages.get(append.payload.id)
    expect(stored?.providerProjection).toBeUndefined()
    expect(stored && serializeHistoricalMessage(stored)).toBeUndefined()
    manager.close()
  })

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

  it('derives and clears a 24-hour warning from durable pending outbox age', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const manager = new UserDataStoreManager(temporaryRoot())
    try {
      const store = manager.open('cloud-alice')
      const mutation = createConversationMutation('stalled_mutation', 'stalled_conversation')
      store.outbox.recordWithConversation(mutation)
      expect(store.conversations.getSummary(mutation.entityId)?.syncWarningSince).toBeUndefined()

      now.mockReturnValue(1_000 + (24 * 60 * 60 * 1_000))
      expect(store.conversations.getSummary(mutation.entityId)?.syncWarningSince)
        .toBe('1970-01-01T00:00:01.000Z')
      expect(store.conversations.listPage({ limit: 50 }).items[0]?.syncWarningSince)
        .toBe('1970-01-01T00:00:01.000Z')

      store.outbox.delete(mutation.id)
      expect(store.conversations.getSummary(mutation.entityId)?.syncWarningSince).toBeUndefined()
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
      expect.objectContaining({ id: create.entityId, revision: 3, syncState: 'failed' }),
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

  it('makes pending backoff and failed non-conversation work immediately retryable', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')
    const pending = createConversationMutation('retry_pending_backoff', 'retry_pending_conversation')
    const failed: SyncMutation = {
      id: 'retry_failed_usage',
      kind: 'usage.record',
      entityId: 'retry_failed_usage',
      baseRevision: 0,
      occurredAt: '2026-08-24T00:00:00.000Z',
      payload: {
        id: 'retry_failed_usage', operationId: 'retry_failed_operation',
        purpose: 'assistant_reply', credentialOwner: 'user', billable: false,
        provider: 'openrouter', model: 'test-model', modality: 'text',
        costStatus: 'unavailable', occurredAt: '2026-08-24T00:00:00.000Z',
      },
    }
    store.outbox.recordWithConversation(pending)
    store.outbox.markPending(pending.id, 9_999_999)
    store.outbox.record(failed)
    store.outbox.markFailed(failed.id, 'SERVICE_UNAVAILABLE', 9_999_999)

    expect(store.outbox.retryFailed()).toEqual([pending.id, failed.id])
    expect(store.outbox.listReady(1, 10).map(({ id }) => id)).toEqual([pending.id, failed.id])
    manager.close()
  })

  it('acknowledges applied and duplicate push results into durable receipt evidence', () => {
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

    expect(store.outbox.find(first.id)).toBeUndefined()
    expect(store.outbox.find(second.id)).toBeUndefined()
    expect(store.conversations.listPage({ limit: 50 }).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.entityId, revision: 1, syncState: 'synced' }),
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
      title: 'Later local title', revision: 3, syncState: 'pending',
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
      title: 'Later local title', revision: 3, syncState: 'pending',
    })
    expect(reopened.outbox.find(later.id)).toBeDefined()
    manager.close()
    const consumed = new Database(cachePath(root, 'cloud-alice'), { readonly: true })
    expect(consumed.prepare('SELECT COUNT(*) AS count FROM sync_receipt_evidence').get())
      .toEqual({ count: 0 })
    consumed.close()
  })

  it('consumes original duplicate evidence from a payload-free compacted receipt', () => {
    const root = temporaryRoot()
    const manager = new UserDataStoreManager(root)
    const store = manager.open('cloud-alice')
    const create = createConversationMutation('compacted_evidence_create', 'compacted_evidence')
    store.outbox.recordWithConversation(create)
    store.outbox.markSyncing([create.id])
    store.outbox.acknowledgePushResults(
      [create], [{ id: create.id, status: 'duplicate', revision: 1 }],
    )

    expect(() => store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'cursor_compacted_evidence',
      mutations: [compactedMutation(create, 1)],
    }, 1)).not.toThrow()
    expect(store.sync.getCheckpoint()?.remoteCursor).toBe('cursor_compacted_evidence')
    expect(projectedConversation(store, create.entityId)).toMatchObject({
      title: create.payload.title, revision: 1, syncState: 'synced',
    })
    manager.close()

    const inspection = new Database(cachePath(root, 'cloud-alice'), { readonly: true })
    expect(inspection.prepare('SELECT COUNT(*) AS count FROM sync_receipt_evidence').get())
      .toEqual({ count: 0 })
    inspection.close()
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

  it('keeps a v1 conversation writable across the terminal compatibility revision anchor', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')
    const conversationId = 'v1_terminal_anchor_conversation'
    const create = createConversationMutation('v1_terminal_anchor_create', conversationId)
    const append = {
      ...appendMessageMutation(
        'v1_terminal_anchor_append',
        conversationId,
        'v1_terminal_anchor_message',
      ),
      payload: {
        ...appendMessageMutation(
          'v1_terminal_anchor_append',
          conversationId,
          'v1_terminal_anchor_message',
        ).payload,
        role: 'assistant' as const,
        blocks: [{ type: 'text' as const, text: '转换已提交' }],
      },
    }
    const rename = renameConversationMutation(
      'v1_terminal_anchor_remote_rename',
      conversationId,
      3,
      'Remote after terminal',
    )

    store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'v1_terminal_anchor_cursor',
      mutations: [
        pulledMutation(create, 1),
        pulledMutation(append, 2),
        {
          id: 'v1_terminal_anchor_compatibility',
          kind: 'conversation.preferences',
          entityId: conversationId,
          baseRevision: 2,
          resultRevision: 3,
          compacted: true,
          receivedAt: '2026-08-24T01:00:00.000Z',
        },
        pulledMutation(rename, 4),
      ],
    }, 1)

    expect(projectedConversation(store, conversationId)).toMatchObject({
      revision: 4,
      title: 'Remote after terminal',
      syncState: 'synced',
    })
    const localRename = renameConversationMutation(
      'v1_terminal_anchor_local_rename',
      conversationId,
      4,
      'Local after terminal',
    )
    store.outbox.recordWithConversation(localRename)
    expect(store.outbox.find(localRename.id)).toMatchObject({ baseRevision: 4, state: 'pending' })
    expect(projectedConversation(store, conversationId)).toMatchObject({
      revision: 5,
      title: 'Local after terminal',
      syncState: 'pending',
    })
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

  it('applies and acknowledges the strict conversion terminal mutation without exposing local job data', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')
    const create = createConversationMutation('terminal_create', 'terminal_conversation')
    const append = appendMessageMutation('terminal_append', create.entityId, 'terminal_message')
    append.payload = {
      ...append.payload,
      role: 'assistant',
      executionId: 'conversion_execution',
      blocks: [{
        type: 'conversion', blockId: 'conversion_block', executionId: 'conversion_execution', state: 'active',
      }],
    }

    store.sync.applyRemotePage({
      protocolVersion: 1, cursor: 'terminal_create_cursor', mutations: [pulledMutation(create, 1)],
    }, 1)
    store.sync.applyRemotePage({
      protocolVersion: 1, cursor: 'terminal_append_cursor', mutations: [pulledMutation(append, 2)],
    }, 2)
    store.messages.replaceBlock(append.entityId, 'conversion_block', {
      type: 'conversion', blockId: 'conversion_block', executionId: 'conversion_execution', state: 'terminal',
    })
    const terminal = store.outbox.listReady(Number.MAX_SAFE_INTEGER, 10).find((mutation) => (
      mutation.kind === 'message.conversion_block_terminal'
    ))
    expect(terminal).toMatchObject({
      entityId: append.entityId,
      payload: { messageId: append.entityId, blockId: 'conversion_block', executionId: 'conversion_execution', state: 'terminal' },
    })
    if (!terminal || terminal.kind !== 'message.conversion_block_terminal') throw new Error('missing terminal mutation')
    const terminalMutation: Extract<SyncMutation, { kind: 'message.conversion_block_terminal' }> = {
      id: terminal.id, kind: terminal.kind, entityId: terminal.entityId,
      baseRevision: terminal.baseRevision, payload: terminal.payload, occurredAt: terminal.occurredAt,
    }
    store.outbox.markSyncing([terminal.id])
    store.sync.applyRemotePage({
      protocolVersion: 1, cursor: 'terminal_receipt_cursor', mutations: [pulledMutation(terminalMutation, 3)],
    }, 3)

    expect(store.outbox.find(terminal.id)).toBeUndefined()
    expect(store.messages.get(append.entityId)?.blocks).toEqual([{
      type: 'conversion', blockId: 'conversion_block', executionId: 'conversion_execution', state: 'terminal',
    }])
    expect(store.conversations.getSummary(create.entityId)).toMatchObject({ revision: 3, syncState: 'synced' })

    store.sync.applyRemotePage({
      protocolVersion: 1, cursor: 'terminal_replay_cursor', mutations: [pulledMutation(terminalMutation, 3)],
    }, 3)
    expect(store.conversations.getSummary(create.entityId)?.revision).toBe(3)

    const mismatched = {
      ...terminalMutation,
      id: 'terminal_wrong_execution',
      baseRevision: 3,
      payload: { ...terminalMutation.payload, executionId: 'wrong_execution' },
    }
    expect(() => store.sync.applyRemotePage({
      protocolVersion: 1, cursor: 'terminal_mismatch_cursor', mutations: [pulledMutation(mismatched, 4)],
    }, 4)).toThrow(expect.objectContaining({ code: 'INTERNAL_ERROR' }))
    expect(store.sync.getCheckpoint()?.remoteCursor).toBe('terminal_replay_cursor')
    manager.close()
  })

  it('journals active conversion bindings with the message and finalizes them with the append outbox', () => {
    const root = temporaryRoot()
    const manager = new UserDataStoreManager(root)
    const store = manager.open('cloud-alice')
    store.conversations.insert({
      id: 'binding_conversation', title: 'Binding', userId: 'cloud-alice', createdAt: 1, updatedAt: 1,
    })
    store.messages.insert({
      id: 'binding_message', conversationId: 'binding_conversation', role: 'assistant',
      blocks: [], createdAt: 2,
    })
    store.chatRuns.insert({
      id: 'binding_run', conversationId: 'binding_conversation', requestId: 'binding_request',
      userId: 'cloud-alice', provider: 'openrouter', model: 'model', status: 'running', startedAt: 2,
    })
    const active = {
      type: 'conversion' as const,
      blockId: 'binding_block',
      executionId: 'binding_execution',
      state: 'active' as const,
    }

    store.messages.update('binding_message', { blocks: [active] })
    expect(store.conversionBlockBindings.get('cloud-alice', 'binding_execution')).toEqual({
      ownerUserId: 'cloud-alice',
      conversationId: 'binding_conversation',
      messageId: 'binding_message',
      blockId: 'binding_block',
      executionId: 'binding_execution',
    })

    manager.close()
    const reopened = manager.open('cloud-alice')
    expect(reopened.conversionBlockBindings.listRecoverable('cloud-alice')).toEqual([
      expect.objectContaining({ executionId: 'binding_execution' }),
    ])
    expect(reopened.conversionBlockBindings.listRecoverable('cloud-alice')[0])
      .not.toHaveProperty('finalizedAt')

    reopened.chatRuns.finalizeWithMessage(
      'binding_run',
      'binding_message',
      'binding_request',
      { blocks: [active], status: 'completed', endedAt: 3 },
    )
    expect(reopened.conversionBlockBindings.get('cloud-alice', 'binding_execution'))
      .toMatchObject({ finalizedAt: 3 })
    expect(reopened.outbox.list(10)).toEqual([
      expect.objectContaining({
        kind: 'message.append',
        entityId: 'binding_message',
        payload: expect.objectContaining({ blocks: [active] }),
      }),
    ])

    reopened.messages.replaceBlock('binding_message', 'binding_block', {
      ...active,
      state: 'terminal',
    })
    expect(reopened.conversionBlockBindings.get('cloud-alice', 'binding_execution'))
      .toMatchObject({ finalizedAt: 3, consumedAt: expect.any(Number) })
    expect(reopened.conversionBlockBindings.listRecoverable('cloud-alice')).toEqual([])
    expect(reopened.outbox.list(10).map(({ kind }) => kind)).toEqual([
      'message.append',
      'message.conversion_block_terminal',
    ])
    expect(() => reopened.messages.replaceBlock('binding_message', 'binding_block', {
      ...active,
      blockId: 'mismatched_replay_block',
      state: 'terminal',
    })).toThrow(expect.objectContaining({ code: 'INTERNAL_ERROR' }))

    manager.close()
    const afterRestart = manager.open('cloud-alice')
    expect(afterRestart.conversionBlockBindings.listRecoverable('cloud-alice')).toEqual([])
    expect(afterRestart.outbox.countPending('message.conversion_block_terminal')).toBe(1)
    afterRestart.conversations.delete('binding_conversation')
    expect(afterRestart.conversionBlockBindings.get('cloud-alice', 'binding_execution'))
      .toBeUndefined()
    manager.close()
  })

  it('rolls back the active message or final append when exact binding invariants fail', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')
    store.conversations.insert({
      id: 'binding_atomic_conversation', title: 'Atomic', userId: 'cloud-alice', createdAt: 1, updatedAt: 1,
    })
    for (const suffix of ['first', 'second']) {
      store.messages.insert({
        id: `binding_atomic_${suffix}`, conversationId: 'binding_atomic_conversation',
        role: 'assistant', blocks: [], createdAt: suffix === 'first' ? 2 : 3,
      })
    }
    store.chatRuns.insert({
      id: 'binding_atomic_run', conversationId: 'binding_atomic_conversation',
      requestId: 'binding_atomic_request', userId: 'cloud-alice', provider: 'openrouter',
      model: 'model', status: 'running', startedAt: 2,
    })
    const active = {
      type: 'conversion' as const,
      blockId: 'binding_atomic_block',
      executionId: 'binding_atomic_execution',
      state: 'active' as const,
    }
    store.messages.update('binding_atomic_first', { blocks: [active] })

    expect(() => store.messages.update('binding_atomic_first', { blocks: [{
      ...active,
      state: 'terminal',
    }] })).toThrow(expect.objectContaining({ code: 'INTERNAL_ERROR' }))
    expect(store.messages.get('binding_atomic_first')?.blocks).toEqual([active])

    expect(() => store.chatRuns.finalizeWithMessage(
      'binding_atomic_run',
      'binding_atomic_first',
      'binding_atomic_request',
      {
        blocks: [{ ...active, state: 'terminal' }],
        status: 'completed',
        endedAt: 4,
      },
    )).toThrow(expect.objectContaining({ code: 'INTERNAL_ERROR' }))
    expect(store.chatRuns.get('binding_atomic_run')?.status).toBe('running')
    expect(store.outbox.countPending()).toBe(0)

    expect(() => store.messages.update('binding_atomic_second', { blocks: [{
      ...active,
      blockId: 'binding_atomic_second_block',
    }] })).toThrow(expect.objectContaining({ code: 'INTERNAL_ERROR' }))
    expect(store.messages.get('binding_atomic_second')?.blocks).toEqual([])

    expect(() => store.chatRuns.finalizeWithMessage(
      'binding_atomic_run',
      'binding_atomic_first',
      'binding_atomic_request',
      {
        blocks: [active, { ...active }],
        status: 'completed',
        endedAt: 4,
      },
    )).toThrow(expect.objectContaining({ code: 'INTERNAL_ERROR' }))
    expect(store.messages.get('binding_atomic_first')?.blocks).toEqual([active])
    expect(store.chatRuns.get('binding_atomic_run')?.status).toBe('running')
    expect(store.conversionBlockBindings.get('cloud-alice', 'binding_atomic_execution'))
      .not.toHaveProperty('finalizedAt')
    expect(store.outbox.countPending()).toBe(0)
    manager.close()
  })

  it('retires missing execution bindings without losing terminal outbox work', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')
    store.conversations.insert({
      id: 'binding_retire_conversation', title: 'Retire', userId: 'cloud-alice', createdAt: 1, updatedAt: 1,
    })
    store.messages.insert({
      id: 'binding_retire_message', conversationId: 'binding_retire_conversation', role: 'assistant',
      blocks: [], createdAt: 2,
    })
    const active = {
      type: 'conversion' as const,
      blockId: 'binding_retire_block',
      executionId: 'binding_retire_execution',
      state: 'active' as const,
    }
    store.messages.update('binding_retire_message', { blocks: [active] })

    expect(store.conversionBlockBindings.retire(
      'cloud-alice', 'binding_retire_execution', 'missing_execution', 3,
    )).toBe(true)
    expect(store.conversionBlockBindings.retire(
      'cloud-alice', 'binding_retire_execution', 'missing_execution', 4,
    )).toBe(false)
    expect(store.conversionBlockBindings.get('cloud-alice', 'binding_retire_execution'))
      .toMatchObject({ retiredAt: 3, retirementReason: 'missing_execution' })
    expect(store.conversionBlockBindings.listRecoverable('cloud-alice')).toEqual([])
    manager.close()
  })

  it.each([
    { label: 'applied base plus one', status: 'applied' as const, revisionDelta: 1, accepted: true },
    { label: 'applied base', status: 'applied' as const, revisionDelta: 0, accepted: false },
    { label: 'duplicate base', status: 'duplicate' as const, revisionDelta: 0, accepted: true },
    { label: 'duplicate base plus one', status: 'duplicate' as const, revisionDelta: 1, accepted: false },
    { label: 'duplicate stale revision', status: 'duplicate' as const, revisionDelta: -1, accepted: false },
    { label: 'duplicate future revision', status: 'duplicate' as const, revisionDelta: 2, accepted: false },
  ])('validates conversion terminal push acknowledgement: $label', ({
    label, status, revisionDelta, accepted,
  }) => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')
    const seeded = createLocalTerminalOutbox(store, `terminal_ack_${label.replaceAll(' ', '_')}`)
    store.outbox.markSyncing([seeded.mutation.id])
    const result: SyncMutationResult = status === 'applied'
      ? { id: seeded.mutation.id, status, revision: seeded.mutation.baseRevision + revisionDelta }
      : { id: seeded.mutation.id, status, revision: seeded.mutation.baseRevision + revisionDelta }
    const acknowledge = () => store.outbox.acknowledgePushResults([seeded.mutation], [result])

    if (accepted) {
      expect(acknowledge).not.toThrow()
      expect(store.outbox.find(seeded.mutation.id)).toBeUndefined()
      expect(store.conversations.getSummary(seeded.conversationId)).toMatchObject({
        revision: status === 'duplicate'
          ? seeded.mutation.baseRevision
          : seeded.mutation.baseRevision + 1,
        syncState: 'synced',
      })
    } else {
      expect(acknowledge).toThrow(expect.objectContaining({ code: 'INTERNAL_ERROR' }))
      expect(store.outbox.find(seeded.mutation.id)).toMatchObject({ state: 'syncing' })
      expect(store.conversations.getSummary(seeded.conversationId)).toMatchObject({
        revision: seeded.mutation.baseRevision + 1,
        syncState: 'syncing',
      })
    }
    manager.close()
  })

  it('allows a stale conversion duplicate only when an exact durable receipt satisfies it', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')
    const seeded = createLocalTerminalOutbox(store, 'terminal_exact_receipt')
    store.outbox.markSyncing([seeded.mutation.id])
    store.outbox.acknowledgePushResults([seeded.mutation], [{
      id: seeded.mutation.id,
      status: 'duplicate',
      revision: seeded.mutation.baseRevision,
    }])
    const checkpointBeforePull = store.sync.getCheckpoint()
    const mismatched = {
      ...seeded.mutation,
      payload: { ...seeded.mutation.payload, executionId: 'other_execution' },
    }

    expect(() => store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'terminal_exact_receipt_mismatch',
      mutations: [pulledMutation(mismatched, seeded.mutation.baseRevision)],
    }, 4)).toThrow(expect.objectContaining({ code: 'INTERNAL_ERROR' }))
    expect(store.sync.getCheckpoint()).toEqual(checkpointBeforePull)

    expect(() => store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'terminal_exact_receipt_pull',
      mutations: [pulledMutation(seeded.mutation, seeded.mutation.baseRevision)],
    }, 5)).not.toThrow()
    expect(store.sync.getCheckpoint()?.remoteCursor).toBe('terminal_exact_receipt_pull')
    expect(store.conversations.getSummary(seeded.conversationId)).toMatchObject({
      revision: seeded.mutation.baseRevision,
      syncState: 'synced',
    })
    manager.close()
  })

  it('treats duplicate-at-base as authoritative and rebases every later conversation mutation', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')
    const seeded = createLocalTerminalOutbox(store, 'terminal_authoritative_rebase')
    const rename = renameConversationMutation(
      'terminal_authoritative_later_rename',
      seeded.conversationId,
      seeded.mutation.baseRevision + 1,
      'Rebased title',
    )
    const append = {
      ...appendMessageMutation(
        'terminal_authoritative_later_append',
        seeded.conversationId,
        'terminal_authoritative_later_message',
      ),
      baseRevision: seeded.mutation.baseRevision + 2,
    }
    const permanentlyFailed = {
      ...appendMessageMutation(
        'terminal_authoritative_failed_append',
        seeded.conversationId,
        'terminal_authoritative_failed_message',
      ),
      baseRevision: seeded.mutation.baseRevision + 3,
    }
    store.outbox.recordWithConversation(rename)
    store.outbox.recordWithMessage(append)
    store.outbox.recordWithMessage(permanentlyFailed)
    store.outbox.markFailed(permanentlyFailed.id, 'INVALID_INPUT')
    store.outbox.markSyncing([seeded.mutation.id, rename.id, append.id])

    const outcome = store.outbox.acknowledgePushResults(
      [seeded.mutation, rename, append],
      [
        { id: seeded.mutation.id, status: 'duplicate', revision: seeded.mutation.baseRevision },
        { id: rename.id, status: 'conflict', errorCode: 'SYNC_CONFLICT' },
        { id: append.id, status: 'conflict', errorCode: 'SYNC_CONFLICT' },
      ],
    )

    expect(outcome.supersededIds).toEqual([rename.id, append.id])
    expect(store.outbox.find(permanentlyFailed.id)).toMatchObject({
      id: permanentlyFailed.id,
      baseRevision: permanentlyFailed.baseRevision,
      state: 'failed',
      lastErrorCode: 'INVALID_INPUT',
    })
    const rebased = store.outbox.list(10).filter(({ id }) => id !== permanentlyFailed.id)
    expect(rebased).toHaveLength(2)
    expect(rebased.map(({ id }) => id)).not.toContain(rename.id)
    expect(rebased.map(({ id }) => id)).not.toContain(append.id)
    expect(rebased.map(({ baseRevision }) => baseRevision)).toEqual([
      seeded.mutation.baseRevision,
      seeded.mutation.baseRevision + 1,
    ])
    expect(rebased).toEqual(rebased.map(() => expect.objectContaining({
      id: expect.not.stringMatching(/terminal_authoritative_later_(rename|append)/),
      state: 'pending',
      attempts: 0,
    })))
    for (const mutation of rebased) {
      expect(mutation).not.toHaveProperty('nextAttemptAt')
      expect(mutation).not.toHaveProperty('lastErrorCode')
    }
    expect(store.conversations.getSummary(seeded.conversationId)).toMatchObject({
      title: 'Rebased title',
      revision: seeded.mutation.baseRevision + 2,
      syncState: 'failed',
    })
    manager.close()
  })

  it('applies a compacted terminal receipt by conversation without requiring its deleted message', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')
    const create = createConversationMutation('compacted_terminal_create', 'compacted_terminal_conversation')
    const rename = renameConversationMutation(
      'compacted_terminal_rename', create.entityId, 1, 'Before compact terminal',
    )
    store.sync.applyRemotePage({
      protocolVersion: 2,
      cursor: 'compacted_terminal_setup',
      mutations: [pulledMutation(create, 1), pulledMutation(rename, 2)],
    }, 1)

    expect(() => store.sync.applyRemotePage({
      protocolVersion: 2,
      cursor: 'compacted_terminal_cursor',
      mutations: [{
        id: 'compacted_terminal_receipt',
        kind: 'message.conversion_block_terminal',
        entityId: 'purged_terminal_message',
        conversationId: create.entityId,
        baseRevision: 2,
        resultRevision: 3,
        compacted: true,
        receivedAt: '2026-08-24T01:00:00.000Z',
      }],
    }, 2)).not.toThrow()
    expect(store.messages.get('purged_terminal_message')).toBeUndefined()
    expect(store.conversations.getSummary(create.entityId)).toMatchObject({
      revision: 3,
      syncState: 'synced',
    })
    expect(store.sync.getCheckpoint()).toMatchObject({
      protocolVersion: 2,
      remoteCursor: 'compacted_terminal_cursor',
    })
    manager.close()
  })

  it.each([
    { label: 'active next revision', localState: 'active' as const, baseRevision: 2, resultRevision: 3, accepted: true, expectedRevision: 3 },
    { label: 'active duplicate revision', localState: 'active' as const, baseRevision: 2, resultRevision: 2, accepted: false, expectedRevision: 2 },
    { label: 'active stale applied revision', localState: 'active' as const, baseRevision: 1, resultRevision: 2, accepted: false, expectedRevision: 2 },
    { label: 'active future revision', localState: 'active' as const, baseRevision: 3, resultRevision: 4, accepted: false, expectedRevision: 2 },
    { label: 'terminal next revision', localState: 'terminal' as const, baseRevision: 2, resultRevision: 3, accepted: true, expectedRevision: 3 },
    { label: 'terminal exact duplicate revision', localState: 'terminal' as const, baseRevision: 2, resultRevision: 2, accepted: true, expectedRevision: 2 },
    { label: 'terminal exact applied replay', localState: 'terminal' as const, baseRevision: 1, resultRevision: 2, accepted: true, expectedRevision: 2 },
    { label: 'terminal stale revision', localState: 'terminal' as const, baseRevision: 0, resultRevision: 1, accepted: false, expectedRevision: 2 },
    { label: 'terminal future revision', localState: 'terminal' as const, baseRevision: 3, resultRevision: 4, accepted: false, expectedRevision: 2 },
  ])('validates pulled conversion terminal OCC: $label', ({
    label, localState, baseRevision, resultRevision, accepted, expectedRevision,
  }) => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')
    const prefix = `terminal_pull_${label.replaceAll(' ', '_')}`
    const conversationId = `${prefix}_conversation`
    const messageId = `${prefix}_message`
    const create = createConversationMutation(`${prefix}_create`, conversationId)
    const append = appendConversionMessageMutation(
      `${prefix}_append`, conversationId, messageId, localState,
    )
    store.sync.applyRemotePage({
      protocolVersion: 1, cursor: `${prefix}_create_cursor`, mutations: [pulledMutation(create, 1)],
    }, 1)
    store.sync.applyRemotePage({
      protocolVersion: 1, cursor: `${prefix}_append_cursor`, mutations: [pulledMutation(append, 2)],
    }, 2)
    const checkpointBeforeTerminal = store.sync.getCheckpoint()
    const terminal = conversionTerminalMutation(`${prefix}_terminal`, messageId, baseRevision)
    const apply = () => store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: `${prefix}_terminal_cursor`,
      mutations: [pulledMutation(terminal, resultRevision)],
    }, 3)

    if (accepted) {
      expect(apply).not.toThrow()
      expect(store.sync.getCheckpoint()?.remoteCursor).toBe(`${prefix}_terminal_cursor`)
      expect(store.messages.get(messageId)?.blocks).toEqual([{
        type: 'conversion',
        blockId: 'conversion_block',
        executionId: 'conversion_execution',
        state: 'terminal',
      }])
    } else {
      expect(apply).toThrow(expect.objectContaining({ code: 'INTERNAL_ERROR' }))
      expect(store.sync.getCheckpoint()).toEqual(checkpointBeforeTerminal)
      expect(store.messages.get(messageId)?.blocks).toEqual([{
        type: 'conversion',
        blockId: 'conversion_block',
        executionId: 'conversion_execution',
        state: localState,
      }])
    }
    expect(store.conversations.getSummary(conversationId)?.revision).toBe(expectedRevision)
    manager.close()
  })

  it.each([
    {
      label: 'duplicate exact conversion blocks',
      blocks: [
        { type: 'conversion', blockId: 'conversion_block', executionId: 'conversion_execution', state: 'active' },
        { type: 'conversion', blockId: 'conversion_block', executionId: 'conversion_execution', state: 'active' },
      ],
    },
    {
      label: 'duplicate block id with another execution',
      blocks: [
        { type: 'conversion', blockId: 'conversion_block', executionId: 'conversion_execution', state: 'active' },
        { type: 'conversion', blockId: 'conversion_block', executionId: 'other_execution', state: 'active' },
      ],
    },
    {
      label: 'duplicate block id with a non-conversion block',
      blocks: [
        { type: 'conversion', blockId: 'conversion_block', executionId: 'conversion_execution', state: 'active' },
        { type: 'media_generation', blockId: 'conversion_block', jobId: 'media_job', kind: 'video', status: 'pending' },
      ],
    },
    {
      label: 'non-conversion target block',
      blocks: [
        { type: 'media_generation', blockId: 'conversion_block', jobId: 'media_job', kind: 'video', status: 'pending' },
      ],
    },
    {
      label: 'null conversion state',
      blocks: [
        { type: 'conversion', blockId: 'conversion_block', executionId: 'conversion_execution', state: null },
      ],
    },
  ])('rejects malformed conversion block targets atomically: $label', ({ label, blocks }) => {
    const root = temporaryRoot()
    const manager = new UserDataStoreManager(root)
    const store = manager.open('cloud-alice')
    const prefix = `terminal_blocks_${label.replaceAll(' ', '_')}`
    const conversationId = `${prefix}_conversation`
    const messageId = `${prefix}_message`
    const create = createConversationMutation(`${prefix}_create`, conversationId)
    const append = appendConversionMessageMutation(`${prefix}_append`, conversationId, messageId)
    store.sync.applyRemotePage({
      protocolVersion: 1, cursor: `${prefix}_create_cursor`, mutations: [pulledMutation(create, 1)],
    }, 1)
    store.sync.applyRemotePage({
      protocolVersion: 1, cursor: `${prefix}_append_cursor`, mutations: [pulledMutation(append, 2)],
    }, 2)
    const raw = new Database(cachePath(root, 'cloud-alice'))
    raw.prepare('UPDATE messages SET blocks_json = ? WHERE id = ?').run(JSON.stringify(blocks), messageId)
    raw.close()
    const checkpointBeforeTerminal = store.sync.getCheckpoint()
    const terminal = conversionTerminalMutation(`${prefix}_terminal`, messageId, 2)

    expect(() => store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: `${prefix}_terminal_cursor`,
      mutations: [pulledMutation(terminal, 3)],
    }, 3)).toThrow(expect.objectContaining({ code: 'INTERNAL_ERROR' }))
    expect(store.sync.getCheckpoint()).toEqual(checkpointBeforeTerminal)
    const inspection = new Database(cachePath(root, 'cloud-alice'), { readonly: true })
    expect(JSON.parse((inspection.prepare('SELECT blocks_json AS blocksJson FROM messages WHERE id = ?')
      .get(messageId) as { blocksJson: string }).blocksJson)).toEqual(blocks)
    expect(inspection.prepare('SELECT revision FROM conversations WHERE id = ?').get(conversationId))
      .toEqual({ revision: 2 })
    inspection.close()
    manager.close()
  })

  it('rejects a conversion terminal pull when the message conversation owner changed', () => {
    const root = temporaryRoot()
    const manager = new UserDataStoreManager(root)
    const store = manager.open('cloud-alice')
    const conversationId = 'terminal_owner_conversation'
    const messageId = 'terminal_owner_message'
    const create = createConversationMutation('terminal_owner_create', conversationId)
    const append = appendConversionMessageMutation('terminal_owner_append', conversationId, messageId)
    store.sync.applyRemotePage({
      protocolVersion: 1, cursor: 'terminal_owner_create_cursor', mutations: [pulledMutation(create, 1)],
    }, 1)
    store.sync.applyRemotePage({
      protocolVersion: 1, cursor: 'terminal_owner_append_cursor', mutations: [pulledMutation(append, 2)],
    }, 2)
    const raw = new Database(cachePath(root, 'cloud-alice'))
    raw.prepare('UPDATE conversations SET user_id = ? WHERE id = ?').run('cloud-bob', conversationId)
    raw.close()
    const checkpointBeforeTerminal = store.sync.getCheckpoint()

    expect(() => store.sync.applyRemotePage({
      protocolVersion: 1,
      cursor: 'terminal_owner_terminal_cursor',
      mutations: [pulledMutation(conversionTerminalMutation(
        'terminal_owner_terminal', messageId, 2,
      ), 3)],
    }, 3)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(store.sync.getCheckpoint()).toEqual(checkpointBeforeTerminal)
    const inspection = new Database(cachePath(root, 'cloud-alice'), { readonly: true })
    expect(inspection.prepare('SELECT revision FROM conversations WHERE id = ?').get(conversationId))
      .toEqual({ revision: 2 })
    inspection.close()
    manager.close()
  })

  it('aggregates conversion terminal pending states and warnings by owning conversation, then clears them', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const manager = new UserDataStoreManager(temporaryRoot())
    try {
      const store = manager.open('cloud-alice')
      const seeded = createLocalTerminalOutbox(store, 'terminal_aggregate')
      now.mockReturnValue(1_000 + (24 * 60 * 60 * 1_000))

      expect(store.conversations.getSummary(seeded.conversationId)).toMatchObject({
        syncState: 'pending', syncWarningSince: '1970-01-01T00:00:01.000Z',
      })
      store.outbox.markSyncing([seeded.mutation.id])
      expect(store.conversations.getSummary(seeded.conversationId)).toMatchObject({
        syncState: 'syncing', syncWarningSince: '1970-01-01T00:00:01.000Z',
      })
      store.outbox.markFailed(seeded.mutation.id, 'SYNC_CONFLICT')
      expect(store.conversations.getSummary(seeded.conversationId)).toMatchObject({
        syncState: 'failed', syncWarningSince: '1970-01-01T00:00:01.000Z',
      })
      expect(store.outbox.retryFailed(seeded.conversationId)).toEqual([seeded.mutation.id])
      expect(store.conversations.getSummary(seeded.conversationId)).toMatchObject({
        syncState: 'pending', syncWarningSince: '1970-01-01T00:00:01.000Z',
      })
      store.outbox.markSyncing([seeded.mutation.id])
      store.outbox.acknowledgePushResults([seeded.mutation], [{
        id: seeded.mutation.id,
        status: 'applied',
        revision: seeded.mutation.baseRevision + 1,
      }])
      expect(store.conversations.getSummary(seeded.conversationId)).toMatchObject({
        syncState: 'synced',
      })
      expect(store.conversations.getSummary(seeded.conversationId)?.syncWarningSince).toBeUndefined()
    } finally {
      manager.close()
      now.mockRestore()
    }
  })

  it('retries a failed conversion terminal mutation by its owning conversation ID', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')
    const seeded = createLocalTerminalOutbox(store, 'terminal_retry_conversation')
    store.outbox.markFailed(seeded.mutation.id, 'SYNC_CONFLICT')

    expect(store.outbox.retryFailed(seeded.conversationId)).toEqual([seeded.mutation.id])
    expect(store.outbox.find(seeded.mutation.id)).toMatchObject({ state: 'pending' })
    expect(store.conversations.getSummary(seeded.conversationId)?.syncState).toBe('pending')
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
        revision: 2,
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
        revision: 2,
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
        revision: 3,
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

  it.each(['before', 'at', 'after'] as const)(
    'accepts compacted purge history from a checkpoint %s the retained cursor rows',
    (checkpoint) => {
      const manager = new UserDataStoreManager(temporaryRoot())
      const store = manager.open(`purge-${checkpoint}`)
      const conversationId = `purged_conversation_${checkpoint}`
      const create: SyncMutation = {
        id: `purged_create_${checkpoint}`, kind: 'conversation.create', entityId: conversationId,
        baseRevision: 0, occurredAt: '2026-06-01T00:00:00.000Z',
        payload: {
          title: 'Never reconstruct or redact this title', titleState: 'user_named',
          createdAt: '2026-06-01T00:00:00.000Z',
          lastActivityAt: '2026-06-01T00:01:00.000Z',
          metadataUpdatedAt: '2026-06-01T00:00:00.000Z',
        },
      }
      const message: SyncMutation = {
        id: `purged_message_mutation_${checkpoint}`, kind: 'message.append',
        entityId: `purged_message_${checkpoint}`, baseRevision: 1,
        occurredAt: '2026-06-01T00:01:00.000Z',
        payload: {
          id: `purged_message_${checkpoint}`, conversationId, role: 'user',
          blocks: [{ type: 'text', text: 'Never reconstruct or redact this message' }],
          createdAt: '2026-06-01T00:01:00.000Z',
        },
      }
      const deletion: SyncMutation = {
        id: `purged_delete_${checkpoint}`, kind: 'conversation.delete', entityId: conversationId,
        baseRevision: 2, occurredAt: '2026-06-01T00:02:00.000Z', payload: {},
      }
      const prefix = [compactedMutation(create, 1), compactedMutation(message, 2)]
      const tombstone = compactedMutation(deletion, 3)

      if (checkpoint === 'at') {
        store.sync.applyRemotePage({
          protocolVersion: 1, cursor: 'cursor_purge_at_anchor', mutations: prefix,
        }, 1)
        store.sync.applyRemotePage({
          protocolVersion: 1, cursor: 'cursor_purge_tombstone', mutations: [tombstone],
        }, 2)
      } else {
        store.sync.applyRemotePage({
          protocolVersion: 1, cursor: 'cursor_purge_tombstone',
          mutations: [...prefix, tombstone],
        }, 1)
        if (checkpoint === 'after') {
          store.sync.applyRemotePage({
            protocolVersion: 1, cursor: 'cursor_after_purge', mutations: [],
          }, 2)
        }
      }

      expect(store.conversations.listPage({ limit: 50 }).items).toEqual([])
      expect(store.messages.get(`purged_message_${checkpoint}`)).toBeUndefined()
      expect(store.sync.getCheckpoint()?.remoteCursor).toBe(
        checkpoint === 'after' ? 'cursor_after_purge' : 'cursor_purge_tombstone',
      )
      manager.close()
    },
  )

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
      .toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 }])
    expect(inspection.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'outbox_mutations'").get())
      .toBeDefined()
    expect(inspection.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_receipt_evidence'").get())
      .toBeDefined()
    expect(inspection.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversion_block_bindings'").get())
      .toBeDefined()
    inspection.close()
  })

  it('strips queued provider projections that predate exact attachment selection', () => {
    const root = temporaryRoot()
    const path = cachePath(root, 'cloud-alice')
    const sqlite = new Database(path)
    const migrationNames = [
      '0001_user_cache',
      '0002_outbox_enqueue_sequence',
      '0003_sync_receipt_evidence',
      '0004_account_sync_projection',
      '0005_legacy_import_identity',
      '0006_legacy_import_identity_history',
      '0007_attachment_kind',
      '0008_conversion_block_binding_journal',
      '0009_message_provider_projection',
    ]
    for (const [index, name] of migrationNames.entries()) {
      sqlite.exec(readFileSync(new URL(
        `../../../resources/user-cache-migrations/${name}.sql`,
        import.meta.url,
      ), 'utf8'))
      sqlite.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
        .run(index + 1, index + 1)
    }
    const payload = {
      id: 'legacy_projection_message',
      conversationId: 'legacy_projection_conversation',
      role: 'user',
      blocks: [{ type: 'text', text: 'Convert private.pdf to PDF' }],
      providerProjection: {
        kind: 'local_conversion', targetFormat: 'pdf', attachmentCount: 1,
      },
      createdAt: '2026-08-24T00:01:00.000Z',
    }
    sqlite.prepare(`
      INSERT INTO conversations (
        id, title, title_state, user_id, revision, sync_state,
        created_at, updated_at, last_activity_at, metadata_updated_at
      ) VALUES (?, 'Legacy', 'pending', 'cloud-alice', 1, 'pending', 1, 1, 1, 1)
    `).run(payload.conversationId)
    sqlite.prepare(`
      INSERT INTO messages (
        id, conversation_id, role, blocks_json, provider_projection_json, ordinal, created_at
      ) VALUES (?, ?, 'user', ?, ?, 1, 1)
    `).run(
      payload.id,
      payload.conversationId,
      JSON.stringify(payload.blocks),
      JSON.stringify(payload.providerProjection),
    )
    sqlite.prepare(`
      INSERT INTO outbox_mutations (
        id, kind, entity_id, base_revision, payload_json, state, attempts,
        occurred_at, created_at, enqueue_sequence
      ) VALUES ('legacy_projection_outbox', 'message.append', ?, 1, ?, 'pending', 0, 1, 1, 1)
    `).run(payload.id, JSON.stringify(payload))
    sqlite.prepare(`
      INSERT INTO sync_receipt_evidence (
        mutation_id, kind, entity_id, base_revision, payload_json, occurred_at, created_at
      ) VALUES ('legacy_projection_receipt', 'message.append', ?, 1, ?, 1, 1)
    `).run(payload.id, JSON.stringify(payload))
    sqlite.close()

    const manager = new UserDataStoreManager(root)
    const store = manager.open('cloud-alice')
    expect(store.outbox.listReady(Date.now(), 10)).toContainEqual(expect.objectContaining({
      id: 'legacy_projection_outbox',
      payload: expect.not.objectContaining({ providerProjection: expect.anything() }),
    }))
    manager.close()

    const inspection = new Database(path, { readonly: true })
    expect(inspection.prepare(`
      SELECT provider_projection_json AS providerProjectionJson
      FROM messages WHERE id = ?
    `).get(payload.id)).toEqual({ providerProjectionJson: null })
    for (const table of ['outbox_mutations', 'sync_receipt_evidence']) {
      const column = table === 'outbox_mutations' ? 'id' : 'mutation_id'
      const id = table === 'outbox_mutations'
        ? 'legacy_projection_outbox'
        : 'legacy_projection_receipt'
      const row = inspection.prepare(`SELECT payload_json AS payloadJson FROM ${table} WHERE ${column} = ?`)
        .get(id) as { payloadJson: string }
      expect(JSON.parse(row.payloadJson)).not.toHaveProperty('providerProjection')
    }
    inspection.close()
  })

  it('upgrades media assets for upload files without losing rows, indexes, foreign keys, or sync state', () => {
    const root = temporaryRoot()
    const path = cachePath(root, 'cloud-alice')
    const sqlite = new Database(path)
    const migrationNames = [
      '0001_user_cache',
      '0002_outbox_enqueue_sequence',
      '0003_sync_receipt_evidence',
      '0004_account_sync_projection',
      '0005_legacy_import_identity',
      '0006_legacy_import_identity_history',
    ]
    for (const [index, name] of migrationNames.entries()) {
      sqlite.exec(readFileSync(new URL(
        `../../../resources/user-cache-migrations/${name}.sql`,
        import.meta.url,
      ), 'utf8'))
      sqlite.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
        .run(index + 1, index + 1)
    }
    sqlite.prepare(`
      INSERT INTO conversations (
        id, title, title_state, user_id, revision, sync_state,
        created_at, updated_at, last_activity_at, metadata_updated_at
      ) VALUES ('migration_conversation', 'Migration', 'user_named', 'cloud-alice', 7, 'pending', 1, 2, 3, 4)
    `).run()
    sqlite.prepare(`
      INSERT INTO messages (id, conversation_id, role, blocks_json, ordinal, created_at)
      VALUES ('migration_message', 'migration_conversation', 'assistant', '[]', 1, 1)
    `).run()
    sqlite.prepare(`
      INSERT INTO media_assets (
        id, conversation_id, source, kind, mime_type, original_name, relative_path,
        byte_size, sha256, status, created_at, updated_at
      ) VALUES (
        'migration_asset', 'migration_conversation', 'generated', 'video', 'video/mp4',
        'existing.mp4', 'migration_conversation/migration_asset.mp4', 4,
        '${'a'.repeat(64)}', 'ready', 1, 2
      )
    `).run()
    sqlite.prepare(`
      INSERT INTO media_generation_jobs (
        id, conversation_id, assistant_message_id, provider, model, kind, provider_job_id,
        status, parameters_json, asset_id, created_at, updated_at
      ) VALUES (
        'migration_job', 'migration_conversation', 'migration_message', 'openrouter',
        'video-model', 'video', 'provider_job', 'completed', '{}', 'migration_asset', 1, 2
      )
    `).run()
    sqlite.close()

    const manager = new UserDataStoreManager(root)
    const store = manager.open('cloud-alice')
    expect(store.mediaAssets.get('migration_asset')).toMatchObject({
      kind: 'video',
      status: 'ready',
      relativePath: 'migration_conversation/migration_asset.mp4',
    })
    store.mediaAssets.insert({
      id: 'migration_file',
      conversationId: 'migration_conversation',
      source: 'upload',
      kind: 'file',
      mimeType: 'text/plain',
      originalName: 'notes.txt',
      relativePath: 'migration_conversation/migration_file.bin',
      byteSize: 5,
      sha256: 'b'.repeat(64),
      status: 'ready',
      createdAt: 3,
      updatedAt: 3,
    })
    manager.close()

    const inspection = new Database(path)
    expect(inspection.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
      .toEqual({ version: 10 })
    expect(inspection.prepare(`
      SELECT revision, sync_state AS syncState, last_activity_at AS lastActivityAt,
             metadata_updated_at AS metadataUpdatedAt
      FROM conversations WHERE id = 'migration_conversation'
    `).get()).toEqual({ revision: 7, syncState: 'pending', lastActivityAt: 3, metadataUpdatedAt: 4 })
    expect(inspection.prepare('SELECT asset_id AS assetId FROM media_generation_jobs WHERE id = ?').get('migration_job'))
      .toEqual({ assetId: 'migration_asset' })
    expect(inspection.prepare('SELECT kind, relative_path AS relativePath FROM media_assets WHERE id = ?').get('migration_file'))
      .toEqual({ kind: 'file', relativePath: 'migration_conversation/migration_file.bin' })
    expect((inspection.prepare('PRAGMA index_list(media_assets)').all() as Array<{ name: string }>).map(({ name }) => name))
      .toEqual(expect.arrayContaining(['media_assets_conversation_status_idx', 'media_assets_unclaimed_idx']))
    expect((inspection.prepare('PRAGMA foreign_key_list(media_generation_jobs)').all() as Array<{ table: string }>))
      .toEqual(expect.arrayContaining([expect.objectContaining({ table: 'media_assets' })]))
    expect(() => inspection.prepare(`
      INSERT INTO media_assets (
        id, conversation_id, source, kind, original_name, status, created_at, updated_at
      ) VALUES ('generated_file', 'migration_conversation', 'generated', 'file', 'bad.bin', 'staging', 4, 4)
    `).run()).toThrow(/CHECK constraint failed/)
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

  it('atomically projects consent and preferences per UID and restores pulled values after restart', () => {
    const root = temporaryRoot()
    const manager = new UserDataStoreManager(root)
    const alice = manager.open('cloud-alice')
    const consent: Extract<SyncMutation, { kind: 'privacy.consent' }> = {
      id: 'consent_mutation_1', kind: 'privacy.consent', entityId: 'cloud-sync-2026-08',
      baseRevision: 0, occurredAt: '2026-08-25T00:00:00.000Z', payload: {
        purpose: 'cloud_sync', documentVersion: 'cloud-sync-2026-08',
        consentedAt: '2026-08-25T00:00:00.000Z', clientVersion: '0.1.0',
      },
    }
    alice.outbox.recordWithConsent(consent)
    expect(alice.account.getConsent('cloud_sync')).toEqual(consent.payload)
    expect(alice.outbox.find(consent.id)).toBeDefined()

    const preferences: Extract<SyncMutation, { kind: 'preferences.update' }> = {
      id: 'preferences_mutation_1', kind: 'preferences.update', entityId: 'account-preferences',
      baseRevision: 0, occurredAt: '2026-08-25T00:01:00.000Z',
      payload: { timezone: 'America/New_York', displayCurrency: 'USD' },
    }
    alice.outbox.recordWithPreferences(preferences)
    expect(alice.account.getPreferences()).toEqual({
      timezone: 'America/New_York', displayCurrency: 'USD', revision: 1,
      updatedAt: '2026-08-25T00:01:00.000Z',
    })
    manager.close()

    const reopened = manager.open('cloud-alice')
    expect(reopened.account.getConsent('cloud_sync')).toEqual(consent.payload)
    reopened.sync.applyRemotePage({
      protocolVersion: 1, cursor: 'cursor_account_0001', mutations: [
        pulledMutation(preferences, 1, '2026-08-25T00:02:00.000Z'),
      ],
    }, 2)
    expect(reopened.account.getPreferences()).toEqual({
      timezone: 'America/New_York', displayCurrency: 'USD', revision: 1,
      updatedAt: '2026-08-25T00:02:00.000Z',
    })
    manager.open('cloud-bob')
    expect(manager.current()?.account.getConsent('cloud_sync')).toBeUndefined()
    expect(manager.current()?.account.getPreferences()).toBeUndefined()
    manager.close()
  })

  it('assigns consecutive optimistic preference revisions and preserves the newest value across receipts', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')
    const first: Extract<SyncMutation, { kind: 'preferences.update' }> = {
      id: 'preferences_first', kind: 'preferences.update', entityId: 'account-preferences',
      baseRevision: 0, occurredAt: '2026-08-25T00:01:00.000Z',
      payload: { timezone: 'Asia/Shanghai', displayCurrency: 'CNY' },
    }
    const second: Extract<SyncMutation, { kind: 'preferences.update' }> = {
      id: 'preferences_second', kind: 'preferences.update', entityId: 'account-preferences',
      baseRevision: 1, occurredAt: '2026-08-25T00:02:00.000Z',
      payload: { timezone: 'America/New_York', displayCurrency: 'USD' },
    }
    store.outbox.recordWithPreferences(first)
    store.outbox.recordWithPreferences(second)

    expect(store.outbox.list(10).map(({ baseRevision }) => baseRevision)).toEqual([0, 1])
    expect(store.account.getPreferences()).toMatchObject({
      timezone: 'America/New_York', revision: 2,
    })
    store.outbox.markSyncing([first.id])
    store.outbox.acknowledgePushResults(
      [first], [{ id: first.id, status: 'applied', revision: 1 }],
    )
    expect(store.account.getPreferences()).toMatchObject({
      timezone: 'America/New_York', revision: 2,
    })
    store.outbox.markSyncing([second.id])
    store.outbox.acknowledgePushResults(
      [second], [{ id: second.id, status: 'conflict', errorCode: 'SYNC_CONFLICT' }],
    )
    store.outbox.markFailed(second.id, 'SYNC_CONFLICT')
    expect(store.outbox.find(second.id)).toMatchObject({
      state: 'failed', lastErrorCode: 'SYNC_CONFLICT', baseRevision: 1,
    })
    expect(store.account.getPreferences()).toMatchObject({
      timezone: 'America/New_York', revision: 2,
    })
    manager.close()
  })

  it('persists one legacy import root per selected set and consent versions', () => {
    const root = temporaryRoot()
    const manager = new UserDataStoreManager(root)
    const store = manager.open('cloud-alice')
    const selection = {
      selectionFingerprint: 'a'.repeat(64),
      includeUnowned: true,
      cloudConsentVersion: 'cloud-sync-2026-08',
      unownedConsentVersion: 'legacy-unowned-import-2026-08',
    }
    expect(store.account.resolveLegacyImportBatch({
      ...selection, candidateBatchId: 'legacy-root-1',
    })).toBe('legacy-root-1')
    expect(store.account.resolveLegacyImportBatch({
      ...selection, candidateBatchId: 'must-not-replace',
    })).toBe('legacy-root-1')
    manager.close()

    const reopened = manager.open('cloud-alice')
    expect(reopened.account.resolveLegacyImportBatch({
      ...selection, candidateBatchId: 'still-must-not-replace',
    })).toBe('legacy-root-1')
    expect(reopened.account.resolveLegacyImportBatch({
      ...selection, selectionFingerprint: 'b'.repeat(64), candidateBatchId: 'legacy-root-2',
    })).toBe('legacy-root-2')
    expect(reopened.account.resolveLegacyImportBatch({
      ...selection, cloudConsentVersion: 'cloud-sync-2026-09',
      candidateBatchId: 'legacy-root-3',
    })).toBe('legacy-root-3')
    expect(reopened.account.resolveLegacyImportBatch({
      ...selection, candidateBatchId: 'must-return-first-root-after-a-b-a',
    })).toBe('legacy-root-1')
    manager.open('cloud-bob')
    expect(manager.current()?.account.resolveLegacyImportBatch({
      ...selection, candidateBatchId: 'bob-root-1',
    })).toBe('bob-root-1')
    manager.close()
  })

  it('migrates the singleton legacy import identity into durable identity history', () => {
    const root = temporaryRoot()
    const path = cachePath(root, 'cloud-alice')
    const sqlite = new Database(path)
    for (let version = 1; version <= 5; version += 1) {
      sqlite.exec(readFileSync(new URL(
        `../../../resources/user-cache-migrations/${String(version).padStart(4, '0')}_${[
          'user_cache',
          'outbox_enqueue_sequence',
          'sync_receipt_evidence',
          'account_sync_projection',
          'legacy_import_identity',
        ][version - 1]}.sql`,
        import.meta.url,
      ), 'utf8'))
      sqlite.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
        .run(version, version)
    }
    sqlite.prepare(`
      INSERT INTO legacy_import_identity(
        id, selection_fingerprint, include_unowned, cloud_consent_version,
        unowned_consent_version, batch_id, updated_at
      ) VALUES (1, ?, 1, ?, ?, ?, 1)
    `).run('a'.repeat(64), 'cloud-sync-2026-08', 'legacy-unowned-import-2026-08', 'legacy-root-1')
    sqlite.close()

    const manager = new UserDataStoreManager(root)
    const store = manager.open('cloud-alice')
    const selection = {
      selectionFingerprint: 'a'.repeat(64),
      includeUnowned: true,
      cloudConsentVersion: 'cloud-sync-2026-08',
      unownedConsentVersion: 'legacy-unowned-import-2026-08',
    }
    expect(store.account.resolveLegacyImportBatch({
      ...selection, candidateBatchId: 'must-not-replace-migrated-root',
    })).toBe('legacy-root-1')
    expect(store.account.resolveLegacyImportBatch({
      ...selection, selectionFingerprint: 'b'.repeat(64), candidateBatchId: 'legacy-root-2',
    })).toBe('legacy-root-2')
    expect(store.account.resolveLegacyImportBatch({
      ...selection, candidateBatchId: 'must-still-return-migrated-root',
    })).toBe('legacy-root-1')
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
