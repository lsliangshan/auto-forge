import type Database from 'better-sqlite3'
import {
  chatBlockSchema,
  syncMutationSchema,
  type ConversationPage,
  type MessagePage,
  type SyncMutation,
} from '@autoforge/shared'
import {
  createRepositories,
  type AppRepositories,
  type Conversation,
} from './repositories.js'

const OUTBOX_LIMIT = 10_000

type SqliteDatabase = Database.Database
type Query = Record<string, unknown>

export type OutboxMutationRecord = SyncMutation & {
  state: 'pending' | 'syncing' | 'failed'
  attempts: number
  nextAttemptAt?: number
  lastErrorCode?: string
  createdAt: number
}

export interface UserDataRepositories {
  conversations: AppRepositories['conversations'] & {
    listPage(input: { limit: 50; cursor?: string }): ConversationPage
  }
  messages: AppRepositories['messages'] & {
    listPage(input: { conversationId: string; limit: 100; cursor?: string }): MessagePage
  }
  conversationContexts: AppRepositories['conversationContexts']
  chatRuns: AppRepositories['chatRuns']
  providerUsage: AppRepositories['providerUsage']
  outbox: {
    record(mutation: SyncMutation): void
    recordWithConversation(mutation: SyncMutation): void
    recordWithMessage(mutation: SyncMutation): void
    listReady(now: number, limit: number): OutboxMutationRecord[]
    countPending(): number
    markSyncing(ids: readonly string[]): void
    markPending(id: string, nextAttemptAt?: number): void
    markFailed(id: string, errorCode: string, nextAttemptAt?: number): void
    delete(id: string): void
  }
}

export class OutboxLimitExceededError extends Error {
  readonly code = 'OUTBOX_LIMIT_EXCEEDED' as const

  constructor() {
    super('Too many local changes are waiting to synchronize.')
    this.name = 'OutboxLimitExceededError'
  }
}

function transaction<T>(database: SqliteDatabase, operation: () => T): T {
  return database.transaction(operation)()
}

function timestamp(value: string): number {
  const parsed = Date.parse(value)
  if (!Number.isSafeInteger(parsed)) throw new Error('Invalid mutation timestamp')
  return parsed
}

function isoTimestamp(value: number): string {
  return new Date(value).toISOString()
}

function encodeCursor(value: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decodeCursor<T extends Record<string, unknown>>(value: string): T {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error()
    return decoded as T
  } catch {
    throw new Error('Invalid pagination cursor')
  }
}

function assertOutboxCapacity(database: SqliteDatabase): void {
  const row = database.prepare('SELECT COUNT(*) AS count FROM outbox_mutations').get() as { count: number }
  if (row.count >= OUTBOX_LIMIT) throw new OutboxLimitExceededError()
}

function insertOutbox(database: SqliteDatabase, mutation: SyncMutation): void {
  const createdAt = Date.now()
  database.prepare(`
    INSERT INTO outbox_mutations (
      id, kind, entity_id, base_revision, payload_json, state,
      occurred_at, created_at
    ) VALUES (
      @id, @kind, @entityId, @baseRevision, @payloadJson, 'pending',
      @occurredAt, @createdAt
    )
  `).run({
    id: mutation.id,
    kind: mutation.kind,
    entityId: mutation.entityId,
    baseRevision: mutation.baseRevision,
    payloadJson: JSON.stringify(mutation.payload),
    occurredAt: timestamp(mutation.occurredAt),
    createdAt,
  })
}

