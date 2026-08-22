import { createHash } from 'node:crypto'
import type { WorkflowDetail } from '@autoforge/shared'

export type BrowserPermissionMatrix = Readonly<Partial<Record<
  'browser.open' | 'browser.fill' | 'browser.click' | 'browser.url' | 'browser.close',
  readonly string[]
>>>

export function canonicalJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite JSON number')
    return JSON.stringify(value)
  }
  if (typeof value !== 'object') throw new TypeError('Non-JSON value')
  if (seen.has(value)) throw new TypeError('Circular JSON value')
  seen.add(value)
  try {
    if (Array.isArray(value)) return `[${value.map((child) => canonicalJson(child, seen)).join(',')}]`
    const values: string[] = []
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key]
      if (child !== undefined) values.push(`${JSON.stringify(key)}:${canonicalJson(child, seen)}`)
    }
    return `{${values.join(',')}}`
  } finally {
    seen.delete(value)
  }
}

export function workflowSecurityFingerprint(workflow: WorkflowDetail): string {
  return createHash('sha256').update(canonicalJson({
    id: workflow.id,
    version: workflow.version,
    name: workflow.name,
    description: workflow.description,
    author: workflow.author,
    category: workflow.category,
    enabled: workflow.enabled,
    source: workflow.source,
    integrity: workflow.integrity,
    codeSha256: workflow.codeSha256,
    runtimeIdentity: workflow.runtimeIdentity,
    cities: workflow.cities,
    permissions: workflow.permissions,
    browserContinuation: workflow.browserContinuation,
    activationExamples: workflow.activationExamples,
    activationNegativeExamples: workflow.activationNegativeExamples,
    timeoutMs: workflow.timeoutMs,
    inputSchema: workflow.inputSchema,
    outputSchema: workflow.outputSchema,
  })).digest('hex')
}

export function browserPermissionMatrix(workflow: Pick<WorkflowDetail, 'permissions'>): BrowserPermissionMatrix {
  const matrix: Record<string, string[]> = {}
  for (const permission of workflow.permissions) {
    if (!permission.capability.startsWith('browser.') || !('origins' in permission.scope)) continue
    matrix[permission.capability] = [...new Set([
      ...(matrix[permission.capability] ?? []),
      ...permission.scope.origins,
    ])].sort()
  }
  return Object.freeze(matrix) as BrowserPermissionMatrix
}
