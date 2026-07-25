import type Database from 'better-sqlite3'
import { z } from 'zod'
import {
  appErrorCodeSchema,
  chatBlockSchema,
  conversationGenerationPreferencesSchema,
  type AppErrorCode,
  type ChatBlock,
  type ConversationGenerationPreferences,
  type MediaKind,
} from '@autoforge/shared'
import { redact } from '../security/redaction.js'

export interface Conversation {
  id: string
  title: string
  generationPreferences?: ConversationGenerationPreferences
  createdAt: number
  updatedAt: number
}

export interface Message {
  id: string
  conversationId: string
  role: string
  blocks: unknown[]
  executionId?: string
  createdAt: number
}

export interface ChatRun {
  id: string
  conversationId: string
  requestId: string
  model: string
  status: string
  generationId?: string
  inputTokens?: number
  outputTokens?: number
  costUsd?: string
  errorCode?: string
  startedAt: number
  endedAt?: number
}

export interface WorkflowProject {
  id: string
  name: string
  rootPath: string
  manifest?: unknown
  status: string
  buildHash?: string
  lastError?: string
  createdAt: number
  updatedAt: number
}

export interface InstalledWorkflow {
  workflowId: string
  version: string
  name: string
  description: string
  author: string
  category: string
  manifest: unknown
  installPath: string
  enabled: boolean
  integrityStatus: string
  source: string
  installedAt: number
  updatedAt: number
}

export interface WorkflowFile {
  workflowId: string
  workflowVersion: string
  path: string
  sha256: string
}

export interface Execution {
  id: string
  workflowId: string
  workflowVersion: string
  chatRunId?: string
  status: string
  input: unknown
  result?: unknown
  errorCode?: string
  createdAt: number
  startedAt?: number
  endedAt?: number
}

export interface ExecutionStep {
  id: string
  executionId: string
  sequence: number
  name: string
  status: string
  percent?: number
  startedAt?: number
  endedAt?: number
}

export interface ExecutionLog {
  id: string
  executionId: string
  sequence: number
  level: string
  message: string
  metadata?: unknown
  createdAt: number
}

export type ExecutionLogInput = ExecutionLog & { sensitivePaths?: readonly string[] }

export interface PermissionGrant {
  id: string
  workflowId: string
  workflowVersion: string
  capability: string
  scope: unknown
  scopeHash: string
  createdAt: number
  updatedAt: number
}

export interface AppSetting {
  key: string
  value: unknown
  updatedAt: number
}

export interface EncryptedSecret {
  key: string
  ciphertextBase64: string
  updatedAt: number
}

export type MediaAssetSource = 'upload' | 'generated'
export type MediaAssetStatus = 'staging' | 'ready' | 'failed' | 'deleting'

export interface MediaAssetRecord {
  id: string
  conversationId: string
  messageId?: string
  source: MediaAssetSource
  kind: MediaKind
  mimeType?: string
  originalName: string
  relativePath?: string
  byteSize?: number
  width?: number
  height?: number
  durationMs?: number
  sha256?: string
  provider?: string
  model?: string
  status: MediaAssetStatus
  createdAt: number
  updatedAt: number
}

export type MediaAssetPatch = Partial<Omit<MediaAssetRecord, 'id' | 'conversationId' | 'messageId' | 'createdAt'>>

export type MediaGenerationJobStatus = 'pending' | 'in_progress' | 'downloading' | 'paused' | 'completed' | 'failed'

export interface MediaGenerationJob {
  id: string
  conversationId: string
  assistantMessageId: string
  provider: string
  model: string
  kind: 'video'
  providerJobId: string
  status: MediaGenerationJobStatus
  parameters: unknown
  nextPollAt?: number
  pollAttempts?: number
  errorCode?: string
  assetId?: string
  createdAt: number
  updatedAt: number
  endedAt?: number
}

export type MediaGenerationJobPatch = Partial<Omit<MediaGenerationJob, 'id' | 'conversationId' | 'assistantMessageId' | 'provider' | 'model' | 'kind' | 'providerJobId' | 'createdAt'>>
export type MessageInput = Omit<Message, 'executionId'> & { executionId?: string }

export interface VideoGenerationTurnInput {
  userMessage: MessageInput
  userAssetIds: string[]
  assistantMessage: MessageInput
  run: Omit<ChatRun, 'generationId' | 'inputTokens' | 'outputTokens' | 'costUsd' | 'errorCode' | 'endedAt'>
  job: MediaGenerationJob
}

export type VideoGenerationTurnPreflightInput = Omit<VideoGenerationTurnInput, 'job'> & {
  job: Omit<MediaGenerationJob, 'providerJobId'>
}

export interface VideoGenerationTransitionPatch {
  status: MediaGenerationJobStatus
  parameters?: unknown
  nextPollAt?: number | null
  pollAttempts?: number
  updatedAt: number
}

export interface VideoGenerationTransition {
  job: MediaGenerationJob
  message: Message
  block: Extract<ChatBlock, { type: 'media_generation' }>
}

export interface VideoGenerationCompletion {
  job: MediaGenerationJob
  message: Message
  block: Extract<ChatBlock, { type: 'media' }>
}

export interface CompleteVideoGenerationInput {
  assetId: string
  block: Extract<ChatBlock, { type: 'media' }>
  endedAt: number
  generationId?: string
  costUsd?: string
}

const identifierSchema = z.string().trim().min(1)
const nonnegativeIntegerSchema = z.number().finite().int().nonnegative()
const positiveIntegerSchema = z.number().finite().int().positive()
const mediaAssetRecordShape = {
  id: identifierSchema,
  conversationId: identifierSchema,
  messageId: identifierSchema.optional(),
  source: z.enum(['upload', 'generated']),
  kind: z.enum(['image', 'audio', 'video']),
  mimeType: z.string().trim().min(1).optional(),
  originalName: z.string().trim().min(1),
  relativePath: z.string().trim().min(1).optional(),
  byteSize: nonnegativeIntegerSchema.optional(),
  width: positiveIntegerSchema.optional(),
  height: positiveIntegerSchema.optional(),
  durationMs: nonnegativeIntegerSchema.optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  provider: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  status: z.enum(['staging', 'ready', 'failed', 'deleting']),
  createdAt: nonnegativeIntegerSchema,
  updatedAt: nonnegativeIntegerSchema,
}

const mediaAssetRecordSchema = z.object(mediaAssetRecordShape).strict().superRefine((asset, context) => {
  if (asset.status !== 'ready') return
  for (const field of ['relativePath', 'mimeType', 'byteSize', 'sha256'] as const) {
    if (asset[field] === undefined) context.addIssue({ code: 'custom', path: [field], message: 'Ready media assets require complete file metadata' })
  }
})

const mediaAssetPatchSchema = z.object({
  source: mediaAssetRecordShape.source,
  kind: mediaAssetRecordShape.kind,
  mimeType: mediaAssetRecordShape.mimeType,
  originalName: mediaAssetRecordShape.originalName,
  relativePath: mediaAssetRecordShape.relativePath,
  byteSize: mediaAssetRecordShape.byteSize,
  width: mediaAssetRecordShape.width,
  height: mediaAssetRecordShape.height,
  durationMs: mediaAssetRecordShape.durationMs,
  sha256: mediaAssetRecordShape.sha256,
  provider: mediaAssetRecordShape.provider,
  model: mediaAssetRecordShape.model,
  status: mediaAssetRecordShape.status,
  updatedAt: mediaAssetRecordShape.updatedAt,
}).partial().strict()

type Query = Record<string, unknown>
type SqliteDatabase = Database.Database

function now(): number {
  return Date.now()
}

function parse(value: string | null): unknown | undefined {
  return value === null ? undefined : JSON.parse(value)
}

function transaction<T>(database: SqliteDatabase, operation: () => T): T {
  return database.transaction(operation)()
}

function one<T>(database: SqliteDatabase, sql: string, parameters: Query): T | undefined {
  return database.prepare(sql).get(parameters) as T | undefined
}

function many<T>(database: SqliteDatabase, sql: string, parameters: Query = {}): T[] {
  return database.prepare(sql).all(parameters) as T[]
}

export interface EncryptedSecretsRepository {
  get(key: string): EncryptedSecret | undefined
  set(key: string, ciphertextBase64: string): void
  delete(key: string): void
  raw(key: string): string | undefined
}