function optimisticConversationMutation(database: SqliteDatabase, mutation: SyncMutation): void {
  switch (mutation.kind) {
    case 'conversation.create': {
      const createdAt = timestamp(mutation.payload.createdAt)
      database.prepare(`
        INSERT INTO conversations (
          id, title, title_state, revision, sync_state, created_at, updated_at,
          last_activity_at, metadata_updated_at
        ) VALUES (
          @id, @title, @titleState, 0, 'pending', @createdAt, @metadataUpdatedAt,
          @lastActivityAt, @metadataUpdatedAt
        )
      `).run({
        id: mutation.entityId,
        title: mutation.payload.title,
        titleState: mutation.payload.titleState,
        createdAt,
        lastActivityAt: timestamp(mutation.payload.lastActivityAt),
        metadataUpdatedAt: timestamp(mutation.payload.metadataUpdatedAt),
      })
      return
    }
    case 'conversation.rename':
      database.prepare(`
        UPDATE conversations
        SET title = @title,
            title_state = @titleState,
            sync_state = 'pending',
            metadata_updated_at = @metadataUpdatedAt,
            updated_at = @metadataUpdatedAt
        WHERE id = @id
      `).run({
        id: mutation.entityId,
        title: mutation.payload.title,
        titleState: mutation.payload.titleState,
        metadataUpdatedAt: timestamp(mutation.payload.metadataUpdatedAt),
      })
      return
    case 'conversation.delete':
      database.prepare(`
        UPDATE conversations
        SET deleted_at = @occurredAt, sync_state = 'pending', updated_at = @occurredAt
        WHERE id = @id
      `).run({ id: mutation.entityId, occurredAt: timestamp(mutation.occurredAt) })
      return
    case 'conversation.restore':
      database.prepare(`
        UPDATE conversations
        SET deleted_at = NULL, sync_state = 'pending', updated_at = @occurredAt
        WHERE id = @id
      `).run({ id: mutation.entityId, occurredAt: timestamp(mutation.occurredAt) })
      return
    default:
      throw new Error('Conversation mutation required')
  }
}

function optimisticMessageMutation(database: SqliteDatabase, mutation: SyncMutation): void {
  if (mutation.kind !== 'message.append') throw new Error('Message mutation required')
  const payload = mutation.payload
  database.prepare(`
    INSERT INTO messages (
      id, conversation_id, role, blocks_json, ordinal, execution_id, created_at
    ) VALUES (
      @id, @conversationId, @role, @blocksJson,
      COALESCE((SELECT MAX(ordinal) + 1 FROM messages WHERE conversation_id = @conversationId), 1),
      @executionId, @createdAt
    )
  `).run({
    id: payload.id,
    conversationId: payload.conversationId,
    role: payload.role,
    blocksJson: JSON.stringify(payload.blocks),
    executionId: payload.executionId ?? null,
    createdAt: timestamp(payload.createdAt),
  })
  database.prepare(`
    UPDATE conversations
    SET last_activity_at = MAX(last_activity_at, @createdAt),
        updated_at = MAX(updated_at, @createdAt),
        sync_state = 'pending'
    WHERE id = @conversationId
  `).run({ conversationId: payload.conversationId, createdAt: timestamp(payload.createdAt) })
}

