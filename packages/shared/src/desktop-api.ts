import { z } from 'zod'
import { isBrowserLocator } from './browser-locator.js'
import { isHttpsUrlPattern } from './https-url-pattern.js'
import { proxySettingsSchema } from './proxy-settings.js'
import { appErrorCodeSchema } from './errors.js'
import {
  chatBlockSchema,
  knowledgeCoordinateSchema,
  knowledgeEvidenceSchema,
  mediaKindSchema,
  type ChatBlock,
  type ChatEvent,
  type ExecutionEvent,
  type ExecutionStatus,
  type KnowledgeEvidence,
  type KnowledgeEvent,
} from './events.js'
import {
  capabilitySchema,
  capabilityScopeSchema,
  runtimeCapabilityPermissionSchema,
  runtimeCapabilityScopeSchema,
  type Capability,
  type CapabilityScope,
} from './worker-protocol.js'

const identifierSchema = z.string().trim().min(1).max(128)
const timestampSchema = z.string().datetime()
const nonEmptyStringSchema = z.string().trim().min(1)

export const knowledgeBaseSummarySchema = z.object({
  id: identifierSchema,
  name: nonEmptyStringSchema.max(200),
  kind: z.enum(['local', 'cloud']),
  status: z.enum(['ready', 'processing', 'paused', 'failed', 'read_only', 'recycled']),
  searchable: z.boolean(),
  documentCount: z.number().int().nonnegative(),
  updatedAt: timestampSchema,
  readOnly: z.boolean().optional(),
}).strict()
export type KnowledgeBaseSummary = z.infer<typeof knowledgeBaseSummarySchema>

export const knowledgeDocumentSummarySchema = z.object({
  id: identifierSchema,
  baseId: identifierSchema,
  name: nonEmptyStringSchema.max(500),
  mimeType: nonEmptyStringSchema.max(200),
  status: z.enum(['queued', 'copying', 'parsing', 'indexing', 'ready', 'failed', 'paused', 'deleted']),
  versionCount: z.number().int().nonnegative(),
  updatedAt: timestampSchema,
  readOnly: z.boolean().optional(),
}).strict()
export type KnowledgeDocumentSummary = z.infer<typeof knowledgeDocumentSummarySchema>

export const knowledgeVersionSummarySchema = z.object({
  id: identifierSchema,
  documentId: identifierSchema,
  number: z.number().int().positive(),
  status: z.enum(['staging', 'ready', 'failed', 'retired']),
  createdAt: timestampSchema,
}).strict()
export type KnowledgeVersionSummary = z.infer<typeof knowledgeVersionSummarySchema>

export const knowledgeImportHandleSchema = z.object({
  id: identifierSchema,
  name: nonEmptyStringSchema.max(500),
  mimeType: nonEmptyStringSchema.max(200),
  byteSize: z.number().int().nonnegative(),
}).strict()
export type KnowledgeImportHandle = z.infer<typeof knowledgeImportHandleSchema>

export const knowledgeSelectionSchema = z.object({
  baseIds: z.array(identifierSchema).max(32).refine(
    (ids) => new Set(ids).size === ids.length,
    { message: 'Knowledge base IDs must be unique' },
  ),
  mode: z.enum(['mixed', 'strict']),
}).strict()
export type KnowledgeSelection = z.infer<typeof knowledgeSelectionSchema>

export const knowledgeEntitlementStateSchema = z.object({
  tier: z.enum(['free', 'member']),
  status: z.enum(['active', 'offline_grace', 'expired', 'unavailable']),
  localEnabled: z.boolean(),
  cloudEnabled: z.boolean(),
  betaEnabled: z.boolean().optional(),
  expiresAt: timestampSchema.optional(),
  graceEndsAt: timestampSchema.optional(),
  retainedBaseId: identifierSchema.optional(),
  retainedDocumentId: identifierSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.cloudEnabled && (value.tier !== 'member'
    || !['active', 'offline_grace'].includes(value.status)
    || value.betaEnabled !== true)) {
    context.addIssue({ code: 'custom', path: ['cloudEnabled'], message: 'Cloud requires an admitted member beta entitlement' })
  }
  if (value.betaEnabled && value.tier !== 'member') {
    context.addIssue({ code: 'custom', path: ['betaEnabled'], message: 'Beta requires membership' })
  }
  if ((value.status === 'expired' || value.status === 'unavailable') && value.cloudEnabled) {
    context.addIssue({ code: 'custom', path: ['cloudEnabled'], message: 'Expired or unavailable entitlement must fail closed' })
  }
  if ((value.expiresAt === undefined) !== (value.graceEndsAt === undefined)
    || (value.expiresAt && value.graceEndsAt
      && Date.parse(value.graceEndsAt) < Date.parse(value.expiresAt))) {
    context.addIssue({ code: 'custom', path: ['graceEndsAt'], message: 'Expiry and grace boundaries must be complete and ordered' })
  }
  if (value.retainedDocumentId && !value.retainedBaseId) {
    context.addIssue({ code: 'custom', path: ['retainedDocumentId'], message: 'A retained document requires its retained base' })
  }
})
export type KnowledgeEntitlementState = z.infer<typeof knowledgeEntitlementStateSchema>

export const knowledgeRetentionSelectionSchema = z.object({
  baseId: identifierSchema,
  documentId: identifierSchema,
}).strict()
export type KnowledgeRetentionSelection = z.infer<typeof knowledgeRetentionSelectionSchema>

export const knowledgeConsentStateSchema = z.object({
  provider: z.enum(['openrouter', 'deepseek']),
  status: z.enum(['unknown', 'granted', 'denied']),
  updatedAt: timestampSchema.optional(),
}).strict()
export type KnowledgeConsentState = z.infer<typeof knowledgeConsentStateSchema>

export const knowledgeSourcePreviewRequestSchema = z.object({
  evidenceId: identifierSchema,
  baseId: identifierSchema,
  documentId: identifierSchema,
  versionId: identifierSchema,
  coordinate: knowledgeCoordinateSchema,
}).strict()
export type KnowledgeSourcePreviewRequest = z.infer<typeof knowledgeSourcePreviewRequestSchema>
export const knowledgeSourcePreviewSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('available'), preview: nonEmptyStringSchema.max(4_000) }).strict(),
  z.object({ kind: z.literal('unavailable') }).strict(),
])
export type KnowledgeSourcePreview = z.infer<typeof knowledgeSourcePreviewSchema>

function knowledgeGateSchema(reason: string) {
  return z.object({
    available: z.boolean(),
    reason: z.literal(reason).optional(),
  }).strict().superRefine((value, context) => {
    if ((value.available && value.reason !== undefined) || (!value.available && value.reason === undefined)) {
      context.addIssue({ code: 'custom', message: 'Knowledge availability gates must fail closed with their matching reason' })
    }
  })
}

export const knowledgeAvailabilitySchema = z.object({
  encryption: knowledgeGateSchema('encryption_unavailable'),
  parser: knowledgeGateSchema('parser_unavailable'),
  cloudbase: knowledgeGateSchema('cloudbase_unavailable'),
  embedding: knowledgeGateSchema('embedding_unavailable'),
  entitlement: knowledgeGateSchema('entitlement_unavailable'),
  beta: knowledgeGateSchema('beta_disabled'),
  cloud: knowledgeGateSchema('cloud_disabled'),
}).strict()
export type KnowledgeAvailability = z.infer<typeof knowledgeAvailabilitySchema>
export type { KnowledgeEvidence, KnowledgeEvent }

export const knowledgeSearchResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('query-too-short') }).strict(),
  z.object({
    kind: z.literal('results'),
    strategy: z.enum(['trigram', 'bounded-instr']),
    evidence: z.array(knowledgeEvidenceSchema).max(8),
  }).strict(),
])
export type KnowledgeSearchResult = z.infer<typeof knowledgeSearchResultSchema>

