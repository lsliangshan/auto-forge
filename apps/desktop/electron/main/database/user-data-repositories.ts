import type Database from 'better-sqlite3'
import { z } from 'zod'
import {
  chatBlockSchema,
  chatMessageSchema,
  conversationSummarySchema,
  opaqueCursorSchema,
  syncMutationKindSchema,
  syncMutationSchema,
  type ConversationPage,
  type MessagePage,
  type SyncMutation,
} from '@autoforge/shared'
import {
  createRepositories,
  type AppRepositories,
} from './repositories.js'

const OUTBOX_LIMIT = 10_000

type SqliteDatabase = Database.Database
type Query = Record<string, unknown>

const outboxMetadataSchema = z.object({
  state: z.enum(['pending', 'syncing', 'failed']),
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: z.number().int().nonnegative().nullable(),
  lastErrorCode: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
}).strict()

const checkpointSchema = z.object({
  protocolVersion: z.number().int().positive(),
  remoteCursor: opaqueCursorSchema.optional(),
  updatedAt: z.number().int().nonnegative(),
}).strict()

const remoteMutationEnvelopeSchema = z.object({
  id: z.string().trim().min(1),
  kind: syncMutationKindSchema,
  entityId: z.string().trim().min(1),
  baseRevision: z.number().int().nonnegative(),
  resultRevision: z.number().int().nonnegative().nullable(),
  payload: z.unknown(),
  receivedAt: z.string().datetime(),
}).strict()

const remotePageEnvelopeSchema = z.object({
  protocolVersion: z.number().int().positive(),
  cursor: opaqueCursorSchema.nullable(),
  mutations: z.array(z.unknown()).max(100),
}).strict()

const conversationRowSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  titleState: z.string(),
  revision: z.number().int().nonnegative(),
  syncState: z.string(),
  createdAt: z.number().int().nonnegative(),
  lastActivityAt: z.number().int().nonnegative(),
  metadataUpdatedAt: z.number().int().nonnegative(),
  userId: z.string().nullable(),
}).passthrough()

const messageRowSchema = z.object({
  id: z.string().trim().min(1),
  conversationId: z.string().trim().min(1),
  role: z.string(),
  blocksJson: z.string(),
  ordinal: z.number().int().positive(),
  executionId: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
}).passthrough()

export type OutboxMutationRecord = SyncMutation & {
  state: 'pending' | 'syncing' | 'failed'
  attempts: number
  nextAttemptAt?: number
  lastErrorCode?: string
  createdAt: number
}

export interface SyncCheckpoint {
  protocolVersion: number
  remoteCursor?: string
  updatedAt: number
}

type StoredRemoteMutation<T extends SyncMutation = SyncMutation> = T extends SyncMutation
  ? Omit<T, 'occurredAt'> & { resultRevision: number | null; receivedAt: string }
  : never

export type RemoteMutation = StoredRemoteMutation