function conversationPage(database: SqliteDatabase, input: { limit: 50; cursor?: string }): ConversationPage {
  if (input.limit !== 50) throw new Error('Conversation page limit must be 50')
  const cursor = input.cursor === undefined
    ? undefined
    : decodeCursor<{ lastActivityAt: number; id: string }>(input.cursor)
  if (cursor !== undefined && (
    !Number.isSafeInteger(cursor.lastActivityAt)
    || typeof cursor.id !== 'string'
    || cursor.id.length === 0
  )) throw new Error('Invalid pagination cursor')
  const rows = database.prepare(`
    SELECT id, title, title_state AS titleState, revision, sync_state AS syncState,
           created_at AS createdAt, last_activity_at AS lastActivityAt,
           metadata_updated_at AS metadataUpdatedAt
    FROM conversations
    WHERE deleted_at IS NULL
      AND (
        @cursorActivity IS NULL
        OR last_activity_at < @cursorActivity
        OR (last_activity_at = @cursorActivity AND id > @cursorId)
      )
    ORDER BY last_activity_at DESC, id
    LIMIT 51
  `).all({
    cursorActivity: cursor?.lastActivityAt ?? null,
    cursorId: cursor?.id ?? null,
  }) as Array<Query & { id: string; lastActivityAt: number }>
  const pageRows = rows.slice(0, 50)
  const items = pageRows.map((row) => ({
    id: row.id as string,
    title: row.title as string,
    titleState: row.titleState as Conversation['titleState'],
    revision: row.revision as number,
    syncState: row.syncState as 'synced' | 'pending' | 'syncing' | 'failed',
    createdAt: isoTimestamp(row.createdAt as number),
    lastActivityAt: isoTimestamp(row.lastActivityAt),
    metadataUpdatedAt: isoTimestamp(row.metadataUpdatedAt as number),
  }))
  const last = pageRows.at(-1)
  return {
    items,
    ...(rows.length > 50 && last
      ? { nextCursor: encodeCursor({ lastActivityAt: last.lastActivityAt, id: last.id }) }
      : {}),
  }
}

function messagePage(database: SqliteDatabase, input: {
  conversationId: string
  limit: 100
  cursor?: string
}): MessagePage {
  if (input.limit !== 100) throw new Error('Message page limit must be 100')
  const cursor = input.cursor === undefined
    ? undefined
    : decodeCursor<{ ordinal: number }>(input.cursor)
  if (cursor !== undefined && (!Number.isSafeInteger(cursor.ordinal) || cursor.ordinal <= 0)) {
    throw new Error('Invalid pagination cursor')
  }
  const rows = database.prepare(`
    SELECT id, conversation_id AS conversationId, role, blocks_json AS blocksJson,
           ordinal, execution_id AS executionId, created_at AS createdAt
    FROM messages
    WHERE conversation_id = @conversationId
      AND (@beforeOrdinal IS NULL OR ordinal < @beforeOrdinal)
    ORDER BY ordinal DESC
    LIMIT 101
  `).all({
    conversationId: input.conversationId,
    beforeOrdinal: cursor?.ordinal ?? null,
  }) as Array<Query & { ordinal: number }>
  const pageRows = rows.slice(0, 100).reverse()
  const items = pageRows.map((row) => ({
    id: row.id as string,
    conversationId: row.conversationId as string,
    role: row.role as 'user' | 'assistant',
    blocks: chatBlockSchema.array().parse(JSON.parse(row.blocksJson as string)),
    ...(row.executionId === null ? {} : { executionId: row.executionId as string }),
    createdAt: isoTimestamp(row.createdAt as number),
  }))
  const oldest = pageRows[0]
  return {
    items,
    ...(rows.length > 100 && oldest
      ? { previousCursor: encodeCursor({ ordinal: oldest.ordinal }) }
      : {}),
  }
}

function outboxFromRow(row: Query): OutboxMutationRecord {
  return {
    id: row.id as string,
    kind: row.kind as SyncMutation['kind'],
    entityId: row.entityId as string,
    baseRevision: row.baseRevision as number,
    payload: JSON.parse(row.payloadJson as string) as SyncMutation['payload'],
    occurredAt: isoTimestamp(row.occurredAt as number),
    state: row.state as OutboxMutationRecord['state'],
    attempts: row.attempts as number,
    ...(row.nextAttemptAt === null ? {} : { nextAttemptAt: row.nextAttemptAt as number }),
    ...(row.lastErrorCode === null ? {} : { lastErrorCode: row.lastErrorCode as string }),
    createdAt: row.createdAt as number,
  } as OutboxMutationRecord
}

