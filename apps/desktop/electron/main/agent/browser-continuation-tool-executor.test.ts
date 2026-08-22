import { describe, expect, it, vi } from 'vitest'
import type { BrowserActionAuditEntry } from '../database/repositories.js'
import type {
  BrowserContinuationBinding,
  BrowserContinuationLease,
  BrowserPageSnapshot,
} from '../browser/browser-continuation-types.js'
import {
  BrowserContinuationToolExecutor,
  type BrowserContinuationRunContext,
} from './browser-continuation-tool-executor.js'

function binding(): BrowserContinuationBinding {
  return Object.freeze({
    bindingId: 'binding_1', tabId: 'tab_1', createdAt: 1, status: 'active',
    userId: 'user_1', conversationId: 'conversation_1', chatRunId: 'workflow_run_1',
    executionId: 'execution_1', workflowId: 'workflow.one', workflowVersion: '1.0.0',
    source: 'installed', securityFingerprint: 'a'.repeat(64),
    permissionMatrix: {
      'browser.open': ['https://service.example/*'],
      'browser.fill': ['https://service.example/*'],
      'browser.click': ['https://service.example/*'],
    },
  })
}

function snapshot(overrides: Partial<BrowserPageSnapshot> = {}): BrowserPageSnapshot {
  return Object.freeze({
    snapshotId: 'snapshot_1', bindingId: 'binding_1', origin: 'https://service.example',
    url: 'https://service.example', title: '事项办理', capturedAt: '2026-08-23T00:00:00.000Z',
    navigationEpoch: 1, auth: 'authenticated', serializedBytes: 300,
    nodes: Object.freeze([
      Object.freeze({ ref: 'ref_name', role: 'textbox', name: '姓名', value: '张三', enabled: true, actions: ['fill'] as const }),
      Object.freeze({ ref: 'ref_agree', role: 'checkbox', name: '同意须知', checked: false, enabled: true, actions: ['check'] as const }),
      Object.freeze({ ref: 'ref_save', role: 'button', name: '保存草稿', enabled: true, actions: ['click'] as const }),
      Object.freeze({ ref: 'ref_submit', role: 'button', name: '正式提交', enabled: true, actions: ['click'] as const }),
    ]),
    ...overrides,
  })
}

function run(overrides: Partial<BrowserContinuationRunContext> = {}): BrowserContinuationRunContext {
  return {
    userId: 'user_1', conversationId: 'conversation_1', runId: 'agent_run_1',
    currentUser: { messageId: 'message_current', text: '姓名填写 李四，并且勾选同意须知：是' },
    referencedHistory: [{ messageId: 'message_history', text: '此前填写姓名 王五' }],
    ...overrides,
  }
}

function harness(options: { snapshots?: BrowserPageSnapshot[]; now?: () => number } = {}) {
  const liveBinding = binding()
  let current = true
  const release = vi.fn(async () => { current = false })
  const lease: BrowserContinuationLease = Object.freeze({
    binding: liveBinding,
    ownerRunId: 'agent_run_1',
    isCurrent: (candidate: BrowserContinuationBinding) => current && candidate === liveBinding,
    release,
  })
  const snapshots = [...(options.snapshots ?? [snapshot()])]
  const inspector = {
    inspect: vi.fn(async () => snapshots.shift() ?? snapshot()),
    resolveRef: vi.fn(async (input: { ref: string; snapshotId: string }) => {
      const candidate = snapshot().nodes.find((node) => node.ref === input.ref)
      if (!candidate || input.snapshotId !== 'snapshot_1') throw { code: 'PAGE_CHANGED' }
      return { snapshotId: input.snapshotId, ref: input.ref, backendNodeId: input.ref === 'ref_submit' ? 99 : 10, role: candidate.role, name: candidate.name }
    }),
    endRun: vi.fn(),
  }
  const state = { origin: 'https://service.example', url: 'https://service.example/form', navigationEpoch: 1 }
  const workspace = {
    getContinuationState: vi.fn(async () => ({ ...state })),
    performContinuationAction: vi.fn(async () => undefined),
    focusContinuation: vi.fn(async () => undefined),
    highlightContinuationTarget: vi.fn(async () => undefined),
    clearContinuationHighlight: vi.fn(async () => undefined),
  }
  const audits: BrowserActionAuditEntry[] = []
  const executor = new BrowserContinuationToolExecutor({
    registry: { acquire: vi.fn(async () => lease) },
    inspector: inspector as never,
    workspace,
    audits: {
      list: vi.fn(() => [...audits]),
      insert: vi.fn((entry: BrowserActionAuditEntry) => { audits.push(entry); return entry }),
    },
    id: (() => { let id = 0; return () => `audit_${++id}` })(),
    now: options.now ?? (() => 1_000),
  })
  return { executor, inspector, workspace, audits, lease, release, state }
}