export interface RemoteMutationPage {
  protocolVersion: number
  cursor: string | null
  mutations: RemoteMutation[]
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
  sync: {
    getCheckpoint(): SyncCheckpoint | undefined
    updateCheckpoint(checkpoint: SyncCheckpoint): void
    applyRemotePage(page: unknown, updatedAt: number): void
  }
  outbox: {
    record(mutation: SyncMutation): void
    recordWithConversation(mutation: SyncMutation): void
    recordWithMessage(mutation: SyncMutation): void
    listReady(now: number, limit: number): OutboxMutationRecord[]
    find(id: string): OutboxMutationRecord | undefined
    list(limit: number): OutboxMutationRecord[]
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

export class UserDataConsistencyError extends Error {
  readonly code = 'INTERNAL_ERROR' as const

  constructor() {
    super('Unexpected application error')
    this.name = 'UserDataConsistencyError'
  }
}

export class UserDataOwnerMismatchError extends Error {
  readonly code = 'FORBIDDEN' as const

  constructor() {
    super('You do not have permission to perform this action.')
    this.name = 'UserDataOwnerMismatchError'
  }
}

function transaction<T>(database: SqliteDatabase, operation: () => T): T {
  return database.transaction(operation)()
}

function parsePersisted<T>(operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    if (error instanceof UserDataConsistencyError) throw error
    throw new UserDataConsistencyError()
  }
}

function assertOwner(actual: string | undefined, expected: string): void {
  if (actual !== undefined && actual !== expected) throw new UserDataOwnerMismatchError()
}

function assertStoredOwner(actual: string | undefined, expected: string): void {
  if (actual !== expected) throw new UserDataOwnerMismatchError()
}

function timestamp(value: string): number {
  const parsed = Date.parse(value)
  if (!Number.isSafeInteger(parsed)) throw new Error('Invalid mutation timestamp')
  return parsed
}

function isoTimestamp(value: number): string {
  return new Date(value).toISOString()
}

function parseRemotePage(value: unknown): RemoteMutationPage {
  return parsePersisted(() => {
    const envelope = remotePageEnvelopeSchema.parse(value)
    const mutations = envelope.mutations.map((raw): RemoteMutation => {
      const remote = remoteMutationEnvelopeSchema.parse(raw)
      const validated = syncMutationSchema.parse({
        id: remote.id,
        kind: remote.kind,
        entityId: remote.entityId,
        baseRevision: remote.baseRevision,
        payload: remote.payload,
        occurredAt: remote.receivedAt,
      })
      const { occurredAt, ...mutation } = validated
      return {
        ...mutation,
        resultRevision: remote.resultRevision,
        receivedAt: occurredAt,
      }
    })
    return { ...envelope, mutations }
  })
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

function optimisticConversationMutation(
  database: SqliteDatabase,
  ownerUserId: string,
  mutation: SyncMutation,
): void {
  switch (mutation.kind) {
    case 'conversation.create': {
      const createdAt = timestamp(mutation.payload.createdAt)
      database.prepare(`
        INSERT INTO conversations (
          id, title, title_state, user_id, revision, sync_state, created_at, updated_at,
          last_activity_at, metadata_updated_at
        ) VALUES (
          @id, @title, @titleState, @ownerUserId, 0, 'pending', @createdAt, @metadataUpdatedAt,
          @lastActivityAt, @metadataUpdatedAt
        )
      `).run({
        id: mutation.entityId,
        ownerUserId,
        title: mutation.payload.title,
        titleState: mutation.payload.titleState,
        createdAt,
        lastActivityAt: timestamp(mutation.payload.lastActivityAt),
        metadataUpdatedAt: timestamp(mutation.payload.metadataUpdatedAt),
      })
      return
    }
    case 'conversation.rename':
      requireOwnedConversation(database, ownerUserId, mutation.entityId)
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
      requireOwnedConversation(database, ownerUserId, mutation.entityId)
      database.prepare(`
        UPDATE conversations
        SET deleted_at = @occurredAt, sync_state = 'pending', updated_at = @occurredAt
        WHERE id = @id
      `).run({ id: mutation.entityId, occurredAt: timestamp(mutation.occurredAt) })
      return
    case 'conversation.restore':
      requireOwnedConversation(database, ownerUserId, mutation.entityId)
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

function optimisticMessageMutation(
  database: SqliteDatabase,
  ownerUserId: string,
  mutation: SyncMutation,
): void {
  if (mutation.kind !== 'message.append') throw new Error('Message mutation required')
  const payload = mutation.payload
  requireOwnedConversation(database, ownerUserId, payload.conversationId)
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

function requireRemoteRevision(mutation: RemoteMutation): number {
  if (mutation.resultRevision === null) throw new UserDataConsistencyError()
  return mutation.resultRevision
}

function requireOwnedConversation(
  database: SqliteDatabase,
  ownerUserId: string,
  conversationId: string,
): void {
  const row = database.prepare(`
    SELECT user_id AS userId
    FROM conversations
    WHERE id = @conversationId
  `).get({ conversationId }) as Query | undefined
  if (row === undefined) throw new UserDataConsistencyError()
  const owner = parsePersisted(() => z.object({ userId: z.string().nullable() }).parse(row))
  assertStoredOwner(owner.userId ?? undefined, ownerUserId)
}

function applyRemoteMutation(
  database: SqliteDatabase,
  ownerUserId: string,
  mutation: RemoteMutation,
): void {
  switch (mutation.kind) {
    case 'conversation.create': {
      const revision = requireRemoteRevision(mutation)
      const createdAt = timestamp(mutation.payload.createdAt)
      const existing = database.prepare(`
        SELECT user_id AS userId FROM conversations WHERE id = @id
      `).get({ id: mutation.entityId }) as Query | undefined
      if (existing !== undefined) {
        const owner = parsePersisted(() => z.object({ userId: z.string().nullable() }).parse(existing))
        assertStoredOwner(owner.userId ?? undefined, ownerUserId)
      }
      database.prepare(`
        INSERT INTO conversations (
          id, title, title_state, user_id, revision, sync_state, created_at, updated_at,
          last_activity_at, metadata_updated_at
        ) VALUES (
          @id, @title, @titleState, @ownerUserId, @revision, 'synced', @createdAt, @metadataUpdatedAt,
          @lastActivityAt, @metadataUpdatedAt
        )
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          title_state = excluded.title_state,
          user_id = excluded.user_id,
          revision = excluded.revision,
          sync_state = 'synced',
          deleted_at = NULL,
          last_activity_at = excluded.last_activity_at,
          metadata_updated_at = excluded.metadata_updated_at,
          updated_at = excluded.updated_at
      `).run({
        id: mutation.entityId,
        ownerUserId,
        title: mutation.payload.title,
        titleState: mutation.payload.titleState,
        revision,
        createdAt,
        lastActivityAt: timestamp(mutation.payload.lastActivityAt),
        metadataUpdatedAt: timestamp(mutation.payload.metadataUpdatedAt),
      })
      break
    }
    case 'conversation.rename': {
      requireOwnedConversation(database, ownerUserId, mutation.entityId)
      const result = database.prepare(`
        UPDATE conversations
        SET title = @title,
            title_state = @titleState,
            revision = @revision,
            sync_state = 'synced',
            metadata_updated_at = @metadataUpdatedAt,
            updated_at = @metadataUpdatedAt
        WHERE id = @id
      `).run({
        id: mutation.entityId,
        title: mutation.payload.title,
        titleState: mutation.payload.titleState,
        revision: requireRemoteRevision(mutation),
        metadataUpdatedAt: timestamp(mutation.payload.metadataUpdatedAt),
      })
      if (result.changes !== 1) throw new UserDataConsistencyError()
      break
    }
    case 'conversation.delete':
    case 'conversation.restore': {
      requireOwnedConversation(database, ownerUserId, mutation.entityId)
      const deletedAt = mutation.kind === 'conversation.delete'
        ? timestamp(mutation.receivedAt)
        : null
      const result = database.prepare(`
        UPDATE conversations
        SET deleted_at = @deletedAt,
            revision = @revision,
            sync_state = 'synced',
            updated_at = @updatedAt
        WHERE id = @id
      `).run({
        id: mutation.entityId,
        deletedAt,
        revision: requireRemoteRevision(mutation),
        updatedAt: timestamp(mutation.receivedAt),
      })
      if (result.changes !== 1) throw new UserDataConsistencyError()
      break
    }
    case 'message.append': {
      requireOwnedConversation(database, ownerUserId, mutation.payload.conversationId)
      const createdAt = timestamp(mutation.payload.createdAt)
      database.prepare(`
        INSERT INTO messages (
          id, conversation_id, role, blocks_json, ordinal, execution_id, created_at
        ) VALUES (
          @id, @conversationId, @role, @blocksJson,
          COALESCE((SELECT MAX(ordinal) + 1 FROM messages WHERE conversation_id = @conversationId), 1),
          @executionId, @createdAt
        ) ON CONFLICT(id) DO NOTHING
      `).run({
        id: mutation.payload.id,
        conversationId: mutation.payload.conversationId,
        role: mutation.payload.role,
        blocksJson: JSON.stringify(mutation.payload.blocks),
        executionId: mutation.payload.executionId ?? null,
        createdAt,
      })
      const conversation = database.prepare(`
        UPDATE conversations
        SET revision = @revision,
            sync_state = 'synced',
            last_activity_at = MAX(last_activity_at, @createdAt),
            updated_at = MAX(updated_at, @createdAt)
        WHERE id = @conversationId
      `).run({
        conversationId: mutation.payload.conversationId,
        revision: requireRemoteRevision(mutation),
        createdAt,
      })
      if (conversation.changes !== 1) throw new UserDataConsistencyError()
      break
    }
    default:
      break
  }
  database.prepare('DELETE FROM outbox_mutations WHERE id = @id').run({ id: mutation.id })
}

function conversationPage(
  database: SqliteDatabase,
  ownerUserId: string,
  input: { limit: 50; cursor?: string },
): ConversationPage {
  if (input.limit !== 50) throw new Error('Conversation page limit must be 50')
  const cursor = input.cursor === undefined
    ? undefined
    : decodeCursor<{ lastActivityAt: number; id: string }>(input.cursor)
  if (cursor !== undefined && (
    !Number.isSafeInteger(cursor.lastActivityAt)
    || typeof cursor.id !== 'string'
    || cursor.id.length === 0
  )) throw new Error('Invalid pagination cursor')
  const rows = (database.prepare(`
    SELECT id, title, title_state AS titleState, revision, sync_state AS syncState,
           created_at AS createdAt, last_activity_at AS lastActivityAt,
           metadata_updated_at AS metadataUpdatedAt, user_id AS userId
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
  }) as Query[]).map((row) => parsePersisted(() => conversationRowSchema.parse(row)))
  for (const row of rows) assertStoredOwner(row.userId ?? undefined, ownerUserId)
  const pageRows = rows.slice(0, 50)
  const items = pageRows.map((row) => parsePersisted(() => conversationSummarySchema.parse({
    id: row.id,
    title: row.title,
    titleState: row.titleState,
    revision: row.revision,
    syncState: row.syncState,
    createdAt: isoTimestamp(row.createdAt),
    lastActivityAt: isoTimestamp(row.lastActivityAt),
    metadataUpdatedAt: isoTimestamp(row.metadataUpdatedAt),
  })))
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
  const rows = (database.prepare(`
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
  }) as Query[]).map((row) => parsePersisted(() => messageRowSchema.parse(row)))
  const pageRows = rows.slice(0, 100).reverse()
  const items = pageRows.map((row) => parsePersisted(() => chatMessageSchema.parse({
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    blocks: chatBlockSchema.array().parse(JSON.parse(row.blocksJson as string)),
    ...(row.executionId === null ? {} : { executionId: row.executionId }),
    createdAt: isoTimestamp(row.createdAt),
  })))
  const oldest = pageRows[0]
  return {
    items,
    ...(rows.length > 100 && oldest
      ? { previousCursor: encodeCursor({ ordinal: oldest.ordinal }) }
      : {}),
  }
}

function outboxFromRow(row: Query): OutboxMutationRecord {
  return parsePersisted(() => {
    const mutation = syncMutationSchema.parse({
      id: row.id,
      kind: row.kind,
      entityId: row.entityId,
      baseRevision: row.baseRevision,
      payload: JSON.parse(z.string().parse(row.payloadJson)),
      occurredAt: isoTimestamp(z.number().int().nonnegative().parse(row.occurredAt)),
    })
    const metadata = outboxMetadataSchema.parse({
      state: row.state,
      attempts: row.attempts,
      nextAttemptAt: row.nextAttemptAt,
      lastErrorCode: row.lastErrorCode,
      createdAt: row.createdAt,
    })
    return {
      ...mutation,
      state: metadata.state,
      attempts: metadata.attempts,
      ...(metadata.nextAttemptAt === null ? {} : { nextAttemptAt: metadata.nextAttemptAt }),
      ...(metadata.lastErrorCode === null ? {} : { lastErrorCode: metadata.lastErrorCode }),
      createdAt: metadata.createdAt,
    }
  })
}

function checkpointFromRow(row: Query | undefined): SyncCheckpoint | undefined {
  if (row === undefined) return undefined
  return parsePersisted(() => checkpointSchema.parse({
    protocolVersion: row.protocolVersion,
    ...(row.remoteCursor === null ? {} : { remoteCursor: row.remoteCursor }),
    updatedAt: row.updatedAt,
  }))
}

function readCheckpoint(database: SqliteDatabase): SyncCheckpoint | undefined {
  const row = database.prepare(`
    SELECT protocol_version AS protocolVersion,
           remote_cursor AS remoteCursor,
           updated_at AS updatedAt
    FROM sync_checkpoint
    WHERE id = 1
  `).get() as Query | undefined
  return checkpointFromRow(row)
}

function writeCheckpoint(database: SqliteDatabase, checkpoint: SyncCheckpoint): void {
  const validated = checkpointSchema.parse(checkpoint)
  database.prepare(`
    INSERT INTO sync_checkpoint (id, remote_cursor, protocol_version, updated_at)
    VALUES (1, @remoteCursor, @protocolVersion, @updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      remote_cursor = excluded.remote_cursor,
      protocol_version = excluded.protocol_version,
      updated_at = excluded.updated_at
  `).run({ ...validated, remoteCursor: validated.remoteCursor ?? null })
}

export function createUserDataRepositories(
  database: SqliteDatabase,
  ownerUserId: string,
): UserDataRepositories {
  database.prepare(`
    UPDATE outbox_mutations
    SET state = 'pending', next_attempt_at = NULL, last_error_code = 'SYNC_FAILED'
    WHERE state = 'syncing'
  `).run()
  const repositories = createRepositories(database)
  const conversations = {
    ...repositories.conversations,
    get(id: string) {
      const stored = repositories.conversations.get(id)
      if (stored) assertStoredOwner(stored.userId, ownerUserId)
      return stored
    },
    list() {
      const stored = repositories.conversations.list()
      for (const conversation of stored) assertStoredOwner(conversation.userId, ownerUserId)
      return stored
    },
    claimLegacyAndListForUser(userId: string) {
      assertOwner(userId, ownerUserId)
      return repositories.conversations.claimLegacyAndListForUser(ownerUserId)
    },
    insert(value: Parameters<AppRepositories['conversations']['insert']>[0]) {
      assertOwner(value.userId, ownerUserId)
      const createdAt = value.createdAt ?? Date.now()
      const updatedAt = value.updatedAt ?? createdAt
      const titleState = value.titleState ?? 'user_named'
      transaction(database, () => database.prepare(`
        INSERT INTO conversations (
          id, title, title_state, user_id, created_at, updated_at,
          last_activity_at, metadata_updated_at
        ) VALUES (
          @id, @title, @titleState, @ownerUserId, @createdAt, @updatedAt,
          @updatedAt, @updatedAt
        )
      `).run({
        id: value.id,
        title: value.title,
        titleState,
        ownerUserId,
        createdAt,
        updatedAt,
      }))
      return {
        id: value.id,
        title: value.title,
        titleState,
        userId: ownerUserId,
        createdAt,
        updatedAt,
      }
    },
    listPage: (input: { limit: 50; cursor?: string }) => conversationPage(database, ownerUserId, input),
  }
  const messages = {
    ...repositories.messages,
    listPage: (input: { conversationId: string; limit: 100; cursor?: string }) => messagePage(database, input),
  }
  const conversationContexts = {
    ...repositories.conversationContexts,
    get(conversationId: string) {
      if (!conversations.get(conversationId)) return undefined
      return repositories.conversationContexts.get(conversationId)
    },
    advance(input: Parameters<AppRepositories['conversationContexts']['advance']>[0]) {
      if (!conversations.get(input.conversationId)) throw new UserDataOwnerMismatchError()
      return repositories.conversationContexts.advance(input)
    },
  }
  const chatRuns = {
    ...repositories.chatRuns,
    insert(value: Parameters<AppRepositories['chatRuns']['insert']>[0]) {
      assertOwner(value.userId, ownerUserId)
      if (!conversations.get(value.conversationId)) throw new UserDataConsistencyError()
      return repositories.chatRuns.insert({ ...value, userId: ownerUserId })
    },
    startMediaGeneration(value: Parameters<AppRepositories['chatRuns']['startMediaGeneration']>[0]) {
      assertOwner(value.run.userId, ownerUserId)
      if (!conversations.get(value.run.conversationId)) throw new UserDataConsistencyError()
      return repositories.chatRuns.startMediaGeneration({
        ...value,
        run: { ...value.run, userId: ownerUserId },
      })
    },
    get(id: string) {
      const stored = repositories.chatRuns.get(id)
      if (stored) assertStoredOwner(stored.userId, ownerUserId)
      return stored
    },
    getByRequestId(requestId: string) {
      const stored = repositories.chatRuns.getByRequestId(requestId)
      if (stored) assertStoredOwner(stored.userId, ownerUserId)
      return stored
    },
    summarizeTokenUsage(input: Parameters<AppRepositories['chatRuns']['summarizeTokenUsage']>[0]) {
      assertOwner(input.userId, ownerUserId)
      return repositories.chatRuns.summarizeTokenUsage(input)
    },
    update(
      id: string,
      value: Parameters<AppRepositories['chatRuns']['update']>[1],
    ) {
      if (!chatRuns.get(id)) return undefined
      return repositories.chatRuns.update(id, value)
    },
    finalizeWithMessage(
      id: string,
      messageId: string,
      requestId: string,
      value: Parameters<AppRepositories['chatRuns']['finalizeWithMessage']>[3],
    ) {
      if (!chatRuns.get(id)) throw new UserDataConsistencyError()
      return repositories.chatRuns.finalizeWithMessage(id, messageId, requestId, value)
    },
  }
  const providerUsage = {
    ...repositories.providerUsage,
    find(operationKey: string) {
      const stored = repositories.providerUsage.find(operationKey)
      if (stored) assertStoredOwner(stored.userId, ownerUserId)
      return stored
    },
    start(event: Parameters<AppRepositories['providerUsage']['start']>[0]) {
      assertOwner(event.userId, ownerUserId)
      providerUsage.find(event.operationKey)
      if (event.chatRunId !== undefined && !chatRuns.get(event.chatRunId)) {
        throw new UserDataConsistencyError()
      }
      return repositories.providerUsage.start({ ...event, userId: ownerUserId })
    },
    bindIdentity(
      operationKey: string,
      identity: Parameters<AppRepositories['providerUsage']['bindIdentity']>[1],
    ) {
      providerUsage.find(operationKey)
      return repositories.providerUsage.bindIdentity(operationKey, identity)
    },
    report(
      operationKey: string,
      report: Parameters<AppRepositories['providerUsage']['report']>[1],
    ) {
      providerUsage.find(operationKey)
      return repositories.providerUsage.report(operationKey, report)
    },
    markUnknown(operationKey: string, endedAt: number) {
      providerUsage.find(operationKey)
      return repositories.providerUsage.markUnknown(operationKey, endedAt)
    },
    recordReconcileFailure(operationKey: string, nextReconcileAt?: number) {
      providerUsage.find(operationKey)
      return repositories.providerUsage.recordReconcileFailure(operationKey, nextReconcileAt)
    },
    recoverPending(recoveredAt: number) {
      return transaction(database, () => database.prepare(`
        UPDATE provider_usage_events
        SET status = 'unknown',
            ended_at = COALESCE(ended_at, @recoveredAt),
            next_reconcile_at = CASE
              WHEN provider = 'openrouter' AND generation_id IS NOT NULL THEN @nextReconcileAt
              ELSE NULL
            END
        WHERE status = 'pending' AND user_id = @ownerUserId
      `).run({
        ownerUserId,
        recoveredAt,
        nextReconcileAt: recoveredAt + 1_000,
      }).changes)
    },
    listReconcilable(reconcileAt: number) {
      return repositories.providerUsage.listReconcilable(reconcileAt)
        .filter((event) => event.userId === ownerUserId)
    },
    summarize(input: Parameters<AppRepositories['providerUsage']['summarize']>[0]) {
      assertOwner(input.userId, ownerUserId)
      return repositories.providerUsage.summarize(input)
    },
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
    conversationContexts,
    chatRuns,
    providerUsage,
    sync: {
      getCheckpoint: () => readCheckpoint(database),
      updateCheckpoint(checkpoint) {
        const validated = parsePersisted(() => checkpointSchema.parse(checkpoint))
        transaction(database, () => writeCheckpoint(database, validated))
      },
      applyRemotePage(pageInput, updatedAt) {
        const page = parseRemotePage(pageInput)
        const checkpoint = parsePersisted(() => checkpointSchema.parse({
          protocolVersion: page.protocolVersion,
          ...(page.cursor === null ? {} : { remoteCursor: page.cursor }),
          updatedAt,
        }))
        transaction(database, () => {
          for (const mutation of page.mutations) {
            applyRemoteMutation(database, ownerUserId, mutation)
          }
          writeCheckpoint(database, checkpoint)
        })
      },
    },
    outbox: {
      record: (mutation) => record(mutation),
      recordWithConversation: (mutation) => record(
        mutation,
        (validated) => optimisticConversationMutation(database, ownerUserId, validated),
      ),
      recordWithMessage: (mutation) => record(
        mutation,
        (validated) => optimisticMessageMutation(database, ownerUserId, validated),
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
      find(id) {
        const row = database.prepare(`
          SELECT id, kind, entity_id AS entityId, base_revision AS baseRevision,
                 payload_json AS payloadJson, state, attempts,
                 next_attempt_at AS nextAttemptAt, last_error_code AS lastErrorCode,
                 occurred_at AS occurredAt, created_at AS createdAt
          FROM outbox_mutations
          WHERE id = @id
        `).get({ id }) as Query | undefined
        return row === undefined ? undefined : outboxFromRow(row)
      },
      list(limit) {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
          throw new UserDataConsistencyError()
        }
        return (database.prepare(`
          SELECT id, kind, entity_id AS entityId, base_revision AS baseRevision,
                 payload_json AS payloadJson, state, attempts,
                 next_attempt_at AS nextAttemptAt, last_error_code AS lastErrorCode,
                 occurred_at AS occurredAt, created_at AS createdAt
          FROM outbox_mutations
          ORDER BY created_at, id
          LIMIT @limit
        `).all({ limit }) as Query[]).map(outboxFromRow)
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
