import { describe, expect, it } from 'vitest'
import type { PermissionGrant } from '../database/repositories.js'
import { PolicyEngine, type PermissionRequest } from './policy-engine.js'

function createGrantRepository() {
  const grants = new Map<string, PermissionGrant>()
  return {
    grants,
    upsert(grant: PermissionGrant) {
      const key = [grant.workflowId, grant.workflowVersion, grant.capability, grant.scopeHash].join('\0')
      const existing = [...grants.values()].find((candidate) =>
        [candidate.workflowId, candidate.workflowVersion, candidate.capability, candidate.scopeHash].join('\0') === key,
      )
      const stored = existing ? { ...grant, id: existing.id, createdAt: existing.createdAt } : grant
      grants.set(stored.id, stored)
      return stored
    },
    get(workflowId: string, workflowVersion: string, capability: string, scopeHash: string) {
      return [...grants.values()].find((grant) => grant.workflowId === workflowId
        && grant.workflowVersion === workflowVersion
        && grant.capability === capability
        && grant.scopeHash === scopeHash)
    },
    delete(id: string) {
      grants.delete(id)
    },
  }
}

function request(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    executionId: 'exec_1',
    workflowId: 'browser.search.baidu',
    workflowVersion: '1.0.0',
    capability: 'browser.open',
    scope: { origins: ['https://www.baidu.com', 'https://example.com'] },
    ...overrides,
  }
}

describe('PolicyEngine', () => {
  it('invalidates an always grant after workflow version changes', () => {
    const repository = createGrantRepository()
    const policy = new PolicyEngine(repository)
    policy.record({ ...request(), decision: 'always' })

    expect(policy.evaluate(request({ workflowVersion: '1.1.0' }))).toEqual({
      allowed: false,
      requiresApproval: true,
    })
  })

  it('matches scopes with recursively sorted keys and arrays', () => {
    const repository = createGrantRepository()
    const policy = new PolicyEngine(repository)
    policy.record({
      ...request({ scope: { origins: ['https://example.com', 'https://www.baidu.com'] } }),
      decision: 'always',
    })

    expect(policy.evaluate(request())).toEqual({ allowed: true, requiresApproval: false })
    expect(repository.grants.values().next().value?.scope).toEqual({
      origins: ['https://example.com', 'https://www.baidu.com'],
    })
  })

  it('does not widen grants across capabilities or scopes', () => {
    const policy = new PolicyEngine(createGrantRepository())
    policy.record({
      ...request({ scope: { origins: ['https://www.baidu.com'] } }),
      decision: 'always',
    })

    expect(policy.evaluate(request({ capability: 'browser.click' }))).toEqual({ allowed: false, requiresApproval: true })
    expect(policy.evaluate(request({ scope: { origins: ['https://www.baidu.com', 'https://example.com'] } }))).toEqual({ allowed: false, requiresApproval: true })
  })

  it('keeps once grants in memory and bound to one execution', () => {
    const repository = createGrantRepository()
    const policy = new PolicyEngine(repository)
    policy.record({ ...request(), decision: 'once' })

    expect(policy.evaluate(request())).toEqual({ allowed: true, requiresApproval: false })
    expect(policy.evaluate(request({ executionId: 'exec_2' }))).toEqual({ allowed: false, requiresApproval: true })
    expect(repository.grants.size).toBe(0)

    policy.releaseExecution('exec_1')
    expect(policy.evaluate(request())).toEqual({ allowed: false, requiresApproval: true })
  })

  it('revokes a persistent grant by id', () => {
    const repository = createGrantRepository()
    const policy = new PolicyEngine(repository)
    const grant = policy.record({ ...request(), decision: 'always' })

    policy.revoke(grant.id)

    expect(policy.evaluate(request())).toEqual({ allowed: false, requiresApproval: true })
  })
})
