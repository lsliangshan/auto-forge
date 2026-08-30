import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import {
  accountDataPreferencesRecordSchema,
  appErrorCodeSchema,
  chatBlockSchema,
  chatMessageSchema,
  messageProviderProjectionSchema,
  conversationGenerationPreferencesSchema,
  conversationSummarySchema,
  conversationTitleStateSchema,
  opaqueCursorSchema,
  pulledMutationSchema,
  sanitizeOpaqueWorkflowArgs,
  syncStateSchema,
  syncMutationResultSchema,
  syncMutationSchema,
  privacyConsentSchema,
  type ConversationPage,
  type ConversationGenerationPreferences,
  type AppErrorCode,
  type MessagePage,
  type PulledMutation,
  type SyncMutation,
  type SyncMutationKind,
  type SyncMutationResult,
  type AccountDataPreferencesRecord,
  type PrivacyConsent,
  type PrivacyConsentPurpose,
  type ChatBlock,
} from '@autoforge/shared'
import {
  createRepositories,
  type AppRepositories,
} from './repositories.js'
import {
  classifyAttachmentConversionRequest,
  type LocalAttachmentProjection,
} from '../chat/local-conversion-intent.js'

const OUTBOX_LIMIT = 10_000

type SqliteDatabase = Database.Database
type Query = Record<string, unknown>

const outboxMetadataSchema = z.object({
  state: z.enum(['pending', 'syncing', 'failed']),
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: z.number().int().nonnegative().nullable(),
  lastErrorCode: appErrorCodeSchema.nullable(),
  createdAt: z.number().int().nonnegative(),
}).strict()

const checkpointSchema = z.object({
  protocolVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  remoteCursor: opaqueCursorSchema.optional(),
  updatedAt: z.number().int().nonnegative(),
}).strict()

const remotePageEnvelopeSchema = z.object({
  protocolVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  cursor: opaqueCursorSchema.nullable(),
  mutations: z.array(pulledMutationSchema).max(100),
}).strict()

const conversationRowSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  titleState: conversationTitleStateSchema,
  revision: z.number().int().nonnegative(),
  syncState: syncStateSchema,
  createdAt: z.number().int().nonnegative(),
  lastActivityAt: z.number().int().nonnegative(),
  metadataUpdatedAt: z.number().int().nonnegative(),
  generationPreferencesJson: z.string().nullable().optional(),
  deletedAt: z.number().int().nonnegative().nullable().optional(),
  userId: z.string().nullable(),
}).strict()

const messageRowSchema = z.object({
  id: z.string().trim().min(1),
  conversationId: z.string().trim().min(1),
  role: z.string(),
  blocksJson: z.string(),
  ordinal: z.number().int().positive(),
  executionId: z.string().nullable(),
  providerProjectionJson: z.string().nullable().optional(),
  createdAt: z.number().int().nonnegative(),
}).passthrough()

const conversionBlockBindingRowSchema = z.object({
  ownerUserId: z.string().min(1).max(512),
  conversationId: z.string().trim().min(1).max(128),
  messageId: z.string().trim().min(1).max(128),
  blockId: z.string().trim().min(1).max(128),
  executionId: z.string().trim().min(1).max(128),
  finalizedAt: z.number().int().nonnegative().nullable(),
  consumedAt: z.number().int().nonnegative().nullable(),
  retiredAt: z.number().int().nonnegative().nullable(),
  retirementReason: z.enum(['missing_execution', 'missing_message', 'invalid_binding']).nullable(),
}).strict()

export type OutboxMutationRecord = SyncMutation & {
  state: 'pending' | 'syncing' | 'failed'
  attempts: number
  nextAttemptAt?: number
  lastErrorCode?: AppErrorCode
  createdAt: number
}

export interface SyncCheckpoint {
  protocolVersion: number
  remoteCursor?: string
  updatedAt: number
}

export interface ConversionBlockBindingRecord {
  ownerUserId: string
  conversationId: string
  messageId: string
  blockId: string
  executionId: string
  finalizedAt?: number
  consumedAt?: number
  retiredAt?: number
  retirementReason?: 'missing_execution' | 'missing_message' | 'invalid_binding'
}

export interface PushAcknowledgementOutcome {
  supersededIds: string[]
}

export type RemoteMutation = PulledMutation

export interface RemoteMutationPage {
  protocolVersion: number
  cursor: string | null
  mutations: RemoteMutation[]
}