const browserAuditOriginSchema = z.string().superRefine((value, context) => {
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
export const browserAuditTextSchema = nonEmptyStringSchema.max(500).refine(
  (value) => !/(?:\b(?:authorization|cookie|set-cookie|password|token|api[_-]?key|path)\b|\bfile\s*:|\b(?:file|folder|directory)path\s*[:=]|(?:^|[\s="'(:])\/(?:[^\s/]+\/)*[^\s/]+|\b[A-Za-z]:[\\/]|(?:^|[\s="'(])\\\\[^\\/\s]+[\\/][^\\/\s]+)/i.test(value),
  { message: 'Browser audit text cannot include sensitive keys' },
)

export const browserActionAuditEntrySchema = z.object({
  id: identifierSchema,
  bindingId: identifierSchema,
  sequence: z.number().int().positive(),
  origin: browserAuditOriginSchema,
  action: browserAuditTextSchema,
  targetSummary: browserAuditTextSchema,
  risk: z.enum(['safe_navigation', 'sensitive_read', 'external_action']),
  outcome: z.enum(['completed', 'blocked', 'failed', 'cancelled', 'handed_off']),
  errorCode: appErrorCodeSchema.optional(),
  createdAt: z.number().int().nonnegative(),
}).strict()
export type BrowserActionAuditEntry = z.infer<typeof browserActionAuditEntrySchema>

export const takeOverBrowserRequestSchema = z.object({
  requestId: identifierSchema,
  bindingId: identifierSchema,
}).strict()
export type TakeOverBrowserRequest = z.infer<typeof takeOverBrowserRequestSchema>

export const listBrowserAuditRequestSchema = z.object({ bindingId: identifierSchema }).strict()
export type ListBrowserAuditRequest = z.infer<typeof listBrowserAuditRequestSchema>
export const httpsUrlPatternSchema = z.string().refine(isHttpsUrlPattern, { message: 'Expected an HTTPS URL pattern' })
export const browserLocatorSchema = z.string().refine(isBrowserLocator, { message: 'Expected a browser locator' })

function nonEmptyUniqueArraySchema<T extends z.ZodType>(schema: T) {
  return z.array(schema).min(1).max(32).refine((values) => new Set(values.map((value) => JSON.stringify(value))).size === values.length, {
    message: 'Values must be unique',
  })
}

export const providerUsageModalitySchema = z.enum(['text', 'image', 'audio', 'video'])
export type ProviderUsageModality = z.infer<typeof providerUsageModalitySchema>

export const authAccountSchema = z.string().trim().regex(/^[A-Za-z0-9_]{5,24}$/)
export const authPhoneSchema = z.string().trim().regex(/^1[3-9]\d{9}$/)
export const authEmailSchema = z.string().trim().toLowerCase().email().max(254)
export const authOtpCodeSchema = z.string().trim().regex(/^\d{6}$/)
export const authPasswordSchema = z.string().superRefine((value, context) => {
  const length = Array.from(value).length
  if (length < 8 || length > 72) {
    context.addIssue({ code: 'custom', message: 'Password must contain 8 to 72 Unicode code points' })
  }
})
export const authCredentialsSchema = z.object({
  account: authAccountSchema,
  password: authPasswordSchema,
}).strict()
export type AuthCredentials = z.infer<typeof authCredentialsSchema>

export const authOtpChannelSchema = z.enum(['phone', 'email'])
export type AuthOtpChannel = z.infer<typeof authOtpChannelSchema>

const authOtpLoginRequestSchema = z.discriminatedUnion('channel', [
  z.object({ intent: z.literal('login'), channel: z.literal('phone'), target: authPhoneSchema }).strict(),
  z.object({ intent: z.literal('login'), channel: z.literal('email'), target: authEmailSchema }).strict(),
])
const authOtpRegisterRequestSchema = z.discriminatedUnion('channel', [
  z.object({
    intent: z.literal('register'),
    channel: z.literal('phone'),
    target: authPhoneSchema,
    account: authAccountSchema,
    password: authPasswordSchema,
  }).strict(),
  z.object({
    intent: z.literal('register'),
    channel: z.literal('email'),
    target: authEmailSchema,
    account: authAccountSchema,
    password: authPasswordSchema,
  }).strict(),
])
export const authOtpRequestSchema = z.union([
  authOtpLoginRequestSchema,
  authOtpRegisterRequestSchema,
])
export type AuthOtpRequest = z.infer<typeof authOtpRequestSchema>

export const authOtpChallengeSchema = z.object({
  challengeId: identifierSchema,
  expiresIn: z.number().int().positive().max(300),
}).strict()
export type AuthOtpChallenge = z.infer<typeof authOtpChallengeSchema>

export const authOtpVerificationSchema = z.object({
  challengeId: identifierSchema,
  code: authOtpCodeSchema,
}).strict()
export type AuthOtpVerification = z.infer<typeof authOtpVerificationSchema>

export const logoutRequestSchema = z.union([
  z.object({ discardPending: z.literal(true) }).strict(),
  z.object({ preservePending: z.literal(true) }).strict(),
]).optional()
export type LogoutRequest = z.infer<typeof logoutRequestSchema>
export const logoutResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('logged_out') }).strict(),
  z.object({ status: z.literal('pending_sync'), pendingCount: z.number().int().positive().max(10_000) }).strict(),
  z.object({ status: z.literal('sync_timeout') }).strict(),
])
export type LogoutResult = z.infer<typeof logoutResultSchema>

export const profileGenderSchema = z.enum(['male', 'female', 'other', 'prefer_not_to_say'])
export type ProfileGender = z.infer<typeof profileGenderSchema>

const canonicalHttpsUrlSchema = z.string().url().superRefine((value, context) => {
  const parsed = new URL(value)
  if (parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.port !== ''
    || parsed.hash !== ''
    || parsed.href !== value) {
    context.addIssue({ code: 'custom', message: 'A canonical HTTPS URL is required' })
  }
})

const profileDisplayNameSchema = z.string().superRefine((value, context) => {
  if (Array.from(value).length > 50) {
    context.addIssue({ code: 'custom', message: 'Display name must contain at most 50 Unicode code points' })
  }
})
const profileBirthDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const profileEmailSchema = z.string().email().max(254)
const profilePhoneSchema = z.string().regex(/^\+?\d{6,20}$/)

const normalizedProfileFieldsSchema = z.object({
  avatarUrl: canonicalHttpsUrlSchema.optional(),
  displayName: profileDisplayNameSchema.min(1).optional(),
  gender: profileGenderSchema.optional(),
  birthDate: profileBirthDateSchema.optional(),
  email: profileEmailSchema.optional(),
  phone: profilePhoneSchema.optional(),
}).strict()

export const authUserProfileSnapshotSchema = z.object({
  avatarUrl: z.union([canonicalHttpsUrlSchema, z.null()]).optional(),
  displayName: z.union([profileDisplayNameSchema.min(1), z.null()]).optional(),
  gender: z.union([profileGenderSchema, z.null()]).optional(),
  email: z.union([profileEmailSchema, z.null()]).optional(),
  phone: z.union([profilePhoneSchema, z.null()]).optional(),
}).strict()
export type AuthUserProfileSnapshot = z.infer<typeof authUserProfileSnapshotSchema>

export const authUserSchema = z.object({
  id: identifierSchema,
  account: z.string().trim().min(1).max(64),
  profile: authUserProfileSnapshotSchema.optional(),
}).strict()
export type AuthUser = z.infer<typeof authUserSchema>

export const roleIdSchema = z.string().trim().regex(/^[a-z][a-z0-9_]{0,62}$/)
export type RoleId = z.infer<typeof roleIdSchema>

export const businessCapabilitySchema = z.enum(['manage_users'])
export type BusinessCapability = z.infer<typeof businessCapabilitySchema>

export const signedKnowledgeEntitlementSnapshotSchema = z.object({
  payload: z.string().regex(/^[A-Za-z0-9_-]+$/).max(8_192),
  signature: z.string().regex(/^[A-Za-z0-9_-]+$/).max(256),
}).strict()
export type SignedKnowledgeEntitlementSnapshot = z.infer<typeof signedKnowledgeEntitlementSnapshotSchema>

export const authorizationSnapshotSchema = z.object({
  role: roleIdSchema,
  capabilities: z.array(businessCapabilitySchema),
  version: z.number().int().nonnegative(),
  updatedAt: timestampSchema,
  confirmed: z.boolean(),
  knowledgeEntitlement: signedKnowledgeEntitlementSnapshotSchema.optional(),
}).strict()
export type AuthorizationSnapshot = z.infer<typeof authorizationSnapshotSchema>

export function hasBusinessCapability(
  authorization: AuthorizationSnapshot | undefined,
  capability: BusinessCapability,
): boolean {
  return authorization?.confirmed === true && authorization.capabilities.includes(capability)
}

export const authSessionSchema = z.object({
  user: authUserSchema,
  authenticatedAt: timestampSchema,
  authorization: authorizationSnapshotSchema.optional(),
}).strict()
export type AuthSession = z.infer<typeof authSessionSchema>

export const assignableRoleSchema = z.enum(['user', 'super_admin'])
export type AssignableRole = z.infer<typeof assignableRoleSchema>

export const userAdminFilterSchema = z.object({
  field: z.enum(['username', 'displayName', 'userId', 'email', 'phone']),
  value: z.string().trim().min(1).max(254),
}).strict()
export type UserAdminFilter = z.infer<typeof userAdminFilterSchema>

export const userAdminListRequestSchema = z.object({
  page: z.number().int().positive(),
  pageSize: z.union([z.literal(20), z.literal(50), z.literal(100)]),
  filter: userAdminFilterSchema.optional(),
}).strict()
export type UserAdminListRequest = z.infer<typeof userAdminListRequestSchema>

export const userAdminListItemSchema = z.object({
  userId: identifierSchema,
  username: z.string().trim().min(1).max(64),
  displayName: z.string().max(80).nullable(),
  maskedEmail: z.string().max(254).nullable(),
  maskedPhone: z.string().max(32).nullable(),
  status: z.enum(['active', 'blocked']),
  role: roleIdSchema,
  roleVersion: z.number().int().nonnegative(),
  createdAt: timestampSchema,
}).strict()
export type UserAdminListItem = z.infer<typeof userAdminListItemSchema>

export const userAdminListResponseSchema = z.object({
  items: z.array(userAdminListItemSchema),
  page: z.number().int().positive(),
  pageSize: z.union([z.literal(20), z.literal(50), z.literal(100)]),
  total: z.number().int().nonnegative(),
}).strict()
export type UserAdminListResponse = z.infer<typeof userAdminListResponseSchema>

export const userAdminUpdateRoleRequestSchema = z.object({
  requestId: identifierSchema.max(128),
  targetUserId: identifierSchema.max(64),
  newRole: assignableRoleSchema,
  expectedVersion: z.number().int().nonnegative(),
}).strict()
export type UserAdminUpdateRoleRequest = z.infer<typeof userAdminUpdateRoleRequestSchema>

export const userAdminUpdateRoleResponseSchema = z.object({
  userId: identifierSchema,
  role: assignableRoleSchema,
  version: z.number().int().positive(),
  updatedAt: timestampSchema,
}).strict()
export type UserAdminUpdateRoleResponse = z.infer<typeof userAdminUpdateRoleResponseSchema>

export const userProfileUpdateSchema = z.object({
  avatarUrl: canonicalHttpsUrlSchema.optional(),
  displayName: profileDisplayNameSchema.optional(),
  gender: profileGenderSchema.optional(),
  birthDate: z.union([z.literal(''), profileBirthDateSchema]).optional(),
}).strict()
export type UserProfileUpdate = z.infer<typeof userProfileUpdateSchema>

export const userProfileSchema = normalizedProfileFieldsSchema.extend({
  userId: identifierSchema,
  account: authUserSchema.shape.account,
  updatedAt: timestampSchema.optional(),
}).strict()
export type UserProfile = z.infer<typeof userProfileSchema>

export const profileAvatarUploadResultSchema = z.object({ url: canonicalHttpsUrlSchema }).strict()
export type ProfileAvatarUploadResult = z.infer<typeof profileAvatarUploadResultSchema>

export const outputTypeSchema = z.enum(['auto', 'text', 'image', 'audio', 'video'])
export type OutputType = z.infer<typeof outputTypeSchema>

export const videoFrameTypeSchema = z.enum(['first_frame', 'last_frame'])
export type VideoFrameType = z.infer<typeof videoFrameTypeSchema>

export const generationOptionsSchema = z.object({
  image: z.object({
    count: z.literal(1),
    resolution: z.string().default('1K'),
    aspectRatio: z.string().default('auto'),
    format: z.string().default('png'),
  }).strict(),
  audio: z.object({
    voice: z.string().trim().min(1).optional(),
    format: z.string().default('mp3'),
  }).strict(),
  video: z.object({
    durationSeconds: z.number().int().positive().default(5),
    resolution: z.string().default('720p'),
    aspectRatio: z.string().default('auto'),
    generateAudio: z.boolean().default(false),
  }).strict(),
}).strict()
export type GenerationOptions = z.infer<typeof generationOptionsSchema>

export const mediaAssetSchema = z.object({
  id: identifierSchema,
  kind: mediaKindSchema,
  mimeType: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  byteSize: z.number().int().nonnegative(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationMs: z.number().int().nonnegative().optional(),
}).strict()
export type MediaAsset = z.infer<typeof mediaAssetSchema>

export const mediaImportContextSchema = z.object({
  conversationId: identifierSchema,
  existingAssetIds: z.array(identifierSchema).max(5),
}).strict()
export type MediaImportContext = z.infer<typeof mediaImportContextSchema>

export const mediaRemoveDraftRequestSchema = z.object({
  conversationId: identifierSchema,
  assetId: identifierSchema,
}).strict()
export type MediaRemoveDraftRequest = z.infer<typeof mediaRemoveDraftRequestSchema>

export const conversationGenerationPreferencesSchema = z.object({
  outputType: outputTypeSchema,
  models: z.object({
    text: nonEmptyStringSchema.optional(),
    image: nonEmptyStringSchema.optional(),
    audio: nonEmptyStringSchema.optional(),
    video: nonEmptyStringSchema.optional(),
  }).strict(),
  generation: generationOptionsSchema,
  knowledgeBaseIds: knowledgeSelectionSchema.shape.baseIds.optional(),
  knowledgeMode: knowledgeSelectionSchema.shape.mode.optional(),
}).strict().superRefine((preferences, context) => {
  if ((preferences.knowledgeBaseIds === undefined) !== (preferences.knowledgeMode === undefined)) {
    context.addIssue({
      code: 'custom',
      path: ['knowledgeBaseIds'],
      message: 'Knowledge selection fields must be supplied together',
    })
  }
})
export type ConversationGenerationPreferences = z.infer<typeof conversationGenerationPreferencesSchema>

export const syncStateSchema = z.enum(['synced', 'pending', 'syncing', 'failed'])
export type SyncState = z.infer<typeof syncStateSchema>

export const opaqueCursorSchema = z.string().min(16).max(2048)

export interface CursorPage<T> {
  items: T[]
  nextCursor?: string
  previousCursor?: string
}

export const conversationTitleStateSchema = z.enum([
  'pending',
  'generating',
  'ai_named',
  'user_named',
  'failed',
])

export const conversationSummarySchema = z.object({
  id: identifierSchema,
  title: nonEmptyStringSchema,
  titleState: conversationTitleStateSchema,
  revision: z.number().int().nonnegative(),
  syncState: syncStateSchema,
  syncWarningSince: timestampSchema.optional(),
  createdAt: timestampSchema,
  lastActivityAt: timestampSchema,
  metadataUpdatedAt: timestampSchema,
}).strict()

export type ConversationSummary = z.infer<typeof conversationSummarySchema>

export const conversationPageSchema = z.object({
  items: z.array(conversationSummarySchema).max(50),
  nextCursor: opaqueCursorSchema.optional(),
  syncWarningSince: timestampSchema.optional(),
}).strict()
export type ConversationPage = z.infer<typeof conversationPageSchema>

export const conversationCreateMutationPayloadSchema = z.object({
  title: nonEmptyStringSchema,
  titleState: conversationTitleStateSchema,
  createdAt: timestampSchema,
  lastActivityAt: timestampSchema,
  metadataUpdatedAt: timestampSchema,
}).strict()
export type ConversationCreateMutationPayload = z.infer<typeof conversationCreateMutationPayloadSchema>

export const conversationRenameMutationPayloadSchema = z.object({
  title: nonEmptyStringSchema,
  titleState: conversationTitleStateSchema,
  metadataUpdatedAt: timestampSchema,
}).strict()
export type ConversationRenameMutationPayload = z.infer<typeof conversationRenameMutationPayloadSchema>

export const conversationPreferencesMutationPayloadSchema = z.object({
  preferences: conversationGenerationPreferencesSchema,
  metadataUpdatedAt: timestampSchema,
}).strict()
export type ConversationPreferencesMutationPayload = z.infer<
  typeof conversationPreferencesMutationPayloadSchema
>

export const conversationDeleteMutationPayloadSchema = z.object({}).strict()
export type ConversationDeleteMutationPayload = z.infer<typeof conversationDeleteMutationPayloadSchema>

export const conversationRestoreMutationPayloadSchema = z.object({}).strict()
export type ConversationRestoreMutationPayload = z.infer<typeof conversationRestoreMutationPayloadSchema>

export const chatMessageSchema = z.object({
  id: identifierSchema,
  conversationId: identifierSchema,
  role: z.enum(['user', 'assistant']),
  blocks: z.array(chatBlockSchema),
  executionId: identifierSchema.optional(),
  createdAt: timestampSchema,
}).strict()

export interface ChatMessage extends Omit<z.infer<typeof chatMessageSchema>, 'blocks'> { blocks: ChatBlock[] }

export const messagePageSchema = z.object({
  items: z.array(chatMessageSchema).max(100),
  previousCursor: opaqueCursorSchema.optional(),
}).strict()
export type MessagePage = Omit<z.infer<typeof messagePageSchema>, 'items'> & { items: ChatMessage[] }

export const messageAppendMutationPayloadSchema = chatMessageSchema
export type MessageAppendMutationPayload = z.infer<typeof messageAppendMutationPayloadSchema>

export const syncMutationKindSchema = z.enum([
  'conversation.create',
  'conversation.rename',
  'conversation.preferences',
  'conversation.delete',
  'conversation.restore',
  'message.append',
  'legacy.import',
  'privacy.consent',
  'preferences.update',
  'usage.record',
])
export type SyncMutationKind = z.infer<typeof syncMutationKindSchema>

export const syncMutationStatusSchema = z.enum(['applied', 'duplicate', 'conflict', 'rejected'])
export type SyncMutationStatus = z.infer<typeof syncMutationStatusSchema>

const syncMutationResultBaseShape = {
  id: identifierSchema,
}

export const syncMutationResultSchema = z.discriminatedUnion('status', [
  z.object({
    ...syncMutationResultBaseShape,
    status: z.literal('applied'),
    revision: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    ...syncMutationResultBaseShape,
    status: z.literal('duplicate'),
    revision: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    ...syncMutationResultBaseShape,
    status: z.literal('conflict'),
    errorCode: appErrorCodeSchema,
  }).strict(),
  z.object({
    ...syncMutationResultBaseShape,
    status: z.literal('rejected'),
    errorCode: appErrorCodeSchema,
  }).strict(),
])
export type SyncMutationResult = z.infer<typeof syncMutationResultSchema>

export const legacyImportPreviewSchema = z.object({
  ownedCount: z.number().int().nonnegative(),
  unownedCount: z.number().int().nonnegative(),
  requiresUnownedConfirmation: z.boolean(),
}).strict().superRefine((preview, context) => {
  if (preview.requiresUnownedConfirmation !== (preview.unownedCount > 0)) {
    context.addIssue({
      code: 'custom',
      path: ['requiresUnownedConfirmation'],
      message: 'Unowned history requires explicit import confirmation',
    })
  }
})
export type LegacyImportPreview = z.infer<typeof legacyImportPreviewSchema>

export const privacyConsentPurposeSchema = z.enum(['cloud_sync', 'legacy_unowned_import'])
export type PrivacyConsentPurpose = z.infer<typeof privacyConsentPurposeSchema>

export const privacyConsentSchema = z.object({
  purpose: privacyConsentPurposeSchema,
  documentVersion: nonEmptyStringSchema.max(128),
  consentedAt: timestampSchema,
  clientVersion: nonEmptyStringSchema.max(64),
}).strict()
export type PrivacyConsent = z.infer<typeof privacyConsentSchema>

export const legacyImportConfirmRequestSchema = z.object({
  batchId: identifierSchema,
  includeUnowned: z.boolean(),
  cloudSyncConsent: privacyConsentSchema,
  unownedImportConsent: privacyConsentSchema.optional(),
}).strict().superRefine((request, context) => {
  if (request.cloudSyncConsent.purpose !== 'cloud_sync') {
    context.addIssue({
      code: 'custom',
      path: ['cloudSyncConsent', 'purpose'],
      message: 'Cloud sync consent is required separately from legacy import consent',
    })
  }
  if (request.includeUnowned && request.unownedImportConsent?.purpose !== 'legacy_unowned_import') {
    context.addIssue({
      code: 'custom',
      path: ['unownedImportConsent'],
      message: 'Importing unowned history requires separate confirmation',
    })
  }
  if (!request.includeUnowned && request.unownedImportConsent !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['unownedImportConsent'],
      message: 'Unowned import consent must accompany an unowned import',
    })
  }
})
export type LegacyImportConfirmRequest = z.infer<typeof legacyImportConfirmRequestSchema>

