import { z } from 'zod'
import { appErrorCodeSchema, appErrorSchema } from './errors.js'
import {
  capabilityScopeSchema,
  capabilitySchema,
  runtimeCapabilityPermissionSchema,
  runtimeCapabilityScopeSchema,
} from './worker-protocol.js'

const identifierSchema = z.string().trim().min(1)
const timestampSchema = z.string().datetime()
const nonEmptyStringSchema = z.string().trim().min(1)
const workflowSourceSchema = z.enum(['installed', 'development'])
const buildHashSchema = z.string().regex(/^[a-f0-9]{64}$/)

function opaqueKeyTokens(key: string): string[] {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase())
}

const sensitiveOpaqueTokens = new Set([
  'authorization', 'base64', 'cookie', 'cookies', 'credential', 'credentials',
  'owner', 'password', 'passwords', 'prompt', 'prompts', 'secret', 'secrets',
  'sql', 'token', 'tokens', 'uid',
])

function hasOpaqueTokenPair(tokens: readonly string[], first: string, second: string): boolean {
  return tokens.some((token, index) => token === first && tokens[index + 1] === second)
}

function sensitiveOpaqueKey(key: string): boolean {
  const tokens = opaqueKeyTokens(key)
  if (tokens.some((token) => sensitiveOpaqueTokens.has(token))) return true
  return hasOpaqueTokenPair(tokens, 'auth', 'header')
    || hasOpaqueTokenPair(tokens, 'user', 'id')
    || hasOpaqueTokenPair(tokens, 'api', 'key')
    || hasOpaqueTokenPair(tokens, 'service', 'key')
    || hasOpaqueTokenPair(tokens, 'response', 'body')
    || ['local', 'file', 'root', 'absolute'].some((prefix) => (
      hasOpaqueTokenPair(tokens, prefix, 'path')
    ))
    || (tokens.length === 1 && tokens[0] === 'path')
}

// Keep byte-for-byte semantics aligned with Task 3's standalone CloudBase copy.
export function sanitizeOpaqueWorkflowArgs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeOpaqueWorkflowArgs)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    sensitiveOpaqueKey(key) ? '[REDACTED]' : sanitizeOpaqueWorkflowArgs(child),
  ]))
}

function declaredScopeMatchesCapability(capability: string, scope: Record<string, unknown>): boolean {
  const needsOrigins = capability.startsWith('browser.') || capability === 'network.fetch'
  const needsPaths = capability.startsWith('filesystem.')
  const needsFormats = capability === 'file.convert'
  return needsOrigins
    ? 'origins' in scope
    : needsPaths
      ? 'paths' in scope
      : needsFormats
        ? 'formats' in scope
        : Object.keys(scope).length === 0
}

const workflowBlockContextSchema = z.object({
  workflowId: identifierSchema,
  workflowName: nonEmptyStringSchema,
  workflowVersion: nonEmptyStringSchema,
  source: workflowSourceSchema,
  buildHash: buildHashSchema.optional(),
  city: nonEmptyStringSchema.optional(),
}).strict().superRefine(({ source, buildHash }, context) => {
  if (source === 'development' && buildHash === undefined) {
    context.addIssue({ code: 'custom', path: ['buildHash'], message: 'Development workflows require a build hash' })
  }
  if (source === 'installed' && buildHash !== undefined) {
    context.addIssue({ code: 'custom', path: ['buildHash'], message: 'Installed workflows cannot include a build hash' })
  }
})

export const mediaKindSchema = z.enum(['image', 'audio', 'video'])
export type MediaKind = z.infer<typeof mediaKindSchema>
export const attachmentKindSchema = z.union([mediaKindSchema, z.literal('file')])
export type AttachmentKind = z.infer<typeof attachmentKindSchema>

