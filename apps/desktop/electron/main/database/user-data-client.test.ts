import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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

function createConversationMutation(id: string, entityId: string): SyncMutation {
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

function appendMessageMutation(id: string, conversationId: string, messageId: string): SyncMutation {
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

function cachePath(root: string, userId: string): string {
  const scope = createHash('sha256')
    .update('autoforge-user-cache-v1\0')
    .update(userId)
    .digest('hex')
    .slice(0, 32)
  return join(root, `${scope}.sqlite`)
}

function pulledMutation(mutation: SyncMutation, resultRevision: number) {
  const { occurredAt, ...stored } = mutation
  return { ...stored, resultRevision, receivedAt: occurredAt }
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

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('UserDataStoreManager', () => {
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
      .toEqual([{ version: 1 }])
    expect(inspection.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'outbox_mutations'").get())
      .toBeDefined()
    inspection.close()
  })

  it('enforces the pending outbox cap before optimistic conversation state commits', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')
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