export const legacyImportRequestSchema = z.object({
  includeUnowned: z.boolean(),
  cloudSyncConsent: privacyConsentSchema,
  unownedImportConsent: privacyConsentSchema.optional(),
}).strict().superRefine((request, context) => {
  if (request.cloudSyncConsent.purpose !== 'cloud_sync') {
    context.addIssue({
      code: 'custom', path: ['cloudSyncConsent', 'purpose'],
      message: 'Cloud sync consent is required separately from legacy import consent',
    })
  }
  if (request.includeUnowned && request.unownedImportConsent?.purpose !== 'legacy_unowned_import') {
    context.addIssue({
      code: 'custom', path: ['unownedImportConsent'],
      message: 'Importing unowned history requires separate confirmation',
    })
  }
  if (!request.includeUnowned && request.unownedImportConsent !== undefined) {
    context.addIssue({
      code: 'custom', path: ['unownedImportConsent'],
      message: 'Unowned import consent must accompany an unowned import',
    })
  }
})
export type LegacyImportRequest = z.infer<typeof legacyImportRequestSchema>

export const legacyImportResultSchema = z.object({
  batchId: identifierSchema,
  status: z.enum(['applied', 'duplicate', 'rejected']),
  importedConversations: z.number().int().nonnegative().optional(),
  importedMessages: z.number().int().nonnegative().optional(),
  errorCode: appErrorCodeSchema.optional(),
}).strict()
export type LegacyImportResult = z.infer<typeof legacyImportResultSchema>

export const chatSendInputSchema = z.object({
  conversationId: identifierSchema,
  content: z.string().trim(),
  assetIds: z.array(identifierSchema).max(5).default([]),
  outputType: outputTypeSchema.default('auto'),
  model: nonEmptyStringSchema.optional(),
  generation: generationOptionsSchema,
}).strict().superRefine(({ content, assetIds, outputType }, context) => {
  if (!content && assetIds.length === 0) {
    context.addIssue({ code: 'custom', message: 'Text or an attachment is required' })
  }
  if (!content && outputType !== 'text' && outputType !== 'auto') {
    context.addIssue({ code: 'custom', message: 'Generation output requires a prompt' })
  }
})

export type ChatSendInput = z.infer<typeof chatSendInputSchema>

export const workflowQuerySchema = z.object({
  search: z.string().trim().optional(),
  category: z.string().trim().min(1).optional(),
  enabled: z.boolean().optional(),
  source: z.enum(['installed', 'development']).optional(),
}).strict()

export type WorkflowQuery = z.infer<typeof workflowQuerySchema>

export const workflowPermissionSchema = z.object({
  capability: capabilitySchema,
  scope: capabilityScopeSchema,
}).strict().superRefine(({ capability, scope }, context) => {
  const needsOrigins = capability.startsWith('browser.') || capability === 'network.fetch'
  const needsPaths = capability.startsWith('filesystem.')

  if (needsOrigins && !('origins' in scope)) {
    context.addIssue({ code: 'custom', message: 'This capability requires origin scope' })
  }
  if (needsPaths && !('paths' in scope)) {
    context.addIssue({ code: 'custom', message: 'This capability requires path scope' })
  }
  if (!needsOrigins && !needsPaths && Object.keys(scope).length !== 0) {
    context.addIssue({ code: 'custom', message: 'This capability requires an empty scope' })
  }
})

export interface WorkflowPermission {
  capability: Capability
  scope: CapabilityScope
}

export const workflowSummarySchema = z.object({
  id: identifierSchema,
  version: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  description: z.string(),
  author: nonEmptyStringSchema,
  category: nonEmptyStringSchema,
  enabled: z.boolean(),
  source: z.enum(['installed', 'development']),
  integrity: z.enum(['valid', 'failed', 'unchecked']),
  updatedAt: timestampSchema,
}).strict()

export type WorkflowSummary = z.infer<typeof workflowSummarySchema>