export function createUserDataRepositories(
  database: SqliteDatabase,
  _ownerUserId: string,
): UserDataRepositories {
  const repositories = createRepositories(database)
  const conversations = {
    ...repositories.conversations,
    insert(value: Parameters<AppRepositories['conversations']['insert']>[0]) {
      const createdAt = value.createdAt ?? Date.now()
      const updatedAt = value.updatedAt ?? createdAt
      const titleState = value.titleState ?? 'user_named'
      transaction(database, () => database.prepare(`
        INSERT INTO conversations (
          id, title, title_state, created_at, updated_at,
          last_activity_at, metadata_updated_at
        ) VALUES (
          @id, @title, @titleState, @createdAt, @updatedAt,
          @updatedAt, @updatedAt
        )
      `).run({
        id: value.id,
        title: value.title,
        titleState,
        createdAt,
        updatedAt,
      }))
      return {
        id: value.id,
        title: value.title,
        titleState,
        createdAt,
        updatedAt,
      }
    },
    listPage: (input: { limit: 50; cursor?: string }) => conversationPage(database, input),
  }
  const messages = {
    ...repositories.messages,
    listPage: (input: { conversationId: string; limit: 100; cursor?: string }) => messagePage(database, input),
  }
  const record = (mutationInput: SyncMutation, optimisticWrite?: (mutation: SyncMutation) => void) => {
    const mutation = syncMutationSchema.parse(mutationInput)
    transaction(database, () => {
      assertOutboxCapacity(database)
      optimisticWrite?.(mutation)
      insertOutbox(database, mutation)
    })
  }
  return {
    conversations,
    messages,
    conversationContexts: repositories.conversationContexts,
    chatRuns: repositories.chatRuns,
    providerUsage: repositories.providerUsage,
    outbox: {
      record: (mutation) => record(mutation),
      recordWithConversation: (mutation) => record(
        mutation,
        (validated) => optimisticConversationMutation(database, validated),
      ),
      recordWithMessage: (mutation) => record(
        mutation,
        (validated) => optimisticMessageMutation(database, validated),
      ),
      listReady(now, limit) {
        if (!Number.isSafeInteger(now) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
          throw new Error('Invalid outbox page request')
        }
        return (database.prepare(`
          SELECT id, kind, entity_id AS entityId, base_revision AS baseRevision,
                 payload_json AS payloadJson, state, attempts,
                 next_attempt_at AS nextAttemptAt, last_error_code AS lastErrorCode,
                 occurred_at AS occurredAt, created_at AS createdAt
          FROM outbox_mutations
          WHERE state IN ('pending', 'failed')
            AND (next_attempt_at IS NULL OR next_attempt_at <= @now)
          ORDER BY created_at, id
          LIMIT @limit
        `).all({ now, limit }) as Query[]).map(outboxFromRow)
      },
      countPending: () => (
        database.prepare('SELECT COUNT(*) AS count FROM outbox_mutations').get() as { count: number }
      ).count,
      markSyncing(ids) {
        transaction(database, () => {
          const update = database.prepare(`
            UPDATE outbox_mutations
            SET state = 'syncing', attempts = attempts + 1, last_error_code = NULL
            WHERE id = @id AND state IN ('pending', 'failed')
          `)
          for (const id of ids) update.run({ id })
        })
      },
      markPending(id, nextAttemptAt) {
        transaction(database, () => database.prepare(`
          UPDATE outbox_mutations
          SET state = 'pending', next_attempt_at = @nextAttemptAt, last_error_code = NULL
          WHERE id = @id
        `).run({ id, nextAttemptAt: nextAttemptAt ?? null }))
      },
      markFailed(id, errorCode, nextAttemptAt) {
        transaction(database, () => database.prepare(`
          UPDATE outbox_mutations
          SET state = 'failed', next_attempt_at = @nextAttemptAt, last_error_code = @errorCode
          WHERE id = @id
        `).run({ id, errorCode, nextAttemptAt: nextAttemptAt ?? null }))
      },
      delete(id) {
        transaction(database, () => database.prepare('DELETE FROM outbox_mutations WHERE id = @id').run({ id }))
      },
    },
  }
}
