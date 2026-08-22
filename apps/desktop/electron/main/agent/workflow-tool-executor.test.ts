import { describe, expect, it, vi } from 'vitest'
import type { ApprovalDecision, WorkflowDetail } from '@autoforge/shared'
import { estimateTextTokens } from '../chat/conversation-context.js'
import { scopeHash } from '../permissions/policy-engine.js'
import type { ExecutionReservation } from '../workflows/execution-service.js'
import type { ExactWorkflowSource, WorkflowExecutionSourceSelector } from '../workflows/workflow-source-selector.js'
import type { WorkflowCandidate } from './workflow-catalog.js'
import {
  createWorkflowActionSummary,
  WorkflowToolExecutor,
  type WorkflowToolRunBudget,
} from './workflow-tool-executor.js'

const inputSchema = {
  type: 'object', additionalProperties: false, required: ['topic'],
  properties: { topic: { type: 'string', title: '事项', minLength: 1 } },
}

function workflow(overrides: Partial<WorkflowDetail> = {}): WorkflowDetail {
  return {
    id: 'local.residence.permit', version: '1.0.0', name: '居住证办理', description: '查询居住证办理信息',
    author: 'AutoForge', category: 'government', enabled: true, source: 'installed', integrity: 'valid',
    updatedAt: '2026-08-22T00:00:00.000Z', codeSha256: 'a'.repeat(64), cities: ['北京'],
    runtimeIdentity: { id: 'local.residence.permit', version: '1.0.0', source: 'installed' },
    timeoutMs: 30_000, permissions: [], activationExamples: ['办理居住证'], activationNegativeExamples: [],
    inputSchema, outputSchema: { type: 'object' },
    ...overrides,
  }
}

function candidate(detail: WorkflowDetail, selector: WorkflowExecutionSourceSelector): WorkflowCandidate {
  return {
    key: `${detail.id}\u0000${detail.version}\u00001`, toolName: 'workflow_1', workflow: detail, selector,
    tool: { type: 'function', function: { name: 'workflow_1', description: detail.description, parameters: {} } },
  }
}

function harness(options: {
  detail?: WorkflowDetail
  exactSource?: ExactWorkflowSource
  developerMode?: boolean
  budgetCode?: 'TOOL_CALL_LIMIT'
} = {}) {
  const selector = Object.freeze({ kind: 'installed-build' as const })
  const detail = options.detail ?? workflow()
  let exactSource: ExactWorkflowSource | undefined = options.exactSource ?? {
    id: detail.id, version: detail.version, source: 'installed', codeSha256: detail.codeSha256!,
  }
  let developerMode = options.developerMode ?? true
  let budgetCode = options.budgetCode
  let liveWorkflow: WorkflowDetail | undefined = structuredClone(detail)
  let reservation = 0
  const order: string[] = []
  const executions = {
    reserve: vi.fn(() => {
      order.push('reserve')
      return { executionId: `execution_${++reservation}` } satisfies ExecutionReservation
    }),
    discardReservation: vi.fn(() => { order.push('discard'); return true }),
    startReserved: vi.fn(async (reserved: ExecutionReservation, input: unknown) => {
      order.push('start')
      return {
        id: reserved.executionId,
        finished: Promise.resolve({ id: reserved.executionId, status: 'completed', result: { ok: true }, input }),
      }
    }),
    cancel: vi.fn(async () => undefined),
  }
  const policy = {
    evaluate: vi.fn(() => ({ allowed: true, requiresApproval: false })),
    record: vi.fn((record: unknown) => { order.push('record'); return record }),
    releaseExecution: vi.fn(() => { order.push('release') }),
  }
  const dependencies = {
    executions,
    policy,
    currentDeveloperMode: vi.fn(() => { order.push('mode'); return developerMode }),
    inspectSource: vi.fn(() => { order.push('source'); return exactSource }),
    resolveCurrentWorkflow: vi.fn(async () => { order.push('live-source'); return liveWorkflow }),
    checkRemainingBudgets: vi.fn((budgetInput: WorkflowToolRunBudget & { phase: 'prepare' | 'start' }) => {
      void budgetInput
      order.push('budget')
      return budgetCode
    }),
    now: vi.fn(() => 1_000),
  }
  const executor = new WorkflowToolExecutor(dependencies)
  const budget: WorkflowToolRunBudget = {
    requestId: 'request_1', runId: 'run_1', toolExecutions: 0, modelDecisions: 1,
  }
  return {
    executor: {
      prepare: (input: Omit<Parameters<WorkflowToolExecutor['prepare']>[0], 'budget'>) => (
        executor.prepare({ ...input, budget })
      ),
      approve: executor.approve.bind(executor),
      deny: executor.deny.bind(executor),
      start: (
        pending: Parameters<WorkflowToolExecutor['start']>[0],
        input: Omit<Parameters<WorkflowToolExecutor['start']>[1], 'budget' | 'conversationId'>
          & Partial<Pick<Parameters<WorkflowToolExecutor['start']>[1], 'conversationId'>>,
      ) => (
        executor.start(pending, {
          ...input, conversationId: input.conversationId ?? 'conversation_1', budget,
        })
      ),
      cancel: executor.cancel.bind(executor),
      toModelResult: executor.toModelResult.bind(executor),
    },
    rawExecutor: executor,
    candidate: candidate(detail, selector),
    dependencies,
    executions,
    policy,
    order,
    setDeveloperMode(value: boolean) { developerMode = value },
    setExactSource(value: ExactWorkflowSource | undefined) { exactSource = value },
    setLiveWorkflow(value: WorkflowDetail | undefined) { liveWorkflow = value },
    setBudgetCode(value: 'TOOL_CALL_LIMIT' | undefined) { budgetCode = value },
  }
}