export const workflowRuntimeIdentitySchema = z.discriminatedUnion('source', [
  z.object({
    id: identifierSchema,
    version: nonEmptyStringSchema,
    source: z.literal('installed'),
  }).strict(),
  z.object({
    id: identifierSchema,
    version: nonEmptyStringSchema,
    source: z.literal('development'),
    buildHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
])

export type WorkflowRuntimeIdentity = z.infer<typeof workflowRuntimeIdentitySchema>

const citySchema = nonEmptyStringSchema

export const browserContinuationManifestSchema = z.object({
  auth: z.object({
    loginUrls: nonEmptyUniqueArraySchema(httpsUrlPatternSchema).optional(),
    loggedIn: nonEmptyUniqueArraySchema(browserLocatorSchema).optional(),
    loggedOut: nonEmptyUniqueArraySchema(browserLocatorSchema).optional(),
  }).strict().optional(),
  readableRegions: nonEmptyUniqueArraySchema(browserLocatorSchema).optional(),
  manualActions: nonEmptyUniqueArraySchema(z.object({
    locator: browserLocatorSchema,
    reason: nonEmptyStringSchema.max(500),
  }).strict()).optional(),
}).strict()

export const workflowDetailSchema = workflowSummarySchema.extend({
  codeSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  cities: z.array(citySchema).default([]),
  runtimeIdentity: workflowRuntimeIdentitySchema,
  permissions: z.array(workflowPermissionSchema),
  activationExamples: z.array(nonEmptyStringSchema),
  activationNegativeExamples: z.array(nonEmptyStringSchema),
  timeoutMs: z.number().int().min(1_000).max(300_000),
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  browserContinuation: browserContinuationManifestSchema.optional(),
}).superRefine(({ cities, id, version, source, runtimeIdentity }, context) => {
  if (new Set(cities).size !== cities.length) {
    context.addIssue({ code: 'custom', path: ['cities'], message: 'Workflow cities must be unique' })
  }
  if (runtimeIdentity.id !== id) {
    context.addIssue({ code: 'custom', path: ['runtimeIdentity', 'id'], message: 'Workflow runtime identity must match the workflow id' })
  }
  if (runtimeIdentity.version !== version) {
    context.addIssue({ code: 'custom', path: ['runtimeIdentity', 'version'], message: 'Workflow runtime identity must match the workflow version' })
  }
  if (runtimeIdentity.source !== source) {
    context.addIssue({ code: 'custom', path: ['runtimeIdentity', 'source'], message: 'Workflow runtime identity must match the workflow source' })
  }
})

export type WorkflowDetail = z.infer<typeof workflowDetailSchema>

export const validationDiagnosticSchema = z.object({
  path: z.string(),
  message: nonEmptyStringSchema,
  severity: z.enum(['error', 'warning']),
}).strict()

export type ValidationDiagnostic = z.infer<typeof validationDiagnosticSchema>

export const validationResultSchema = z.object({
  valid: z.boolean(),
  diagnostics: z.array(validationDiagnosticSchema),
}).strict()

export type ValidationResult = z.infer<typeof validationResultSchema>

export const workflowChatAvailabilitySchema = z.enum(['ready', 'not_built', 'unbuilt_changes', 'invalid'])

export type WorkflowChatAvailability = z.infer<typeof workflowChatAvailabilitySchema>

export const developerProjectSchema = z.object({
  id: identifierSchema,
  name: nonEmptyStringSchema,
  rootPath: nonEmptyStringSchema,
  status: z.enum(['new', 'building', 'ready', 'invalid', 'error']),
  chatAvailability: workflowChatAvailabilitySchema,
  files: z.array(nonEmptyStringSchema),
  directories: z.array(nonEmptyStringSchema),
  updatedAt: timestampSchema,
}).strict()

export type DeveloperProject = z.infer<typeof developerProjectSchema>

export const developerRunInputSchema = z.object({
  projectId: identifierSchema,
  input: z.unknown(),
}).strict()

export type DeveloperRunInput = z.infer<typeof developerRunInputSchema>

export const developerRunResultSchema = z.union([
  z.object({ executionId: identifierSchema }).strict(),
  z.object({ validationError: nonEmptyStringSchema.max(500) }).strict(),
])

export type DeveloperRunResult = z.infer<typeof developerRunResultSchema>

export const executionQuerySchema = z.object({
  status: z.enum([
    'queued', 'awaiting_approval', 'running', 'completed', 'failed', 'cancelled', 'interrupted',
  ]).optional(),
  workflowId: identifierSchema.optional(),
  search: z.string().trim().optional(),
  from: timestampSchema.optional(),
  to: timestampSchema.optional(),
}).strict()

export type ExecutionQuery = z.infer<typeof executionQuerySchema>

export const executionSummarySchema = z.object({
  id: identifierSchema,
  workflowId: identifierSchema,
  workflowVersion: nonEmptyStringSchema,
  status: z.enum([
    'queued', 'awaiting_approval', 'running', 'completed', 'failed', 'cancelled', 'interrupted',
  ]),
  startedAt: timestampSchema.optional(),
  finishedAt: timestampSchema.optional(),
  createdAt: timestampSchema,
}).strict()

export interface ExecutionSummary extends Omit<z.infer<typeof executionSummarySchema>, 'status'> {
  status: ExecutionStatus
}

export const executionStepSchema = z.object({
  id: identifierSchema,
  label: nonEmptyStringSchema,
  status: z.enum(['running', 'completed', 'failed']),
  startedAt: timestampSchema.optional(),
  finishedAt: timestampSchema.optional(),
}).strict()

export type ExecutionStep = z.infer<typeof executionStepSchema>

export const executionLogSchema = z.object({
  id: identifierSchema,
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string(),
  createdAt: timestampSchema,
}).strict()

export type ExecutionLog = z.infer<typeof executionLogSchema>

export const executionDetailSchema = executionSummarySchema.extend({
  input: z.unknown(),
  output: z.unknown().optional(),
  error: z.object({
    code: nonEmptyStringSchema,
    message: nonEmptyStringSchema,
  }).strict().optional(),
  steps: z.array(executionStepSchema),
  logs: z.array(executionLogSchema),
})

export interface ExecutionDetail extends Omit<z.infer<typeof executionDetailSchema>, 'status'> {
  status: ExecutionStatus
}

const oneTimeApprovalDecisionSchema = z.object({
  executionId: identifierSchema,
  permissionIndex: z.number().int().nonnegative(),
  scopeHash: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(['once', 'deny']),
}).strict()

const persistentApprovalDecisionSchema = z.object({
  executionId: identifierSchema,
  permissionIndex: z.number().int().nonnegative(),
  scopeHash: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.literal('always'),
  workflowId: identifierSchema,
  workflowVersion: nonEmptyStringSchema,
  capability: capabilitySchema,
  scope: runtimeCapabilityScopeSchema,
}).strict().superRefine(({ capability, scope }, context) => {
  const result = runtimeCapabilityPermissionSchema.safeParse({ capability, scope })
  if (!result.success) {
    context.addIssue({ code: 'custom', message: 'Persistent approval scope is invalid for this capability' })
  }
})

export const approvalDecisionSchema = z.union([
  oneTimeApprovalDecisionSchema,
  persistentApprovalDecisionSchema,
])

export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>

export const permissionGrantSchema = z.object({
  id: identifierSchema,
  workflowId: identifierSchema,
  workflowVersion: nonEmptyStringSchema,
  capability: capabilitySchema,
  scope: runtimeCapabilityScopeSchema,
  createdAt: timestampSchema,
}).strict().superRefine(({ capability, scope }, context) => {
  if (!runtimeCapabilityPermissionSchema.safeParse({ capability, scope }).success) {
    context.addIssue({ code: 'custom', message: 'Permission grant scope is invalid for this capability' })
  }
})

export type PermissionGrant = z.infer<typeof permissionGrantSchema>

export const modelProviderIdSchema = z.enum(['deepseek', 'openrouter'])
export type ModelProviderId = z.infer<typeof modelProviderIdSchema>

export const accountDataPreferencesDefaults = {
  timezone: 'Asia/Shanghai',
  displayCurrency: 'CNY',
} as const

export const accountDataPreferencesSchema = z.object({
  timezone: nonEmptyStringSchema.max(128).default(accountDataPreferencesDefaults.timezone),
  displayCurrency: z.enum(['CNY', 'USD']).default(accountDataPreferencesDefaults.displayCurrency),
}).strict()
export type AccountDataPreferences = z.infer<typeof accountDataPreferencesSchema>

export const accountDataPreferencesRecordSchema = accountDataPreferencesSchema.extend({
  revision: z.number().int().nonnegative(),
  updatedAt: timestampSchema,
}).strict()
export type AccountDataPreferencesRecord = z.infer<typeof accountDataPreferencesRecordSchema>

export const providerDefaultModelsSchema = z.object({
  deepseek: z.object({ text: nonEmptyStringSchema }).strict(),
  openrouter: z.object({
    text: nonEmptyStringSchema.optional(),
    image: nonEmptyStringSchema.optional(),
    audio: nonEmptyStringSchema.optional(),
    video: nonEmptyStringSchema.optional(),
  }).strict(),
}).strict()
export type ProviderDefaultModels = z.infer<typeof providerDefaultModelsSchema>

export const appSettingsSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']),
  language: z.enum(['zh-CN', 'en-US']),
  dataDirectory: nonEmptyStringSchema,
  logDirectory: nonEmptyStringSchema,
  activeProvider: modelProviderIdSchema,
  defaultModels: providerDefaultModelsSchema,
  showCosts: z.boolean(),
  developerMode: z.boolean(),
  permissionDefault: z.literal('ask'),
  proxy: proxySettingsSchema,
}).strict()

export type AppSettings = z.infer<typeof appSettingsSchema>

export const appSettingsPatchSchema = appSettingsSchema.partial().strict()

export type AppSettingsPatch = z.infer<typeof appSettingsPatchSchema>

export const providerCredentialStatusSchema = z.object({
  provider: modelProviderIdSchema,
  configured: z.boolean(),
  validation: z.enum(['unchecked', 'valid', 'invalid', 'denied', 'unavailable']),
  message: z.string().optional(),
  checkedAt: timestampSchema.optional(),
}).strict()

export type ProviderCredentialStatus = z.infer<typeof providerCredentialStatusSchema>

export const modelInfoSchema = z.object({
  id: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  contextLength: z.number().int().positive().optional(),
  inputCostPerMillion: z.number().nonnegative().optional(),
  outputCostPerMillion: z.number().nonnegative().optional(),
  inputModalities: z.array(providerUsageModalitySchema),
  outputModalities: z.array(providerUsageModalitySchema),
  supportsTools: z.boolean(),
  generation: z.object({
    image: z.object({
      resolutions: z.array(z.string()),
      aspectRatios: z.array(z.string()),
      formats: z.array(z.string()),
      maxCount: z.number().int().positive(),
    }).strict().optional(),
    audio: z.object({
      voices: z.array(z.string()),
      formats: z.array(z.string()),
    }).strict().optional(),
    video: z.object({
      resolutions: z.array(z.string()),
      aspectRatios: z.array(z.string()),
      durations: z.array(z.number().int().positive()),
      supportsAudio: z.boolean(),
      frameImages: z.array(videoFrameTypeSchema),
      maxReferenceImages: z.number().int().positive().optional(),
    }).strict().optional(),
  }).strict(),
}).strict()

export type ModelInfo = z.infer<typeof modelInfoSchema>

const safeTokenCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const usdDecimalPattern = /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/
const usdDecimalSchema = z.string().regex(usdDecimalPattern)
const providerCostShape = {
  openRouterCostUsd: usdDecimalSchema,
  openRouterKnownCostCount: safeTokenCountSchema,
  openRouterUnknownCostCount: safeTokenCountSchema,
}
const tokenUsageShape = {
  inputTokens: safeTokenCountSchema,
  outputTokens: safeTokenCountSchema,
  totalTokens: safeTokenCountSchema,
}

export const remoteUsageStatusSchema = z.enum([
  'pending',
  'reported',
  'calculated',
  'estimated',
  'unavailable',
])
export type RemoteUsageStatus = z.infer<typeof remoteUsageStatusSchema>

const byokUsageEventShape = {
  id: identifierSchema,
  operationId: identifierSchema,
  purpose: nonEmptyStringSchema.max(64),
  credentialOwner: z.literal('user'),
  billable: z.literal(false),
  provider: modelProviderIdSchema,
  model: nonEmptyStringSchema,
  modality: providerUsageModalitySchema,
  inputTokens: safeTokenCountSchema.optional(),
  outputTokens: safeTokenCountSchema.optional(),
  occurredAt: timestampSchema,
}

export const byokUsageEventSchema = z.discriminatedUnion('costStatus', [
  z.object({
    ...byokUsageEventShape,
    costStatus: z.literal('estimated'),
    estimatedCostUsd: usdDecimalSchema,
  }).strict(),
  z.object({
    ...byokUsageEventShape,
    costStatus: z.literal('unavailable'),
  }).strict(),
])
export type ByokUsageEvent = z.infer<typeof byokUsageEventSchema>

export const remoteUsageSnapshotSchema = z.object({
  startedAt: timestampSchema,
  endedAt: timestampSchema,
  inputTokens: safeTokenCountSchema,
  outputTokens: safeTokenCountSchema,
  totalTokens: safeTokenCountSchema,
  confirmedPlatformCost: z.object({
    amount: usdDecimalSchema,
    currency: z.enum(['CNY', 'USD']),
  }).strict().nullable(),
  pendingCount: safeTokenCountSchema,
  byokEstimatedCostUsd: usdDecimalSchema,
  byokEstimatedCount: safeTokenCountSchema,
  byokUnavailableCount: safeTokenCountSchema,
  timezone: nonEmptyStringSchema.max(128),
  displayCurrency: z.enum(['CNY', 'USD']),
  lastSyncAt: timestampSchema.optional(),
}).strict().superRefine((snapshot, context) => {
  if (snapshot.totalTokens !== snapshot.inputTokens + snapshot.outputTokens) {
    context.addIssue({ code: 'custom', path: ['totalTokens'], message: 'Token totals must match' })
  }
})
export type RemoteUsageSnapshot = z.infer<typeof remoteUsageSnapshotSchema>

