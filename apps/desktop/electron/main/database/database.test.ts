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

    expect(database.schemaVersion()).toBe(2)
    expect(database.executions.markInterrupted()).toBe(1)
    expect(database.executions.get('exec_1')?.status).toBe('interrupted')
  })

  it('upgrades a populated v1 database without losing conversations or messages', () => {
    const database = createV1Database()

    expect(database.schemaVersion()).toBe(2)
    expect(database.conversations.get('conversation_v1')).toMatchObject({ title: 'Persisted v1' })
    expect(database.messages.get('message_v1')?.blocks).toEqual([{ type: 'text', text: 'before upgrade' }])
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
    database.mediaAssets.insert({ ...readyAsset('asset_video', 'conversation_blocks'), source: 'generated' })

    database.messages.replaceBlock('message_blocks', 'block_video', {
      type: 'media', blockId: 'block_video', assetId: 'asset_video', kind: 'video', purpose: 'output',
      name: 'video.mp4', mimeType: 'video/mp4', byteSize: 12,
    })

    expect(database.messages.get('message_blocks')?.blocks).toEqual([{
      type: 'media', blockId: 'block_video', assetId: 'asset_video', kind: 'video', purpose: 'output',
      name: 'video.mp4', mimeType: 'video/mp4', byteSize: 12,
    }])
    expect(() => database.messages.replaceBlock('message_blocks', 'block_video', {
      type: 'media', blockId: 'different_block', assetId: 'asset_video', kind: 'video', purpose: 'output',
      name: 'video.mp4', mimeType: 'video/mp4', byteSize: 12,
    })).toThrow()
    expect(() => database.messages.replaceBlock('message_blocks', 'block_video', {
      type: 'media', blockId: 'block_video', assetId: 'asset_video', kind: 'video', purpose: 'output',
      name: '', mimeType: 'video/mp4', byteSize: 12,
    })).toThrow()
  })

  it('claims a ready output media asset when replacing a generation block', () => {
    const database = openTestDatabase()
    database.conversations.insert({ id: 'conversation_output', title: 'Output' })
    database.messages.insert({
      id: 'message_output', conversationId: 'conversation_output', role: 'assistant', createdAt: 1,
      blocks: [{ type: 'media_generation', blockId: 'block_output', jobId: 'job_output', kind: 'image', status: 'in_progress' }],
    })
    database.mediaAssets.insert({ ...readyAsset('asset_output', 'conversation_output'), source: 'generated' })

    database.messages.replaceBlock('message_output', 'block_output', {
      type: 'media', blockId: 'block_output', assetId: 'asset_output', kind: 'image', purpose: 'output',
      name: 'asset_output.png', mimeType: 'image/png', byteSize: 12,
    })

    expect(database.mediaAssets.get('asset_output')?.messageId).toBe('message_output')
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

    database.chatRuns.finalizeWithMessage('run_terminal', 'assistant_terminal', {
      blocks: [{ type: 'text', text: '完整' }], status: 'completed', endedAt: 2,
      generationId: 'generation_1', inputTokens: 3, outputTokens: 4, costUsd: '0.01',
    })

    expect(database.messages.get('assistant_terminal')?.blocks).toEqual([{ type: 'text', text: '完整' }])
    expect(database.chatRuns.get('run_terminal')).toMatchObject({
      status: 'completed', endedAt: 2, generationId: 'generation_1', inputTokens: 3, outputTokens: 4, costUsd: '0.01',
    })

    expect(() => database.chatRuns.finalizeWithMessage('missing', 'assistant_terminal', {
      blocks: [{ type: 'text', text: '不得提交' }], status: 'failed', endedAt: 3,
    })).toThrow()
    expect(database.messages.get('assistant_terminal')?.blocks).toEqual([{ type: 'text', text: '完整' }])
  })

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
