import type { WorkflowDetail } from '@autoforge/shared'
import { describe, expect, it } from 'vitest'
import { createWorkflowSourceSelectorVault } from './workflow-source-selector.js'

describe('createWorkflowSourceSelectorVault', () => {
  it('accepts only selectors created by its vault', () => {
    const vault = createWorkflowSourceSelectorVault()
    const workflow: WorkflowDetail = {
      id: 'workflow.dev', version: '1.0.0', name: '开发工作流', description: '测试',
      author: 'AutoForge', category: 'test', enabled: true, source: 'development',
      integrity: 'valid', updatedAt: '2026-08-22T00:00:00.000Z', cities: ['北京'],
      runtimeIdentity: { id: 'workflow.dev', version: '1.0.0', source: 'development', buildHash: 'c'.repeat(64) },
      permissions: [], activationExamples: [], activationNegativeExamples: [],
      timeoutMs: 30_000, inputSchema: {}, outputSchema: {},
    }

    const selector = vault.create(workflow)

    expect(vault.inspect(selector)).toEqual({
      id: workflow.id, version: workflow.version, source: 'development', buildHash: 'c'.repeat(64),
    })
    expect(vault.inspect({ kind: 'development-build' } as never)).toBeUndefined()
  })

  it('keeps the exact source bound when an inspector mutates its returned value', () => {
    const vault = createWorkflowSourceSelectorVault()
    const selector = vault.create({
      id: 'workflow.dev', version: '1.0.0', name: '开发工作流', description: '测试',
      author: 'AutoForge', category: 'test', enabled: true, source: 'development',
      integrity: 'valid', updatedAt: '2026-08-22T00:00:00.000Z', cities: [],
      runtimeIdentity: { id: 'workflow.dev', version: '1.0.0', source: 'development', buildHash: 'c'.repeat(64) },
      permissions: [], activationExamples: [], activationNegativeExamples: [],
      timeoutMs: 30_000, inputSchema: {}, outputSchema: {},
    })
    const inspected = vault.inspect(selector) as { buildHash: string }

    try { inspected.buildHash = 'd'.repeat(64) } catch { /* Frozen exact sources are immutable. */ }

    expect(vault.inspect(selector)).toEqual({
      id: 'workflow.dev', version: '1.0.0', source: 'development', buildHash: 'c'.repeat(64),
    })
  })
})