const syncMutationBaseShape = {
  id: identifierSchema,
  entityId: identifierSchema,
  baseRevision: z.number().int().nonnegative(),
  occurredAt: timestampSchema,
}

export const syncMutationSchema = z.discriminatedUnion('kind', [
  z.object({
    ...syncMutationBaseShape,
    kind: z.literal('conversation.create'),
    payload: conversationCreateMutationPayloadSchema,
  }).strict(),
  z.object({
    ...syncMutationBaseShape,
    kind: z.literal('conversation.rename'),
    payload: conversationRenameMutationPayloadSchema,
  }).strict(),
  z.object({
    ...syncMutationBaseShape,
    kind: z.literal('conversation.preferences'),
    payload: conversationPreferencesMutationPayloadSchema,
  }).strict(),
  z.object({
    ...syncMutationBaseShape,
    kind: z.literal('conversation.delete'),
    payload: conversationDeleteMutationPayloadSchema,
  }).strict(),
  z.object({
    ...syncMutationBaseShape,
    kind: z.literal('conversation.restore'),
    payload: conversationRestoreMutationPayloadSchema,
  }).strict(),
  z.object({
    ...syncMutationBaseShape,
    kind: z.literal('message.append'),
    payload: messageAppendMutationPayloadSchema,
  }).strict(),
  z.object({
    ...syncMutationBaseShape,
    kind: z.literal('legacy.import'),
    payload: legacyImportConfirmRequestSchema,
  }).strict(),
  z.object({
    ...syncMutationBaseShape,
    kind: z.literal('privacy.consent'),
    payload: privacyConsentSchema,
  }).strict(),
  z.object({
    ...syncMutationBaseShape,
    kind: z.literal('preferences.update'),
    payload: accountDataPreferencesSchema,
  }).strict(),
  z.object({
    ...syncMutationBaseShape,
    kind: z.literal('usage.record'),
    payload: byokUsageEventSchema,
  }).strict(),
]).superRefine((mutation, context) => {
  let payloadEntityId: string | undefined
  switch (mutation.kind) {
    case 'message.append':
    case 'usage.record':
      payloadEntityId = mutation.payload.id
      break
    case 'legacy.import':
      payloadEntityId = mutation.payload.batchId
      break
    case 'privacy.consent':
      payloadEntityId = mutation.payload.documentVersion
      break
  }
  if (payloadEntityId !== undefined && mutation.entityId !== payloadEntityId) {
    context.addIssue({
      code: 'custom',
      path: ['entityId'],
      message: 'Mutation entity identity does not match its payload.',
    })
  }
})
export type SyncMutation = z.infer<typeof syncMutationSchema>

export const storedLegacyImportReceiptPayloadSchema = z.object({
  batchId: identifierSchema,
  includeUnowned: z.boolean(),
}).strict()
export type StoredLegacyImportReceiptPayload = z.infer<typeof storedLegacyImportReceiptPayloadSchema>

const pulledMutationBaseShape = {
  id: identifierSchema,
  entityId: identifierSchema,
  baseRevision: z.number().int().nonnegative(),
  resultRevision: z.number().int().nonnegative().nullable(),
  receivedAt: timestampSchema,
}

const ordinaryPulledMutationSchema = z.discriminatedUnion('kind', [
  z.object({
    ...pulledMutationBaseShape,
    kind: z.literal('conversation.create'),
    payload: conversationCreateMutationPayloadSchema,
  }).strict(),
  z.object({
    ...pulledMutationBaseShape,
    kind: z.literal('conversation.rename'),
    payload: conversationRenameMutationPayloadSchema,
  }).strict(),
  z.object({
    ...pulledMutationBaseShape,
    kind: z.literal('conversation.preferences'),
    payload: conversationPreferencesMutationPayloadSchema,
  }).strict(),
  z.object({
    ...pulledMutationBaseShape,
    kind: z.literal('conversation.delete'),
    payload: conversationDeleteMutationPayloadSchema,
  }).strict(),
  z.object({
    ...pulledMutationBaseShape,
    kind: z.literal('conversation.restore'),
    payload: conversationRestoreMutationPayloadSchema,
  }).strict(),
  z.object({
    ...pulledMutationBaseShape,
    kind: z.literal('message.append'),
    payload: messageAppendMutationPayloadSchema,
  }).strict(),
  z.object({
    ...pulledMutationBaseShape,
    kind: z.literal('legacy.import'),
    payload: storedLegacyImportReceiptPayloadSchema,
  }).strict(),
  z.object({
    ...pulledMutationBaseShape,
    kind: z.literal('privacy.consent'),
    payload: privacyConsentSchema,
  }).strict(),
  z.object({
    ...pulledMutationBaseShape,
    kind: z.literal('preferences.update'),
    payload: accountDataPreferencesSchema,
  }).strict(),
  z.object({
    ...pulledMutationBaseShape,
    kind: z.literal('usage.record'),
    payload: byokUsageEventSchema,
  }).strict(),
]).superRefine((mutation, context) => {
  let payloadEntityId: string | undefined
  switch (mutation.kind) {
    case 'message.append':
    case 'usage.record':
      payloadEntityId = mutation.payload.id
      break
    case 'legacy.import':
      payloadEntityId = mutation.payload.batchId
      break
    case 'privacy.consent':
      payloadEntityId = mutation.payload.documentVersion
      break
  }
  if (payloadEntityId !== undefined && mutation.entityId !== payloadEntityId) {
    context.addIssue({
      code: 'custom',
      path: ['entityId'],
      message: 'Mutation entity identity does not match its payload.',
    })
  }
})

const compactedPulledMutationBaseShape = {
  ...pulledMutationBaseShape,
  compacted: z.literal(true),
}

export const compactedPulledMutationSchema = z.discriminatedUnion('kind', [
  z.object({
    ...compactedPulledMutationBaseShape,
    kind: z.literal('conversation.create'),
  }).strict(),
  z.object({
    ...compactedPulledMutationBaseShape,
    kind: z.literal('conversation.rename'),
  }).strict(),
  z.object({
    ...compactedPulledMutationBaseShape,
    kind: z.literal('conversation.preferences'),
  }).strict(),
  z.object({
    ...compactedPulledMutationBaseShape,
    kind: z.literal('conversation.delete'),
  }).strict(),
  z.object({
    ...compactedPulledMutationBaseShape,
    kind: z.literal('conversation.restore'),
  }).strict(),
  z.object({
    ...compactedPulledMutationBaseShape,
    kind: z.literal('message.append'),
    conversationId: identifierSchema,
  }).strict(),
])
export type CompactedPulledMutation = z.infer<typeof compactedPulledMutationSchema>

export const pulledMutationSchema = z.union([
  ordinaryPulledMutationSchema,
  compactedPulledMutationSchema,
])
export type PulledMutation = z.infer<typeof pulledMutationSchema>

export const modelTokenUsageSchema = z.object({
  provider: modelProviderIdSchema,
  model: nonEmptyStringSchema,
  ...tokenUsageShape,
  ...providerCostShape,
}).strict().superRefine((usage, context) => {
  const total = usage.inputTokens + usage.outputTokens
  if (!Number.isSafeInteger(total) || usage.totalTokens !== total) {
    context.addIssue({
      code: 'custom',
      path: ['totalTokens'],
      message: 'Token total must equal input plus output',
    })
  }
})

export const tokenUsagePeriodKeys = ['today', 'yesterday', 'week', 'month', 'allTime'] as const
export type TokenUsagePeriodKey = (typeof tokenUsagePeriodKeys)[number]

export const tokenUsageTrendPointSchema = z.object({
  startedAt: timestampSchema,
  ...tokenUsageShape,
}).strict().superRefine((point, context) => {
  const total = point.inputTokens + point.outputTokens
  if (!Number.isSafeInteger(total) || point.totalTokens !== total) {
    context.addIssue({
      code: 'custom',
      path: ['totalTokens'],
      message: 'Trend total must equal input plus output',
    })
  }
})

export const tokenUsagePeriodSchema = z.object({
  startedAt: timestampSchema,
  endedAt: timestampSchema,
  ...tokenUsageShape,
  ...providerCostShape,
  models: z.array(modelTokenUsageSchema),
  trend: z.array(tokenUsageTrendPointSchema),
}).strict().superRefine((usage, context) => {
  const startedAt = Date.parse(usage.startedAt)
  const endedAt = Date.parse(usage.endedAt)
  if (startedAt > endedAt) {
    context.addIssue({ code: 'custom', path: ['endedAt'], message: 'Period end must not precede start' })
  }

  const modelIds = new Set<string>()
  let modelInput = 0
  let modelOutput = 0
  let modelKnownCosts = 0
  let modelUnknownCosts = 0
  let modelCostScale = 0
  let modelCostDigits = 0n
  for (const model of usage.models) {
    const modelId = `${model.provider}\u0000${model.model}`
    if (modelIds.has(modelId)) {
      context.addIssue({ code: 'custom', path: ['models'], message: 'Token usage models must be unique' })
    }
    modelIds.add(modelId)
    modelInput += model.inputTokens
    modelOutput += model.outputTokens
    modelKnownCosts += model.openRouterKnownCostCount
    modelUnknownCosts += model.openRouterUnknownCostCount
    const modelCost = model.openRouterCostUsd
    if (typeof modelCost !== 'string' || !usdDecimalPattern.test(modelCost)) continue
    const [integer, fraction = ''] = modelCost.split('.')
    if (fraction.length > modelCostScale) {
      modelCostDigits *= 10n ** BigInt(fraction.length - modelCostScale)
      modelCostScale = fraction.length
    }
    modelCostDigits += BigInt(`${integer}${fraction}`)
      * 10n ** BigInt(modelCostScale - fraction.length)
  }

  const costDigits = modelCostDigits.toString().padStart(modelCostScale + 1, '0')
  const modelCost = modelCostScale === 0
    ? costDigits
    : `${costDigits.slice(0, -modelCostScale)}.${costDigits.slice(-modelCostScale)}`
        .replace(/0+$/, '')
        .replace(/\.$/, '')

  let trendInput = 0
  let trendOutput = 0
  let previousStartedAt = -1
  for (const point of usage.trend) {
    const pointStartedAt = Date.parse(point.startedAt)
    if (pointStartedAt < startedAt || pointStartedAt >= endedAt || pointStartedAt <= previousStartedAt) {
      context.addIssue({
        code: 'custom',
        path: ['trend'],
        message: 'Trend points must be unique, ordered and inside the period',
      })
    }
    previousStartedAt = pointStartedAt
    trendInput += point.inputTokens
    trendOutput += point.outputTokens
  }

  const totals = [
    modelInput,
    modelOutput,
    modelInput + modelOutput,
    trendInput,
    trendOutput,
    trendInput + trendOutput,
  ]
  if (totals.some((value) => !Number.isSafeInteger(value))
    || usage.inputTokens !== modelInput
    || usage.outputTokens !== modelOutput
    || usage.totalTokens !== modelInput + modelOutput
    || usage.inputTokens !== trendInput
    || usage.outputTokens !== trendOutput
    || usage.totalTokens !== trendInput + trendOutput) {
    context.addIssue({ code: 'custom', message: 'Period, model and trend totals must match' })
  }
  if (!Number.isSafeInteger(modelKnownCosts)
    || !Number.isSafeInteger(modelUnknownCosts)
    || usage.openRouterCostUsd !== modelCost
    || usage.openRouterKnownCostCount !== modelKnownCosts
    || usage.openRouterUnknownCostCount !== modelUnknownCosts) {
    context.addIssue({ code: 'custom', message: 'Period and model provider cost totals must match' })
  }
})