describe('BrowserContinuationToolExecutor', () => {
  it('strictly rejects unknown keys, oversized batches, invalid waits, and source-less checks', async () => {
    const test = harness()
    await expect(test.executor.execute('browser_session_exec' as never, {
      bindingId: 'binding_1', reason: 'manual_action',
    }, run())).resolves.toEqual({ kind: 'tool_error', code: 'INVALID_INPUT' })
    await expect(test.executor.execute('browser_session_inspect', {
      bindingId: 'binding_1', intent: '查看表单', injected: true,
    }, run())).resolves.toEqual({ kind: 'tool_error', code: 'INVALID_INPUT' })
    await expect(test.executor.execute('browser_session_act', {
      bindingId: 'binding_1', snapshotId: 'snapshot_1',
      actions: Array.from({ length: 11 }, () => ({ type: 'focus' })),
    }, run())).resolves.toEqual({ kind: 'tool_error', code: 'INVALID_INPUT' })
    await expect(test.executor.execute('browser_session_act', {
      bindingId: 'binding_1', snapshotId: 'snapshot_1', actions: [{ type: 'wait', milliseconds: 49 }],
    }, run())).resolves.toEqual({ kind: 'tool_error', code: 'INVALID_INPUT' })
    await expect(test.executor.execute('browser_session_act', {
      bindingId: 'binding_1', snapshotId: 'snapshot_1', actions: [{ type: 'check', ref: 'ref_agree', checked: true }],
    }, run())).resolves.toEqual({ kind: 'tool_error', code: 'INVALID_INPUT' })
    expect(test.workspace.performContinuationAction).not.toHaveBeenCalled()
  })

  it('returns bounded explicitly untrusted inspection data and a redacted audit', async () => {
    const test = harness()
    const result = await test.executor.execute('browser_session_inspect', {
      bindingId: 'binding_1', intent: '查看姓名',
    }, run())

    expect(result).toMatchObject({
      kind: 'success',
      data: { trust: 'untrusted_page_data', snapshot: { snapshotId: 'snapshot_1', bindingId: 'binding_1' } },
    })
    expect(JSON.stringify(result)).not.toMatch(/backendNodeId|selector|cookie|webContents/iu)
    expect(test.audits).toEqual([expect.objectContaining({
      sequence: 1, action: 'inspect', targetSummary: 'page', risk: 'sensitive_read', outcome: 'completed',
    })])
  })

  it('hands a protected final action off with focus and Overlay highlight but zero mutation', async () => {
    const test = harness()
    await test.executor.execute('browser_session_inspect', { bindingId: 'binding_1', intent: '填写' }, run())
    const result = await test.executor.execute('browser_session_act', {
      bindingId: 'binding_1', snapshotId: 'snapshot_1', actions: [
        { type: 'click', ref: 'ref_submit' },
        { type: 'click', ref: 'ref_save' },
      ],
    }, run())

    expect(result).toEqual({ kind: 'handoff', code: 'MANUAL_ACTION_REQUIRED' })
    expect(test.workspace.performContinuationAction).not.toHaveBeenCalled()
    expect(test.workspace.focusContinuation).toHaveBeenCalledWith('tab_1')
    expect(test.workspace.highlightContinuationTarget).toHaveBeenCalledWith(
      'tab_1', 'ref_submit', expect.objectContaining({ backendNodeId: 99 }),
    )
    expect(test.release).toHaveBeenCalledOnce()
    expect(test.inspector.endRun).toHaveBeenCalledWith('agent_run_1')
    expect(test.audits.slice(1)).toEqual([
      expect.objectContaining({ action: 'click', targetSummary: 'button control', outcome: 'handed_off' }),
      expect.objectContaining({ action: 'handoff', targetSummary: 'button control', outcome: 'handed_off' }),
    ])
  })

  it('verifies current user, explicitly referenced history, page, and boolean value sources', async () => {
    const test = harness()
    await test.executor.execute('browser_session_inspect', { bindingId: 'binding_1', intent: '填写' }, run())

    await expect(test.executor.execute('browser_session_act', {
      bindingId: 'binding_1', snapshotId: 'snapshot_1', actions: [
        { type: 'fill', ref: 'ref_name', value: '李四', source: { kind: 'current_user' } },
        { type: 'fill', ref: 'ref_name', value: '王五', source: { kind: 'history', messageId: 'message_history' } },
        { type: 'fill', ref: 'ref_name', value: '张三', source: { kind: 'page', snapshotId: 'snapshot_1', ref: 'ref_name' } },
        { type: 'check', ref: 'ref_agree', checked: true, source: { kind: 'current_user' } },
      ],
    }, run())).resolves.toEqual({ kind: 'success', data: { completedActions: 4 } })
    expect(test.workspace.performContinuationAction).toHaveBeenCalledTimes(4)
  })

  it('rejects invented or unreferenced values before dispatch and redacts entered/page text from audit', async () => {
    const test = harness()
    await test.executor.execute('browser_session_inspect', { bindingId: 'binding_1', intent: '填写' }, run())
    const result = await test.executor.execute('browser_session_act', {
      bindingId: 'binding_1', snapshotId: 'snapshot_1', actions: [
        { type: 'fill', ref: 'ref_name', value: '秘密值', source: { kind: 'history', messageId: 'not_referenced' } },
        { type: 'click', ref: 'ref_save' },
      ],
    }, run())

    expect(result).toEqual({ kind: 'tool_error', code: 'INVALID_INPUT' })
    expect(test.workspace.performContinuationAction).not.toHaveBeenCalled()
    expect(test.inspector.endRun).toHaveBeenCalledWith('agent_run_1')
    expect(test.audits.at(-1)).toMatchObject({ action: 'fill', outcome: 'failed', errorCode: 'INVALID_INPUT' })
    expect(JSON.stringify(test.audits)).not.toMatch(/秘密值|张三|李四|王五|姓名|事项办理/u)
  })

  it('stops the suffix on stale refs and performs error cleanup', async () => {
    const test = harness()
    await test.executor.execute('browser_session_inspect', { bindingId: 'binding_1', intent: '填写' }, run())
    test.inspector.resolveRef.mockRejectedValueOnce({ code: 'PAGE_CHANGED' })

    const result = await test.executor.execute('browser_session_act', {
      bindingId: 'binding_1', snapshotId: 'snapshot_1', actions: [
        { type: 'click', ref: 'ref_save' },
        { type: 'wait', milliseconds: 50 },
      ],
    }, run())

    expect(result).toEqual({ kind: 'tool_error', code: 'PAGE_CHANGED' })
    expect(test.workspace.performContinuationAction).not.toHaveBeenCalled()
    expect(test.release).toHaveBeenCalledOnce()
    expect(test.inspector.endRun).toHaveBeenCalledWith('agent_run_1')
    expect(test.audits.at(-1)).toMatchObject({ action: 'click', outcome: 'failed', errorCode: 'PAGE_CHANGED' })
  })

  it('rechecks the exact action capability after dispatch and stops a cancelled suffix', async () => {
    const originChanged = harness()
    await originChanged.executor.execute('browser_session_inspect', { bindingId: 'binding_1', intent: '保存' }, run())
    originChanged.workspace.performContinuationAction.mockImplementationOnce(async () => {
      originChanged.state.origin = 'https://outside.example'
      originChanged.state.url = 'https://outside.example/landing'
    })
    await expect(originChanged.executor.execute('browser_session_act', {
      bindingId: 'binding_1', snapshotId: 'snapshot_1', actions: [{ type: 'click', ref: 'ref_save' }],
    }, run())).resolves.toEqual({ kind: 'tool_error', code: 'DOMAIN_BLOCKED' })
    expect(originChanged.audits.at(-1)).toMatchObject({ action: 'click', outcome: 'failed', errorCode: 'DOMAIN_BLOCKED' })

    const controller = new AbortController()
    const cancelled = harness()
    await cancelled.executor.execute('browser_session_inspect', { bindingId: 'binding_1', intent: '保存' }, run())
    cancelled.workspace.performContinuationAction.mockImplementationOnce(async () => { controller.abort() })
    await expect(cancelled.executor.execute('browser_session_act', {
      bindingId: 'binding_1', snapshotId: 'snapshot_1', actions: [
        { type: 'click', ref: 'ref_save' }, { type: 'wait', milliseconds: 50 },
      ],
    }, run({ signal: controller.signal }))).resolves.toEqual({ kind: 'tool_error', code: 'CANCELLED' })
    expect(cancelled.workspace.performContinuationAction).toHaveBeenCalledOnce()
    expect(cancelled.audits.at(-1)).toMatchObject({ action: 'click', outcome: 'cancelled', errorCode: 'CANCELLED' })
  })

  it('enforces 30 actions without resetting the run budget across batches', async () => {
    const test = harness()
    await test.executor.execute('browser_session_inspect', { bindingId: 'binding_1', intent: '检查' }, run())
    for (let batch = 0; batch < 3; batch += 1) {
      await expect(test.executor.execute('browser_session_act', {
        bindingId: 'binding_1', snapshotId: 'snapshot_1',
        actions: Array.from({ length: 10 }, (_, index) => ({ type: 'wait', milliseconds: 50 + batch * 10 + index })),
      }, run())).resolves.toEqual({ kind: 'success', data: { completedActions: 10 } })
    }
    await expect(test.executor.execute('browser_session_act', {
      bindingId: 'binding_1', snapshotId: 'snapshot_1', actions: [{ type: 'focus' }],
    }, run())).resolves.toEqual({ kind: 'tool_error', code: 'ACTION_LIMIT_EXCEEDED' })
    expect(test.workspace.performContinuationAction).toHaveBeenCalledTimes(30)
  })

  it('ends authority after three no-progress inspections and after five active minutes', async () => {
    const noProgress = harness({ snapshots: [snapshot(), snapshot({ snapshotId: 'snapshot_2' }), snapshot({ snapshotId: 'snapshot_3' })] })
    await noProgress.executor.execute('browser_session_inspect', { bindingId: 'binding_1', intent: '检查' }, run())
    await noProgress.executor.execute('browser_session_inspect', { bindingId: 'binding_1', intent: '检查' }, run())
    await expect(noProgress.executor.execute('browser_session_inspect', {
      bindingId: 'binding_1', intent: '检查',
    }, run())).resolves.toEqual({ kind: 'tool_error', code: 'ACTION_LIMIT_EXCEEDED' })
    expect(noProgress.inspector.endRun).toHaveBeenCalledWith('agent_run_1')

    let now = 0
    const timed = harness({ now: () => now })
    await timed.executor.execute('browser_session_inspect', { bindingId: 'binding_1', intent: '检查' }, run())
    now = 300_001
    await expect(timed.executor.execute('browser_session_act', {
      bindingId: 'binding_1', snapshotId: 'snapshot_1', actions: [{ type: 'focus' }],
    }, run())).resolves.toEqual({ kind: 'tool_error', code: 'ACTION_LIMIT_EXCEEDED' })
    expect(timed.workspace.performContinuationAction).not.toHaveBeenCalled()
  })

  it('owns terminal, cancellation, takeover, handoff, and error endRun cleanup', async () => {
    const cancelled = harness()
    const controller = new AbortController()
    await cancelled.executor.execute('browser_session_inspect', { bindingId: 'binding_1', intent: '检查' }, run())
    controller.abort()
    await expect(cancelled.executor.execute('browser_session_act', {
      bindingId: 'binding_1', snapshotId: 'snapshot_1', actions: [{ type: 'focus' }],
    }, run({ signal: controller.signal }))).resolves.toEqual({ kind: 'tool_error', code: 'CANCELLED' })
    expect(cancelled.inspector.endRun).toHaveBeenCalledWith('agent_run_1')

    const takeover = harness()
    await takeover.executor.execute('browser_session_inspect', { bindingId: 'binding_1', intent: '检查' }, run())
    await takeover.executor.takeOver('agent_run_1')
    expect(takeover.inspector.endRun).toHaveBeenCalledWith('agent_run_1')
    expect(takeover.release).toHaveBeenCalledOnce()

    const terminal = harness()
    await terminal.executor.execute('browser_session_inspect', { bindingId: 'binding_1', intent: '检查' }, run())
    await terminal.executor.endRun('agent_run_1')
    expect(terminal.inspector.endRun).toHaveBeenCalledWith('agent_run_1')
    expect(terminal.release).toHaveBeenCalledOnce()
  })
})
