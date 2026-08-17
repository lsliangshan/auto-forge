import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { type ConversationGenerationPreferences } from '@autoforge/shared'
import { openAppDatabase } from './client.js'
import { resolveMigrationDirectory } from './migrations.js'

const temporaryDirectories: string[] = []

function openTestDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'autoforge-database-'))
  temporaryDirectories.push(directory)
  return openAppDatabase(join(directory, 'autoforge.sqlite'))
}

function createV1Database() {
  const directory = mkdtempSync(join(tmpdir(), 'autoforge-database-v1-'))
  temporaryDirectories.push(directory)
  const path = join(directory, 'autoforge.sqlite')
  const sqlite = new Database(path)
  sqlite.exec(readFileSync(fileURLToPath(new URL('../../../resources/migrations/0001_init.sql', import.meta.url)), 'utf8'))
  sqlite.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (1, 1)').run()
  sqlite.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run('conversation_v1', 'Persisted v1', 1, 1)
  sqlite.prepare('INSERT INTO messages (id, conversation_id, role, blocks_json, created_at) VALUES (?, ?, ?, ?, ?)').run('message_v1', 'conversation_v1', 'user', JSON.stringify([{ type: 'text', text: 'before upgrade' }]), 1)
  sqlite.close()
  return openAppDatabase(path)
}

