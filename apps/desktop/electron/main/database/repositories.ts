import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import {
  appErrorCodeSchema,
  attachmentKindSchema,
  browserAuditTextSchema,
  capabilitySchema,
  chatBlockSchema,
  conversationGenerationPreferencesSchema,
  conversionTargetFormatSchema,
  httpsUrlPatternSchema,
  runtimeCapabilityPermissionSchema,
  runtimeCapabilityScopeSchema,
  type AppErrorCode,
  type ByokUsageEvent,
  type ChatBlock,
  type ConversionJobStatus,
  type ConversionPreset,
  type ConversionTargetFormat,
  type ConversationGenerationPreferences,
  type AttachmentKind,
  type ModelProviderId,
} from '@autoforge/shared'
import { addUsd, normalizeUsd } from '../billing/decimal-usd.js'
import { redact } from '../security/redaction.js'

export interface Conversation {
  id: string
  title: string
  titleState: 'pending' | 'generating' | 'ai_named' | 'user_named' | 'failed'
  userId?: string
  generationPreferences?: ConversationGenerationPreferences
  createdAt: number
  updatedAt: number
}

export interface Message {
  id: string
  conversationId: string
  role: string
  blocks: unknown[]
  providerProjection?: MessageProviderProjection
  ordinal: number
  executionId?: string
  createdAt: number
}

export interface MessageProviderProjection {
  kind: 'local_conversion'
  content: string
}

export interface ConversationContextRecord {
  conversationId: string
  summaryText: string
  throughOrdinal: number
  estimatedTokens: number
  updatedAt: number
}

export interface ConversationContextAdvanceInput
  extends ConversationContextRecord {
  expectedThroughOrdinal: number
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
  userId?: string
  provider?: ModelProviderId
}

export type BrowserPermissionMatrix = Partial<Record<
  'browser.open' | 'browser.fill' | 'browser.click' | 'browser.url' | 'browser.close',
  string[]
>>

export interface BrowserTabBinding {
  id: string
  tabId: string
  userId: string
  conversationId: string
  chatRunId?: string
  executionId?: string
  workflowId: string
  workflowVersion: string
  source: 'installed' | 'development'
  buildHash?: string
  securityFingerprint: string
  permissionMatrix: BrowserPermissionMatrix
  status: 'active' | 'revoked' | 'closed' | 'stale'
  terminalReason?: string
  createdAt: number
  endedAt?: number
}

export interface BrowserActionAuditEntry {
  id: string
  bindingId: string
  chatRunId?: string
  sequence: number
  origin: string
  action: string
  targetSummary: string
  risk: 'safe_navigation' | 'sensitive_read' | 'external_action'
  outcome: 'completed' | 'blocked' | 'failed' | 'cancelled' | 'handed_off'
  errorCode?: AppErrorCode
  createdAt: number
}

export type ProviderUsageStatus = 'pending' | 'reported' | 'unknown'
export type ProviderUsageModality = 'text' | 'image' | 'audio' | 'video'

export class ProviderUsageConsistencyError extends Error {
  constructor() {
    super('Provider usage consistency error')
    this.name = 'ProviderUsageConsistencyError'
  }
}

export interface ProviderUsageStart {
  id: string
  operationKey: string
  userId: string
  provider: ModelProviderId
  apiKeyFingerprint?: string
  requestId: string
  chatRunId?: string
  model: string
  modality: ProviderUsageModality
  startedAt: number
}

export interface ProviderUsageIdentity {
  generationId?: string
  providerJobId?: string
}

export interface ProviderUsageReport extends ProviderUsageIdentity {
  inputTokens?: number
  outputTokens?: number
  costUsd: string | number
  endedAt: number
}

export interface ProviderUsageQueryRecord {
  userId: string
  yesterdayStartedAt: number
  todayStartedAt: number
  weekStartedAt: number
  monthStartedAt: number
  endedAt: number
}

export interface ProviderUsageEvent extends ProviderUsageStart {
  generationId?: string
  providerJobId?: string
  status: ProviderUsageStatus
  inputTokens?: number
  outputTokens?: number
  costUsd?: string
  reconcileAttempts: number
  nextReconcileAt?: number
  endedAt?: number
}

export interface ProviderCostModelRecord {
  provider: ModelProviderId
  model: string
  openRouterCostUsd: string
  openRouterKnownCostCount: number
  openRouterUnknownCostCount: number
}

export interface ProviderCostPeriodRecord {
  openRouterCostUsd: string
  openRouterKnownCostCount: number
  openRouterUnknownCostCount: number
  models: ProviderCostModelRecord[]
}

export interface ProviderCostSnapshotRecord {
  allTimeStartedAt?: number
  today: ProviderCostPeriodRecord
  yesterday: ProviderCostPeriodRecord
  week: ProviderCostPeriodRecord
  month: ProviderCostPeriodRecord
  allTime: ProviderCostPeriodRecord
}

export interface ProviderUsageRepository {
  find(operationKey: string): ProviderUsageEvent | undefined
  start(event: ProviderUsageStart): ProviderUsageEvent
  bindIdentity(operationKey: string, identity: ProviderUsageIdentity): ProviderUsageEvent
  report(operationKey: string, report: ProviderUsageReport): ProviderUsageEvent
  markUnknown(operationKey: string, endedAt: number): ProviderUsageEvent
  recoverPending(now: number): number
  listReconcilable(now: number): ProviderUsageEvent[]
  recordReconcileFailure(operationKey: string, nextReconcileAt?: number): ProviderUsageEvent
  summarize(input: ProviderUsageQueryRecord): ProviderCostSnapshotRecord
  recordByokUsage?(event: ByokUsageEvent): void
}