export interface AppRepositories {
  conversations: {
    insert(value: Pick<Conversation, 'id' | 'title'> & Partial<Pick<Conversation, 'createdAt' | 'updatedAt'>>): Conversation
    get(id: string): Conversation | undefined
    list(): Conversation[]
    update(id: string, value: Partial<Pick<Conversation, 'title' | 'updatedAt'>>): Conversation | undefined
    updateGenerationPreferences(id: string, preferences: ConversationGenerationPreferences): Conversation | undefined
    delete(id: string): void
  }
  messages: {
    insert(value: MessageInput): Message
    insertWithAssets(value: MessageInput, assetIds: string[]): Message
    get(id: string): Message | undefined
    listForConversation(conversationId: string): Message[]
    update(id: string, value: Partial<Pick<Message, 'blocks' | 'executionId'>>): Message | undefined
    replaceBlock(messageId: string, blockId: string, replacement: unknown): Message
    failInterruptedMediaGenerations(): number
  }
  mediaAssets: { insert(value: MediaAssetRecord): MediaAssetRecord; get(id: string): MediaAssetRecord | undefined; listForConversation(conversationId: string): MediaAssetRecord[]; listUnclaimedBefore(timestamp: number): MediaAssetRecord[]; update(id: string, patch: MediaAssetPatch): MediaAssetRecord | undefined; delete(id: string): void }
  mediaGenerationJobs: {
    insert(value: MediaGenerationJob): MediaGenerationJob
    preflightTurn(value: VideoGenerationTurnPreflightInput): void
    insertTurn(value: VideoGenerationTurnInput): MediaGenerationJob
    get(id: string): MediaGenerationJob | undefined
    reconcileInterrupted(endedAt: number): string[]
    listResumable(now: number): MediaGenerationJob[]
    listActive(): MediaGenerationJob[]
    update(id: string, patch: MediaGenerationJobPatch): MediaGenerationJob | undefined
    transition(
      id: string,
      expectedStatuses: MediaGenerationJobStatus[],
      patch: VideoGenerationTransitionPatch,
    ): VideoGenerationTransition | undefined
    complete(
      id: string,
      expectedStatuses: MediaGenerationJobStatus[],
      input: CompleteVideoGenerationInput,
    ): VideoGenerationCompletion | undefined
    fail(
      id: string,
      expectedStatuses: MediaGenerationJobStatus[],
      errorCode: AppErrorCode,
      endedAt: number,
    ): VideoGenerationTransition | undefined
  }
  chatRuns: {
    insert(value: Omit<ChatRun, 'generationId' | 'inputTokens' | 'outputTokens' | 'costUsd' | 'errorCode' | 'endedAt'> & Partial<Pick<ChatRun, 'generationId' | 'inputTokens' | 'outputTokens' | 'costUsd' | 'errorCode' | 'endedAt'>>): ChatRun
    get(id: string): ChatRun | undefined
    update(id: string, value: Partial<Omit<ChatRun, 'id' | 'conversationId' | 'requestId' | 'model' | 'startedAt'>>): ChatRun | undefined
    finalizeWithMessage(
      id: string,
      messageId: string,
      requestId: string,
      value: Pick<ChatRun, 'status' | 'endedAt'> & Partial<Pick<ChatRun, 'generationId' | 'inputTokens' | 'outputTokens' | 'costUsd' | 'errorCode'>> & { blocks: unknown[] },
    ): ChatRun
  }
  workflowProjects: { insert(value: WorkflowProject): WorkflowProject; get(id: string): WorkflowProject | undefined; list(): WorkflowProject[]; update(id: string, value: Partial<Omit<WorkflowProject, 'id' | 'createdAt'>>): WorkflowProject | undefined }
  installedWorkflows: { insert(value: InstalledWorkflow, files: WorkflowFile[]): InstalledWorkflow; upsert(value: InstalledWorkflow): InstalledWorkflow; get(workflowId: string, version: string): InstalledWorkflow | undefined; list(): InstalledWorkflow[]; setEnabled(workflowId: string, version: string, enabled: boolean): void; delete(workflowId: string, version: string): void }
  workflowFiles: { insert(value: WorkflowFile): WorkflowFile; list(workflowId: string, workflowVersion: string): WorkflowFile[] }
  executions: {
    insert(value: Pick<Execution, 'id' | 'status' | 'workflowId' | 'workflowVersion'> & Partial<Omit<Execution, 'id' | 'status' | 'workflowId' | 'workflowVersion'>>): Execution
    get(id: string): Execution | undefined
    list(): Execution[]
    update(id: string, value: Partial<Omit<Execution, 'id' | 'workflowId' | 'workflowVersion' | 'createdAt'>>): Execution | undefined
    markInterrupted(): number
  }
  executionSteps: { insert(value: ExecutionStep): ExecutionStep; list(executionId: string): ExecutionStep[] }
  executionLogs: { insert(value: ExecutionLogInput): ExecutionLog; list(executionId: string): ExecutionLog[] }
  permissionGrants: { upsert(value: PermissionGrant): PermissionGrant; get(workflowId: string, workflowVersion: string, capability: string, scopeHash: string): PermissionGrant | undefined; list(): PermissionGrant[]; delete(id: string): void }
  appSettings: { get(key: string): AppSetting | undefined; set(key: string, value: unknown): AppSetting; delete(key: string): void }
  encryptedSecrets: EncryptedSecretsRepository
}

const conversationColumns = 'id, title, generation_preferences_json AS generationPreferencesJson, created_at AS createdAt, updated_at AS updatedAt'
const messageColumns = 'id, conversation_id AS conversationId, role, blocks_json AS blocksJson, execution_id AS executionId, created_at AS createdAt'
const mediaAssetColumns = 'id, conversation_id AS conversationId, message_id AS messageId, source, kind, mime_type AS mimeType, original_name AS originalName, relative_path AS relativePath, byte_size AS byteSize, width, height, duration_ms AS durationMs, sha256, provider, model, status, created_at AS createdAt, updated_at AS updatedAt'
const mediaGenerationJobColumns = 'id, conversation_id AS conversationId, assistant_message_id AS assistantMessageId, provider, model, kind, provider_job_id AS providerJobId, status, parameters_json AS parametersJson, next_poll_at AS nextPollAt, poll_attempts AS pollAttempts, error_code AS errorCode, asset_id AS assetId, created_at AS createdAt, updated_at AS updatedAt, ended_at AS endedAt'
const chatRunColumns = 'id, conversation_id AS conversationId, request_id AS requestId, model, status, generation_id AS generationId, input_tokens AS inputTokens, output_tokens AS outputTokens, cost_usd AS costUsd, error_code AS errorCode, started_at AS startedAt, ended_at AS endedAt'
const projectColumns = 'id, name, root_path AS rootPath, manifest_json AS manifestJson, status, build_hash AS buildHash, last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt'
const installedWorkflowColumns = 'workflow_id AS workflowId, version, name, description, author, category, manifest_json AS manifestJson, install_path AS installPath, enabled, integrity_status AS integrityStatus, source, installed_at AS installedAt, updated_at AS updatedAt'
const executionColumns = 'id, workflow_id AS workflowId, workflow_version AS workflowVersion, chat_run_id AS chatRunId, status, input_json AS inputJson, result_json AS resultJson, error_code AS errorCode, created_at AS createdAt, started_at AS startedAt, ended_at AS endedAt'

function messageFromRow(row: Query): Message {
  return { ...row, blocks: parse(row.blocksJson as string) as unknown[] } as Message
}

function conversationFromRow(row: Query): Conversation {
  const preferences = parse(row.generationPreferencesJson as string | null)
  return {
    id: row.id as string,
    title: row.title as string,
    ...(preferences === undefined ? {} : { generationPreferences: conversationGenerationPreferencesSchema.parse(preferences) }),
    createdAt: row.createdAt as number,
    updatedAt: row.updatedAt as number,
  }
}

function optional<T>(value: unknown): T | undefined {
  return value === null || value === undefined ? undefined : value as T
}

function mediaAssetFromRow(row: Query): MediaAssetRecord {
  return mediaAssetRecordSchema.parse({
    id: row.id as string,
    conversationId: row.conversationId as string,
    messageId: optional<string>(row.messageId),
    source: row.source as MediaAssetSource,
    kind: row.kind as MediaKind,
    mimeType: optional<string>(row.mimeType),
    originalName: row.originalName as string,
    relativePath: optional<string>(row.relativePath),
    byteSize: optional<number>(row.byteSize),
    width: optional<number>(row.width),
    height: optional<number>(row.height),
    durationMs: optional<number>(row.durationMs),
    sha256: optional<string>(row.sha256),
    provider: optional<string>(row.provider),
    model: optional<string>(row.model),
    status: row.status as MediaAssetStatus,
    createdAt: row.createdAt as number,
    updatedAt: row.updatedAt as number,
  })
}

function mediaGenerationJobFromRow(row: Query): MediaGenerationJob {
  return {
    id: row.id as string,
    conversationId: row.conversationId as string,
    assistantMessageId: row.assistantMessageId as string,
    provider: row.provider as string,
    model: row.model as string,
    kind: row.kind as 'video',
    providerJobId: row.providerJobId as string,
    status: row.status as MediaGenerationJobStatus,
    parameters: parse(row.parametersJson as string),
    nextPollAt: optional<number>(row.nextPollAt),
    pollAttempts: row.pollAttempts as number,
    errorCode: optional<string>(row.errorCode),
    assetId: optional<string>(row.assetId),
    createdAt: row.createdAt as number,
    updatedAt: row.updatedAt as number,
    endedAt: optional<number>(row.endedAt),
  }
}

