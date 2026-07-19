import { z } from 'zod'
import { appErrorSchema } from './errors.js'

const identifierSchema = z.string().trim().min(1)
const httpsUrlSchema = z.url().refine((value) => new URL(value).protocol === 'https:', {
  message: 'Expected an HTTPS URL',
})

export const capabilitySchema = z.enum([
  'browser.open',
  'browser.fill',
  'browser.click',
  'browser.url',
  'browser.close',
  'network.fetch',
  'filesystem.read',
  'filesystem.write',
  'clipboard.read',
  'clipboard.write',
  'notification.send',
  'artifact.create',
])

export type Capability = z.infer<typeof capabilitySchema>

const browserScopeSchema = z.object({ origins: z.array(httpsUrlSchema).min(1) }).strict()
const filesystemScopeSchema = z.object({ paths: z.array(z.string().trim().min(1)).min(1) }).strict()
const emptyScopeSchema = z.object({}).strict()

export const capabilityScopeSchema = z.union([
  browserScopeSchema,
  filesystemScopeSchema,
  emptyScopeSchema,
])

export type CapabilityScope = z.infer<typeof capabilityScopeSchema>

const capabilityRequestSchema = z.discriminatedUnion('capability', [
  z.object({
    capability: z.literal('browser.open'),
    scope: browserScopeSchema,
    arguments: z.object({ url: httpsUrlSchema }).strict(),
  }).strict(),
  z.object({
    capability: z.literal('browser.fill'),
    scope: browserScopeSchema,
    arguments: z.object({ locator: z.string().trim().min(1), value: z.string() }).strict(),
  }).strict(),
  z.object({
    capability: z.literal('browser.click'),
    scope: browserScopeSchema,
    arguments: z.object({ locator: z.string().trim().min(1) }).strict(),
  }).strict(),
  z.object({
    capability: z.literal('browser.url'),
    scope: browserScopeSchema,
    arguments: z.object({}).strict(),
  }).strict(),
  z.object({
    capability: z.literal('browser.close'),
    scope: browserScopeSchema,
    arguments: z.object({}).strict(),
  }).strict(),
])

export type WorkerCapabilityRequest = z.infer<typeof capabilityRequestSchema>

export const workerRequestSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('start'),
    executionId: identifierSchema,
    workflowId: identifierSchema,
    workflowVersion: identifierSchema,
    entryPath: z.string().trim().min(1),
    input: z.unknown(),
  }).strict(),
  z.object({ type: z.literal('cancel'), executionId: identifierSchema }).strict(),
  z.object({
    type: z.literal('capability_result'),
    requestId: identifierSchema,
    result: z.unknown(),
  }).strict(),
  z.object({
    type: z.literal('capability_error'),
    requestId: identifierSchema,
    error: appErrorSchema,
  }).strict(),
])

export type WorkerRequest = z.infer<typeof workerRequestSchema>

export const workerResponseSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), executionId: identifierSchema }).strict(),
  z.object({
    type: z.literal('log'),
    level: z.enum(['debug', 'info', 'warn', 'error']),
    message: z.string(),
  }).strict(),
  z.object({
    type: z.literal('progress'),
    label: z.string().trim().min(1),
    percent: z.number().min(0).max(100).optional(),
  }).strict(),
  z.object({
    type: z.literal('capability_request'),
    requestId: identifierSchema,
    request: capabilityRequestSchema,
  }).strict(),
  z.object({ type: z.literal('result'), output: z.unknown() }).strict(),
  z.object({ type: z.literal('error'), error: appErrorSchema }).strict(),
])

export type WorkerResponse = z.infer<typeof workerResponseSchema>

export const workerMessageSchema = z.union([workerRequestSchema, workerResponseSchema])

export type WorkerMessage = z.infer<typeof workerMessageSchema>
