import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { sql } from 'drizzle-orm'
import { authAccountSchema, chatBlockSchema, type ConversationGenerationPreferences } from '@autoforge/shared'
import { openAppDatabase as openProductionAppDatabase } from './client.js'
import { resolveMigrationDirectory } from './migrations.js'
import { createRepositories, ProviderUsageConsistencyError } from './repositories.js'

const temporaryDirectories: string[] = []

function openAppDatabase(path: string) {
  const production = openProductionAppDatabase(path)
  const sqlite = new Database(path)
  sqlite.pragma('foreign_keys = ON')
  const repositories = createRepositories(sqlite)
  repositories.messages.upgradeLegacyApprovals()
  const recoverInterrupted = () => sqlite.transaction(() => {
    const endedAt = Date.now()
    const executions = sqlite.prepare(`
      UPDATE executions
      SET status = 'interrupted', error_code = 'INTERNAL_ERROR', ended_at = ?
      WHERE status IN ('queued', 'awaiting_approval', 'running', 'pending', 'waiting_approval')
    `).run(endedAt).changes
    const interruptedRuns = sqlite.prepare(`
      SELECT id, request_id AS requestId
      FROM chat_runs
      WHERE status IN ('queued', 'awaiting_approval', 'running', 'streaming')
    `).all() as Array<{ id: string; requestId: string }>
    const preservedRequestIds = new Set(repositories.mediaGenerationJobs.reconcileInterrupted(endedAt))
    let chatRuns = 0
    const failRun = sqlite.prepare(`
      UPDATE chat_runs
      SET status = 'failed', error_code = 'INTERNAL_ERROR', ended_at = @endedAt
      WHERE id = @id
        AND status IN ('queued', 'awaiting_approval', 'running', 'streaming')
    `)
    const failedRequestIds: string[] = []
    for (const run of interruptedRuns) {
      if (preservedRequestIds.has(run.requestId)) continue
      const changes = failRun.run({ id: run.id, endedAt }).changes
      const reconciled = changes === 1 || sqlite.prepare(`
        SELECT 1 FROM chat_runs
        WHERE id = @id AND status = 'failed'
          AND error_code = 'INTERNAL_ERROR' AND ended_at = @endedAt
      `).get({ id: run.id, endedAt }) !== undefined
      if (reconciled) {
        chatRuns += 1
        failedRequestIds.push(run.requestId)
      }
    }
    repositories.messages.failInterruptedBrowserStatuses(failedRequestIds)
    repositories.messages.invalidatePendingAgentApprovals()
    repositories.messages.failInterruptedMediaGenerations()
    repositories.conversations.failInterruptedTitleGenerations()
    return { executions, chatRuns }
  })()
  recoverInterrupted()
  const clearConversations = () => sqlite.transaction(() => {
    sqlite.prepare('DELETE FROM conversations').run()
  })()
  const clearLocalData = (scope: 'conversations' | 'executions' | 'all') => sqlite.transaction(() => {
    if (scope === 'executions' || scope === 'all') sqlite.prepare('DELETE FROM executions').run()
    if (scope === 'conversations' || scope === 'all') sqlite.prepare('DELETE FROM conversations').run()
  })()
  return {
    ...production,
    conversations: repositories.conversations,
    messages: repositories.messages,
    conversationContexts: repositories.conversationContexts,
    mediaAssets: repositories.mediaAssets,
    mediaGenerationJobs: repositories.mediaGenerationJobs,
    chatRuns: repositories.chatRuns,
    providerUsage: repositories.providerUsage,
    recoverInterrupted,
    clearConversations,
    clearLocalData,
    close() {
      sqlite.close()
      production.close()
    },
  }
}

function openTestDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'autoforge-database-'))
  temporaryDirectories.push(directory)
  return openAppDatabase(join(directory, 'autoforge.sqlite'))
}

function openInspectableTestDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'autoforge-database-'))
  temporaryDirectories.push(directory)
  const path = join(directory, 'autoforge.sqlite')
  return { database: openAppDatabase(path), path }
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