function assertMediaBlockMetadata(block: Extract<ChatBlock, { type: 'media' }>, asset: MediaAssetRecord): void {
  if (
    block.name !== asset.originalName
    || block.kind !== asset.kind
    || block.mimeType !== asset.mimeType
    || block.byteSize !== asset.byteSize
    || block.width !== asset.width
    || block.height !== asset.height
    || block.durationMs !== asset.durationMs
  ) throw new Error('Media block metadata must match the asset')
}

function claimReplacementMedia(
  database: SqliteDatabase,
  messageId: string,
  conversationId: string,
  previous: ChatBlock,
  replacement: Extract<ChatBlock, { type: 'media' }>,
  identity?: { requestId: string; model: string },
): void {
  if (
    !('blockId' in previous)
    || previous.blockId !== replacement.blockId
    || (
      previous.type === 'media_generation'
        ? previous.kind !== replacement.kind
        : previous.type !== 'media'
          || previous.purpose !== 'output'
          || previous.assetId !== replacement.assetId
    )
    || replacement.purpose !== 'output'
  ) throw new Error('Media output must replace its matching generation block')
  if (
    previous.type === 'media_generation'
    && !['pending', 'in_progress', 'downloading'].includes(previous.status)
  ) throw new Error('Media generation is not active')
  if (
    identity
    && previous.type === 'media_generation'
    && previous.jobId !== identity.requestId
  ) throw new Error('Media generation identity does not match')

  const row = one<Query>(database, `SELECT ${mediaAssetColumns} FROM media_assets WHERE id = @id`, {
    id: replacement.assetId,
  })
  if (!row) throw new Error('Media asset not found')
  const asset = mediaAssetFromRow(row)
  if (
    asset.conversationId !== conversationId
    || asset.source !== 'generated'
    || (identity !== undefined && asset.model !== identity.model)
    || asset.status !== 'ready'
    || (asset.messageId !== undefined && asset.messageId !== messageId)
  ) throw new Error('Media asset cannot be claimed')
  assertMediaBlockMetadata(replacement, asset)
  if (asset.messageId === messageId) return

  const claim = database.prepare("UPDATE media_assets SET message_id = @messageId, updated_at = @updatedAt WHERE id = @assetId AND conversation_id = @conversationId AND message_id IS NULL AND status = 'ready'")
  if (claim.run({
    messageId,
    assetId: replacement.assetId,
    conversationId,
    updatedAt: now(),
  }).changes !== 1) throw new Error('Media asset could not be claimed')
}

function assertUniqueFinalMediaBlocks(blocks: readonly ChatBlock[]): void {
  const blockIds = new Set<string>()
  const assetIds = new Set<string>()
  for (const block of blocks) {
    if ('blockId' in block) {
      if (blockIds.has(block.blockId)) throw new Error('Message block IDs must be unique')
      blockIds.add(block.blockId)
    }
    if (block.type === 'media') {
      if (assetIds.has(block.assetId)) throw new Error('Message media assets must be unique')
      assetIds.add(block.assetId)
    }
  }
}

function validateMessageWithAssets(
  database: SqliteDatabase,
  value: MessageInput,
  assetIds: readonly string[],
): ChatBlock[] {
  const blocks = chatBlockSchema.array().parse(value.blocks)
  const blockAssetIds = blocks
    .filter((block) => block.type === 'media')
    .map((block) => block.assetId)
  if (
    new Set(assetIds).size !== assetIds.length
    || new Set(blockAssetIds).size !== blockAssetIds.length
    || assetIds.length !== blockAssetIds.length
    || assetIds.some((assetId) => !blockAssetIds.includes(assetId))
  ) throw new Error('Media assets must exactly match message blocks')
  for (const assetId of assetIds) {
    const row = one<Query>(database, `SELECT ${mediaAssetColumns} FROM media_assets WHERE id = @id`, {
      id: assetId,
    })
    if (!row) throw new Error('Media asset not found')
    const asset = mediaAssetFromRow(row)
    if (
      asset.conversationId !== value.conversationId
      || asset.status !== 'ready'
      || asset.messageId !== undefined
    ) throw new Error('Media asset cannot be claimed')
    const block = blocks.find((candidate) => (
      candidate.type === 'media' && candidate.assetId === assetId
    ))
    if (!block || block.type !== 'media') throw new Error('Media block is missing')
    assertMediaBlockMetadata(block, asset)
  }
  return blocks
}

function insertMessageWithAssets(
  database: SqliteDatabase,
  value: MessageInput,
  assetIds: readonly string[],
): Message {
  const blocks = validateMessageWithAssets(database, value, assetIds)
  database.prepare('INSERT INTO messages (id, conversation_id, role, blocks_json, execution_id, created_at) VALUES (@id, @conversationId, @role, @blocksJson, @executionId, @createdAt)').run({
    ...value,
    blocksJson: JSON.stringify(blocks),
    executionId: value.executionId ?? null,
  })
  const claim = database.prepare("UPDATE media_assets SET message_id = @messageId, updated_at = @updatedAt WHERE id = @assetId AND message_id IS NULL AND status = 'ready'")
  for (const assetId of assetIds) {
    if (claim.run({
      messageId: value.id,
      assetId,
      updatedAt: now(),
    }).changes !== 1) throw new Error('Media asset could not be claimed')
  }
  return { ...value, blocks }
}

function validateVideoGenerationTurn(
  database: SqliteDatabase,
  value: VideoGenerationTurnPreflightInput,
  providerJobId?: string,
): ChatBlock[] {
  const { userMessage, userAssetIds, assistantMessage, run, job } = value
  const assistantBlocks = chatBlockSchema.array().parse(assistantMessage.blocks)
  const block = assistantBlocks[0]
  for (const id of [
    userMessage.id,
    assistantMessage.id,
    run.id,
    run.requestId,
    job.id,
    job.assistantMessageId,
  ]) identifierSchema.parse(id)
  identifierSchema.parse(job.provider)
  identifierSchema.parse(job.model)
  if (providerJobId !== undefined) identifierSchema.parse(providerJobId)
  if (
    userMessage.role !== 'user'
    || assistantMessage.role !== 'assistant'
    || userMessage.id === assistantMessage.id
    || userMessage.conversationId !== job.conversationId
    || assistantMessage.conversationId !== job.conversationId
    || run.conversationId !== job.conversationId
    || run.requestId !== job.id
    || run.model !== job.model
    || run.status !== 'running'
    || job.assistantMessageId !== assistantMessage.id
    || job.kind !== 'video'
    || (job.status !== 'pending' && job.status !== 'in_progress')
    || assistantBlocks.length !== 1
    || block?.type !== 'media_generation'
    || block.jobId !== job.id
    || block.kind !== 'video'
    || block.status !== job.status
    || block.errorCode !== undefined
  ) throw new Error('Video generation turn identity does not match')

  if (!one(database, 'SELECT id FROM conversations WHERE id = @id', {
    id: job.conversationId,
  })) throw new Error('Video generation conversation not found')
  if (one(database, 'SELECT id FROM messages WHERE id IN (@userMessageId, @assistantMessageId) LIMIT 1', {
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id,
  })) throw new Error('Video generation message ID already exists')
  if (one(database, 'SELECT id FROM chat_runs WHERE id = @id OR request_id = @requestId LIMIT 1', {
    id: run.id,
    requestId: run.requestId,
  })) throw new Error('Video generation run identity already exists')
  if (one(database, 'SELECT id FROM media_generation_jobs WHERE id = @id', {
    id: job.id,
  })) throw new Error('Video generation job already exists')

  validateMessageWithAssets(database, userMessage, userAssetIds)
  return assistantBlocks
}

function activeVideoBlock(
  database: SqliteDatabase,
  job: MediaGenerationJob,
): { message: Message; blocks: ChatBlock[]; index: number; block: Extract<ChatBlock, { type: 'media_generation' }> } {
  const row = one<Query>(database, `SELECT ${messageColumns} FROM messages WHERE id = @id`, {
    id: job.assistantMessageId,
  })
  if (!row || row.role !== 'assistant' || row.conversationId !== job.conversationId) {
    throw new Error('Video job assistant message not found')
  }
  const message = messageFromRow(row)
  const blocks = chatBlockSchema.array().parse(message.blocks)
  const index = blocks.findIndex((candidate) => (
    candidate.type === 'media_generation' && candidate.jobId === job.id
  ))
  const block = blocks[index]
  if (
    index === -1
    || !block
    || block.type !== 'media_generation'
    || block.kind !== 'video'
    || block.status !== job.status
  ) throw new Error('Video job block is not active')
  return { message, blocks, index, block }
}

