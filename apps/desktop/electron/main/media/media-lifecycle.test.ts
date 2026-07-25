import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import {
  lstat,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openAppDatabase } from '../database/client.js'
import {
  MediaLifecycle,
  type MediaLifecycleDatabase,
  type MediaLifecycleFileSystem,
} from './media-lifecycle.js'

const temporaryDirectories: string[] = []
const DAY = 24 * 60 * 60 * 1_000
const NOW = 2 * DAY

function setup() {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'autoforge-media-lifecycle-'))
  temporaryDirectories.push(dataDirectory)
  const mediaRoot = join(dataDirectory, 'media')
  mkdirSync(mediaRoot, { recursive: true })
  const database = openAppDatabase(join(dataDirectory, 'autoforge.sqlite'))
  return { database, mediaRoot }
}

function insertConversation(
  database: ReturnType<typeof openAppDatabase>,
  conversationId: string,
) {
  database.conversations.insert({
    id: conversationId,
    title: conversationId,
    createdAt: 1,
    updatedAt: 1,
  })
}

function insertAsset(
  database: ReturnType<typeof openAppDatabase>,
  input: {
    id: string
    conversationId: string
    relativePath: string
    status?: 'staging' | 'ready' | 'failed' | 'deleting'
    createdAt?: number
    messageId?: string
  },
) {
  const bytes = Buffer.from(input.id)
  return database.mediaAssets.insert({
    id: input.id,
    conversationId: input.conversationId,
    ...(input.messageId ? { messageId: input.messageId } : {}),
    source: 'upload',
    kind: 'image',
    mimeType: 'image/png',
    originalName: `${input.id}.png`,
    relativePath: input.relativePath,
    byteSize: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    status: input.status ?? 'ready',
    createdAt: input.createdAt ?? NOW,
    updatedAt: input.createdAt ?? NOW,
  })
}

function writeAsset(mediaRoot: string, conversationId: string, name: string, bytes: string) {
  const directory = join(mediaRoot, conversationId)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, name), bytes)
}