export interface UserDataRepositories {
  conversations: AppRepositories['conversations'] & {
    getSummary(id: string): ConversationPage['items'][number] | undefined
    listPage(input: { limit: 50; cursor?: string }): ConversationPage
  }
  messages: AppRepositories['messages'] & {
    listPage(input: { conversationId: string; limit: 100; cursor?: string }): MessagePage
  }
  conversationContexts: AppRepositories['conversationContexts']
  mediaAssets: AppRepositories['mediaAssets']
  mediaGenerationJobs: AppRepositories['mediaGenerationJobs']
  chatRuns: AppRepositories['chatRuns']
  providerUsage: AppRepositories['providerUsage']
  conversionBlockBindings: {
    get(ownerUserId: string, executionId: string): ConversionBlockBindingRecord | undefined
    listRecoverable(ownerUserId: string): ConversionBlockBindingRecord[]
    retire(
      ownerUserId: string,
      executionId: string,
      reason: NonNullable<ConversionBlockBindingRecord['retirementReason']>,
      retiredAt: number,
    ): boolean
  }
  account: {
    getConsent(purpose: PrivacyConsentPurpose): PrivacyConsent | undefined
    getPreferences(): AccountDataPreferencesRecord | undefined
    projectPreferences(preferences: AccountDataPreferencesRecord): void
    resolveLegacyImportBatch(input: {
      selectionFingerprint: string
      includeUnowned: boolean
      cloudConsentVersion: string
      unownedConsentVersion?: string
      candidateBatchId: string
    }): string
  }
  sync: {
    getCheckpoint(): SyncCheckpoint | undefined
    updateCheckpoint(checkpoint: SyncCheckpoint): void
    applyRemotePage(page: unknown, updatedAt: number): void
  }
  outbox: {
    record(mutation: SyncMutation): void
    recordWithConversation(mutation: SyncMutation): void
    recordWithMessage(
      mutation: SyncMutation,
      assetIds?: readonly string[],
    ): void
    recordWithConsent(mutation: Extract<SyncMutation, { kind: 'privacy.consent' }>): void
    recordWithPreferences(mutation: Extract<SyncMutation, { kind: 'preferences.update' }>): void
    listReady(now: number, limit: number): OutboxMutationRecord[]
    find(id: string): OutboxMutationRecord | undefined
    list(limit: number): OutboxMutationRecord[]
    countPending(kind?: SyncMutationKind): number
    oldestPendingOrFailedAt(): number | undefined
    markSyncing(ids: readonly string[]): void
    markPending(id: string, nextAttemptAt?: number): void
    markFailed(id: string, errorCode: AppErrorCode, nextAttemptAt?: number): void
    acknowledgePushResults(
      sent: readonly SyncMutation[],
      results: readonly SyncMutationResult[],
    ): PushAcknowledgementOutcome
    retryFailed(entityId?: string): string[]
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

type ConversionBlock = Extract<ChatBlock, { type: 'conversion' }>

function exactConversionBlocks(blocksInput: unknown): ConversionBlock[] {
  const blocks = parsePersisted(() => chatBlockSchema.array().parse(blocksInput))
  const blockIds = new Set<string>()
  const executionIds = new Set<string>()
  const conversions: ConversionBlock[] = []
  for (const block of blocks) {
    if ('blockId' in block) {
      if (blockIds.has(block.blockId)) throw new UserDataConsistencyError()
      blockIds.add(block.blockId)
    }
    if (block.type !== 'conversion') continue
    if (executionIds.has(block.executionId)) throw new UserDataConsistencyError()
    executionIds.add(block.executionId)
    conversions.push(block)
  }
  return conversions
}

function conversionBlockBindingFromRow(row: Query): ConversionBlockBindingRecord {
  const parsed = parsePersisted(() => conversionBlockBindingRowSchema.parse(row))
  return {
    ownerUserId: parsed.ownerUserId,
    conversationId: parsed.conversationId,
    messageId: parsed.messageId,
    blockId: parsed.blockId,
    executionId: parsed.executionId,
    ...(parsed.finalizedAt === null ? {} : { finalizedAt: parsed.finalizedAt }),
    ...(parsed.consumedAt === null ? {} : { consumedAt: parsed.consumedAt }),
    ...(parsed.retiredAt === null ? {} : { retiredAt: parsed.retiredAt }),
    ...(parsed.retirementReason === null ? {} : { retirementReason: parsed.retirementReason }),
  }
}

function storedConversionBlockBinding(
  database: SqliteDatabase,
  ownerUserId: string,
  executionId: string,
): ConversionBlockBindingRecord | undefined {
  const row = database.prepare(`
    SELECT owner_user_id AS ownerUserId, conversation_id AS conversationId,
           message_id AS messageId, block_id AS blockId, execution_id AS executionId,
           finalized_at AS finalizedAt, consumed_at AS consumedAt,
           retired_at AS retiredAt, retirement_reason AS retirementReason
    FROM conversion_block_bindings
    WHERE owner_user_id = @ownerUserId AND execution_id = @executionId
  `).get({ ownerUserId, executionId }) as Query | undefined
  return row === undefined ? undefined : conversionBlockBindingFromRow(row)
}

function exactBindingForBlock(
  database: SqliteDatabase,
  ownerUserId: string,
  message: { id: string; conversationId: string },
  block: ConversionBlock,
): ConversionBlockBindingRecord | undefined {
  const binding = storedConversionBlockBinding(database, ownerUserId, block.executionId)
  if (binding === undefined) return undefined
  if (binding.conversationId !== message.conversationId
    || binding.messageId !== message.id
    || binding.blockId !== block.blockId) throw new UserDataConsistencyError()
  return binding
}

function registerActiveConversionBindings(
  database: SqliteDatabase,
  ownerUserId: string,
  message: { id: string; conversationId: string },
  blocksInput: unknown,
): void {
  const conversions = exactConversionBlocks(blocksInput)
  for (const block of conversions) {
    if (block.state !== 'active') throw new UserDataConsistencyError()
    const existing = exactBindingForBlock(database, ownerUserId, message, block)
    if (existing !== undefined) {
      if (existing.consumedAt !== undefined || existing.retiredAt !== undefined) {
        throw new UserDataConsistencyError()
      }
      continue
    }
    database.prepare(`
      INSERT INTO conversion_block_bindings(
        owner_user_id, conversation_id, message_id, block_id, execution_id
      ) VALUES (
        @ownerUserId, @conversationId, @messageId, @blockId, @executionId
      )
    `).run({
      ownerUserId,
      conversationId: message.conversationId,
      messageId: message.id,
      blockId: block.blockId,
      executionId: block.executionId,
    })
  }
  const recoverable = database.prepare(`
    SELECT owner_user_id AS ownerUserId, conversation_id AS conversationId,
           message_id AS messageId, block_id AS blockId, execution_id AS executionId,
           finalized_at AS finalizedAt, consumed_at AS consumedAt,
           retired_at AS retiredAt, retirement_reason AS retirementReason
    FROM conversion_block_bindings
    WHERE owner_user_id = @ownerUserId AND message_id = @messageId
      AND consumed_at IS NULL AND retired_at IS NULL
  `).all({ ownerUserId, messageId: message.id }) as Query[]
  for (const row of recoverable) {
    const binding = conversionBlockBindingFromRow(row)
    const exact = conversions.filter((block) => (
      block.blockId === binding.blockId && block.executionId === binding.executionId
    ))
    if (exact.length !== 1) throw new UserDataConsistencyError()
  }
}

function finalizeConversionBindings(
  database: SqliteDatabase,
  ownerUserId: string,
  message: { id: string; conversationId: string },
  blocksInput: unknown,
  finalizedAt: number,
): void {
  if (!Number.isSafeInteger(finalizedAt) || finalizedAt < 0) throw new UserDataConsistencyError()
  const conversions = exactConversionBlocks(blocksInput)
  for (const block of conversions) {
    if (block.state !== 'active') throw new UserDataConsistencyError()
    const binding = exactBindingForBlock(database, ownerUserId, message, block)
    if (!binding || binding.consumedAt !== undefined || binding.retiredAt !== undefined) {
      throw new UserDataConsistencyError()
    }
    if (binding.finalizedAt !== undefined && binding.finalizedAt !== finalizedAt) {
      throw new UserDataConsistencyError()
    }
    database.prepare(`
      UPDATE conversion_block_bindings
      SET finalized_at = @finalizedAt
      WHERE owner_user_id = @ownerUserId AND execution_id = @executionId
        AND finalized_at IS NULL AND consumed_at IS NULL AND retired_at IS NULL
    `).run({ ownerUserId, executionId: block.executionId, finalizedAt })
  }
  const unrepresented = database.prepare(`
    SELECT execution_id AS executionId
    FROM conversion_block_bindings
    WHERE owner_user_id = @ownerUserId AND message_id = @messageId
      AND consumed_at IS NULL AND retired_at IS NULL
  `).all({ ownerUserId, messageId: message.id }) as Array<{ executionId: string }>
  if (unrepresented.some(({ executionId }) => (
    !conversions.some((block) => block.executionId === executionId)
  ))) throw new UserDataConsistencyError()
}

function consumeConversionBinding(
  database: SqliteDatabase,
  ownerUserId: string,
  message: { id: string; conversationId: string },
  block: ConversionBlock,
  consumedAt: number,
): void {
  const binding = exactBindingForBlock(database, ownerUserId, message, block)
  // Remote and pre-journal historical messages intentionally have no local execution binding.
  if (!binding) return
  if (binding.retiredAt !== undefined || binding.finalizedAt === undefined) {
    throw new UserDataConsistencyError()
  }
  if (binding.consumedAt !== undefined) return
  const changed = database.prepare(`
    UPDATE conversion_block_bindings
    SET consumed_at = @consumedAt
    WHERE owner_user_id = @ownerUserId AND execution_id = @executionId
      AND finalized_at IS NOT NULL AND consumed_at IS NULL AND retired_at IS NULL
  `).run({ ownerUserId, executionId: block.executionId, consumedAt }).changes
  if (changed !== 1) throw new UserDataConsistencyError()
}

function timestamp(value: string): number {
  const parsed = Date.parse(value)
  if (!Number.isSafeInteger(parsed)) throw new Error('Invalid mutation timestamp')
  return parsed
}

function isoTimestamp(value: number): string {
  return new Date(value).toISOString()
}

function storedConsent(
  database: SqliteDatabase,
  purpose: PrivacyConsentPurpose,
): PrivacyConsent | undefined {
  const row = database.prepare(`
    SELECT purpose, document_version AS documentVersion,
           consented_at AS consentedAt, client_version AS clientVersion
    FROM privacy_consents WHERE purpose = @purpose
  `).get({ purpose }) as Query | undefined
  return row === undefined ? undefined : parsePersisted(() => privacyConsentSchema.parse({
    ...row, consentedAt: isoTimestamp(z.number().int().nonnegative().parse(row.consentedAt)),
  }))
}

function projectConsent(database: SqliteDatabase, consent: PrivacyConsent): void {
  const value = privacyConsentSchema.parse(consent)
  database.prepare(`
    INSERT INTO privacy_consents(purpose, document_version, consented_at, client_version)
    VALUES (@purpose, @documentVersion, @consentedAt, @clientVersion)
    ON CONFLICT(purpose) DO UPDATE SET
      document_version = excluded.document_version,
      consented_at = excluded.consented_at,
      client_version = excluded.client_version
  `).run({ ...value, consentedAt: timestamp(value.consentedAt) })
}

function storedPreferences(database: SqliteDatabase): AccountDataPreferencesRecord | undefined {
  const row = database.prepare(`
    SELECT timezone, display_currency AS displayCurrency, revision, updated_at AS updatedAt
    FROM account_data_preferences WHERE id = 1
  `).get() as Query | undefined
  return row === undefined ? undefined : parsePersisted(() => accountDataPreferencesRecordSchema.parse({
    ...row, updatedAt: isoTimestamp(z.number().int().nonnegative().parse(row.updatedAt)),
  }))
}

function projectPreferences(
  database: SqliteDatabase,
  preferences: Extract<SyncMutation, { kind: 'preferences.update' }>['payload'],
  revision: number,
  updatedAt: string,
): void {
  const value = accountDataPreferencesRecordSchema.parse({
    ...preferences, revision, updatedAt,
  })
  database.prepare(`
    INSERT INTO account_data_preferences(id, timezone, display_currency, revision, updated_at)
    VALUES (1, @timezone, @displayCurrency, @revision, @updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      timezone = excluded.timezone,
      display_currency = excluded.display_currency,
      revision = excluded.revision,
      updated_at = excluded.updated_at
  `).run({ ...value, updatedAt: timestamp(value.updatedAt) })
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function trustedRemoteProviderProjection(payload: Record<string, unknown>) {
  const candidate = messageProviderProjectionSchema.safeParse(payload.providerProjection)
  const blocks = chatBlockSchema.array().safeParse(payload.blocks)
  if (!candidate.success || !blocks.success || payload.role !== 'user') return undefined
  const inputBlocks = blocks.data.filter((block): block is Extract<ChatBlock, { type: 'media' }> => (
    block.type === 'media' && block.purpose === 'input'
  ))
  const attachments: LocalAttachmentProjection[] = inputBlocks.map((block, index) => ({
    index,
    name: block.name,
    mimeType: block.mimeType,
    byteSize: block.byteSize,
  }))
  const text = blocks.data
    .filter((block): block is Extract<ChatBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  const classification = classifyAttachmentConversionRequest(text, attachments)
  return classification.decision === 'local'
    && classification.targetFormat === candidate.data.targetFormat
    && classification.selectedAttachmentIndexes?.length === candidate.data.selectedAttachmentIndexes.length
    && classification.selectedAttachmentIndexes.every((index, position) => (
      index === candidate.data.selectedAttachmentIndexes[position]
    ))
    && attachments.length === candidate.data.attachmentCount
    ? candidate.data
    : undefined
}

function discardUntrustedRemoteProviderProjections(value: unknown): unknown {
  const page = record(value)
  if (!page || !Array.isArray(page.mutations)) return value
  return {
    ...page,
    mutations: page.mutations.map((mutationValue) => {
      const mutation = record(mutationValue)
      const payload = record(mutation?.payload)
      if (!mutation || mutation.kind !== 'message.append' || mutation.compacted === true || !payload
        || !Object.prototype.hasOwnProperty.call(payload, 'providerProjection')) return mutationValue
      const payloadWithoutProjection = { ...payload }
      delete payloadWithoutProjection.providerProjection
      const providerProjection = page.protocolVersion === 3
        ? trustedRemoteProviderProjection(payload)
        : undefined
      return {
        ...mutation,
        payload: {
          ...payloadWithoutProjection,
          ...(providerProjection === undefined ? {} : { providerProjection }),
        },
      }
    }),
  }
}

function parseRemotePage(value: unknown): RemoteMutationPage {
  return parsePersisted(() => remotePageEnvelopeSchema.parse(
    discardUntrustedRemoteProviderProjections(value),
  ))
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
  const sequence = database.prepare(`
    UPDATE outbox_enqueue_counter
    SET value = value + 1
    WHERE id = 1
    RETURNING value
  `).get() as { value: unknown } | undefined
  if (
    sequence === undefined
    || typeof sequence.value !== 'number'
    || !Number.isSafeInteger(sequence.value)
    || sequence.value < 1
  ) throw new UserDataConsistencyError()
  database.prepare(`
    INSERT INTO outbox_mutations (
      id, kind, entity_id, base_revision, payload_json, state,
      occurred_at, created_at, enqueue_sequence
    ) VALUES (
      @id, @kind, @entityId, @baseRevision, @payloadJson, 'pending',
      @occurredAt, @createdAt, @enqueueSequence
    )
  `).run({
    id: mutation.id,
    kind: mutation.kind,
    entityId: mutation.entityId,
    baseRevision: mutation.baseRevision,
    payloadJson: JSON.stringify(mutation.payload),
    occurredAt: timestamp(mutation.occurredAt),
    createdAt,
    enqueueSequence: sequence.value,
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
          @id, @title, @titleState, @ownerUserId, 1, 'pending', @createdAt, @metadataUpdatedAt,
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
            revision = @revision,
            sync_state = 'pending',
            metadata_updated_at = @metadataUpdatedAt,
            updated_at = @metadataUpdatedAt
        WHERE id = @id
      `).run({
        id: mutation.entityId,
        revision: mutation.baseRevision + 1,
        title: mutation.payload.title,
        titleState: mutation.payload.titleState,
        metadataUpdatedAt: timestamp(mutation.payload.metadataUpdatedAt),
      })
      return
    case 'conversation.preferences':
      requireOwnedConversation(database, ownerUserId, mutation.entityId)
      database.prepare(`
        UPDATE conversations
        SET generation_preferences_json = @generationPreferencesJson,
            revision = @revision,
            sync_state = 'pending',
            metadata_updated_at = @metadataUpdatedAt,
            updated_at = @metadataUpdatedAt
        WHERE id = @id
      `).run({
        id: mutation.entityId,
        generationPreferencesJson: JSON.stringify(mutation.payload.preferences),
        revision: mutation.baseRevision + 1,
        metadataUpdatedAt: timestamp(mutation.payload.metadataUpdatedAt),
      })
      return
    case 'conversation.delete':
      requireOwnedConversation(database, ownerUserId, mutation.entityId)
      database.prepare(`
        UPDATE conversations
        SET deleted_at = @occurredAt, revision = @revision,
            sync_state = 'pending', updated_at = @occurredAt
        WHERE id = @id
      `).run({
        id: mutation.entityId,
        revision: mutation.baseRevision + 1,
        occurredAt: timestamp(mutation.occurredAt),
      })
      return
    case 'conversation.restore':
      requireOwnedConversation(database, ownerUserId, mutation.entityId)
      database.prepare(`
        UPDATE conversations
        SET deleted_at = NULL, revision = @revision,
            sync_state = 'pending', updated_at = @occurredAt
        WHERE id = @id
      `).run({
        id: mutation.entityId,
        revision: mutation.baseRevision + 1,
        occurredAt: timestamp(mutation.occurredAt),
      })
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
      id, conversation_id, role, blocks_json, provider_projection_json,
      ordinal, execution_id, created_at
    ) VALUES (
      @id, @conversationId, @role, @blocksJson, @providerProjectionJson,
      COALESCE((SELECT MAX(ordinal) + 1 FROM messages WHERE conversation_id = @conversationId), 1),
      @executionId, @createdAt
    )
  `).run({
    id: payload.id,
    conversationId: payload.conversationId,
    role: payload.role,
    blocksJson: JSON.stringify(payload.blocks),
    providerProjectionJson: payload.providerProjection === undefined
      ? null
      : JSON.stringify(payload.providerProjection),
    executionId: payload.executionId ?? null,
    createdAt: timestamp(payload.createdAt),
  })
  database.prepare(`
    UPDATE conversations
    SET revision = @revision,
        last_activity_at = MAX(last_activity_at + 1, @createdAt),
        updated_at = MAX(updated_at, last_activity_at + 1, @createdAt),
        sync_state = 'pending'
    WHERE id = @conversationId
  `).run({
    conversationId: payload.conversationId,
    revision: mutation.baseRevision + 1,
    createdAt: timestamp(payload.createdAt),
  })
}

type MutationReceipt = RemoteMutation
type OrdinaryRemoteMutation = Exclude<RemoteMutation, { compacted: true }>

function isCompactedReceipt(
  mutation: MutationReceipt,
): mutation is Extract<RemoteMutation, { compacted: true }> {
  return 'compacted' in mutation && mutation.compacted === true
}

function requireRemoteRevision(mutation: MutationReceipt): number {
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

function sameMutationIdentity(
  local: SyncMutation,
  remote: MutationReceipt,
  database: SqliteDatabase,
): boolean {
  const payloadsMatch = isCompactedReceipt(remote)
    ? remote.kind === 'message.append'
      ? local.kind === 'message.append'
        && local.payload.conversationId === remote.conversationId
      : remote.kind === 'message.conversion_block_terminal'
        ? local.kind === 'message.conversion_block_terminal'
          && affectedConversationId(local, database) === remote.conversationId
        : true
    : local.kind === 'message.append' && remote.kind === 'message.append'
    ? isDeepStrictEqual(
        canonicalMessagePayload(local.payload),
        canonicalMessagePayload(remote.payload as typeof local.payload),
      )
    : isDeepStrictEqual(local.payload, remote.payload)
  return local.id === remote.id
    && local.kind === remote.kind
    && local.entityId === remote.entityId
    && local.baseRevision === remote.baseRevision
    && payloadsMatch
}

function canonicalMessagePayload(
  payload: Extract<SyncMutation, { kind: 'message.append' }>['payload'],
): Extract<SyncMutation, { kind: 'message.append' }>['payload'] {
  return {
    ...payload,
    blocks: payload.blocks.map((block) => block.type === 'workflow_proposal'
      ? { ...block, args: sanitizeOpaqueWorkflowArgs(block.args) }
      : block),
  }
}

function requireValidRemoteResult(
  mutation: MutationReceipt,
  allowExactConversionDuplicate = false,
): number {
  const result = requireRemoteRevision(mutation)
  const valid = (() => {
    switch (mutation.kind) {
      case 'conversation.create':
        return mutation.baseRevision === 0 && result === 1
      case 'conversation.rename':
      case 'conversation.preferences':
      case 'conversation.delete':
      case 'conversation.restore':
      case 'preferences.update':
        return result === mutation.baseRevision + 1
      case 'message.append':
        return result === mutation.baseRevision || result === mutation.baseRevision + 1
      case 'message.conversion_block_terminal':
        return result === mutation.baseRevision + 1
          || (allowExactConversionDuplicate && result === mutation.baseRevision)
      case 'legacy.import':
      case 'privacy.consent':
      case 'usage.record':
        return result === 0
    }
  })()
  if (!valid) throw new UserDataConsistencyError()
  return result
}

function validateOutboxReceipt(
  database: SqliteDatabase,
  mutation: MutationReceipt,
  validateRevision = true,
): OutboxMutationRecord | undefined {
  const row = database.prepare(`
    SELECT id, kind, entity_id AS entityId, base_revision AS baseRevision,
           payload_json AS payloadJson, state, attempts,
           next_attempt_at AS nextAttemptAt, last_error_code AS lastErrorCode,
           occurred_at AS occurredAt, created_at AS createdAt
    FROM outbox_mutations
    WHERE id = @id
  `).get({ id: mutation.id }) as Query | undefined
  if (row === undefined) return undefined
  const local = outboxFromRow(row)
  if (!sameMutationIdentity(local, mutation, database)) throw new UserDataConsistencyError()
  if (validateRevision) requireValidRemoteResult(mutation, true)
  return local
}

function evidenceFromRow(row: Query): SyncMutation {
  return parsePersisted(() => syncMutationSchema.parse({
    id: row.id,
    kind: row.kind,
    entityId: row.entityId,
    baseRevision: row.baseRevision,
    payload: JSON.parse(z.string().parse(row.payloadJson)),
    occurredAt: isoTimestamp(z.number().int().nonnegative().parse(row.occurredAt)),
  }))
}

function findReceiptEvidence(database: SqliteDatabase, id: string): SyncMutation | undefined {
  const row = database.prepare(`
    SELECT mutation_id AS id, kind, entity_id AS entityId, base_revision AS baseRevision,
           payload_json AS payloadJson, occurred_at AS occurredAt
    FROM sync_receipt_evidence
    WHERE mutation_id = @id
  `).get({ id }) as Query | undefined
  return row === undefined ? undefined : evidenceFromRow(row)
}

function validateReceiptEvidence(
  database: SqliteDatabase,
  mutation: MutationReceipt,
): SyncMutation | undefined {
  const local = findReceiptEvidence(database, mutation.id)
  if (local === undefined) return undefined
  if (!sameMutationIdentity(local, mutation, database)) throw new UserDataConsistencyError()
  requireValidRemoteResult(mutation, true)
  return local
}

function preserveReceiptEvidence(database: SqliteDatabase, mutation: SyncMutation): void {
  const existing = findReceiptEvidence(database, mutation.id)
  if (existing !== undefined) {
    if (!isDeepStrictEqual(existing, mutation)) throw new UserDataConsistencyError()
    return
  }
  database.prepare(`
    INSERT INTO sync_receipt_evidence (
      mutation_id, kind, entity_id, base_revision, payload_json, occurred_at, created_at
    ) VALUES (
      @id, @kind, @entityId, @baseRevision, @payloadJson, @occurredAt, @createdAt
    )
  `).run({
    id: mutation.id,
    kind: mutation.kind,
    entityId: mutation.entityId,
    baseRevision: mutation.baseRevision,
    payloadJson: JSON.stringify(mutation.payload),
    occurredAt: timestamp(mutation.occurredAt),
    createdAt: Date.now(),
  })
}

function remoteConversation(
  database: SqliteDatabase,
  ownerUserId: string,
  conversationId: string,
): z.infer<typeof conversationRowSchema> | undefined {
  const raw = database.prepare(`
    SELECT id, title, title_state AS titleState, revision, sync_state AS syncState,
           created_at AS createdAt, last_activity_at AS lastActivityAt,
           metadata_updated_at AS metadataUpdatedAt, deleted_at AS deletedAt,
           generation_preferences_json AS generationPreferencesJson, user_id AS userId
    FROM conversations
    WHERE id = @conversationId
  `).get({ conversationId }) as Query | undefined
  if (raw === undefined) return undefined
  const conversation = parsePersisted(() => conversationRowSchema.parse(raw))
  assertStoredOwner(conversation.userId ?? undefined, ownerUserId)
  return conversation
}

function parseConversationGenerationPreferences(
  conversation: z.infer<typeof conversationRowSchema>,
): ConversationGenerationPreferences | undefined {
  const serialized = conversation.generationPreferencesJson
  if (serialized == null) return undefined
  return parsePersisted(() => conversationGenerationPreferencesSchema.parse(
    JSON.parse(serialized),
  ))
}

function recomputeConversationSyncState(
  database: SqliteDatabase,
  ownerUserId: string,
  conversationId: string,
): void {
  if (remoteConversation(database, ownerUserId, conversationId) === undefined) return
  const aggregate = database.prepare(`
    SELECT COUNT(*) AS total,
           MAX(CASE WHEN state = 'failed' AND next_attempt_at IS NULL THEN 1 ELSE 0 END)
             AS hasTerminalFailure,
           MAX(CASE WHEN state = 'syncing' THEN 1 ELSE 0 END) AS hasSyncing
    FROM outbox_mutations
      WHERE (
        (entity_id = @conversationId AND kind LIKE 'conversation.%')
        OR (kind = 'message.append'
          AND json_extract(payload_json, '$.conversationId') = @conversationId)
        OR (kind = 'message.conversion_block_terminal'
          AND entity_id IN (SELECT id FROM messages WHERE conversation_id = @conversationId))
      )
  `).get({ conversationId }) as {
    total: number
    hasTerminalFailure: number | null
    hasSyncing: number | null
  }
  const syncState = aggregate.hasTerminalFailure === 1
    ? 'failed'
    : aggregate.hasSyncing === 1
      ? 'syncing'
      : aggregate.total > 0
        ? 'pending'
        : 'synced'
  database.prepare(`
    UPDATE conversations
    SET sync_state = @syncState
    WHERE id = @conversationId
  `).run({ conversationId, syncState })
}

function acknowledgeLocalMutation(
  database: SqliteDatabase,
  ownerUserId: string,
  local: SyncMutation,
  remote: MutationReceipt,
  source: 'outbox' | 'evidence' = 'outbox',
): void {
  const resultRevision = requireValidRemoteResult(remote, true)
  let conversationId: string | undefined
  switch (local.kind) {
    case 'conversation.create':
    case 'conversation.rename':
    case 'conversation.preferences':
    case 'conversation.delete':
    case 'conversation.restore':
      conversationId = local.entityId
      requireOwnedConversation(database, ownerUserId, conversationId)
      break
    case 'message.append':
      conversationId = local.payload.conversationId
      requireOwnedConversation(database, ownerUserId, conversationId)
      if (storedMessage(database, local.payload.id) === undefined) {
        throw new UserDataConsistencyError()
      }
      break
    case 'message.conversion_block_terminal': {
      const message = storedMessage(database, local.payload.messageId)
      if (!message) throw new UserDataConsistencyError()
      const target = requireConversionBlockTarget(message, local.payload)
      if (target.state !== 'terminal') throw new UserDataConsistencyError()
      conversationId = message.conversationId
      requireOwnedConversation(database, ownerUserId, conversationId)
      break
    }
    case 'privacy.consent':
      projectConsent(database, local.payload)
      break
    case 'preferences.update':
      if ((storedPreferences(database)?.revision ?? 0) <= resultRevision) {
        projectPreferences(database, local.payload, resultRevision, remote.receivedAt)
      }
      break
    default:
      break
  }
  const deleted = source === 'outbox'
    ? database.prepare('DELETE FROM outbox_mutations WHERE id = @id').run({ id: local.id })
    : database.prepare('DELETE FROM sync_receipt_evidence WHERE mutation_id = @id').run({ id: local.id })
  if (deleted.changes !== 1) throw new UserDataConsistencyError()
  if (conversationId !== undefined) {
    database.prepare(`
      UPDATE conversations
      SET revision = MAX(revision, @revision)
      WHERE id = @conversationId
    `).run({
      conversationId,
      revision: resultRevision,
    })
    recomputeConversationSyncState(database, ownerUserId, conversationId)
  }
}

function sameConversationCreate(
  row: z.infer<typeof conversationRowSchema>,
  mutation: Extract<OrdinaryRemoteMutation, { kind: 'conversation.create' }>,
): boolean {
  return row.title === mutation.payload.title
    && row.titleState === mutation.payload.titleState
    && row.createdAt === timestamp(mutation.payload.createdAt)
    && row.lastActivityAt === timestamp(mutation.payload.lastActivityAt)
    && row.metadataUpdatedAt === timestamp(mutation.payload.metadataUpdatedAt)
}

function storedMessage(database: SqliteDatabase, id: string) {
  const row = database.prepare(`
    SELECT id, conversation_id AS conversationId, role, blocks_json AS blocksJson,
           provider_projection_json AS providerProjectionJson,
           ordinal, execution_id AS executionId, created_at AS createdAt
    FROM messages
    WHERE id = @id
  `).get({ id }) as Query | undefined
  if (row === undefined) return undefined
  const parsed = parsePersisted(() => messageRowSchema.parse(row))
  const message = parsePersisted(() => chatMessageSchema.parse({
    id: parsed.id,
    conversationId: parsed.conversationId,
    role: parsed.role,
    blocks: chatBlockSchema.array().parse(JSON.parse(parsed.blocksJson)),
    ...(parsed.executionId === null ? {} : { executionId: parsed.executionId }),
    createdAt: isoTimestamp(parsed.createdAt),
  }))
  const providerProjection = parsed.providerProjectionJson === null
    || parsed.providerProjectionJson === undefined
    ? undefined
    : parsePersisted(() => messageProviderProjectionSchema.parse(
      JSON.parse(parsed.providerProjectionJson as string),
    ))
  return { ...message, ...(providerProjection === undefined ? {} : { providerProjection }) }
}

function requireConversionBlockTarget(
  message: NonNullable<ReturnType<typeof storedMessage>>,
  payload: Extract<SyncMutation, { kind: 'message.conversion_block_terminal' }>['payload'],
) {
  const candidates = message.blocks.filter((block) => (
    'blockId' in block && block.blockId === payload.blockId
  ))
  if (candidates.length !== 1) throw new UserDataConsistencyError()
  const target = candidates[0]
  if (target?.type !== 'conversion' || target.executionId !== payload.executionId) {
    throw new UserDataConsistencyError()
  }
  return target
}

function sameMessageAppend(
  stored: NonNullable<ReturnType<typeof storedMessage>>,
  mutation: Extract<OrdinaryRemoteMutation, { kind: 'message.append' }>,
): boolean {
  return stored.id === mutation.payload.id
    && stored.conversationId === mutation.payload.conversationId
    && stored.role === mutation.payload.role
    && stored.executionId === mutation.payload.executionId
    && isDeepStrictEqual(stored.providerProjection, mutation.payload.providerProjection)
    && timestamp(stored.createdAt) === timestamp(mutation.payload.createdAt)
    && isDeepStrictEqual(
      canonicalMessagePayload({ ...mutation.payload, blocks: stored.blocks }).blocks,
      canonicalMessagePayload(mutation.payload).blocks,
    )
}

function applyRemoteMutation(
  database: SqliteDatabase,
  ownerUserId: string,
  mutation: RemoteMutation,
): void {
  const matchingOutboxReceipt = validateOutboxReceipt(database, mutation)
  if (matchingOutboxReceipt !== undefined) {
    acknowledgeLocalMutation(database, ownerUserId, matchingOutboxReceipt, mutation)
    return
  }
  const matchingEvidence = validateReceiptEvidence(database, mutation)
  if (matchingEvidence !== undefined) {
    acknowledgeLocalMutation(database, ownerUserId, matchingEvidence, mutation, 'evidence')
    return
  }
  if (isCompactedReceipt(mutation)) {
    applyCompactedRemoteMutation(database, ownerUserId, mutation)
    return
  }
  const revision = mutation.kind === 'message.conversion_block_terminal'
    ? requireRemoteRevision(mutation)
    : requireValidRemoteResult(mutation)
  switch (mutation.kind) {
    case 'conversation.create': {
      const createdAt = timestamp(mutation.payload.createdAt)
      const existingRaw = database.prepare(`
        SELECT id, title, title_state AS titleState, revision, sync_state AS syncState,
               created_at AS createdAt, last_activity_at AS lastActivityAt,
               metadata_updated_at AS metadataUpdatedAt,
               generation_preferences_json AS generationPreferencesJson, user_id AS userId
        FROM conversations
        WHERE id = @id
      `).get({ id: mutation.entityId }) as Query | undefined
      const existing = existingRaw === undefined
        ? undefined
        : parsePersisted(() => conversationRowSchema.parse(existingRaw))
      if (existing !== undefined) {
        assertStoredOwner(existing.userId ?? undefined, ownerUserId)
        if (!sameConversationCreate(existing, mutation)) throw new UserDataConsistencyError()
        break
      }
      database.prepare(`
        INSERT INTO conversations (
          id, title, title_state, user_id, revision, sync_state, created_at, updated_at,
          last_activity_at, metadata_updated_at
        ) VALUES (
          @id, @title, @titleState, @ownerUserId, @revision, 'synced', @createdAt, @metadataUpdatedAt,
          @lastActivityAt, @metadataUpdatedAt
        )
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
      const current = remoteConversation(database, ownerUserId, mutation.entityId)
      if (current === undefined) throw new UserDataConsistencyError()
      if (current.revision === revision) {
        if (
          current.title !== mutation.payload.title
          || current.titleState !== mutation.payload.titleState
          || current.metadataUpdatedAt !== timestamp(mutation.payload.metadataUpdatedAt)
        ) throw new UserDataConsistencyError()
        break
      }
      if (current.revision !== mutation.baseRevision) throw new UserDataConsistencyError()
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
        revision,
        metadataUpdatedAt: timestamp(mutation.payload.metadataUpdatedAt),
      })
      if (result.changes !== 1) throw new UserDataConsistencyError()
      break
    }
    case 'conversation.preferences': {
      const current = remoteConversation(database, ownerUserId, mutation.entityId)
      if (current === undefined) throw new UserDataConsistencyError()
      const storedPreferences = parseConversationGenerationPreferences(current)
      if (current.revision === revision) {
        if (
          !isDeepStrictEqual(storedPreferences, mutation.payload.preferences)
          || current.metadataUpdatedAt !== timestamp(mutation.payload.metadataUpdatedAt)
        ) throw new UserDataConsistencyError()
        break
      }
      if (current.revision !== mutation.baseRevision) throw new UserDataConsistencyError()
      const result = database.prepare(`
        UPDATE conversations
        SET generation_preferences_json = @generationPreferencesJson,
            revision = @revision,
            sync_state = 'synced',
            metadata_updated_at = @metadataUpdatedAt,
            updated_at = @metadataUpdatedAt
        WHERE id = @id
      `).run({
        id: mutation.entityId,
        generationPreferencesJson: JSON.stringify(mutation.payload.preferences),
        revision,
        metadataUpdatedAt: timestamp(mutation.payload.metadataUpdatedAt),
      })
      if (result.changes !== 1) throw new UserDataConsistencyError()
      break
    }
    case 'conversation.delete':
    case 'conversation.restore': {
      const current = remoteConversation(database, ownerUserId, mutation.entityId)
      if (current === undefined) throw new UserDataConsistencyError()
      const expectedDeleted = mutation.kind === 'conversation.delete'
      if (current.revision === revision) {
        if ((current.deletedAt !== null) !== expectedDeleted) {
          throw new UserDataConsistencyError()
        }
        break
      }
      if (
        current.revision !== mutation.baseRevision
        || (mutation.kind === 'conversation.restore' && current.deletedAt === null)
      ) throw new UserDataConsistencyError()
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
        revision,
        updatedAt: timestamp(mutation.receivedAt),
      })
      if (result.changes !== 1) throw new UserDataConsistencyError()
      break
    }
    case 'message.append': {
      requireOwnedConversation(database, ownerUserId, mutation.payload.conversationId)
      const createdAt = timestamp(mutation.payload.createdAt)
      const existing = storedMessage(database, mutation.payload.id)
      if (existing !== undefined && !sameMessageAppend(existing, mutation)) {
        throw new UserDataConsistencyError()
      }
      const conversation = remoteConversation(
        database,
        ownerUserId,
        mutation.payload.conversationId,
      )
      if (conversation === undefined) throw new UserDataConsistencyError()
      if (existing !== undefined) {
        if (conversation.revision < revision) throw new UserDataConsistencyError()
        break
      }
      if (
        conversation.revision !== mutation.baseRevision
        || revision !== mutation.baseRevision + 1
      ) throw new UserDataConsistencyError()
      if (existing === undefined) {
        database.prepare(`
          INSERT INTO messages (
            id, conversation_id, role, blocks_json, provider_projection_json,
            ordinal, execution_id, created_at
          ) VALUES (
            @id, @conversationId, @role, @blocksJson, @providerProjectionJson,
            COALESCE((SELECT MAX(ordinal) + 1 FROM messages WHERE conversation_id = @conversationId), 1),
            @executionId, @createdAt
          )
        `).run({
          id: mutation.payload.id,
          conversationId: mutation.payload.conversationId,
          role: mutation.payload.role,
          blocksJson: JSON.stringify(mutation.payload.blocks),
          providerProjectionJson: mutation.payload.providerProjection === undefined
            ? null
            : JSON.stringify(mutation.payload.providerProjection),
          executionId: mutation.payload.executionId ?? null,
          createdAt,
        })
      }
      const updatedConversation = database.prepare(`
        UPDATE conversations
        SET revision = @revision,
            sync_state = 'synced',
            last_activity_at = MAX(last_activity_at, @createdAt),
            updated_at = MAX(updated_at, @createdAt)
        WHERE id = @conversationId
      `).run({
        conversationId: mutation.payload.conversationId,
        revision,
        createdAt,
      })
      if (updatedConversation.changes !== 1) throw new UserDataConsistencyError()
      break
    }
    case 'message.conversion_block_terminal': {
      const existing = storedMessage(database, mutation.payload.messageId)
      if (!existing || existing.id !== mutation.entityId) throw new UserDataConsistencyError()
      const matched = requireConversionBlockTarget(existing, mutation.payload)
      const conversation = remoteConversation(database, ownerUserId, existing.conversationId)
      if (!conversation) throw new UserDataConsistencyError()
      const duplicateRevision = revision === mutation.baseRevision
      const appliedRevision = revision === mutation.baseRevision + 1
      if (!duplicateRevision && !appliedRevision) throw new UserDataConsistencyError()
      if (matched.state === 'active' && (
        !appliedRevision || conversation.revision !== mutation.baseRevision
      )) throw new UserDataConsistencyError()
      if (matched.state === 'terminal') {
        if (duplicateRevision) {
          if (conversation.revision !== mutation.baseRevision) throw new UserDataConsistencyError()
          break
        }
        if (conversation.revision === revision) break
        if (conversation.revision !== mutation.baseRevision) throw new UserDataConsistencyError()
      }
      const blocks = existing.blocks.map((block) => {
        if (block.type !== 'conversion' || block.blockId !== mutation.payload.blockId
          || block.executionId !== mutation.payload.executionId) return block
        return block.state === 'terminal' ? block : { ...block, state: 'terminal' as const }
      })
      if (JSON.stringify(blocks) !== JSON.stringify(existing.blocks)) {
        database.prepare('UPDATE messages SET blocks_json = @blocksJson WHERE id = @id').run({
          id: existing.id, blocksJson: JSON.stringify(blocks),
        })
      }
      database.prepare('UPDATE conversations SET revision = @revision, sync_state = \'synced\' WHERE id = @id').run({
        id: existing.conversationId, revision,
      })
      break
    }
    case 'privacy.consent':
      projectConsent(database, mutation.payload)
      break
    case 'preferences.update':
      projectPreferences(database, mutation.payload, revision, mutation.receivedAt)
      break
    default:
      break
  }
  const conversationId = affectedConversationId(mutation, database)
  if (conversationId !== undefined) {
    recomputeConversationSyncState(database, ownerUserId, conversationId)
  }
}

function applyCompactedRemoteMutation(
  database: SqliteDatabase,
  ownerUserId: string,
  mutation: Extract<RemoteMutation, { compacted: true }>,
): void {
  const revision = requireValidRemoteResult(
    mutation,
    mutation.kind === 'message.conversion_block_terminal',
  )
  const conversationId = mutation.kind === 'message.append'
    || mutation.kind === 'message.conversion_block_terminal'
    ? mutation.conversationId
    : mutation.entityId
  const current = remoteConversation(database, ownerUserId, conversationId)
  // Purged content is never reconstructed from a compacted cursor anchor.
  if (current === undefined) return
  if (current.revision > revision) return
  if (current.revision !== mutation.baseRevision && current.revision !== revision) {
    throw new UserDataConsistencyError()
  }
  const deletedAt = mutation.kind === 'conversation.delete'
    ? timestamp(mutation.receivedAt)
    : mutation.kind === 'conversation.restore'
      ? null
      : current.deletedAt
  const result = database.prepare(`
    UPDATE conversations
    SET revision = @revision,
        deleted_at = @deletedAt,
        sync_state = 'synced',
        updated_at = MAX(updated_at, @receivedAt)
    WHERE id = @conversationId
  `).run({
    conversationId,
    revision,
    deletedAt,
    receivedAt: timestamp(mutation.receivedAt),
  })
  if (result.changes !== 1) throw new UserDataConsistencyError()
  recomputeConversationSyncState(database, ownerUserId, conversationId)
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
    ...conversationSyncWarning(database, z.string().parse(row.id)),
  })))
  const last = pageRows.at(-1)
  return {
    items,
    ...(rows.length > 50 && last
      ? { nextCursor: encodeCursor({ lastActivityAt: last.lastActivityAt, id: last.id }) }
      : {}),
  }
}

const SYNC_WARNING_AGE_MS = 24 * 60 * 60 * 1_000

function conversationSyncWarning(database: SqliteDatabase, conversationId: string) {
  const result = database.prepare(`
    SELECT MIN(created_at) AS oldest
    FROM outbox_mutations
    WHERE state IN ('pending', 'syncing', 'failed')
      AND (
        (kind LIKE 'conversation.%' AND entity_id = @conversationId)
        OR (kind = 'message.append' AND json_extract(payload_json, '$.conversationId') = @conversationId)
        OR (kind = 'message.conversion_block_terminal'
          AND entity_id IN (SELECT id FROM messages WHERE conversation_id = @conversationId))
      )
  `).get({ conversationId }) as { oldest: number | null }
  return result.oldest !== null && Date.now() - result.oldest >= SYNC_WARNING_AGE_MS
    ? { syncWarningSince: isoTimestamp(result.oldest) }
    : {}
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

function findOutboxMutation(database: SqliteDatabase, id: string): OutboxMutationRecord | undefined {
  const row = database.prepare(`
    SELECT id, kind, entity_id AS entityId, base_revision AS baseRevision,
           payload_json AS payloadJson, state, attempts,
           next_attempt_at AS nextAttemptAt, last_error_code AS lastErrorCode,
           occurred_at AS occurredAt, created_at AS createdAt
    FROM outbox_mutations
    WHERE id = @id
  `).get({ id }) as Query | undefined
  return row === undefined ? undefined : outboxFromRow(row)
}

function affectedConversationId(
  mutation: SyncMutation | RemoteMutation,
  database?: SqliteDatabase,
): string | undefined {
  switch (mutation.kind) {
    case 'conversation.create':
    case 'conversation.rename':
    case 'conversation.preferences':
    case 'conversation.delete':
    case 'conversation.restore':
      return mutation.entityId
    case 'message.append':
      return 'compacted' in mutation ? mutation.conversationId : mutation.payload.conversationId
    case 'message.conversion_block_terminal':
      if ('compacted' in mutation) return mutation.conversationId
      return database === undefined ? undefined : storedMessage(database, mutation.entityId)?.conversationId
    default:
      return undefined
  }
}

function recomputeAffectedConversations(
  database: SqliteDatabase,
  ownerUserId: string,
  mutations: readonly SyncMutation[],
): void {
  const conversationIds = new Set(mutations.map((mutation) => affectedConversationId(mutation, database)).filter(
    (conversationId): conversationId is string => conversationId !== undefined,
  ))
  for (const conversationId of conversationIds) {
    recomputeConversationSyncState(database, ownerUserId, conversationId)
  }
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

function acknowledgeAuthoritativeConversionDuplicate(
  database: SqliteDatabase,
  ownerUserId: string,
  local: Extract<SyncMutation, { kind: 'message.conversion_block_terminal' }>,
  remote: MutationReceipt,
): string[] {
  const resultRevision = requireValidRemoteResult(remote, true)
  if (resultRevision !== local.baseRevision) throw new UserDataConsistencyError()
  const message = storedMessage(database, local.payload.messageId)
  if (!message || message.id !== local.entityId) throw new UserDataConsistencyError()
  const target = requireConversionBlockTarget(message, local.payload)
  if (target.state !== 'terminal') throw new UserDataConsistencyError()
  requireOwnedConversation(database, ownerUserId, message.conversationId)
  const anchor = database.prepare(`
    SELECT enqueue_sequence AS enqueueSequence
    FROM outbox_mutations
    WHERE id = @id
  `).get({ id: local.id }) as { enqueueSequence: number } | undefined
  if (!anchor || !Number.isSafeInteger(anchor.enqueueSequence)) throw new UserDataConsistencyError()

  const later = (database.prepare(`
    SELECT id, kind, entity_id AS entityId, base_revision AS baseRevision,
           payload_json AS payloadJson, state, attempts,
           next_attempt_at AS nextAttemptAt, last_error_code AS lastErrorCode,
           occurred_at AS occurredAt, created_at AS createdAt,
           enqueue_sequence AS enqueueSequence
    FROM outbox_mutations
    WHERE enqueue_sequence > @enqueueSequence
      AND state IN ('pending', 'syncing')
    ORDER BY enqueue_sequence
  `).all({ enqueueSequence: anchor.enqueueSequence }) as Query[])
    .map((row) => ({ mutation: outboxFromRow(row), enqueueSequence: row.enqueueSequence }))
    .filter(({ mutation }) => affectedConversationId(mutation, database) === message.conversationId)

  preserveReceiptEvidence(database, local)
  const deleted = database.prepare('DELETE FROM outbox_mutations WHERE id = @id').run({ id: local.id })
  if (deleted.changes !== 1) throw new UserDataConsistencyError()

  let predictedRevision = resultRevision
  const supersededIds: string[] = []
  for (const { mutation, enqueueSequence } of later) {
    if (!Number.isSafeInteger(enqueueSequence)) throw new UserDataConsistencyError()
    const rebased = syncMutationSchema.parse({
      id: randomUUID(),
      kind: mutation.kind,
      entityId: mutation.entityId,
      baseRevision: predictedRevision,
      payload: mutation.payload,
      occurredAt: mutation.occurredAt,
    })
    const changed = database.prepare(`
      UPDATE outbox_mutations
      SET id = @newId,
          base_revision = @baseRevision,
          state = 'pending',
          attempts = 0,
          next_attempt_at = NULL,
          last_error_code = NULL
      WHERE id = @oldId AND enqueue_sequence = @enqueueSequence
    `).run({
      oldId: mutation.id,
      newId: rebased.id,
      baseRevision: rebased.baseRevision,
      enqueueSequence,
    }).changes
    if (changed !== 1) throw new UserDataConsistencyError()
    supersededIds.push(mutation.id)
    predictedRevision += 1
  }
  const updated = database.prepare(`
    UPDATE conversations
    SET revision = @predictedRevision
    WHERE id = @conversationId AND user_id = @ownerUserId
  `).run({
    predictedRevision,
    conversationId: message.conversationId,
    ownerUserId,
  })
  if (updated.changes !== 1) throw new UserDataConsistencyError()
  recomputeConversationSyncState(database, ownerUserId, message.conversationId)
  return supersededIds
}

function acknowledgePushResults(
  database: SqliteDatabase,
  ownerUserId: string,
  sentInput: readonly SyncMutation[],
  resultInput: readonly SyncMutationResult[],
): PushAcknowledgementOutcome {
  const sent = parsePersisted(() => sentInput.map((mutation) => syncMutationSchema.parse(mutation)))
  const results = parsePersisted(() => resultInput.map((result) => syncMutationResultSchema.parse(result)))
  if (sent.length === 0 || sent.length > 100 || sent.length !== results.length) {
    throw new UserDataConsistencyError()
  }
  const sentById = new Map(sent.map((mutation) => [mutation.id, mutation]))
  const resultById = new Map(results.map((result) => [result.id, result]))
  if (sentById.size !== sent.length || resultById.size !== results.length) {
    throw new UserDataConsistencyError()
  }

  return transaction(database, () => {
    const supersededIds = new Set<string>()
    for (const [id, mutation] of sentById) {
      const result = resultById.get(id)
      if (!result) throw new UserDataConsistencyError()
      if (supersededIds.has(id)) {
        if (result.status !== 'conflict' && result.status !== 'rejected') {
          throw new UserDataConsistencyError()
        }
        continue
      }
      const resultRevision = result.status === 'applied' || result.status === 'duplicate'
        ? result.revision
        : null
      const receipt = {
        id: mutation.id,
        kind: mutation.kind,
        entityId: mutation.entityId,
        baseRevision: mutation.baseRevision,
        resultRevision,
        payload: mutation.payload,
        receivedAt: mutation.occurredAt,
      } as OrdinaryRemoteMutation
      const local = validateOutboxReceipt(database, receipt, false)
      if (local?.state !== 'syncing') throw new UserDataConsistencyError()
      if (result.status === 'applied' || result.status === 'duplicate') {
        if (mutation.kind === 'message.conversion_block_terminal') {
          const expectedRevision = result.status === 'applied'
            ? mutation.baseRevision + 1
            : mutation.baseRevision
          if (result.revision !== expectedRevision) throw new UserDataConsistencyError()
        } else {
          requireValidRemoteResult(receipt)
        }
        preserveReceiptEvidence(database, local)
        if (mutation.kind === 'message.conversion_block_terminal'
          && result.status === 'duplicate'
          && result.revision === mutation.baseRevision) {
          for (const supersededId of acknowledgeAuthoritativeConversionDuplicate(
            database,
            ownerUserId,
            mutation,
            receipt,
          )) supersededIds.add(supersededId)
        } else {
          acknowledgeLocalMutation(database, ownerUserId, local, receipt)
        }
      }
    }
    return { supersededIds: [...supersededIds] }
  })
}

function assertEveryMessageOwned(database: SqliteDatabase, ownerUserId: string): void {
  const foreign = database.prepare(`
    SELECT 1
    FROM messages AS message
    JOIN conversations AS conversation ON conversation.id = message.conversation_id
    WHERE conversation.user_id IS NULL OR conversation.user_id <> @ownerUserId
    LIMIT 1
  `).get({ ownerUserId })
  if (foreign !== undefined) throw new UserDataOwnerMismatchError()
}

function assertWorkflowApprovalOwned(
  database: SqliteDatabase,
  ownerUserId: string,
  executionId: string,
): void {
  const row = database.prepare(`
    SELECT conversation.user_id AS userId
    FROM agent_workflow_approvals AS approval
    JOIN messages AS message ON message.id = approval.message_id
    JOIN conversations AS conversation ON conversation.id = message.conversation_id
    WHERE approval.execution_id = @executionId
  `).get({ executionId }) as Query | undefined
  if (row === undefined) return
  const parsed = parsePersisted(() => z.object({ userId: z.string().nullable() }).parse(row))
  assertStoredOwner(parsed.userId ?? undefined, ownerUserId)
}

export function createUserDataRepositories(
  database: SqliteDatabase,
  ownerUserId: string,
): UserDataRepositories {
  transaction(database, () => {
    const interrupted = (database.prepare(`
      SELECT id, kind, entity_id AS entityId, base_revision AS baseRevision,
             payload_json AS payloadJson, state, attempts,
             next_attempt_at AS nextAttemptAt, last_error_code AS lastErrorCode,
             occurred_at AS occurredAt, created_at AS createdAt
      FROM outbox_mutations
      WHERE state = 'syncing'
    `).all() as Query[]).map(outboxFromRow)
    database.prepare(`
      UPDATE outbox_mutations
      SET state = 'pending', next_attempt_at = NULL, last_error_code = 'SYNC_FAILED'
      WHERE state = 'syncing'
    `).run()
    recomputeAffectedConversations(database, ownerUserId, interrupted)
  })
  const repositories = createRepositories(database)
  const conversationSummary = (id: string) => {
    const row = database.prepare(`
      SELECT id, title, title_state AS titleState, revision, sync_state AS syncState,
             created_at AS createdAt, last_activity_at AS lastActivityAt,
             metadata_updated_at AS metadataUpdatedAt
      FROM conversations
      WHERE id = @id AND user_id = @ownerUserId AND deleted_at IS NULL
    `).get({ id, ownerUserId }) as Query | undefined
    return row === undefined ? undefined : parsePersisted(() => conversationSummarySchema.parse({
      ...row,
      createdAt: isoTimestamp(z.number().parse(row.createdAt)),
      lastActivityAt: isoTimestamp(z.number().parse(row.lastActivityAt)),
      metadataUpdatedAt: isoTimestamp(z.number().parse(row.metadataUpdatedAt)),
      ...conversationSyncWarning(database, id),
    }))
  }
  const messageMutation = (
    message: Parameters<AppRepositories['messages']['insert']>[0],
  ): SyncMutation => ({
    id: randomUUID(),
    kind: 'message.append',
    entityId: message.id,
    baseRevision: conversationSummary(message.conversationId)?.revision ?? 0,
    payload: {
      id: message.id,
      conversationId: message.conversationId,
      role: message.role === 'user' ? 'user' : 'assistant',
      blocks: chatBlockSchema.array().parse(message.blocks),
      ...(message.providerProjection === undefined
        ? {}
        : { providerProjection: message.providerProjection }),
      ...(typeof message.executionId === 'string' ? { executionId: message.executionId } : {}),
      createdAt: isoTimestamp(message.createdAt),
    },
    occurredAt: isoTimestamp(message.createdAt),
  })
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
      return conversations.list()
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
    renameByUser(id: string, title: string) {
      if (!conversations.get(id)) return undefined
      return repositories.conversations.renameByUser(id, title)
    },
    claimTitleGeneration(id: string) {
      if (!conversations.get(id)) return false
      return repositories.conversations.claimTitleGeneration(id)
    },
    completeTitleGeneration(id: string, title: string) {
      const summary = conversationSummary(id)
      const current = conversations.get(id)
      if (!summary || current?.titleState !== 'generating') return undefined
      const occurredAt = isoTimestamp(Date.now())
      recordMutation({
        id: randomUUID(),
        kind: 'conversation.rename',
        entityId: id,
        baseRevision: summary.revision,
        occurredAt,
        payload: {
          title,
          titleState: 'ai_named',
          metadataUpdatedAt: occurredAt,
        },
      }, (mutation) => optimisticConversationMutation(database, ownerUserId, mutation))
      return repositories.conversations.get(id)
    },
    failTitleGeneration(id: string) {
      if (!conversations.get(id)) return
      repositories.conversations.failTitleGeneration(id)
    },
    failPendingTitleGeneration(id: string) {
      if (!conversations.get(id)) return
      repositories.conversations.failPendingTitleGeneration(id)
    },
    failInterruptedTitleGenerations() {
      return transaction(database, () => database.prepare(`
        UPDATE conversations
        SET title_state = 'failed', updated_at = @updatedAt
        WHERE user_id = @ownerUserId AND title_state = 'generating'
      `).run({ ownerUserId, updatedAt: Date.now() }).changes)
    },
    updateGenerationPreferences(
      id: string,
      preferences: Parameters<AppRepositories['conversations']['updateGenerationPreferences']>[1],
    ) {
      if (!conversations.get(id)) return undefined
      const summary = conversationSummary(id)
      if (!summary) return undefined
      const occurredAt = isoTimestamp(Date.now())
      recordMutation({
        id: randomUUID(),
        kind: 'conversation.preferences',
        entityId: id,
        baseRevision: summary.revision,
        occurredAt,
        payload: {
          preferences: conversationGenerationPreferencesSchema.parse(preferences),
          metadataUpdatedAt: occurredAt,
        },
      }, (mutation) => optimisticConversationMutation(database, ownerUserId, mutation))
      return repositories.conversations.get(id)
    },
    delete(id: string) {
      if (!conversations.get(id)) return
      repositories.conversations.delete(id)
    },
    getSummary: conversationSummary,
    listPage: (input: { limit: 50; cursor?: string }) => conversationPage(database, ownerUserId, input),
  }
  const getOwnedMessage = (id: string) => {
    const stored = repositories.messages.get(id)
    if (stored) requireOwnedConversation(database, ownerUserId, stored.conversationId)
    return stored
  }
  const messages = {
    ...repositories.messages,
    insert(value: Parameters<AppRepositories['messages']['insert']>[0]) {
      requireOwnedConversation(database, ownerUserId, value.conversationId)
      return repositories.messages.insert(value)
    },
    insertWithAssets(
      value: Parameters<AppRepositories['messages']['insertWithAssets']>[0],
      assetIds: string[],
    ) {
      requireOwnedConversation(database, ownerUserId, value.conversationId)
      return repositories.messages.insertWithAssets(value, assetIds)
    },
    get: getOwnedMessage,
    listForConversation(conversationId: string) {
      requireOwnedConversation(database, ownerUserId, conversationId)
      return repositories.messages.listForConversation(conversationId)
    },
    listBeforeOrdinal(conversationId: string, beforeOrdinal: number) {
      requireOwnedConversation(database, ownerUserId, conversationId)
      return repositories.messages.listBeforeOrdinal(conversationId, beforeOrdinal)
    },
    update(
      id: string,
      value: Parameters<AppRepositories['messages']['update']>[1],
    ) {
      const existing = getOwnedMessage(id)
      if (!existing) return undefined
      return transaction(database, () => {
        const updated = repositories.messages.update(id, value)
        if (!updated) return undefined
        if (value.blocks !== undefined) {
          registerActiveConversionBindings(database, ownerUserId, updated, updated.blocks)
        }
        return updated
      })
    },
    replaceBlock(
      messageId: string,
      blockId: string,
      replacement: unknown,
    ) {
      const existing = getOwnedMessage(messageId)
      if (!existing) throw new UserDataConsistencyError()
      const parsed = chatBlockSchema.parse(replacement)
      if (parsed.type !== 'conversion' || parsed.state !== 'terminal') {
        return repositories.messages.replaceBlock(messageId, blockId, parsed)
      }
      const candidates = exactConversionBlocks(existing.blocks).filter((block) => block.blockId === blockId)
      const current = candidates[0]
      if (candidates.length !== 1 || parsed.blockId !== blockId
        || current?.executionId !== parsed.executionId) {
        throw new UserDataConsistencyError()
      }
      if (current.state === 'terminal') {
        transaction(database, () => consumeConversionBinding(
          database,
          ownerUserId,
          existing,
          current,
          Date.now(),
        ))
        return existing
      }
      if (current.state !== 'active') throw new UserDataConsistencyError()
      const summary = conversationSummary(existing.conversationId)
      if (!summary) throw new UserDataConsistencyError()
      const mutation: SyncMutation = {
        id: randomUUID(), kind: 'message.conversion_block_terminal', entityId: messageId,
        baseRevision: summary.revision, occurredAt: isoTimestamp(Date.now()),
        payload: { messageId, blockId, executionId: parsed.executionId, state: 'terminal' },
      }
      let updated: ReturnType<AppRepositories['messages']['replaceBlock']> | undefined
      const consumedAt = Date.now()
      recordMutation(mutation, () => {
        updated = repositories.messages.replaceBlock(messageId, blockId, parsed)
        consumeConversionBinding(database, ownerUserId, existing, parsed, consumedAt)
        database.prepare(`
          UPDATE conversations
          SET revision = @revision,
              last_activity_at = MAX(last_activity_at + 1, @createdAt),
              updated_at = MAX(updated_at, last_activity_at + 1, @createdAt), sync_state = 'pending'
          WHERE id = @conversationId AND user_id = @ownerUserId
        `).run({
          conversationId: existing.conversationId,
          ownerUserId,
          revision: mutation.baseRevision + 1,
          createdAt: existing.createdAt,
        })
      })
      if (!updated) throw new UserDataConsistencyError()
      return updated
    },
    upgradeLegacyApprovals() {
      assertEveryMessageOwned(database, ownerUserId)
      return repositories.messages.upgradeLegacyApprovals()
    },
    invalidatePendingAgentApprovals() {
      assertEveryMessageOwned(database, ownerUserId)
      return repositories.messages.invalidatePendingAgentApprovals()
    },
    hasWorkflowApproval(executionId: string) {
      assertWorkflowApprovalOwned(database, ownerUserId, executionId)
      return repositories.messages.hasWorkflowApproval(executionId)
    },
    failInterruptedMediaGenerations() {
      assertEveryMessageOwned(database, ownerUserId)
      return repositories.messages.failInterruptedMediaGenerations()
    },
    failInterruptedBrowserStatuses(requestIds: readonly string[]) {
      assertEveryMessageOwned(database, ownerUserId)
      return repositories.messages.failInterruptedBrowserStatuses(requestIds)
    },
    listPage(input: { conversationId: string; limit: 100; cursor?: string }) {
      requireOwnedConversation(database, ownerUserId, input.conversationId)
      return messagePage(database, input)
    },
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
  const mediaAssets: AppRepositories['mediaAssets'] = {
    insert(value) {
      requireOwnedConversation(database, ownerUserId, value.conversationId)
      if (value.messageId !== undefined && !messages.get(value.messageId)) {
        throw new UserDataConsistencyError()
      }
      return repositories.mediaAssets.insert(value)
    },
    get(id) {
      const stored = repositories.mediaAssets.get(id)
      if (stored) requireOwnedConversation(database, ownerUserId, stored.conversationId)
      return stored
    },
    listForConversation(conversationId) {
      requireOwnedConversation(database, ownerUserId, conversationId)
      return repositories.mediaAssets.listForConversation(conversationId)
    },
    listUnclaimedBefore(before) {
      const stored = repositories.mediaAssets.listUnclaimedBefore(before)
      for (const asset of stored) {
        requireOwnedConversation(database, ownerUserId, asset.conversationId)
      }
      return stored
    },
    update(id, patch) {
      if (!mediaAssets.get(id)) return undefined
      return repositories.mediaAssets.update(id, patch)
    },
    delete(id) {
      if (!mediaAssets.get(id)) return
      repositories.mediaAssets.delete(id)
    },
  }
  const requireOwnedMediaJob = (id: string) => {
    const stored = repositories.mediaGenerationJobs.get(id)
    if (stored) requireOwnedConversation(database, ownerUserId, stored.conversationId)
    return stored
  }
  const mediaGenerationJobs: AppRepositories['mediaGenerationJobs'] = {
    insert(value) {
      requireOwnedConversation(database, ownerUserId, value.conversationId)
      if (!messages.get(value.assistantMessageId)) throw new UserDataConsistencyError()
      return repositories.mediaGenerationJobs.insert(value)
    },
    startSubmissionIntent(value) {
      requireOwnedConversation(database, ownerUserId, value.job.conversationId)
      assertOwner(value.run.userId, ownerUserId)
      const mutation = messageMutation(value.userMessage)
      let started: ReturnType<AppRepositories['mediaGenerationJobs']['startSubmissionIntent']> | undefined
      recordMutation(mutation, () => {
        started = repositories.mediaGenerationJobs.startSubmissionIntent({
          ...value,
          run: { ...value.run, userId: ownerUserId },
        })
        bumpConversationActivity(
          value.job.conversationId,
          mutation.baseRevision + 1,
          value.userMessage.createdAt,
        )
      })
      if (!started) throw new UserDataConsistencyError()
      return started
    },
    bindSubmitted(id, input) {
      if (!requireOwnedMediaJob(id)) return undefined
      return repositories.mediaGenerationJobs.bindSubmitted(id, input)
    },
    insertTurn(value) {
      requireOwnedConversation(database, ownerUserId, value.run.conversationId)
      assertOwner(value.run.userId, ownerUserId)
      return repositories.mediaGenerationJobs.insertTurn({
        ...value,
        run: { ...value.run, userId: ownerUserId },
      })
    },
    get: requireOwnedMediaJob,
    reconcileInterrupted(endedAt) {
      for (const job of repositories.mediaGenerationJobs.listActive()) {
        requireOwnedConversation(database, ownerUserId, job.conversationId)
      }
      return repositories.mediaGenerationJobs.reconcileInterrupted(endedAt)
    },
    listResumable(now) {
      const jobs = repositories.mediaGenerationJobs.listResumable(now)
      for (const job of jobs) requireOwnedConversation(database, ownerUserId, job.conversationId)
      return jobs
    },
    listActive() {
      const jobs = repositories.mediaGenerationJobs.listActive()
      for (const job of jobs) requireOwnedConversation(database, ownerUserId, job.conversationId)
      return jobs
    },
    update(id, patch) {
      if (!requireOwnedMediaJob(id)) return undefined
      return repositories.mediaGenerationJobs.update(id, patch)
    },
    transition(id, expectedStatuses, patch) {
      if (!requireOwnedMediaJob(id)) return undefined
      return repositories.mediaGenerationJobs.transition(id, expectedStatuses, patch)
    },
    complete(id, expectedStatuses, input) {
      if (!requireOwnedMediaJob(id)) return undefined
      if (!mediaAssets.get(input.assetId)) throw new UserDataConsistencyError()
      let completed: ReturnType<AppRepositories['mediaGenerationJobs']['complete']>
      transaction(database, () => {
        completed = repositories.mediaGenerationJobs.complete(id, expectedStatuses, input)
        if (!completed) return
        assertOutboxCapacity(database)
        const mutation = syncMutationSchema.parse(messageMutation(completed.message))
        insertOutbox(database, mutation)
        bumpConversationActivity(
          completed.job.conversationId,
          mutation.baseRevision + 1,
          input.endedAt,
        )
        recomputeAffectedConversations(database, ownerUserId, [mutation])
      })
      return completed
    },
    fail(id, expectedStatuses, errorCode, endedAt) {
      if (!requireOwnedMediaJob(id)) return undefined
      let failed: ReturnType<AppRepositories['mediaGenerationJobs']['fail']>
      transaction(database, () => {
        failed = repositories.mediaGenerationJobs.fail(id, expectedStatuses, errorCode, endedAt)
        if (!failed) return
        assertOutboxCapacity(database)
        const mutation = syncMutationSchema.parse(messageMutation(failed.message))
        insertOutbox(database, mutation)
        bumpConversationActivity(
          failed.job.conversationId,
          mutation.baseRevision + 1,
          endedAt,
        )
        recomputeAffectedConversations(database, ownerUserId, [mutation])
      })
      return failed
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
      const mutation = messageMutation(value.userMessage)
      return recordMutation(mutation, () => {
        repositories.chatRuns.startMediaGeneration({
          ...value,
          run: { ...value.run, userId: ownerUserId },
        })
        database.prepare(`
          UPDATE conversations
          SET revision = @revision,
              last_activity_at = MAX(last_activity_at + 1, @createdAt),
              updated_at = MAX(updated_at, last_activity_at + 1, @createdAt),
              sync_state = 'pending'
          WHERE id = @conversationId AND user_id = @ownerUserId
        `).run({
          conversationId: value.userMessage.conversationId,
          ownerUserId,
          revision: mutation.baseRevision + 1,
          createdAt: value.userMessage.createdAt,
        })
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
      const existing = messages.get(messageId)
      if (!existing) throw new UserDataConsistencyError()
      const finalizedAt = value.endedAt
      if (finalizedAt === undefined && exactConversionBlocks(value.blocks).length > 0) {
        throw new UserDataConsistencyError()
      }
      const mutation = parsePersisted(() => messageMutation({ ...existing, blocks: value.blocks }))
      let finalized: ReturnType<AppRepositories['chatRuns']['finalizeWithMessage']> | undefined
      recordMutation(mutation, () => {
        finalizeConversionBindings(
          database,
          ownerUserId,
          existing,
          value.blocks,
          finalizedAt ?? 0,
        )
        finalized = repositories.chatRuns.finalizeWithMessage(id, messageId, requestId, value)
        database.prepare(`
          UPDATE conversations
          SET revision = @revision,
              last_activity_at = MAX(last_activity_at + 1, @createdAt),
              updated_at = MAX(updated_at, last_activity_at + 1, @createdAt), sync_state = 'pending'
          WHERE id = @conversationId AND user_id = @ownerUserId
        `).run({
          conversationId: existing.conversationId,
          ownerUserId,
          revision: mutation.baseRevision + 1,
          createdAt: existing.createdAt,
        })
      })
      if (!finalized) throw new UserDataConsistencyError()
      return finalized
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
  const conversionBlockBindings: UserDataRepositories['conversionBlockBindings'] = {
    get(requestedOwnerUserId, executionId) {
      assertStoredOwner(requestedOwnerUserId, ownerUserId)
      const validatedExecutionId = parsePersisted(() => z.string().trim().min(1).max(128).parse(executionId))
      return storedConversionBlockBinding(database, ownerUserId, validatedExecutionId)
    },
    listRecoverable(requestedOwnerUserId) {
      assertStoredOwner(requestedOwnerUserId, ownerUserId)
      return (database.prepare(`
        SELECT owner_user_id AS ownerUserId, conversation_id AS conversationId,
               message_id AS messageId, block_id AS blockId, execution_id AS executionId,
               finalized_at AS finalizedAt, consumed_at AS consumedAt,
               retired_at AS retiredAt, retirement_reason AS retirementReason
        FROM conversion_block_bindings
        WHERE owner_user_id = @ownerUserId
          AND consumed_at IS NULL AND retired_at IS NULL
        ORDER BY execution_id
      `).all({ ownerUserId }) as Query[]).map(conversionBlockBindingFromRow)
    },
    retire(requestedOwnerUserId, executionId, reason, retiredAt) {
      assertStoredOwner(requestedOwnerUserId, ownerUserId)
      const validated = parsePersisted(() => z.object({
        executionId: z.string().trim().min(1).max(128),
        reason: z.enum(['missing_execution', 'missing_message', 'invalid_binding']),
        retiredAt: z.number().int().nonnegative(),
      }).strict().parse({ executionId, reason, retiredAt }))
      return transaction(database, () => database.prepare(`
        UPDATE conversion_block_bindings
        SET retired_at = @retiredAt, retirement_reason = @reason
        WHERE owner_user_id = @ownerUserId AND execution_id = @executionId
          AND consumed_at IS NULL AND retired_at IS NULL
      `).run({ ownerUserId, ...validated }).changes === 1)
    },
  }
  function recordMutation(
    mutationInput: SyncMutation,
    optimisticWrite?: (mutation: SyncMutation) => void,
  ): void {
    const mutation = parsePersisted(() => syncMutationSchema.parse(mutationInput))
    transaction(database, () => {
      assertOutboxCapacity(database)
      optimisticWrite?.(mutation)
      insertOutbox(database, mutation)
      recomputeAffectedConversations(database, ownerUserId, [mutation])
    })
  }
  function bumpConversationActivity(
    conversationId: string,
    revision: number,
    occurredAt: number,
  ): void {
    database.prepare(`
      UPDATE conversations
      SET revision = @revision,
          last_activity_at = MAX(last_activity_at + 1, @occurredAt),
          updated_at = MAX(updated_at, last_activity_at + 1, @occurredAt),
          sync_state = 'pending'
      WHERE id = @conversationId AND user_id = @ownerUserId
    `).run({ conversationId, ownerUserId, revision, occurredAt })
  }
  return {
    conversations,
    messages,
    conversationContexts,
    mediaAssets,
    mediaGenerationJobs,
    chatRuns,
    providerUsage,
    conversionBlockBindings,
    account: {
      getConsent: (purpose) => storedConsent(database, purpose),
      getPreferences: () => storedPreferences(database),
      projectPreferences(preferences) {
        const value = accountDataPreferencesRecordSchema.parse(preferences)
        projectPreferences(database, value, value.revision, value.updatedAt)
      },
      resolveLegacyImportBatch(input) {
        const value = parsePersisted(() => z.object({
          selectionFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
          includeUnowned: z.boolean(),
          cloudConsentVersion: z.string().trim().min(1).max(128),
          unownedConsentVersion: z.string().trim().min(1).max(128).optional(),
          candidateBatchId: z.string().trim().min(1).max(128),
        }).strict().parse(input))
        return transaction(database, () => {
          database.prepare(`
            INSERT INTO legacy_import_identity(
              selection_fingerprint, include_unowned, cloud_consent_version,
              unowned_consent_version, batch_id, updated_at
            ) VALUES (
              @selectionFingerprint, @includeUnowned, @cloudConsentVersion,
              @unownedConsentVersion, @candidateBatchId, @updatedAt
            )
            ON CONFLICT(
              selection_fingerprint, include_unowned, cloud_consent_version,
              unowned_consent_version
            ) DO NOTHING
          `).run({
            ...value,
            includeUnowned: Number(value.includeUnowned),
            unownedConsentVersion: value.unownedConsentVersion ?? '',
            updatedAt: Date.now(),
          })
          const stored = database.prepare(`
            SELECT batch_id AS batchId
            FROM legacy_import_identity
            WHERE selection_fingerprint = @selectionFingerprint
              AND include_unowned = @includeUnowned
              AND cloud_consent_version = @cloudConsentVersion
              AND unowned_consent_version = @unownedConsentVersion
          `).get({
            selectionFingerprint: value.selectionFingerprint,
            includeUnowned: Number(value.includeUnowned),
            cloudConsentVersion: value.cloudConsentVersion,
            unownedConsentVersion: value.unownedConsentVersion ?? '',
          }) as Query
          return z.string().trim().min(1).max(128).parse(stored.batchId)
        })
      },
    },
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
      record: (mutation) => recordMutation(mutation),
      recordWithConversation: (mutation) => recordMutation(
        mutation,
        (validated) => optimisticConversationMutation(database, ownerUserId, validated),
      ),
      recordWithMessage: (mutation, assetIds = []) => recordMutation(
        mutation,
        (validated) => {
          if (validated.kind !== 'message.append') throw new Error('Message mutation required')
          if (assetIds.length === 0) {
            optimisticMessageMutation(database, ownerUserId, validated)
            return
          }
          const payload = validated.payload
          repositories.messages.insertWithAssets({
            id: payload.id,
            conversationId: payload.conversationId,
            role: payload.role,
            blocks: payload.blocks,
            ...(payload.providerProjection === undefined
              ? {}
              : { providerProjection: payload.providerProjection }),
            ...(payload.executionId === undefined ? {} : { executionId: payload.executionId }),
            createdAt: timestamp(payload.createdAt),
          }, [...assetIds])
          database.prepare(`
            UPDATE conversations
            SET revision = @revision,
                last_activity_at = MAX(last_activity_at + 1, @createdAt),
                updated_at = MAX(updated_at, last_activity_at + 1, @createdAt), sync_state = 'pending'
            WHERE id = @conversationId AND user_id = @ownerUserId
          `).run({
            conversationId: payload.conversationId,
            ownerUserId,
            revision: validated.baseRevision + 1,
            createdAt: timestamp(payload.createdAt),
          })
        },
      ),
      recordWithConsent: (mutation) => recordMutation(
        mutation,
        (validated) => {
          if (validated.kind !== 'privacy.consent') throw new UserDataConsistencyError()
          projectConsent(database, validated.payload)
        },
      ),
      recordWithPreferences: (mutation) => recordMutation(
        mutation,
        (validated) => {
          if (validated.kind !== 'preferences.update') throw new UserDataConsistencyError()
          projectPreferences(
            database,
            validated.payload,
            validated.baseRevision + 1,
            validated.occurredAt,
          )
        },
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
          WHERE (state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= @now))
            OR (state = 'failed' AND next_attempt_at IS NOT NULL AND next_attempt_at <= @now)
          ORDER BY enqueue_sequence
          LIMIT @limit
        `).all({ now, limit }) as Query[]).map(outboxFromRow)
      },
      find(id) {
        return findOutboxMutation(database, id)
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
          ORDER BY enqueue_sequence
          LIMIT @limit
        `).all({ limit }) as Query[]).map(outboxFromRow)
      },
      countPending: (kind) => ((
        kind === undefined
          ? database.prepare('SELECT COUNT(*) AS count FROM outbox_mutations').get()
          : database.prepare('SELECT COUNT(*) AS count FROM outbox_mutations WHERE kind = @kind')
            .get({ kind })
      ) as { count: number }).count,
      oldestPendingOrFailedAt() {
        const result = database.prepare(`
          SELECT MIN(created_at) AS oldest
          FROM outbox_mutations
          WHERE state IN ('pending', 'syncing', 'failed')
        `).get() as { oldest: number | null }
        return result.oldest ?? undefined
      },
      markSyncing(ids) {
        transaction(database, () => {
          const mutations = ids.map((id) => findOutboxMutation(database, id))
            .filter((mutation): mutation is OutboxMutationRecord => mutation !== undefined)
          const update = database.prepare(`
            UPDATE outbox_mutations
            SET state = 'syncing', attempts = attempts + 1, last_error_code = NULL
            WHERE id = @id AND state IN ('pending', 'failed')
          `)
          for (const id of ids) update.run({ id })
          recomputeAffectedConversations(database, ownerUserId, mutations)
        })
      },
      markPending(id, nextAttemptAt) {
        transaction(database, () => {
          const local = findOutboxMutation(database, id)
          database.prepare(`
            UPDATE outbox_mutations
            SET state = 'pending', next_attempt_at = @nextAttemptAt, last_error_code = NULL
            WHERE id = @id
          `).run({ id, nextAttemptAt: nextAttemptAt ?? null })
          if (local) recomputeAffectedConversations(database, ownerUserId, [local])
        })
      },
      markFailed(id, errorCode, nextAttemptAt) {
        const validatedErrorCode = parsePersisted(() => appErrorCodeSchema.parse(errorCode))
        transaction(database, () => {
          const local = findOutboxMutation(database, id)
          database.prepare(`
            UPDATE outbox_mutations
            SET state = 'failed', next_attempt_at = @nextAttemptAt, last_error_code = @errorCode
            WHERE id = @id
          `).run({ id, errorCode: validatedErrorCode, nextAttemptAt: nextAttemptAt ?? null })
          if (local) recomputeAffectedConversations(database, ownerUserId, [local])
        })
      },
      acknowledgePushResults(sent, results) {
        return acknowledgePushResults(database, ownerUserId, sent, results)
      },
      retryFailed(entityId) {
        const validatedEntityId = entityId === undefined
          ? undefined
          : parsePersisted(() => z.string().trim().min(1).parse(entityId))
        return transaction(database, () => {
          const retryable = (database.prepare(`
            SELECT id, kind, entity_id AS entityId, base_revision AS baseRevision,
                   payload_json AS payloadJson, state, attempts,
                   next_attempt_at AS nextAttemptAt, last_error_code AS lastErrorCode,
                   occurred_at AS occurredAt, created_at AS createdAt
            FROM outbox_mutations
            WHERE state IN ('pending', 'failed')
            ORDER BY enqueue_sequence
          `).all() as Query[]).map(outboxFromRow).filter((mutation) => (
            validatedEntityId === undefined
              || mutation.entityId === validatedEntityId
              || affectedConversationId(mutation, database) === validatedEntityId
          ))
          const update = database.prepare(`
            UPDATE outbox_mutations
            SET state = 'pending', next_attempt_at = NULL, last_error_code = NULL
            WHERE id = @id AND state IN ('pending', 'failed')
          `)
          for (const mutation of retryable) {
            update.run({ id: mutation.id })
          }
          recomputeAffectedConversations(database, ownerUserId, retryable)
          return retryable.map(({ id }) => id)
        })
      },
      delete(id) {
        transaction(database, () => {
          const local = findOutboxMutation(database, id)
          database.prepare('DELETE FROM outbox_mutations WHERE id = @id').run({ id })
          if (local) recomputeAffectedConversations(database, ownerUserId, [local])
        })
      },
    },
  }
}