function createV3Database() {
  const directory = mkdtempSync(join(tmpdir(), 'autoforge-database-v3-'))
  temporaryDirectories.push(directory)
  const path = join(directory, 'autoforge.sqlite')
  const sqlite = new Database(path)
  for (const [index, fileName] of [
    '0001_init.sql',
    '0002_multimodal_media.sql',
    '0003_conversation_context.sql',
  ].entries()) {
    sqlite.exec(readFileSync(fileURLToPath(new URL(`../../../resources/migrations/${fileName}`, import.meta.url)), 'utf8'))
    sqlite.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(index + 1, index + 1)
  }
  sqlite.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('conversation_v3', 'Persisted v3', 1, 1)
  sqlite.prepare('INSERT INTO messages (id, conversation_id, role, blocks_json, ordinal, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('message_v3', 'conversation_v3', 'user', JSON.stringify([{ type: 'text', text: 'before auth' }]), 1, 1)
  sqlite.close()
  return openAppDatabase(path)
}

const defaultConversationGenerationPreferences: ConversationGenerationPreferences = {
  outputType: 'auto',
  models: {},
  generation: {
    image: { count: 1, resolution: '1K', aspectRatio: 'auto', format: 'png' },
    audio: { format: 'mp3' },
    video: { durationSeconds: 5, resolution: '720p', aspectRatio: 'auto', generateAudio: false },
  },
}

function readyAsset(id: string, conversationId: string) {
  return {
    id,
    conversationId,
    source: 'upload' as const,
    kind: 'image' as const,
    mimeType: 'image/png',
    originalName: `${id}.png`,
    relativePath: `${conversationId}/${id}.png`,
    byteSize: 12,
    sha256: 'a'.repeat(64),
    status: 'ready' as const,
    createdAt: 1,
    updatedAt: 1,
  }
}

function readyVideoAsset(id: string, conversationId: string) {
  return {
    ...readyAsset(id, conversationId),
    kind: 'video' as const,
    mimeType: 'video/mp4',
    originalName: `${id}.mp4`,
    relativePath: `${conversationId}/${id}.mp4`,
  }
}

type ReadyAssetFixture = Omit<ReturnType<typeof readyAsset>, 'source'> & {
  source: 'upload' | 'generated'
  width?: number
  height?: number
  durationMs?: number
}

function mediaBlockForAsset(asset: ReadyAssetFixture, blockId: string, purpose: 'input' | 'output') {
  return {
    type: 'media' as const,
    blockId,
    assetId: asset.id,
    kind: asset.kind,
    purpose,
    name: asset.originalName,
    mimeType: asset.mimeType,
    byteSize: asset.byteSize,
    ...(asset.width === undefined ? {} : { width: asset.width }),
    ...(asset.height === undefined ? {} : { height: asset.height }),
    ...(asset.durationMs === undefined ? {} : { durationMs: asset.durationMs }),
  }
}

const mediaMetadataMismatches = [
  ['kind', { kind: 'audio' as const }],
  ['MIME type', { mimeType: 'image/jpeg' }],
  ['byte size', { byteSize: 13 }],
  ['display name', { name: 'other.png' }],
  ['width', { width: 321 }],
  ['height', { height: 241 }],
  ['duration', { durationMs: undefined }],
] as const

function mediaMessage(id: string, conversationId: string, assetId: string) {
  return {
    id,
    conversationId,
    role: 'user',
    blocks: [{
      type: 'media' as const,
      blockId: `${id}_block`,
      assetId,
      kind: 'image' as const,
      purpose: 'input' as const,
      name: `${assetId}.png`,
      mimeType: 'image/png',
      byteSize: 12,
    }],
    createdAt: 1,
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('openAppDatabase', () => {
  it('packages migrations where the migration runner resolves them', () => {
    const configPath = fileURLToPath(new URL('../../../electron-builder.yml', import.meta.url))
    const config = readFileSync(configPath, 'utf8')

    expect(config).toContain('extraResources:\n  - from: resources/migrations\n    to: migrations')
  })

  it('resolves source migrations from the bundled main module location in development', () => {
    const bundledMainUrl = new URL('../../../out/main/index.js', import.meta.url).href
    expect(resolveMigrationDirectory(bundledMainUrl, '')).toBe(
      fileURLToPath(new URL('../../../resources/migrations/', import.meta.url)),
    )
  })

  it('migrates a fresh database and interrupts abandoned executions', () => {
    const database = openTestDatabase()

    database.executions.insert({
      id: 'exec_1',
      status: 'running',
      workflowId: 'w',
      workflowVersion: '1.0.0',
    })

    expect(database.schemaVersion()).toBe(4)
    expect(database.executions.markInterrupted()).toBe(1)
    expect(database.executions.get('exec_1')?.status).toBe('interrupted')
  })

  it('upgrades a populated v1 database without losing conversations or messages', () => {
    const database = createV1Database()

    expect(database.schemaVersion()).toBe(4)
    expect(database.conversations.get('conversation_v1')).toMatchObject({ title: 'Persisted v1' })
    expect(database.messages.get('message_v1')).toMatchObject({
      blocks: [{ type: 'text', text: 'before upgrade' }],
      ordinal: 1,
    })
  })

  it('upgrades a populated v3 database without losing business data', () => {
    const database = createV3Database()

    expect(database.schemaVersion()).toBe(4)
    expect(database.conversations.get('conversation_v3')).toMatchObject({ title: 'Persisted v3' })
    expect(database.messages.get('message_v3')).toMatchObject({
      blocks: [{ type: 'text', text: 'before auth' }],
      ordinal: 1,
    })
  })

  it('stores local users and one persistent authentication session', () => {
    const database = openTestDatabase()
    const user = {
      id: 'user_1', account: 'Alice', accountNormalized: 'alice',
      passwordDigest: 'digest', createdAt: 10, updatedAt: 10,
    }

    expect(database.localAuth.createUserAndSession(user, 11)).toMatchObject({
      user: { id: 'user_1', account: 'Alice' }, authenticatedAt: 11,
    })
    expect(database.localAuth.findUserByNormalizedAccount('alice')).toEqual(user)
    expect(database.localAuth.getCurrentSession()).toMatchObject({ user: { id: 'user_1' } })
    database.localAuth.clearSession()
    database.localAuth.clearSession()
    expect(database.localAuth.getCurrentSession()).toBeUndefined()
  })

  it('rejects a case-insensitive duplicate without replacing the current session', () => {
    const database = openTestDatabase()
    database.localAuth.createUserAndSession({
      id: 'user_1', account: 'Alice', accountNormalized: 'alice',
      passwordDigest: 'digest-1', createdAt: 10, updatedAt: 10,
    }, 11)

    expect(database.localAuth.createUserAndSession({
      id: 'user_2', account: 'ALICE', accountNormalized: 'alice',
      passwordDigest: 'digest-2', createdAt: 12, updatedAt: 12,
    }, 13)).toBeUndefined()
    expect(database.localAuth.getCurrentSession()?.user.id).toBe('user_1')
  })

  it('backfills insertion order and allocates independent conversation ordinals', () => {
    const database = openTestDatabase()
    database.conversations.insert({ id: 'c1', title: 'One' })
    database.conversations.insert({ id: 'c2', title: 'Two' })
    database.messages.insert({
      id: 'z-user', conversationId: 'c1', role: 'user',
      blocks: [{ type: 'text', text: 'first' }], createdAt: 10,
    })
    database.messages.insert({
      id: 'a-assistant', conversationId: 'c1', role: 'assistant',
      blocks: [{ type: 'text', text: 'second' }], createdAt: 10,
    })
    database.messages.insert({
      id: 'other', conversationId: 'c2', role: 'user',
      blocks: [{ type: 'text', text: 'independent' }], createdAt: 10,
    })

    expect(database.messages.listForConversation('c1').map(({ id, ordinal }) => ({ id, ordinal })))
      .toEqual([{ id: 'z-user', ordinal: 1 }, { id: 'a-assistant', ordinal: 2 }])
    expect(database.messages.listBeforeOrdinal('c1', 2).map(({ id, ordinal }) => ({ id, ordinal })))
      .toEqual([{ id: 'z-user', ordinal: 1 }])
    expect(database.messages.get('other')?.ordinal).toBe(1)
  })

  it('advances a summary atomically from the expected checkpoint', () => {
    const database = openTestDatabase()
    database.conversations.insert({ id: 'context-c', title: 'Context' })

    expect(database.conversationContexts.get('context-c')).toBeUndefined()
    expect(database.conversationContexts.advance({
      conversationId: 'context-c', expectedThroughOrdinal: 0,
      summaryText: 'Known fact', throughOrdinal: 2,
      estimatedTokens: 4, updatedAt: 20,
    })).toMatchObject({ summaryText: 'Known fact', throughOrdinal: 2 })
    expect(() => database.conversationContexts.advance({
      conversationId: 'context-c', expectedThroughOrdinal: 0,
      summaryText: 'stale', throughOrdinal: 3,
      estimatedTokens: 2, updatedAt: 21,
    })).toThrow('Conversation context checkpoint changed')

    database.conversations.delete('context-c')
    expect(database.conversationContexts.get('context-c')).toBeUndefined()
  })

  it('recovers every nonterminal execution and chat run without claiming success', () => {
    const database = openTestDatabase()
    database.conversations.insert({ id: 'recovery_conversation', title: 'Recovery' })
    for (const status of ['queued', 'awaiting_approval', 'running']) {
      database.executions.insert({
        id: `execution_${status}`, status, workflowId: 'workflow', workflowVersion: '1.0.0',
      })
      database.chatRuns.insert({
        id: `run_${status}`, conversationId: 'recovery_conversation', requestId: `request_${status}`,
        model: 'model', status, startedAt: 1,
      })
    }

    expect(database.recoverInterrupted()).toEqual({ executions: 3, chatRuns: 3 })
    for (const status of ['queued', 'awaiting_approval', 'running']) {
      expect(database.executions.get(`execution_${status}`)).toMatchObject({ status: 'interrupted' })
      expect(database.chatRuns.get(`run_${status}`)).toMatchObject({ status: 'failed', errorCode: 'INTERNAL_ERROR' })
    }
  })

  it('persists JSON message blocks in chronological order and cascades deletion', () => {
    const database = openTestDatabase()
    database.conversations.insert({ id: 'conversation_1', title: 'First conversation' })
    database.messages.insert({
      id: 'message_1',
      conversationId: 'conversation_1',
      role: 'user',
      blocks: [{ type: 'text', text: 'first' }],
      createdAt: 10,
    })
    database.messages.insert({
      id: 'message_2',
      conversationId: 'conversation_1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'second' }],
      createdAt: 20,
    })

    expect(database.messages.listForConversation('conversation_1').map((message) => message.id))
      .toEqual(['message_1', 'message_2'])

    database.conversations.delete('conversation_1')
    expect(database.messages.listForConversation('conversation_1')).toEqual([])
  })

  it('persists media ownership and generation preferences with the Task 1 schema', () => {
    const database = openTestDatabase()
    database.conversations.insert({ id: 'conversation_media', title: 'Media' })
    database.mediaAssets.insert(readyAsset('asset_media', 'conversation_media'))

    database.messages.insertWithAssets(
      mediaMessage('message_media', 'conversation_media', 'asset_media'),
      ['asset_media'],
    )
    const updated = database.conversations.updateGenerationPreferences(
      'conversation_media',
      defaultConversationGenerationPreferences,
    )

    expect(database.mediaAssets.get('asset_media')?.messageId).toBe('message_media')
    expect(updated?.generationPreferences).toEqual(defaultConversationGenerationPreferences)
    expect(database.conversations.get('conversation_media')?.generationPreferences).toEqual(defaultConversationGenerationPreferences)
  })

  it.each([
    ['a cross-conversation asset', (database: ReturnType<typeof openTestDatabase>) => {
      database.conversations.insert({ id: 'conversation_other', title: 'Other' })
      database.mediaAssets.insert(readyAsset('asset_other', 'conversation_other'))
      return 'asset_other'
    }],
    ['an already claimed asset', (database: ReturnType<typeof openTestDatabase>) => {
      database.mediaAssets.insert(readyAsset('asset_claimed', 'conversation_claims'))
      database.messages.insertWithAssets(
        mediaMessage('message_claimed', 'conversation_claims', 'asset_claimed'),
        ['asset_claimed'],
      )
      return 'asset_claimed'
    }],
    ['an asset that is not ready', (database: ReturnType<typeof openTestDatabase>) => {
      database.mediaAssets.insert({ ...readyAsset('asset_staging', 'conversation_claims'), status: 'staging' })
      return 'asset_staging'
    }],
  ])('rolls back a message when it claims %s', (_description, setup) => {
    const database = openTestDatabase()
    database.conversations.insert({ id: 'conversation_claims', title: 'Claims' })
    const assetId = setup(database)

    expect(() => database.messages.insertWithAssets(
      mediaMessage(`message_${assetId}`, 'conversation_claims', assetId),
      [assetId],
    )).toThrow()

    expect(database.messages.get(`message_${assetId}`)).toBeUndefined()
    expect(database.mediaAssets.get(assetId)?.messageId).not.toBe(`message_${assetId}`)
  })

  it('cascades media assets and generation jobs when deleting a conversation', () => {
    const database = openTestDatabase()
    database.conversations.insert({ id: 'conversation_cascade', title: 'Cascade' })
    database.messages.insert({
      id: 'message_cascade', conversationId: 'conversation_cascade', role: 'assistant',
      blocks: [{ type: 'media_generation', blockId: 'block_cascade', jobId: 'job_cascade', kind: 'video', status: 'pending' }], createdAt: 1,
    })
    database.mediaAssets.insert(readyAsset('asset_cascade', 'conversation_cascade'))
    database.mediaGenerationJobs.insert({
      id: 'job_cascade', conversationId: 'conversation_cascade', assistantMessageId: 'message_cascade',
      provider: 'openrouter', model: 'video-model', kind: 'video', providerJobId: 'provider_job_cascade',
      status: 'pending', parameters: { prompt: 'cascade' }, createdAt: 1, updatedAt: 1,
    })

    database.conversations.delete('conversation_cascade')

    expect(database.mediaAssets.get('asset_cascade')).toBeUndefined()
    expect(database.mediaGenerationJobs.get('job_cascade')).toBeUndefined()
  })

  it('lists only due resumable video generation job statuses', () => {
    const database = openTestDatabase()
    database.conversations.insert({ id: 'conversation_jobs', title: 'Jobs' })
    database.messages.insert({ id: 'message_jobs', conversationId: 'conversation_jobs', role: 'assistant', blocks: [], createdAt: 1 })
    for (const status of ['pending', 'in_progress', 'downloading', 'paused', 'completed', 'failed'] as const) {
      database.mediaGenerationJobs.insert({
        id: `job_${status}`, conversationId: 'conversation_jobs', assistantMessageId: 'message_jobs',
        provider: 'openrouter', model: 'video-model', kind: 'video', providerJobId: `provider_${status}`,
        status, parameters: {}, nextPollAt: 10, createdAt: 1, updatedAt: 1,
      })
    }
    database.mediaGenerationJobs.insert({
      id: 'job_later', conversationId: 'conversation_jobs', assistantMessageId: 'message_jobs',
      provider: 'openrouter', model: 'video-model', kind: 'video', providerJobId: 'provider_later',
      status: 'pending', parameters: {}, nextPollAt: 11, createdAt: 1, updatedAt: 1,
    })

    expect(database.mediaGenerationJobs.listResumable(10).map((job) => job.id))
      .toEqual(['job_downloading', 'job_in_progress', 'job_pending'])
  })

  it('replaces a media generation block in place only with a valid matching block', () => {
    const database = openTestDatabase()
    database.conversations.insert({ id: 'conversation_blocks', title: 'Blocks' })
    database.messages.insert({
      id: 'message_blocks', conversationId: 'conversation_blocks', role: 'assistant', createdAt: 1,
      blocks: [{ type: 'media_generation', blockId: 'block_video', jobId: 'job_video', kind: 'video', status: 'downloading' }],
    })
    database.mediaAssets.insert({ ...readyVideoAsset('asset_video', 'conversation_blocks'), source: 'generated' })

    database.messages.replaceBlock('message_blocks', 'block_video', {
      type: 'media', blockId: 'block_video', assetId: 'asset_video', kind: 'video', purpose: 'output',
      name: 'asset_video.mp4', mimeType: 'video/mp4', byteSize: 12,
    })

    expect(database.messages.get('message_blocks')?.blocks).toEqual([{
      type: 'media', blockId: 'block_video', assetId: 'asset_video', kind: 'video', purpose: 'output',
      name: 'asset_video.mp4', mimeType: 'video/mp4', byteSize: 12,
    }])
    expect(() => database.messages.replaceBlock('message_blocks', 'block_video', {
      type: 'media', blockId: 'different_block', assetId: 'asset_video', kind: 'video', purpose: 'output',
      name: 'asset_video.mp4', mimeType: 'video/mp4', byteSize: 12,
    })).toThrow()
    expect(() => database.messages.replaceBlock('message_blocks', 'block_video', {
      type: 'media', blockId: 'block_video', assetId: 'asset_video', kind: 'video', purpose: 'output',
      name: '', mimeType: 'video/mp4', byteSize: 12,
    })).toThrow()
  })

  it.each(['pending', 'in_progress', 'downloading'] as const)(
    'claims a ready output media asset when replacing an active %s generation block',
    (status) => {
      const database = openTestDatabase()
      database.conversations.insert({ id: 'conversation_output', title: 'Output' })
      database.messages.insert({
        id: 'message_output', conversationId: 'conversation_output', role: 'assistant', createdAt: 1,
        blocks: [{ type: 'media_generation', blockId: 'block_output', jobId: 'job_output', kind: 'image', status }],
      })
      database.mediaAssets.insert({ ...readyAsset('asset_output', 'conversation_output'), source: 'generated' })

      database.messages.replaceBlock('message_output', 'block_output', {
        type: 'media', blockId: 'block_output', assetId: 'asset_output', kind: 'image', purpose: 'output',
        name: 'asset_output.png', mimeType: 'image/png', byteSize: 12,
      })

      expect(database.mediaAssets.get('asset_output')?.messageId).toBe('message_output')
    },
  )

  it.each(['failed', 'paused'] as const)(
    'rejects output media that arrives after a generation block is %s',
    (status) => {
      const database = openTestDatabase()
      database.conversations.insert({ id: 'conversation_late_output', title: 'Late output' })
      const generation = {
        type: 'media_generation' as const,
        blockId: 'block_late_output',
        jobId: 'job_late_output',
        kind: 'image' as const,
        status,
        ...(status === 'failed' ? { errorCode: 'CANCELLED' as const } : {}),
      }
      database.messages.insert({
        id: 'message_late_output',
        conversationId: 'conversation_late_output',
        role: 'assistant',
        createdAt: 1,
        blocks: [generation],
      })
      database.mediaAssets.insert({
        ...readyAsset('asset_late_output', 'conversation_late_output'),
        source: 'generated',
      })

      expect(() => database.messages.replaceBlock('message_late_output', 'block_late_output', {
        type: 'media',
        blockId: 'block_late_output',
        assetId: 'asset_late_output',
        kind: 'image',
        purpose: 'output',
        name: 'asset_late_output.png',
        mimeType: 'image/png',
        byteSize: 12,
      })).toThrow()

      expect(database.messages.get('message_late_output')?.blocks).toEqual([generation])
      expect(database.mediaAssets.get('asset_late_output')?.messageId).toBeUndefined()
    },
  )

  it('keeps replacing an output media block with the same claimed asset idempotent', () => {
    const database = openTestDatabase()
    database.conversations.insert({ id: 'conversation_output_retry', title: 'Output retry' })
    const output = {
      type: 'media' as const,
      blockId: 'block_output_retry',
      assetId: 'asset_output_retry',
      kind: 'image' as const,
      purpose: 'output' as const,
      name: 'asset_output_retry.png',
      mimeType: 'image/png',
      byteSize: 12,
    }
    database.messages.insert({
      id: 'message_output_retry',
      conversationId: 'conversation_output_retry',
      role: 'assistant',
      createdAt: 1,
      blocks: [{
        type: 'media_generation',
        blockId: 'block_output_retry',
        jobId: 'job_output_retry',
        kind: 'image',
        status: 'in_progress',
      }],
    })
    database.mediaAssets.insert({
      ...readyAsset('asset_output_retry', 'conversation_output_retry'),
      source: 'generated',
    })
    database.messages.replaceBlock('message_output_retry', 'block_output_retry', output)

    database.messages.replaceBlock('message_output_retry', 'block_output_retry', output)

    expect(database.messages.get('message_output_retry')?.blocks).toEqual([output])
    expect(database.mediaAssets.get('asset_output_retry')?.messageId).toBe('message_output_retry')
  })

  it.each([
    ['a missing output asset', () => 'asset_missing'],
    ['an output asset that is not ready', (database: ReturnType<typeof openTestDatabase>) => {
      database.mediaAssets.insert({ ...readyAsset('asset_output_staging', 'conversation_replace'), source: 'generated', status: 'staging' })
      return 'asset_output_staging'
    }],
    ['a cross-conversation output asset', (database: ReturnType<typeof openTestDatabase>) => {
      database.conversations.insert({ id: 'conversation_replace_other', title: 'Other' })
      database.mediaAssets.insert({ ...readyAsset('asset_output_other', 'conversation_replace_other'), source: 'generated' })
      return 'asset_output_other'
    }],
    ['an already claimed output asset', (database: ReturnType<typeof openTestDatabase>) => {
      database.messages.insert({ id: 'message_output_owner', conversationId: 'conversation_replace', role: 'assistant', blocks: [], createdAt: 1 })
      database.mediaAssets.insert({ ...readyAsset('asset_output_claimed', 'conversation_replace'), source: 'generated', messageId: 'message_output_owner' })
      return 'asset_output_claimed'
    }],
  ])('rolls back block replacement for %s', (_description, setup) => {
    const database = openTestDatabase()
    database.conversations.insert({ id: 'conversation_replace', title: 'Replace' })
    database.messages.insert({
      id: 'message_replace', conversationId: 'conversation_replace', role: 'assistant', createdAt: 1,
      blocks: [{ type: 'media_generation', blockId: 'block_replace', jobId: 'job_replace', kind: 'image', status: 'in_progress' }],
    })
    const assetId = setup(database)

    expect(() => database.messages.replaceBlock('message_replace', 'block_replace', {
      type: 'media', blockId: 'block_replace', assetId, kind: 'image', purpose: 'output',
      name: 'replacement.png', mimeType: 'image/png', byteSize: 12,
    })).toThrow()
    expect(database.messages.get('message_replace')?.blocks).toEqual([
      { type: 'media_generation', blockId: 'block_replace', jobId: 'job_replace', kind: 'image', status: 'in_progress' },
    ])
    expect(database.mediaAssets.get(assetId)?.messageId).not.toBe('message_replace')
  })

  it.each([
    ['a missing asset ID', () => ({ assetIds: [], blocks: mediaMessage('message_missing', 'conversation_asset_binding', 'asset_binding').blocks })],
    ['an extra asset ID', () => ({ assetIds: ['asset_binding'], blocks: [] })],
    ['a mismatched asset ID', (database: ReturnType<typeof openTestDatabase>) => {
      database.mediaAssets.insert(readyAsset('asset_binding_other', 'conversation_asset_binding'))
      return { assetIds: ['asset_binding_other'], blocks: mediaMessage('message_mismatch', 'conversation_asset_binding', 'asset_binding').blocks }
    }],
    ['a duplicate block asset ID', () => {
      const blocks = mediaMessage('message_duplicate_block', 'conversation_asset_binding', 'asset_binding').blocks
      return { assetIds: ['asset_binding'], blocks: [...blocks, { ...blocks[0], blockId: 'duplicate_block' }] }
    }],
    ['a duplicate supplied asset ID', () => ({ assetIds: ['asset_binding', 'asset_binding'], blocks: mediaMessage('message_duplicate_id', 'conversation_asset_binding', 'asset_binding').blocks })],
  ])('does not persist a message with %s', (_description, setup) => {
    const database = openTestDatabase()
    database.conversations.insert({ id: 'conversation_asset_binding', title: 'Binding' })
    database.mediaAssets.insert(readyAsset('asset_binding', 'conversation_asset_binding'))
    const { assetIds, blocks } = setup(database)

    expect(() => database.messages.insertWithAssets({
      id: 'message_asset_binding', conversationId: 'conversation_asset_binding', role: 'user', blocks, createdAt: 1,
    }, assetIds)).toThrow()
    expect(database.messages.get('message_asset_binding')).toBeUndefined()
    expect(database.mediaAssets.listForConversation('conversation_asset_binding').every((asset) => asset.messageId === undefined)).toBe(true)
  })

  it.each(mediaMetadataMismatches)('rolls back an input claim with mismatched %s metadata', (_description, mismatch) => {
    const database = openTestDatabase()
    const asset = { ...readyAsset('asset_input_metadata', 'conversation_input_metadata'), width: 320, height: 240, durationMs: 1_000 }
    database.conversations.insert({ id: 'conversation_input_metadata', title: 'Input metadata' })
    database.mediaAssets.insert(asset)

    expect(() => database.messages.insertWithAssets({
      id: 'message_input_metadata', conversationId: 'conversation_input_metadata', role: 'user', createdAt: 1,
      blocks: [{ ...mediaBlockForAsset(asset, 'block_input_metadata', 'input'), ...mismatch }],
    }, [asset.id])).toThrow()

    expect(database.messages.get('message_input_metadata')).toBeUndefined()
    expect(database.mediaAssets.get(asset.id)?.messageId).toBeUndefined()
  })

  it.each(mediaMetadataMismatches)('rolls back a replacement claim with mismatched %s metadata', (_description, mismatch) => {
    const database = openTestDatabase()
    const asset = { ...readyAsset('asset_replacement_metadata', 'conversation_replacement_metadata'), source: 'generated' as const, width: 320, height: 240, durationMs: 1_000 }
    database.conversations.insert({ id: 'conversation_replacement_metadata', title: 'Replacement metadata' })
    database.messages.insert({
      id: 'message_replacement_metadata', conversationId: 'conversation_replacement_metadata', role: 'assistant', createdAt: 1,
      blocks: [{ type: 'media_generation', blockId: 'block_replacement_metadata', jobId: 'job_replacement_metadata', kind: 'image', status: 'in_progress' }],
    })
    database.mediaAssets.insert(asset)

    expect(() => database.messages.replaceBlock('message_replacement_metadata', 'block_replacement_metadata', {
      ...mediaBlockForAsset(asset, 'block_replacement_metadata', 'output'),
      ...mismatch,
    })).toThrow()

    expect(database.messages.get('message_replacement_metadata')?.blocks).toEqual([
      { type: 'media_generation', blockId: 'block_replacement_metadata', jobId: 'job_replacement_metadata', kind: 'image', status: 'in_progress' },
    ])
    expect(database.mediaAssets.get(asset.id)?.messageId).toBeUndefined()
  })

  it('rejects cross-conversation media generation job message and asset links without mutation', () => {
    const database = openTestDatabase()
    database.conversations.insert({ id: 'conversation_job_a', title: 'Job A' })
    database.conversations.insert({ id: 'conversation_job_b', title: 'Job B' })
    database.messages.insert({ id: 'message_job_a', conversationId: 'conversation_job_a', role: 'assistant', blocks: [], createdAt: 1 })
    database.messages.insert({ id: 'message_job_b', conversationId: 'conversation_job_b', role: 'assistant', blocks: [], createdAt: 1 })
    database.mediaAssets.insert({ ...readyAsset('asset_job_b', 'conversation_job_b'), source: 'generated' })

    expect(() => database.mediaGenerationJobs.insert({
      id: 'job_bad_message', conversationId: 'conversation_job_a', assistantMessageId: 'message_job_b',
      provider: 'openrouter', model: 'video-model', kind: 'video', providerJobId: 'provider_bad_message',
      status: 'pending', parameters: {}, createdAt: 1, updatedAt: 1,
    })).toThrow()
    expect(() => database.mediaGenerationJobs.insert({
      id: 'job_bad_asset', conversationId: 'conversation_job_a', assistantMessageId: 'message_job_a',
      provider: 'openrouter', model: 'video-model', kind: 'video', providerJobId: 'provider_bad_asset',
      status: 'pending', parameters: {}, assetId: 'asset_job_b', createdAt: 1, updatedAt: 1,
    })).toThrow()
    database.mediaGenerationJobs.insert({
      id: 'job_update_asset', conversationId: 'conversation_job_a', assistantMessageId: 'message_job_a',
      provider: 'openrouter', model: 'video-model', kind: 'video', providerJobId: 'provider_update_asset',
      status: 'pending', parameters: {}, createdAt: 1, updatedAt: 1,
    })
    expect(() => database.mediaGenerationJobs.update('job_update_asset', { assetId: 'asset_job_b' })).toThrow()

    expect(database.mediaGenerationJobs.get('job_bad_message')).toBeUndefined()
    expect(database.mediaGenerationJobs.get('job_bad_asset')).toBeUndefined()
    expect(database.mediaGenerationJobs.get('job_update_asset')?.assetId).toBeUndefined()
  })

  it('rejects invalid ready media assets and invalid patches before persistence', () => {
    const database = openTestDatabase()
    database.conversations.insert({ id: 'conversation_asset_validation', title: 'Asset validation' })

    expect(() => database.mediaAssets.insert({
      ...readyAsset('asset_invalid_ready', 'conversation_asset_validation'), relativePath: undefined,
    })).toThrow()
    expect(() => database.mediaAssets.insert({
      ...readyAsset('asset_invalid_metadata', 'conversation_asset_validation'), byteSize: -1,
    })).toThrow()
    database.mediaAssets.insert({
      ...readyAsset('asset_staging_validation', 'conversation_asset_validation'), status: 'staging', relativePath: undefined, mimeType: undefined, byteSize: undefined, sha256: undefined,
    })
    expect(() => database.mediaAssets.update('asset_staging_validation', { status: 'ready' })).toThrow()

    expect(database.mediaAssets.get('asset_invalid_ready')).toBeUndefined()
    expect(database.mediaAssets.get('asset_invalid_metadata')).toBeUndefined()
    expect(database.mediaAssets.get('asset_staging_validation')).toMatchObject({ status: 'staging' })
  })

  it('rejects invalid persisted media records and blocks when they are read', () => {
    const directory = mkdtempSync(join(tmpdir(), 'autoforge-database-corrupt-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'autoforge.sqlite')
    const database = openAppDatabase(path)
    database.conversations.insert({ id: 'conversation_corrupt', title: 'Corrupt' })
    database.messages.insert({ id: 'message_corrupt', conversationId: 'conversation_corrupt', role: 'assistant', blocks: [], createdAt: 1 })
    database.close()

    const sqlite = new Database(path)
    sqlite.prepare("INSERT INTO media_assets (id, conversation_id, source, kind, original_name, status, created_at, updated_at) VALUES (?, ?, 'generated', 'image', ?, 'ready', ?, ?)")
      .run('asset_corrupt', 'conversation_corrupt', 'corrupt.png', 1, 1)
    sqlite.prepare('UPDATE messages SET blocks_json = ? WHERE id = ?').run('{not valid json', 'message_corrupt')
    sqlite.close()

    const reopened = openAppDatabase(path)
    expect(() => reopened.mediaAssets.get('asset_corrupt')).toThrow()
    expect(() => reopened.messages.replaceBlock('message_corrupt', 'block_corrupt', {
      type: 'media_generation', blockId: 'block_corrupt', jobId: 'job_corrupt', kind: 'image', status: 'failed',
    })).toThrow()
  })

  it('fails interrupted non-video media generations while preserving resumable video jobs', () => {
    const database = openTestDatabase()
    database.conversations.insert({ id: 'conversation_recovery_media', title: 'Recovery media' })
    database.messages.insert({
      id: 'message_recovery_media', conversationId: 'conversation_recovery_media', role: 'assistant', createdAt: 1,
      blocks: [
        { type: 'media_generation', blockId: 'block_lost', jobId: 'image_request_lost', kind: 'image', status: 'in_progress' },
        { type: 'media_generation', blockId: 'block_video', jobId: 'job_video_recovery', kind: 'video', status: 'in_progress' },
      ],
    })
    database.chatRuns.insert({
      id: 'run_video_recovery', conversationId: 'conversation_recovery_media',
      requestId: 'job_video_recovery', model: 'video-model', status: 'running', startedAt: 1,
    })
    database.mediaGenerationJobs.insert({
      id: 'job_video_recovery', conversationId: 'conversation_recovery_media', assistantMessageId: 'message_recovery_media',
      provider: 'openrouter', model: 'video-model', kind: 'video', providerJobId: 'provider_video_recovery',
      status: 'in_progress', parameters: {}, createdAt: 1, updatedAt: 1,
    })

    database.recoverInterrupted()

    expect(database.messages.get('message_recovery_media')?.blocks).toEqual([
      { type: 'media_generation', blockId: 'block_lost', jobId: 'image_request_lost', kind: 'image', status: 'failed', errorCode: 'MEDIA_GENERATION_FAILED' },
      { type: 'media_generation', blockId: 'block_video', jobId: 'job_video_recovery', kind: 'video', status: 'in_progress' },
    ])
  })

  it('isolates malformed video parameters during interrupted recovery', () => {
    const directory = mkdtempSync(join(tmpdir(), 'autoforge-database-corrupt-parameters-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'autoforge.sqlite')
    const database = openAppDatabase(path)
    database.conversations.insert({ id: 'conversation_parameters_recovery', title: 'Recovery' })
    const insertVideo = (
      id: string,
      status: 'pending' | 'paused',
    ) => {
      database.messages.insert({
        id: `assistant_${id}`,
        conversationId: 'conversation_parameters_recovery',
        role: 'assistant',
        blocks: [{
          type: 'media_generation',
          blockId: `block_${id}`,
          jobId: id,
          kind: 'video',
          status,
        }],
        createdAt: 1,
      })
      database.chatRuns.insert({
        id: `run_${id}`,
        conversationId: 'conversation_parameters_recovery',
        requestId: id,
        model: 'video-model',
        status: 'running',
        startedAt: 1,
      })
      database.mediaGenerationJobs.insert({
        id,
        conversationId: 'conversation_parameters_recovery',
        assistantMessageId: `assistant_${id}`,
        provider: 'openrouter',
        model: 'video-model',
        kind: 'video',
        providerJobId: `provider_${id}`,
        status,
        parameters: {},
        createdAt: 1,
        updatedAt: 1,
      })
    }
    insertVideo('request_bad_parameters', 'pending')
    insertVideo('request_valid_active', 'pending')
    insertVideo('request_valid_paused', 'paused')
    database.executions.insert({
      id: 'execution_parameters_recovery',
      status: 'running',
      workflowId: 'workflow',
      workflowVersion: '1.0.0',
    })
    database.chatRuns.insert({
      id: 'run_unrelated_parameters_recovery',
      conversationId: 'conversation_parameters_recovery',
      requestId: 'request_unrelated_parameters_recovery',
      model: 'text-model',
      status: 'streaming',
      startedAt: 1,
    })
    const fault = new Database(path)
    fault.prepare('UPDATE media_generation_jobs SET parameters_json = ? WHERE id = ?')
      .run('{not valid json', 'request_bad_parameters')
    fault.close()

    let recovery: { executions: number; chatRuns: number } | undefined
    expect(() => {
      recovery = database.recoverInterrupted()
    }).not.toThrow()
    expect(recovery).toEqual({ executions: 1, chatRuns: 2 })

    const inspection = new Database(path)
    expect(inspection.prepare(`
      SELECT status, error_code AS errorCode
      FROM media_generation_jobs
      WHERE id = ?
    `).get('request_bad_parameters')).toEqual({
      status: 'failed',
      errorCode: 'MEDIA_GENERATION_FAILED',
    })
    inspection.close()
    expect(() => database.mediaGenerationJobs.get('request_bad_parameters')).toThrow()
    expect(database.chatRuns.get('run_request_bad_parameters')).toMatchObject({
      status: 'failed',
      errorCode: 'INTERNAL_ERROR',
    })
    expect(database.messages.get('assistant_request_bad_parameters')?.blocks).toEqual([{
      type: 'media_generation',
      blockId: 'block_request_bad_parameters',
      jobId: 'request_bad_parameters',
      kind: 'video',
      status: 'failed',
      errorCode: 'MEDIA_GENERATION_FAILED',
    }])
    expect(database.mediaGenerationJobs.get('request_valid_active')?.status).toBe('pending')
    expect(database.mediaGenerationJobs.get('request_valid_paused')?.status).toBe('paused')
    expect(database.mediaGenerationJobs.listActive().map((job) => job.id))
      .toEqual(['request_valid_active'])
    expect(database.chatRuns.get('run_request_valid_active')?.status).toBe('running')
    expect(database.chatRuns.get('run_request_valid_paused')?.status).toBe('running')
    expect(database.executions.get('execution_parameters_recovery')?.status).toBe('interrupted')
    expect(database.chatRuns.get('run_unrelated_parameters_recovery')).toMatchObject({
      status: 'failed',
      errorCode: 'INTERNAL_ERROR',
    })
  })

  it('atomically commits assistant partials with the chat-run terminal state', () => {
    const database = openTestDatabase()
    database.conversations.insert({ id: 'conversation_terminal', title: 'Terminal' })
    database.messages.insert({
      id: 'assistant_terminal', conversationId: 'conversation_terminal', role: 'assistant',
      blocks: [{ type: 'text', text: '部分' }], createdAt: 1,
    })
    database.chatRuns.insert({
      id: 'run_terminal', conversationId: 'conversation_terminal', requestId: 'request_terminal',
      model: 'model', status: 'running', startedAt: 1,
    })

    database.chatRuns.finalizeWithMessage('run_terminal', 'assistant_terminal', 'request_terminal', {
      blocks: [{ type: 'text', text: '完整' }], status: 'completed', endedAt: 2,
      generationId: 'generation_1', inputTokens: 3, outputTokens: 4, costUsd: '0.01',
    })

    expect(database.messages.get('assistant_terminal')?.blocks).toEqual([{ type: 'text', text: '完整' }])
    expect(database.chatRuns.get('run_terminal')).toMatchObject({
      status: 'completed', endedAt: 2, generationId: 'generation_1', inputTokens: 3, outputTokens: 4, costUsd: '0.01',
    })

    expect(() => database.chatRuns.finalizeWithMessage('missing', 'assistant_terminal', 'request_terminal', {
      blocks: [{ type: 'text', text: '不得提交' }], status: 'failed', endedAt: 3,
    })).toThrow()
    expect(database.messages.get('assistant_terminal')?.blocks).toEqual([{ type: 'text', text: '完整' }])
  })

  it('summarizes retained token usage by model for the current month and all time', () => {
    const database = openTestDatabase()
    database.conversations.insert({ id: 'conversation_usage', title: 'Usage' })
    const insert = (
      id: string,
      model: string,
      status: 'completed' | 'failed' | 'cancelled',
      startedAt: number,
      inputTokens?: number,
      outputTokens?: number,
    ) => database.chatRuns.insert({
      id,
      conversationId: 'conversation_usage',
      requestId: `request_${id}`,
      model,
      status,
      startedAt,
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
    })

    insert('before_alpha', 'alpha/model', 'completed', 99, 10, 5)
    insert('month_alpha', 'alpha/model', 'failed', 100, 7)
    insert('month_beta', 'beta/model', 'cancelled', 101, undefined, 9)
    insert('month_zero', 'zero/model', 'completed', 102, 0, 0)
    insert('ignored', 'ignored/model', 'completed', 103)

    expect(database.chatRuns.summarizeTokenUsage(100)).toEqual({
      month: {
        inputTokens: 7,
        outputTokens: 9,
        totalTokens: 16,
        models: [
          { model: 'beta/model', inputTokens: 0, outputTokens: 9, totalTokens: 9 },
          { model: 'alpha/model', inputTokens: 7, outputTokens: 0, totalTokens: 7 },
          { model: 'zero/model', inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        ],
      },
      allTime: {
        inputTokens: 17,
        outputTokens: 14,
        totalTokens: 31,
        models: [
          { model: 'alpha/model', inputTokens: 17, outputTokens: 5, totalTokens: 22 },
          { model: 'beta/model', inputTokens: 0, outputTokens: 9, totalTokens: 9 },
          { model: 'zero/model', inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        ],
      },
    })

    database.clearLocalData('conversations')
    expect(database.chatRuns.summarizeTokenUsage(100)).toEqual({
      month: { inputTokens: 0, outputTokens: 0, totalTokens: 0, models: [] },
      allTime: { inputTokens: 0, outputTokens: 0, totalTokens: 0, models: [] },
    })
  })

  it('atomically claims generated media, replaces its stable block, and finalizes the chat run', () => {
    const database = openTestDatabase()
    database.conversations.insert({ id: 'conversation_media_terminal', title: 'Media terminal' })
    const pending = {
      type: 'media_generation' as const,
      blockId: 'block_media_terminal',
      jobId: 'request_media_terminal',
      kind: 'image' as const,
      status: 'in_progress' as const,
    }
    database.messages.insert({
      id: 'assistant_media_terminal',
      conversationId: 'conversation_media_terminal',
      role: 'assistant',
      blocks: [pending],
      createdAt: 1,
    })
    database.chatRuns.insert({
      id: 'run_media_terminal',
      conversationId: 'conversation_media_terminal',
      requestId: 'request_media_terminal',
      model: 'image-model',
      status: 'running',
      startedAt: 1,
    })
    const asset = {
      ...readyAsset('asset_media_terminal', 'conversation_media_terminal'),
      source: 'generated' as const,
      provider: 'openrouter',
      model: 'image-model',
    }
    database.mediaAssets.insert(asset)
    const finalBlocks = [
      mediaBlockForAsset(asset, 'block_media_terminal', 'output'),
      { type: 'text' as const, text: 'transcript' },
    ]

    database.chatRuns.finalizeWithMessage(
      'run_media_terminal',
      'assistant_media_terminal',
      'request_media_terminal',
      {
        blocks: finalBlocks,
        status: 'completed',
        endedAt: 2,
        generationId: 'generation_media_terminal',
        inputTokens: 3,
        outputTokens: 4,
        costUsd: '0.25',
      },
    )

    expect(database.messages.get('assistant_media_terminal')?.blocks).toEqual(finalBlocks)
    expect(database.mediaAssets.get(asset.id)?.messageId).toBe('assistant_media_terminal')
    expect(database.chatRuns.get('run_media_terminal')).toMatchObject({
      status: 'completed',
      endedAt: 2,
      generationId: 'generation_media_terminal',
      inputTokens: 3,
      outputTokens: 4,
      costUsd: '0.25',
    })
  })

  it('rolls back media ownership and message replacement when terminal run persistence fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'autoforge-database-media-terminal-fault-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'autoforge.sqlite')
    const database = openAppDatabase(path)
    database.conversations.insert({ id: 'conversation_media_rollback', title: 'Media rollback' })
    const pending = {
      type: 'media_generation' as const,
      blockId: 'block_media_rollback',
      jobId: 'request_media_rollback',
      kind: 'image' as const,
      status: 'in_progress' as const,
    }
    database.messages.insert({
      id: 'assistant_media_rollback',
      conversationId: 'conversation_media_rollback',
      role: 'assistant',
      blocks: [pending],
      createdAt: 1,
    })
    database.chatRuns.insert({
      id: 'run_media_rollback',
      conversationId: 'conversation_media_rollback',
      requestId: 'request_media_rollback',
      model: 'image-model',
      status: 'running',
      startedAt: 1,
    })
    const asset = {
      ...readyAsset('asset_media_rollback', 'conversation_media_rollback'),
      source: 'generated' as const,
      provider: 'openrouter',
      model: 'image-model',
    }
    database.mediaAssets.insert(asset)
    const faultInjector = new Database(path)
    faultInjector.exec(`
      CREATE TRIGGER fail_media_terminal_run_update
      BEFORE UPDATE ON chat_runs
      WHEN NEW.id = 'run_media_rollback'
      BEGIN
        SELECT RAISE(FAIL, 'injected terminal failure');
      END;
    `)
    faultInjector.close()

    expect(() => database.chatRuns.finalizeWithMessage(
      'run_media_rollback',
      'assistant_media_rollback',
      'request_media_rollback',
      {
        blocks: [mediaBlockForAsset(asset, 'block_media_rollback', 'output')],
        status: 'completed',
        endedAt: 2,
      },
    )).toThrow()

    expect(database.messages.get('assistant_media_rollback')?.blocks).toEqual([pending])
    expect(database.mediaAssets.get(asset.id)?.messageId).toBeUndefined()
    expect(database.chatRuns.get('run_media_rollback')?.status).toBe('running')
  })

  it.each([
    ['run request mismatch', {
      requestId: 'request_wrong',
      pendingJobId: 'request_identity',
      pendingStatus: 'in_progress',
      assetModel: 'image-model',
    }],
    ['generation job mismatch', {
      requestId: 'request_identity',
      pendingJobId: 'request_wrong',
      pendingStatus: 'in_progress',
      assetModel: 'image-model',
    }],
    ['generated asset model mismatch', {
      requestId: 'request_identity',
      pendingJobId: 'request_identity',
      pendingStatus: 'in_progress',
      assetModel: 'other-model',
    }],
    ['already failed generation', {
      requestId: 'request_identity',
      pendingJobId: 'request_identity',
      pendingStatus: 'failed',
      assetModel: 'image-model',
    }],
  ] as const)('rejects media finalization with %s', (_description, variant) => {
    const database = openTestDatabase()
    database.conversations.insert({ id: 'conversation_identity', title: 'Identity' })
    const pending = {
      type: 'media_generation' as const,
      blockId: 'block_identity',
      jobId: variant.pendingJobId,
      kind: 'image' as const,
      status: variant.pendingStatus,
      ...(variant.pendingStatus === 'failed' ? { errorCode: 'CANCELLED' as const } : {}),
    }
    database.messages.insert({
      id: 'assistant_identity',
      conversationId: 'conversation_identity',
      role: 'assistant',
      blocks: [pending],
      createdAt: 1,
    })
    database.chatRuns.insert({
      id: 'run_identity',
      conversationId: 'conversation_identity',
      requestId: 'request_identity',
      model: 'image-model',
      status: 'running',
      startedAt: 1,
    })
    const asset = {
      ...readyAsset('asset_identity', 'conversation_identity'),
      source: 'generated' as const,
      provider: 'openrouter',
      model: variant.assetModel,
    }
    database.mediaAssets.insert(asset)

    expect(() => database.chatRuns.finalizeWithMessage(
      'run_identity',
      'assistant_identity',
      variant.requestId,
      {
        blocks: [mediaBlockForAsset(asset, 'block_identity', 'output')],
        status: 'completed',
        endedAt: 2,
      },
    )).toThrow()

    expect(database.messages.get('assistant_identity')?.blocks).toEqual([pending])
    expect(database.mediaAssets.get(asset.id)?.messageId).toBeUndefined()
    expect(database.chatRuns.get('run_identity')?.status).toBe('running')
  })

  it.each(['failed', 'cancelled'] as const)(
    'rejects a media generation terminal with a mismatched job ID when the run is %s',
    (runStatus) => {
      const database = openTestDatabase()
      database.conversations.insert({ id: 'conversation_failed_identity', title: 'Failed identity' })
      const pending = {
        type: 'media_generation' as const,
        blockId: 'block_failed_identity',
        jobId: 'request_failed_identity',
        kind: 'audio' as const,
        status: 'in_progress' as const,
      }
      database.messages.insert({
        id: 'assistant_failed_identity',
        conversationId: 'conversation_failed_identity',
        role: 'assistant',
        blocks: [pending],
        createdAt: 1,
      })
      database.chatRuns.insert({
        id: 'run_failed_identity',
        conversationId: 'conversation_failed_identity',
        requestId: 'request_failed_identity',
        model: 'audio-model',
        status: 'running',
        startedAt: 1,
      })

      expect(() => database.chatRuns.finalizeWithMessage(
        'run_failed_identity',
        'assistant_failed_identity',
        'request_failed_identity',
        {
          blocks: [{
            ...pending,
            jobId: 'request_wrong',
            status: 'failed',
            errorCode: runStatus === 'cancelled' ? 'CANCELLED' : 'MEDIA_GENERATION_FAILED',
          }],
          status: runStatus,
          endedAt: 2,
          errorCode: runStatus === 'cancelled' ? 'CANCELLED' : 'MEDIA_GENERATION_FAILED',
        },
      )).toThrow()

      expect(database.messages.get('assistant_failed_identity')?.blocks).toEqual([pending])
      expect(database.chatRuns.get('run_failed_identity')?.status).toBe('running')
    },
  )

  it.each([
    ['failed run and failure block differ', 'failed', 'MEDIA_DOWNLOAD_FAILED', 'MEDIA_GENERATION_FAILED'],
    ['cancelled run does not carry CANCELLED', 'cancelled', 'CANCELLED', 'MEDIA_GENERATION_FAILED'],
    ['cancelled block does not carry CANCELLED', 'cancelled', 'MEDIA_GENERATION_FAILED', 'CANCELLED'],
  ] as const)(
    'rejects media terminal error codes when %s',
    (_description, runStatus, blockErrorCode, runErrorCode) => {
      const database = openTestDatabase()
      database.conversations.insert({ id: 'conversation_terminal_error', title: 'Terminal error' })
      const pending = {
        type: 'media_generation' as const,
        blockId: 'block_terminal_error',
        jobId: 'request_terminal_error',
        kind: 'audio' as const,
        status: 'in_progress' as const,
      }
      database.messages.insert({
        id: 'assistant_terminal_error',
        conversationId: 'conversation_terminal_error',
        role: 'assistant',
        blocks: [pending],
        createdAt: 1,
      })
      database.chatRuns.insert({
        id: 'run_terminal_error',
        conversationId: 'conversation_terminal_error',
        requestId: 'request_terminal_error',
        model: 'audio-model',
        status: 'running',
        startedAt: 1,
      })

      expect(() => database.chatRuns.finalizeWithMessage(
        'run_terminal_error',
        'assistant_terminal_error',
        'request_terminal_error',
        {
          blocks: [{
            ...pending,
            status: 'failed',
            errorCode: blockErrorCode,
          }],
          status: runStatus,
          endedAt: 2,
          errorCode: runErrorCode,
        },
      )).toThrow()

      expect(database.messages.get('assistant_terminal_error')?.blocks).toEqual([pending])
      expect(database.chatRuns.get('run_terminal_error')?.status).toBe('running')
    },
  )

  it.each([
    ['failed', 'MEDIA_DOWNLOAD_FAILED'],
    ['cancelled', 'CANCELLED'],
  ] as const)(
    'accepts a request-bound media %s terminal with a matching safe error code',
    (runStatus, errorCode) => {
      const database = openTestDatabase()
      database.conversations.insert({ id: 'conversation_terminal_error_match', title: 'Matching terminal error' })
      const pending = {
        type: 'media_generation' as const,
        blockId: 'block_terminal_error_match',
        jobId: 'request_terminal_error_match',
        kind: 'audio' as const,
        status: 'in_progress' as const,
      }
      database.messages.insert({
        id: 'assistant_terminal_error_match',
        conversationId: 'conversation_terminal_error_match',
        role: 'assistant',
        blocks: [pending],
        createdAt: 1,
      })
      database.chatRuns.insert({
        id: 'run_terminal_error_match',
        conversationId: 'conversation_terminal_error_match',
        requestId: 'request_terminal_error_match',
        model: 'audio-model',
        status: 'running',
        startedAt: 1,
      })
      const terminal = {
        ...pending,
        status: 'failed' as const,
        errorCode,
      }

      database.chatRuns.finalizeWithMessage(
        'run_terminal_error_match',
        'assistant_terminal_error_match',
        'request_terminal_error_match',
        {
          blocks: [terminal],
          status: runStatus,
          endedAt: 2,
          errorCode,
        },
      )

      expect(database.messages.get('assistant_terminal_error_match')?.blocks).toEqual([terminal])
      expect(database.chatRuns.get('run_terminal_error_match')).toMatchObject({
        status: runStatus,
        errorCode,
        endedAt: 2,
      })
    },
  )

  it('rejects a completed terminal carrying an error code', () => {
    const database = openTestDatabase()
    database.conversations.insert({ id: 'conversation_completed_error', title: 'Completed error' })
    database.messages.insert({
      id: 'assistant_completed_error',
      conversationId: 'conversation_completed_error',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'partial' }],
      createdAt: 1,
    })
    database.chatRuns.insert({
      id: 'run_completed_error',
      conversationId: 'conversation_completed_error',
      requestId: 'request_completed_error',
      model: 'text-model',
      status: 'running',
      startedAt: 1,
    })

    expect(() => database.chatRuns.finalizeWithMessage(
      'run_completed_error',
      'assistant_completed_error',
      'request_completed_error',
      {
        blocks: [{ type: 'text', text: 'complete' }],
        status: 'completed',
        endedAt: 2,
        errorCode: 'INTERNAL_ERROR',
      },
    )).toThrow()

    expect(database.messages.get('assistant_completed_error')?.blocks)
      .toEqual([{ type: 'text', text: 'partial' }])
    expect(database.chatRuns.get('run_completed_error')?.status).toBe('running')
  })

  it('keeps non-media workflow terminal persistence compatible', () => {
    const database = openTestDatabase()
    database.conversations.insert({ id: 'conversation_workflow_terminal', title: 'Workflow terminal' })
    database.messages.insert({
      id: 'assistant_workflow_terminal',
      conversationId: 'conversation_workflow_terminal',
      role: 'assistant',
      blocks: [{
        type: 'workflow_proposal',
        workflowId: 'workflow_1',
        workflowName: 'Workflow',
        args: {},
      }],
      createdAt: 1,
    })
    database.chatRuns.insert({
      id: 'run_workflow_terminal',
      conversationId: 'conversation_workflow_terminal',
      requestId: 'request_workflow_terminal',
      model: 'text-model',
      status: 'running',
      startedAt: 1,
    })
    const blocks = [
      { type: 'text' as const, text: 'Ready' },
      {
        type: 'workflow_proposal' as const,
        workflowId: 'workflow_1',
        workflowName: 'Workflow',
        args: { value: 1 },
      },
    ]

    database.chatRuns.finalizeWithMessage(
      'run_workflow_terminal',
      'assistant_workflow_terminal',
      'request_workflow_terminal',
      { blocks, status: 'completed', endedAt: 2 },
    )

    expect(database.messages.get('assistant_workflow_terminal')?.blocks).toEqual(blocks)
    expect(database.chatRuns.get('run_workflow_terminal')).toMatchObject({
      status: 'completed',
      endedAt: 2,
    })
  })

  it.each(['completed', 'failed', 'cancelled'] as const)(
    'rejects rewriting an already terminal %s chat run',
    (terminalStatus) => {
      const database = openTestDatabase()
      database.conversations.insert({ id: 'conversation_terminal_rewrite', title: 'Terminal rewrite' })
      database.messages.insert({
        id: 'assistant_terminal_rewrite',
        conversationId: 'conversation_terminal_rewrite',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'original terminal' }],
        createdAt: 1,
      })
      database.chatRuns.insert({
        id: 'run_terminal_rewrite',
        conversationId: 'conversation_terminal_rewrite',
        requestId: 'request_terminal_rewrite',
        model: 'text-model',
        status: terminalStatus,
        startedAt: 1,
        endedAt: 2,
      })

      expect(() => database.chatRuns.finalizeWithMessage(
        'run_terminal_rewrite',
        'assistant_terminal_rewrite',
        'request_terminal_rewrite',
        {
          blocks: [{ type: 'text', text: 'late rewrite' }],
          status: 'completed',
          endedAt: 3,
        },
      )).toThrow()

      expect(database.messages.get('assistant_terminal_rewrite')?.blocks)
        .toEqual([{ type: 'text', text: 'original terminal' }])
      expect(database.chatRuns.get('run_terminal_rewrite')).toMatchObject({
        status: terminalStatus,
        endedAt: 2,
      })
    },
  )

  it('redacts execution log text and metadata before persistence', () => {
    const database = openTestDatabase()
    database.executions.insert({
      id: 'execution_1',
      status: 'running',
      workflowId: 'workflow_1',
      workflowVersion: '1.0.0',
    })
    database.executionLogs.insert({
      id: 'log_1',
      executionId: 'execution_1',
      sequence: 1,
      level: 'info',
      message: JSON.stringify({ apiKey: 'api-secret', input: { privateValue: 'private-secret' } }),
      metadata: { accessToken: 'token-secret', input: { privateValue: 'private-secret' } },
      sensitivePaths: ['input.privateValue'],
      createdAt: 1,
    })

    const stored = database.executionLogs.list('execution_1')[0]
    expect(JSON.stringify(stored)).not.toContain('api-secret')
    expect(JSON.stringify(stored)).not.toContain('token-secret')
    expect(JSON.stringify(stored)).not.toContain('private-secret')
    expect(stored.message).toContain('[REDACTED]')
  })

  it('redacts complete plain-text secret values before persistence and return', () => {
    const database = openTestDatabase()
    database.executions.insert({ id: 'execution_2', status: 'running', workflowId: 'workflow_1', workflowVersion: '1.0.0' })
    const message = 'Authorization: Bearer sk-secret; X-API-Key: api-secret; token=token-secret; password=password-secret'
    const returned = database.executionLogs.insert({
      id: 'log_2',
      executionId: 'execution_2',
      sequence: 1,
      level: 'info',
      message,
      sensitivePaths: ['credentials.password'],
      createdAt: 1,
    })
    const stored = database.executionLogs.list('execution_2')[0]

    for (const secret of ['sk-secret', 'api-secret', 'token-secret', 'password-secret']) {
      expect(returned.message).not.toContain(secret)
      expect(stored.message).not.toContain(secret)
    }
    expect(stored.message).toContain('[REDACTED]')
  })
})
