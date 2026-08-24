import {
  chatBlockSchema,
  legacyImportConfirmRequestSchema,
  legacyImportPreviewSchema,
  toSafeAppError,
  type LegacyImportConfirmRequest,
  type LegacyImportPreview,
  type LegacyImportResult,
} from '@autoforge/shared'
import { createHash } from 'node:crypto'
import type { AppRepositories, Conversation } from '../database/repositories.js'
import type { UserDataBindingToken } from './user-data-sync-engine.js'

const MAX_BATCH_RECORDS = 100

export interface LegacyImportBatchRequest extends LegacyImportConfirmRequest {
  conversations: Array<{
    id: string
    title: string
    titleState: 'pending' | 'generating' | 'ai_named' | 'user_named' | 'failed'
    createdAt: string
    lastActivityAt: string
    metadataUpdatedAt: string
    sourceUnowned?: boolean
  }>
  messages: Array<{
    id: string
    conversationId: string
    role: 'user' | 'assistant'
    blocks: ReturnType<typeof chatBlockSchema.array>['_output']
    executionId?: string
    createdAt: string
    sourceUnowned?: boolean
  }>
}

export type LegacyImportBatchResult = LegacyImportResult

interface LegacyImportCoordinator {
  captureBinding(userId: string): UserDataBindingToken
  canImportLegacyBatch(expected: UserDataBindingToken, input: LegacyImportBatchRequest): boolean
  importLegacyBatch(
    expected: UserDataBindingToken,
    input: LegacyImportBatchRequest,
  ): Promise<LegacyImportBatchResult>
}

type LegacyRepositories = Pick<AppRepositories, 'conversations' | 'messages'>

function identity(batchId: string, kind: 'conversation' | 'message', legacyId: string): string {
  const digest = createHash('sha256').update(`${batchId}\0${kind}\0${legacyId}`).digest('hex')
  return `legacy_${digest.slice(0, 32)}`
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString()
}

function selectedConversations(rows: readonly Conversation[], userId: string, includeUnowned: boolean) {
  return rows.filter((row) => row.userId === userId || (includeUnowned && row.userId === undefined))
}

export class LegacyUserDataImporter {
  constructor(
    private readonly legacy: LegacyRepositories,
    private readonly coordinator: LegacyImportCoordinator,
  ) {}

  preview(userId: string): LegacyImportPreview {
    const rows = this.legacy.conversations.list()
    const ownedCount = rows.filter((row) => row.userId === userId).length
    const unownedCount = rows.filter((row) => row.userId === undefined).length
    return legacyImportPreviewSchema.parse({
      ownedCount, unownedCount, requiresUnownedConfirmation: unownedCount > 0,
    })
  }

  selectionFingerprint(userId: string, includeUnowned: boolean): string {
    const conversations = selectedConversations(
      this.legacy.conversations.list(), userId, includeUnowned,
    ).sort((left, right) => left.id.localeCompare(right.id))
    const selected = conversations.map((conversation) => ({
      conversation,
      messages: this.legacy.messages.listForConversation(conversation.id)
        .sort((left, right) => left.id.localeCompare(right.id)),
    }))
    return createHash('sha256').update(JSON.stringify(selected)).digest('hex')
  }

  async import(userId: string, input: LegacyImportConfirmRequest): Promise<LegacyImportBatchResult[]> {
    const confirmation = legacyImportConfirmRequestSchema.safeParse(input)
    if (!confirmation.success) throw toSafeAppError({ code: 'IMPORT_CONFIRMATION_REQUIRED' })
    const binding = this.coordinator.captureBinding(userId)
    const conversations = selectedConversations(
      this.legacy.conversations.list(), userId, confirmation.data.includeUnowned,
    )
    const conversationIds = new Map(conversations.map((row) => [
      row.id, identity(confirmation.data.batchId, 'conversation', row.id),
    ]))
    const records: Array<
      | { type: 'conversation'; value: LegacyImportBatchRequest['conversations'][number] }
      | { type: 'message'; value: LegacyImportBatchRequest['messages'][number] }
    > = []
    for (const row of conversations) {
      const messages = this.legacy.messages.listForConversation(row.id)
      const sourceUnowned = row.userId === undefined
      records.push({
        type: 'conversation',
        value: {
          id: conversationIds.get(row.id)!, title: row.title, titleState: row.titleState,
          createdAt: iso(row.createdAt),
          lastActivityAt: iso(messages.reduce(
            (latest, message) => Math.max(latest, message.createdAt),
            Math.max(row.createdAt, row.updatedAt),
          )),
          metadataUpdatedAt: iso(row.updatedAt), ...(sourceUnowned ? { sourceUnowned: true } : {}),
        },
      })
    }
    for (const conversation of conversations) {
      const sourceUnowned = conversation.userId === undefined
      for (const row of this.legacy.messages.listForConversation(conversation.id)) {
        records.push({
          type: 'message',
          value: {
            id: identity(confirmation.data.batchId, 'message', row.id),
            conversationId: conversationIds.get(row.conversationId)!,
            role: row.role === 'user' ? 'user' : 'assistant',
            blocks: chatBlockSchema.array().parse(row.blocks),
            ...(row.executionId === undefined ? {} : { executionId: row.executionId }),
            createdAt: iso(row.createdAt), ...(sourceUnowned ? { sourceUnowned: true } : {}),
          },
        })
      }
    }

    const batches: LegacyImportBatchRequest[] = []
    for (const record of records) {
      let batch = batches.at(-1)
      if (!batch) {
        batch = this.emptyBatch(confirmation.data, 0)
        batches.push(batch)
      }
      const append = (target: LegacyImportBatchRequest) => {
        if (record.type === 'conversation') target.conversations.push(record.value)
        else target.messages.push(record.value)
      }
      const candidate = structuredClone(batch)
      append(candidate)
      const count = candidate.conversations.length + candidate.messages.length
      if (count > MAX_BATCH_RECORDS
        || !this.coordinator.canImportLegacyBatch(binding, candidate)) {
        batch = this.emptyBatch(confirmation.data, batches.length)
        batches.push(batch)
        append(batch)
        if (!this.coordinator.canImportLegacyBatch(binding, batch)) {
          throw toSafeAppError({ code: 'INVALID_INPUT' })
        }
      } else {
        append(batch)
      }
    }
    const results: LegacyImportBatchResult[] = []
    for (const batch of batches) {
      const result = await this.coordinator.importLegacyBatch(binding, batch)
      if (result.status === 'rejected') {
        throw toSafeAppError({ code: result.errorCode ?? 'SYNC_CONFLICT' })
      }
      results.push(result)
    }
    return results
  }

  private emptyBatch(
    confirmation: LegacyImportConfirmRequest,
    index: number,
  ): LegacyImportBatchRequest {
    return {
      ...confirmation,
      batchId: `${confirmation.batchId}-${index}`,
      conversations: [],
      messages: [],
    }
  }
}
