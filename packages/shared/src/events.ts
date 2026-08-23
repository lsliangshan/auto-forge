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

function declaredScopeMatchesCapability(capability: string, scope: Record<string, unknown>): boolean {
  const needsOrigins = capability.startsWith('browser.') || capability === 'network.fetch'
  const needsPaths = capability.startsWith('filesystem.')
  return needsOrigins
    ? 'origins' in scope
    : needsPaths
      ? 'paths' in scope
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

export const mediaBlockSchema = z.object({
  type: z.literal('media'),
  blockId: identifierSchema,
  assetId: identifierSchema,
  kind: mediaKindSchema,
  purpose: z.enum(['input', 'output']),
  name: z.string().trim().min(1),
  mimeType: z.string().trim().min(1),
  byteSize: z.number().int().nonnegative(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationMs: z.number().int().nonnegative().optional(),
}).strict()

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

export const chatEventSchema = z.discriminatedUnion('type', [
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
]).superRefine((event, context) => {
  if (event.type === 'block_update' && event.blockId !== event.block.blockId) {
    context.addIssue({
      code: 'custom',
      path: ['blockId'],
      message: 'Replacement block identity must match the updated block',
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