export const mediaBlockSchema = z.object({
  type: z.literal('media'),
  blockId: identifierSchema,
  assetId: identifierSchema,
  kind: attachmentKindSchema,
  purpose: z.enum(['input', 'output']),
  name: z.string().trim().min(1),
  mimeType: z.string().trim().min(1),
  byteSize: z.number().int().nonnegative(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationMs: z.number().int().nonnegative().optional(),
}).strict().superRefine(({ kind, purpose }, context) => {
  if (kind === 'file' && purpose === 'output') {
    context.addIssue({ code: 'custom', path: ['purpose'], message: 'File attachments can only be input media' })
  }
})

export const mediaGenerationBlockSchema = z.object({
  type: z.literal('media_generation'),
  blockId: identifierSchema,
  jobId: identifierSchema,
  kind: mediaKindSchema,
  status: z.enum(['pending', 'in_progress', 'downloading', 'paused', 'failed']),
  errorCode: appErrorCodeSchema.optional(),
}).strict()

export const executionStatusSchema = z.enum([
  'queued',
  'awaiting_approval',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
])

export type ExecutionStatus = z.infer<typeof executionStatusSchema>

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

export const browserStatusBlockSchema = z.object({
  type: z.literal('browser_status'),
  blockId: identifierSchema,
  requestId: identifierSchema,
  bindingId: identifierSchema,
  siteLabel: nonEmptyStringSchema.max(500),
  origin: browserOriginSchema,
  state: z.enum(['inspecting', 'acting', 'awaiting_user', 'completed', 'failed', 'cancelled']),
  actionSummary: nonEmptyStringSchema.max(500).optional(),
  errorCode: appErrorCodeSchema.optional(),
}).strict()

export const chatBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z.object({ type: z.literal('reasoning_status'), label: z.string().trim().min(1) }).strict(),
  z.object({
    type: z.literal('workflow_proposal'),
    workflowId: identifierSchema,
    workflowName: z.string().trim().min(1),
    args: z.unknown(),
  }).strict(),
  z.object({
    type: z.literal('approval'),
    blockId: identifierSchema,
    state: z.enum(['pending', 'approved', 'denied', 'expired', 'cancelled', 'invalidated']),
    executionId: identifierSchema,
    workflowId: identifierSchema,
    workflowName: nonEmptyStringSchema,
    workflowVersion: nonEmptyStringSchema,
    source: workflowSourceSchema,
    buildHash: buildHashSchema.optional(),
    city: nonEmptyStringSchema.optional(),
    actionSummary: nonEmptyStringSchema.max(500),
    permissionIndex: z.number().int().nonnegative(),
    capability: capabilitySchema,
    scope: capabilityScopeSchema,
    scopeHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().superRefine(({ capability, scope, source, buildHash }, context) => {
    if (!declaredScopeMatchesCapability(capability, scope)) {
      context.addIssue({ code: 'custom', message: 'Approval scope is invalid for this capability' })
    }
    if (source === 'development' && buildHash === undefined) {
      context.addIssue({ code: 'custom', path: ['buildHash'], message: 'Development workflows require a build hash' })
    }
    if (source === 'installed' && buildHash !== undefined) {
      context.addIssue({ code: 'custom', path: ['buildHash'], message: 'Installed workflows cannot include a build hash' })
    }
  }),
  workflowBlockContextSchema.extend({
    type: z.literal('workflow_status'),
    blockId: identifierSchema,
    executionId: identifierSchema,
    status: executionStatusSchema,
    executionAvailable: z.boolean(),
    executionIndex: z.number().int().positive(),
    executionLimit: z.number().int().positive().max(5),
    errorCode: appErrorCodeSchema.optional(),
    errorSummary: nonEmptyStringSchema.max(500).optional(),
  }).superRefine(({ executionIndex, executionLimit, status, executionAvailable, errorCode, errorSummary }, context) => {
    if (executionIndex > executionLimit) {
      context.addIssue({ code: 'custom', path: ['executionIndex'], message: 'Execution index cannot exceed its limit' })
    }
    if ((errorCode === undefined) !== (errorSummary === undefined)) {
      context.addIssue({ code: 'custom', message: 'Workflow status errors require both code and summary' })
    }
    if (['queued', 'awaiting_approval'].includes(status) && executionAvailable) {
      context.addIssue({ code: 'custom', path: ['executionAvailable'], message: 'Pre-start workflow status cannot expose an execution' })
    }
    if (['running', 'completed', 'interrupted'].includes(status) && !executionAvailable) {
      context.addIssue({ code: 'custom', path: ['executionAvailable'], message: 'Started workflow status must expose its execution' })
    }
    if (errorCode === undefined) return
    if (['queued', 'awaiting_approval', 'running'].includes(status)) {
      context.addIssue({ code: 'custom', path: ['errorCode'], message: 'Active workflow status cannot include an error' })
    }
    if (errorCode === 'RESULT_TOO_LARGE' && status !== 'completed') {
      context.addIssue({ code: 'custom', path: ['errorCode'], message: 'Oversized results must remain completed' })
    }
    if (status === 'completed' && errorCode !== 'RESULT_TOO_LARGE') {
      context.addIssue({ code: 'custom', path: ['errorCode'], message: 'Completed workflow status only accepts an oversized-result notice' })
    }
  }),
  z.object({
    type: z.literal('workflow_provenance'),
    blockId: identifierSchema,
    entries: z.array(workflowBlockContextSchema.extend({
      executionId: identifierSchema,
      status: executionStatusSchema,
    })).min(1),
  }).strict(),
  z.object({ type: z.literal('workflow_execution'), executionId: identifierSchema }).strict(),
  z.object({
    type: z.literal('execution_result'),
    executionId: identifierSchema,
    summary: z.string(),
  }).strict(),
  z.object({
    type: z.literal('error'),
    code: z.string().trim().min(1),
    message: z.string().trim().min(1),
  }).strict(),
  browserStatusBlockSchema,
  mediaBlockSchema,
  mediaGenerationBlockSchema,
])

export type ChatBlock = z.infer<typeof chatBlockSchema>

const conversationEventSummarySchema = z.object({
  id: identifierSchema,
  title: nonEmptyStringSchema,
  titleState: z.enum(['pending', 'generating', 'ai_named', 'user_named', 'failed']),
  revision: z.number().int().nonnegative(),
  syncState: z.enum(['synced', 'pending', 'syncing', 'failed']),
  syncWarningSince: timestampSchema.optional(),
  createdAt: timestampSchema,
  lastActivityAt: timestampSchema,
  metadataUpdatedAt: timestampSchema,
}).strict()

export const chatEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('sync_warning_updated'),
    warningSince: timestampSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal('block'),
    conversationId: identifierSchema,
    messageId: identifierSchema,
    block: chatBlockSchema,
  }).strict(),
  z.object({
    type: z.literal('status'),
    conversationId: identifierSchema,
    requestId: identifierSchema,
    status: z.enum(['running', 'completed', 'cancelled', 'failed']),
    error: appErrorSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal('block_update'),
    conversationId: identifierSchema,
    messageId: identifierSchema,
    blockId: identifierSchema,
    block: z.union([mediaBlockSchema, mediaGenerationBlockSchema]),
  }).strict(),
  z.object({
    type: z.literal('conversation_title_updated'),
    conversationId: identifierSchema,
    title: z.string().trim().min(1).max(20),
    updatedAt: timestampSchema,
  }).strict(),
  z.object({
    type: z.literal('conversation_updated'),
    conversationId: identifierSchema,
    conversation: conversationEventSummarySchema,
  }).strict(),
  z.object({
    type: z.literal('conversation_removed'),
    conversationId: identifierSchema,
  }).strict(),
]).superRefine((event, context) => {
  if (event.type === 'block_update' && event.blockId !== event.block.blockId) {
    context.addIssue({
      code: 'custom',
      path: ['blockId'],
      message: 'Replacement block identity must match the updated block',
    })
  }
  if (event.type === 'conversation_updated' && event.conversationId !== event.conversation.id) {
    context.addIssue({
      code: 'custom',
      path: ['conversationId'],
      message: 'Conversation identity must match the updated projection',
    })
  }
})

