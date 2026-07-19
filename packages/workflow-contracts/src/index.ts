import { z } from 'zod'

export const workflowPermissions = [
  'browser.navigate',
  'browser.read',
  'browser.interact',
  'browser.download'
] as const

export type WorkflowPermission = (typeof workflowPermissions)[number]

const slug = z.string().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
const semver = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/)
const host = z.string().min(1).max(253).refine((value) => {
  const candidate = value.startsWith('*.') ? value.slice(2) : value
  return candidate === 'localhost' || /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(candidate)
}, 'Invalid target host')

export const workflowManifestSchema = z.object({
  schemaVersion: z.literal(1),
  sdkVersion: z.literal(1),
  slug,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(2_000),
  version: semver,
  categorySlug: slug,
  entry: z.literal('dist/index.mjs'),
  targetHosts: z.array(host).min(1).max(50),
  permissions: z.array(z.enum(workflowPermissions)).min(1).max(workflowPermissions.length)
}).strict()

export type WorkflowManifest = z.infer<typeof workflowManifestSchema>

export function parseWorkflowManifest(input: unknown): WorkflowManifest {
  return workflowManifestSchema.parse(input)
}

export function hostMatches(hostname: string, allowedHosts: readonly string[]): boolean {
  const actual = hostname.trim().toLowerCase().replace(/\.$/, '')
  return allowedHosts.some((rule) => {
    const expected = rule.toLowerCase()
    return expected.startsWith('*.')
      ? actual.endsWith(`.${expected.slice(2)}`) && actual !== expected.slice(2)
      : actual === expected
  })
}

export interface ReleaseManifest {
  schemaVersion: 1
  workflowId: string
  slug: string
  version: string
  entry: 'dist/index.mjs'
  codeSha256: string
  packageSha256: string
  permissions: WorkflowPermission[]
  targetHosts: string[]
  publishedAt: string
}

function serialize(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON does not support non-finite numbers')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(serialize).join(',')}]`
  if (typeof value === 'object') {
    return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${serialize((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  throw new TypeError('Value is not valid JSON')
}

export function canonicalize(value: unknown): string {
  return serialize(value)
}

export type SubmissionStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'
export type UserRole = 'USER' | 'ADMIN'

export interface Page<T> {
  items: T[]
  page: number
  pageSize: number
  total: number
}

export interface CategorySummary {
  id: string
  slug: string
  name: string
  sortOrder: number
  active: boolean
}

export interface WorkflowSummary {
  id: string
  slug: string
  name: string
  description: string
  authorName: string
  version: string
  category: CategorySummary
  permissions: WorkflowPermission[]
  targetHosts: string[]
  codeSha256: string
  packageSha256: string
  downloads: number
  publishedAt: string
}

export interface SignedRelease {
  keyId: string
  manifest: ReleaseManifest
  signature: string
  downloadUrl: string
  expiresAt: string
}

export const errorCodes = [
  'AUTH_REQUIRED', 'FORBIDDEN', 'INVALID_INPUT', 'INVALID_MANIFEST', 'INVALID_SOURCE',
  'NOT_FOUND', 'CONFLICT', 'CATEGORY_IN_USE', 'SIGNATURE_INVALID', 'HASH_MISMATCH',
  'HOST_NOT_ALLOWED', 'PERMISSION_DENIED', 'EXECUTION_ABORTED', 'INTERNAL_ERROR'
] as const
export type ErrorCode = (typeof errorCodes)[number]

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; requestId?: string }
}