function databasePort(
  database: ReturnType<typeof openAppDatabase>,
  overrides: Partial<MediaLifecycleDatabase> = {},
): MediaLifecycleDatabase {
  return {
    conversations: database.conversations,
    mediaAssets: database.mediaAssets,
    clearConversations: database.clearConversations,
    ...overrides,
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('MediaLifecycle', () => {
  it('quarantines media before deleting database authority and purges afterward', async () => {
    const { database, mediaRoot } = setup()
    insertConversation(database, 'conversation_1')
    writeAsset(mediaRoot, 'conversation_1', 'asset.png', 'asset')
    const order: string[] = []
    const lifecycle = new MediaLifecycle({
      database: databasePort(database, {
        conversations: {
          ...database.conversations,
          delete(id) {
            expect(existsSync(join(mediaRoot, id))).toBe(false)
            expect(existsSync(join(mediaRoot, '.quarantine', `${id}.deleting`))).toBe(true)
            order.push('database')
            database.conversations.delete(id)
          },
        },
      }),
      mediaRoot,
      filesystem: {
        async rename(source, destination) {
          order.push('quarantine')
          await rename(source, destination)
        },
        async rm(path, options) {
          order.push('purge')
          await rm(path, options)
        },
      },
    })

    await lifecycle.deleteConversation('conversation_1')

    expect(order).toEqual(['quarantine', 'database', 'purge'])
    expect(database.conversations.get('conversation_1')).toBeUndefined()
    expect(existsSync(join(mediaRoot, 'conversation_1'))).toBe(false)
    expect(existsSync(join(mediaRoot, '.quarantine', 'conversation_1.deleting'))).toBe(false)
  })

  it('restores quarantined media when database deletion fails without leaking paths', async () => {
    const { database, mediaRoot } = setup()
    insertConversation(database, 'conversation_2')
    writeAsset(mediaRoot, 'conversation_2', 'asset.png', 'asset')
    const lifecycle = new MediaLifecycle({
      database: databasePort(database, {
        conversations: {
          ...database.conversations,
          delete() {
            throw new Error(`database unavailable at ${mediaRoot}`)
          },
        },
      }),
      mediaRoot,
    })

    const failure = await lifecycle.deleteConversation('conversation_2').catch((error) => error)

    expect(failure).toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(JSON.stringify(failure)).not.toContain(mediaRoot)
    expect(database.conversations.get('conversation_2')).toBeDefined()
    expect(existsSync(join(mediaRoot, 'conversation_2', 'asset.png'))).toBe(true)
    expect(existsSync(join(mediaRoot, '.quarantine', 'conversation_2.deleting'))).toBe(false)
  })

  it('marks ready rows failed when a database rollback cannot restore canonical media', async () => {
    const { database, mediaRoot } = setup()
    insertConversation(database, 'conversation_restore')
    writeAsset(mediaRoot, 'conversation_restore', 'asset_restore.png', 'asset_restore')
    insertAsset(database, {
      id: 'asset_restore',
      conversationId: 'conversation_restore',
      relativePath: 'conversation_restore/asset_restore.png',
    })
    let moves = 0
    const lifecycle = new MediaLifecycle({
      database: databasePort(database, {
        conversations: {
          ...database.conversations,
          delete() {
            throw new Error('database unavailable')
          },
        },
      }),
      mediaRoot,
      filesystem: {
        async rename(source, destination) {
          moves += 1
          if (moves === 2) throw new Error('restore unavailable')
          await rename(source, destination)
        },
      },
    })

    await expect(lifecycle.deleteConversation('conversation_restore'))
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR' })

    expect(database.mediaAssets.get('asset_restore')).toMatchObject({ status: 'failed' })
    expect(existsSync(join(mediaRoot, 'conversation_restore', 'asset_restore.png'))).toBe(false)
    expect(existsSync(join(mediaRoot, '.quarantine', 'conversation_restore.deleting'))).toBe(true)
  })

  it('honors database authority when deletion commits before reporting an error', async () => {
    const { database, mediaRoot } = setup()
    insertConversation(database, 'conversation_committed')
    writeAsset(mediaRoot, 'conversation_committed', 'asset.png', 'asset')
    const lifecycle = new MediaLifecycle({
      database: databasePort(database, {
        conversations: {
          ...database.conversations,
          delete(id) {
            database.conversations.delete(id)
            throw new Error('commit acknowledgement lost')
          },
        },
      }),
      mediaRoot,
    })

    await lifecycle.deleteConversation('conversation_committed')

    expect(database.conversations.get('conversation_committed')).toBeUndefined()
    expect(existsSync(join(mediaRoot, 'conversation_committed'))).toBe(false)
    expect(existsSync(join(mediaRoot, '.quarantine', 'conversation_committed.deleting'))).toBe(false)
  })

  it('quarantines every conversation before one clear transaction', async () => {
    const { database, mediaRoot } = setup()
    for (const id of ['conversation_a', 'conversation_b']) {
      insertConversation(database, id)
      writeAsset(mediaRoot, id, 'asset.png', id)
    }
    let clears = 0
    const lifecycle = new MediaLifecycle({
      database: databasePort(database, {
        clearConversations() {
          clears += 1
          for (const id of ['conversation_a', 'conversation_b']) {
            expect(existsSync(join(mediaRoot, id))).toBe(false)
            expect(existsSync(join(mediaRoot, '.quarantine', `${id}.deleting`))).toBe(true)
          }
          database.clearConversations()
        },
      }),
      mediaRoot,
    })

    await lifecycle.clearConversations()

    expect(clears).toBe(1)
    expect(database.conversations.list()).toEqual([])
    expect(existsSync(join(mediaRoot, '.quarantine', 'conversation_a.deleting'))).toBe(false)
    expect(existsSync(join(mediaRoot, '.quarantine', 'conversation_b.deleting'))).toBe(false)
  })

  it('restores all conversation directories when the clear transaction fails', async () => {
    const { database, mediaRoot } = setup()
    for (const id of ['conversation_a', 'conversation_b']) {
      insertConversation(database, id)
      writeAsset(mediaRoot, id, 'asset.png', id)
    }
    const lifecycle = new MediaLifecycle({
      database: databasePort(database, {
        clearConversations() {
          throw new Error('database unavailable')
        },
      }),
      mediaRoot,
    })

    await expect(lifecycle.clearConversations())
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR' })

    expect(database.conversations.list()).toHaveLength(2)
    for (const id of ['conversation_a', 'conversation_b']) {
      expect(await readFile(join(mediaRoot, id, 'asset.png'), 'utf8')).toBe(id)
      expect(existsSync(join(mediaRoot, '.quarantine', `${id}.deleting`))).toBe(false)
    }
  })

  it('reports a failed clear even when a live conversation has no media directory', async () => {
    const { database, mediaRoot } = setup()
    insertConversation(database, 'conversation_without_media')
    const lifecycle = new MediaLifecycle({
      database: databasePort(database, {
        clearConversations() {
          throw new Error('database unavailable')
        },
      }),
      mediaRoot,
    })

    await expect(lifecycle.clearConversations())
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR' })

    expect(database.conversations.get('conversation_without_media')).toBeDefined()
  })

  it('continues purging other quarantines after one post-commit purge fails', async () => {
    const { database, mediaRoot } = setup()
    for (const id of ['conversation_a', 'conversation_b']) {
      insertConversation(database, id)
      writeAsset(mediaRoot, id, 'asset.png', id)
    }
    let failed = false
    const lifecycle = new MediaLifecycle({
      database: databasePort(database),
      mediaRoot,
      filesystem: {
        async rm(path, options) {
          if (!failed && path.endsWith('conversation_a.deleting')) {
            failed = true
            throw new Error('busy')
          }
          await rm(path, options)
        },
      },
    })

    await lifecycle.clearConversations()

    expect(database.conversations.list()).toEqual([])
    expect(existsSync(join(mediaRoot, '.quarantine', 'conversation_a.deleting'))).toBe(true)
    expect(existsSync(join(mediaRoot, '.quarantine', 'conversation_b.deleting'))).toBe(false)
  })

  it('does not restore media when the clear transaction committed before reporting an error', async () => {
    const { database, mediaRoot } = setup()
    for (const id of ['conversation_a', 'conversation_b']) {
      insertConversation(database, id)
      writeAsset(mediaRoot, id, 'asset.png', id)
    }
    const lifecycle = new MediaLifecycle({
      database: databasePort(database, {
        clearConversations() {
          database.clearConversations()
          throw new Error('commit acknowledgement lost')
        },
      }),
      mediaRoot,
    })

    await lifecycle.clearConversations()

    expect(database.conversations.list()).toEqual([])
    for (const id of ['conversation_a', 'conversation_b']) {
      expect(existsSync(join(mediaRoot, id))).toBe(false)
      expect(existsSync(join(mediaRoot, '.quarantine', `${id}.deleting`))).toBe(false)
    }
  })

  it('recovers directory quarantines according to database authority', async () => {
    const { database, mediaRoot } = setup()
    insertConversation(database, 'conversation_live')
    mkdirSync(join(mediaRoot, '.quarantine', 'conversation_live.deleting'), { recursive: true })
    writeFileSync(join(mediaRoot, '.quarantine', 'conversation_live.deleting', 'asset.png'), 'live')
    mkdirSync(join(mediaRoot, '.quarantine', 'conversation_deleted.deleting'), { recursive: true })
    writeFileSync(join(mediaRoot, '.quarantine', 'conversation_deleted.deleting', 'asset.png'), 'deleted')

    await new MediaLifecycle({ database: databasePort(database), mediaRoot, now: () => NOW }).recover()

    expect(await readFile(join(mediaRoot, 'conversation_live', 'asset.png'), 'utf8')).toBe('live')
    expect(existsSync(join(mediaRoot, '.quarantine', 'conversation_live.deleting'))).toBe(false)
    expect(existsSync(join(mediaRoot, '.quarantine', 'conversation_deleted.deleting'))).toBe(false)
  })

  it('reconciles ready, non-ready, staging, tombstone, and old unclaimed media', async () => {
    const { database, mediaRoot } = setup()
    insertConversation(database, 'conversation_recovery')
    database.messages.insert({
      id: 'message_missing',
      conversationId: 'conversation_recovery',
      role: 'user',
      blocks: [],
      createdAt: 1,
    })
    insertAsset(database, {
      id: 'asset_missing',
      conversationId: 'conversation_recovery',
      relativePath: 'conversation_recovery/asset_missing.png',
      messageId: 'message_missing',
    })
    mkdirSync(join(mediaRoot, '.quarantine'), { recursive: true })
    for (const status of ['failed', 'deleting'] as const) {
      const id = `asset_${status}`
      const tombstone = `${id}.delete`
      insertAsset(database, {
        id,
        conversationId: 'conversation_recovery',
        relativePath: `.quarantine/${tombstone}`,
        status,
      })
      writeFileSync(join(mediaRoot, '.quarantine', tombstone), id)
    }
    writeFileSync(join(mediaRoot, '.quarantine', 'orphan.delete'), 'orphan')
    mkdirSync(join(mediaRoot, 'conversation_recovery', '.staging'), { recursive: true })
    writeFileSync(join(mediaRoot, 'conversation_recovery', '.staging', 'orphan.stage'), 'staging')
    insertAsset(database, {
      id: 'asset_old',
      conversationId: 'conversation_recovery',
      relativePath: 'conversation_recovery/asset_old.png',
      createdAt: NOW - DAY - 1,
    })
    writeAsset(mediaRoot, 'conversation_recovery', 'asset_old.png', 'asset_old')
    insertAsset(database, {
      id: 'asset_recent',
      conversationId: 'conversation_recovery',
      relativePath: 'conversation_recovery/asset_recent.png',
      createdAt: NOW - DAY + 1,
    })
    writeAsset(mediaRoot, 'conversation_recovery', 'asset_recent.png', 'asset_recent')

    await new MediaLifecycle({ database: databasePort(database), mediaRoot, now: () => NOW }).recover()

    expect(database.mediaAssets.get('asset_missing')).toMatchObject({ status: 'failed' })
    expect(database.mediaAssets.get('asset_failed')).toBeUndefined()
    expect(database.mediaAssets.get('asset_deleting')).toBeUndefined()
    expect(database.mediaAssets.get('asset_old')).toBeUndefined()
    expect(database.mediaAssets.get('asset_recent')).toMatchObject({ status: 'ready' })
    expect(existsSync(join(mediaRoot, 'conversation_recovery', 'asset_old.png'))).toBe(false)
    expect(existsSync(join(mediaRoot, 'conversation_recovery', 'asset_recent.png'))).toBe(true)
    expect(existsSync(join(mediaRoot, 'conversation_recovery', '.staging', 'orphan.stage'))).toBe(false)
    expect(existsSync(join(mediaRoot, '.quarantine', 'asset_failed.delete'))).toBe(false)
    expect(existsSync(join(mediaRoot, '.quarantine', 'asset_deleting.delete'))).toBe(false)
    expect(existsSync(join(mediaRoot, '.quarantine', 'orphan.delete'))).toBe(false)
  })

  it('preserves paused video generation jobs during recovery', async () => {
    const { database, mediaRoot } = setup()
    insertConversation(database, 'conversation_video')
    database.messages.insert({
      id: 'message_video',
      conversationId: 'conversation_video',
      role: 'assistant',
      blocks: [{
        type: 'media_generation',
        blockId: 'block_video',
        jobId: 'job_video',
        kind: 'video',
        status: 'paused',
      }],
      createdAt: 1,
    })
    database.mediaGenerationJobs.insert({
      id: 'job_video',
      conversationId: 'conversation_video',
      assistantMessageId: 'message_video',
      provider: 'openrouter',
      model: 'video-model',
      kind: 'video',
      providerJobId: 'provider_job_video',
      status: 'paused',
      parameters: {},
      createdAt: 1,
      updatedAt: 1,
    })

    await new MediaLifecycle({ database: databasePort(database), mediaRoot, now: () => NOW }).recover()

    expect(database.mediaGenerationJobs.get('job_video')).toMatchObject({ status: 'paused' })
    expect(database.messages.get('message_video')?.blocks).toContainEqual(
      expect.objectContaining({ jobId: 'job_video', status: 'paused' }),
    )
  })

  it('continues old-draft recovery when one database transition fails', async () => {
    const { database, mediaRoot } = setup()
    insertConversation(database, 'conversation_drafts')
    for (const id of ['asset_a', 'asset_b']) {
      insertAsset(database, {
        id,
        conversationId: 'conversation_drafts',
        relativePath: `conversation_drafts/${id}.png`,
        createdAt: NOW - DAY - 1,
      })
      writeAsset(mediaRoot, 'conversation_drafts', `${id}.png`, id)
    }
    const lifecycle = new MediaLifecycle({
      database: databasePort(database, {
        mediaAssets: {
          ...database.mediaAssets,
          update(id, patch) {
            if (id === 'asset_a' && patch.status === 'deleting') {
              throw new Error('database unavailable')
            }
            return database.mediaAssets.update(id, patch)
          },
        },
      }),
      mediaRoot,
      now: () => NOW,
    })

    await lifecycle.recover()

    expect(database.mediaAssets.get('asset_a')).toMatchObject({ status: 'ready' })
    expect(database.mediaAssets.get('asset_b')).toBeUndefined()
    expect(existsSync(join(mediaRoot, 'conversation_drafts', 'asset_a.png'))).toBe(true)
    expect(existsSync(join(mediaRoot, 'conversation_drafts', 'asset_b.png'))).toBe(false)
  })

  it('converges when the deleting transition commits before reporting an error', async () => {
    const { database, mediaRoot } = setup()
    insertConversation(database, 'conversation_update_ack')
    insertAsset(database, {
      id: 'asset_update_ack',
      conversationId: 'conversation_update_ack',
      relativePath: 'conversation_update_ack/asset_update_ack.png',
      createdAt: NOW - DAY - 1,
    })
    writeAsset(
      mediaRoot,
      'conversation_update_ack',
      'asset_update_ack.png',
      'asset_update_ack',
    )
    let loseAcknowledgement = true
    const lifecycle = new MediaLifecycle({
      database: databasePort(database, {
        mediaAssets: {
          ...database.mediaAssets,
          update(id, patch) {
            const updated = database.mediaAssets.update(id, patch)
            if (
              loseAcknowledgement
              && id === 'asset_update_ack'
              && patch.status === 'deleting'
            ) {
              loseAcknowledgement = false
              throw new Error('commit acknowledgement lost')
            }
            return updated
          },
        },
      }),
      mediaRoot,
      now: () => NOW,
    })

    await lifecycle.recover()
    expect(existsSync(join(
      mediaRoot,
      'conversation_update_ack',
      'asset_update_ack.png',
    ))).toBe(false)
    await lifecycle.recover()
    expect(database.mediaAssets.get('asset_update_ack')).toBeUndefined()
    expect(existsSync(join(
      mediaRoot,
      'conversation_update_ack',
      'asset_update_ack.png',
    ))).toBe(false)
    expect(existsSync(join(mediaRoot, '.quarantine'))).toBe(true)
    expect(
      (await lstat(join(mediaRoot, '.quarantine'))).isDirectory(),
    ).toBe(true)
    expect((await readdir(join(mediaRoot, '.quarantine')))
      .filter((name) => name.endsWith('.delete'))).toEqual([])
  })

  it('does not restore canonical bytes when asset deletion commits before throwing', async () => {
    const { database, mediaRoot } = setup()
    insertConversation(database, 'conversation_delete_ack')
    insertAsset(database, {
      id: 'asset_delete_ack',
      conversationId: 'conversation_delete_ack',
      relativePath: 'conversation_delete_ack/asset_delete_ack.png',
      createdAt: NOW - DAY - 1,
    })
    writeAsset(
      mediaRoot,
      'conversation_delete_ack',
      'asset_delete_ack.png',
      'asset_delete_ack',
    )
    let loseAcknowledgement = true
    const lifecycle = new MediaLifecycle({
      database: databasePort(database, {
        mediaAssets: {
          ...database.mediaAssets,
          delete(id) {
            database.mediaAssets.delete(id)
            if (loseAcknowledgement && id === 'asset_delete_ack') {
              loseAcknowledgement = false
              throw new Error('commit acknowledgement lost')
            }
          },
        },
      }),
      mediaRoot,
      now: () => NOW,
    })

    await lifecycle.recover()
    expect(existsSync(join(
      mediaRoot,
      'conversation_delete_ack',
      'asset_delete_ack.png',
    ))).toBe(false)
    await lifecycle.recover()
    expect(database.mediaAssets.get('asset_delete_ack')).toBeUndefined()
    expect(existsSync(join(
      mediaRoot,
      'conversation_delete_ack',
      'asset_delete_ack.png',
    ))).toBe(false)
    expect((await readdir(join(mediaRoot, '.quarantine')))
      .filter((name) => name.endsWith('.delete'))).toEqual([])
  })

  it('returns rollback bytes to their tombstone when restoring original metadata does not commit', async () => {
    const { database, mediaRoot } = setup()
    const conversationId = 'conversation_rollback_failed'
    const assetId = 'asset_rollback_failed'
    const relativePath = `${conversationId}/${assetId}.png`
    insertConversation(database, conversationId)
    insertAsset(database, {
      id: assetId,
      conversationId,
      relativePath,
      createdAt: NOW - DAY - 1,
    })
    writeAsset(mediaRoot, conversationId, `${assetId}.png`, assetId)
    let deleteAttempts = 0
    const lifecycle = new MediaLifecycle({
      database: databasePort(database, {
        mediaAssets: {
          ...database.mediaAssets,
          update(id, patch) {
            if (
              id === assetId
              && patch.status === 'ready'
              && patch.relativePath === relativePath
            ) throw new Error('rollback database unavailable')
            return database.mediaAssets.update(id, patch)
          },
          delete(id) {
            if (id === assetId && deleteAttempts++ === 0) {
              throw new Error('delete database unavailable')
            }
            database.mediaAssets.delete(id)
          },
        },
      }),
      mediaRoot,
      now: () => NOW,
    })

    await lifecycle.recover()

    const retained = database.mediaAssets.get(assetId)
    expect(retained).toMatchObject({
      status: 'deleting',
      relativePath: expect.stringMatching(/^\.quarantine\/.+\.delete$/),
    })
    expect(existsSync(join(mediaRoot, relativePath))).toBe(false)
    expect(existsSync(join(mediaRoot, retained!.relativePath!))).toBe(true)

    await lifecycle.recover()

    expect(database.mediaAssets.get(assetId)).toBeUndefined()
    expect(existsSync(join(mediaRoot, relativePath))).toBe(false)
    expect((await readdir(join(mediaRoot, '.quarantine')))
      .filter((name) => name.endsWith('.delete'))).toEqual([])
  })

  it('keeps canonical rollback bytes when restoring original metadata commits before throwing', async () => {
    const { database, mediaRoot } = setup()
    const conversationId = 'conversation_rollback_ack'
    const assetId = 'asset_rollback_ack'
    const relativePath = `${conversationId}/${assetId}.png`
    insertConversation(database, conversationId)
    insertAsset(database, {
      id: assetId,
      conversationId,
      relativePath,
      createdAt: NOW - DAY - 1,
    })
    writeAsset(mediaRoot, conversationId, `${assetId}.png`, assetId)
    let deleteAttempts = 0
    let loseRollbackAcknowledgement = true
    const lifecycle = new MediaLifecycle({
      database: databasePort(database, {
        mediaAssets: {
          ...database.mediaAssets,
          update(id, patch) {
            const updated = database.mediaAssets.update(id, patch)
            if (
              loseRollbackAcknowledgement
              && id === assetId
              && patch.status === 'ready'
              && patch.relativePath === relativePath
            ) {
              loseRollbackAcknowledgement = false
              throw new Error('rollback acknowledgement lost')
            }
            return updated
          },
          delete(id) {
            if (id === assetId && deleteAttempts++ === 0) {
              throw new Error('delete database unavailable')
            }
            database.mediaAssets.delete(id)
          },
        },
      }),
      mediaRoot,
      now: () => NOW,
    })

    await lifecycle.recover()

    expect(database.mediaAssets.get(assetId)).toMatchObject({
      status: 'ready',
      relativePath,
    })
    expect(existsSync(join(mediaRoot, relativePath))).toBe(true)

    await lifecycle.recover()

    expect(database.mediaAssets.get(assetId)).toBeUndefined()
    expect(existsSync(join(mediaRoot, relativePath))).toBe(false)
    expect((await readdir(join(mediaRoot, '.quarantine')))
      .filter((name) => name.endsWith('.delete'))).toEqual([])
  })

  it('fails closed on a symlinked conversation and does not expose its target path', async () => {
    const { database, mediaRoot } = setup()
    insertConversation(database, 'conversation_link')
    const outside = mkdtempSync(join(tmpdir(), 'autoforge-media-outside-'))
    temporaryDirectories.push(outside)
    const victim = join(outside, 'victim.txt')
    writeFileSync(victim, 'outside')
    await symlink(outside, join(mediaRoot, 'conversation_link'))

    const failure = await new MediaLifecycle({
      database: databasePort(database),
      mediaRoot,
    }).deleteConversation('conversation_link').catch((error) => error)

    expect(failure).toMatchObject({ code: 'MEDIA_IMPORT_FAILED' })
    expect(JSON.stringify(failure)).not.toContain(outside)
    expect(await readFile(victim, 'utf8')).toBe('outside')
    expect(database.conversations.get('conversation_link')).toBeDefined()
  })

  it('detects a source substitution race before changing database authority', async () => {
    const { database, mediaRoot } = setup()
    insertConversation(database, 'conversation_race')
    writeAsset(mediaRoot, 'conversation_race', 'asset_race.png', 'asset_race')
    insertAsset(database, {
      id: 'asset_race',
      conversationId: 'conversation_race',
      relativePath: 'conversation_race/asset_race.png',
    })
    const outside = mkdtempSync(join(tmpdir(), 'autoforge-media-race-outside-'))
    temporaryDirectories.push(outside)
    const victim = join(outside, 'victim.txt')
    writeFileSync(victim, 'outside')
    let swapped = false
    const filesystem: Partial<MediaLifecycleFileSystem> = {
      async rename(source, destination) {
        if (!swapped && source.endsWith('conversation_race')) {
          swapped = true
          await rm(source, { recursive: true })
          await symlink(outside, source)
        }
        await rename(source, destination)
      },
    }

    await expect(new MediaLifecycle({
      database: databasePort(database),
      mediaRoot,
      filesystem,
    }).deleteConversation('conversation_race')).rejects.toMatchObject({
      code: 'MEDIA_IMPORT_FAILED',
    })

    expect(await readFile(victim, 'utf8')).toBe('outside')
    expect(database.conversations.get('conversation_race')).toBeDefined()
    expect(database.mediaAssets.get('asset_race')).toMatchObject({ status: 'failed' })
  })

  it('never follows symlinks while recovering staging and quarantine residue', async () => {
    const { database, mediaRoot } = setup()
    insertConversation(database, 'conversation_symlink_recovery')
    const outside = mkdtempSync(join(tmpdir(), 'autoforge-media-recovery-outside-'))
    temporaryDirectories.push(outside)
    const victim = join(outside, 'victim.txt')
    writeFileSync(victim, 'outside')
    mkdirSync(join(mediaRoot, 'conversation_symlink_recovery', '.staging'), { recursive: true })
    mkdirSync(join(mediaRoot, '.quarantine'), { recursive: true })
    await symlink(victim, join(mediaRoot, 'conversation_symlink_recovery', '.staging', 'orphan.stage'))
    await symlink(outside, join(mediaRoot, '.quarantine', 'orphan.delete'))

    await new MediaLifecycle({ database: databasePort(database), mediaRoot, now: () => NOW }).recover()

    expect(await readFile(victim, 'utf8')).toBe('outside')
    expect((await lstat(join(mediaRoot, 'conversation_symlink_recovery', '.staging', 'orphan.stage'))).isSymbolicLink()).toBe(true)
    expect((await lstat(join(mediaRoot, '.quarantine', 'orphan.delete'))).isSymbolicLink()).toBe(true)
  })

  it('rejects a symlinked media root before recovery touches its target', async () => {
    const { database, mediaRoot } = setup()
    rmSync(mediaRoot, { recursive: true })
    const outside = mkdtempSync(join(tmpdir(), 'autoforge-media-root-outside-'))
    temporaryDirectories.push(outside)
    const victim = join(outside, 'victim.txt')
    writeFileSync(victim, 'outside')
    await symlink(outside, mediaRoot)

    await expect(new MediaLifecycle({
      database: databasePort(database),
      mediaRoot,
      now: () => NOW,
    }).recover()).rejects.toMatchObject({ code: 'MEDIA_IMPORT_FAILED' })

    expect(await readFile(victim, 'utf8')).toBe('outside')
    expect(existsSync(join(outside, '.quarantine'))).toBe(false)
  })
})