function assertVideoTransition(
  from: MediaGenerationJobStatus,
  to: MediaGenerationJobStatus,
): void {
  if (from === to && (from === 'pending' || from === 'in_progress')) return
  const allowed = (
    (from === 'pending' && (to === 'in_progress' || to === 'paused' || to === 'failed'))
    || (from === 'in_progress' && (to === 'downloading' || to === 'paused' || to === 'failed'))
    || (from === 'downloading' && (to === 'completed' || to === 'failed'))
    || (from === 'paused' && to === 'pending')
  )
  if (!allowed) throw new Error('Invalid video job transition')
}

function updateVideoBlock(
  database: SqliteDatabase,
  messageId: string,
  blocks: ChatBlock[],
  index: number,
  replacement: ChatBlock,
): Message {
  blocks[index] = replacement
  if (database.prepare('UPDATE messages SET blocks_json = @blocksJson WHERE id = @id').run({
    id: messageId,
    blocksJson: JSON.stringify(blocks),
  }).changes !== 1) throw new Error('Video job assistant message not found')
  const row = one<Query>(database, `SELECT ${messageColumns} FROM messages WHERE id = @id`, {
    id: messageId,
  })
  if (!row) throw new Error('Video job assistant message not found')
  return messageFromRow(row)
}

function videoRun(database: SqliteDatabase, job: MediaGenerationJob): ChatRun {
  const run = one<ChatRun>(
    database,
    `SELECT ${chatRunColumns} FROM chat_runs WHERE request_id = @requestId`,
    { requestId: job.id },
  )
  if (
    !run
    || run.conversationId !== job.conversationId
    || run.model !== job.model
    || run.status !== 'running'
  ) throw new Error('Video chat run is not active')
  return run
}

interface ResumableVideoAssociation {
  messageId: string
  blockId: string
}

function resumableVideoAssociation(
  database: SqliteDatabase,
  job: MediaGenerationJob,
): ResumableVideoAssociation | undefined {
  if (
    job.kind !== 'video'
    || !['pending', 'in_progress', 'downloading', 'paused'].includes(job.status)
  ) return undefined
  const run = one<ChatRun>(
    database,
    `SELECT ${chatRunColumns} FROM chat_runs WHERE request_id = @requestId`,
    { requestId: job.id },
  )
  if (
    !run
    || run.conversationId !== job.conversationId
    || run.model !== job.model
    || run.status !== 'running'
  ) return undefined
  const row = one<Query>(database, `SELECT ${messageColumns} FROM messages WHERE id = @id`, {
    id: job.assistantMessageId,
  })
  if (!row || row.role !== 'assistant' || row.conversationId !== job.conversationId) {
    return undefined
  }
  try {
    const blocks = chatBlockSchema.array().parse(parse(row.blocksJson as string))
    const matches = blocks.filter((block) => (
      block.type === 'media_generation' && block.jobId === job.id
    ))
    const block = matches[0]
    if (
      matches.length !== 1
      || !block
      || block.type !== 'media_generation'
      || block.kind !== 'video'
      || block.status !== job.status
    ) return undefined
    return { messageId: job.assistantMessageId, blockId: block.blockId }
  } catch {
    return undefined
  }
}

function projectFromRow(row: Query): WorkflowProject {
  return { ...row, manifest: parse(row.manifestJson as string | null) } as WorkflowProject
}

function installedWorkflowFromRow(row: Query): InstalledWorkflow {
  return { ...row, enabled: Boolean(row.enabled), manifest: parse(row.manifestJson as string) } as InstalledWorkflow
}

function executionFromRow(row: Query): Execution {
  return { ...row, input: parse(row.inputJson as string), result: parse(row.resultJson as string | null) } as Execution
}

function permissionFromRow(row: Query): PermissionGrant {
  return { ...row, scope: parse(row.scopeJson as string) } as PermissionGrant
}

function redactLogMessage(message: string, sensitivePaths: readonly string[]): string {
  try {
    return JSON.stringify(redact(JSON.parse(message), sensitivePaths))
  } catch {
    const sensitiveKeys = sensitivePaths
      .map((path) => path.split('.').at(-1))
      .filter((key): key is string => Boolean(key))
      .map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const keys = ['authorization', 'cookie', 'x-api-key', 'api[_-]?key', '(?:access|refresh)?token', ...sensitiveKeys].join('|')
    return message.replace(new RegExp(`\\b(${keys})\\b\\s*([:=])\\s*(?:Bearer\\s+)?(?:"[^"]*"|'[^']*'|[^\\s,;]+)`, 'gi'), '$1$2[REDACTED]')
  }
}