export type ChatEvent = z.infer<typeof chatEventSchema>

export const executionEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('status'),
    executionId: identifierSchema,
    status: executionStatusSchema,
    occurredAt: timestampSchema,
    error: appErrorSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal('step'),
    executionId: identifierSchema,
    stepId: identifierSchema,
    label: z.string().trim().min(1),
    status: z.enum(['running', 'completed', 'failed']),
    occurredAt: timestampSchema,
  }).strict(),
  z.object({
    type: z.literal('log'),
    executionId: identifierSchema,
    level: z.enum(['debug', 'info', 'warn', 'error']),
    message: z.string(),
    occurredAt: timestampSchema,
  }).strict(),
  z.object({
    type: z.literal('result'),
    executionId: identifierSchema,
    summary: z.string(),
    occurredAt: timestampSchema,
  }).strict(),
  z.object({
    type: z.literal('approval_required'),
    executionId: identifierSchema,
    permissionIndex: z.number().int().nonnegative(),
    capability: capabilitySchema,
    scope: runtimeCapabilityScopeSchema,
    scopeHash: z.string().regex(/^[a-f0-9]{64}$/),
    occurredAt: timestampSchema,
  }).strict().superRefine(({ capability, scope }, context) => {
    if (!runtimeCapabilityPermissionSchema.safeParse({ capability, scope }).success) {
      context.addIssue({ code: 'custom', message: 'Approval scope is invalid for this capability' })
    }
  }),
])

export type ExecutionEvent = z.infer<typeof executionEventSchema>