export const tokenUsageSnapshotSchema = z.object({
  generatedAt: timestampSchema,
  today: tokenUsagePeriodSchema,
  yesterday: tokenUsagePeriodSchema,
  week: tokenUsagePeriodSchema,
  month: tokenUsagePeriodSchema,
  allTime: tokenUsagePeriodSchema,
}).strict().superRefine((snapshot, context) => {
  const generatedAt = Date.parse(snapshot.generatedAt)
  for (const key of ['today', 'week', 'month', 'allTime'] as const) {
    if (Date.parse(snapshot[key].endedAt) !== generatedAt) {
      context.addIssue({ code: 'custom', path: [key, 'endedAt'], message: 'Active period must end at generation time' })
    }
  }
  if (Date.parse(snapshot.yesterday.endedAt) !== Date.parse(snapshot.today.startedAt)) {
    context.addIssue({ code: 'custom', path: ['yesterday', 'endedAt'], message: 'Yesterday must end when today starts' })
  }
})

export type ModelTokenUsage = z.infer<typeof modelTokenUsageSchema>
export type TokenUsageTrendPoint = z.infer<typeof tokenUsageTrendPointSchema>
export type TokenUsagePeriod = z.infer<typeof tokenUsagePeriodSchema>
export type TokenUsageSnapshot = z.infer<typeof tokenUsageSnapshotSchema>

export const appInfoSchema = z.object({
  version: nonEmptyStringSchema,
  platform: z.enum(['darwin', 'win32']),
}).strict()
export type AppInfo = z.infer<typeof appInfoSchema>

export const ipcChannels = {
  authGetSession: 'auth:get-session',
  authRefreshAuthorization: 'auth:refresh-authorization',
  authSendOtp: 'auth:send-otp',
  authVerifyOtp: 'auth:verify-otp',
  authCancelOtp: 'auth:cancel-otp',
  authLoginWithPassword: 'auth:login-with-password',
  authLogout: 'auth:logout',
  userAdminList: 'user-admin:list',
  userAdminUpdateRole: 'user-admin:update-role',
  profileGet: 'profile:get',
  profileUpdate: 'profile:update',
  profilePickAndUploadAvatar: 'profile:pick-and-upload-avatar',
  chatListConversations: 'chat:list-conversations',
  chatListMessages: 'chat:list-messages',
  chatCreateConversation: 'chat:create-conversation',
  chatRenameConversation: 'chat:rename-conversation',
  chatDeleteConversation: 'chat:delete-conversation',
  chatRetrySync: 'chat:retry-sync',
  chatSend: 'chat:send',
  chatCancel: 'chat:cancel',
  chatTakeOverBrowser: 'chat:take-over-browser',
  chatListBrowserAudit: 'chat:list-browser-audit',
  chatGetGenerationPreferences: 'chat:get-generation-preferences',
  chatUpdateGenerationPreferences: 'chat:update-generation-preferences',
  chatEvent: 'chat:event',
  mediaPickFiles: 'media:pick-files',
  mediaImportDroppedFiles: 'media:import-dropped-files',
  mediaImportClipboardImage: 'media:import-clipboard-image',
  mediaRemoveDraft: 'media:remove-draft',
  mediaSaveCopy: 'media:save-copy',
  mediaReveal: 'media:reveal',
  mediaPauseVideoJob: 'media:pause-video-job',
  mediaResumeVideoJob: 'media:resume-video-job',
  workflowsList: 'workflows:list',
  workflowsGet: 'workflows:get',
  workflowsSetEnabled: 'workflows:set-enabled',
  workflowsRemove: 'workflows:remove',
  workflowsInstallProject: 'workflows:install-project',
  developerCreateProject: 'developer:create-project',
  developerListProjects: 'developer:list-projects',
  developerRegisterProject: 'developer:register-project',
  developerReadFile: 'developer:read-file',
  developerWriteFile: 'developer:write-file',
  developerCreateEntry: 'developer:create-entry',
  developerRenameEntry: 'developer:rename-entry',
  developerDeleteEntry: 'developer:delete-entry',
  developerBuildProject: 'developer:build-project',
  developerValidate: 'developer:validate',
  developerRun: 'developer:run',
  executionsList: 'executions:list',
  executionsGet: 'executions:get',
  executionsDecide: 'executions:decide',
  executionsCancel: 'executions:cancel',
  executionsEvent: 'executions:event',
  permissionsListGrants: 'permissions:list-grants',
  permissionsRevoke: 'permissions:revoke',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsSaveProviderApiKey: 'settings:save-provider-api-key',
  settingsClearProviderApiKey: 'settings:clear-provider-api-key',
  settingsValidateProviderCredential: 'settings:validate-provider-credential',
  settingsListProviderModels: 'settings:list-provider-models',
  settingsGetTokenUsage: 'settings:get-token-usage',
  settingsRecordPrivacyConsent: 'settings:record-privacy-consent',
  settingsPreviewLegacyImport: 'settings:preview-legacy-import',
  settingsImportLegacyData: 'settings:import-legacy-data',
  settingsGetAccountDataPreferences: 'settings:get-account-data-preferences',
  settingsUpdateAccountDataPreferences: 'settings:update-account-data-preferences',
  settingsGetRemoteUsage: 'settings:get-remote-usage',
  settingsClearLocalData: 'settings:clear-local-data',
  settingsClearBrowserData: 'settings:clear-browser-data',
  knowledgeList: 'knowledge:list',
  knowledgeCreateBase: 'knowledge:create-base',
  knowledgeListDocuments: 'knowledge:list-documents',
  knowledgeListVersions: 'knowledge:list-versions',
  knowledgePickImportFiles: 'knowledge:pick-import-files',
  knowledgeImportDocument: 'knowledge:import-document',
  knowledgeReplaceDocument: 'knowledge:replace-document',
  knowledgeRecycleDocument: 'knowledge:recycle-document',
  knowledgeRestoreDocument: 'knowledge:restore-document',
  knowledgePurgeDocument: 'knowledge:purge-document',
  knowledgeRecycleBase: 'knowledge:recycle-base',
  knowledgeRestoreBase: 'knowledge:restore-base',
  knowledgePurgeBase: 'knowledge:purge-base',
  knowledgeExportBase: 'knowledge:export-base',
  knowledgeGetSelection: 'knowledge:get-selection',
  knowledgeUpdateSelection: 'knowledge:update-selection',
  knowledgeSearch: 'knowledge:search',
  knowledgeGetAvailability: 'knowledge:get-availability',
  knowledgeGetEntitlement: 'knowledge:get-entitlement',
  knowledgeRetainFreeAllowance: 'knowledge:retain-free-allowance',
  knowledgeGetConsent: 'knowledge:get-consent',
  knowledgeSetConsent: 'knowledge:set-consent',
  knowledgeRevokeConsent: 'knowledge:revoke-consent',
  knowledgeGetSourcePreview: 'knowledge:get-source-preview',
  knowledgeEvent: 'knowledge:event',
  systemOpenExternal: 'system:open-external',
  systemGetAppInfo: 'system:get-app-info',
} as const

export type IpcChannel = (typeof ipcChannels)[keyof typeof ipcChannels]

export const createConversationRequestSchema = z.undefined()
export const listConversationsRequestSchema = z.object({
  limit: z.literal(50),
  cursor: opaqueCursorSchema.optional(),
}).strict()
export type ListConversationsRequest = z.infer<typeof listConversationsRequestSchema>
export const listMessagesRequestSchema = z.object({
  conversationId: identifierSchema,
  limit: z.literal(100),
  cursor: opaqueCursorSchema.optional(),
}).strict()
export type ListMessagesRequest = z.infer<typeof listMessagesRequestSchema>
export const renameConversationRequestSchema = z.object({
  conversationId: identifierSchema,
  title: nonEmptyStringSchema,
}).strict()
export const deleteConversationRequestSchema = z.object({ conversationId: identifierSchema }).strict()
export const retryConversationSyncRequestSchema = z.object({
  conversationId: identifierSchema.optional(),
}).strict()
export const cancelChatRequestSchema = z.object({ requestId: identifierSchema }).strict()
export const generationPreferencesRequestSchema = z.object({ conversationId: identifierSchema }).strict()
export const updateGenerationPreferencesRequestSchema = generationPreferencesRequestSchema.extend({
  preferences: conversationGenerationPreferencesSchema,
})
export const importDroppedFilesRequestSchema = mediaImportContextSchema.extend({
  paths: z.array(nonEmptyStringSchema).max(5),
})
export const mediaAssetRequestSchema = z.object({ assetId: identifierSchema }).strict()
export const mediaGenerationJobRequestSchema = z.object({ jobId: identifierSchema }).strict()
export const workflowListRequestSchema = workflowQuerySchema.optional()
export const workflowGetRequestSchema = z.object({
  id: identifierSchema,
  version: nonEmptyStringSchema.optional(),
}).strict()
export const workflowSetEnabledRequestSchema = z.object({ id: identifierSchema, version: nonEmptyStringSchema, enabled: z.boolean() }).strict()
export const workflowRemoveRequestSchema = z.object({ id: identifierSchema, version: nonEmptyStringSchema }).strict()
export const workflowInstallProjectRequestSchema = z.object({ projectId: identifierSchema }).strict()
export const createProjectRequestSchema = z.object({ name: nonEmptyStringSchema }).strict()
export const listProjectsRequestSchema = z.undefined()
export const registerProjectRequestSchema = z.undefined()
export const readFileRequestSchema = z.object({
  projectId: identifierSchema,
  relativePath: nonEmptyStringSchema,
}).strict()
export const writeFileRequestSchema = readFileRequestSchema.extend({ content: z.string() })
const developerEntryNameSchema = z.string().trim().min(1).refine(
  (value) => value !== '.' && value !== '..' && !/[\\/\0]/.test(value),
  'A single file or directory name is required',
)
export const createEntryRequestSchema = z.object({
  projectId: identifierSchema,
  parentPath: z.string(),
  name: developerEntryNameSchema,
  kind: z.enum(['file', 'directory']),
}).strict()
export const renameEntryRequestSchema = z.object({
  projectId: identifierSchema,
  relativePath: nonEmptyStringSchema,
  name: developerEntryNameSchema,
}).strict()
export const deleteEntryRequestSchema = z.object({
  projectId: identifierSchema,
  relativePath: nonEmptyStringSchema,
}).strict()
export const validateProjectRequestSchema = z.object({ projectId: identifierSchema }).strict()
export const executionListRequestSchema = executionQuerySchema.optional()
export const getExecutionRequestSchema = z.object({ executionId: identifierSchema }).strict()
export const cancelExecutionRequestSchema = z.object({ executionId: identifierSchema }).strict()
export const revokePermissionRequestSchema = z.object({ grantId: identifierSchema }).strict()
export const settingsGetRequestSchema = z.undefined()
export const settingsUpdateRequestSchema = appSettingsPatchSchema
export const providerRequestSchema = z.object({ provider: modelProviderIdSchema }).strict()
export const saveProviderApiKeyRequestSchema = providerRequestSchema.extend({ apiKey: nonEmptyStringSchema }).strict()
export const listProviderModelsRequestSchema = providerRequestSchema.extend({
  refresh: z.boolean().optional().default(false),
}).strict()
export const clearLocalDataRequestSchema = z.object({
  scope: z.enum(['conversations', 'executions', 'all']),
}).strict()
export const knowledgeListRequestSchema = z.undefined()
export const knowledgeBaseRequestSchema = z.object({ baseId: identifierSchema }).strict()
export const knowledgeDocumentRequestSchema = z.object({ documentId: identifierSchema }).strict()
export const knowledgeCreateBaseRequestSchema = z.object({ name: nonEmptyStringSchema.max(200) }).strict()
export const knowledgeImportRequestSchema = z.object({
  baseId: identifierSchema,
  importHandleId: identifierSchema,
}).strict()
export const knowledgeReplaceRequestSchema = z.object({
  documentId: identifierSchema,
  importHandleId: identifierSchema,
}).strict()
export const knowledgeSelectionRequestSchema = z.object({ conversationId: identifierSchema }).strict()
export const knowledgeUpdateSelectionRequestSchema = knowledgeSelectionRequestSchema.extend({
  selection: knowledgeSelectionSchema,
}).strict()
export const knowledgeSearchRequestSchema = z.object({ query: nonEmptyStringSchema.max(1_000) }).strict()
export const knowledgeRetentionSelectionRequestSchema = knowledgeRetentionSelectionSchema
export const knowledgeConsentRequestSchema = z.object({ provider: modelProviderIdSchema }).strict()
export const knowledgeSetConsentRequestSchema = knowledgeConsentRequestSchema.extend({
  status: z.enum(['granted', 'denied']),
}).strict()
export const openExternalRequestSchema = z.object({
  url: z.string().superRefine((value, context) => {
    try {
      const parsed = new URL(value)
      if (parsed.protocol !== 'https:'
        || parsed.username !== ''
        || parsed.password !== ''
        || parsed.port !== ''
        || parsed.href !== value) {
        context.addIssue({ code: 'custom', message: 'A canonical default-port HTTPS URL is required' })
      }
    } catch {
      context.addIssue({ code: 'custom', message: 'A canonical default-port HTTPS URL is required' })
    }
  }),
}).strict()