export interface ModelTokenUsageRecord {
  provider: ModelProviderId
  model: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export type TokenUsageGranularityRecord = 'hour' | 'day' | 'month'

export interface TokenUsageQueryRecord {
  userId: string
  yesterdayStartedAt: number
  todayStartedAt: number
  weekStartedAt: number
  monthStartedAt: number
  endedAt: number
}

export interface TokenUsageTrendRecord {
  bucket: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface TokenUsagePeriodRecord {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  models: ModelTokenUsageRecord[]
  trend: TokenUsageTrendRecord[]
}

export interface TokenUsageSnapshotRecord {
  allTimeStartedAt?: number
  today: TokenUsagePeriodRecord
  yesterday: TokenUsagePeriodRecord
  week: TokenUsagePeriodRecord
  month: TokenUsagePeriodRecord
  allTime: TokenUsagePeriodRecord
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
  ownerUserId?: string
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

export interface ConversionJob {
  id: string
  ownerUserId: string
  executionId: string
  sourceKind: 'media' | 'artifact'
  sourceId: string
  targetFormat: ConversionTargetFormat
  preset?: ConversionPreset
  status: ConversionJobStatus
  epoch: number
  progress: number
  errorCode?: AppErrorCode
  createdAt: number
  updatedAt: number
  startedAt?: number
  endedAt?: number
}

export type NewConversionJob = Pick<
  ConversionJob,
  'id' | 'ownerUserId' | 'executionId' | 'sourceKind' | 'sourceId' | 'targetFormat'
> & Partial<Pick<ConversionJob, 'preset' | 'status' | 'epoch' | 'progress' | 'errorCode' | 'createdAt' | 'updatedAt' | 'startedAt' | 'endedAt'>>

export type ConversionJobTransition = Partial<Pick<
  ConversionJob,
  'status' | 'progress' | 'errorCode' | 'startedAt' | 'endedAt'
>>

const conversionIconRepresentationSizeSchema = z.union([
  z.literal(16), z.literal(24), z.literal(32), z.literal(48), z.literal(64),
  z.literal(128), z.literal(256), z.literal(512), z.literal(1024),
])
const conversionIcnsSlotDimensions = {
  icp4: [16, 1, 16], ic11: [16, 2, 32], icp5: [32, 1, 32], ic12: [32, 2, 64],
  icp6: [64, 1, 64], ic07: [128, 1, 128], ic13: [128, 2, 256],
  ic08: [256, 1, 256], ic14: [256, 2, 512], ic09: [512, 1, 512], ic10: [512, 2, 1024],
} as const
const conversionIcnsRepresentationSchema = z.object({
  sourceType: z.enum(['icp4', 'ic11', 'icp5', 'ic12', 'icp6', 'ic07', 'ic13', 'ic08', 'ic14', 'ic09', 'ic10']),
  logicalWidth: conversionIconRepresentationSizeSchema,
  logicalHeight: conversionIconRepresentationSizeSchema,
  pixelWidth: conversionIconRepresentationSizeSchema,
  pixelHeight: conversionIconRepresentationSizeSchema,
  scale: z.union([z.literal(1), z.literal(2)]),
}).strict().superRefine((value, context) => {
  const [logicalSize, scale, pixelSize] = conversionIcnsSlotDimensions[value.sourceType]
  if (
    value.logicalWidth !== logicalSize || value.logicalHeight !== logicalSize
    || value.pixelWidth !== pixelSize || value.pixelHeight !== pixelSize || value.scale !== scale
  ) context.addIssue({ code: 'custom', message: 'ICNS representation metadata must match its source slot' })
})
const conversionIcoDimensionSchema = z.number().int().min(1).max(256)
const conversionIcoRepresentationSchema = z.object({
  sourceType: z.literal('ico'),
  sourceIndex: z.number().int().min(1).max(256),
  logicalWidth: conversionIcoDimensionSchema,
  logicalHeight: conversionIcoDimensionSchema,
  pixelWidth: conversionIcoDimensionSchema,
  pixelHeight: conversionIcoDimensionSchema,
  scale: z.literal(1),
}).strict().superRefine((value, context) => {
  if (value.logicalWidth !== value.pixelWidth || value.logicalHeight !== value.pixelHeight) {
    context.addIssue({ code: 'custom', message: 'ICO representation metadata must preserve its pixel dimensions' })
  }
})
const conversionIconRepresentationSchema = z.union([
  conversionIcnsRepresentationSchema,
  conversionIcoRepresentationSchema,
])

export const conversionArtifactMetadataSchema = z.object({
  iconRepresentations: z.array(conversionIconRepresentationSizeSchema).min(1).max(9)
    .refine((sizes) => new Set(sizes).size === sizes.length, 'Icon representations must be unique')
    .optional(),
  iconRepresentation: conversionIconRepresentationSchema.optional(),
  pdfPage: z.number().int().min(1).max(100).optional(),
  frameSelection: z.literal('first').optional(),
  transparentPadding: z.literal(true).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'Conversion metadata must describe an output')

export type ConversionArtifactMetadata = z.infer<typeof conversionArtifactMetadataSchema>

export interface ConversionArtifact {
  id: string
  ownerUserId: string
  executionId: string
  conversionJobId?: string
  role: 'input' | 'output'
  displayName: string
  detectedFormat: string
  mimeType: string
  byteSize: number
  sha256: string
  relativePath: string
  metadata?: ConversionArtifactMetadata
  status: 'ready' | 'deleted'
  createdAt: number
  updatedAt: number
  deletedAt?: number
}

export type NewConversionArtifact = Pick<
  ConversionArtifact,
  'id' | 'ownerUserId' | 'executionId' | 'role' | 'displayName' | 'detectedFormat' | 'mimeType' | 'byteSize' | 'sha256' | 'relativePath'
> & Partial<Pick<ConversionArtifact, 'conversionJobId' | 'metadata' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'>>

export interface CompleteConversionJobWithArtifactsInput {
  jobId: string
  ownerUserId: string
  executionId: string
  expectedEpoch: number
  endedAt: number
  artifacts: readonly NewConversionArtifact[]
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
  kind: AttachmentKind
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
export const VIDEO_SUBMISSION_INTENT_PROVIDER_JOB_ID = 'local:autoforge_video_submission_intent'

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

export function isVideoSubmissionIntent(job: MediaGenerationJob): boolean {
  return job.providerJobId === VIDEO_SUBMISSION_INTENT_PROVIDER_JOB_ID
}

function hasVideoSubmissionIntentMarker(parameters: unknown): boolean {
  if (
    typeof parameters !== 'object'
    || parameters === null
    || !('submission' in parameters)
    || typeof parameters.submission !== 'object'
    || parameters.submission === null
  ) return false
  return 'phase' in parameters.submission && parameters.submission.phase === 'intent'
}

export type MediaGenerationJobPatch = Partial<Omit<MediaGenerationJob, 'id' | 'conversationId' | 'assistantMessageId' | 'provider' | 'model' | 'kind' | 'providerJobId' | 'createdAt'>>
export type MessageInput = Omit<Message, 'ordinal' | 'executionId'> & { executionId?: string }

export interface VideoGenerationTurnInput {
  userMessage: MessageInput
  userAssetIds: string[]
  assistantMessage: MessageInput
  run: Omit<ChatRun, 'generationId' | 'inputTokens' | 'outputTokens' | 'costUsd' | 'errorCode' | 'endedAt'>
  job: MediaGenerationJob
}

export type MediaGenerationTurnInput = Omit<VideoGenerationTurnInput, 'job'>

export type VideoGenerationSubmissionIntentInput = Omit<VideoGenerationTurnInput, 'job'> & {
  job: Omit<MediaGenerationJob, 'providerJobId'>
}

export interface BindSubmittedVideoInput {
  providerJobId: string
  status: 'pending' | 'in_progress'
  parameters: unknown
  nextPollAt: number
  updatedAt: number
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
  kind: attachmentKindSchema,
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
  if (asset.source === 'generated' && asset.kind === 'file') {
    context.addIssue({ code: 'custom', path: ['kind'], message: 'Generated media assets cannot be files' })
  }
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

const storedIdentifierSchema = z.string().trim().min(1)
const browserPermissionMatrixSchema = z.object({
  'browser.open': z.array(httpsUrlPatternSchema).min(1).optional(),
  'browser.fill': z.array(httpsUrlPatternSchema).min(1).optional(),
  'browser.click': z.array(httpsUrlPatternSchema).min(1).optional(),
  'browser.url': z.array(httpsUrlPatternSchema).min(1).optional(),
  'browser.close': z.array(httpsUrlPatternSchema).min(1).optional(),
}).strict().refine((matrix) => Object.values(matrix).some((origins) => origins !== undefined), {
  message: 'A browser permission matrix requires at least one action scope',
})
const browserOriginSchema = z.string().superRefine((value, context) => {
  try {
    const origin = new URL(value)
    if (origin.protocol !== 'https:'
      || origin.username !== ''
      || origin.password !== ''
      || origin.pathname !== '/'
      || origin.search !== ''
      || origin.hash !== ''
      || origin.origin !== value) {
      context.addIssue({ code: 'custom', message: 'A canonical HTTPS origin is required' })
    }
  } catch {
    context.addIssue({ code: 'custom', message: 'A canonical HTTPS origin is required' })
  }
})
const auditTextSchema = browserAuditTextSchema
const browserTabBindingSchema = z.object({
  id: storedIdentifierSchema,
  tabId: storedIdentifierSchema,
  userId: storedIdentifierSchema,
  conversationId: storedIdentifierSchema,
  chatRunId: storedIdentifierSchema.optional(),
  executionId: storedIdentifierSchema.optional(),
  workflowId: storedIdentifierSchema,
  workflowVersion: storedIdentifierSchema,
  source: z.enum(['installed', 'development']),
  buildHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  securityFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  permissionMatrix: browserPermissionMatrixSchema,
  status: z.enum(['active', 'revoked', 'closed', 'stale']),
  terminalReason: auditTextSchema.optional(),
  createdAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().optional(),
}).strict().superRefine(({ source, buildHash }, context) => {
  if (source === 'development' && buildHash === undefined) {
    context.addIssue({ code: 'custom', path: ['buildHash'], message: 'Development browser bindings require a build hash' })
  }
  if (source === 'installed' && buildHash !== undefined) {
    context.addIssue({ code: 'custom', path: ['buildHash'], message: 'Installed browser bindings cannot include a build hash' })
  }
})
const browserTabBindingTerminalSchema = z.object({
  status: z.enum(['revoked', 'closed']),
  terminalReason: appErrorCodeSchema,
  endedAt: z.number().int().nonnegative(),
}).strict()
const browserActionAuditSchema = z.object({
  id: storedIdentifierSchema,
  bindingId: storedIdentifierSchema,
  chatRunId: storedIdentifierSchema.optional(),
  sequence: z.number().int().positive(),
  origin: browserOriginSchema,
  action: auditTextSchema,
  targetSummary: auditTextSchema,
  risk: z.enum(['safe_navigation', 'sensitive_read', 'external_action']),
  outcome: z.enum(['completed', 'blocked', 'failed', 'cancelled', 'handed_off']),
  errorCode: appErrorCodeSchema.optional(),
  createdAt: z.number().int().nonnegative(),
}).strict()
const legacyApprovalBlockSchema = z.object({
  type: z.literal('approval'),
  executionId: storedIdentifierSchema,
  workflowId: storedIdentifierSchema,
  workflowVersion: storedIdentifierSchema,
  permissionIndex: z.number().int().nonnegative(),
  capability: capabilitySchema,
  scope: runtimeCapabilityScopeSchema,
  scopeHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().superRefine(({ capability, scope }, context) => {
  if (!runtimeCapabilityPermissionSchema.safeParse({ capability, scope }).success) {
    context.addIssue({ code: 'custom', message: 'Historical approval capability scope is invalid' })
  }
})

function storedBlocks(value: string): unknown[] | undefined {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function upgradedLegacyApproval(
  messageId: string,
  index: number,
  value: unknown,
): Extract<ChatBlock, { type: 'approval' }> | undefined {
  const legacy = legacyApprovalBlockSchema.safeParse(value)
  if (!legacy.success) return undefined
  const blockId = `legacy_approval_${createHash('sha256')
    .update(JSON.stringify([messageId, index, legacy.data.executionId]))
    .digest('hex')}`
  const upgraded = chatBlockSchema.safeParse({
    ...legacy.data,
    blockId,
    state: 'invalidated',
    workflowName: legacy.data.workflowId.slice(0, 500),
    source: 'installed',
    actionSummary: '历史权限审批已失效',
  })
  return upgraded.success && upgraded.data.type === 'approval' ? upgraded.data : undefined
}

function storedApproval(value: unknown): Extract<ChatBlock, { type: 'approval' }> | undefined {
  const parsed = chatBlockSchema.safeParse(value)
  return parsed.success && parsed.data.type === 'approval' ? parsed.data : undefined
}

function upsertWorkflowApprovalOwnership(
  database: SqliteDatabase,
  messageId: string,
  role: string,
  blocks: readonly unknown[],
): void {
  if (role !== 'assistant') return
  const upsert = database.prepare(`
    INSERT INTO agent_workflow_approvals (execution_id, message_id, block_id)
    VALUES (@executionId, @messageId, @blockId)
    ON CONFLICT(execution_id) DO UPDATE SET
      message_id = excluded.message_id,
      block_id = excluded.block_id
  `)
  for (const block of blocks) {
    const approval = storedApproval(block)
    if (!approval) continue
    upsert.run({
      executionId: approval.executionId,
      messageId,
      blockId: approval.blockId,
    })
  }
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
    insert(value: Pick<Conversation, 'id' | 'title'> & Partial<Pick<Conversation, 'titleState' | 'userId' | 'createdAt' | 'updatedAt'>>): Conversation
    get(id: string): Conversation | undefined
    list(): Conversation[]
    claimLegacyAndListForUser(userId: string): Conversation[]
    renameByUser(id: string, title: string): Conversation | undefined
    claimTitleGeneration(id: string): boolean
    completeTitleGeneration(id: string, title: string): Conversation | undefined
    failTitleGeneration(id: string): void
    failPendingTitleGeneration(id: string): void
    failInterruptedTitleGenerations(): number
    updateGenerationPreferences(id: string, preferences: ConversationGenerationPreferences): Conversation | undefined
    delete(id: string): void
  }
  messages: {
    insert(value: MessageInput): Message
    insertWithAssets(value: MessageInput, assetIds: string[]): Message
    get(id: string): Message | undefined
    listForConversation(conversationId: string): Message[]
    listBeforeOrdinal(conversationId: string, beforeOrdinal: number): Message[]
    update(id: string, value: Partial<Pick<Message, 'blocks' | 'executionId'>>): Message | undefined
    replaceBlock(messageId: string, blockId: string, replacement: unknown): Message
    upgradeLegacyApprovals(): number
    invalidatePendingAgentApprovals(): number
    hasWorkflowApproval(executionId: string): boolean
    failInterruptedMediaGenerations(): number
    failInterruptedBrowserStatuses(requestIds: readonly string[]): number
  }
  conversationContexts: {
    get(conversationId: string): ConversationContextRecord | undefined
    advance(input: ConversationContextAdvanceInput): ConversationContextRecord
  }
  mediaAssets: { insert(value: MediaAssetRecord): MediaAssetRecord; get(id: string): MediaAssetRecord | undefined; listForConversation(conversationId: string): MediaAssetRecord[]; listUnclaimedBefore(timestamp: number): MediaAssetRecord[]; update(id: string, patch: MediaAssetPatch): MediaAssetRecord | undefined; delete(id: string): void }
  mediaGenerationJobs: {
    insert(value: MediaGenerationJob): MediaGenerationJob
    startSubmissionIntent(value: VideoGenerationSubmissionIntentInput): MediaGenerationJob
    bindSubmitted(id: string, input: BindSubmittedVideoInput): VideoGenerationTransition | undefined
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
    startMediaGeneration(value: MediaGenerationTurnInput): void
    get(id: string): ChatRun | undefined
    getByRequestId(requestId: string): ChatRun | undefined
    summarizeTokenUsage(input: TokenUsageQueryRecord): TokenUsageSnapshotRecord
    update(id: string, value: Partial<Omit<ChatRun, 'id' | 'conversationId' | 'requestId' | 'model' | 'startedAt' | 'userId' | 'provider'>>): ChatRun | undefined
    finalizeWithMessage(
      id: string,
      messageId: string,
      requestId: string,
      value: Pick<ChatRun, 'status' | 'endedAt'> & Partial<Pick<ChatRun, 'generationId' | 'inputTokens' | 'outputTokens' | 'costUsd' | 'errorCode'>> & { blocks: unknown[] },
    ): ChatRun
  }
  providerUsage: ProviderUsageRepository
  workflowProjects: { insert(value: WorkflowProject): WorkflowProject; get(id: string): WorkflowProject | undefined; list(): WorkflowProject[]; update(id: string, value: Partial<Omit<WorkflowProject, 'id' | 'createdAt'>>): WorkflowProject | undefined }
  installedWorkflows: { insert(value: InstalledWorkflow, files: WorkflowFile[]): InstalledWorkflow; upsert(value: InstalledWorkflow): InstalledWorkflow; get(workflowId: string, version: string): InstalledWorkflow | undefined; list(): InstalledWorkflow[]; setEnabled(workflowId: string, version: string, enabled: boolean): void; delete(workflowId: string, version: string): void }
  workflowFiles: { insert(value: WorkflowFile): WorkflowFile; list(workflowId: string, workflowVersion: string): WorkflowFile[] }
  executions: {
    insert(value: Pick<Execution, 'id' | 'status' | 'workflowId' | 'workflowVersion'> & { ownerUserId: string } & Partial<Omit<Execution, 'id' | 'ownerUserId' | 'status' | 'workflowId' | 'workflowVersion'>>): Execution
    get(id: string): Execution | undefined
    list(): Execution[]
    update(id: string, value: Partial<Omit<Execution, 'id' | 'workflowId' | 'workflowVersion' | 'createdAt'>>): Execution | undefined
    getForUser(id: string, ownerUserId: string): Execution | undefined
    listForUser(ownerUserId: string): Execution[]
    updateForUser(id: string, ownerUserId: string, value: Partial<Omit<Execution, 'id' | 'ownerUserId' | 'workflowId' | 'workflowVersion' | 'createdAt'>>): Execution | undefined
    markInterrupted(): number
  }
  conversionJobs: {
    create(input: NewConversionJob): ConversionJob
    getOwned(jobId: string, ownerUserId: string): ConversionJob | null
    listForExecution(executionId: string, ownerUserId: string): ConversionJob[]
    claimNext(ownerUserId: string): ConversionJob | null
    transition(input: {
      jobId: string
      ownerUserId: string
      expectedEpoch: number
      expectedStatuses: ConversionJobStatus[]
      patch: ConversionJobTransition
    }): boolean
    retry(input: {
      jobId: string
      ownerUserId: string
      expectedEpoch: number
      expectedStatuses: ConversionJobStatus[]
    }): boolean
    interruptCompletedForArtifactRecovery(input: {
      jobId: string
      ownerUserId: string
      expectedEpoch: number
    }): boolean
    completeWithArtifacts(input: CompleteConversionJobWithArtifactsInput): ConversionArtifact[] | null
    interruptInFlight(ownerUserId: string): number
  }
  conversionArtifacts: {
    create(input: NewConversionArtifact): ConversionArtifact
    createBatch(inputs: readonly NewConversionArtifact[]): ConversionArtifact[]
    getOwned(artifactId: string, ownerUserId: string): ConversionArtifact | null
    listForExecution(executionId: string, ownerUserId: string): ConversionArtifact[]
    listForJob(jobId: string, ownerUserId: string): ConversionArtifact[]
    markDeleted(
      artifactId: string,
      ownerUserId: string,
      expected: ConversionArtifact,
    ): boolean
  }
  executionSteps: { insert(value: ExecutionStep): ExecutionStep; list(executionId: string): ExecutionStep[]; listForUser(executionId: string, ownerUserId: string): ExecutionStep[] }
  executionLogs: { insert(value: ExecutionLogInput): ExecutionLog; list(executionId: string): ExecutionLog[]; listForUser(executionId: string, ownerUserId: string): ExecutionLog[] }
  permissionGrants: { upsert(value: PermissionGrant): PermissionGrant; get(workflowId: string, workflowVersion: string, capability: string, scopeHash: string): PermissionGrant | undefined; list(): PermissionGrant[]; delete(id: string): void }
  browserTabBindings: {
    insert(value: BrowserTabBinding): BrowserTabBinding
    get(id: string): BrowserTabBinding | undefined
    terminate(id: string, value: {
      status: 'revoked' | 'closed'
      terminalReason: AppErrorCode
      endedAt: number
    }): BrowserTabBinding | undefined
    markActiveStale(endedAt: number): number
  }
  browserActionAudits: {
    insert(value: BrowserActionAuditEntry): BrowserActionAuditEntry
    list(bindingId: string): BrowserActionAuditEntry[]
  }
  appSettings: { get(key: string): AppSetting | undefined; set(key: string, value: unknown): AppSetting; delete(key: string): void }
  encryptedSecrets: EncryptedSecretsRepository
}

const conversationColumns = 'id, title, title_state AS titleState, user_id AS userId, generation_preferences_json AS generationPreferencesJson, created_at AS createdAt, updated_at AS updatedAt'
const messageColumns = 'id, conversation_id AS conversationId, role, blocks_json AS blocksJson, provider_projection_json AS providerProjectionJson, ordinal, execution_id AS executionId, created_at AS createdAt'
const conversationContextColumns = 'conversation_id AS conversationId, summary_text AS summaryText, through_ordinal AS throughOrdinal, estimated_tokens AS estimatedTokens, updated_at AS updatedAt'
const mediaAssetColumns = 'id, conversation_id AS conversationId, message_id AS messageId, source, kind, mime_type AS mimeType, original_name AS originalName, relative_path AS relativePath, byte_size AS byteSize, width, height, duration_ms AS durationMs, sha256, provider, model, status, created_at AS createdAt, updated_at AS updatedAt'
const mediaGenerationJobColumns = 'id, conversation_id AS conversationId, assistant_message_id AS assistantMessageId, provider, model, kind, provider_job_id AS providerJobId, status, parameters_json AS parametersJson, next_poll_at AS nextPollAt, poll_attempts AS pollAttempts, error_code AS errorCode, asset_id AS assetId, created_at AS createdAt, updated_at AS updatedAt, ended_at AS endedAt'
const chatRunColumns = 'id, conversation_id AS conversationId, request_id AS requestId, model, status, generation_id AS generationId, input_tokens AS inputTokens, output_tokens AS outputTokens, cost_usd AS costUsd, error_code AS errorCode, started_at AS startedAt, ended_at AS endedAt, user_id AS userId, provider'
const providerUsageColumns = 'id, operation_key AS operationKey, user_id AS userId, provider, api_key_fingerprint AS apiKeyFingerprint, request_id AS requestId, chat_run_id AS chatRunId, generation_id AS generationId, provider_job_id AS providerJobId, model, modality, status, input_tokens AS inputTokens, output_tokens AS outputTokens, cost_usd AS costUsd, reconcile_attempts AS reconcileAttempts, next_reconcile_at AS nextReconcileAt, started_at AS startedAt, ended_at AS endedAt'
const projectColumns = 'id, name, root_path AS rootPath, manifest_json AS manifestJson, status, build_hash AS buildHash, last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt'
const installedWorkflowColumns = 'workflow_id AS workflowId, version, name, description, author, category, manifest_json AS manifestJson, install_path AS installPath, enabled, integrity_status AS integrityStatus, source, installed_at AS installedAt, updated_at AS updatedAt'
const executionColumns = 'id, owner_user_id AS ownerUserId, workflow_id AS workflowId, workflow_version AS workflowVersion, chat_run_id AS chatRunId, status, input_json AS inputJson, result_json AS resultJson, error_code AS errorCode, created_at AS createdAt, started_at AS startedAt, ended_at AS endedAt'
const conversionJobColumns = 'id, owner_user_id AS ownerUserId, execution_id AS executionId, source_kind AS sourceKind, source_id AS sourceId, target_format AS targetFormat, preset, status, epoch, progress, error_code AS errorCode, created_at AS createdAt, updated_at AS updatedAt, started_at AS startedAt, ended_at AS endedAt'
const conversionArtifactColumns = 'id, owner_user_id AS ownerUserId, execution_id AS executionId, conversion_job_id AS conversionJobId, role, display_name AS displayName, detected_format AS detectedFormat, mime_type AS mimeType, byte_size AS byteSize, sha256, relative_path AS relativePath, metadata_json AS metadataJson, status, created_at AS createdAt, updated_at AS updatedAt, deleted_at AS deletedAt'
const browserTabBindingColumns = 'id, tab_id AS tabId, user_id AS userId, conversation_id AS conversationId, chat_run_id AS chatRunId, execution_id AS executionId, workflow_id AS workflowId, workflow_version AS workflowVersion, source, build_hash AS buildHash, security_fingerprint AS securityFingerprint, permission_matrix_json AS permissionMatrixJson, status, terminal_reason AS terminalReason, created_at AS createdAt, ended_at AS endedAt'
const browserActionAuditColumns = 'id, binding_id AS bindingId, chat_run_id AS chatRunId, sequence, origin, action, target_summary AS targetSummary, risk, outcome, error_code AS errorCode, created_at AS createdAt'

interface TokenUsageRow {
  provider: ModelProviderId
  model: string
  inputTokens: number
  outputTokens: number
}

interface SparseTokenUsageRow {
  bucket: string | number
  inputTokens: number
  outputTokens: number
}

function safeTokenCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Token usage exceeded the supported range')
  }
  return value
}

function providerUsageConsistencyError(): ProviderUsageConsistencyError {
  return new ProviderUsageConsistencyError()
}

function providerUsageFromRow(row: Query): ProviderUsageEvent {
  return {
    id: row.id as string,
    operationKey: row.operationKey as string,
    userId: row.userId as string,
    provider: row.provider as ModelProviderId,
    apiKeyFingerprint: row.apiKeyFingerprint === null ? undefined : row.apiKeyFingerprint as string,
    requestId: row.requestId as string,
    chatRunId: row.chatRunId === null ? undefined : row.chatRunId as string,
    generationId: row.generationId === null ? undefined : row.generationId as string,
    providerJobId: row.providerJobId === null ? undefined : row.providerJobId as string,
    model: row.model as string,
    modality: row.modality as ProviderUsageModality,
    status: row.status as ProviderUsageStatus,
    inputTokens: row.inputTokens === null ? undefined : row.inputTokens as number,
    outputTokens: row.outputTokens === null ? undefined : row.outputTokens as number,
    costUsd: row.costUsd === null ? undefined : row.costUsd as string,
    reconcileAttempts: row.reconcileAttempts as number,
    nextReconcileAt: row.nextReconcileAt === null ? undefined : row.nextReconcileAt as number,
    startedAt: row.startedAt as number,
    endedAt: row.endedAt === null ? undefined : row.endedAt as number,
  }
}

function getProviderUsage(database: SqliteDatabase, operationKey: string): ProviderUsageEvent {
  const row = one<Query>(database, `
    SELECT ${providerUsageColumns}
    FROM provider_usage_events
    WHERE operation_key = @operationKey
  `, { operationKey })
  if (!row) throw providerUsageConsistencyError()
  return providerUsageFromRow(row)
}

function sameProviderUsageStart(stored: ProviderUsageEvent, input: ProviderUsageStart): boolean {
  return stored.operationKey === input.operationKey
    && stored.userId === input.userId
    && stored.provider === input.provider
    && stored.apiKeyFingerprint === input.apiKeyFingerprint
    && stored.requestId === input.requestId
    && stored.chatRunId === input.chatRunId
    && stored.model === input.model
    && stored.modality === input.modality
}

interface ProviderCostRow {
  provider: ModelProviderId
  model: string
  status: ProviderUsageStatus
  costUsd: string | null
  startedAt: number
}

function summarizeProviderCostPeriod(
  rows: ProviderCostRow[],
  startedAt: number,
  endedAt: number,
): ProviderCostPeriodRecord {
  const periodRows = rows.filter((row) => row.startedAt >= startedAt && row.startedAt < endedAt)
  const groups = new Map<string, ProviderCostRow[]>()
  for (const row of periodRows) {
    const key = `${row.provider}\0${row.model}`
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  }
  const summarizeRows = (values: ProviderCostRow[]) => ({
    openRouterCostUsd: addUsd(values.flatMap((row) => row.status === 'reported' && row.costUsd !== null ? [row.costUsd] : [])),
    openRouterKnownCostCount: values.filter((row) => row.status === 'reported').length,
    openRouterUnknownCostCount: values.filter((row) => row.status !== 'reported').length,
  })
  const models = Array.from(groups.values(), (values): ProviderCostModelRecord => ({
    provider: values[0].provider,
    model: values[0].model,
    ...summarizeRows(values),
  })).sort((left, right) => (
    left.provider < right.provider ? -1
      : left.provider > right.provider ? 1
        : left.model < right.model ? -1
          : left.model > right.model ? 1 : 0
  ))
  return { ...summarizeRows(periodRows), models }
}

function trendBucketSql(granularity: TokenUsageGranularityRecord): string {
  if (granularity === 'hour') {
    return 'CAST((started_at - @startedAt) / 3600000 AS INTEGER)'
  }
  if (granularity === 'day') {
    return "strftime('%Y-%m-%d', started_at / 1000, 'unixepoch', 'localtime')"
  }
  return "strftime('%Y-%m', started_at / 1000, 'unixepoch', 'localtime')"
}

function summarizeTokenUsagePeriod(
  database: SqliteDatabase,
  userId: string,
  startedAt: number,
  endedAt: number,
  granularity: TokenUsageGranularityRecord,
): TokenUsagePeriodRecord {
  const parameters = {
    userId,
    startedAt: safeTokenCount(startedAt),
    endedAt: safeTokenCount(endedAt),
  }
  const models = many<TokenUsageRow>(database, `
    SELECT
      provider,
      model,
      SUM(COALESCE(input_tokens, 0)) AS inputTokens,
      SUM(COALESCE(output_tokens, 0)) AS outputTokens
    FROM chat_runs
    WHERE user_id = @userId
      AND provider IS NOT NULL
      AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL)
      AND started_at >= @startedAt
      AND started_at < @endedAt
    GROUP BY provider, model
  `, parameters).map((row): ModelTokenUsageRecord => {
    const inputTokens = safeTokenCount(row.inputTokens)
    const outputTokens = safeTokenCount(row.outputTokens)
    return {
      provider: row.provider,
      model: row.model,
      inputTokens,
      outputTokens,
      totalTokens: safeTokenCount(inputTokens + outputTokens),
    }
  })
    .sort((left, right) => right.totalTokens - left.totalTokens
      || (left.model < right.model ? -1 : left.model > right.model ? 1 : 0)
      || (left.provider < right.provider ? -1 : left.provider > right.provider ? 1 : 0))

  const bucket = trendBucketSql(granularity)
  const trend = many<SparseTokenUsageRow>(database, `
    SELECT
      ${bucket} AS bucket,
      SUM(COALESCE(input_tokens, 0)) AS inputTokens,
      SUM(COALESCE(output_tokens, 0)) AS outputTokens
    FROM chat_runs
    WHERE user_id = @userId
      AND provider IS NOT NULL
      AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL)
      AND started_at >= @startedAt
      AND started_at < @endedAt
    GROUP BY ${bucket}
    ORDER BY MIN(started_at)
  `, parameters).map((row): TokenUsageTrendRecord => {
    const inputTokens = safeTokenCount(row.inputTokens)
    const outputTokens = safeTokenCount(row.outputTokens)
    return {
      bucket: String(row.bucket),
      inputTokens,
      outputTokens,
      totalTokens: safeTokenCount(inputTokens + outputTokens),
    }
  })

  const inputTokens = safeTokenCount(models.reduce((sum, model) => sum + model.inputTokens, 0))
  const outputTokens = safeTokenCount(models.reduce((sum, model) => sum + model.outputTokens, 0))
  const trendInput = safeTokenCount(trend.reduce((sum, point) => sum + point.inputTokens, 0))
  const trendOutput = safeTokenCount(trend.reduce((sum, point) => sum + point.outputTokens, 0))
  if (inputTokens !== trendInput || outputTokens !== trendOutput) {
    throw new Error('Token usage aggregates are inconsistent')
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens: safeTokenCount(inputTokens + outputTokens),
    models,
    trend,
  }
}

function messageFromRow(row: Query): Message {
  const providerProjection = parseMessageProviderProjection(row.providerProjectionJson)
  return {
    ...row,
    blocks: parse(row.blocksJson as string) as unknown[],
    ordinal: positiveIntegerSchema.parse(row.ordinal),
    ...(providerProjection === undefined ? {} : { providerProjection }),
  } as Message
}

function parseMessageProviderProjection(value: unknown): MessageProviderProjection | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('Message Provider projection is invalid')
  const parsed = z.object({
    kind: z.literal('local_conversion'),
    content: z.string().max(512),
  }).strict().parse(parse(value))
  const match = /^任务：选择并调用具备 file\.convert 能力的本地工作流。\n附件数量：(?<count>[1-5])\n附件索引：(?<indexes>\d(?:, \d)*)\n目标格式：(?<target>[a-z0-9]+)\n禁止读取附件内容或调用非 file\.convert 工具。$/u.exec(parsed.content)
  if (!match?.groups) throw new Error('Message Provider projection is invalid')
  const count = Number(match.groups.count)
  const indexes = match.groups.indexes!.split(', ').map(Number)
  const expectedIndexes = Array.from({ length: count }, (_, index) => index)
  const target = match.groups.target!
  if (indexes.length !== count
    || indexes.some((index, position) => index !== expectedIndexes[position])
    || !conversionTargetFormatSchema.safeParse(target).success) {
    throw new Error('Message Provider projection is invalid')
  }
  return Object.freeze({ kind: parsed.kind, content: parsed.content })
}

function conversationContextFromRow(row: Query): ConversationContextRecord {
  return {
    conversationId: row.conversationId as string,
    summaryText: row.summaryText as string,
    throughOrdinal: nonnegativeIntegerSchema.parse(row.throughOrdinal),
    estimatedTokens: nonnegativeIntegerSchema.parse(row.estimatedTokens),
    updatedAt: row.updatedAt as number,
  }
}

function conversationFromRow(row: Query): Conversation {
  const preferences = parse(row.generationPreferencesJson as string | null)
  const userId = optional<string>(row.userId)
  return {
    id: row.id as string,
    title: row.title as string,
    titleState: row.titleState as Conversation['titleState'],
    ...(userId === undefined ? {} : { userId }),
    ...(preferences === undefined ? {} : { generationPreferences: conversationGenerationPreferencesSchema.parse(preferences) }),
    createdAt: row.createdAt as number,
    updatedAt: row.updatedAt as number,
  }
}

function optional<T>(value: unknown): T | undefined {
  return value === null || value === undefined ? undefined : value as T
}

function chatRunFromRow(row: Query): ChatRun {
  return {
    id: row.id as string,
    conversationId: row.conversationId as string,
    requestId: row.requestId as string,
    model: row.model as string,
    status: row.status as string,
    generationId: optional<string>(row.generationId),
    inputTokens: optional<number>(row.inputTokens),
    outputTokens: optional<number>(row.outputTokens),
    costUsd: optional<string>(row.costUsd),
    errorCode: optional<string>(row.errorCode),
    startedAt: row.startedAt as number,
    endedAt: optional<number>(row.endedAt),
    userId: optional<string>(row.userId),
    provider: optional<ModelProviderId>(row.provider),
  }
}

function chatRunOwnership(value: Pick<ChatRun, 'userId' | 'provider'>): {
  userId: string | null
  provider: ModelProviderId | null
} {
  if (value.userId !== undefined && value.provider === undefined) {
    throw new Error('Owned chat run requires a provider')
  }
  return {
    userId: value.userId ?? null,
    provider: value.provider ?? null,
  }
}

function mediaAssetFromRow(row: Query): MediaAssetRecord {
  return mediaAssetRecordSchema.parse({
    id: row.id as string,
    conversationId: row.conversationId as string,
    messageId: optional<string>(row.messageId),
    source: row.source as MediaAssetSource,
    kind: row.kind as AttachmentKind,
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

function nextMessageOrdinal(database: SqliteDatabase, conversationId: string): number {
  const row = one<{ ordinal: number }>(database, `
    SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal
    FROM messages
    WHERE conversation_id = @conversationId
  `, { conversationId })
  if (!row || !Number.isSafeInteger(row.ordinal) || row.ordinal < 1) {
    throw new Error('Message ordinal is invalid')
  }
  return row.ordinal
}

function insertMessage(
  database: SqliteDatabase,
  value: MessageInput,
  blocks: unknown[] = value.blocks,
): Message {
  const ordinal = nextMessageOrdinal(database, value.conversationId)
  database.prepare('INSERT INTO messages (id, conversation_id, role, blocks_json, provider_projection_json, ordinal, execution_id, created_at) VALUES (@id, @conversationId, @role, @blocksJson, @providerProjectionJson, @ordinal, @executionId, @createdAt)').run({
    ...value,
    blocksJson: JSON.stringify(blocks),
    providerProjectionJson: value.providerProjection === undefined
      ? null
      : JSON.stringify(value.providerProjection),
    ordinal,
    executionId: value.executionId ?? null,
  })
  upsertWorkflowApprovalOwnership(database, value.id, value.role, blocks)
  return { ...value, blocks, ordinal }
}

function insertMessageWithAssets(
  database: SqliteDatabase,
  value: MessageInput,
  assetIds: readonly string[],
): Message {
  const blocks = validateMessageWithAssets(database, value, assetIds)
  const message = insertMessage(database, value, blocks)
  const claim = database.prepare("UPDATE media_assets SET message_id = @messageId, updated_at = @updatedAt WHERE id = @assetId AND message_id IS NULL AND status = 'ready'")
  for (const assetId of assetIds) {
    if (claim.run({
      messageId: value.id,
      assetId,
      updatedAt: now(),
    }).changes !== 1) throw new Error('Media asset could not be claimed')
  }
  return message
}

function validateVideoGenerationTurn(
  database: SqliteDatabase,
  value: VideoGenerationSubmissionIntentInput,
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

function validateMediaGenerationTurn(
  database: SqliteDatabase,
  value: MediaGenerationTurnInput,
): ChatBlock[] {
  const { userMessage, assistantMessage, run } = value
  const assistantBlocks = chatBlockSchema.array().parse(assistantMessage.blocks)
  const block = assistantBlocks[0]
  for (const id of [
    userMessage.id,
    assistantMessage.id,
    run.id,
    run.requestId,
  ]) identifierSchema.parse(id)
  if (
    userMessage.role !== 'user'
    || assistantMessage.role !== 'assistant'
    || userMessage.id === assistantMessage.id
    || userMessage.conversationId !== assistantMessage.conversationId
    || run.conversationId !== assistantMessage.conversationId
    || run.status !== 'running'
    || assistantBlocks.length !== 1
    || block?.type !== 'media_generation'
    || block.jobId !== run.requestId
    || (block.kind !== 'image' && block.kind !== 'audio')
    || block.status !== 'in_progress'
    || block.errorCode !== undefined
  ) throw new Error('Media generation turn identity does not match')
  if (!one(database, 'SELECT id FROM conversations WHERE id = @id', {
    id: run.conversationId,
  })) throw new Error('Media generation conversation not found')
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
  const row = one<Query>(
    database,
    `SELECT ${chatRunColumns} FROM chat_runs WHERE request_id = @requestId`,
    { requestId: job.id },
  )
  const run = row === undefined ? undefined : chatRunFromRow(row)
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
    || isVideoSubmissionIntent(job)
    || !['pending', 'in_progress', 'downloading', 'paused'].includes(job.status)
  ) return undefined
  const runRow = one<Query>(
    database,
    `SELECT ${chatRunColumns} FROM chat_runs WHERE request_id = @requestId`,
    { requestId: job.id },
  )
  const run = runRow === undefined ? undefined : chatRunFromRow(runRow)
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
  return {
    ...row,
    ownerUserId: row.ownerUserId === null ? undefined : row.ownerUserId,
    input: parse(row.inputJson as string),
    result: parse(row.resultJson as string | null),
  } as Execution
}

function conversionJobFromRow(row: Query): ConversionJob {
  return {
    id: row.id as string,
    ownerUserId: row.ownerUserId as string,
    executionId: row.executionId as string,
    sourceKind: row.sourceKind as ConversionJob['sourceKind'],
    sourceId: row.sourceId as string,
    targetFormat: row.targetFormat as ConversionTargetFormat,
    preset: optional<ConversionPreset>(row.preset),
    status: row.status as ConversionJobStatus,
    epoch: row.epoch as number,
    progress: row.progress as number,
    errorCode: optional<AppErrorCode>(row.errorCode),
    createdAt: row.createdAt as number,
    updatedAt: row.updatedAt as number,
    startedAt: optional<number>(row.startedAt),
    endedAt: optional<number>(row.endedAt),
  }
}

function conversionArtifactFromRow(row: Query): ConversionArtifact {
  return {
    id: row.id as string,
    ownerUserId: row.ownerUserId as string,
    executionId: row.executionId as string,
    conversionJobId: optional<string>(row.conversionJobId),
    role: row.role as ConversionArtifact['role'],
    displayName: row.displayName as string,
    detectedFormat: row.detectedFormat as string,
    mimeType: row.mimeType as string,
    byteSize: row.byteSize as number,
    sha256: row.sha256 as string,
    relativePath: row.relativePath as string,
    metadata: row.metadataJson === null ? undefined : conversionArtifactMetadataSchema.parse(parse(row.metadataJson as string)),
    status: row.status as ConversionArtifact['status'],
    createdAt: row.createdAt as number,
    updatedAt: row.updatedAt as number,
    deletedAt: optional<number>(row.deletedAt),
  }
}

function conversionArtifactMetadata(value: unknown): ConversionArtifactMetadata | undefined {
  if (value === undefined) return undefined
  const parsed = conversionArtifactMetadataSchema.safeParse(value)
  if (!parsed.success) throw new Error('Invalid conversion artifact metadata')
  return parsed.data
}

function relativeConversionArtifactPath(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.startsWith('/')
    || value.startsWith('\\')
    || /^[A-Za-z]:/.test(value)
    || value.includes('\0')
  ) throw new Error('Invalid conversion artifact path')
  return value
}

function insertConversionArtifact(
  database: SqliteDatabase,
  input: NewConversionArtifact,
): ConversionArtifact {
  const createdAt = input.createdAt ?? now()
  const updatedAt = input.updatedAt ?? createdAt
  const status = input.status ?? 'ready'
  const metadata = conversionArtifactMetadata(input.metadata)
  const relativePath = relativeConversionArtifactPath(input.relativePath)
  const inserted = database.prepare(`
    INSERT INTO conversion_artifacts (
      id, owner_user_id, execution_id, conversion_job_id, role, display_name,
      detected_format, mime_type, byte_size, sha256, relative_path, metadata_json,
      status, created_at, updated_at, deleted_at
    )
    SELECT
      @id, @ownerUserId, @executionId, @conversionJobId, @role, @displayName,
      @detectedFormat, @mimeType, @byteSize, @sha256, @relativePath, @metadataJson,
      @status, @createdAt, @updatedAt, @deletedAt
    WHERE EXISTS (
      SELECT 1 FROM executions WHERE id = @executionId AND owner_user_id = @ownerUserId
    ) AND (
      @conversionJobId IS NULL OR EXISTS (
        SELECT 1 FROM conversion_jobs
        WHERE id = @conversionJobId AND owner_user_id = @ownerUserId AND execution_id = @executionId
      )
    )
  `).run({
    ...input,
    conversionJobId: input.conversionJobId ?? null,
    metadataJson: metadata === undefined ? null : JSON.stringify(metadata),
    relativePath,
    status,
    createdAt,
    updatedAt,
    deletedAt: input.deletedAt ?? (status === 'deleted' ? updatedAt : null),
  }).changes
  if (inserted !== 1) throw new Error('Conversion artifact ownership mismatch')
  const row = one<Query>(database, `SELECT ${conversionArtifactColumns} FROM conversion_artifacts WHERE id = @id`, { id: input.id })
  if (!row) throw new Error('Conversion artifact was not created')
  return conversionArtifactFromRow(row)
}

function permissionFromRow(row: Query): PermissionGrant {
  return { ...row, scope: parse(row.scopeJson as string) } as PermissionGrant
}

function browserTabBindingFromRow(row: Query): BrowserTabBinding {
  const { permissionMatrixJson, ...binding } = row
  return browserTabBindingSchema.parse({
    ...binding,
    chatRunId: row.chatRunId === null ? undefined : row.chatRunId,
    executionId: row.executionId === null ? undefined : row.executionId,
    buildHash: row.buildHash === null ? undefined : row.buildHash,
    terminalReason: row.terminalReason === null ? undefined : row.terminalReason,
    endedAt: row.endedAt === null ? undefined : row.endedAt,
    permissionMatrix: parse(permissionMatrixJson as string),
  })
}

function browserActionAuditFromRow(row: Query): BrowserActionAuditEntry {
  return browserActionAuditSchema.parse({
    ...row,
    chatRunId: row.chatRunId === null ? undefined : row.chatRunId,
    errorCode: row.errorCode === null ? undefined : row.errorCode,
  })
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
        const titleState = value.titleState ?? 'user_named'
        transaction(database, () => database.prepare('INSERT INTO conversations (id, title, title_state, user_id, created_at, updated_at) VALUES (@id, @title, @titleState, @userId, @createdAt, @updatedAt)').run({ ...value, titleState, userId: value.userId ?? null, createdAt, updatedAt }))
        return { id: value.id, title: value.title, titleState, ...(value.userId === undefined ? {} : { userId: value.userId }), createdAt, updatedAt }
      },
      get: (id) => { const row = one<Query>(database, `SELECT ${conversationColumns} FROM conversations WHERE id = @id`, { id }); return row && conversationFromRow(row) },
      list: () => many<Query>(database, `SELECT ${conversationColumns} FROM conversations ORDER BY updated_at DESC, id`).map(conversationFromRow),
      claimLegacyAndListForUser: (userId) => transaction(database, () => {
        database.prepare('UPDATE conversations SET user_id = @userId WHERE user_id IS NULL').run({ userId })
        return many<Query>(database, `SELECT ${conversationColumns} FROM conversations WHERE user_id = @userId ORDER BY updated_at DESC, id`, { userId }).map(conversationFromRow)
      }),
      renameByUser(id, title) {
        const updatedAt = now()
        transaction(database, () => database.prepare("UPDATE conversations SET title = @title, title_state = 'user_named', updated_at = @updatedAt WHERE id = @id").run({ id, title, updatedAt }))
        const row = one<Query>(database, `SELECT ${conversationColumns} FROM conversations WHERE id = @id`, { id })
        return row && conversationFromRow(row)
      },
      claimTitleGeneration: (id) => transaction(database, () => (
        database.prepare("UPDATE conversations SET title_state = 'generating' WHERE id = @id AND title_state = 'pending'")
          .run({ id }).changes === 1
      )),
      completeTitleGeneration(id, title) {
        return transaction(database, () => {
          const updatedAt = now()
          const result = database.prepare("UPDATE conversations SET title = @title, title_state = 'ai_named', updated_at = @updatedAt WHERE id = @id AND title_state = 'generating'")
            .run({ id, title, updatedAt })
          if (result.changes !== 1) return undefined
          const row = one<Query>(database, `SELECT ${conversationColumns} FROM conversations WHERE id = @id`, { id })
          return row && conversationFromRow(row)
        })
      },
      failTitleGeneration: (id) => {
        transaction(database, () => database.prepare("UPDATE conversations SET title_state = 'failed' WHERE id = @id AND title_state = 'generating'").run({ id }))
      },
      failPendingTitleGeneration: (id) => {
        transaction(database, () => database.prepare("UPDATE conversations SET title_state = 'failed' WHERE id = @id AND title_state = 'pending'").run({ id }))
      },
      failInterruptedTitleGenerations: () => transaction(database, () => (
        database.prepare("UPDATE conversations SET title_state = 'failed' WHERE title_state = 'generating'")
          .run().changes
      )),
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
        return transaction(database, () => insertMessage(database, value))
      },
      insertWithAssets(value, assetIds) {
        transaction(database, () => insertMessageWithAssets(database, value, assetIds))
        const stored = this.get(value.id)
        if (!stored) throw new Error('Message was not persisted')
        return stored
      },
      get: (id) => { const row = one<Query>(database, `SELECT ${messageColumns} FROM messages WHERE id = @id`, { id }); return row && messageFromRow(row) },
      listForConversation: (conversationId) => many<Query>(database, `SELECT ${messageColumns} FROM messages WHERE conversation_id = @conversationId ORDER BY ordinal`, { conversationId }).map(messageFromRow),
      listBeforeOrdinal: (conversationId, beforeOrdinal) => many<Query>(database, `
        SELECT ${messageColumns}
        FROM messages
        WHERE conversation_id = @conversationId AND ordinal < @beforeOrdinal
        ORDER BY ordinal
      `, { conversationId, beforeOrdinal }).map(messageFromRow),
      update(id, value) {
        return transaction(database, () => {
          database.prepare('UPDATE messages SET blocks_json = COALESCE(@blocksJson, blocks_json), execution_id = COALESCE(@executionId, execution_id) WHERE id = @id').run({ id, blocksJson: value.blocks === undefined ? null : JSON.stringify(value.blocks), executionId: value.executionId ?? null })
          const row = one<Query>(database, `SELECT ${messageColumns} FROM messages WHERE id = @id`, { id })
          if (row && value.blocks !== undefined) {
            upsertWorkflowApprovalOwnership(database, id, row.role as string, value.blocks)
          }
          return row && messageFromRow(row)
        })
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
          upsertWorkflowApprovalOwnership(database, messageId, row.role as string, blocks)
          const stored = one<Query>(database, `SELECT ${messageColumns} FROM messages WHERE id = @id`, { id: messageId })
          if (!stored) throw new Error('Message not found')
          return messageFromRow(stored)
        })
      },
      upgradeLegacyApprovals() {
        return transaction(database, () => {
          let upgraded = 0
          const normalized: Array<{ id: string; blocks: unknown[] }> = []
          for (const row of many<Query>(database, "SELECT id, blocks_json AS blocksJson FROM messages WHERE role = 'assistant'")) {
            const blocks = storedBlocks(row.blocksJson as string)
            if (!blocks) continue
            let changed = false
            for (const [index, block] of blocks.entries()) {
              if (chatBlockSchema.safeParse(block).success) continue
              const replacement = upgradedLegacyApproval(row.id as string, index, block)
              if (!replacement) continue
              blocks[index] = replacement
              upgraded += 1
              changed = true
            }
            if (changed) {
              database.prepare('UPDATE messages SET blocks_json = @blocksJson WHERE id = @id')
                .run({ id: row.id, blocksJson: JSON.stringify(blocks) })
            }
            normalized.push({ id: row.id as string, blocks })
          }
          for (const row of normalized) {
            upsertWorkflowApprovalOwnership(database, row.id, 'assistant', row.blocks)
          }
          return upgraded
        })
      },
      invalidatePendingAgentApprovals() {
        return transaction(database, () => {
          let invalidated = 0
          for (const row of many<Query>(database, "SELECT id, blocks_json AS blocksJson FROM messages WHERE role = 'assistant'")) {
            const blocks = storedBlocks(row.blocksJson as string)
            if (!blocks) continue
            let changed = false
            for (const [index, block] of blocks.entries()) {
              const approval = storedApproval(block)
              if (!approval || approval.state !== 'pending') continue
              blocks[index] = { ...approval, state: 'invalidated' }
              invalidated += 1
              changed = true
            }
            if (changed) {
              database.prepare('UPDATE messages SET blocks_json = @blocksJson WHERE id = @id')
                .run({ id: row.id, blocksJson: JSON.stringify(blocks) })
            }
          }
          return invalidated
        })
      },
      hasWorkflowApproval(executionId) {
        return one<{ owned: number }>(database, `
          SELECT 1 AS owned
          FROM agent_workflow_approvals
          WHERE execution_id = @executionId
        `, { executionId }) !== undefined
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
      failInterruptedBrowserStatuses(requestIds) {
        return transaction(database, () => {
          const interrupted = new Set(requestIds)
          if (interrupted.size === 0) return 0
          let failed = 0
          for (const row of many<Query>(database, "SELECT id, blocks_json AS blocksJson FROM messages WHERE role = 'assistant'")) {
            const blocks = storedBlocks(row.blocksJson as string)
            if (!blocks) continue
            let changed = false
            for (const [index, block] of blocks.entries()) {
              const parsed = chatBlockSchema.safeParse(block)
              if (
                !parsed.success
                || parsed.data.type !== 'browser_status'
                || !interrupted.has(parsed.data.requestId)
                || (parsed.data.state !== 'inspecting' && parsed.data.state !== 'acting')
              ) continue
              blocks[index] = {
                ...parsed.data,
                state: 'failed',
                actionSummary: '应用已重启，浏览器自动操作已中断',
                errorCode: 'INTERNAL_ERROR',
              }
              failed += 1
              changed = true
            }
            if (changed) {
              database.prepare('UPDATE messages SET blocks_json = @blocksJson WHERE id = @id')
                .run({ id: row.id, blocksJson: JSON.stringify(blocks) })
            }
          }
          return failed
        })
      },
    },
    conversationContexts: {
      get: (conversationId) => {
        const row = one<Query>(database, `
          SELECT ${conversationContextColumns}
          FROM conversation_contexts
          WHERE conversation_id = @conversationId
        `, { conversationId })
        return row && conversationContextFromRow(row)
      },
      advance(input) {
        return transaction(database, () => {
          const result = input.expectedThroughOrdinal === 0
            ? database.prepare('INSERT INTO conversation_contexts (conversation_id, summary_text, through_ordinal, estimated_tokens, updated_at) SELECT @conversationId, @summaryText, @throughOrdinal, @estimatedTokens, @updatedAt WHERE NOT EXISTS (SELECT 1 FROM conversation_contexts WHERE conversation_id = @conversationId)').run(input)
            : database.prepare('UPDATE conversation_contexts SET summary_text = @summaryText, through_ordinal = @throughOrdinal, estimated_tokens = @estimatedTokens, updated_at = @updatedAt WHERE conversation_id = @conversationId AND through_ordinal = @expectedThroughOrdinal').run(input)
          if (result.changes !== 1) throw new Error('Conversation context checkpoint changed')
          const row = one<Query>(database, `
            SELECT ${conversationContextColumns}
            FROM conversation_contexts
            WHERE conversation_id = @conversationId
          `, { conversationId: input.conversationId })
          if (!row) throw new Error('Conversation context was not persisted')
          return conversationContextFromRow(row)
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
      startSubmissionIntent(value) {
        const { userMessage, userAssetIds, assistantMessage, run, job } = value
        if (!hasVideoSubmissionIntentMarker(job.parameters)) {
          throw new Error('Video submission intent marker is required')
        }
        transaction(database, () => {
          const assistantBlocks = validateVideoGenerationTurn(database, value)
          insertMessageWithAssets(database, userMessage, userAssetIds)
          database.prepare('INSERT INTO chat_runs (id, conversation_id, user_id, provider, request_id, model, status, generation_id, input_tokens, output_tokens, cost_usd, error_code, started_at, ended_at) VALUES (@id, @conversationId, @userId, @provider, @requestId, @model, @status, NULL, NULL, NULL, NULL, NULL, @startedAt, NULL)').run({ ...run, ...chatRunOwnership(run) })
          insertMessage(database, assistantMessage, assistantBlocks)
          database.prepare('INSERT INTO media_generation_jobs (id, conversation_id, assistant_message_id, provider, model, kind, provider_job_id, status, parameters_json, next_poll_at, poll_attempts, error_code, asset_id, created_at, updated_at, ended_at) VALUES (@id, @conversationId, @assistantMessageId, @provider, @model, @kind, @providerJobId, @status, @parametersJson, NULL, @pollAttempts, NULL, NULL, @createdAt, @updatedAt, NULL)').run({
            ...job,
            providerJobId: VIDEO_SUBMISSION_INTENT_PROVIDER_JOB_ID,
            parametersJson: JSON.stringify(job.parameters),
            pollAttempts: job.pollAttempts ?? 0,
          })
        })
        const stored = this.get(job.id)
        if (!stored || !isVideoSubmissionIntent(stored)) {
          throw new Error('Video submission intent was not persisted')
        }
        return stored
      },
      bindSubmitted(id, input) {
        identifierSchema.parse(id)
        identifierSchema.parse(input.providerJobId)
        if (
          input.providerJobId === VIDEO_SUBMISSION_INTENT_PROVIDER_JOB_ID
          || (input.status !== 'pending' && input.status !== 'in_progress')
          || !Number.isFinite(input.nextPollAt)
          || !Number.isFinite(input.updatedAt)
        ) throw new Error('Invalid submitted video job')
        return transaction(database, () => {
          const row = one<Query>(database, `SELECT ${mediaGenerationJobColumns} FROM media_generation_jobs WHERE id = @id`, { id })
          if (!row) return undefined
          const job = mediaGenerationJobFromRow(row)
          if (job.status !== 'pending' || !isVideoSubmissionIntent(job)) return undefined
          const active = activeVideoBlock(database, job)
          videoRun(database, job)
          const replacement: Extract<ChatBlock, { type: 'media_generation' }> = {
            ...active.block,
            status: input.status,
          }
          delete replacement.errorCode
          const message = updateVideoBlock(
            database,
            active.message.id,
            active.blocks,
            active.index,
            replacement,
          )
          if (database.prepare(`
            UPDATE media_generation_jobs
            SET provider_job_id = @providerJobId,
                status = @status,
                parameters_json = @parametersJson,
                next_poll_at = @nextPollAt,
                poll_attempts = 0,
                error_code = NULL,
                updated_at = @updatedAt
            WHERE id = @id
              AND provider_job_id = @intentProviderJobId
              AND status = 'pending'
          `).run({
            id,
            providerJobId: input.providerJobId,
            status: input.status,
            parametersJson: JSON.stringify(input.parameters),
            nextPollAt: input.nextPollAt,
            updatedAt: input.updatedAt,
            intentProviderJobId: VIDEO_SUBMISSION_INTENT_PROVIDER_JOB_ID,
          }).changes !== 1) throw new Error('Video provider bind was lost')
          const stored = this.get(id)
          if (!stored) throw new Error('Video job was not persisted')
          return { job: stored, message, block: replacement }
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
          database.prepare('INSERT INTO chat_runs (id, conversation_id, user_id, provider, request_id, model, status, generation_id, input_tokens, output_tokens, cost_usd, error_code, started_at, ended_at) VALUES (@id, @conversationId, @userId, @provider, @requestId, @model, @status, NULL, NULL, NULL, NULL, NULL, @startedAt, NULL)').run({ ...run, ...chatRunOwnership(run) })
          insertMessage(database, assistantMessage, assistantBlocks)
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
          const failedRequestIds = new Set<string>()
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
              const id = row.id as string
              failJob.run({ id, endedAt })
              failedRequestIds.add(id)
              continue
            }
            if (resumableVideoAssociation(database, job)) {
              preservedRequestIds.push(job.id)
              continue
            }
            failJob.run({ id: job.id, endedAt })
            failedRequestIds.add(job.id)
          }
          for (const requestId of failedRequestIds) {
            database.prepare(`
              UPDATE chat_runs
              SET status = 'failed', error_code = 'INTERNAL_ERROR', ended_at = @endedAt
              WHERE request_id = @requestId AND status = 'running'
            `).run({ requestId, endedAt })
          }
          for (const row of many<Query>(database, 'SELECT id, blocks_json AS blocksJson FROM messages')) {
            let blocks: ChatBlock[]
            try {
              blocks = chatBlockSchema.array().parse(parse(row.blocksJson as string))
            } catch {
              continue
            }
            let changed = false
            for (const block of blocks) {
              if (block.type !== 'media_generation' || !failedRequestIds.has(block.jobId)) continue
              block.status = 'failed'
              block.errorCode = 'MEDIA_GENERATION_FAILED'
              changed = true
            }
            if (changed) {
              database.prepare('UPDATE messages SET blocks_json = @blocksJson WHERE id = @id')
                .run({ id: row.id, blocksJson: JSON.stringify(blocks) })
            }
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
        transaction(database, () => database.prepare('INSERT INTO chat_runs (id, conversation_id, user_id, provider, request_id, model, status, generation_id, input_tokens, output_tokens, cost_usd, error_code, started_at, ended_at) VALUES (@id, @conversationId, @userId, @provider, @requestId, @model, @status, @generationId, @inputTokens, @outputTokens, @costUsd, @errorCode, @startedAt, @endedAt)').run({
          generationId: null, inputTokens: null, outputTokens: null, costUsd: null, errorCode: null, endedAt: null, ...value, ...chatRunOwnership(value),
        }))
        return value
      },
      startMediaGeneration(value) {
        const { userMessage, userAssetIds, assistantMessage, run } = value
        transaction(database, () => {
          const assistantBlocks = validateMediaGenerationTurn(database, value)
          insertMessageWithAssets(database, userMessage, userAssetIds)
          database.prepare('INSERT INTO chat_runs (id, conversation_id, user_id, provider, request_id, model, status, generation_id, input_tokens, output_tokens, cost_usd, error_code, started_at, ended_at) VALUES (@id, @conversationId, @userId, @provider, @requestId, @model, @status, NULL, NULL, NULL, NULL, NULL, @startedAt, NULL)').run({ ...run, ...chatRunOwnership(run) })
          insertMessage(database, assistantMessage, assistantBlocks)
        })
      },
      get: (id) => {
        const row = one<Query>(database, `SELECT ${chatRunColumns} FROM chat_runs WHERE id = @id`, { id })
        return row === undefined ? undefined : chatRunFromRow(row)
      },
      getByRequestId: (requestId) => {
        const row = one<Query>(database, `SELECT ${chatRunColumns} FROM chat_runs WHERE request_id = @requestId`, { requestId })
        return row === undefined ? undefined : chatRunFromRow(row)
      },
      summarizeTokenUsage(input) {
        const query = {
          userId: input.userId,
          yesterdayStartedAt: safeTokenCount(input.yesterdayStartedAt),
          todayStartedAt: safeTokenCount(input.todayStartedAt),
          weekStartedAt: safeTokenCount(input.weekStartedAt),
          monthStartedAt: safeTokenCount(input.monthStartedAt),
          endedAt: safeTokenCount(input.endedAt),
        }
        return database.transaction((): TokenUsageSnapshotRecord => {
          const first = one<{ startedAt: number | null }>(database, `
            SELECT MIN(started_at) AS startedAt
            FROM chat_runs
            WHERE user_id = @userId
              AND provider IS NOT NULL
              AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL)
              AND started_at < @endedAt
          `, { userId: query.userId, endedAt: query.endedAt })
          const allTimeStartedAt = first?.startedAt === null || first?.startedAt === undefined
            ? undefined
            : safeTokenCount(first.startedAt)
          const allTimeStart = allTimeStartedAt ?? query.endedAt
          return {
            ...(allTimeStartedAt === undefined ? {} : { allTimeStartedAt }),
            today: summarizeTokenUsagePeriod(database, query.userId, query.todayStartedAt, query.endedAt, 'hour'),
            yesterday: summarizeTokenUsagePeriod(database, query.userId, query.yesterdayStartedAt, query.todayStartedAt, 'hour'),
            week: summarizeTokenUsagePeriod(database, query.userId, query.weekStartedAt, query.endedAt, 'day'),
            month: summarizeTokenUsagePeriod(database, query.userId, query.monthStartedAt, query.endedAt, 'day'),
            allTime: summarizeTokenUsagePeriod(database, query.userId, allTimeStart, query.endedAt, 'month'),
          }
        })()
      },
      update(id, value) {
        transaction(database, () => database.prepare('UPDATE chat_runs SET status = COALESCE(@status, status), generation_id = COALESCE(@generationId, generation_id), input_tokens = COALESCE(@inputTokens, input_tokens), output_tokens = COALESCE(@outputTokens, output_tokens), cost_usd = COALESCE(@costUsd, cost_usd), error_code = COALESCE(@errorCode, error_code), ended_at = COALESCE(@endedAt, ended_at) WHERE id = @id').run({
          id, status: null, generationId: null, inputTokens: null, outputTokens: null, costUsd: null, errorCode: null, endedAt: null, ...value,
        }))
        const row = one<Query>(database, `SELECT ${chatRunColumns} FROM chat_runs WHERE id = @id`, { id })
        return row === undefined ? undefined : chatRunFromRow(row)
      },
      finalizeWithMessage(id, messageId, requestId, value) {
        const blocks = chatBlockSchema.array().parse(value.blocks)
        assertUniqueFinalMediaBlocks(blocks)
        return transaction(database, () => {
          const messageRow = one<Query>(database, `SELECT ${messageColumns} FROM messages WHERE id = @id`, {
            id: messageId,
          })
          if (!messageRow || messageRow.role !== 'assistant') throw new Error('Assistant message not found')
          const runRow = one<Query>(database, `SELECT ${chatRunColumns} FROM chat_runs WHERE id = @id`, { id })
          const chatRun = runRow === undefined ? undefined : chatRunFromRow(runRow)
          if (
            !chatRun
            || chatRun.conversationId !== messageRow.conversationId
            || chatRun.requestId !== requestId
            || chatRun.status !== 'running'
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
              { requestId, model: chatRun.model },
            )
          }
          const message = database.prepare('UPDATE messages SET blocks_json = @blocksJson WHERE id = @messageId').run({
            messageId,
            blocksJson: JSON.stringify(blocks),
          })
          if (message.changes !== 1) throw new Error('Assistant message not found')
          upsertWorkflowApprovalOwnership(database, messageId, messageRow.role as string, blocks)
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
          const storedRow = one<Query>(database, `SELECT ${chatRunColumns} FROM chat_runs WHERE id = @id`, { id })
          if (!storedRow) throw new Error('Chat run not found')
          return chatRunFromRow(storedRow)
        })
      },
    },
    providerUsage: {
      find(operationKey) {
        const row = one<Query>(database, `
          SELECT ${providerUsageColumns}
          FROM provider_usage_events
          WHERE operation_key = @operationKey
        `, { operationKey })
        return row === undefined ? undefined : providerUsageFromRow(row)
      },
      start(event) {
        return transaction(database, () => {
          const idOwner = one<{ operationKey: string }>(database, `
            SELECT operation_key AS operationKey
            FROM provider_usage_events
            WHERE id = @id
          `, { id: event.id })
          if (idOwner && idOwner.operationKey !== event.operationKey) {
            throw providerUsageConsistencyError()
          }
          database.prepare(`
            INSERT INTO provider_usage_events (
              id, operation_key, user_id, provider, api_key_fingerprint, request_id,
              chat_run_id, model, modality, status, started_at
            ) VALUES (
              @id, @operationKey, @userId, @provider, @apiKeyFingerprint, @requestId,
              @chatRunId, @model, @modality, 'pending', @startedAt
            )
            ON CONFLICT(operation_key) DO NOTHING
          `).run({
            ...event,
            apiKeyFingerprint: event.apiKeyFingerprint ?? null,
            chatRunId: event.chatRunId ?? null,
          })
          const stored = getProviderUsage(database, event.operationKey)
          if (!sameProviderUsageStart(stored, event)) throw providerUsageConsistencyError()
          return stored
        })
      },
      bindIdentity(operationKey, identity) {
        return transaction(database, () => {
          const stored = getProviderUsage(database, operationKey)
          if (
            identity.generationId !== undefined
            && stored.generationId !== undefined
            && stored.generationId !== identity.generationId
          ) throw providerUsageConsistencyError()
          if (
            identity.providerJobId !== undefined
            && stored.providerJobId !== undefined
            && stored.providerJobId !== identity.providerJobId
          ) throw providerUsageConsistencyError()
          if (identity.generationId !== undefined && stored.generationId === undefined) {
            const owner = one<{ operationKey: string }>(database, `
              SELECT operation_key AS operationKey
              FROM provider_usage_events
              WHERE generation_id = @generationId
            `, { generationId: identity.generationId })
            if (owner && owner.operationKey !== operationKey) throw providerUsageConsistencyError()
          }
          database.prepare(`
            UPDATE provider_usage_events
            SET generation_id = @generationId, provider_job_id = @providerJobId
            WHERE operation_key = @operationKey
          `).run({
            operationKey,
            generationId: identity.generationId ?? stored.generationId ?? null,
            providerJobId: identity.providerJobId ?? stored.providerJobId ?? null,
          })
          return getProviderUsage(database, operationKey)
        })
      },
      report(operationKey, report) {
        const costUsd = normalizeUsd(report.costUsd)
        return transaction(database, () => {
          const stored = getProviderUsage(database, operationKey)
          if (stored.status === 'reported') {
            if (
              (report.generationId !== undefined && report.generationId !== stored.generationId)
              || (report.providerJobId !== undefined && report.providerJobId !== stored.providerJobId)
              || stored.inputTokens !== report.inputTokens
              || stored.outputTokens !== report.outputTokens
              || stored.costUsd !== costUsd
            ) throw providerUsageConsistencyError()
            return stored
          }
          if (
            report.generationId !== undefined
            && stored.generationId !== undefined
            && stored.generationId !== report.generationId
          ) throw providerUsageConsistencyError()
          if (
            report.providerJobId !== undefined
            && stored.providerJobId !== undefined
            && stored.providerJobId !== report.providerJobId
          ) throw providerUsageConsistencyError()
          if (report.generationId !== undefined && stored.generationId === undefined) {
            const owner = one<{ operationKey: string }>(database, `
              SELECT operation_key AS operationKey
              FROM provider_usage_events
              WHERE generation_id = @generationId
            `, { generationId: report.generationId })
            if (owner && owner.operationKey !== operationKey) throw providerUsageConsistencyError()
          }
          database.prepare(`
            UPDATE provider_usage_events
            SET generation_id = @generationId,
                provider_job_id = @providerJobId,
                status = 'reported',
                input_tokens = @inputTokens,
                output_tokens = @outputTokens,
                cost_usd = @costUsd,
                next_reconcile_at = NULL,
                ended_at = @endedAt
            WHERE operation_key = @operationKey
          `).run({
            operationKey,
            generationId: report.generationId ?? stored.generationId ?? null,
            providerJobId: report.providerJobId ?? stored.providerJobId ?? null,
            inputTokens: report.inputTokens ?? null,
            outputTokens: report.outputTokens ?? null,
            costUsd,
            endedAt: report.endedAt,
          })
          return getProviderUsage(database, operationKey)
        })
      },
      markUnknown(operationKey, endedAt) {
        return transaction(database, () => {
          const stored = getProviderUsage(database, operationKey)
          if (stored.status === 'reported') return stored
          if (stored.status === 'unknown') return stored
          const terminalAt = stored.endedAt ?? endedAt
          const nextReconcileAt = stored.provider === 'openrouter' && stored.generationId !== undefined
            ? terminalAt + 1_000
            : null
          database.prepare(`
            UPDATE provider_usage_events
            SET status = 'unknown', ended_at = @endedAt, next_reconcile_at = @nextReconcileAt
            WHERE operation_key = @operationKey AND status = 'pending'
          `).run({ operationKey, endedAt: terminalAt, nextReconcileAt })
          return getProviderUsage(database, operationKey)
        })
      },
      recoverPending(recoveredAt) {
        return transaction(database, () => database.prepare(`
          UPDATE provider_usage_events
          SET status = 'unknown',
              ended_at = COALESCE(ended_at, @recoveredAt),
              next_reconcile_at = CASE
                WHEN provider = 'openrouter' AND generation_id IS NOT NULL THEN @nextReconcileAt
                ELSE NULL
              END
          WHERE status = 'pending'
        `).run({ recoveredAt, nextReconcileAt: recoveredAt + 1_000 }).changes)
      },
      listReconcilable(reconcileAt) {
        return many<Query>(database, `
          SELECT ${providerUsageColumns}
          FROM provider_usage_events
          WHERE provider = 'openrouter'
            AND status = 'unknown'
            AND generation_id IS NOT NULL
            AND reconcile_attempts < 3
            AND next_reconcile_at IS NOT NULL
            AND next_reconcile_at <= @reconcileAt
          ORDER BY next_reconcile_at, started_at, id
        `, { reconcileAt }).map(providerUsageFromRow)
      },
      recordReconcileFailure(operationKey, nextReconcileAt) {
        return transaction(database, () => {
          const stored = getProviderUsage(database, operationKey)
          if (stored.status !== 'unknown') throw providerUsageConsistencyError()
          const reconcileAttempts = stored.reconcileAttempts + 1
          database.prepare(`
            UPDATE provider_usage_events
            SET reconcile_attempts = @reconcileAttempts,
                next_reconcile_at = @nextReconcileAt
            WHERE operation_key = @operationKey AND status = 'unknown'
          `).run({
            operationKey,
            reconcileAttempts,
            nextReconcileAt: reconcileAttempts >= 3 ? null : nextReconcileAt ?? null,
          })
          return getProviderUsage(database, operationKey)
        })
      },
      summarize(input) {
        const query = {
          userId: input.userId,
          yesterdayStartedAt: safeTokenCount(input.yesterdayStartedAt),
          todayStartedAt: safeTokenCount(input.todayStartedAt),
          weekStartedAt: safeTokenCount(input.weekStartedAt),
          monthStartedAt: safeTokenCount(input.monthStartedAt),
          endedAt: safeTokenCount(input.endedAt),
        }
        return transaction(database, (): ProviderCostSnapshotRecord => {
          const rows = many<ProviderCostRow>(database, `
            SELECT provider, model, status, cost_usd AS costUsd, started_at AS startedAt
            FROM provider_usage_events
            WHERE user_id = @userId
              AND provider = 'openrouter'
              AND started_at < @endedAt
            ORDER BY started_at, id
          `, { userId: query.userId, endedAt: query.endedAt })
          const allTimeStartedAt = rows[0]?.startedAt
          const allTimeStart = allTimeStartedAt ?? query.endedAt
          return {
            ...(allTimeStartedAt === undefined ? {} : { allTimeStartedAt }),
            today: summarizeProviderCostPeriod(rows, query.todayStartedAt, query.endedAt),
            yesterday: summarizeProviderCostPeriod(rows, query.yesterdayStartedAt, query.todayStartedAt),
            week: summarizeProviderCostPeriod(rows, query.weekStartedAt, query.endedAt),
            month: summarizeProviderCostPeriod(rows, query.monthStartedAt, query.endedAt),
            allTime: summarizeProviderCostPeriod(rows, allTimeStart, query.endedAt),
          }
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
        transaction(database, () => database.prepare('INSERT INTO executions (id, owner_user_id, workflow_id, workflow_version, chat_run_id, status, input_json, result_json, error_code, created_at, started_at, ended_at) VALUES (@id, @ownerUserId, @workflowId, @workflowVersion, @chatRunId, @status, @inputJson, @resultJson, @errorCode, @createdAt, @startedAt, @endedAt)').run({ ...value, inputJson: JSON.stringify(input), resultJson: value.result === undefined ? null : JSON.stringify(value.result), chatRunId: value.chatRunId ?? null, errorCode: value.errorCode ?? null, createdAt, startedAt: value.startedAt ?? null, endedAt: value.endedAt ?? null }))
        return { ...value, input, createdAt } as Execution
      },
      get: (id) => { const row = one<Query>(database, `SELECT ${executionColumns} FROM executions WHERE id = @id`, { id }); return row && executionFromRow(row) },
      list: () => many<Query>(database, `SELECT ${executionColumns} FROM executions ORDER BY created_at DESC, id`).map(executionFromRow),
      getForUser: (id, ownerUserId) => { const row = one<Query>(database, `SELECT ${executionColumns} FROM executions WHERE id = @id AND owner_user_id = @ownerUserId`, { id, ownerUserId }); return row && executionFromRow(row) },
      listForUser: (ownerUserId) => many<Query>(database, `SELECT ${executionColumns} FROM executions WHERE owner_user_id = @ownerUserId ORDER BY created_at DESC, id`, { ownerUserId }).map(executionFromRow),
      update(id, value) {
        transaction(database, () => database.prepare('UPDATE executions SET chat_run_id = COALESCE(@chatRunId, chat_run_id), status = COALESCE(@status, status), input_json = COALESCE(@inputJson, input_json), result_json = COALESCE(@resultJson, result_json), error_code = COALESCE(@errorCode, error_code), started_at = COALESCE(@startedAt, started_at), ended_at = COALESCE(@endedAt, ended_at) WHERE id = @id').run({
          id, chatRunId: null, status: null, errorCode: null, startedAt: null, endedAt: null, ...value,
          inputJson: value.input === undefined ? null : JSON.stringify(value.input),
          resultJson: value.result === undefined ? null : JSON.stringify(value.result),
        }))
        const row = one<Query>(database, `SELECT ${executionColumns} FROM executions WHERE id = @id`, { id })
        return row && executionFromRow(row)
      },
      updateForUser(id, ownerUserId, value) {
        transaction(database, () => database.prepare('UPDATE executions SET chat_run_id = COALESCE(@chatRunId, chat_run_id), status = COALESCE(@status, status), input_json = COALESCE(@inputJson, input_json), result_json = COALESCE(@resultJson, result_json), error_code = COALESCE(@errorCode, error_code), started_at = COALESCE(@startedAt, started_at), ended_at = COALESCE(@endedAt, ended_at) WHERE id = @id AND owner_user_id = @ownerUserId').run({
          id, ownerUserId, chatRunId: null, status: null, errorCode: null, startedAt: null, endedAt: null, ...value,
          inputJson: value.input === undefined ? null : JSON.stringify(value.input),
          resultJson: value.result === undefined ? null : JSON.stringify(value.result),
        }))
        const row = one<Query>(database, `SELECT ${executionColumns} FROM executions WHERE id = @id AND owner_user_id = @ownerUserId`, { id, ownerUserId })
        return row && executionFromRow(row)
      },
      markInterrupted: () => transaction(database, () => database.prepare("UPDATE executions SET status = 'interrupted', error_code = 'INTERNAL_ERROR', ended_at = @endedAt WHERE status IN ('queued', 'awaiting_approval', 'running', 'pending', 'waiting_approval')").run({ endedAt: now() }).changes),
    },
    conversionJobs: {
      create(input) {
        const createdAt = input.createdAt ?? now()
        const updatedAt = input.updatedAt ?? createdAt
        const status = input.status ?? 'queued'
        const epoch = input.epoch ?? 0
        const progress = input.progress ?? 0
        const inserted = transaction(database, () => database.prepare(`
          INSERT INTO conversion_jobs (
            id, owner_user_id, execution_id, source_kind, source_id, target_format, preset,
            status, epoch, progress, error_code, created_at, updated_at, started_at, ended_at
          )
          SELECT
            @id, @ownerUserId, @executionId, @sourceKind, @sourceId, @targetFormat, @preset,
            @status, @epoch, @progress, @errorCode, @createdAt, @updatedAt, @startedAt, @endedAt
          WHERE EXISTS (
            SELECT 1 FROM executions WHERE id = @executionId AND owner_user_id = @ownerUserId
          )
        `).run({
          ...input,
          preset: input.preset ?? null,
          status,
          epoch,
          progress,
          errorCode: input.errorCode ?? null,
          createdAt,
          updatedAt,
          startedAt: input.startedAt ?? null,
          endedAt: input.endedAt ?? null,
        }).changes)
        if (inserted !== 1) throw new Error('Conversion execution ownership mismatch')
        const row = one<Query>(database, `SELECT ${conversionJobColumns} FROM conversion_jobs WHERE id = @id`, { id: input.id })
        if (!row) throw new Error('Conversion job was not created')
        return conversionJobFromRow(row)
      },
      getOwned(jobId, ownerUserId) {
        const row = one<Query>(database, `
          SELECT ${conversionJobColumns} FROM conversion_jobs
          WHERE id = @jobId AND owner_user_id = @ownerUserId
        `, { jobId, ownerUserId })
        return row ? conversionJobFromRow(row) : null
      },
      listForExecution(executionId, ownerUserId) {
        return many<Query>(database, `
          SELECT ${conversionJobColumns} FROM conversion_jobs
          WHERE execution_id = @executionId AND owner_user_id = @ownerUserId
          ORDER BY created_at, id
        `, { executionId, ownerUserId }).map(conversionJobFromRow)
      },
      claimNext(ownerUserId) {
        return transaction(database, () => {
          const row = one<Query>(database, `
            SELECT ${conversionJobColumns} FROM conversion_jobs
            WHERE owner_user_id = @ownerUserId AND status = 'queued'
            ORDER BY created_at, id
            LIMIT 1
          `, { ownerUserId })
          if (!row) return null
          const claimedAt = now()
          const claimed = database.prepare(`
            UPDATE conversion_jobs
            SET status = 'downloading_component',
                updated_at = @claimedAt,
                started_at = COALESCE(started_at, @claimedAt)
            WHERE id = @id AND owner_user_id = @ownerUserId AND status = 'queued'
          `).run({ id: row.id, ownerUserId, claimedAt }).changes
          if (claimed !== 1) return null
          const updated = one<Query>(database, `
            SELECT ${conversionJobColumns} FROM conversion_jobs WHERE id = @id AND owner_user_id = @ownerUserId
          `, { id: row.id, ownerUserId })
          return updated ? conversionJobFromRow(updated) : null
        })
      },
      transition(input) {
        if (input.expectedStatuses.length === 0) return false
        const expectedParameters = Object.fromEntries(input.expectedStatuses.map((status, index) => [`status${index}`, status]))
        const statuses = input.expectedStatuses.map((_, index) => `@status${index}`).join(', ')
        const updatedAt = now()
        return transaction(database, () => database.prepare(`
          UPDATE conversion_jobs
          SET status = COALESCE(@status, status),
              progress = COALESCE(@progress, progress),
              error_code = COALESCE(@errorCode, error_code),
              started_at = COALESCE(@startedAt, started_at),
              ended_at = COALESCE(@endedAt, ended_at),
              updated_at = @updatedAt
          WHERE id = @jobId
            AND owner_user_id = @ownerUserId
            AND epoch = @expectedEpoch
            AND status IN (${statuses})
            AND status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
        `).run({
          jobId: input.jobId,
          ownerUserId: input.ownerUserId,
          expectedEpoch: input.expectedEpoch,
          status: input.patch.status ?? null,
          progress: input.patch.progress ?? null,
          errorCode: input.patch.errorCode ?? null,
          startedAt: input.patch.startedAt ?? null,
          endedAt: input.patch.endedAt ?? null,
          updatedAt,
          ...expectedParameters,
        }).changes === 1)
      },
      retry(input) {
        if (input.expectedStatuses.length === 0) return false
        const expectedParameters = Object.fromEntries(input.expectedStatuses.map((status, index) => [`status${index}`, status]))
        const statuses = input.expectedStatuses.map((_, index) => `@status${index}`).join(', ')
        return transaction(database, () => database.prepare(`
          UPDATE conversion_jobs
          SET epoch = epoch + 1,
              status = 'queued',
              progress = 0,
              error_code = NULL,
              started_at = NULL,
              ended_at = NULL,
              updated_at = @updatedAt
          WHERE id = @jobId
            AND owner_user_id = @ownerUserId
            AND epoch = @expectedEpoch
            AND status IN (${statuses})
            AND status IN ('failed', 'cancelled', 'interrupted')
        `).run({
          jobId: input.jobId,
          ownerUserId: input.ownerUserId,
          expectedEpoch: input.expectedEpoch,
          updatedAt: now(),
          ...expectedParameters,
        }).changes === 1)
      },
      interruptCompletedForArtifactRecovery(input) {
        const interruptedAt = now()
        return transaction(database, () => database.prepare(`
          UPDATE conversion_jobs
          SET status = 'interrupted',
              error_code = 'CONVERSION_INTERRUPTED',
              updated_at = @interruptedAt,
              ended_at = @interruptedAt
          WHERE id = @jobId
            AND owner_user_id = @ownerUserId
            AND epoch = @expectedEpoch
            AND status = 'completed'
        `).run({
          jobId: input.jobId,
          ownerUserId: input.ownerUserId,
          expectedEpoch: input.expectedEpoch,
          interruptedAt,
        }).changes === 1)
      },
      completeWithArtifacts(input) {
        if (input.artifacts.length === 0 || input.artifacts.length > 256) {
          throw new Error('Invalid conversion artifact batch')
        }
        return transaction(database, () => {
          const completed = database.prepare(`
            UPDATE conversion_jobs
            SET status = 'completed',
                progress = 100,
                error_code = NULL,
                updated_at = @endedAt,
                ended_at = @endedAt
            WHERE id = @jobId
              AND owner_user_id = @ownerUserId
              AND execution_id = @executionId
              AND epoch = @expectedEpoch
              AND status = 'verifying'
          `).run({
            jobId: input.jobId,
            ownerUserId: input.ownerUserId,
            executionId: input.executionId,
            expectedEpoch: input.expectedEpoch,
            endedAt: input.endedAt,
          }).changes
          if (completed !== 1) return null
          return input.artifacts.map((artifact) => {
            if (
              artifact.ownerUserId !== input.ownerUserId
              || artifact.executionId !== input.executionId
              || artifact.conversionJobId !== input.jobId
              || artifact.role !== 'output'
              || artifact.status === 'deleted'
            ) throw new Error('Conversion artifact batch identity mismatch')
            return insertConversionArtifact(database, artifact)
          })
        })
      },
      interruptInFlight(ownerUserId) {
        return transaction(database, () => {
          const interruptedAt = now()
          return database.prepare(`
            UPDATE conversion_jobs
            SET status = 'interrupted',
                error_code = 'CONVERSION_INTERRUPTED',
                updated_at = @interruptedAt,
                ended_at = @interruptedAt
            WHERE owner_user_id = @ownerUserId
              AND status IN ('downloading_component', 'converting', 'verifying')
          `).run({ ownerUserId, interruptedAt }).changes
        })
      },
    },
    conversionArtifacts: {
      create(input) {
        return transaction(database, () => insertConversionArtifact(database, input))
      },
      createBatch(inputs) {
        if (inputs.length === 0 || inputs.length > 256) throw new Error('Invalid conversion artifact batch')
        return transaction(database, () => inputs.map((input) => insertConversionArtifact(database, input)))
      },
      getOwned(artifactId, ownerUserId) {
        const row = one<Query>(database, `
          SELECT ${conversionArtifactColumns} FROM conversion_artifacts
          WHERE id = @artifactId AND owner_user_id = @ownerUserId
        `, { artifactId, ownerUserId })
        return row ? conversionArtifactFromRow(row) : null
      },
      listForExecution(executionId, ownerUserId) {
        return many<Query>(database, `
          SELECT ${conversionArtifactColumns} FROM conversion_artifacts
          WHERE execution_id = @executionId AND owner_user_id = @ownerUserId
          ORDER BY created_at, id
        `, { executionId, ownerUserId }).map(conversionArtifactFromRow)
      },
      listForJob(jobId, ownerUserId) {
        return many<Query>(database, `
          SELECT ${conversionArtifactColumns} FROM conversion_artifacts
          WHERE conversion_job_id = @jobId AND owner_user_id = @ownerUserId
          ORDER BY created_at, id
        `, { jobId, ownerUserId }).map(conversionArtifactFromRow)
      },
      markDeleted(artifactId, ownerUserId, expected) {
        return transaction(database, () => {
          const deletedAt = now()
          return database.prepare(`
            UPDATE conversion_artifacts
            SET status = 'deleted', updated_at = @deletedAt, deleted_at = @deletedAt
            WHERE id = @artifactId
              AND owner_user_id = @ownerUserId
              AND execution_id = @expectedExecutionId
              AND conversion_job_id IS @expectedConversionJobId
              AND role = @expectedRole
              AND display_name = @expectedDisplayName
              AND detected_format = @expectedDetectedFormat
              AND mime_type IS @expectedMimeType
              AND byte_size = @expectedByteSize
              AND sha256 = @expectedSha256
              AND relative_path = @expectedRelativePath
              AND metadata_json IS @expectedMetadataJson
              AND status = 'ready'
              AND created_at = @expectedCreatedAt
              AND updated_at = @expectedUpdatedAt
              AND deleted_at IS @expectedDeletedAt
          `).run({
            artifactId,
            ownerUserId,
            deletedAt,
            expectedExecutionId: expected.executionId,
            expectedConversionJobId: expected.conversionJobId ?? null,
            expectedRole: expected.role,
            expectedDisplayName: expected.displayName,
            expectedDetectedFormat: expected.detectedFormat,
            expectedMimeType: expected.mimeType ?? null,
            expectedByteSize: expected.byteSize,
            expectedSha256: expected.sha256,
            expectedRelativePath: expected.relativePath,
            expectedMetadataJson: expected.metadata === undefined
              ? null
              : JSON.stringify(expected.metadata),
            expectedCreatedAt: expected.createdAt,
            expectedUpdatedAt: expected.updatedAt,
            expectedDeletedAt: expected.deletedAt ?? null,
          }).changes === 1
        })
      },
    },
    executionSteps: {
      insert(value) { transaction(database, () => database.prepare('INSERT INTO execution_steps (id, execution_id, sequence, name, status, percent, started_at, ended_at) VALUES (@id, @executionId, @sequence, @name, @status, @percent, @startedAt, @endedAt)').run(value)); return value },
      list: (executionId) => many<ExecutionStep>(database, 'SELECT id, execution_id AS executionId, sequence, name, status, percent, started_at AS startedAt, ended_at AS endedAt FROM execution_steps WHERE execution_id = @executionId ORDER BY sequence', { executionId }),
      listForUser: (executionId, ownerUserId) => many<ExecutionStep>(database, 'SELECT step.id, step.execution_id AS executionId, step.sequence, step.name, step.status, step.percent, step.started_at AS startedAt, step.ended_at AS endedAt FROM execution_steps step JOIN executions execution ON execution.id = step.execution_id WHERE step.execution_id = @executionId AND execution.owner_user_id = @ownerUserId ORDER BY step.sequence', { executionId, ownerUserId }),
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
      listForUser: (executionId, ownerUserId) => many<Query>(database, 'SELECT log.id, log.execution_id AS executionId, log.sequence, log.level, log.message, log.metadata_json AS metadataJson, log.created_at AS createdAt FROM execution_logs log JOIN executions execution ON execution.id = log.execution_id WHERE log.execution_id = @executionId AND execution.owner_user_id = @ownerUserId ORDER BY log.sequence', { executionId, ownerUserId }).map((row) => ({ ...row, metadata: parse(row.metadataJson as string | null) } as ExecutionLog)),
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
    browserTabBindings: {
      insert(value) {
        const binding = browserTabBindingSchema.parse(value)
        transaction(database, () => database.prepare(`
          INSERT INTO browser_tab_bindings (
            id, tab_id, user_id, conversation_id, chat_run_id, execution_id,
            workflow_id, workflow_version, source, build_hash, security_fingerprint,
            permission_matrix_json, status, terminal_reason, created_at, ended_at
          ) VALUES (
            @id, @tabId, @userId, @conversationId, @chatRunId, @executionId,
            @workflowId, @workflowVersion, @source, @buildHash, @securityFingerprint,
            @permissionMatrixJson, @status, @terminalReason, @createdAt, @endedAt
          )
        `).run({
          ...binding,
          chatRunId: binding.chatRunId ?? null,
          executionId: binding.executionId ?? null,
          buildHash: binding.buildHash ?? null,
          permissionMatrixJson: JSON.stringify(binding.permissionMatrix),
          terminalReason: binding.terminalReason ?? null,
          endedAt: binding.endedAt ?? null,
        }))
        return binding
      },
      get: (id) => {
        const row = one<Query>(database, `SELECT ${browserTabBindingColumns} FROM browser_tab_bindings WHERE id = @id`, { id })
        return row && browserTabBindingFromRow(row)
      },
      terminate: (id, value) => transaction(database, () => {
        const terminal = browserTabBindingTerminalSchema.parse(value)
        const updated = database.prepare(`
          UPDATE browser_tab_bindings
          SET status = @status, terminal_reason = @terminalReason, ended_at = @endedAt
          WHERE id = @id AND status = 'active'
        `).run({ id, ...terminal })
        if (updated.changes !== 1) return undefined
        const row = one<Query>(database, `SELECT ${browserTabBindingColumns} FROM browser_tab_bindings WHERE id = @id`, { id })
        return row && browserTabBindingFromRow(row)
      }),
      markActiveStale: (endedAt) => transaction(database, () => database.prepare(`
        UPDATE browser_tab_bindings
        SET status = 'stale', ended_at = @endedAt
        WHERE status = 'active'
      `).run({ endedAt }).changes),
    },
    browserActionAudits: {
      insert(value) {
        const audit = browserActionAuditSchema.parse(value)
        transaction(database, () => database.prepare(`
          INSERT INTO browser_action_audits (
            id, binding_id, chat_run_id, sequence, origin, action, target_summary,
            risk, outcome, error_code, created_at
          ) VALUES (
            @id, @bindingId, @chatRunId, @sequence, @origin, @action, @targetSummary,
            @risk, @outcome, @errorCode, @createdAt
          )
        `).run({ ...audit, chatRunId: audit.chatRunId ?? null, errorCode: audit.errorCode ?? null }))
        return audit
      },
      list: (bindingId) => many<Query>(database, `
        SELECT ${browserActionAuditColumns}
        FROM browser_action_audits
        WHERE binding_id = @bindingId
        ORDER BY sequence
      `, { bindingId }).map(browserActionAuditFromRow),
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
