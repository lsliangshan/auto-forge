import { createHash, randomUUID } from 'node:crypto'
import type { Capability, CapabilityScope } from '@autoforge/shared'
import type { AppRepositories, PermissionGrant } from '../database/repositories.js'

type PermissionGrantRepository = AppRepositories['permissionGrants']

export interface PermissionRequest {
  executionId: string
  workflowId: string
  workflowVersion: string
  capability: Capability
  scope: CapabilityScope
}

export type PermissionRecord = PermissionRequest & { decision: 'once' | 'always' }

export interface PolicyEvaluation {
  allowed: boolean
  requiresApproval: boolean
}

export interface RecordedPermission {
  id: string
  workflowId: string
  workflowVersion: string
  capability: Capability
  scope: CapabilityScope
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(canonicalize)
      .sort((left, right) => compare(JSON.stringify(left), JSON.stringify(right)))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => compare(left, right))
      .map(([key, child]) => [key, canonicalize(child)]))
  }
  return value
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function canonicalScope(scope: CapabilityScope): CapabilityScope {
  return canonicalize(scope) as CapabilityScope
}

export function scopeHash(scope: CapabilityScope): string {
  return createHash('sha256').update(JSON.stringify(canonicalScope(scope))).digest('hex')
}

function permissionKey(request: Omit<PermissionRequest, 'executionId'>): string {
  return [request.workflowId, request.workflowVersion, request.capability, scopeHash(request.scope)].join('\0')
}

export class PolicyEngine {
  private readonly once = new Map<string, Set<string>>()

  constructor(private readonly repository: PermissionGrantRepository) {}

  evaluate(request: PermissionRequest): PolicyEvaluation {
    const hash = scopeHash(request.scope)
    const key = permissionKey(request)
    const allowed = this.once.get(request.executionId)?.has(key) === true
      || this.repository.get(request.workflowId, request.workflowVersion, request.capability, hash) !== undefined
    return { allowed, requiresApproval: !allowed }
  }

  record(record: PermissionRecord): RecordedPermission {
    const scope = canonicalScope(record.scope)
    const id = randomUUID()
    if (record.decision === 'once') {
      const grants = this.once.get(record.executionId) ?? new Set<string>()
      grants.add(permissionKey(record))
      this.once.set(record.executionId, grants)
      return {
        id,
        workflowId: record.workflowId,
        workflowVersion: record.workflowVersion,
        capability: record.capability,
        scope,
      }
    }

    const hash = scopeHash(scope)
    const existing = this.repository.get(
      record.workflowId,
      record.workflowVersion,
      record.capability,
      hash,
    )
    const timestamp = Date.now()
    const grant: PermissionGrant = {
      id: existing?.id ?? id,
      workflowId: record.workflowId,
      workflowVersion: record.workflowVersion,
      capability: record.capability,
      scope,
      scopeHash: hash,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    }
    const stored = this.repository.upsert(grant)
    return {
      id: stored.id,
      workflowId: stored.workflowId,
      workflowVersion: stored.workflowVersion,
      capability: stored.capability as Capability,
      scope: stored.scope as CapabilityScope,
    }
  }

  revoke(grantId: string): void {
    this.repository.delete(grantId)
  }

  releaseExecution(executionId: string): void {
    this.once.delete(executionId)
  }
}