export const ipcRequestSchemas = {
  [ipcChannels.authGetSession]: z.undefined(),
  [ipcChannels.authRefreshAuthorization]: z.undefined(),
  [ipcChannels.authSendOtp]: authOtpRequestSchema,
  [ipcChannels.authVerifyOtp]: authOtpVerificationSchema,
  [ipcChannels.authCancelOtp]: z.object({ challengeId: identifierSchema }).strict(),
  [ipcChannels.authLoginWithPassword]: authCredentialsSchema,
  [ipcChannels.authLogout]: logoutRequestSchema,
  [ipcChannels.userAdminList]: userAdminListRequestSchema,
  [ipcChannels.userAdminUpdateRole]: userAdminUpdateRoleRequestSchema,
  [ipcChannels.profileGet]: z.undefined(),
  [ipcChannels.profileUpdate]: userProfileUpdateSchema,
  [ipcChannels.profilePickAndUploadAvatar]: z.undefined(),
  [ipcChannels.chatListConversations]: listConversationsRequestSchema,
  [ipcChannels.chatListMessages]: listMessagesRequestSchema,
  [ipcChannels.chatCreateConversation]: createConversationRequestSchema,
  [ipcChannels.chatRenameConversation]: renameConversationRequestSchema,
  [ipcChannels.chatDeleteConversation]: deleteConversationRequestSchema,
  [ipcChannels.chatRetrySync]: retryConversationSyncRequestSchema,
  [ipcChannels.chatSend]: chatSendInputSchema,
  [ipcChannels.chatCancel]: cancelChatRequestSchema,
  [ipcChannels.chatTakeOverBrowser]: takeOverBrowserRequestSchema,
  [ipcChannels.chatListBrowserAudit]: listBrowserAuditRequestSchema,
  [ipcChannels.chatGetGenerationPreferences]: generationPreferencesRequestSchema,
  [ipcChannels.chatUpdateGenerationPreferences]: updateGenerationPreferencesRequestSchema,
  [ipcChannels.mediaPickFiles]: mediaImportContextSchema,
  [ipcChannels.mediaImportDroppedFiles]: importDroppedFilesRequestSchema,
  [ipcChannels.mediaImportClipboardImage]: mediaImportContextSchema,
  [ipcChannels.mediaRemoveDraft]: mediaRemoveDraftRequestSchema,
  [ipcChannels.mediaSaveCopy]: mediaAssetRequestSchema,
  [ipcChannels.mediaReveal]: mediaAssetRequestSchema,
  [ipcChannels.mediaPauseVideoJob]: mediaGenerationJobRequestSchema,
  [ipcChannels.mediaResumeVideoJob]: mediaGenerationJobRequestSchema,
  [ipcChannels.workflowsList]: workflowListRequestSchema,
  [ipcChannels.workflowsGet]: workflowGetRequestSchema,
  [ipcChannels.workflowsSetEnabled]: workflowSetEnabledRequestSchema,
  [ipcChannels.workflowsRemove]: workflowRemoveRequestSchema,
  [ipcChannels.workflowsInstallProject]: workflowInstallProjectRequestSchema,
  [ipcChannels.developerCreateProject]: createProjectRequestSchema,
  [ipcChannels.developerListProjects]: listProjectsRequestSchema,
  [ipcChannels.developerRegisterProject]: registerProjectRequestSchema,
  [ipcChannels.developerReadFile]: readFileRequestSchema,
  [ipcChannels.developerWriteFile]: writeFileRequestSchema,
  [ipcChannels.developerCreateEntry]: createEntryRequestSchema,
  [ipcChannels.developerRenameEntry]: renameEntryRequestSchema,
  [ipcChannels.developerDeleteEntry]: deleteEntryRequestSchema,
  [ipcChannels.developerBuildProject]: validateProjectRequestSchema,
  [ipcChannels.developerValidate]: validateProjectRequestSchema,
  [ipcChannels.developerRun]: developerRunInputSchema,
  [ipcChannels.executionsList]: executionListRequestSchema,
  [ipcChannels.executionsGet]: getExecutionRequestSchema,
  [ipcChannels.executionsDecide]: approvalDecisionSchema,
  [ipcChannels.executionsCancel]: cancelExecutionRequestSchema,
  [ipcChannels.permissionsListGrants]: z.undefined(),
  [ipcChannels.permissionsRevoke]: revokePermissionRequestSchema,
  [ipcChannels.settingsGet]: settingsGetRequestSchema,
  [ipcChannels.settingsUpdate]: settingsUpdateRequestSchema,
  [ipcChannels.settingsSaveProviderApiKey]: saveProviderApiKeyRequestSchema,
  [ipcChannels.settingsClearProviderApiKey]: providerRequestSchema,
  [ipcChannels.settingsValidateProviderCredential]: providerRequestSchema,
  [ipcChannels.settingsListProviderModels]: listProviderModelsRequestSchema,
  [ipcChannels.settingsGetTokenUsage]: z.undefined(),
  [ipcChannels.settingsRecordPrivacyConsent]: privacyConsentSchema,
  [ipcChannels.settingsPreviewLegacyImport]: z.undefined(),
  [ipcChannels.settingsImportLegacyData]: legacyImportRequestSchema,
  [ipcChannels.settingsGetAccountDataPreferences]: z.undefined(),
  [ipcChannels.settingsUpdateAccountDataPreferences]: accountDataPreferencesSchema,
  [ipcChannels.settingsGetRemoteUsage]: z.undefined(),
  [ipcChannels.settingsClearLocalData]: clearLocalDataRequestSchema,
  [ipcChannels.settingsClearBrowserData]: z.undefined(),
  [ipcChannels.knowledgeList]: knowledgeListRequestSchema,
  [ipcChannels.knowledgeCreateBase]: knowledgeCreateBaseRequestSchema,
  [ipcChannels.knowledgeListDocuments]: knowledgeBaseRequestSchema,
  [ipcChannels.knowledgeListVersions]: knowledgeDocumentRequestSchema,
  [ipcChannels.knowledgePickImportFiles]: z.undefined(),
  [ipcChannels.knowledgeImportDocument]: knowledgeImportRequestSchema,
  [ipcChannels.knowledgeReplaceDocument]: knowledgeReplaceRequestSchema,
  [ipcChannels.knowledgeRecycleDocument]: knowledgeDocumentRequestSchema,
  [ipcChannels.knowledgeRestoreDocument]: knowledgeDocumentRequestSchema,
  [ipcChannels.knowledgePurgeDocument]: knowledgeDocumentRequestSchema,
  [ipcChannels.knowledgeRecycleBase]: knowledgeBaseRequestSchema,
  [ipcChannels.knowledgeRestoreBase]: knowledgeBaseRequestSchema,
  [ipcChannels.knowledgePurgeBase]: knowledgeBaseRequestSchema,
  [ipcChannels.knowledgeExportBase]: knowledgeBaseRequestSchema,
  [ipcChannels.knowledgeGetSelection]: knowledgeSelectionRequestSchema,
  [ipcChannels.knowledgeUpdateSelection]: knowledgeUpdateSelectionRequestSchema,
  [ipcChannels.knowledgeSearch]: knowledgeSearchRequestSchema,
  [ipcChannels.knowledgeGetAvailability]: z.undefined(),
  [ipcChannels.knowledgeGetEntitlement]: z.undefined(),
  [ipcChannels.knowledgeRetainFreeAllowance]: knowledgeRetentionSelectionRequestSchema,
  [ipcChannels.knowledgeGetConsent]: knowledgeConsentRequestSchema.optional(),
  [ipcChannels.knowledgeSetConsent]: knowledgeSetConsentRequestSchema,
  [ipcChannels.knowledgeRevokeConsent]: knowledgeConsentRequestSchema,
  [ipcChannels.knowledgeGetSourcePreview]: knowledgeSourcePreviewRequestSchema,
  [ipcChannels.systemOpenExternal]: openExternalRequestSchema,
  [ipcChannels.systemGetAppInfo]: z.undefined(),
} as const

const voidResponseSchema = z.void()
const requestIdResponseSchema = z.object({ requestId: identifierSchema }).strict()