function onceDecision(pending: {
  executionId: string
  permissionIndex: number
  scopeHash: string | undefined
}): ApprovalDecision {
  if (pending.scopeHash === undefined) throw new Error('approval has no scope hash')
  return {
    executionId: pending.executionId,
    permissionIndex: pending.permissionIndex,
    scopeHash: pending.scopeHash,
    decision: 'once',
  }
}

describe('WorkflowToolExecutor', () => {
  it('requires an exact supported city before reserving an execution', async () => {
    const missing = harness()
    await expect(missing.executor.prepare({
      candidate: missing.candidate, arguments: { input: { topic: '居住证' } }, developerMode: true,
    })).resolves.toEqual({ kind: 'tool_error', code: 'CITY_REQUIRED' })
    expect(missing.executions.reserve).not.toHaveBeenCalled()

    const mismatch = harness()
    await expect(mismatch.executor.prepare({
      candidate: mismatch.candidate,
      arguments: { resolvedCity: '上海', input: { topic: '居住证' } },
      developerMode: true,
    })).resolves.toEqual({ kind: 'tool_error', code: 'CITY_NOT_SUPPORTED' })
    expect(mismatch.executions.reserve).not.toHaveBeenCalled()
  })

  it('strictly rejects wrapper keys and omits city for unrestricted workflows', async () => {
    const restricted = harness()
    await expect(restricted.executor.prepare({
      candidate: restricted.candidate,
      arguments: { resolvedCity: '北京', input: { topic: '居住证' }, injected: true },
      developerMode: true,
    })).resolves.toEqual({ kind: 'tool_error', code: 'INVALID_INPUT' })
    expect(restricted.executions.reserve).not.toHaveBeenCalled()

    const allCitiesDetail = workflow({ cities: [] })
    const unrestricted = harness({ detail: allCitiesDetail })
    await expect(unrestricted.executor.prepare({
      candidate: unrestricted.candidate,
      arguments: { resolvedCity: '北京', input: { topic: '居住证' } },
      developerMode: true,
    })).resolves.toEqual({ kind: 'tool_error', code: 'INVALID_INPUT' })
    expect(unrestricted.executions.reserve).not.toHaveBeenCalled()

    const ready = await unrestricted.executor.prepare({
      candidate: unrestricted.candidate, arguments: { input: { topic: '居住证' } }, developerMode: true,
    })
    expect(ready).toMatchObject({ kind: 'ready', pending: { city: undefined, input: { topic: '居住证' } } })
  })

  it('returns bounded semantic input errors without reserving', async () => {
    const test = harness()
    await expect(test.executor.prepare({
      candidate: test.candidate, arguments: { resolvedCity: '北京', input: {} }, developerMode: true,
    })).resolves.toMatchObject({ kind: 'tool_error', code: 'INVALID_INPUT', message: '事项不能为空' })
    expect(test.executions.reserve).not.toHaveBeenCalled()
  })

  it('runs preflight in budget, mode, source, city, input order and fails source changes closed', async () => {
    const development = workflow({
      source: 'development', codeSha256: undefined,
      runtimeIdentity: {
        id: 'local.residence.permit', version: '1.0.0', source: 'development', buildHash: 'b'.repeat(64),
      },
    })
    const test = harness({
      detail: development,
      exactSource: {
        id: development.id, version: development.version, source: 'development', buildHash: 'c'.repeat(64),
      },
    })

    await expect(test.executor.prepare({
      candidate: test.candidate,
      arguments: { resolvedCity: '北京', input: { topic: '居住证' } },
      developerMode: true,
    })).resolves.toEqual({ kind: 'tool_error', code: 'WORKFLOW_CHANGED' })
    expect(test.order).toEqual(['budget', 'mode', 'source'])
    expect(test.executions.reserve).not.toHaveBeenCalled()
  })

  it('fails a depleted run budget before any other preflight or reservation', async () => {
    const test = harness({ budgetCode: 'TOOL_CALL_LIMIT' })

    await expect(test.executor.prepare({
      candidate: test.candidate,
      arguments: { resolvedCity: '北京', input: { topic: '居住证' } },
      developerMode: true,
    })).resolves.toEqual({ kind: 'tool_error', code: 'TOOL_CALL_LIMIT' })
    expect(test.order).toEqual(['budget'])
    expect(test.executions.reserve).not.toHaveBeenCalled()
  })

  it('fails a development candidate when either run or current developer mode is off', async () => {
    const development = workflow({
      source: 'development', codeSha256: undefined,
      runtimeIdentity: {
        id: 'local.residence.permit', version: '1.0.0', source: 'development', buildHash: 'b'.repeat(64),
      },
    })
    const exact = {
      id: development.id, version: development.version, source: 'development' as const, buildHash: 'b'.repeat(64),
    }
    const runDisabled = harness({ detail: development, exactSource: exact })
    await expect(runDisabled.executor.prepare({
      candidate: runDisabled.candidate,
      arguments: { resolvedCity: '北京', input: { topic: '居住证' } },
      developerMode: false,
    })).resolves.toEqual({ kind: 'tool_error', code: 'WORKFLOW_CHANGED' })

    const currentDisabled = harness({ detail: development, exactSource: exact, developerMode: false })
    await expect(currentDisabled.executor.prepare({
      candidate: currentDisabled.candidate,
      arguments: { resolvedCity: '北京', input: { topic: '居住证' } },
      developerMode: true,
    })).resolves.toEqual({ kind: 'tool_error', code: 'WORKFLOW_CHANGED' })
    expect(currentDisabled.executions.reserve).not.toHaveBeenCalled()
  })

  it('auto-records each safe-navigation permission once for its reserved execution', async () => {
    const permissions = [
      { capability: 'browser.open' as const, scope: { origins: ['https://example.com'] } },
      { capability: 'browser.close' as const, scope: { origins: ['https://example.com'] } },
    ]
    const test = harness({ detail: workflow({ permissions }) })

    const prepared = await test.executor.prepare({
      candidate: test.candidate,
      arguments: { resolvedCity: '北京', input: { topic: '居住证' } },
      developerMode: true,
    })

    expect(prepared).toMatchObject({ kind: 'ready' })
    expect(test.policy.record).toHaveBeenCalledTimes(2)
    expect(test.policy.record).toHaveBeenNthCalledWith(1, expect.objectContaining({
      executionId: 'execution_1', capability: 'browser.open', decision: 'once',
    }))
    expect(test.policy.evaluate).not.toHaveBeenCalled()
  })

  it.each(['external_action', 'sensitive_read'] as const)(
    'requires one chat approval at a time for %s despite an allowed persistent policy',
    async (risk) => {
      const permission = risk === 'external_action'
        ? { capability: 'browser.fill' as const, scope: { origins: ['https://example.com'] } }
        : { capability: 'clipboard.read' as const, scope: {} as Record<string, never> }
      const second = { capability: 'browser.click' as const, scope: { origins: ['https://example.com'] } }
      const test = harness({ detail: workflow({ permissions: [permission, second] }) })

      const first = await test.executor.prepare({
        candidate: test.candidate,
        arguments: { resolvedCity: '北京', input: { topic: '居住证' } },
        developerMode: true,
      })
      expect(first).toMatchObject({
        kind: 'awaiting_approval',
        pending: {
          executionId: 'execution_1', permissionIndex: 0, capability: permission.capability,
          city: '北京', source: expect.objectContaining({ id: 'local.residence.permit' }),
          input: { topic: '居住证' }, scopeHash: scopeHash(permission.scope),
        },
      })
      if (first.kind !== 'awaiting_approval') throw new Error('expected approval')
      expect(test.policy.evaluate).not.toHaveBeenCalled()

      const next = await test.executor.approve(first.pending, onceDecision(first.pending))
      expect(next).toMatchObject({
        kind: 'awaiting_approval', pending: { permissionIndex: 1, capability: 'browser.click' },
      })
      expect(test.executions.startReserved).not.toHaveBeenCalled()
    },
  )

  it('fails unsupported and unknown capabilities before reserving or recording grants', async () => {
    for (const capability of ['network.fetch', 'future.unknown'] as const) {
      const test = harness({
        detail: workflow({ permissions: [{ capability, scope: capability === 'network.fetch' ? { origins: ['https://example.com'] } : {} } as never] }),
      })
      await expect(test.executor.prepare({
        candidate: test.candidate,
        arguments: { resolvedCity: '北京', input: { topic: '居住证' } },
        developerMode: true,
      })).resolves.toEqual({ kind: 'tool_error', code: 'CAPABILITY_SCOPE_DENIED' })
      expect(test.executions.reserve).not.toHaveBeenCalled()
      expect(test.policy.record).not.toHaveBeenCalled()
    }
  })

  it('generates a bounded recursive-redacted action summary without raw scope or sensitive paths', async () => {
    const detail = workflow({
      name: '安全操作',
      inputSchema: {
        type: 'object', required: ['topic'], additionalProperties: true,
        properties: { topic: { type: 'string' } },
      },
      permissions: [{ capability: 'browser.fill', scope: { origins: ['https://private.example.com'] } }],
    })
    const test = harness({ detail })
    const prepared = await test.executor.prepare({
      candidate: test.candidate,
      arguments: {
        resolvedCity: '北京',
        input: {
          topic: '办理', password: 'pw-secret', nested: { apiKey: 'sk-live', cookie: 'session-cookie' },
          path: '/Users/person/private.txt', padding: '长'.repeat(1_000),
        },
      },
      developerMode: true,
    })

    expect(prepared).toMatchObject({ kind: 'awaiting_approval' })
    if (prepared.kind !== 'awaiting_approval') throw new Error('expected approval')
    const summary = prepared.pending.actionSummary
    if (summary === undefined) throw new Error('approval has no action summary')
    expect(summary.length).toBeLessThanOrEqual(500)
    expect(summary).toContain('安全操作')
    expect(summary).toContain('browser.fill')
    expect(summary).toContain('北京')
    expect(summary).toContain('***')
    expect(summary).not.toMatch(/pw-secret|sk-live|session-cookie|private\.example|\/Users\/person/)
  })

  it('denies once, discards the reservation, releases grants, and rejects duplicate cleanup', async () => {
    const permission = { capability: 'browser.fill' as const, scope: { origins: ['https://example.com'] } }
    const test = harness({ detail: workflow({ permissions: [permission] }) })
    const prepared = await test.executor.prepare({
      candidate: test.candidate,
      arguments: { resolvedCity: '北京', input: { topic: '居住证' } },
      developerMode: true,
    })
    if (prepared.kind !== 'awaiting_approval') throw new Error('expected approval')
    const decision = { ...onceDecision(prepared.pending), decision: 'deny' as const }

    await expect(test.executor.deny(prepared.pending, decision)).resolves.toEqual({
      kind: 'tool_error', code: 'PERMISSION_DENIED',
    })
    await expect(test.executor.deny(prepared.pending, decision)).resolves.toEqual({
      kind: 'tool_error', code: 'CONFLICT',
    })
    expect(test.executions.discardReservation).toHaveBeenCalledTimes(1)
    expect(test.policy.releaseExecution).toHaveBeenCalledTimes(1)
    expect(test.executions.startReserved).not.toHaveBeenCalled()
  })

  it('cancels an unstarted pending tool through the executor and cleans up once', async () => {
    const test = harness()
    const prepared = await test.executor.prepare({
      candidate: test.candidate,
      arguments: { resolvedCity: '北京', input: { topic: '居住证' } },
      developerMode: true,
    })
    if (prepared.kind !== 'ready') throw new Error('expected ready')

    await test.executor.cancel(prepared.pending)
    await test.executor.cancel(prepared.pending)

    expect(test.executions.discardReservation).toHaveBeenCalledTimes(1)
    expect(test.executions.cancel).not.toHaveBeenCalled()
    expect(test.policy.releaseExecution).toHaveBeenCalledTimes(1)
  })

  it('forwards duplicate cancellation of a started tool only once', async () => {
    const test = harness()
    const prepared = await test.executor.prepare({
      candidate: test.candidate,
      arguments: { resolvedCity: '北京', input: { topic: '居住证' } },
      developerMode: true,
    })
    if (prepared.kind !== 'ready') throw new Error('expected ready')
    const started = await test.executor.start(prepared.pending, { userId: 'user_1' })
    if (started.kind !== 'started') throw new Error('expected started')

    await test.executor.cancel(prepared.pending)
    await test.executor.cancel(prepared.pending)

    expect(test.executions.cancel).toHaveBeenCalledTimes(1)
    await started.finished
    expect(test.policy.releaseExecution).not.toHaveBeenCalled()
  })

  it('rejects stale approval identity and persistent chat approval without changing lifecycle', async () => {
    const permission = { capability: 'browser.fill' as const, scope: { origins: ['https://example.com'] } }
    const test = harness({ detail: workflow({ permissions: [permission] }) })
    const prepared = await test.executor.prepare({
      candidate: test.candidate,
      arguments: { resolvedCity: '北京', input: { topic: '居住证' } },
      developerMode: true,
    })
    if (prepared.kind !== 'awaiting_approval') throw new Error('expected approval')

    await expect(test.executor.approve(prepared.pending, {
      ...onceDecision(prepared.pending), scopeHash: 'f'.repeat(64),
    })).resolves.toEqual({ kind: 'tool_error', code: 'CONFLICT' })
    await expect(test.executor.approve(prepared.pending, {
      executionId: prepared.pending.executionId,
      permissionIndex: prepared.pending.permissionIndex,
      scopeHash: prepared.pending.scopeHash!,
      decision: 'always',
      workflowId: test.candidate.workflow.id,
      workflowVersion: test.candidate.workflow.version,
      capability: permission.capability,
      scope: permission.scope,
    })).resolves.toEqual({ kind: 'tool_error', code: 'INVALID_INPUT' })
    expect(test.policy.record).not.toHaveBeenCalled()
    expect(test.executions.discardReservation).not.toHaveBeenCalled()
  })

  it('rechecks budget, current mode, and exact source immediately before start and cleans up a race once', async () => {
    const development = workflow({
      source: 'development', codeSha256: undefined,
      runtimeIdentity: {
        id: 'local.residence.permit', version: '1.0.0', source: 'development', buildHash: 'b'.repeat(64),
      },
    })
    const exact = {
      id: development.id, version: development.version, source: 'development' as const, buildHash: 'b'.repeat(64),
    }
    const test = harness({ detail: development, exactSource: exact })
    const prepared = await test.executor.prepare({
      candidate: test.candidate,
      arguments: { resolvedCity: '北京', input: { topic: '居住证' } },
      developerMode: true,
    })
    if (prepared.kind !== 'ready') throw new Error('expected ready')
    test.order.length = 0
    test.setExactSource({ ...exact, buildHash: 'c'.repeat(64) })

    await expect(test.executor.start(prepared.pending, {
      userId: 'user_1', chatRunId: 'run_1',
    })).resolves.toEqual({ kind: 'tool_error', code: 'WORKFLOW_CHANGED' })
    expect(test.order).toEqual(['budget', 'mode', 'source', 'discard', 'release'])
    expect(test.executions.startReserved).not.toHaveBeenCalled()
    expect(test.executions.discardReservation).toHaveBeenCalledTimes(1)
    expect(test.policy.releaseExecution).toHaveBeenCalledTimes(1)
  })

  it('invokes the loop start hook immediately before transferring execution ownership', async () => {
    const test = harness()
    const prepared = await test.executor.prepare({
      candidate: test.candidate,
      arguments: { resolvedCity: '北京', input: { topic: '居住证' } },
      developerMode: true,
    })
    if (prepared.kind !== 'ready') throw new Error('expected ready')
    test.order.length = 0

    await expect(test.executor.start(prepared.pending, {
      userId: 'user_1',
      beforeStart: () => {
        test.order.push('loop-start')
        return { kind: 'started', executionIndex: 1 }
      },
    })).resolves.toMatchObject({ kind: 'started' })

    expect(test.order.slice(-2)).toEqual(['loop-start', 'start'])
  })

  it('rejects live approval metadata drift with an unchanged code hash before start', async () => {
    const test = harness()
    const prepared = await test.executor.prepare({
      candidate: test.candidate,
      arguments: { resolvedCity: '北京', input: { topic: '居住证' } },
      developerMode: true,
    })
    if (prepared.kind !== 'ready') throw new Error('expected ready')
    test.setLiveWorkflow(workflow({ cities: ['北京', '上海'] }))

    await expect(test.executor.start(prepared.pending, { userId: 'user_1' }))
      .resolves.toEqual({ kind: 'tool_error', code: 'WORKFLOW_CHANGED' })
    expect(test.dependencies.resolveCurrentWorkflow).toHaveBeenCalledWith(
      test.candidate.selector, test.candidate.workflow.id, test.candidate.workflow.version,
    )
    expect(test.executions.startReserved).not.toHaveBeenCalled()
  })

  it('rechecks developer mode and exact selector after the live lookup immediately before start', async () => {
    const development = workflow({
      source: 'development', codeSha256: undefined,
      runtimeIdentity: {
        id: 'local.residence.permit', version: '1.0.0', source: 'development', buildHash: 'b'.repeat(64),
      },
    })
    const exact = {
      id: development.id, version: development.version, source: 'development' as const, buildHash: 'b'.repeat(64),
    }
    const test = harness({ detail: development, exactSource: exact })
    const prepared = await test.executor.prepare({
      candidate: test.candidate,
      arguments: { resolvedCity: '北京', input: { topic: '居住证' } },
      developerMode: true,
    })
    if (prepared.kind !== 'ready') throw new Error('expected ready')
    test.dependencies.resolveCurrentWorkflow.mockImplementationOnce(async () => {
      test.setDeveloperMode(false)
      test.setExactSource(undefined)
      return development
    })

    await expect(test.executor.start(prepared.pending, { userId: 'user_1' }))
      .resolves.toEqual({ kind: 'tool_error', code: 'WORKFLOW_CHANGED' })
    expect(test.executions.startReserved).not.toHaveBeenCalled()
  })

  it('does not start after cancellation discards a pending tool during the live lookup', async () => {
    let releaseLookup!: () => void
    const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve })
    let lookupEntered!: () => void
    const entered = new Promise<void>((resolve) => { lookupEntered = resolve })
    const test = harness()
    test.dependencies.resolveCurrentWorkflow.mockImplementationOnce(async () => {
      lookupEntered()
      await lookupGate
      return workflow()
    })
    const prepared = await test.executor.prepare({
      candidate: test.candidate,
      arguments: { resolvedCity: '北京', input: { topic: '居住证' } },
      developerMode: true,
    })
    if (prepared.kind !== 'ready') throw new Error('expected ready')

    const starting = test.executor.start(prepared.pending, { userId: 'user_1' })
    await entered
    await test.executor.cancel(prepared.pending)
    releaseLookup()

    await expect(starting).resolves.toEqual({ kind: 'tool_error', code: 'CANCELLED' })
    expect(test.executions.discardReservation).toHaveBeenCalledTimes(1)
    expect(test.policy.releaseExecution).toHaveBeenCalledTimes(1)
    expect(test.executions.startReserved).not.toHaveBeenCalled()
  })

  it.each([
    ['input', (pending: Record<string, unknown>) => { pending.input = { topic: '篡改' } }],
    ['city', (pending: Record<string, unknown>) => { pending.city = '上海' }],
    ['source', (pending: Record<string, unknown>) => { pending.source = { id: 'other', version: '1.0.0', source: 'installed', codeSha256: 'b'.repeat(64) } }],
    ['capability', (pending: Record<string, unknown>) => { pending.capability = 'browser.click' }],
    ['scope', (pending: Record<string, unknown>) => { pending.scope = { origins: ['https://attacker.example'] } }],
    ['action summary', (pending: Record<string, unknown>) => { pending.actionSummary = '伪造操作' }],
  ] as const)('fails approval closed after exposed pending %s mutation', async (_field, mutate) => {
    const permission = { capability: 'browser.fill' as const, scope: { origins: ['https://example.com'] } }
    const test = harness({ detail: workflow({ permissions: [permission] }) })
    const prepared = await test.executor.prepare({
      candidate: test.candidate,
      arguments: { resolvedCity: '北京', input: { topic: '居住证' } },
      developerMode: true,
    })
    if (prepared.kind !== 'awaiting_approval') throw new Error('expected approval')
    const decision = onceDecision(prepared.pending)
    let blocked = false
    try { mutate(prepared.pending as unknown as Record<string, unknown>) } catch { blocked = true }

    expect(blocked).toBe(true)
    expect(Object.isFrozen(prepared.pending)).toBe(true)
    expect(onceDecision(prepared.pending)).toEqual(decision)
    expect(test.policy.record).not.toHaveBeenCalled()
    expect(test.executions.startReserved).not.toHaveBeenCalled()
  })

  it('binds approval to the current candidate permission scope', async () => {
    const permission = { capability: 'browser.fill' as const, scope: { origins: ['https://example.com'] } }
    const test = harness({ detail: workflow({ permissions: [permission] }) })
    const prepared = await test.executor.prepare({
      candidate: test.candidate,
      arguments: { resolvedCity: '北京', input: { topic: '居住证' } },
      developerMode: true,
    })
    if (prepared.kind !== 'awaiting_approval') throw new Error('expected approval')
    const decision = onceDecision(prepared.pending)
    permission.scope.origins[0] = 'https://attacker.example'

    await expect(test.executor.approve(prepared.pending, decision))
      .resolves.toEqual({ kind: 'tool_error', code: 'CONFLICT' })
    expect(test.policy.record).not.toHaveBeenCalled()
  })

  it('passes mandatory run identity, phase, and counters to both budget checks', async () => {
    const test = harness()
    const prepared = await test.executor.prepare({
      candidate: test.candidate,
      arguments: { resolvedCity: '北京', input: { topic: '居住证' } },
      developerMode: true,
    })
    if (prepared.kind !== 'ready') throw new Error('expected ready')
    await test.executor.start(prepared.pending, { userId: 'user_1' })

    expect(test.dependencies.checkRemainingBudgets).toHaveBeenNthCalledWith(1, {
      requestId: 'request_1', runId: 'run_1', toolExecutions: 0, modelDecisions: 1, phase: 'prepare',
    })
    expect(test.dependencies.checkRemainingBudgets).toHaveBeenNthCalledWith(2, {
      requestId: 'request_1', runId: 'run_1', toolExecutions: 0, modelDecisions: 1, phase: 'start',
    })
  })

  it('never cleans transferred ownership when startReserved rejects', async () => {
    const test = harness()
    test.executions.startReserved.mockRejectedValueOnce(Object.assign(new Error('port rejected'), { code: 'CONFLICT' }))
    const prepared = await test.executor.prepare({
      candidate: test.candidate,
      arguments: { resolvedCity: '北京', input: { topic: '居住证' } },
      developerMode: true,
    })
    if (prepared.kind !== 'ready') throw new Error('expected ready')

    await expect(test.executor.start(prepared.pending, { userId: 'user_1' }))
      .resolves.toEqual({ kind: 'tool_error', code: 'CONFLICT' })
    expect(test.executions.discardReservation).not.toHaveBeenCalled()
    expect(test.policy.releaseExecution).not.toHaveBeenCalled()
    await test.executor.cancel(prepared.pending)
    expect(test.executions.cancel).toHaveBeenCalledWith('execution_1')
  })

  it('cancels only the bound execution when a start port returns a foreign id', async () => {
    const test = harness()
    test.executions.startReserved.mockImplementationOnce(async () => ({
      id: 'execution_foreign',
      finished: Promise.resolve({
        id: 'execution_foreign', status: 'completed', result: { ok: true, secret: 'foreign' }, input: undefined,
      }),
    }))
    const prepared = await test.executor.prepare({
      candidate: test.candidate,
      arguments: { resolvedCity: '北京', input: { topic: '居住证' } },
      developerMode: true,
    })
    if (prepared.kind !== 'ready') throw new Error('expected ready')

    await expect(test.executor.start(prepared.pending, { userId: 'user_1' }))
      .resolves.toEqual({ kind: 'tool_error', code: 'CONFLICT' })
    expect(test.executions.cancel).toHaveBeenCalledTimes(1)
    expect(test.executions.cancel).toHaveBeenCalledWith('execution_1')
    expect(test.executions.cancel).not.toHaveBeenCalledWith('execution_foreign')
  })

  it('leaves started grant cleanup exclusively to ExecutionService', async () => {
    const test = harness()
    const prepared = await test.executor.prepare({
      candidate: test.candidate,
      arguments: { resolvedCity: '北京', input: { topic: '居住证' } },
      developerMode: true,
    })
    if (prepared.kind !== 'ready') throw new Error('expected ready')
    const started = await test.executor.start(prepared.pending, { userId: 'user_1' })
    if (started.kind !== 'started') throw new Error('expected started')

    await started.finished
    expect(test.executions.discardReservation).not.toHaveBeenCalled()
    expect(test.policy.releaseExecution).not.toHaveBeenCalled()
  })

  it('fails a mismatched completion id closed without exposing its result', async () => {
    const test = harness()
    test.executions.startReserved.mockImplementationOnce(async (reservation) => ({
      id: reservation.executionId,
      finished: Promise.resolve({
        id: 'execution_attacker', status: 'completed', result: { ok: true, secret: 'stolen' }, input: undefined,
      }),
    }))
    const prepared = await test.executor.prepare({
      candidate: test.candidate,
      arguments: { resolvedCity: '北京', input: { topic: '居住证' } },
      developerMode: true,
    })
    if (prepared.kind !== 'ready') throw new Error('expected ready')
    const started = await test.executor.start(prepared.pending, { userId: 'user_1' })
    if (started.kind !== 'started') throw new Error('expected started')

    await expect(started.finished).resolves.toEqual({
      id: 'execution_1', status: 'failed', errorCode: 'CONFLICT',
    })
  })

  it('bounds summary traversal and fails cyclic, throwing-getter, and proxy values safely', () => {
    const wide: Record<string, unknown> = {}
    for (let index = 0; index < 100; index += 1) wide[`key_${index}`] = index
    const circular: { self?: unknown } = {}
    circular.self = circular
    const throwing = Object.defineProperty({}, 'value', {
      enumerable: true,
      get() { throw new Error('secret getter value') },
    })
    const proxy = new Proxy({}, { ownKeys() { throw new Error('secret proxy value') } })

    const summary = createWorkflowActionSummary(workflow(), 'browser.fill', '北京', wide)
    expect(summary).toContain('key_11')
    expect(summary).not.toContain('key_12')
    expect(createWorkflowActionSummary(workflow(), 'browser.fill', '北京', [circular])).toContain('[circular]')
    expect(createWorkflowActionSummary(workflow(), 'browser.fill', '北京', throwing)).toContain('[unavailable]')
    expect(createWorkflowActionSummary(workflow(), 'browser.fill', '北京', proxy)).toContain('[unavailable]')
    expect([summary,
      createWorkflowActionSummary(workflow(), 'browser.fill', '北京', throwing),
      createWorkflowActionSummary(workflow(), 'browser.fill', '北京', proxy),
    ].join(' ')).not.toMatch(/secret getter value|secret proxy value/)
  })

  it('prevents a prepared development tool from starting after developer mode closes', async () => {
    const development = workflow({
      source: 'development', codeSha256: undefined,
      runtimeIdentity: {
        id: 'local.residence.permit', version: '1.0.0', source: 'development', buildHash: 'b'.repeat(64),
      },
    })
    const test = harness({
      detail: development,
      exactSource: {
        id: development.id, version: development.version, source: 'development', buildHash: 'b'.repeat(64),
      },
    })
    const prepared = await test.executor.prepare({
      candidate: test.candidate,
      arguments: { resolvedCity: '北京', input: { topic: '居住证' } },
      developerMode: true,
    })
    if (prepared.kind !== 'ready') throw new Error('expected ready')
    test.setDeveloperMode(false)

    await expect(test.executor.start(prepared.pending, { userId: 'user_1' }))
      .resolves.toEqual({ kind: 'tool_error', code: 'WORKFLOW_CHANGED' })
    expect(test.executions.startReserved).not.toHaveBeenCalled()
    expect(test.executions.discardReservation).toHaveBeenCalledTimes(1)
    expect(test.policy.releaseExecution).toHaveBeenCalledTimes(1)
  })

  it('starts only with validated input and preserves exact selector identity', async () => {
    const permission = { capability: 'browser.open' as const, scope: { origins: ['https://example.com'] } }
    const test = harness({ detail: workflow({ permissions: [permission] }) })
    const prepared = await test.executor.prepare({
      candidate: test.candidate,
      arguments: { resolvedCity: '北京', input: { topic: '居住证' } },
      developerMode: true,
    })
    if (prepared.kind !== 'ready') throw new Error('expected ready')

    const started = await test.executor.start(prepared.pending, {
      userId: 'user_1', conversationId: 'conversation_exact', chatRunId: 'run_1',
    })

    expect(started).toMatchObject({ kind: 'started', executionId: 'execution_1' })
    expect(test.executions.startReserved).toHaveBeenCalledWith(
      expect.any(Object),
      {
        userId: 'user_1', workflowId: test.candidate.workflow.id,
        workflowVersion: test.candidate.workflow.version, input: { topic: '居住证' },
        chatRunId: 'run_1', conversationId: 'conversation_exact', sourceSelector: test.candidate.selector,
        agentAuthorization: {
          workflowFingerprint: expect.any(String),
          permissions: [{
            permissionIndex: 0,
            ...permission,
            scopeHash: scopeHash(permission.scope),
          }],
        },
      },
      undefined,
    )
    expect(JSON.stringify(test.executions.startReserved.mock.calls[0])).not.toContain('resolvedCity')
  })

  it('keeps oversized completed output out of model context by Unicode bytes or authoritative tokens', () => {
    const test = harness()
    expect(test.executor.toModelResult({ result: 'x'.repeat(300 * 1024), contextLength: 128_000 }))
      .toEqual({ kind: 'tool_error', code: 'RESULT_TOO_LARGE' })
    expect(test.executor.toModelResult({ result: '汉'.repeat(90_000), contextLength: 1_000_000 }))
      .toEqual({ kind: 'tool_error', code: 'RESULT_TOO_LARGE' })
    expect(test.executor.toModelResult({ result: 'x'.repeat(5_000), contextLength: 1_000 }))
      .toEqual({ kind: 'tool_error', code: 'RESULT_TOO_LARGE' })
    expect(test.executor.toModelResult({ result: { answer: 'ok' }, contextLength: 128_000 }))
      .toEqual({ kind: 'tool_result', content: '{"answer":"ok"}' })
  })

  it('accepts exact byte and token result limits and rejects one over with the real estimator', () => {
    const test = harness()
    const exactBytes = 'x'.repeat((256 * 1024) - 2)
    const overBytes = `${exactBytes}x`
    expect(Buffer.byteLength(JSON.stringify(exactBytes), 'utf8')).toBe(256 * 1024)
    expect(Buffer.byteLength(JSON.stringify(overBytes), 'utf8')).toBe((256 * 1024) + 1)
    expect(test.executor.toModelResult({ result: exactBytes, contextLength: 2_000_000 }).kind).toBe('tool_result')
    expect(test.executor.toModelResult({ result: overBytes, contextLength: 2_000_000 }))
      .toEqual({ kind: 'tool_error', code: 'RESULT_TOO_LARGE' })

    const exactTokens = 'x'.repeat(28)
    const overTokens = `${exactTokens}x`
    expect(estimateTextTokens(JSON.stringify(exactTokens))).toBe(10)
    expect(estimateTextTokens(JSON.stringify(overTokens))).toBe(11)
    expect(test.executor.toModelResult({ result: exactTokens, contextLength: 67 }).kind).toBe('tool_result')
    expect(test.executor.toModelResult({ result: overTokens, contextLength: 67 }))
      .toEqual({ kind: 'tool_error', code: 'RESULT_TOO_LARGE' })
  })

  it('fails closed for undefined, circular, and non-JSON results without exposing error details', () => {
    const test = harness()
    const circular: { self?: unknown } = {}
    circular.self = circular

    expect(test.executor.toModelResult({ result: undefined, contextLength: 128_000 }))
      .toEqual({ kind: 'tool_result', content: 'null' })
    expect(test.executor.toModelResult({ result: circular, contextLength: 128_000 }))
      .toEqual({ kind: 'tool_error', code: 'INTERNAL_ERROR' })
    expect(test.executor.toModelResult({ result: 1n, contextLength: 128_000 }))
      .toEqual({ kind: 'tool_error', code: 'INTERNAL_ERROR' })
  })

  it('serializes execution failures only as safe code and message', () => {
    const test = harness()
    expect(test.executor.toModelResult({
      error: {
        code: 'WORKER_TIMEOUT', message: 'secret token at /Users/person/file',
        stack: 'stack /Users/person/file', scope: { paths: ['/Users/person'] },
      },
      contextLength: 128_000,
    })).toEqual({
      kind: 'tool_error', code: 'WORKER_TIMEOUT', message: 'The worker timed out.',
    })
  })
})
