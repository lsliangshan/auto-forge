import { z } from 'zod'
import { conversionFormatScopeSchema, fileConvertRequestSchema } from './conversion.js'
import { appErrorSchema } from './errors.js'
import { isHttpsUrlPattern } from './https-url-pattern.js'

const identifierSchema = z.string().trim().min(1)
const httpsUrlSchema = z.url().refine((value) => {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}, {
  message: 'Expected an HTTPS URL',
})

const httpsOriginSchema = z.url().refine((value) => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
      && url.username === ''
      && url.password === ''
      && url.pathname === '/'
      && url.search === ''
      && url.hash === ''
      && url.origin === value
  } catch {
    return false
  }
}, { message: 'Expected an exact HTTPS origin' })

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
  'file.convert',
])

export type Capability = z.infer<typeof capabilitySchema>

const browserScopeSchema = z.object({
  origins: z.array(z.string().refine(isHttpsUrlPattern, { message: 'Expected an HTTPS URL pattern' })).min(1),
}).strict()
const runtimeBrowserScopeSchema = z.object({ origins: z.array(httpsOriginSchema).min(1) }).strict()
const filesystemScopeSchema = z.object({ paths: z.array(z.string().trim().min(1)).min(1) }).strict()
const emptyScopeSchema = z.object({}).strict()

export const capabilityScopeSchema = z.union([
  browserScopeSchema,
  filesystemScopeSchema,
  conversionFormatScopeSchema,
  emptyScopeSchema,
])

export type CapabilityScope = z.infer<typeof capabilityScopeSchema>

export const runtimeCapabilityScopeSchema = z.union([
  runtimeBrowserScopeSchema,
  filesystemScopeSchema,
  conversionFormatScopeSchema,
  emptyScopeSchema,
])

export const runtimeCapabilityPermissionSchema = z.object({
  capability: capabilitySchema,
  scope: runtimeCapabilityScopeSchema,
}).strict().superRefine(({ capability, scope }, context) => {
  const needsOrigins = capability.startsWith('browser.') || capability === 'network.fetch'
  const needsPaths = capability.startsWith('filesystem.')
  const needsFormats = capability === 'file.convert'
  if (needsOrigins && !('origins' in scope)) {
    context.addIssue({ code: 'custom', message: 'This capability requires exact origin scope' })
  }
  if (needsPaths && !('paths' in scope)) {
    context.addIssue({ code: 'custom', message: 'This capability requires path scope' })
  }
  if (needsFormats && !('formats' in scope)) {
    context.addIssue({ code: 'custom', message: 'This capability requires conversion format scope' })
  }
  if (!needsOrigins && !needsPaths && !needsFormats && Object.keys(scope).length !== 0) {
    context.addIssue({ code: 'custom', message: 'This capability requires an empty scope' })
  }
})

export const workerCapabilityRequestSchema = z.discriminatedUnion('capability', [
  z.object({
    capability: z.literal('browser.open'),
    scope: runtimeBrowserScopeSchema,
    arguments: z.object({ url: httpsUrlSchema }).strict(),
  }).strict(),
  z.object({
    capability: z.literal('browser.fill'),
    scope: runtimeBrowserScopeSchema,
    arguments: z.object({ locator: z.string().trim().min(1), value: z.string() }).strict(),
  }).strict(),
  z.object({
    capability: z.literal('browser.click'),
    scope: runtimeBrowserScopeSchema,
    arguments: z.object({ locator: z.string().trim().min(1) }).strict(),
  }).strict(),
  z.object({
    capability: z.literal('browser.url'),
    scope: runtimeBrowserScopeSchema,
    arguments: z.object({}).strict(),
  }).strict(),
  z.object({
    capability: z.literal('browser.close'),
    scope: runtimeBrowserScopeSchema,
    arguments: z.object({}).strict(),
  }).strict(),
  fileConvertRequestSchema,
])

export type WorkerCapabilityRequest = z.infer<typeof workerCapabilityRequestSchema>

export const workerRequestSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('inspect_config'),
    inspectionId: identifierSchema,
    workflowId: identifierSchema,
    workflowVersion: identifierSchema,
    entryPath: z.string().trim().min(1),
  }).strict(),
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
  z.object({
    type: z.literal('workflow_config'),
    inspectionId: identifierSchema,
    implemented: z.boolean(),
    config: z.unknown().optional(),
  }).strict(),
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
    request: workerCapabilityRequestSchema,
  }).strict(),
  z.object({ type: z.literal('result'), output: z.unknown() }).strict(),
  z.object({ type: z.literal('error'), error: appErrorSchema }).strict(),
])

export type WorkerResponse = z.infer<typeof workerResponseSchema>

export const workerMessageSchema = z.union([workerRequestSchema, workerResponseSchema])

export type WorkerMessage = z.infer<typeof workerMessageSchema>