export const ipcResponseSchemas = {
  [ipcChannels.authGetSession]: authSessionSchema.nullable(),
  [ipcChannels.authRefreshAuthorization]: authSessionSchema,
  [ipcChannels.authSendOtp]: authOtpChallengeSchema,
  [ipcChannels.authVerifyOtp]: authSessionSchema,
  [ipcChannels.authCancelOtp]: voidResponseSchema,
  [ipcChannels.authLoginWithPassword]: authSessionSchema,
  [ipcChannels.authLogout]: logoutResultSchema,
  [ipcChannels.userAdminList]: userAdminListResponseSchema,
  [ipcChannels.userAdminUpdateRole]: userAdminUpdateRoleResponseSchema,
  [ipcChannels.profileGet]: userProfileSchema,
  [ipcChannels.profileUpdate]: userProfileSchema,
  [ipcChannels.profilePickAndUploadAvatar]: profileAvatarUploadResultSchema.nullable(),
  [ipcChannels.chatListConversations]: conversationPageSchema,
  [ipcChannels.chatListMessages]: messagePageSchema,
  [ipcChannels.chatCreateConversation]: conversationSummarySchema,
  [ipcChannels.chatRenameConversation]: conversationSummarySchema,
  [ipcChannels.chatDeleteConversation]: voidResponseSchema,
  [ipcChannels.chatRetrySync]: voidResponseSchema,
  [ipcChannels.chatSend]: requestIdResponseSchema,
  [ipcChannels.chatCancel]: voidResponseSchema,
  [ipcChannels.chatTakeOverBrowser]: voidResponseSchema,
  [ipcChannels.chatListBrowserAudit]: z.array(browserActionAuditEntrySchema),
  [ipcChannels.chatGetGenerationPreferences]: conversationGenerationPreferencesSchema,
  [ipcChannels.chatUpdateGenerationPreferences]: conversationGenerationPreferencesSchema,
  [ipcChannels.mediaPickFiles]: z.array(mediaAssetSchema),
  [ipcChannels.mediaImportDroppedFiles]: z.array(mediaAssetSchema),
  [ipcChannels.mediaImportClipboardImage]: z.array(mediaAssetSchema),
  [ipcChannels.mediaRemoveDraft]: voidResponseSchema,
  [ipcChannels.mediaSaveCopy]: voidResponseSchema,
  [ipcChannels.mediaReveal]: voidResponseSchema,
  [ipcChannels.mediaPauseVideoJob]: voidResponseSchema,
  [ipcChannels.mediaResumeVideoJob]: voidResponseSchema,
  [ipcChannels.workflowsList]: z.array(workflowSummarySchema),
  [ipcChannels.workflowsGet]: workflowDetailSchema,
  [ipcChannels.workflowsSetEnabled]: voidResponseSchema,
  [ipcChannels.workflowsRemove]: voidResponseSchema,
  [ipcChannels.workflowsInstallProject]: workflowDetailSchema,
  [ipcChannels.developerCreateProject]: developerProjectSchema,
  [ipcChannels.developerListProjects]: z.array(developerProjectSchema),
  [ipcChannels.developerRegisterProject]: developerProjectSchema.nullable(),
  [ipcChannels.developerReadFile]: z.string(),
  [ipcChannels.developerWriteFile]: voidResponseSchema,
  [ipcChannels.developerCreateEntry]: developerProjectSchema,
  [ipcChannels.developerRenameEntry]: developerProjectSchema,
  [ipcChannels.developerDeleteEntry]: developerProjectSchema,
  [ipcChannels.developerBuildProject]: developerProjectSchema,
  [ipcChannels.developerValidate]: validationResultSchema,
  [ipcChannels.developerRun]: developerRunResultSchema,
  [ipcChannels.executionsList]: z.array(executionSummarySchema),
  [ipcChannels.executionsGet]: executionDetailSchema,
  [ipcChannels.executionsDecide]: voidResponseSchema,
  [ipcChannels.executionsCancel]: voidResponseSchema,
  [ipcChannels.permissionsListGrants]: z.array(permissionGrantSchema),
  [ipcChannels.permissionsRevoke]: voidResponseSchema,
  [ipcChannels.settingsGet]: appSettingsSchema,
  [ipcChannels.settingsUpdate]: appSettingsSchema,
  [ipcChannels.settingsSaveProviderApiKey]: providerCredentialStatusSchema,
  [ipcChannels.settingsClearProviderApiKey]: voidResponseSchema,
  [ipcChannels.settingsValidateProviderCredential]: providerCredentialStatusSchema,
  [ipcChannels.settingsListProviderModels]: z.array(modelInfoSchema),
  [ipcChannels.settingsGetTokenUsage]: tokenUsageSnapshotSchema,
  [ipcChannels.settingsRecordPrivacyConsent]: voidResponseSchema,
  [ipcChannels.settingsPreviewLegacyImport]: legacyImportPreviewSchema,
  [ipcChannels.settingsImportLegacyData]: z.array(legacyImportResultSchema),
  [ipcChannels.settingsGetAccountDataPreferences]: accountDataPreferencesSchema,
  [ipcChannels.settingsUpdateAccountDataPreferences]: accountDataPreferencesSchema,
  [ipcChannels.settingsGetRemoteUsage]: remoteUsageSnapshotSchema,
  [ipcChannels.settingsClearLocalData]: voidResponseSchema,
  [ipcChannels.settingsClearBrowserData]: voidResponseSchema,
  [ipcChannels.knowledgeList]: z.array(knowledgeBaseSummarySchema),
  [ipcChannels.knowledgeCreateBase]: knowledgeBaseSummarySchema,
  [ipcChannels.knowledgeListDocuments]: z.array(knowledgeDocumentSummarySchema),
  [ipcChannels.knowledgeListVersions]: z.array(knowledgeVersionSummarySchema),
  [ipcChannels.knowledgePickImportFiles]: z.array(knowledgeImportHandleSchema),
  [ipcChannels.knowledgeImportDocument]: knowledgeDocumentSummarySchema.optional(),
  [ipcChannels.knowledgeReplaceDocument]: knowledgeDocumentSummarySchema.optional(),
  [ipcChannels.knowledgeRecycleDocument]: voidResponseSchema,
  [ipcChannels.knowledgeRestoreDocument]: voidResponseSchema,
  [ipcChannels.knowledgePurgeDocument]: voidResponseSchema,
  [ipcChannels.knowledgeRecycleBase]: voidResponseSchema,
  [ipcChannels.knowledgeRestoreBase]: voidResponseSchema,
  [ipcChannels.knowledgePurgeBase]: voidResponseSchema,
  [ipcChannels.knowledgeExportBase]: voidResponseSchema,
  [ipcChannels.knowledgeGetSelection]: knowledgeSelectionSchema,
  [ipcChannels.knowledgeUpdateSelection]: knowledgeSelectionSchema,
  [ipcChannels.knowledgeSearch]: knowledgeSearchResultSchema,
  [ipcChannels.knowledgeGetAvailability]: knowledgeAvailabilitySchema,
  [ipcChannels.knowledgeGetEntitlement]: knowledgeEntitlementStateSchema,
  [ipcChannels.knowledgeRetainFreeAllowance]: knowledgeEntitlementStateSchema,
  [ipcChannels.knowledgeGetConsent]: knowledgeConsentStateSchema,
  [ipcChannels.knowledgeSetConsent]: knowledgeConsentStateSchema,
  [ipcChannels.knowledgeRevokeConsent]: knowledgeConsentStateSchema,
  [ipcChannels.knowledgeGetSourcePreview]: knowledgeSourcePreviewSchema,
  [ipcChannels.systemOpenExternal]: voidResponseSchema,
  [ipcChannels.systemGetAppInfo]: appInfoSchema,
} as const

export interface DesktopAPI {
  auth: {
    getSession(): Promise<AuthSession | null>
    refreshAuthorization(): Promise<AuthSession>
    sendOtp(input: AuthOtpRequest): Promise<AuthOtpChallenge>
    verifyOtp(input: AuthOtpVerification): Promise<AuthSession>
    cancelOtp(challengeId: string): Promise<void>
    loginWithPassword(input: AuthCredentials): Promise<AuthSession>
    logout(input?: LogoutRequest): Promise<LogoutResult>
  }
  profile: {
    get(): Promise<UserProfile>
    update(input: UserProfileUpdate): Promise<UserProfile>
    pickAndUploadAvatar(): Promise<ProfileAvatarUploadResult | null>
  }
  userAdmin: {
    list(input: UserAdminListRequest): Promise<UserAdminListResponse>
    updateRole(input: UserAdminUpdateRoleRequest): Promise<UserAdminUpdateRoleResponse>
  }
  chat: {
    listConversations(input: ListConversationsRequest): Promise<ConversationPage>
    listMessages(input: ListMessagesRequest): Promise<MessagePage>
    createConversation(): Promise<ConversationSummary>
    renameConversation(conversationId: string, title: string): Promise<ConversationSummary>
    deleteConversation(conversationId: string): Promise<void>
    retrySync(conversationId?: string): Promise<void>
    send(input: ChatSendInput): Promise<{ requestId: string }>
    cancel(requestId: string): Promise<void>
    takeOverBrowser(input: TakeOverBrowserRequest): Promise<void>
    listBrowserAudit(bindingId: string): Promise<BrowserActionAuditEntry[]>
    getGenerationPreferences(conversationId: string): Promise<ConversationGenerationPreferences>
    updateGenerationPreferences(
      conversationId: string,
      preferences: ConversationGenerationPreferences,
    ): Promise<ConversationGenerationPreferences>
    onEvent(listener: (event: ChatEvent) => void): () => void
  }
  media: {
    pickFiles(context: MediaImportContext): Promise<MediaAsset[]>
    importDroppedFiles(context: MediaImportContext, files: readonly File[]): Promise<MediaAsset[]>
    importClipboardImage(context: MediaImportContext): Promise<MediaAsset[]>
    removeDraft(input: MediaRemoveDraftRequest): Promise<void>
    saveCopy(assetId: string): Promise<void>
    reveal(assetId: string): Promise<void>
    pauseVideoJob(jobId: string): Promise<void>
    resumeVideoJob(jobId: string): Promise<void>
  }
  workflows: {
    list(query?: WorkflowQuery): Promise<WorkflowSummary[]>
    get(id: string, version?: string): Promise<WorkflowDetail>
    setEnabled(id: string, version: string, enabled: boolean): Promise<void>
    remove(id: string, version: string): Promise<void>
    installProject(projectId: string): Promise<WorkflowDetail>
  }
  developer: {
    listProjects(): Promise<DeveloperProject[]>
    createProject(name: string): Promise<DeveloperProject>
    registerProject(): Promise<DeveloperProject | null>
    readFile(projectId: string, relativePath: string): Promise<string>
    writeFile(projectId: string, relativePath: string, content: string): Promise<void>
    createEntry(projectId: string, parentPath: string, name: string, kind: 'file' | 'directory'): Promise<DeveloperProject>
    renameEntry(projectId: string, relativePath: string, name: string): Promise<DeveloperProject>
    deleteEntry(projectId: string, relativePath: string): Promise<DeveloperProject>
    build(projectId: string): Promise<DeveloperProject>
    validate(projectId: string): Promise<ValidationResult>
    run(input: DeveloperRunInput): Promise<DeveloperRunResult>
  }
  executions: {
    list(query?: ExecutionQuery): Promise<ExecutionSummary[]>
    get(executionId: string): Promise<ExecutionDetail>
    decide(input: ApprovalDecision): Promise<void>
    cancel(executionId: string): Promise<void>
    onEvent(listener: (event: ExecutionEvent) => void): () => void
  }
  permissions: {
    listGrants(): Promise<PermissionGrant[]>
    revoke(grantId: string): Promise<void>
  }
  settings: {
    get(): Promise<AppSettings>
    update(patch: AppSettingsPatch): Promise<AppSettings>
    saveProviderApiKey(provider: ModelProviderId, apiKey: string): Promise<ProviderCredentialStatus>
    clearProviderApiKey(provider: ModelProviderId): Promise<void>
    validateProviderCredential(provider: ModelProviderId): Promise<ProviderCredentialStatus>
    listProviderModels(provider: ModelProviderId, refresh?: boolean): Promise<ModelInfo[]>
    getTokenUsage(): Promise<TokenUsageSnapshot>
    recordPrivacyConsent(input: PrivacyConsent): Promise<void>
    previewLegacyImport(): Promise<LegacyImportPreview>
    importLegacyData(input: LegacyImportRequest): Promise<LegacyImportResult[]>
    getAccountDataPreferences(): Promise<AccountDataPreferences>
    updateAccountDataPreferences(input: AccountDataPreferences): Promise<AccountDataPreferences>
    getRemoteUsage(): Promise<RemoteUsageSnapshot>
    clearLocalData(scope: 'conversations' | 'executions' | 'all'): Promise<void>
    clearBrowserData(): Promise<void>
  }
  knowledge: {
    list(): Promise<KnowledgeBaseSummary[]>
    create(name: string): Promise<KnowledgeBaseSummary>
    listDocuments(baseId: string): Promise<KnowledgeDocumentSummary[]>
    listVersions(documentId: string): Promise<KnowledgeVersionSummary[]>
    pickImportFiles(): Promise<KnowledgeImportHandle[]>
    importDocument(baseId: string, importHandleId: string): Promise<KnowledgeDocumentSummary | undefined>
    replaceDocument(documentId: string, importHandleId: string): Promise<KnowledgeDocumentSummary | undefined>
    recycleDocument(documentId: string): Promise<void>
    restoreDocument(documentId: string): Promise<void>
    purgeDocument(documentId: string): Promise<void>
    recycleBase(baseId: string): Promise<void>
    restoreBase(baseId: string): Promise<void>
    purgeBase(baseId: string): Promise<void>
    exportBase(baseId: string): Promise<void>
    getSelection(conversationId: string): Promise<KnowledgeSelection>
    updateSelection(conversationId: string, selection: KnowledgeSelection): Promise<KnowledgeSelection>
    search(query: string): Promise<KnowledgeSearchResult>
    getAvailability(): Promise<KnowledgeAvailability>
    getEntitlement(): Promise<KnowledgeEntitlementState>
    retainFreeAllowance(input: KnowledgeRetentionSelection): Promise<KnowledgeEntitlementState>
    getConsent(provider?: ModelProviderId): Promise<KnowledgeConsentState>
    setConsent(provider: ModelProviderId, status: 'granted' | 'denied'): Promise<KnowledgeConsentState>
    revokeConsent(provider: ModelProviderId): Promise<KnowledgeConsentState>
    getSourcePreview(input: KnowledgeSourcePreviewRequest): Promise<KnowledgeSourcePreview>
    onEvent(listener: (event: KnowledgeEvent) => void): () => void
  }
  system: {
    openExternal(url: string): Promise<void>
    getAppInfo(): Promise<AppInfo>
  }
}
