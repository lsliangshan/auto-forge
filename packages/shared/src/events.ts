import { z } from 'zod'
import { appErrorSchema } from './errors.js'
import { capabilitySchema, capabilityScopeSchema } from './worker-protocol.js'

const identifierSchema = z.string().trim().min(1)
const timestampSchema = z.string().datetime()

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
    executionId: identifierSchema,
    workflowId: identifierSchema,
    workflowVersion: z.string().trim().min(1),
    permissionIndex: z.number().int().nonnegative(),
    capability: capabilitySchema,
    scope: capabilityScopeSchema,
    scopeHash: z.string().regex(/^[a-f0-9]{64}$/),
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
])

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
    scope: capabilityScopeSchema,
    scopeHash: z.string().regex(/^[a-f0-9]{64}$/),
    occurredAt: timestampSchema,
  }).strict(),
])

export type ExecutionEvent = z.infer<typeof executionEventSchema>