export function createRepositories(database: SqliteDatabase): AppRepositories {
  return {
    conversations: {
      insert(value) {
        const createdAt = value.createdAt ?? now()
        const updatedAt = value.updatedAt ?? createdAt
        transaction(database, () => database.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (@id, @title, @createdAt, @updatedAt)').run({ ...value, createdAt, updatedAt }))
        return { id: value.id, title: value.title, createdAt, updatedAt }
      },
      get: (id) => { const row = one<Query>(database, `SELECT ${conversationColumns} FROM conversations WHERE id = @id`, { id }); return row && conversationFromRow(row) },
      list: () => many<Query>(database, `SELECT ${conversationColumns} FROM conversations ORDER BY updated_at DESC, id`).map(conversationFromRow),
      update(id, value) {
        const updatedAt = value.updatedAt ?? now()
        transaction(database, () => database.prepare('UPDATE conversations SET title = COALESCE(@title, title), updated_at = @updatedAt WHERE id = @id').run({ id, title: value.title ?? null, updatedAt }))
        const row = one<Query>(database, `SELECT ${conversationColumns} FROM conversations WHERE id = @id`, { id })
        return row && conversationFromRow(row)
      },
      updateGenerationPreferences(id, preferences) {
        const validated = conversationGenerationPreferencesSchema.parse(preferences)
        transaction(database, () => database.prepare('UPDATE conversations SET generation_preferences_json = @generationPreferencesJson, updated_at = @updatedAt WHERE id = @id').run({
          id,
          generationPreferencesJson: JSON.stringify(validated),
          updatedAt: now(),
        }))
        const row = one<Query>(database, `SELECT ${conversationColumns} FROM conversations WHERE id = @id`, { id })
        return row && conversationFromRow(row)
      },
      delete: (id) => { transaction(database, () => database.prepare('DELETE FROM conversations WHERE id = @id').run({ id })) },
    },
    messages: {
      insert(value) {
        transaction(database, () => database.prepare('INSERT INTO messages (id, conversation_id, role, blocks_json, execution_id, created_at) VALUES (@id, @conversationId, @role, @blocksJson, @executionId, @createdAt)').run({ ...value, blocksJson: JSON.stringify(value.blocks), executionId: value.executionId ?? null }))
        return value
      },
      insertWithAssets(value, assetIds) {
        transaction(database, () => insertMessageWithAssets(database, value, assetIds))
        const stored = this.get(value.id)
        if (!stored) throw new Error('Message was not persisted')
        return stored
      },
      get: (id) => { const row = one<Query>(database, `SELECT ${messageColumns} FROM messages WHERE id = @id`, { id }); return row && messageFromRow(row) },
      listForConversation: (conversationId) => many<Query>(database, `SELECT ${messageColumns} FROM messages WHERE conversation_id = @conversationId ORDER BY created_at, id`, { conversationId }).map(messageFromRow),
      update(id, value) {
        transaction(database, () => database.prepare('UPDATE messages SET blocks_json = COALESCE(@blocksJson, blocks_json), execution_id = COALESCE(@executionId, execution_id) WHERE id = @id').run({ id, blocksJson: value.blocks === undefined ? null : JSON.stringify(value.blocks), executionId: value.executionId ?? null }))
        const row = one<Query>(database, `SELECT ${messageColumns} FROM messages WHERE id = @id`, { id })
        return row && messageFromRow(row)
      },
      replaceBlock(messageId, blockId, replacement) {
        const parsedReplacement = chatBlockSchema.parse(replacement)
        if (!('blockId' in parsedReplacement) || parsedReplacement.blockId !== blockId) {
          throw new Error('Replacement block identity must match the updated block')
        }
        return transaction(database, () => {
          const row = one<Query>(database, `SELECT ${messageColumns} FROM messages WHERE id = @id`, { id: messageId })
          if (!row) throw new Error('Message not found')
          const blocks = chatBlockSchema.array().parse(parse(row.blocksJson as string))
          const index = blocks.findIndex((block) => 'blockId' in block && block.blockId === blockId)
          if (index === -1) throw new Error('Message block not found')
          if (parsedReplacement.type === 'media') {
            if (row.role !== 'assistant') throw new Error('Media output requires an assistant message')
            claimReplacementMedia(
              database,
              messageId,
              row.conversationId as string,
              blocks[index]!,
              parsedReplacement,
            )
          }
          blocks[index] = parsedReplacement
          database.prepare('UPDATE messages SET blocks_json = @blocksJson WHERE id = @id').run({ id: messageId, blocksJson: JSON.stringify(blocks) })
          const stored = one<Query>(database, `SELECT ${messageColumns} FROM messages WHERE id = @id`, { id: messageId })
          if (!stored) throw new Error('Message not found')
          return messageFromRow(stored)
        })
      },
      failInterruptedMediaGenerations() {
        return transaction(database, () => {
          let failed = 0
          const activeStatuses = new Set(['pending', 'in_progress', 'downloading', 'paused'])
          for (const row of many<Query>(database, 'SELECT id, blocks_json AS blocksJson FROM messages')) {
            let blocks: ChatBlock[]
            try {
              blocks = chatBlockSchema.array().parse(parse(row.blocksJson as string))
            } catch {
              continue
            }
            let changed = false
            for (const block of blocks) {
              if (block.type !== 'media_generation' || !activeStatuses.has(block.status)) continue
              const jobRow = one<Query>(
                database,
                `SELECT ${mediaGenerationJobColumns} FROM media_generation_jobs WHERE id = @id`,
                { id: block.jobId },
              )
              let association: ResumableVideoAssociation | undefined
              if (jobRow) {
                try {
                  association = resumableVideoAssociation(
                    database,
                    mediaGenerationJobFromRow(jobRow),
                  )
                } catch {
                  association = undefined
                }
              }
              if (
                association
                && association.messageId === row.id
                && association.blockId === block.blockId
              ) continue
              block.status = 'failed'
              block.errorCode = 'MEDIA_GENERATION_FAILED'
              failed += 1
              changed = true
            }
            if (changed) database.prepare('UPDATE messages SET blocks_json = @blocksJson WHERE id = @id').run({ id: row.id, blocksJson: JSON.stringify(blocks) })
          }
          return failed
        })
      },
    },
    mediaAssets: {
      insert(value) {
        const asset = mediaAssetRecordSchema.parse(value)
        transaction(database, () => database.prepare('INSERT INTO media_assets (id, conversation_id, message_id, source, kind, mime_type, original_name, relative_path, byte_size, width, height, duration_ms, sha256, provider, model, status, created_at, updated_at) VALUES (@id, @conversationId, @messageId, @source, @kind, @mimeType, @originalName, @relativePath, @byteSize, @width, @height, @durationMs, @sha256, @provider, @model, @status, @createdAt, @updatedAt)').run({
          ...asset,
          messageId: asset.messageId ?? null,
          mimeType: asset.mimeType ?? null,
          relativePath: asset.relativePath ?? null,
          byteSize: asset.byteSize ?? null,
          width: asset.width ?? null,
          height: asset.height ?? null,
          durationMs: asset.durationMs ?? null,
          sha256: asset.sha256 ?? null,
          provider: asset.provider ?? null,
          model: asset.model ?? null,
        }))
        const stored = this.get(asset.id)
        if (!stored) throw new Error('Media asset was not persisted')
        return stored
      },
      get: (id) => { const row = one<Query>(database, `SELECT ${mediaAssetColumns} FROM media_assets WHERE id = @id`, { id }); return row && mediaAssetFromRow(row) },
      listForConversation: (conversationId) => many<Query>(database, `SELECT ${mediaAssetColumns} FROM media_assets WHERE conversation_id = @conversationId ORDER BY created_at, id`, { conversationId }).map(mediaAssetFromRow),
      listUnclaimedBefore: (timestamp) => many<Query>(database, `SELECT ${mediaAssetColumns} FROM media_assets WHERE message_id IS NULL AND created_at < @timestamp ORDER BY created_at, id`, { timestamp }).map(mediaAssetFromRow),
      update(id, patch) {
        const validatedPatch = mediaAssetPatchSchema.parse(patch)
        transaction(database, () => {
          const row = one<Query>(database, `SELECT ${mediaAssetColumns} FROM media_assets WHERE id = @id`, { id })
          if (!row) return
          const updated = mediaAssetRecordSchema.parse({ ...mediaAssetFromRow(row), ...validatedPatch, updatedAt: validatedPatch.updatedAt ?? now() })
          database.prepare('UPDATE media_assets SET source = @source, kind = @kind, mime_type = @mimeType, original_name = @originalName, relative_path = @relativePath, byte_size = @byteSize, width = @width, height = @height, duration_ms = @durationMs, sha256 = @sha256, provider = @provider, model = @model, status = @status, updated_at = @updatedAt WHERE id = @id').run({
            ...updated,
            mimeType: updated.mimeType ?? null,
            relativePath: updated.relativePath ?? null,
            byteSize: updated.byteSize ?? null,
            width: updated.width ?? null,
            height: updated.height ?? null,
            durationMs: updated.durationMs ?? null,
            sha256: updated.sha256 ?? null,
            provider: updated.provider ?? null,
            model: updated.model ?? null,
          })
        })
        return this.get(id)
      },
      delete: (id) => { transaction(database, () => database.prepare('DELETE FROM media_assets WHERE id = @id').run({ id })) },
    },
    mediaGenerationJobs: {
      insert(value) {
        transaction(database, () => {
          const message = one<{ conversationId: string }>(database, 'SELECT conversation_id AS conversationId FROM messages WHERE id = @id', { id: value.assistantMessageId })
          if (!message || message.conversationId !== value.conversationId) throw new Error('Assistant message does not belong to the media job conversation')
          if (value.assetId !== undefined) {
            const asset = one<{ conversationId: string }>(database, 'SELECT conversation_id AS conversationId FROM media_assets WHERE id = @id', { id: value.assetId })
            if (!asset || asset.conversationId !== value.conversationId) throw new Error('Media asset does not belong to the media job conversation')
          }
          database.prepare('INSERT INTO media_generation_jobs (id, conversation_id, assistant_message_id, provider, model, kind, provider_job_id, status, parameters_json, next_poll_at, poll_attempts, error_code, asset_id, created_at, updated_at, ended_at) VALUES (@id, @conversationId, @assistantMessageId, @provider, @model, @kind, @providerJobId, @status, @parametersJson, @nextPollAt, @pollAttempts, @errorCode, @assetId, @createdAt, @updatedAt, @endedAt)').run({
            ...value,
            parametersJson: JSON.stringify(value.parameters),
            nextPollAt: value.nextPollAt ?? null,
            pollAttempts: value.pollAttempts ?? 0,
            errorCode: value.errorCode ?? null,
            assetId: value.assetId ?? null,
            endedAt: value.endedAt ?? null,
          })
        })
        const stored = this.get(value.id)
        if (!stored) throw new Error('Media generation job was not persisted')
        return stored
      },
      preflightTurn(value) {
        transaction(database, () => {
          validateVideoGenerationTurn(database, value)
        })
      },
      insertTurn(value) {
        const { userMessage, userAssetIds, assistantMessage, run, job } = value
        transaction(database, () => {
          const assistantBlocks = validateVideoGenerationTurn(
            database,
            value,
            job.providerJobId,
          )
          insertMessageWithAssets(database, userMessage, userAssetIds)
          database.prepare('INSERT INTO chat_runs (id, conversation_id, request_id, model, status, generation_id, input_tokens, output_tokens, cost_usd, error_code, started_at, ended_at) VALUES (@id, @conversationId, @requestId, @model, @status, NULL, NULL, NULL, NULL, NULL, @startedAt, NULL)').run(run)
          database.prepare('INSERT INTO messages (id, conversation_id, role, blocks_json, execution_id, created_at) VALUES (@id, @conversationId, @role, @blocksJson, @executionId, @createdAt)').run({
            ...assistantMessage,
            blocksJson: JSON.stringify(assistantBlocks),
            executionId: assistantMessage.executionId ?? null,
          })
          database.prepare('INSERT INTO media_generation_jobs (id, conversation_id, assistant_message_id, provider, model, kind, provider_job_id, status, parameters_json, next_poll_at, poll_attempts, error_code, asset_id, created_at, updated_at, ended_at) VALUES (@id, @conversationId, @assistantMessageId, @provider, @model, @kind, @providerJobId, @status, @parametersJson, @nextPollAt, @pollAttempts, NULL, NULL, @createdAt, @updatedAt, NULL)').run({
            ...job,
            parametersJson: JSON.stringify(job.parameters),
            nextPollAt: job.nextPollAt ?? null,
            pollAttempts: job.pollAttempts ?? 0,
          })
        })
        const stored = this.get(job.id)
        if (!stored) throw new Error('Media generation job was not persisted')
        return stored
      },
      get: (id) => { const row = one<Query>(database, `SELECT ${mediaGenerationJobColumns} FROM media_generation_jobs WHERE id = @id`, { id }); return row && mediaGenerationJobFromRow(row) },
      reconcileInterrupted(endedAt) {
        return transaction(database, () => {
          const preservedRequestIds: string[] = []
          const rows = many<Query>(
            database,
            `SELECT ${mediaGenerationJobColumns}
             FROM media_generation_jobs
             WHERE status IN ('pending', 'in_progress', 'downloading', 'paused')
             ORDER BY id`,
          )
          const failJob = database.prepare(`
            UPDATE media_generation_jobs
            SET status = 'failed',
                next_poll_at = NULL,
                error_code = 'MEDIA_GENERATION_FAILED',
                updated_at = @endedAt,
                ended_at = @endedAt
            WHERE id = @id
              AND status IN ('pending', 'in_progress', 'downloading', 'paused')
          `)
          for (const row of rows) {
            let job: MediaGenerationJob
            try {
              job = mediaGenerationJobFromRow(row)
            } catch {
              failJob.run({ id: row.id as string, endedAt })
              continue
            }
            if (resumableVideoAssociation(database, job)) {
              preservedRequestIds.push(job.id)
              continue
            }
            failJob.run({ id: job.id, endedAt })
          }
          return preservedRequestIds
        })
      },
      listResumable: (now) => many<Query>(database, `SELECT ${mediaGenerationJobColumns} FROM media_generation_jobs WHERE status IN ('pending', 'in_progress', 'downloading') AND (next_poll_at IS NULL OR next_poll_at <= @now) ORDER BY next_poll_at, id`, { now }).map(mediaGenerationJobFromRow),
      listActive: () => many<Query>(database, `SELECT ${mediaGenerationJobColumns} FROM media_generation_jobs WHERE status IN ('pending', 'in_progress', 'downloading') ORDER BY next_poll_at, id`).map(mediaGenerationJobFromRow),
      update(id, patch) {
        transaction(database, () => {
          const job = one<Query>(database, `SELECT ${mediaGenerationJobColumns} FROM media_generation_jobs WHERE id = @id`, { id })
          if (!job) return
          const stored = mediaGenerationJobFromRow(job)
          if (patch.assetId !== undefined) {
            const asset = one<{ conversationId: string }>(database, 'SELECT conversation_id AS conversationId FROM media_assets WHERE id = @id', { id: patch.assetId })
            if (!asset || asset.conversationId !== stored.conversationId) throw new Error('Media asset does not belong to the media job conversation')
          }
          database.prepare('UPDATE media_generation_jobs SET status = COALESCE(@status, status), parameters_json = COALESCE(@parametersJson, parameters_json), next_poll_at = COALESCE(@nextPollAt, next_poll_at), poll_attempts = COALESCE(@pollAttempts, poll_attempts), error_code = COALESCE(@errorCode, error_code), asset_id = COALESCE(@assetId, asset_id), updated_at = @updatedAt, ended_at = COALESCE(@endedAt, ended_at) WHERE id = @id').run({
            id, ...patch, status: patch.status ?? null, parametersJson: patch.parameters === undefined ? null : JSON.stringify(patch.parameters), nextPollAt: patch.nextPollAt ?? null, pollAttempts: patch.pollAttempts ?? null, errorCode: patch.errorCode ?? null, assetId: patch.assetId ?? null, endedAt: patch.endedAt ?? null, updatedAt: patch.updatedAt ?? now(),
          })
        })
        return this.get(id)
      },
      transition(id, expectedStatuses, patch) {
        if (expectedStatuses.length === 0) throw new Error('Expected video job status is required')
        return transaction(database, () => {
          const row = one<Query>(database, `SELECT ${mediaGenerationJobColumns} FROM media_generation_jobs WHERE id = @id`, { id })
          if (!row) return undefined
          const job = mediaGenerationJobFromRow(row)
          if (!expectedStatuses.includes(job.status)) return undefined
          assertVideoTransition(job.status, patch.status)
          if (patch.status === 'failed' || patch.status === 'completed') {
            throw new Error('Use a terminal video generation operation')
          }
          const active = activeVideoBlock(database, job)
          const replacement: Extract<ChatBlock, { type: 'media_generation' }> = {
            ...active.block,
            status: patch.status as 'pending' | 'in_progress' | 'downloading' | 'paused',
          }
          delete replacement.errorCode
          const message = updateVideoBlock(
            database,
            active.message.id,
            active.blocks,
            active.index,
            replacement,
          )
          const nextPollAt = Object.prototype.hasOwnProperty.call(patch, 'nextPollAt')
            ? patch.nextPollAt ?? null
            : job.nextPollAt ?? null
          if (database.prepare('UPDATE media_generation_jobs SET status = @status, parameters_json = @parametersJson, next_poll_at = @nextPollAt, poll_attempts = @pollAttempts, error_code = NULL, updated_at = @updatedAt WHERE id = @id AND status = @expectedStatus').run({
            id,
            expectedStatus: job.status,
            status: patch.status,
            parametersJson: JSON.stringify(
              patch.parameters === undefined ? job.parameters : patch.parameters,
            ),
            nextPollAt,
            pollAttempts: patch.pollAttempts ?? job.pollAttempts ?? 0,
            updatedAt: patch.updatedAt,
          }).changes !== 1) throw new Error('Video job transition was lost')
          const stored = this.get(id)
          if (!stored) throw new Error('Video job was not persisted')
          return { job: stored, message, block: replacement }
        })
      },
      complete(id, expectedStatuses, input) {
        return transaction(database, () => {
          const row = one<Query>(database, `SELECT ${mediaGenerationJobColumns} FROM media_generation_jobs WHERE id = @id`, { id })
          if (!row) return undefined
          const job = mediaGenerationJobFromRow(row)
          if (!expectedStatuses.includes(job.status)) return undefined
          assertVideoTransition(job.status, 'completed')
          const active = activeVideoBlock(database, job)
          if (
            input.block.blockId !== active.block.blockId
            || input.block.kind !== 'video'
            || input.block.purpose !== 'output'
            || input.block.assetId !== input.assetId
          ) throw new Error('Video output block identity does not match')
          const assetRow = one<Query>(database, `SELECT ${mediaAssetColumns} FROM media_assets WHERE id = @id`, {
            id: input.assetId,
          })
          if (!assetRow) throw new Error('Video output asset not found')
          const asset = mediaAssetFromRow(assetRow)
          if (
            asset.conversationId !== job.conversationId
            || asset.source !== 'generated'
            || asset.kind !== 'video'
            || asset.provider !== job.provider
            || asset.model !== job.model
            || asset.status !== 'ready'
            || (asset.messageId !== undefined && asset.messageId !== job.assistantMessageId)
          ) throw new Error('Video output asset does not match its job')
          const run = videoRun(database, job)
          claimReplacementMedia(
            database,
            job.assistantMessageId,
            job.conversationId,
            active.block,
            input.block,
            { requestId: job.id, model: job.model },
          )
          const message = updateVideoBlock(
            database,
            active.message.id,
            active.blocks,
            active.index,
            input.block,
          )
          if (database.prepare("UPDATE media_generation_jobs SET status = 'completed', next_poll_at = NULL, error_code = NULL, asset_id = @assetId, updated_at = @endedAt, ended_at = @endedAt WHERE id = @id AND status = @expectedStatus").run({
            id,
            expectedStatus: job.status,
            assetId: input.assetId,
            endedAt: input.endedAt,
          }).changes !== 1) throw new Error('Video job completion was lost')
          if (database.prepare("UPDATE chat_runs SET status = 'completed', generation_id = @generationId, cost_usd = @costUsd, error_code = NULL, ended_at = @endedAt WHERE id = @id AND status = 'running'").run({
            id: run.id,
            generationId: input.generationId ?? null,
            costUsd: input.costUsd ?? null,
            endedAt: input.endedAt,
          }).changes !== 1) throw new Error('Video chat run completion was lost')
          const stored = this.get(id)
          if (!stored) throw new Error('Video job was not persisted')
          return { job: stored, message, block: input.block }
        })
      },
      fail(id, expectedStatuses, errorCode, endedAt) {
        const safeErrorCode = appErrorCodeSchema.parse(errorCode)
        return transaction(database, () => {
          const row = one<Query>(database, `SELECT ${mediaGenerationJobColumns} FROM media_generation_jobs WHERE id = @id`, { id })
          if (!row) return undefined
          const job = mediaGenerationJobFromRow(row)
          if (!expectedStatuses.includes(job.status)) return undefined
          assertVideoTransition(job.status, 'failed')
          const active = activeVideoBlock(database, job)
          const run = videoRun(database, job)
          const replacement: Extract<ChatBlock, { type: 'media_generation' }> = {
            ...active.block,
            status: 'failed',
            errorCode: safeErrorCode,
          }
          const message = updateVideoBlock(
            database,
            active.message.id,
            active.blocks,
            active.index,
            replacement,
          )
          if (database.prepare("UPDATE media_generation_jobs SET status = 'failed', next_poll_at = NULL, error_code = @errorCode, updated_at = @endedAt, ended_at = @endedAt WHERE id = @id AND status = @expectedStatus").run({
            id,
            expectedStatus: job.status,
            errorCode: safeErrorCode,
            endedAt,
          }).changes !== 1) throw new Error('Video job failure was lost')
          if (database.prepare("UPDATE chat_runs SET status = 'failed', error_code = @errorCode, ended_at = @endedAt WHERE id = @id AND status = 'running'").run({
            id: run.id,
            errorCode: safeErrorCode,
            endedAt,
          }).changes !== 1) throw new Error('Video chat run failure was lost')
          const stored = this.get(id)
          if (!stored) throw new Error('Video job was not persisted')
          return { job: stored, message, block: replacement }
        })
      },
    },
    chatRuns: {
      insert(value) {
        transaction(database, () => database.prepare('INSERT INTO chat_runs (id, conversation_id, request_id, model, status, generation_id, input_tokens, output_tokens, cost_usd, error_code, started_at, ended_at) VALUES (@id, @conversationId, @requestId, @model, @status, @generationId, @inputTokens, @outputTokens, @costUsd, @errorCode, @startedAt, @endedAt)').run({
          generationId: null, inputTokens: null, outputTokens: null, costUsd: null, errorCode: null, endedAt: null, ...value,
        }))
        return value
      },
      get: (id) => one<ChatRun>(database, `SELECT ${chatRunColumns} FROM chat_runs WHERE id = @id`, { id }),
      update(id, value) {
        transaction(database, () => database.prepare('UPDATE chat_runs SET status = COALESCE(@status, status), generation_id = COALESCE(@generationId, generation_id), input_tokens = COALESCE(@inputTokens, input_tokens), output_tokens = COALESCE(@outputTokens, output_tokens), cost_usd = COALESCE(@costUsd, cost_usd), error_code = COALESCE(@errorCode, error_code), ended_at = COALESCE(@endedAt, ended_at) WHERE id = @id').run({
          id, status: null, generationId: null, inputTokens: null, outputTokens: null, costUsd: null, errorCode: null, endedAt: null, ...value,
        }))
        return one<ChatRun>(database, `SELECT ${chatRunColumns} FROM chat_runs WHERE id = @id`, { id })
      },
      finalizeWithMessage(id, messageId, requestId, value) {
        const blocks = chatBlockSchema.array().parse(value.blocks)
        assertUniqueFinalMediaBlocks(blocks)
        return transaction(database, () => {
          const messageRow = one<Query>(database, `SELECT ${messageColumns} FROM messages WHERE id = @id`, {
            id: messageId,
          })
          if (!messageRow || messageRow.role !== 'assistant') throw new Error('Assistant message not found')
          const runRow = one<ChatRun>(database, `SELECT ${chatRunColumns} FROM chat_runs WHERE id = @id`, { id })
          if (
            !runRow
            || runRow.conversationId !== messageRow.conversationId
            || runRow.requestId !== requestId
            || runRow.status !== 'running'
          ) {
            throw new Error('Chat run does not belong to the assistant conversation')
          }
          if (value.status === 'completed' && value.errorCode !== undefined) {
            throw new Error('Completed chat run cannot carry an error')
          }
          const previousBlocks = chatBlockSchema.array().parse(parse(messageRow.blocksJson as string))
          for (const previous of previousBlocks) {
            if (previous.type !== 'media_generation') continue
            const replacement = blocks.find((candidate) => (
              'blockId' in candidate && candidate.blockId === previous.blockId
            ))
            if (
              !replacement
              || previous.jobId !== requestId
              || !['pending', 'in_progress', 'downloading'].includes(previous.status)
            ) throw new Error('Media generation identity is not active')
            if (replacement.type === 'media_generation') {
              const matchingFailure = (
                replacement.errorCode !== undefined
                && replacement.errorCode === value.errorCode
                && (
                  value.status === 'failed'
                  || (
                    value.status === 'cancelled'
                    && value.errorCode === 'CANCELLED'
                  )
                )
              )
              if (
                replacement.jobId !== requestId
                || replacement.kind !== previous.kind
                || replacement.status !== 'failed'
                || !matchingFailure
              ) throw new Error('Media generation failure does not match its request')
            } else if (replacement.type === 'media') {
              if (value.status !== 'completed') throw new Error('Media output requires a completed run')
            } else {
              throw new Error('Media generation block requires a terminal replacement')
            }
          }
          for (const block of blocks) {
            if (block.type !== 'media') continue
            const previous = previousBlocks.find((candidate) => (
              'blockId' in candidate && candidate.blockId === block.blockId
            ))
            if (!previous) throw new Error('Message block not found')
            claimReplacementMedia(
              database,
              messageId,
              messageRow.conversationId as string,
              previous,
              block,
              { requestId, model: runRow.model },
            )
          }
          const message = database.prepare('UPDATE messages SET blocks_json = @blocksJson WHERE id = @messageId').run({
            messageId,
            blocksJson: JSON.stringify(blocks),
          })
          if (message.changes !== 1) throw new Error('Assistant message not found')
          const run = database.prepare('UPDATE chat_runs SET status = @status, generation_id = @generationId, input_tokens = @inputTokens, output_tokens = @outputTokens, cost_usd = @costUsd, error_code = @errorCode, ended_at = @endedAt WHERE id = @id').run({
            id,
            status: value.status,
            generationId: value.generationId ?? null,
            inputTokens: value.inputTokens ?? null,
            outputTokens: value.outputTokens ?? null,
            costUsd: value.costUsd ?? null,
            errorCode: value.errorCode ?? null,
            endedAt: value.endedAt,
          })
          if (run.changes !== 1) throw new Error('Chat run not found')
          const stored = one<ChatRun>(database, `SELECT ${chatRunColumns} FROM chat_runs WHERE id = @id`, { id })
          if (!stored) throw new Error('Chat run not found')
          return stored
        })
      },
    },
    workflowProjects: {
      insert(value) {
        transaction(database, () => database.prepare('INSERT INTO workflow_projects (id, name, root_path, manifest_json, status, build_hash, last_error, created_at, updated_at) VALUES (@id, @name, @rootPath, @manifestJson, @status, @buildHash, @lastError, @createdAt, @updatedAt)').run({ ...value, manifestJson: value.manifest === undefined ? null : JSON.stringify(value.manifest) }))
        return value
      },
      get: (id) => { const row = one<Query>(database, `SELECT ${projectColumns} FROM workflow_projects WHERE id = @id`, { id }); return row && projectFromRow(row) },
      list: () => many<Query>(database, `SELECT ${projectColumns} FROM workflow_projects ORDER BY updated_at DESC, id`).map(projectFromRow),
      update(id, value) {
        transaction(database, () => database.prepare('UPDATE workflow_projects SET name = COALESCE(@name, name), manifest_json = COALESCE(@manifestJson, manifest_json), status = COALESCE(@status, status), build_hash = COALESCE(@buildHash, build_hash), last_error = COALESCE(@lastError, last_error), updated_at = @updatedAt WHERE id = @id').run({ id, ...value, manifestJson: value.manifest === undefined ? null : JSON.stringify(value.manifest), updatedAt: value.updatedAt ?? now() }))
        const row = one<Query>(database, `SELECT ${projectColumns} FROM workflow_projects WHERE id = @id`, { id })
        return row && projectFromRow(row)
      },
    },
    installedWorkflows: {
      insert(value, files) {
        transaction(database, () => {
          database.prepare('INSERT INTO installed_workflows (workflow_id, version, name, description, author, category, manifest_json, install_path, enabled, integrity_status, source, installed_at, updated_at) VALUES (@workflowId, @version, @name, @description, @author, @category, @manifestJson, @installPath, @enabled, @integrityStatus, @source, @installedAt, @updatedAt)').run({ ...value, enabled: Number(value.enabled), manifestJson: JSON.stringify(value.manifest) })
          const insertFile = database.prepare('INSERT INTO workflow_files (workflow_id, workflow_version, path, sha256) VALUES (@workflowId, @workflowVersion, @path, @sha256)')
          for (const file of files) insertFile.run(file)
        })
        return value
      },
      upsert(value) {
        transaction(database, () => database.prepare('INSERT INTO installed_workflows (workflow_id, version, name, description, author, category, manifest_json, install_path, enabled, integrity_status, source, installed_at, updated_at) VALUES (@workflowId, @version, @name, @description, @author, @category, @manifestJson, @installPath, @enabled, @integrityStatus, @source, @installedAt, @updatedAt) ON CONFLICT(workflow_id, version) DO UPDATE SET name = excluded.name, description = excluded.description, author = excluded.author, category = excluded.category, manifest_json = excluded.manifest_json, install_path = excluded.install_path, enabled = excluded.enabled, integrity_status = excluded.integrity_status, source = excluded.source, updated_at = excluded.updated_at').run({ ...value, enabled: Number(value.enabled), manifestJson: JSON.stringify(value.manifest) }))
        return value
      },
      get: (workflowId, version) => { const row = one<Query>(database, `SELECT ${installedWorkflowColumns} FROM installed_workflows WHERE workflow_id = @workflowId AND version = @version`, { workflowId, version }); return row && installedWorkflowFromRow(row) },
      list: () => many<Query>(database, `SELECT ${installedWorkflowColumns} FROM installed_workflows ORDER BY name, version`).map(installedWorkflowFromRow),
      setEnabled: (workflowId, version, enabled) => { transaction(database, () => database.prepare('UPDATE installed_workflows SET enabled = @enabled, updated_at = @updatedAt WHERE workflow_id = @workflowId AND version = @version').run({ workflowId, version, enabled: Number(enabled), updatedAt: now() })) },
      delete: (workflowId, version) => {
        transaction(database, () => {
          database.prepare('DELETE FROM permission_grants WHERE workflow_id = @workflowId AND workflow_version = @version').run({ workflowId, version })
          database.prepare('DELETE FROM installed_workflows WHERE workflow_id = @workflowId AND version = @version').run({ workflowId, version })
        })
      },
    },
    workflowFiles: {
      insert(value) { transaction(database, () => database.prepare('INSERT INTO workflow_files (workflow_id, workflow_version, path, sha256) VALUES (@workflowId, @workflowVersion, @path, @sha256)').run(value)); return value },
      list: (workflowId, workflowVersion) => many<WorkflowFile>(database, 'SELECT workflow_id AS workflowId, workflow_version AS workflowVersion, path, sha256 FROM workflow_files WHERE workflow_id = @workflowId AND workflow_version = @workflowVersion ORDER BY path', { workflowId, workflowVersion }),
    },
    executions: {
      insert(value) {
        const createdAt = value.createdAt ?? now()
        const input = value.input ?? {}
        transaction(database, () => database.prepare('INSERT INTO executions (id, workflow_id, workflow_version, chat_run_id, status, input_json, result_json, error_code, created_at, started_at, ended_at) VALUES (@id, @workflowId, @workflowVersion, @chatRunId, @status, @inputJson, @resultJson, @errorCode, @createdAt, @startedAt, @endedAt)').run({ ...value, inputJson: JSON.stringify(input), resultJson: value.result === undefined ? null : JSON.stringify(value.result), chatRunId: value.chatRunId ?? null, errorCode: value.errorCode ?? null, createdAt, startedAt: value.startedAt ?? null, endedAt: value.endedAt ?? null }))
        return { ...value, input, createdAt } as Execution
      },
      get: (id) => { const row = one<Query>(database, `SELECT ${executionColumns} FROM executions WHERE id = @id`, { id }); return row && executionFromRow(row) },
      list: () => many<Query>(database, `SELECT ${executionColumns} FROM executions ORDER BY created_at DESC, id`).map(executionFromRow),
      update(id, value) {
        transaction(database, () => database.prepare('UPDATE executions SET chat_run_id = COALESCE(@chatRunId, chat_run_id), status = COALESCE(@status, status), input_json = COALESCE(@inputJson, input_json), result_json = COALESCE(@resultJson, result_json), error_code = COALESCE(@errorCode, error_code), started_at = COALESCE(@startedAt, started_at), ended_at = COALESCE(@endedAt, ended_at) WHERE id = @id').run({
          id, chatRunId: null, status: null, errorCode: null, startedAt: null, endedAt: null, ...value,
          inputJson: value.input === undefined ? null : JSON.stringify(value.input),
          resultJson: value.result === undefined ? null : JSON.stringify(value.result),
        }))
        const row = one<Query>(database, `SELECT ${executionColumns} FROM executions WHERE id = @id`, { id })
        return row && executionFromRow(row)
      },
      markInterrupted: () => transaction(database, () => database.prepare("UPDATE executions SET status = 'interrupted', error_code = 'INTERNAL_ERROR', ended_at = @endedAt WHERE status IN ('queued', 'awaiting_approval', 'running', 'pending', 'waiting_approval')").run({ endedAt: now() }).changes),
    },
    executionSteps: {
      insert(value) { transaction(database, () => database.prepare('INSERT INTO execution_steps (id, execution_id, sequence, name, status, percent, started_at, ended_at) VALUES (@id, @executionId, @sequence, @name, @status, @percent, @startedAt, @endedAt)').run(value)); return value },
      list: (executionId) => many<ExecutionStep>(database, 'SELECT id, execution_id AS executionId, sequence, name, status, percent, started_at AS startedAt, ended_at AS endedAt FROM execution_steps WHERE execution_id = @executionId ORDER BY sequence', { executionId }),
    },
    executionLogs: {
      insert(value) {
        const sensitivePaths = value.sensitivePaths ?? []
        const log: ExecutionLog = {
          id: value.id,
          executionId: value.executionId,
          sequence: value.sequence,
          level: value.level,
          message: redactLogMessage(value.message, sensitivePaths),
          metadata: value.metadata === undefined ? undefined : redact(value.metadata, sensitivePaths),
          createdAt: value.createdAt,
        }
        transaction(database, () => database.prepare('INSERT INTO execution_logs (id, execution_id, sequence, level, message, metadata_json, created_at) VALUES (@id, @executionId, @sequence, @level, @message, @metadataJson, @createdAt)').run({ ...log, metadataJson: log.metadata === undefined ? null : JSON.stringify(log.metadata) }))
        return log
      },
      list: (executionId) => many<Query>(database, 'SELECT id, execution_id AS executionId, sequence, level, message, metadata_json AS metadataJson, created_at AS createdAt FROM execution_logs WHERE execution_id = @executionId ORDER BY sequence', { executionId }).map((row) => ({ ...row, metadata: parse(row.metadataJson as string | null) } as ExecutionLog)),
    },
    permissionGrants: {
      upsert(value) {
        transaction(database, () => database.prepare('INSERT INTO permission_grants (id, workflow_id, workflow_version, capability, scope_json, scope_hash, created_at, updated_at) VALUES (@id, @workflowId, @workflowVersion, @capability, @scopeJson, @scopeHash, @createdAt, @updatedAt) ON CONFLICT(workflow_id, workflow_version, capability, scope_hash) DO UPDATE SET updated_at = excluded.updated_at').run({ ...value, scopeJson: JSON.stringify(value.scope) }))
        return value
      },
      get: (workflowId, workflowVersion, capability, scopeHash) => { const row = one<Query>(database, 'SELECT id, workflow_id AS workflowId, workflow_version AS workflowVersion, capability, scope_json AS scopeJson, scope_hash AS scopeHash, created_at AS createdAt, updated_at AS updatedAt FROM permission_grants WHERE workflow_id = @workflowId AND workflow_version = @workflowVersion AND capability = @capability AND scope_hash = @scopeHash', { workflowId, workflowVersion, capability, scopeHash }); return row && permissionFromRow(row) },
      list: () => many<Query>(database, 'SELECT id, workflow_id AS workflowId, workflow_version AS workflowVersion, capability, scope_json AS scopeJson, scope_hash AS scopeHash, created_at AS createdAt, updated_at AS updatedAt FROM permission_grants ORDER BY created_at DESC, id').map(permissionFromRow),
      delete: (id) => { transaction(database, () => database.prepare('DELETE FROM permission_grants WHERE id = @id').run({ id })) },
    },
    appSettings: {
      get: (key) => { const row = one<Query>(database, 'SELECT key, value_json AS valueJson, updated_at AS updatedAt FROM app_settings WHERE key = @key', { key }); return row && { key: row.key as string, value: parse(row.valueJson as string), updatedAt: row.updatedAt as number } },
      set(key, value) {
        const updatedAt = now()
        transaction(database, () => database.prepare('INSERT INTO app_settings (key, value_json, updated_at) VALUES (@key, @valueJson, @updatedAt) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at').run({ key, valueJson: JSON.stringify(value), updatedAt }))
        return { key, value, updatedAt }
      },
      delete: (key) => { transaction(database, () => database.prepare('DELETE FROM app_settings WHERE key = @key').run({ key })) },
    },
    encryptedSecrets: {
      get: (key) => one<EncryptedSecret>(database, 'SELECT key, ciphertext_base64 AS ciphertextBase64, updated_at AS updatedAt FROM encrypted_secrets WHERE key = @key', { key }),
      set(key, ciphertextBase64) { transaction(database, () => database.prepare('INSERT INTO encrypted_secrets (key, ciphertext_base64, updated_at) VALUES (@key, @ciphertextBase64, @updatedAt) ON CONFLICT(key) DO UPDATE SET ciphertext_base64 = excluded.ciphertext_base64, updated_at = excluded.updated_at').run({ key, ciphertextBase64, updatedAt: now() })) },
      delete: (key) => { transaction(database, () => database.prepare('DELETE FROM encrypted_secrets WHERE key = @key').run({ key })) },
      raw: (key) => one<{ ciphertextBase64: string }>(database, 'SELECT ciphertext_base64 AS ciphertextBase64 FROM encrypted_secrets WHERE key = @key', { key })?.ciphertextBase64,
    },
  }
}