function createV4Database() {
  const directory = mkdtempSync(join(tmpdir(), 'autoforge-database-v4-'))
  temporaryDirectories.push(directory)
  const path = join(directory, 'autoforge.sqlite')
  const sqlite = new Database(path)
  for (const [index, fileName] of [
    '0001_init.sql',
    '0002_multimodal_media.sql',
    '0003_conversation_context.sql',
    '0004_local_auth.sql',
  ].entries()) {
    sqlite.exec(readFileSync(fileURLToPath(new URL(`../../../resources/migrations/${fileName}`, import.meta.url)), 'utf8'))
    sqlite.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(index + 1, index + 1)
  }
  sqlite.prepare(`
    INSERT INTO local_users (id, account, account_normalized, password_digest, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('user_v4', 'Legacy', 'legacy', 'digest', 1, 1)
  sqlite.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('conversation_v4', 'Persisted v4', 1, 1)
  sqlite.prepare('INSERT INTO chat_runs (id, conversation_id, request_id, model, status, started_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('run_v4', 'conversation_v4', 'request_v4', 'model-v4', 'completed', 1)
  sqlite.close()
  return { database: openAppDatabase(path), path }
}

function createV12ExecutionBoundaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'autoforge-database-v12-execution-boundary-'))
  temporaryDirectories.push(directory)
  const path = join(directory, 'autoforge.sqlite')
  const sqlite = new Database(path)
  sqlite.pragma('foreign_keys = ON')
  const migrationDirectory = fileURLToPath(new URL('../../../resources/migrations/', import.meta.url))
  const migrations = readdirSync(migrationDirectory)
    .map((fileName) => ({ fileName, version: Number.parseInt(fileName.slice(0, 4), 10) }))
    .filter(({ fileName, version }) => fileName.endsWith('.sql') && version <= 12)
    .sort((left, right) => left.version - right.version)
  for (const migration of migrations) {
    sqlite.exec(readFileSync(join(migrationDirectory, migration.fileName), 'utf8'))
    sqlite.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(migration.version, migration.version)
  }
  sqlite.prepare(`
    INSERT INTO local_users (id, account, account_normalized, password_digest, created_at, updated_at)
    VALUES ('execution_boundary_user', 'Execution boundary', 'execution boundary', 'digest', 1, 1)
  `).run()
  sqlite.prepare(`
    INSERT INTO conversations (id, title, created_at, updated_at)
    VALUES ('execution_boundary_conversation', 'Execution boundary', 1, 1)
  `).run()
  sqlite.prepare(`
    INSERT INTO chat_runs (id, conversation_id, request_id, model, status, started_at, ended_at)
    VALUES (
      'legacy_global_run', 'execution_boundary_conversation', 'legacy_global_request',
      'legacy-model', 'completed', 1, 2
    )
  `).run()
  sqlite.prepare(`
    INSERT INTO executions (
      id, workflow_id, workflow_version, chat_run_id, status, input_json, result_json,
      error_code, created_at, started_at, ended_at
    ) VALUES (
      'legacy_execution', 'workflow.boundary', '1.0.0', 'legacy_global_run', 'completed',
      '{"input":"preserved"}', '{"result":"preserved"}', NULL, 3, 4, 5
    )
  `).run()
  sqlite.prepare(`
    INSERT INTO execution_steps (
      id, execution_id, sequence, name, status, percent, started_at, ended_at
    ) VALUES ('legacy_step', 'legacy_execution', 1, 'preserved step', 'completed', 100, 4, 5)
  `).run()
  sqlite.prepare(`
    INSERT INTO execution_logs (
      id, execution_id, sequence, level, message, metadata_json, created_at
    ) VALUES (
      'legacy_log', 'legacy_execution', 1, 'info', 'preserved log',
      '{"metadata":"preserved"}', 5
    )
  `).run()
  sqlite.prepare(`
    INSERT INTO browser_tab_bindings (
      id, tab_id, user_id, conversation_id, chat_run_id, execution_id, workflow_id,
      workflow_version, source, build_hash, security_fingerprint, permission_matrix_json,
      status, terminal_reason, created_at, ended_at
    ) VALUES (
      'legacy_binding', 'legacy_tab', 'execution_boundary_user',
      'execution_boundary_conversation', 'legacy_global_run', 'legacy_execution',
      'workflow.boundary', '1.0.0', 'installed', NULL, ?, '{}', 'closed',
      'PAGE_CLOSED', 6, 7
    )
  `).run('f'.repeat(64))
  sqlite.prepare(`
    INSERT INTO browser_action_audits (
      id, binding_id, chat_run_id, sequence, origin, action, target_summary, risk,
      outcome, error_code, created_at
    ) VALUES (
      'legacy_audit', 'legacy_binding', 'legacy_global_run', 1, 'https://example.com',
      'inspect', 'preserved audit', 'sensitive_read', 'completed', NULL, 7
    )
  `).run()
  sqlite.close()
  return path
}

function insertLocalUser(database: ReturnType<typeof openTestDatabase>, id: string, account: string) {
  const user = {
    id,
    account,
    accountNormalized: account.toLowerCase(),
    passwordDigest: `digest-${id}`,
    createdAt: 1,
    updatedAt: 1,
  }
  expect(database.localAuth.createUserAndSession(user, 1)?.user).toEqual({ id, account })
}

function usageStart(id: string, userId: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    operationKey: `operation_${id}`,
    userId,
    provider: 'openrouter' as const,
    apiKeyFingerprint: 'shared-fingerprint',
    requestId: `request_${id}`,
    model: 'openai/gpt-4.1',
    modality: 'text' as const,
    startedAt: 200,
    ...overrides,
  }
}

function expectProviderUsageConsistencyError(operation: () => unknown): void {
  let thrown: unknown
  try {
    operation()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(ProviderUsageConsistencyError)
  expect(thrown).toMatchObject({
    name: 'ProviderUsageConsistencyError',
    message: 'Provider usage consistency error',
  })
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
  it('exposes global legacy conversations as read-only import data', () => {
    const directory = mkdtempSync(join(tmpdir(), 'autoforge-legacy-read-only-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'autoforge.sqlite')
    openProductionAppDatabase(path).close()
    const seed = new Database(path)
    seed.prepare(`
      INSERT INTO conversations (id, title, created_at, updated_at)
      VALUES ('legacy_read_only', 'Legacy', 1, 1)
    `).run()
    seed.prepare(`
      INSERT INTO executions (
        id, owner_user_id, workflow_id, workflow_version, status, input_json, created_at
      ) VALUES ('legacy_execution', 'legacy-user', 'workflow', '1.0.0', 'completed', '{}', 1)
    `).run()
    seed.close()
    const database = openProductionAppDatabase(path)
    const expected = { code: 'CONFLICT', message: 'The requested operation conflicts with existing state.' }

    expect(database.conversations.list().map(({ id }) => id)).toEqual(['legacy_read_only'])
    expect(() => database.conversations.insert({ id: 'forbidden_insert', title: 'Forbidden' }))
      .toThrow(expect.objectContaining(expected))
    expect(() => database.conversations.renameByUser('legacy_read_only', 'Forbidden'))
      .toThrow(expect.objectContaining(expected))
    expect(() => database.conversations.delete('legacy_read_only'))
      .toThrow(expect.objectContaining(expected))
    expect(() => database.conversations.claimLegacyAndListForUser('cloud-alice'))
      .toThrow(expect.objectContaining(expected))
    expect(() => database.clearConversations()).toThrow(expect.objectContaining(expected))
    expect(() => database.clearLocalData('all')).toThrow(expect.objectContaining(expected))
    expect(database.conversations.get('legacy_read_only')).toBeDefined()
    expect(database.executions.get('legacy_execution')).toBeDefined()

    database.clearLocalData('executions')
    expect(database.executions.get('legacy_execution')).toBeUndefined()
    database.close()
  })

  it('keeps every sensitive legacy surface byte-for-byte stable across open and recovery', () => {
    const directory = mkdtempSync(join(tmpdir(), 'autoforge-legacy-sensitive-read-only-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'autoforge.sqlite')
    openProductionAppDatabase(path).close()
    const seed = new Database(path)
    seed.prepare(`
      INSERT INTO conversations (
        id, title, title_state, created_at, updated_at
      ) VALUES ('legacy_sensitive', 'Legacy sensitive', 'generating', 1, 1)
    `).run()
    const legacyApproval = JSON.stringify([{
      type: 'approval', executionId: 'legacy_sensitive_execution',
      workflowId: 'legacy.workflow', workflowVersion: '1.0.0', permissionIndex: 0,
      capability: 'browser.open', scope: { origins: ['https://example.com'] },
      scopeHash: 'a'.repeat(64),
    }])
    seed.prepare(`
      INSERT INTO messages (
        id, conversation_id, role, blocks_json, ordinal, created_at
      ) VALUES ('legacy_sensitive_message', 'legacy_sensitive', 'assistant', ?, 1, 1)
    `).run(legacyApproval)
    seed.prepare(`
      INSERT INTO conversation_contexts (
        conversation_id, summary_text, through_ordinal, estimated_tokens, updated_at
      ) VALUES ('legacy_sensitive', 'private legacy summary', 1, 3, 1)
    `).run()
    seed.prepare(`
      INSERT INTO chat_runs (
        id, conversation_id, request_id, model, status, started_at
      ) VALUES ('legacy_sensitive_run', 'legacy_sensitive', 'legacy_sensitive_request',
        'model', 'running', 1)
    `).run()
    seed.prepare(`
      INSERT INTO local_users (
        id, account, account_normalized, password_digest, created_at, updated_at
      ) VALUES ('legacy-user', 'Legacy user', 'legacy user', 'digest', 1, 1)
    `).run()
    seed.prepare(`
      INSERT INTO provider_usage_events (
        id, operation_key, user_id, provider, request_id, model, modality, status,
        reconcile_attempts, started_at
      ) VALUES ('legacy_sensitive_usage', 'legacy_sensitive_operation', 'legacy-user',
        'openrouter', 'legacy_sensitive_usage_request', 'model', 'text', 'pending', 0, 1)
    `).run()
    seed.prepare(`
      INSERT INTO media_assets (
        id, conversation_id, message_id, source, kind, original_name, relative_path,
        status, created_at, updated_at
      ) VALUES ('legacy_sensitive_asset', 'legacy_sensitive', 'legacy_sensitive_message',
        'generated', 'image', 'legacy.png', 'legacy_sensitive/legacy.png',
        'staging', 1, 1)
    `).run()
    seed.prepare(`
      INSERT INTO media_generation_jobs (
        id, conversation_id, assistant_message_id, provider, model, kind,
        provider_job_id, status, parameters_json, next_poll_at, poll_attempts,
        created_at, updated_at
      ) VALUES ('legacy_sensitive_job', 'legacy_sensitive', 'legacy_sensitive_message',
        'openrouter', 'model', 'video', 'provider_job', 'pending', '{}', 1, 0, 1, 1)
    `).run()
    const sensitiveSnapshot = (sqlite: Database.Database) => JSON.stringify([
      'conversations',
      'messages',
      'conversation_contexts',
      'chat_runs',
      'provider_usage_events',
      'media_assets',
      'media_generation_jobs',
    ].map((table) => [table, sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
    const before = sensitiveSnapshot(seed)
    seed.close()

    const database = openProductionAppDatabase(path)
    const expected = {
      code: 'CONFLICT',
      message: 'The requested operation conflicts with existing state.',
    }
    expect(database.messages.get('legacy_sensitive_message')).toBeDefined()
    expect(database.conversationContexts.get('legacy_sensitive')).toBeDefined()
    expect(database.chatRuns.get('legacy_sensitive_run')).toBeDefined()
    expect(database.providerUsage.find('legacy_sensitive_operation')).toBeDefined()
    expect(database.mediaAssets.get('legacy_sensitive_asset')).toBeDefined()
    expect(database.mediaAssets.listForConversation('legacy_sensitive')).toHaveLength(1)
    expect(database.mediaAssets.listUnclaimedBefore(2)).toEqual([])
    expect(database.mediaGenerationJobs.get('legacy_sensitive_job')).toBeDefined()
    expect(database.mediaGenerationJobs.listResumable(2)).toHaveLength(1)
    expect(database.mediaGenerationJobs.listActive()).toHaveLength(1)
    for (const mutate of [
      () => database.messages.insert({
        id: 'forbidden_message', conversationId: 'legacy_sensitive', role: 'user',
        blocks: [{ type: 'text', text: 'forbidden' }], createdAt: 2,
      }),
      () => database.messages.update('legacy_sensitive_message', { executionId: 'forbidden' }),
      () => database.messages.replaceBlock(
        'legacy_sensitive_message', 'forbidden', { type: 'text', text: 'forbidden' },
      ),
      () => database.messages.upgradeLegacyApprovals(),
      () => database.messages.invalidatePendingAgentApprovals(),
      () => database.messages.failInterruptedMediaGenerations(),
      () => database.messages.failInterruptedBrowserStatuses(['legacy_sensitive_request']),
      () => database.conversationContexts.advance({
        conversationId: 'legacy_sensitive', expectedThroughOrdinal: 1,
        summaryText: 'forbidden', throughOrdinal: 2, estimatedTokens: 1, updatedAt: 2,
      }),
      () => database.chatRuns.insert({
        id: 'forbidden_run', conversationId: 'legacy_sensitive', requestId: 'forbidden_request',
        model: 'model', status: 'running', startedAt: 2,
      }),
      () => database.chatRuns.startMediaGeneration({} as never),
      () => database.chatRuns.update('legacy_sensitive_run', { status: 'failed' }),
      () => database.chatRuns.finalizeWithMessage(
        'legacy_sensitive_run', 'legacy_sensitive_message', 'legacy_sensitive_request', {} as never,
      ),
      () => database.providerUsage.start({} as never),
      () => database.providerUsage.bindIdentity('legacy_sensitive_operation', {}),
      () => database.providerUsage.report('legacy_sensitive_operation', {} as never),
      () => database.providerUsage.markUnknown('legacy_sensitive_operation', 2),
      () => database.providerUsage.recordReconcileFailure('legacy_sensitive_operation', 2),
      () => database.mediaAssets.insert({} as never),
      () => database.mediaAssets.update('legacy_sensitive_asset', { status: 'failed' }),
      () => database.mediaAssets.delete('legacy_sensitive_asset'),
      () => database.mediaGenerationJobs.insert({} as never),
      () => database.mediaGenerationJobs.startSubmissionIntent({} as never),
      () => database.mediaGenerationJobs.bindSubmitted('legacy_sensitive_job', {} as never),
      () => database.mediaGenerationJobs.insertTurn({} as never),
      () => database.mediaGenerationJobs.reconcileInterrupted(2),
      () => database.mediaGenerationJobs.update('legacy_sensitive_job', { status: 'failed' }),
      () => database.mediaGenerationJobs.transition('legacy_sensitive_job', ['pending'], {} as never),
      () => database.mediaGenerationJobs.complete('legacy_sensitive_job', ['pending'], {} as never),
      () => database.mediaGenerationJobs.fail(
        'legacy_sensitive_job', ['pending'], 'MEDIA_GENERATION_FAILED', 2,
      ),
    ]) expect(mutate).toThrow(expect.objectContaining(expected))

    expect(database.providerUsage.recoverPending(2)).toBe(0)
    expect(database.providerUsage.listReconcilable(2)).toEqual([])
    expect(database.recoverInterrupted()).toEqual({ executions: 0, chatRuns: 0 })
    database.close()
    const inspection = new Database(path, { readonly: true })
    expect(sensitiveSnapshot(inspection)).toBe(before)
    inspection.close()
  })

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
    const { database, path } = openInspectableTestDatabase()

    database.executions.insert({
      id: 'exec_1',
      ownerUserId: 'test-user',
      status: 'running',
      workflowId: 'w',
      workflowVersion: '1.0.0',
    })

    expect(database.schemaVersion()).toBe(15)
    const inspection = new Database(path, { readonly: true })
    expect((inspection.prepare('PRAGMA foreign_key_list(browser_tab_bindings)').all() as Array<{ table: string; on_delete: string }>)
      .map(({ table, on_delete }) => ({ table, on_delete })))
      .toEqual(expect.arrayContaining([
        { table: 'local_users', on_delete: 'CASCADE' },
        { table: 'executions', on_delete: 'SET NULL' },
      ]))
    expect((inspection.prepare('PRAGMA foreign_key_list(browser_tab_bindings)').all() as Array<{ table: string }>)
      .map(({ table }) => table)).not.toEqual(expect.arrayContaining(['conversations', 'chat_runs']))
    expect((inspection.prepare('PRAGMA index_list(browser_action_audits)').all() as Array<{ name: string }>).map(({ name }) => name))
      .toEqual(expect.arrayContaining(['browser_action_audits_binding_sequence_idx']))
    expect((inspection.prepare('PRAGMA index_list(browser_tab_bindings)').all() as Array<{ name: string }>).map(({ name }) => name))
      .toEqual(expect.arrayContaining(['browser_tab_bindings_conversation_status_idx']))
    inspection.close()
    expect(database.executions.markInterrupted()).toBe(1)
    expect(database.executions.get('exec_1')?.status).toBe('interrupted')
  })

  it('migrates v12 executions to opaque user-cache chat-run correlation without losing dependent data or semantics', () => {
    const path = createV12ExecutionBoundaryDatabase()
    const tableSnapshot = (sqlite: Database.Database) => Object.fromEntries([
      'executions',
      'execution_steps',
      'execution_logs',
      'browser_tab_bindings',
      'browser_action_audits',
    ].map((table) => [table, sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
    const v12 = new Database(path)
    v12.pragma('foreign_keys = ON')
    const before = tableSnapshot(v12)
    expect(() => v12.prepare(`
      INSERT INTO executions (
        id, workflow_id, workflow_version, chat_run_id, status, input_json, created_at
      ) VALUES ('blocked_user_cache_execution', 'workflow.boundary', '1.0.0', ?, 'queued', '{}', 8)
    `).run('user_cache_run_not_in_global_chat_runs')).toThrow('FOREIGN KEY constraint failed')
    v12.close()

    const database = openProductionAppDatabase(path)
    expect(() => database.executions.insert({
      id: 'user_cache_execution',
      ownerUserId: 'execution_boundary_user',
      workflowId: 'workflow.boundary',
      workflowVersion: '1.0.0',
      chatRunId: 'user_cache_run_not_in_global_chat_runs',
      status: 'completed',
      input: { source: 'user-cache' },
      result: { inserted: true },
      createdAt: 8,
      startedAt: 9,
      endedAt: 10,
    })).not.toThrow()
    expect(database.executions.update('user_cache_execution', {
      chatRunId: 'updated_user_cache_run_not_in_global_chat_runs',
      result: { updated: true },
    })).toMatchObject({
      chatRunId: 'updated_user_cache_run_not_in_global_chat_runs',
      result: { updated: true },
    })
    expect(database.executions.get('user_cache_execution')).toMatchObject({
      chatRunId: 'updated_user_cache_run_not_in_global_chat_runs',
      input: { source: 'user-cache' },
      result: { updated: true },
    })
    expect(database.chatRuns.get('user_cache_run_not_in_global_chat_runs')).toBeUndefined()
    expect(database.chatRuns.get('updated_user_cache_run_not_in_global_chat_runs')).toBeUndefined()
    expect(database.schemaVersion()).toBe(15)
    database.close()

    const inspection = new Database(path)
    inspection.pragma('foreign_keys = ON')
    const after = tableSnapshot(inspection)
    expect(after.executions).toEqual([
      ...(before.executions as Array<Record<string, unknown>>)
        .map((execution) => ({ ...execution, owner_user_id: null })),
      expect.objectContaining({
        id: 'user_cache_execution',
        chat_run_id: 'updated_user_cache_run_not_in_global_chat_runs',
      }),
    ])
    expect(after.execution_steps).toEqual(before.execution_steps)
    expect(after.execution_logs).toEqual(before.execution_logs)
    expect(after.browser_tab_bindings).toEqual(before.browser_tab_bindings)
    expect(after.browser_action_audits).toEqual(before.browser_action_audits)
    expect((inspection.prepare('PRAGMA foreign_key_list(executions)').all() as Array<{ table: string }>)
      .map(({ table }) => table)).not.toContain('chat_runs')
    expect(inspection.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    for (const [table, indexes] of [
      ['executions', ['executions_status_created_at_idx', 'executions_created_at_idx']],
      ['execution_steps', ['execution_steps_execution_sequence_idx']],
      ['execution_logs', ['execution_logs_execution_sequence_idx']],
      ['browser_tab_bindings', ['browser_tab_bindings_conversation_status_idx']],
      ['browser_action_audits', ['browser_action_audits_binding_sequence_idx']],
    ] as const) {
      const names = (inspection.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>)
        .map(({ name }) => name)
      expect(names).toEqual(expect.arrayContaining([...indexes]))
    }

    inspection.prepare("DELETE FROM executions WHERE id = 'legacy_execution'").run()
    expect(inspection.prepare("SELECT id FROM execution_steps WHERE id = 'legacy_step'").get()).toBeUndefined()
    expect(inspection.prepare("SELECT id FROM execution_logs WHERE id = 'legacy_log'").get()).toBeUndefined()
    expect(inspection.prepare("SELECT execution_id FROM browser_tab_bindings WHERE id = 'legacy_binding'").get())
      .toEqual({ execution_id: null })
    expect(inspection.prepare("SELECT id FROM browser_action_audits WHERE id = 'legacy_audit'").get())
      .toEqual({ id: 'legacy_audit' })
    inspection.prepare("DELETE FROM browser_tab_bindings WHERE id = 'legacy_binding'").run()
    expect(inspection.prepare("SELECT id FROM browser_action_audits WHERE id = 'legacy_audit'").get())
      .toBeUndefined()
    expect(inspection.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    inspection.close()
  })

  it('migrates legacy executions as unowned and requires trusted ownership for new rows', () => {
    const path = createV12ExecutionBoundaryDatabase()
    const database = openProductionAppDatabase(path)

    expect(database.executions.getForUser('legacy_execution', 'execution_boundary_user'))
      .toBeUndefined()
    expect(database.executions.listForUser('execution_boundary_user')).toEqual([])
    expect(() => database.executions.insert({
      id: 'missing_owner_execution',
      workflowId: 'workflow.boundary',
      workflowVersion: '1.0.0',
      status: 'completed',
    } as never)).toThrow()
    expect(database.executions.insert({
      id: 'owned_execution',
      ownerUserId: 'execution_boundary_user',
      workflowId: 'workflow.boundary',
      workflowVersion: '1.0.0',
      status: 'completed',
    })).toMatchObject({ id: 'owned_execution', ownerUserId: 'execution_boundary_user' })
    expect(database.executions.getForUser('owned_execution', 'other_user')).toBeUndefined()
    expect(database.executions.updateForUser(
      'owned_execution', 'other_user', { status: 'cancelled' },
    )).toBeUndefined()
    expect(database.executions.getForUser('owned_execution', 'execution_boundary_user'))
      .toMatchObject({ status: 'completed' })
    expect(database.executionSteps.listForUser('owned_execution', 'other_user')).toEqual([])
    expect(database.executionLogs.listForUser('owned_execution', 'other_user')).toEqual([])
    expect(database.schemaVersion()).toBe(15)
    database.close()

    const inspection = new Database(path, { readonly: true })
    expect(inspection.prepare(
      "SELECT owner_user_id FROM executions WHERE id = 'legacy_execution'",
    ).get()).toEqual({ owner_user_id: null })
    expect(inspection.prepare(
      "SELECT owner_user_id FROM executions WHERE id = 'owned_execution'",
    ).get()).toEqual({ owner_user_id: 'execution_boundary_user' })
    inspection.close()
  })

  it('persists redacted browser continuation audits and expires active bindings on recovery', () => {
    const database = openTestDatabase()
    insertLocalUser(database, 'browser_user', 'BrowserUser')
    const conversation = database.conversations.insert({
      id: 'browser_conversation', title: 'Browser continuation', userId: 'browser_user',
    })
    const run = database.chatRuns.insert({
      id: 'browser_run', conversationId: conversation.id, requestId: 'browser_request',
      model: 'model', status: 'completed', startedAt: 1,
    })
    const execution = database.executions.insert({
      id: 'browser_execution', ownerUserId: 'browser_user', status: 'completed', workflowId: 'gov.permit', workflowVersion: '1.0.0',
    })

    const binding = database.browserTabBindings.insert({
      id: 'binding_1', tabId: 'tab_1', userId: 'browser_user', conversationId: conversation.id,
      chatRunId: run.id, executionId: execution.id,
      workflowId: 'gov.permit', workflowVersion: '1.0.0', source: 'installed',
      securityFingerprint: 'a'.repeat(64),
      permissionMatrix: { 'browser.open': ['https://fw.bjrcgz.gov.cn/*'] },
      status: 'active', createdAt: 10,
    })
    database.browserActionAudits.insert({
      id: 'audit_1', bindingId: binding.id, chatRunId: run.id, sequence: 1,
      origin: 'https://fw.bjrcgz.gov.cn', action: 'inspect', targetSummary: '工作居住证信息',
      risk: 'sensitive_read', outcome: 'completed', createdAt: 11,
    })

    expect(database.browserActionAudits.list(binding.id)).toHaveLength(1)
    expect(database.browserActionAudits.insert({
      id: 'audit_port', bindingId: binding.id, chatRunId: run.id, sequence: 100,
      origin: 'https://fw.bjrcgz.gov.cn:8443', action: 'inspect', targetSummary: '显式端口状态',
      risk: 'sensitive_read', outcome: 'completed', createdAt: 11,
    }).origin).toBe('https://fw.bjrcgz.gov.cn:8443')
    for (const [index, origin] of [
      'http://fw.bjrcgz.gov.cn:8443',
      'https://user@fw.bjrcgz.gov.cn:8443',
    ].entries()) {
      expect(() => database.browserActionAudits.insert({
        id: `audit_invalid_origin_${index}`, bindingId: binding.id, chatRunId: run.id, sequence: 101 + index,
        origin, action: 'inspect', targetSummary: '非安全来源',
        risk: 'sensitive_read', outcome: 'completed', createdAt: 11,
      })).toThrow()
    }
    expect(() => database.browserActionAudits.insert({
      id: 'audit_2', bindingId: binding.id, chatRunId: run.id, sequence: 2,
      origin: 'https://fw.bjrcgz.gov.cn', action: 'inspect',
      targetSummary: `身份证号 11010119900101${'x'.repeat(500)}`,
      risk: 'sensitive_read', outcome: 'completed', createdAt: 12,
    })).toThrow()
    expect(() => database.browserActionAudits.insert({
      id: 'audit_duplicate_sequence', bindingId: binding.id, chatRunId: run.id, sequence: 1,
      origin: 'https://fw.bjrcgz.gov.cn', action: 'inspect', targetSummary: '重复审计',
      risk: 'sensitive_read', outcome: 'completed', createdAt: 12,
    })).toThrow()
    expect(() => database.browserActionAudits.insert({
      id: 'audit_3', bindingId: binding.id, chatRunId: run.id, sequence: 2,
      origin: 'https://fw.bjrcgz.gov.cn?token=secret', action: 'inspect', targetSummary: '状态',
      risk: 'sensitive_read', outcome: 'completed', createdAt: 12,
    })).toThrow()
    for (const [index, path] of [
      '/Users/alice/secret.txt',
      'C:\\Users\\Alice\\secret.txt',
      '\\\\fileserver\\private\\secret.txt',
      'filePath=/tmp/a',
      'file:///Users/alice/secret.txt',
      'FILE:///Users/alice/secret.txt',
    ].entries()) {
      expect(() => database.browserActionAudits.insert({
        id: `audit_path_${index}`, bindingId: binding.id, chatRunId: run.id, sequence: index + 10,
        origin: 'https://fw.bjrcgz.gov.cn', action: index === 3 ? path : 'inspect',
        targetSummary: index === 3 ? '状态' : path,
        risk: 'sensitive_read', outcome: 'completed', createdAt: 12,
      })).toThrow()
    }
    expect(() => database.browserTabBindings.insert({
      ...binding, id: 'binding_path_reason', status: 'closed', terminalReason: 'filePath=/tmp/a',
    })).toThrow()
    expect(() => database.browserTabBindings.terminate(binding.id, {
      status: 'active', terminalReason: 'CANCELLED', endedAt: 20,
    } as never)).toThrow()
    expect(() => database.browserTabBindings.terminate(binding.id, {
      status: 'closed', terminalReason: 'PAGE_CLOSED', endedAt: -1,
    })).toThrow()
    expect(() => database.browserTabBindings.terminate(binding.id, {
      status: 'closed', terminalReason: 'PAGE_CLOSED', endedAt: 20, unexpected: true,
    } as never)).toThrow()

    expect(database.browserTabBindings.terminate(binding.id, {
      status: 'revoked', terminalReason: 'CANCELLED', endedAt: 20,
    })).toMatchObject({
      id: binding.id, status: 'revoked', terminalReason: 'CANCELLED', endedAt: 20,
      permissionMatrix: { 'browser.open': ['https://fw.bjrcgz.gov.cn/*'] },
    })
    expect(database.browserTabBindings.terminate('missing_binding', {
      status: 'closed', terminalReason: 'PAGE_CLOSED', endedAt: 21,
    })).toBeUndefined()
    expect(database.browserTabBindings.get(binding.id)).toMatchObject({
      status: 'revoked', terminalReason: 'CANCELLED', endedAt: 20,
    })

    database.recoverInterrupted()
    expect(database.browserTabBindings.get(binding.id)).toMatchObject({ status: 'revoked', endedAt: 20 })
    database.conversations.delete(conversation.id)
    expect(database.browserTabBindings.get(binding.id)).toMatchObject({
      id: binding.id, conversationId: conversation.id, status: 'revoked',
    })
  })

  it('upgrades a populated v1 database without losing conversations or messages', () => {
    const database = createV1Database()

    expect(database.schemaVersion()).toBe(15)
    expect(database.conversations.get('conversation_v1')).toMatchObject({
      title: 'Persisted v1',
      titleState: 'user_named',
    })
    expect(database.messages.get('message_v1')).toMatchObject({
      blocks: [{ type: 'text', text: 'before upgrade' }],
      ordinal: 1,
    })
  })

  it('upgrades a populated v3 database without losing business data', () => {
    const database = createV3Database()

    expect(database.schemaVersion()).toBe(15)
    expect(database.conversations.get('conversation_v3')).toMatchObject({ title: 'Persisted v3' })
    expect(database.messages.get('message_v3')).toMatchObject({
      blocks: [{ type: 'text', text: 'before auth' }],
      ordinal: 1,
    })
  })

  it('upgrades a populated v4 database without losing local users', () => {
    const { database } = createV4Database()

    expect(database.schemaVersion()).toBe(15)
    expect(database.localAuth.findUserByNormalizedAccount('legacy')).toMatchObject({
      id: 'user_v4', account: 'Legacy',
    })
    expect(database.userProfiles.findByUserId('user_v4')).toBeUndefined()
  })

  it('adds persistent conversation ownership when upgrading an existing database', () => {
    const { path } = createV4Database()
    const inspection = new Database(path)

    const columns = inspection.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>
    expect(columns.map(({ name }) => name)).toContain('user_id')

    inspection.close()
  })

  it('upgrades a populated v4 database with nullable chat-run ownership', () => {
    const { database, path } = createV4Database()

    expect(database.schemaVersion()).toBe(15)
    const inspection = new Database(path)
    expect(inspection.prepare(`
      SELECT user_id AS userId, provider
      FROM chat_runs
      WHERE id = ?
    `).get('run_v4')).toEqual({ userId: null, provider: null })
    inspection.close()
  })

  it('looks up migrated chat runs by request id without inventing ownership', () => {
    const { database } = createV4Database()

    expect(database.chatRuns.getByRequestId('request_v4')).toMatchObject({
      id: 'run_v4',
      requestId: 'request_v4',
      model: 'model-v4',
    })
    expect(database.chatRuns.getByRequestId('request_v4')?.userId).toBeUndefined()
    expect(database.chatRuns.getByRequestId('request_v4')?.provider).toBeUndefined()
    expect(database.chatRuns.getByRequestId('missing_request')).toBeUndefined()
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

  it('persists the owning user when inserting a conversation', () => {
    const database = openTestDatabase()
    insertLocalUser(database, 'user_owner', 'Owner')

    database.conversations.insert({
      id: 'conversation_owned',
      title: 'Owned conversation',
      userId: 'user_owner',
    })

    expect(database.conversations.get('conversation_owned')).toMatchObject({
      id: 'conversation_owned',
      userId: 'user_owner',
    })
  })

  it('allows one AI title attempt without overwriting a user rename', () => {
    const database = openTestDatabase()
    const conversations = database.conversations as typeof database.conversations & {
      insert(value: { id: string; title: string; titleState: 'pending' }): unknown
      claimTitleGeneration(id: string): boolean
      completeTitleGeneration(id: string, title: string): unknown
      failTitleGeneration(id: string): void
      renameByUser(id: string, title: string): unknown
    }

    conversations.insert({ id: 'conversation_ai', title: '新会话', titleState: 'pending' })
    expect(conversations.claimTitleGeneration('conversation_ai')).toBe(true)
    expect(database.conversations.get('conversation_ai')).toMatchObject({ titleState: 'generating' })
    expect(conversations.completeTitleGeneration('conversation_ai', '北京工作居住证')).toMatchObject({
      title: '北京工作居住证',
      titleState: 'ai_named',
    })
    expect(conversations.claimTitleGeneration('conversation_ai')).toBe(false)

    conversations.insert({ id: 'conversation_manual', title: '新会话', titleState: 'pending' })
    expect(conversations.claimTitleGeneration('conversation_manual')).toBe(true)
    expect(conversations.renameByUser('conversation_manual', '我的证件事项')).toMatchObject({
      title: '我的证件事项',
      titleState: 'user_named',
    })
    expect(conversations.completeTitleGeneration('conversation_manual', '不应覆盖')).toBeUndefined()
    expect(database.conversations.get('conversation_manual')).toMatchObject({
      title: '我的证件事项',
      titleState: 'user_named',
    })

    conversations.insert({ id: 'conversation_failed', title: '新会话', titleState: 'pending' })
    expect(conversations.claimTitleGeneration('conversation_failed')).toBe(true)
    conversations.failTitleGeneration('conversation_failed')
    expect(database.conversations.get('conversation_failed')).toMatchObject({ titleState: 'failed' })
    expect(conversations.claimTitleGeneration('conversation_failed')).toBe(false)
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

  it('projects an external identity for business foreign keys without creating a local session', () => {
    const directory = mkdtempSync(join(tmpdir(), 'autoforge-external-identity-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'autoforge.sqlite')
    const database = openAppDatabase(path)
    database.localAuth.createUserAndSession({
      id: 'legacy_user', account: 'Alice', accountNormalized: 'alice',
      passwordDigest: 'legacy-digest', createdAt: 1, updatedAt: 1,
    }, 1)
    database.localAuth.clearSession()

    database.localAuth.ensureExternalIdentity({ id: 'cloudbase_uid_1', account: 'Alice' }, 10)
    database.localAuth.ensureExternalIdentity({ id: 'cloudbase_uid_1', account: 'Alice Cloud' }, 20)

    const inspect = new Database(path)
    expect(inspect.prepare(`
      SELECT id, account, account_normalized AS accountNormalized,
             password_digest AS passwordDigest, created_at AS createdAt, updated_at AS updatedAt
      FROM local_users
      ORDER BY id
    `).all()).toEqual([
      {
        id: 'cloudbase_uid_1', account: 'Alice Cloud',
        accountNormalized: expect.stringMatching(/^cloudbase:/),
        passwordDigest: expect.stringMatching(/^!external-identity:/),
        createdAt: 10, updatedAt: 20,
      },
      {
        id: 'legacy_user', account: 'Alice', accountNormalized: 'alice',
        passwordDigest: 'legacy-digest', createdAt: 1, updatedAt: 1,
      },
    ])
    const projected = inspect.prepare(`
      SELECT account_normalized AS accountNormalized
      FROM local_users
      WHERE id = 'cloudbase_uid_1'
    `).get() as { accountNormalized: string }
    expect(authAccountSchema.safeParse(projected.accountNormalized).success).toBe(false)
    expect(inspect.prepare('SELECT COUNT(*) AS count FROM local_auth_session').get()).toEqual({ count: 0 })
    inspect.close()
    database.close()

    const restarted = openAppDatabase(path)
    restarted.localAuth.ensureExternalIdentity({ id: 'cloudbase_uid_1', account: 'Alice Cloud' }, 30)
    expect(restarted.localAuth.getCurrentSession()).toBeUndefined()
    restarted.close()
  })

  it('stores isolated profiles and updates the current user profile', () => {
    const database = openTestDatabase()
    database.localAuth.createUserAndSession({
      id: 'user_1', account: 'Alice', accountNormalized: 'alice',
      passwordDigest: 'digest', createdAt: 10, updatedAt: 10,
    }, 12)
    database.localAuth.createUserAndSession({
      id: 'user_2', account: 'Bob', accountNormalized: 'bob',
      passwordDigest: 'digest', createdAt: 11, updatedAt: 11,
    }, 13)

    expect(database.userProfiles.findByUserId('user_1')).toBeUndefined()
    database.userProfiles.upsert({
      userId: 'user_1', avatarUrl: null, displayName: 'Alice Zhang', gender: null,
      birthDate: null, email: 'alice@example.com', phone: null, updatedAt: 20,
    })
    database.userProfiles.upsert({
      userId: 'user_1', avatarUrl: 'https://cdn.example.com/a.png', displayName: 'Alice Chen', gender: 'female',
      birthDate: '2000-01-01', email: null, phone: '+8613800138000', updatedAt: 30,
    })

    expect(database.userProfiles.findByUserId('user_1')).toMatchObject({
      displayName: 'Alice Chen', gender: 'female', updatedAt: 30,
    })
    expect(database.userProfiles.findByUserId('user_2')).toBeUndefined()
  })

  it('cascades profile deletion with its local user', () => {
    const database = openTestDatabase()
    database.localAuth.createUserAndSession({
      id: 'user_1', account: 'Alice', accountNormalized: 'alice',
      passwordDigest: 'digest', createdAt: 10, updatedAt: 10,
    }, 11)
    database.userProfiles.upsert({
      userId: 'user_1', avatarUrl: null, displayName: 'Alice', gender: null,
      birthDate: null, email: null, phone: null, updatedAt: 20,
    })

    database.db.run(sql`DELETE FROM local_users WHERE id = 'user_1'`)

    expect(database.userProfiles.findByUserId('user_1')).toBeUndefined()
  })

  it('enforces provider usage identity, state, modality, and token constraints in SQL', () => {
    const directory = mkdtempSync(join(tmpdir(), 'autoforge-provider-usage-constraints-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'autoforge.sqlite')
    const database = openAppDatabase(path)
    insertLocalUser(database, 'user_constraints', 'Constraints')
    const sqlite = new Database(path)
    sqlite.pragma('foreign_keys = ON')
    const insert = (overrides: Record<string, unknown> = {}) => sqlite.prepare(`
      INSERT INTO provider_usage_events (
        id, operation_key, user_id, provider, request_id, generation_id, model,
        modality, status, input_tokens, output_tokens, cost_usd, started_at
      ) VALUES (
        @id, @operationKey, @userId, @provider, @requestId, @generationId, @model,
        @modality, @status, @inputTokens, @outputTokens, @costUsd, @startedAt
      )
    `).run({
      id: 'usage_constraint_base',
      operationKey: 'operation_constraint_base',
      userId: 'user_constraints',
      provider: 'openrouter',
      requestId: 'request_constraint_base',
      generationId: 'generation_constraint_base',
      model: 'model',
      modality: 'text',
      status: 'pending',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
      startedAt: 1,
      ...overrides,
    })

    insert()
    expect(() => insert({ id: 'usage_duplicate_operation', requestId: 'request_duplicate_operation', generationId: null })).toThrow()
    expect(() => insert({ id: 'usage_duplicate_generation', operationKey: 'operation_duplicate_generation', requestId: 'request_duplicate_generation' })).toThrow()
    expect(() => insert({ id: 'usage_reported_without_cost', operationKey: 'operation_reported_without_cost', requestId: 'request_reported_without_cost', generationId: null, status: 'reported' })).toThrow()
    expect(() => insert({ id: 'usage_pending_with_cost', operationKey: 'operation_pending_with_cost', requestId: 'request_pending_with_cost', generationId: null, costUsd: '0' })).toThrow()
    expect(() => insert({ id: 'usage_unknown_with_cost', operationKey: 'operation_unknown_with_cost', requestId: 'request_unknown_with_cost', generationId: null, status: 'unknown', costUsd: '0.1' })).toThrow()
    expect(() => insert({ id: 'usage_bad_modality', operationKey: 'operation_bad_modality', requestId: 'request_bad_modality', generationId: null, modality: 'document' })).toThrow()
    expect(() => insert({ id: 'usage_bad_status', operationKey: 'operation_bad_status', requestId: 'request_bad_status', generationId: null, status: 'complete' })).toThrow()
    expect(() => insert({ id: 'usage_negative_input', operationKey: 'operation_negative_input', requestId: 'request_negative_input', generationId: null, inputTokens: -1 })).toThrow()
    expect(() => insert({ id: 'usage_negative_output', operationKey: 'operation_negative_output', requestId: 'request_negative_output', generationId: null, outputTokens: -1 })).toThrow()
    expect(() => insert({ id: 'usage_missing_user', operationKey: 'operation_missing_user', requestId: 'request_missing_user', generationId: null, userId: 'missing' })).toThrow()
    expect(() => insert({ id: 'usage_zero_cost', operationKey: 'operation_zero_cost', requestId: 'request_zero_cost', generationId: null, status: 'reported', costUsd: '0' })).not.toThrow()
    sqlite.close()
  })

  it('keeps provider usage starts and identity binding idempotent without overwriting conflicts', () => {
    const database = openTestDatabase()
    insertLocalUser(database, 'user_identity', 'Identity')
    insertLocalUser(database, 'user_identity_other', 'IdentityOther')
    const start = usageStart('identity', 'user_identity')

    expect(database.providerUsage.find(start.operationKey)).toBeUndefined()
    expect(database.providerUsage.start(start)).toMatchObject({ ...start, status: 'pending', reconcileAttempts: 0 })
    expect(database.providerUsage.find(start.operationKey)).toMatchObject({
      ...start,
      status: 'pending',
      reconcileAttempts: 0,
    })
    expect(database.providerUsage.start({ ...start })).toMatchObject(start)
    const replay = { ...start, id: 'identity_replay_storage_id', startedAt: 999 }
    expect(database.providerUsage.start(replay)).toMatchObject(start)
    for (const conflict of [
      { ...replay, userId: 'user_identity_other' },
      { ...replay, provider: 'deepseek' as const },
      { ...replay, apiKeyFingerprint: 'other-fingerprint' },
      { ...replay, requestId: 'request_conflict' },
      { ...replay, chatRunId: 'chat_run_conflict' },
      { ...replay, model: 'other/model' },
      { ...replay, modality: 'image' as const },
    ]) {
      expectProviderUsageConsistencyError(() => database.providerUsage.start(conflict))
    }
    expect(database.providerUsage.start({
      ...usageStart('identity_replay_storage_id', 'user_identity'),
      operationKey: 'operation_identity_replay_storage_id_owner',
    })).toMatchObject({ operationKey: 'operation_identity_replay_storage_id_owner' })
    expectProviderUsageConsistencyError(() => (
      database.providerUsage.start({
        ...usageStart('identity_other_operation', 'user_identity'),
        id: start.id,
      })
    ))
    expect(database.providerUsage.bindIdentity(start.operationKey, { generationId: 'generation_identity' }))
      .toMatchObject({ generationId: 'generation_identity' })
    expect(database.providerUsage.bindIdentity(start.operationKey, { generationId: 'generation_identity', providerJobId: 'job_identity' }))
      .toMatchObject({ generationId: 'generation_identity', providerJobId: 'job_identity' })
    expect(database.providerUsage.bindIdentity(start.operationKey, {}))
      .toMatchObject({ generationId: 'generation_identity', providerJobId: 'job_identity' })
    expectProviderUsageConsistencyError(() => (
      database.providerUsage.bindIdentity(start.operationKey, { generationId: 'generation_conflict' })
    ))
    expectProviderUsageConsistencyError(() => (
      database.providerUsage.bindIdentity('operation_missing', { generationId: 'generation_missing' })
    ))
    expect(database.providerUsage.bindIdentity(start.operationKey, {}))
      .toMatchObject({ requestId: start.requestId, generationId: 'generation_identity' })
  })

  it('reports exact costs idempotently and preserves the first terminal values', () => {
    const database = openTestDatabase()
    insertLocalUser(database, 'user_report', 'Report')
    const start = usageStart('report', 'user_report')
    database.providerUsage.start(start)
    const report = {
      generationId: 'generation_report',
      providerJobId: 'job_report',
      inputTokens: 0,
      outputTokens: 7,
      costUsd: 1e-7,
      endedAt: 500,
    }

    expect(database.providerUsage.report(start.operationKey, report)).toMatchObject({
      status: 'reported', generationId: 'generation_report', providerJobId: 'job_report',
      inputTokens: 0, outputTokens: 7, costUsd: '0.0000001', endedAt: 500,
    })
    expect(database.providerUsage.report(start.operationKey, { ...report, costUsd: '0.00000010' }))
      .toMatchObject({ costUsd: '0.0000001' })
    expect(database.providerUsage.report(start.operationKey, { ...report, endedAt: 501 }))
      .toMatchObject({ costUsd: '0.0000001', endedAt: 500 })
    for (const conflict of [
      { ...report, generationId: 'generation_other' },
      { ...report, providerJobId: 'job_other' },
      { ...report, inputTokens: 1 },
      { ...report, outputTokens: 8 },
      { ...report, costUsd: '0.0000002' },
    ]) {
      expectProviderUsageConsistencyError(() => (
        database.providerUsage.report(start.operationKey, conflict)
      ))
    }
    expectProviderUsageConsistencyError(() => database.providerUsage.report('operation_missing', report))
    expect(database.providerUsage.markUnknown(start.operationKey, 999)).toMatchObject({
      status: 'reported', costUsd: '0.0000001', endedAt: 500,
    })
  })

  it('replays reports without identity after identity was bound separately', () => {
    const database = openTestDatabase()
    insertLocalUser(database, 'user_prebound_report', 'Prebound Report')
    const start = usageStart('prebound_report', 'user_prebound_report')
    database.providerUsage.start(start)
    database.providerUsage.bindIdentity(start.operationKey, {
      generationId: 'generation_prebound_report',
      providerJobId: 'job_prebound_report',
    })
    const report = { inputTokens: 3, outputTokens: 4, costUsd: '0.25', endedAt: 600 }

    const first = database.providerUsage.report(start.operationKey, report)
    const replayed = database.providerUsage.report(start.operationKey, report)

    expect(first).toMatchObject({
      status: 'reported',
      generationId: 'generation_prebound_report',
      providerJobId: 'job_prebound_report',
      inputTokens: 3,
      outputTokens: 4,
      costUsd: '0.25',
      endedAt: 600,
    })
    expect(replayed).toEqual(first)
    expect(() => database.providerUsage.report(start.operationKey, {
      ...report,
      generationId: 'generation_conflict',
    })).toThrow('Provider usage consistency error')
    expect(() => database.providerUsage.report(start.operationKey, {
      ...report,
      providerJobId: 'job_conflict',
    })).toThrow('Provider usage consistency error')
  })

  it('marks and recovers pending usage as unknown without changing reported rows', () => {
    const database = openTestDatabase()
    insertLocalUser(database, 'user_unknown', 'Unknown')
    const scheduled = usageStart('scheduled_unknown', 'user_unknown')
    const unscheduled = usageStart('unscheduled_unknown', 'user_unknown', { startedAt: 201 })
    const recovered = usageStart('recovered_unknown', 'user_unknown', { startedAt: 202 })
    const deepseek = usageStart('deepseek_unknown', 'user_unknown', { provider: 'deepseek', startedAt: 203 })
    const reported = usageStart('reported_recovery', 'user_unknown', { startedAt: 204 })
    for (const event of [scheduled, unscheduled, recovered, deepseek, reported]) database.providerUsage.start(event)
    database.providerUsage.bindIdentity(scheduled.operationKey, { generationId: 'generation_scheduled' })
    database.providerUsage.bindIdentity(recovered.operationKey, { generationId: 'generation_recovered' })
    database.providerUsage.bindIdentity(deepseek.operationKey, { generationId: 'generation_deepseek' })
    database.providerUsage.report(reported.operationKey, { costUsd: '0', endedAt: 300 })

    expect(database.providerUsage.markUnknown(scheduled.operationKey, 400)).toMatchObject({
      status: 'unknown', endedAt: 400, nextReconcileAt: 1_400,
    })
    expect(database.providerUsage.markUnknown(scheduled.operationKey, 400)).toMatchObject({ endedAt: 400 })
    expect(database.providerUsage.markUnknown(scheduled.operationKey, 401))
      .toMatchObject({ status: 'unknown', endedAt: 400, nextReconcileAt: 1_400 })
    expect(database.providerUsage.markUnknown(unscheduled.operationKey, 401)).toMatchObject({
      status: 'unknown', endedAt: 401, nextReconcileAt: undefined,
    })
    expect(database.providerUsage.markUnknown(deepseek.operationKey, 402)).toMatchObject({
      status: 'unknown', nextReconcileAt: undefined,
    })
    expectProviderUsageConsistencyError(() => database.providerUsage.markUnknown('operation_missing', 1))

    expect(database.providerUsage.recoverPending(500)).toBe(1)
    expect(database.providerUsage.markUnknown(recovered.operationKey, 500)).toMatchObject({
      status: 'unknown', endedAt: 500, nextReconcileAt: 1_500,
    })
    expect(database.providerUsage.markUnknown(reported.operationKey, 999)).toMatchObject({
      status: 'reported', costUsd: '0', endedAt: 300,
    })
  })

  it('lists reconcilable usage in stable order and caps failed reconciliation attempts', () => {
    const database = openTestDatabase()
    insertLocalUser(database, 'user_reconcile', 'Reconcile')
    const first = usageStart('reconcile_first', 'user_reconcile', { startedAt: 10 })
    const second = usageStart('reconcile_second', 'user_reconcile', { startedAt: 10 })
    const later = usageStart('reconcile_later', 'user_reconcile', { startedAt: 9 })
    for (const event of [second, later, first]) {
      database.providerUsage.start(event)
      database.providerUsage.bindIdentity(event.operationKey, { generationId: `generation_${event.id}` })
      database.providerUsage.markUnknown(event.operationKey, event === later ? 101 : 100)
    }

    expect(database.providerUsage.listReconcilable(1_100).map(({ id }) => id))
      .toEqual(['reconcile_first', 'reconcile_second'])
    expect(database.providerUsage.listReconcilable(1_101).map(({ id }) => id))
      .toEqual(['reconcile_first', 'reconcile_second', 'reconcile_later'])
    expect(database.providerUsage.recordReconcileFailure(first.operationKey, 2_000)).toMatchObject({
      reconcileAttempts: 1, nextReconcileAt: 2_000,
    })
    expect(database.providerUsage.recordReconcileFailure(first.operationKey, 3_000)).toMatchObject({
      reconcileAttempts: 2, nextReconcileAt: 3_000,
    })
    expect(database.providerUsage.recordReconcileFailure(first.operationKey, 4_000)).toMatchObject({
      reconcileAttempts: 3, nextReconcileAt: undefined,
    })
    expect(database.providerUsage.recordReconcileFailure(second.operationKey)).toMatchObject({
      reconcileAttempts: 1, nextReconcileAt: undefined,
    })
    expect(database.providerUsage.listReconcilable(10_000).map(({ id }) => id)).toEqual(['reconcile_later'])
    expect(() => database.providerUsage.recordReconcileFailure('operation_missing', 1))
      .toThrow('Provider usage consistency error')

    const reported = usageStart('reconcile_reported', 'user_reconcile')
    database.providerUsage.start(reported)
    database.providerUsage.report(reported.operationKey, { costUsd: '0', endedAt: 1 })
    expect(() => database.providerUsage.recordReconcileFailure(reported.operationKey, 2))
      .toThrow('Provider usage consistency error')
  })

  it('isolates exact OpenRouter cost summaries by user and groups them by model', () => {
    const database = openTestDatabase()
    insertLocalUser(database, 'alice', 'Alice')
    insertLocalUser(database, 'bob', 'Bob')
    const record = (
      id: string,
      userId: string,
      startedAt: number,
      model: string,
      costUsd?: string | number,
      provider: 'openrouter' | 'deepseek' = 'openrouter',
    ) => {
      const start = usageStart(id, userId, { startedAt, model, provider })
      database.providerUsage.start(start)
      if (costUsd === undefined) database.providerUsage.markUnknown(start.operationKey, startedAt + 1)
      else database.providerUsage.report(start.operationKey, { costUsd, endedAt: startedAt + 1 })
    }
    record('alice_before_month', 'alice', 49, 'z/model', '0.2')
    record('alice_yesterday', 'alice', 100, 'a/model', '0.1000000')
    record('alice_today_tiny', 'alice', 200, 'a/model', 1e-7)
    record('alice_today_zero', 'alice', 201, 'b/model', '0.00')
    record('alice_today_unknown', 'alice', 202, 'a/model')
    record('alice_at_end', 'alice', 300, 'ignored/model', '99')
    record('alice_deepseek', 'alice', 203, 'ignored/model', '88', 'deepseek')
    record('bob_same_fingerprint', 'bob', 200, 'a/model', '77')

    const summary = database.providerUsage.summarize({
      userId: 'alice',
      yesterdayStartedAt: 100,
      todayStartedAt: 200,
      weekStartedAt: 180,
      monthStartedAt: 50,
      endedAt: 300,
    })
    expect(summary.allTimeStartedAt).toBe(49)
    expect(summary.today).toEqual({
      openRouterCostUsd: '0.0000001',
      openRouterKnownCostCount: 2,
      openRouterUnknownCostCount: 1,
      models: [
        { provider: 'openrouter', model: 'a/model', openRouterCostUsd: '0.0000001', openRouterKnownCostCount: 1, openRouterUnknownCostCount: 1 },
        { provider: 'openrouter', model: 'b/model', openRouterCostUsd: '0', openRouterKnownCostCount: 1, openRouterUnknownCostCount: 0 },
      ],
    })
    expect(summary.yesterday.openRouterCostUsd).toBe('0.1')
    expect(summary.week).toEqual(summary.today)
    expect(summary.month.openRouterCostUsd).toBe('0.1000001')
    expect(summary.allTime.openRouterCostUsd).toBe('0.3000001')
    expect(summary.allTime.models.map(({ provider, model }) => `${provider}:${model}`))
      .toEqual(['openrouter:a/model', 'openrouter:b/model', 'openrouter:z/model'])
    expect(JSON.stringify(summary)).not.toContain('77')
    expect(JSON.stringify(summary)).not.toContain('88')
  })

  it('retains provider usage after conversation deletion and local-data clearing', () => {
    const { database, path } = openInspectableTestDatabase()
    insertLocalUser(database, 'user_retention', 'Retention')
    for (const suffix of ['delete', 'clear_conversations', 'clear_all']) {
      const conversationId = `conversation_usage_${suffix}`
      const runId = `run_usage_${suffix}`
      database.conversations.insert({ id: conversationId, title: suffix })
      database.chatRuns.insert({
        id: runId, conversationId, requestId: `request_run_${suffix}`,
        model: 'model', status: 'completed', startedAt: 1,
      })
      const start = usageStart(`retained_${suffix}`, 'user_retention', { chatRunId: runId, startedAt: 1 })
      database.providerUsage.start(start)
      database.providerUsage.report(start.operationKey, { costUsd: '0', endedAt: 2 })
    }

    database.conversations.delete('conversation_usage_delete')
    database.executions.insert({
      id: 'execution_clear_all',
      ownerUserId: 'user_retention',
      workflowId: 'workflow_clear_all',
      workflowVersion: '1.0.0',
      status: 'completed',
    })
    expect(database.providerUsage.summarize({ userId: 'user_retention', yesterdayStartedAt: 0, todayStartedAt: 0, weekStartedAt: 0, monthStartedAt: 0, endedAt: 10 }).allTime.openRouterKnownCostCount).toBe(3)
    const production = openProductionAppDatabase(path)
    expect(() => production.clearConversations()).toThrow(expect.objectContaining({ code: 'CONFLICT' }))
    expect(database.conversations.get('conversation_usage_clear_conversations')).toBeDefined()
    expect(database.providerUsage.summarize({ userId: 'user_retention', yesterdayStartedAt: 0, todayStartedAt: 0, weekStartedAt: 0, monthStartedAt: 0, endedAt: 10 }).allTime.openRouterKnownCostCount).toBe(3)
    expect(() => production.clearLocalData('all')).toThrow(expect.objectContaining({ code: 'CONFLICT' }))
    expect(database.conversations.get('conversation_usage_clear_all')).toBeDefined()
    expect(database.executions.get('execution_clear_all')).toBeDefined()
    production.clearLocalData('executions')
    expect(database.executions.get('execution_clear_all')).toBeUndefined()
    expect(database.providerUsage.summarize({ userId: 'user_retention', yesterdayStartedAt: 0, todayStartedAt: 0, weekStartedAt: 0, monthStartedAt: 0, endedAt: 10 }).allTime.openRouterKnownCostCount).toBe(3)
    production.close()
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
        id: `execution_${status}`, ownerUserId: 'recovery_user', status, workflowId: 'workflow', workflowVersion: '1.0.0',
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

  it('marks an interrupted conversation-title generation failed during recovery', () => {
    const database = openTestDatabase()
    database.conversations.insert({
      id: 'conversation_title_recovery', title: '新会话', titleState: 'pending',
    })
    expect(database.conversations.claimTitleGeneration('conversation_title_recovery')).toBe(true)

    database.recoverInterrupted()

    expect(database.conversations.get('conversation_title_recovery')).toMatchObject({
      title: '新会话', titleState: 'failed',
    })
  })

  it('terminalizes only nonterminal browser statuses owned by interrupted chat runs', () => {
    const database = openTestDatabase()
    database.conversations.insert({ id: 'browser_status_recovery', title: 'Browser recovery' })
    for (const [id, requestId, status] of [
      ['run_browser_inspecting', 'request_browser_inspecting', 'running'],
      ['run_browser_acting', 'request_browser_acting', 'streaming'],
      ['run_browser_finished', 'request_browser_finished', 'completed'],
    ] as const) {
      database.chatRuns.insert({
        id, conversationId: 'browser_status_recovery', requestId,
        model: 'model', status, startedAt: 1,
      })
    }
    const status = (
      blockId: string,
      requestId: string,
      state: 'inspecting' | 'acting' | 'awaiting_user' | 'completed',
      origin = 'https://example.test',
    ) => ({
      type: 'browser_status' as const,
      blockId,
      requestId,
      bindingId: 'binding_browser_recovery',
      siteLabel: '恢复测试站点',
      origin,
      state,
      actionSummary: '恢复前状态',
    })
    database.messages.insert({
      id: 'message_browser_status_recovery',
      conversationId: 'browser_status_recovery',
      role: 'assistant',
      createdAt: 1,
      blocks: [
        status('block_inspecting', 'request_browser_inspecting', 'inspecting'),
        status('block_explicit_port', 'request_browser_inspecting', 'inspecting', 'https://example.test:8443'),
        status('block_acting', 'request_browser_acting', 'acting'),
        status('block_handoff', 'request_browser_inspecting', 'awaiting_user'),
        status('block_completed', 'request_browser_acting', 'completed'),
        status('block_unrelated', 'request_browser_finished', 'acting'),
        { type: 'malformed_unrelated', rawSecret: 'must remain isolated' },
      ],
    })

    expect(database.recoverInterrupted()).toEqual({ executions: 0, chatRuns: 2 })
    expect(database.messages.get('message_browser_status_recovery')?.blocks).toEqual([
      {
        ...status('block_inspecting', 'request_browser_inspecting', 'inspecting'),
        state: 'failed',
        actionSummary: '应用已重启，浏览器自动操作已中断',
        errorCode: 'INTERNAL_ERROR',
      },
      {
        ...status('block_explicit_port', 'request_browser_inspecting', 'inspecting', 'https://example.test:8443'),
        state: 'failed',
        actionSummary: '应用已重启，浏览器自动操作已中断',
        errorCode: 'INTERNAL_ERROR',
      },
      {
        ...status('block_acting', 'request_browser_acting', 'acting'),
        state: 'failed',
        actionSummary: '应用已重启，浏览器自动操作已中断',
        errorCode: 'INTERNAL_ERROR',
      },
      status('block_handoff', 'request_browser_inspecting', 'awaiting_user'),
      status('block_completed', 'request_browser_acting', 'completed'),
      status('block_unrelated', 'request_browser_finished', 'acting'),
      { type: 'malformed_unrelated', rawSecret: 'must remain isolated' },
    ])
  })

  it('invalidates persisted pending Agent approvals while tolerating unrelated malformed blocks', () => {
    const database = openTestDatabase()
    database.conversations.insert({ id: 'approval_recovery_conversation', title: 'Approval recovery' })
    const approval = {
      type: 'approval', blockId: 'approval_pending', state: 'pending',
      executionId: 'execution_approval_recovery', workflowId: 'workflow.recovery',
      workflowName: 'Recovery workflow', workflowVersion: '1.0.0', source: 'installed',
      actionSummary: '恢复前待审批操作', permissionIndex: 0, capability: 'filesystem.write',
      scope: { paths: ['/Users/private/recovery.txt'] }, scopeHash: 'a'.repeat(64),
    }
    database.messages.insert({
      id: 'approval_recovery_message', conversationId: 'approval_recovery_conversation',
      role: 'assistant', createdAt: 1,
      blocks: [
        approval,
        { type: 'malformed_unrelated', rawSecret: 'must remain isolated' },
        { ...approval, blockId: 'approval_already_denied', executionId: 'execution_denied', state: 'denied' },
      ],
    })
    database.executions.insert({
      id: 'execution_approval_recovery', status: 'awaiting_approval',
      ownerUserId: 'approval_recovery_user',
      workflowId: 'workflow.recovery', workflowVersion: '1.0.0',
    })
    database.chatRuns.insert({
      id: 'run_approval_recovery', conversationId: 'approval_recovery_conversation',
      requestId: 'request_approval_recovery', model: 'model', status: 'awaiting_approval', startedAt: 1,
    })

    expect(database.recoverInterrupted()).toEqual({ executions: 1, chatRuns: 1 })
    expect(database.executions.get('execution_approval_recovery')).toMatchObject({ status: 'interrupted' })
    expect(database.chatRuns.get('run_approval_recovery')).toMatchObject({ status: 'failed' })
    expect(database.messages.get('approval_recovery_message')?.blocks).toEqual([
      { ...approval, state: 'invalidated' },
      { type: 'malformed_unrelated', rawSecret: 'must remain isolated' },
      { ...approval, blockId: 'approval_already_denied', executionId: 'execution_denied', state: 'denied' },
    ])
    expect(database.messages.hasWorkflowApproval('execution_approval_recovery')).toBe(true)
    expect(database.messages.hasWorkflowApproval('manual_execution')).toBe(false)
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

  it('upgrades only the exact strict legacy approval shape to a stable disabled block', () => {
    const directory = mkdtempSync(join(tmpdir(), 'autoforge-database-legacy-approval-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'autoforge.sqlite')
    const database = openAppDatabase(path)
    database.conversations.insert({ id: 'legacy_approval_conversation', title: 'Legacy approval' })
    database.messages.insert({
      id: 'legacy_approval_message', conversationId: 'legacy_approval_conversation', role: 'assistant',
      blocks: [], createdAt: 1,
    })
    database.messages.insert({
      id: 'near_legacy_approval_message', conversationId: 'legacy_approval_conversation', role: 'assistant',
      blocks: [], createdAt: 2,
    })
    database.close()
    const legacyApproval = {
      type: 'approval', executionId: 'legacy_execution', workflowId: 'legacy.workflow',
      workflowVersion: '1.0.0', permissionIndex: 0, capability: 'browser.open',
      scope: { origins: ['https://example.com'] }, scopeHash: 'a'.repeat(64),
    }
    const seed = new Database(path)
    seed.prepare('UPDATE messages SET blocks_json = ? WHERE id = ?')
      .run(JSON.stringify([legacyApproval]), 'legacy_approval_message')
    seed.prepare('UPDATE messages SET blocks_json = ? WHERE id = ?')
      .run(JSON.stringify([{ ...legacyApproval, unexpected: true }]), 'near_legacy_approval_message')
    seed.close()

    const upgraded = openAppDatabase(path)
    const block = upgraded.messages.get('legacy_approval_message')?.blocks[0]
    expect(chatBlockSchema.parse(block)).toMatchObject({
      type: 'approval', state: 'invalidated', executionId: 'legacy_execution',
      workflowId: 'legacy.workflow', workflowName: 'legacy.workflow', workflowVersion: '1.0.0',
      source: 'installed', actionSummary: '历史权限审批已失效', permissionIndex: 0,
      capability: 'browser.open', scope: { origins: ['https://example.com'] },
      scopeHash: 'a'.repeat(64),
    })
    if (!block || typeof block !== 'object' || !('blockId' in block) || typeof block.blockId !== 'string') {
      throw new Error('Expected upgraded approval identity')
    }
    const blockId = block.blockId
    expect(blockId).not.toMatch(/legacy_execution|legacy\.workflow|private|secret/)
    expect(chatBlockSchema.safeParse(upgraded.messages.get('near_legacy_approval_message')?.blocks[0]).success)
      .toBe(false)
    upgraded.close()

    const reopened = openAppDatabase(path)
    expect(reopened.messages.get('legacy_approval_message')?.blocks[0]).toMatchObject({ blockId })
    const persisted = new Database(path, { readonly: true })
    expect(JSON.parse((persisted.prepare('SELECT blocks_json AS blocksJson FROM messages WHERE id = ?')
      .get('legacy_approval_message') as { blocksJson: string }).blocksJson)[0]).toMatchObject({
      blockId, state: 'invalidated', actionSummary: '历史权限审批已失效',
    })
    persisted.close()
    reopened.close()
  })

  it('matches the exact historical approval capability and runtime-scope matrix', () => {
    const directory = mkdtempSync(join(tmpdir(), 'autoforge-database-legacy-approval-matrix-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'autoforge.sqlite')
    const database = openAppDatabase(path)
    database.conversations.insert({ id: 'legacy_matrix_conversation', title: 'Legacy matrix' })
    const cases = [
      { name: 'browser exact origin', capability: 'browser.open', scope: { origins: ['https://example.com'] }, accepted: true },
      { name: 'filesystem path', capability: 'filesystem.write', scope: { paths: ['/tmp/result.txt'] }, accepted: true },
      { name: 'empty notification', capability: 'notification.send', scope: {}, accepted: true },
      { name: 'browser empty scope', capability: 'browser.open', scope: {}, accepted: false },
      { name: 'browser wildcard origin', capability: 'browser.open', scope: { origins: ['*.example.com'] }, accepted: false },
      { name: 'browser path scope', capability: 'browser.open', scope: { paths: ['/tmp'] }, accepted: false },
    ] as const
    for (const index of cases.keys()) {
      database.messages.insert({
        id: `legacy_matrix_${index}`, conversationId: 'legacy_matrix_conversation',
        role: 'assistant', blocks: [], createdAt: index + 1,
      })
    }
    database.close()
    const seed = new Database(path)
    for (const [index, value] of cases.entries()) {
      seed.prepare('UPDATE messages SET blocks_json = ? WHERE id = ?').run(JSON.stringify([{
        type: 'approval', executionId: `legacy_matrix_execution_${index}`,
        workflowId: 'legacy.workflow', workflowVersion: '1.0.0', permissionIndex: 0,
        capability: value.capability, scope: value.scope, scopeHash: 'a'.repeat(64),
      }]), `legacy_matrix_${index}`)
    }
    seed.close()

    const upgraded = openAppDatabase(path)
    for (const [index, value] of cases.entries()) {
      const block = upgraded.messages.get(`legacy_matrix_${index}`)?.blocks[0]
      expect({ name: value.name, normalized: chatBlockSchema.safeParse(block).success }).toEqual({
        name: value.name, normalized: value.accepted,
      })
      expect(upgraded.messages.hasWorkflowApproval(`legacy_matrix_execution_${index}`)).toBe(value.accepted)
    }
    upgraded.close()
  })

  it('targets persisted Agent ownership by indexed identity without parsing unrelated transcripts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'autoforge-database-agent-ownership-query-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'autoforge.sqlite')
    const database = openAppDatabase(path)
    database.conversations.insert({ id: 'ownership_query_conversation', title: 'Ownership query' })
    const bulk = new Database(path)
    const insertIrrelevant = bulk.prepare(`
      INSERT INTO messages (id, conversation_id, role, blocks_json, ordinal, created_at)
      VALUES (?, 'ownership_query_conversation', 'assistant', ?, ?, ?)
    `)
    bulk.transaction(() => {
      for (let index = 0; index < 10_000; index += 1) {
        insertIrrelevant.run(
          `ownership_irrelevant_${index}`,
          JSON.stringify([{ type: 'text', text: `irrelevant ${index}` }]),
          index + 1,
          index + 1,
        )
      }
    })()
    bulk.close()
    database.messages.insert({
      id: 'ownership_malformed_json', conversationId: 'ownership_query_conversation',
      role: 'assistant', blocks: [], createdAt: 10_001,
    })
    const fault = new Database(path)
    fault.prepare('UPDATE messages SET blocks_json = ? WHERE id = ?')
      .run('{not valid json', 'ownership_malformed_json')
    fault.close()
    database.messages.insert({
      id: 'ownership_invalid_legacy', conversationId: 'ownership_query_conversation', role: 'assistant',
      blocks: [{
        type: 'approval', executionId: 'invalid_legacy_execution', workflowId: 'legacy.workflow',
        workflowVersion: '1.0.0', permissionIndex: 0, capability: 'browser.open',
        scope: {}, scopeHash: 'a'.repeat(64),
      }], createdAt: 10_002,
    })
    database.messages.insert({
      id: 'ownership_near_current', conversationId: 'ownership_query_conversation', role: 'assistant',
      blocks: [{
        type: 'approval', blockId: 'near_current', state: 'pending',
        executionId: 'near_current_execution', workflowId: 'workflow.current',
        workflowVersion: '1.0.0', source: 'installed', actionSummary: 'missing workflow name',
        permissionIndex: 0, capability: 'notification.send', scope: {}, scopeHash: 'b'.repeat(64),
      }], createdAt: 10_003,
    })
    database.messages.insert({
      id: 'ownership_exact_current', conversationId: 'ownership_query_conversation', role: 'assistant',
      blocks: [{
        type: 'approval', blockId: 'exact_current', state: 'invalidated',
        executionId: 'exact_current_execution', workflowId: 'workflow.current',
        workflowName: 'Current workflow', workflowVersion: '1.0.0', source: 'installed',
        actionSummary: 'Persisted approval', permissionIndex: 0,
        capability: 'notification.send', scope: {}, scopeHash: 'c'.repeat(64),
      }], createdAt: 10_004,
    })
    const inspection = new Database(path, { readonly: true })
    const plan = inspection.prepare(`
      EXPLAIN QUERY PLAN
      SELECT 1 FROM agent_workflow_approvals WHERE execution_id = ?
    `).all('exact_current_execution') as Array<{ detail: string }>
    expect(plan.map(({ detail }) => detail).join('\n')).toMatch(
      /SEARCH agent_workflow_approvals USING (?:COVERING )?INDEX .* \(execution_id=\?\)/,
    )
    inspection.close()
    const parseJson = vi.spyOn(JSON, 'parse')
    parseJson.mockClear()

    expect(database.messages.hasWorkflowApproval('exact_current_execution')).toBe(true)
    expect(parseJson).not.toHaveBeenCalled()
    parseJson.mockClear()
    expect(database.messages.hasWorkflowApproval('invalid_legacy_execution')).toBe(false)
    expect(parseJson).not.toHaveBeenCalled()
    parseJson.mockClear()
    expect(database.messages.hasWorkflowApproval('near_current_execution')).toBe(false)
    expect(parseJson).not.toHaveBeenCalled()
    parseJson.mockClear()
    expect(database.messages.hasWorkflowApproval('manual_execution')).toBe(false)
    expect(parseJson).not.toHaveBeenCalled()

    parseJson.mockRestore()
    database.close()
  })

  it('backfills current and exact legacy Agent approvals and cascades their ownership', () => {
    const directory = mkdtempSync(join(tmpdir(), 'autoforge-database-agent-ownership-migration-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'autoforge.sqlite')
    const sqlite = new Database(path)
    const migrations = [
      '0001_init.sql', '0002_multimodal_media.sql', '0003_conversation_context.sql',
      '0004_local_auth.sql', '0005_user_profile.sql', '0006_provider_usage.sql',
      '0007_conversation_ownership.sql', '0008_local_user_roles.sql',
    ]
    for (const [index, fileName] of migrations.entries()) {
      sqlite.exec(readFileSync(fileURLToPath(new URL(`../../../resources/migrations/${fileName}`, import.meta.url)), 'utf8'))
      sqlite.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(index + 1, index + 1)
    }
    sqlite.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('ownership_migration_conversation', 'Ownership migration', 1, 1)
    const currentApproval = {
      type: 'approval', blockId: 'current_approval', state: 'denied',
      executionId: 'current_execution', workflowId: 'workflow.current',
      workflowName: 'Current workflow', workflowVersion: '1.0.0', source: 'installed',
      actionSummary: 'Current persisted approval', permissionIndex: 0,
      capability: 'notification.send', scope: {}, scopeHash: 'a'.repeat(64),
    }
    const legacyApproval = {
      type: 'approval', executionId: 'legacy_execution', workflowId: 'workflow.legacy',
      workflowVersion: '1.0.0', permissionIndex: 0, capability: 'browser.open',
      scope: { origins: ['https://example.com'] }, scopeHash: 'b'.repeat(64),
    }
    const invalidApproval = { ...legacyApproval, executionId: 'invalid_execution', scope: {} }
    const insert = sqlite.prepare(`
      INSERT INTO messages (id, conversation_id, role, blocks_json, ordinal, created_at)
      VALUES (?, 'ownership_migration_conversation', ?, ?, ?, ?)
    `)
    insert.run('current_message', 'assistant', JSON.stringify([currentApproval]), 1, 1)
    insert.run('legacy_message', 'assistant', JSON.stringify([legacyApproval]), 2, 2)
    insert.run('invalid_message', 'assistant', JSON.stringify([invalidApproval]), 3, 3)
    insert.run('user_message', 'user', JSON.stringify([{ ...currentApproval, executionId: 'user_execution' }]), 4, 4)
    sqlite.close()

    const database = openAppDatabase(path)
    expect(database.schemaVersion()).toBe(15)
    expect(database.messages.get('current_message')?.blocks).toEqual([currentApproval])
    expect(database.messages.hasWorkflowApproval('current_execution')).toBe(true)
    expect(database.messages.hasWorkflowApproval('legacy_execution')).toBe(true)
    expect(database.messages.hasWorkflowApproval('invalid_execution')).toBe(false)
    expect(database.messages.hasWorkflowApproval('user_execution')).toBe(false)

    const inspection = new Database(path)
    expect(inspection.prepare(`
      SELECT execution_id AS executionId, message_id AS messageId
      FROM agent_workflow_approvals
      ORDER BY execution_id
    `).all()).toEqual([
      { executionId: 'current_execution', messageId: 'current_message' },
      { executionId: 'legacy_execution', messageId: 'legacy_message' },
    ])
    inspection.close()

    database.conversations.delete('ownership_migration_conversation')
    expect(database.messages.hasWorkflowApproval('current_execution')).toBe(false)
    expect(database.messages.hasWorkflowApproval('legacy_execution')).toBe(false)
    database.close()
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

  it('rejects generated generic file assets before persistence', () => {
    const database = openTestDatabase()
    database.conversations.insert({ id: 'conversation_generated_file', title: 'Generated file' })

    expect(() => database.mediaAssets.insert({
      ...readyAsset('asset_generated_file', 'conversation_generated_file'),
      source: 'generated',
      kind: 'file',
      mimeType: 'application/pdf',
      originalName: 'report.pdf',
      relativePath: 'conversation_generated_file/asset_generated_file.pdf',
    })).toThrow()

    expect(database.mediaAssets.get('asset_generated_file')).toBeUndefined()
  })

  it('persists a ready generic file attachment after the attachment-kind migration', () => {
    const database = openTestDatabase()
    database.conversations.insert({ id: 'conversation_file_attachment', title: 'File attachment' })

    database.mediaAssets.insert({
      ...readyAsset('asset_file_attachment', 'conversation_file_attachment'),
      kind: 'file',
      mimeType: 'application/pdf',
      originalName: 'report.pdf',
      relativePath: 'conversation_file_attachment/asset_file_attachment.pdf',
    })

    expect(database.mediaAssets.get('asset_file_attachment')).toMatchObject({
      kind: 'file',
      mimeType: 'application/pdf',
      originalName: 'report.pdf',
    })
  })

  it('migrates v14 media assets to support generic file attachments without losing media relationships', () => {
    const directory = mkdtempSync(join(tmpdir(), 'autoforge-database-v14-file-attachment-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'autoforge.sqlite')
    const sqlite = new Database(path)
    const migrationDirectory = fileURLToPath(new URL('../../../resources/migrations/', import.meta.url))
    const migrations = readdirSync(migrationDirectory)
      .map((fileName) => ({ fileName, version: Number.parseInt(fileName.slice(0, 4), 10) }))
      .filter(({ fileName, version }) => fileName.endsWith('.sql') && version <= 14)
      .sort((left, right) => left.version - right.version)
    for (const migration of migrations) {
      sqlite.exec(readFileSync(join(migrationDirectory, migration.fileName), 'utf8'))
      sqlite.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(migration.version, migration.version)
    }
    sqlite.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('conversation_v14_file_attachment', 'V14 attachment', 1, 1)
    sqlite.prepare('INSERT INTO messages (id, conversation_id, role, blocks_json, ordinal, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('message_v14_file_attachment', 'conversation_v14_file_attachment', 'assistant', '[]', 1, 1)
    sqlite.prepare(`
      INSERT INTO media_assets (
        id, conversation_id, message_id, source, kind, mime_type, original_name, relative_path,
        byte_size, sha256, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'generated', 'image', 'image/png', 'preserved.png', ?, 12, ?, 'ready', 1, 1)
    `).run(
      'asset_v14_file_attachment',
      'conversation_v14_file_attachment',
      'message_v14_file_attachment',
      'conversation_v14_file_attachment/asset_v14_file_attachment.png',
      'a'.repeat(64),
    )
    sqlite.prepare(`
      INSERT INTO media_generation_jobs (
        id, conversation_id, assistant_message_id, provider, model, kind, provider_job_id,
        status, parameters_json, asset_id, created_at, updated_at
      ) VALUES (?, ?, ?, 'openrouter', 'video-model', 'video', 'provider-job', 'completed', '{}', ?, 1, 1)
    `).run(
      'job_v14_file_attachment',
      'conversation_v14_file_attachment',
      'message_v14_file_attachment',
      'asset_v14_file_attachment',
    )
    sqlite.close()

    const database = openAppDatabase(path)

    expect(database.schemaVersion()).toBe(15)
    expect(database.mediaAssets.get('asset_v14_file_attachment')).toMatchObject({
      id: 'asset_v14_file_attachment',
      kind: 'image',
      messageId: 'message_v14_file_attachment',
    })
    expect(database.mediaGenerationJobs.get('job_v14_file_attachment')?.assetId)
      .toBe('asset_v14_file_attachment')
    database.mediaAssets.insert({
      ...readyAsset('asset_v15_file_attachment', 'conversation_v14_file_attachment'),
      kind: 'file',
      mimeType: 'application/pdf',
      originalName: 'new-report.pdf',
      relativePath: 'conversation_v14_file_attachment/asset_v15_file_attachment.pdf',
    })
    database.close()

    const inspection = new Database(path)
    expect(() => inspection.prepare(`
      INSERT INTO media_assets (
        id, conversation_id, source, kind, original_name, status, created_at, updated_at
      ) VALUES (?, ?, 'generated', 'file', 'generated.pdf', 'ready', 1, 1)
    `).run('asset_v15_generated_file', 'conversation_v14_file_attachment')).toThrow()
    expect((inspection.prepare('PRAGMA index_list(media_assets)').all() as Array<{ name: string }>).map(({ name }) => name))
      .toEqual(expect.arrayContaining(['media_assets_conversation_status_idx', 'media_assets_unclaimed_idx']))
    expect(inspection.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    inspection.close()
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
      ownerUserId: 'parameters_recovery_user',
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

  it('persists chat-run ownership and isolates token usage by user and provider', () => {
    const database = openTestDatabase()
    insertLocalUser(database, 'alice', 'alice@example.com')
    insertLocalUser(database, 'bob', 'bob@example.com')
    database.conversations.insert({ id: 'conversation_usage_ownership', title: 'Usage ownership' })
    const insert = (
      id: string,
      userId: string | undefined,
      provider: 'deepseek' | 'openrouter' | undefined,
      status: 'completed' | 'failed',
      startedAt: number,
      inputTokens?: number,
      outputTokens?: number,
    ) => database.chatRuns.insert({
      id,
      conversationId: 'conversation_usage_ownership',
      requestId: `request_${id}`,
      model: 'shared/model',
      status,
      startedAt,
      ...(userId === undefined ? {} : { userId }),
      ...(provider === undefined ? {} : { provider }),
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
    })
    const query = (userId: string) => ({
      userId,
      yesterdayStartedAt: 100,
      todayStartedAt: 200,
      weekStartedAt: 100,
      monthStartedAt: 100,
      endedAt: 300,
    })

    insert('alice_openrouter', 'alice', 'openrouter', 'completed', 200, 3, 4)
    insert('alice_deepseek', 'alice', 'deepseek', 'failed', 201, 2, 1)
    insert('bob_openrouter', 'bob', 'openrouter', 'completed', 202, 11)
    insert('historical', undefined, undefined, 'completed', 203, 99)

    expect(database.chatRuns.get('alice_openrouter')).toMatchObject({
      userId: 'alice', provider: 'openrouter',
    })
    expect(database.chatRuns.summarizeTokenUsage(query('alice')).today).toMatchObject({
      inputTokens: 5,
      outputTokens: 5,
      totalTokens: 10,
      models: [
        { provider: 'openrouter', model: 'shared/model', inputTokens: 3, outputTokens: 4, totalTokens: 7 },
        { provider: 'deepseek', model: 'shared/model', inputTokens: 2, outputTokens: 1, totalTokens: 3 },
      ],
      trend: [{ bucket: '0', inputTokens: 5, outputTokens: 5, totalTokens: 10 }],
    })
    expect(database.chatRuns.summarizeTokenUsage(query('bob')).today).toMatchObject({
      inputTokens: 11,
      outputTokens: 0,
      totalTokens: 11,
      models: [{ provider: 'openrouter', model: 'shared/model', inputTokens: 11, outputTokens: 0, totalTokens: 11 }],
      trend: [{ bucket: '0', inputTokens: 11, outputTokens: 0, totalTokens: 11 }],
    })
    expect(() => insert('alice_without_provider', 'alice', undefined, 'completed', 204, 1))
      .toThrow('Owned chat run requires a provider')
  })

  it('summarizes retained token usage and preserves it during global legacy clearing', () => {
    const { database, path } = openInspectableTestDatabase()
    insertLocalUser(database, 'usage_user', 'usage@example.com')
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
      userId: 'usage_user',
      provider: 'openrouter',
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
    })

    const query = {
      userId: 'usage_user',
      yesterdayStartedAt: 100,
      todayStartedAt: 200,
      weekStartedAt: 180,
      monthStartedAt: 50,
      endedAt: 300,
    }

    insert('before_month', 'alpha/model', 'completed', 49, 10, 5)
    insert('yesterday', 'alpha/model', 'failed', 100, 7)
    insert('today', 'beta/model', 'cancelled', 200, undefined, 9)
    insert('today_zero', 'zero/model', 'completed', 201, 0, 0)
    insert('at_end', 'ignored/model', 'completed', 300, 99, 99)
    insert('no_usage', 'ignored/model', 'completed', 250)

    const usage = database.chatRuns.summarizeTokenUsage(query)
    expect(usage.allTimeStartedAt).toBe(49)
    expect(usage.today.models).toEqual([
      { provider: 'openrouter', model: 'beta/model', inputTokens: 0, outputTokens: 9, totalTokens: 9 },
      { provider: 'openrouter', model: 'zero/model', inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    ])
    expect(usage.yesterday.models).toEqual([
      { provider: 'openrouter', model: 'alpha/model', inputTokens: 7, outputTokens: 0, totalTokens: 7 },
    ])
    expect(usage.week.models).toEqual(usage.today.models)
    expect(usage.month.models).toEqual([
      { provider: 'openrouter', model: 'beta/model', inputTokens: 0, outputTokens: 9, totalTokens: 9 },
      { provider: 'openrouter', model: 'alpha/model', inputTokens: 7, outputTokens: 0, totalTokens: 7 },
      { provider: 'openrouter', model: 'zero/model', inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    ])
    expect(usage.allTime.models[0]).toEqual({
      provider: 'openrouter', model: 'alpha/model', inputTokens: 17, outputTokens: 5, totalTokens: 22,
    })
    expect(usage.allTime.models.some(({ model }) => model === 'ignored/model')).toBe(false)

    const production = openProductionAppDatabase(path)
    expect(() => production.clearLocalData('conversations'))
      .toThrow(expect.objectContaining({ code: 'CONFLICT' }))
    expect(database.chatRuns.summarizeTokenUsage(query)).toEqual(usage)
    expect(database.conversations.get('conversation_usage')).toMatchObject({ id: 'conversation_usage' })
    production.close()
  })

  it('groups token usage trends by local calendar boundaries and excludes the query end point', () => {
    const database = openTestDatabase()
    insertLocalUser(database, 'usage_trends_user', 'trends@example.com')
    database.conversations.insert({ id: 'conversation_usage_trends', title: 'Usage trends' })
    const local = (year: number, month: number, day: number, hour = 0) => (
      new Date(year, month, day, hour).getTime()
    )
    const insert = (
      id: string,
      startedAt: number,
      inputTokens: number,
      outputTokens: number,
    ) => database.chatRuns.insert({
      id,
      conversationId: 'conversation_usage_trends',
      requestId: `request_${id}`,
      model: 'alpha/model',
      status: 'completed',
      startedAt,
      userId: 'usage_trends_user',
      provider: 'openrouter',
      inputTokens,
      outputTokens,
    })
    const query = {
      userId: 'usage_trends_user',
      yesterdayStartedAt: local(2025, 11, 31),
      todayStartedAt: local(2026, 0, 1),
      weekStartedAt: local(2025, 11, 29),
      monthStartedAt: local(2026, 0, 1),
      endedAt: local(2026, 0, 2),
    }

    insert('previous_month', local(2025, 11, 31, 8), 1, 2)
    insert('hour_a', local(2026, 0, 1, 8), 2, 1)
    insert('hour_b', local(2026, 0, 1, 8) + 1_000, 3, 4)
    insert('at_end', query.endedAt, 50, 50)

    const usage = database.chatRuns.summarizeTokenUsage(query)
    expect(usage.today.trend).toEqual([
      { bucket: '8', inputTokens: 5, outputTokens: 5, totalTokens: 10 },
    ])
    expect(usage.week.trend).toEqual([
      { bucket: '2025-12-31', inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      { bucket: '2026-01-01', inputTokens: 5, outputTokens: 5, totalTokens: 10 },
    ])
    expect(usage.allTime.trend).toEqual([
      { bucket: '2025-12', inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      { bucket: '2026-01', inputTokens: 5, outputTokens: 5, totalTokens: 10 },
    ])
  })

  it('rejects token usage when a SQLite aggregate exceeds the safe integer range', () => {
    const database = openTestDatabase()
    insertLocalUser(database, 'usage_overflow_user', 'overflow@example.com')
    database.conversations.insert({ id: 'conversation_usage_overflow', title: 'Usage overflow' })
    const query = {
      userId: 'usage_overflow_user',
      yesterdayStartedAt: 100,
      todayStartedAt: 200,
      weekStartedAt: 100,
      monthStartedAt: 100,
      endedAt: 300,
    }

    database.chatRuns.insert({
      id: 'usage_overflow_a',
      conversationId: 'conversation_usage_overflow',
      requestId: 'request_usage_overflow_a',
      model: 'alpha/model',
      status: 'completed',
      startedAt: 200,
      userId: 'usage_overflow_user',
      provider: 'openrouter',
      inputTokens: Number.MAX_SAFE_INTEGER,
    })
    database.chatRuns.insert({
      id: 'usage_overflow_b',
      conversationId: 'conversation_usage_overflow',
      requestId: 'request_usage_overflow_b',
      model: 'alpha/model',
      status: 'completed',
      startedAt: 201,
      userId: 'usage_overflow_user',
      provider: 'openrouter',
      inputTokens: 1,
    })

    expect(() => database.chatRuns.summarizeTokenUsage(query))
      .toThrow('Token usage exceeded the supported range')
  })

  it('keeps repeated local hours in distinct elapsed-hour buckets', () => {
    const previous = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      const database = openTestDatabase()
      insertLocalUser(database, 'usage_fallback_user', 'fallback@example.com')
      database.conversations.insert({ id: 'conversation_usage_fallback', title: 'Usage fallback' })
      const query = {
        userId: 'usage_fallback_user',
        yesterdayStartedAt: Date.parse('2026-10-31T00:00:00-04:00'),
        todayStartedAt: Date.parse('2026-11-01T00:00:00-04:00'),
        weekStartedAt: Date.parse('2026-10-26T00:00:00-04:00'),
        monthStartedAt: Date.parse('2026-11-01T00:00:00-04:00'),
        endedAt: Date.parse('2026-11-02T00:00:00-05:00'),
      }
      const insert = (id: string, startedAt: number, inputTokens: number) => (
        database.chatRuns.insert({
          id,
          conversationId: 'conversation_usage_fallback',
          requestId: `request_${id}`,
          model: 'alpha/model',
          status: 'completed',
          startedAt,
          userId: 'usage_fallback_user',
          provider: 'openrouter',
          inputTokens,
        })
      )

      insert('usage_first_0130', Date.parse('2026-11-01T01:30:00-04:00'), 1)
      insert('usage_second_0130', Date.parse('2026-11-01T01:30:00-05:00'), 2)

      expect(database.chatRuns.summarizeTokenUsage(query).today.trend).toEqual([
        { bucket: '1', inputTokens: 1, outputTokens: 0, totalTokens: 1 },
        { bucket: '2', inputTokens: 2, outputTokens: 0, totalTokens: 2 },
      ])
    } finally {
      if (previous === undefined) delete process.env.TZ
      else process.env.TZ = previous
    }
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
      ownerUserId: 'execution_log_user',
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
    database.executions.insert({ id: 'execution_2', ownerUserId: 'execution_log_user', status: 'running', workflowId: 'workflow_1', workflowVersion: '1.0.0' })
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
