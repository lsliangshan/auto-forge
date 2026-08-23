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
import type { BrowserResolvedElementReference } from '../browser/browser-page-inspector.js'

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
      Object.freeze({ ref: 'ref_help', role: 'link', name: '帮助中心', enabled: true, actions: ['click'] as const }),
    ]),
    ...overrides,
  })
}

function run(overrides: Partial<BrowserContinuationRunContext> = {}): BrowserContinuationRunContext {
  return {
    userId: 'user_1', conversationId: 'conversation_1', runId: 'agent_run_1',
    currentUser: { messageId: 'message_current', text: '姓名填写 李四，并且勾选同意须知：是' },
    ...overrides,
  }
}

function harness(options: {
  snapshots?: BrowserPageSnapshot[]
  now?: () => number
  stableSemantics?: boolean
  terminalRunLimit?: number
  terminalRunTtlMs?: number
} = {}) {
  const liveBinding = binding()
  let current = true
  const release = vi.fn(async () => { current = false })
  const lease: BrowserContinuationLease = Object.freeze({
    binding: liveBinding,
    ownerRunId: 'agent_run_1',
    isCurrent: (candidate: BrowserContinuationBinding) => current && candidate === liveBinding,
    assertEligible: vi.fn(async () => undefined),
    release,
  })
  const snapshots = [...(options.snapshots ?? [snapshot()])]
  let semanticRead = 0
  const semanticFingerprint = () => options.stableSemantics ? 'stable_page' : `page_${++semanticRead}`
  const inspector = {
    inspect: vi.fn(async () => snapshots.shift() ?? snapshot()),
    resolveRef: vi.fn(async (input: { ref: string; snapshotId: string }): Promise<BrowserResolvedElementReference> => {
      const candidate = snapshot().nodes.find((node) => node.ref === input.ref)
      if (!candidate || input.snapshotId !== 'snapshot_1') throw { code: 'PAGE_CHANGED' }
      return {
        snapshotId: input.snapshotId,
        ref: input.ref,
        backendNodeId: input.ref === 'ref_submit' ? 99 : 10,
        role: candidate.role,
        name: candidate.name,
        auth: 'authenticated' as const,
        semanticFingerprint: semanticFingerprint(),
        targetContext: input.ref === 'ref_help' ? { href: 'https://service.example/help' } : {},
      }
    }),
    currentPageContext: vi.fn(async () => ({
      auth: 'authenticated' as const,
      semanticFingerprint: semanticFingerprint(),
    })),
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
    ...(options.terminalRunLimit === undefined ? {} : { terminalRunLimit: options.terminalRunLimit }),
    ...(options.terminalRunTtlMs === undefined ? {} : { terminalRunTtlMs: options.terminalRunTtlMs }),
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
    await expect(test.executor.execute('browser_session_inspect', {
      bindingId: 'binding_1', intent: '查看表单', mode: 'region_image', ref: 'ref_name',
    }, run())).resolves.toEqual({ kind: 'tool_error', code: 'INVALID_INPUT' })
    await expect(test.executor.execute('browser_session_act', {
      bindingId: 'binding_1', snapshotId: 'snapshot_1', actions: [{
        type: 'fill', ref: 'ref_name', value: '王五',
        source: { kind: 'history', messageId: 'message_history' },
      }],
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
    expect(test.workspace.focusContinuation).toHaveBeenCalledWith('tab_1', 'agent_run_1')
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

  it('verifies current-user, page, and boolean value sources', async () => {
    const initial = snapshot()
    const progressSnapshot = (snapshotId: string, name: string, checked = false) => snapshot({
      snapshotId,
      nodes: Object.freeze(initial.nodes.map((node) => Object.freeze(
        node.ref === 'ref_name' ? { ...node, value: name }
          : node.ref === 'ref_agree' ? { ...node, checked } : node,
      ))),
    })
    const test = harness({ snapshots: [
      initial,
      progressSnapshot('progress_1', '李四'),
      progressSnapshot('progress_2', '张三'),
      progressSnapshot('progress_3', '张三', true),
    ] })
    await test.executor.execute('browser_session_inspect', { bindingId: 'binding_1', intent: '填写' }, run())

    await expect(test.executor.execute('browser_session_act', {
      bindingId: 'binding_1', snapshotId: 'snapshot_1', actions: [
        { type: 'fill', ref: 'ref_name', value: '李四', source: { kind: 'current_user' } },
        { type: 'fill', ref: 'ref_name', value: '张三', source: { kind: 'page', snapshotId: 'snapshot_1', ref: 'ref_name' } },
        { type: 'check', ref: 'ref_agree', checked: true, source: { kind: 'current_user' } },
      ],
    }, run())).resolves.toEqual({ kind: 'success', data: { completedActions: 3 } })
    expect(test.workspace.performContinuationAction).toHaveBeenCalledTimes(3)
  })

  it('accepts only exact current-user URLs or fresh inspected link destinations', async () => {
    const exact = harness({ snapshots: [snapshot(), snapshot({ snapshotId: 'progress_1' })] })
    const exactContext = run({
      currentUser: { messageId: 'message_current', text: '请打开 https://service.example/help?topic=permit' },
    })
    await exact.executor.execute('browser_session_inspect', { bindingId: 'binding_1', intent: '打开帮助' }, exactContext)
    await expect(exact.executor.execute('browser_session_act', {
      bindingId: 'binding_1', snapshotId: 'snapshot_1', actions: [{
        type: 'navigate', url: 'https://service.example/help?topic=permit', source: { kind: 'current_user' },
      }],
    }, exactContext)).resolves.toEqual({ kind: 'success', data: { completedActions: 1 } })
    expect(exact.workspace.performContinuationAction).toHaveBeenCalledOnce()

    const inspected = harness({ snapshots: [snapshot(), snapshot({ snapshotId: 'progress_1' })] })
    inspected.inspector.resolveRef.mockResolvedValueOnce({
      snapshotId: 'snapshot_1', ref: 'ref_help', backendNodeId: 11, role: 'link', name: '帮助中心',
      auth: 'authenticated', semanticFingerprint: 'before',
      targetContext: { href: 'https://service.example/help' },
    })
    const inspectedContext = run({ currentUser: { messageId: 'message_current', text: '打开帮助中心' } })
    await inspected.executor.execute('browser_session_inspect', {
      bindingId: 'binding_1', intent: '打开帮助中心',
    }, inspectedContext)
    await expect(inspected.executor.execute('browser_session_act', {
      bindingId: 'binding_1', snapshotId: 'snapshot_1', actions: [{
        type: 'navigate', url: 'https://service.example/help',
        source: { kind: 'page', snapshotId: 'snapshot_1', ref: 'ref_help' },
      }],
    }, inspectedContext)).resolves.toEqual({ kind: 'success', data: { completedActions: 1 } })
    expect(inspected.workspace.performContinuationAction).toHaveBeenCalledOnce()
  })

  it.each(['/logout', '/account/delete', '/permit/withdraw', '/change/confirm'])(
    'hands exact but protected same-origin navigation off: %s',
    async (path) => {
      const test = harness()
      const url = `https://service.example${path}`
      const context = run({ currentUser: { messageId: 'message_current', text: `请打开 ${url}` } })
      await test.executor.execute('browser_session_inspect', { bindingId: 'binding_1', intent: '打开' }, context)
      await expect(test.executor.execute('browser_session_act', {
        bindingId: 'binding_1', snapshotId: 'snapshot_1', actions: [{
          type: 'navigate', url, source: { kind: 'current_user' },
        }],
      }, context)).resolves.toEqual({ kind: 'handoff', code: 'MANUAL_ACTION_REQUIRED' })
      expect(test.workspace.performContinuationAction).not.toHaveBeenCalled()
    },
  )

  it('rejects URL substrings, origin-only mentions, and stale or mismatched page links', async () => {
    for (const [text, action] of [
      ['打开 https://service.example/helpful', {
        type: 'navigate' as const, url: 'https://service.example/help', source: { kind: 'current_user' as const },
      }],
      ['打开 https://service.example', {
        type: 'navigate' as const, url: 'https://service.example/help', source: { kind: 'current_user' as const },
      }],
      ['打开帮助中心', {
        type: 'navigate' as const, url: 'https://service.example/other',
        source: { kind: 'page' as const, snapshotId: 'snapshot_1', ref: 'ref_help' },
      }],
    ] as const) {
      const test = harness()
      const context = run({ currentUser: { messageId: 'message_current', text } })
      await test.executor.execute('browser_session_inspect', { bindingId: 'binding_1', intent: text }, context)
      await expect(test.executor.execute('browser_session_act', {
        bindingId: 'binding_1', snapshotId: 'snapshot_1', actions: [action],
      }, context)).resolves.toEqual({ kind: 'tool_error', code: 'INVALID_INPUT' })
      expect(test.workspace.performContinuationAction).not.toHaveBeenCalled()
    }
  })

  it('uses live target semantics and auth so benign-looking final controls never dispatch', async () => {
    const semanticFinal = harness()
    await semanticFinal.executor.execute('browser_session_inspect', { bindingId: 'binding_1', intent: '保存' }, run())
    semanticFinal.inspector.resolveRef.mockResolvedValueOnce({
      snapshotId: 'snapshot_1', ref: 'ref_save', backendNodeId: 10, role: 'button', name: '保存草稿',
      auth: 'authenticated', semanticFingerprint: 'before',
      targetContext: {
        formOwned: true, expectedNavigation: true, inputType: 'submit', nearbyLabels: ['确认并提交申请'],
      },
    })

    await expect(semanticFinal.executor.execute('browser_session_act', {
      bindingId: 'binding_1', snapshotId: 'snapshot_1', actions: [{ type: 'click', ref: 'ref_save' }],
    }, run())).resolves.toEqual({ kind: 'handoff', code: 'MANUAL_ACTION_REQUIRED' })
    expect(semanticFinal.workspace.performContinuationAction).not.toHaveBeenCalled()

    const liveAuth = harness()
    await liveAuth.executor.execute('browser_session_inspect', { bindingId: 'binding_1', intent: '保存' }, run())
    liveAuth.inspector.resolveRef.mockResolvedValueOnce({
      snapshotId: 'snapshot_1', ref: 'ref_save', backendNodeId: 10, role: 'button', name: '保存草稿',
      auth: 'required', semanticFingerprint: 'before', targetContext: { nearbyLabels: ['登录后继续'] },
    })
    await expect(liveAuth.executor.execute('browser_session_act', {
      bindingId: 'binding_1', snapshotId: 'snapshot_1', actions: [{ type: 'click', ref: 'ref_save' }],
    }, run())).resolves.toEqual({ kind: 'handoff', code: 'AUTH_REQUIRED' })
    expect(liveAuth.workspace.performContinuationAction).not.toHaveBeenCalled()
  })

  it.each([
    { text: '不同意须知', checked: true },
    { text: '不要勾选同意须知', checked: true },
    { text: '勾选同意须知，但不要勾选同意须知', checked: true },
  ])('rejects ambiguous or negated boolean evidence: $text', async ({ text, checked }) => {
    const test = harness()
    await test.executor.execute('browser_session_inspect', { bindingId: 'binding_1', intent: '填写' }, run({
      currentUser: { messageId: 'message_current', text },
    }))
    await expect(test.executor.execute('browser_session_act', {
      bindingId: 'binding_1', snapshotId: 'snapshot_1', actions: [
        { type: 'check', ref: 'ref_agree', checked, source: { kind: 'current_user' } },
      ],
    }, run({ currentUser: { messageId: 'message_current', text } }))).resolves.toEqual({
      kind: 'tool_error', code: 'INVALID_INPUT',
    })
    expect(test.workspace.performContinuationAction).not.toHaveBeenCalled()
  })

  it('rejects invalid calendar dates but preserves explicitly quoted values', async () => {
    const invalidDate = harness()
    const invalidContext = run({ currentUser: { messageId: 'message_current', text: '办理日期：2026-02-31' } })
    await invalidDate.executor.execute('browser_session_inspect', { bindingId: 'binding_1', intent: '填写' }, invalidContext)
    await expect(invalidDate.executor.execute('browser_session_act', {
      bindingId: 'binding_1', snapshotId: 'snapshot_1', actions: [
        { type: 'fill', ref: 'ref_name', value: '2026-02-31', source: { kind: 'current_user' } },
      ],
    }, invalidContext)).resolves.toEqual({ kind: 'tool_error', code: 'INVALID_INPUT' })
    expect(invalidDate.workspace.performContinuationAction).not.toHaveBeenCalled()

    const quoted = harness()
    const quotedContext = run({ currentUser: { messageId: 'message_current', text: '姓名：“李四”' } })
    await quoted.executor.execute('browser_session_inspect', { bindingId: 'binding_1', intent: '填写' }, quotedContext)
    await expect(quoted.executor.execute('browser_session_act', {
      bindingId: 'binding_1', snapshotId: 'snapshot_1', actions: [
        { type: 'fill', ref: 'ref_name', value: '李四', source: { kind: 'current_user' } },
      ],
    }, quotedContext)).resolves.toEqual({ kind: 'success', data: { completedActions: 1 } })
  })

  it('does not treat a requested value as evidence-delimited inside its negation', async () => {
    const test = harness()
    const context = run({ currentUser: { messageId: 'message_current', text: '办理意见：不同意' } })
    await test.executor.execute('browser_session_inspect', { bindingId: 'binding_1', intent: '填写' }, context)
    await expect(test.executor.execute('browser_session_act', {
      bindingId: 'binding_1', snapshotId: 'snapshot_1', actions: [
        { type: 'fill', ref: 'ref_name', value: '同意', source: { kind: 'current_user' } },
      ],
    }, context)).resolves.toEqual({ kind: 'tool_error', code: 'INVALID_INPUT' })
    expect(test.workspace.performContinuationAction).not.toHaveBeenCalled()
  })

  it('rejects invented values before dispatch and redacts entered/page text from audit', async () => {
    const test = harness()
    await test.executor.execute('browser_session_inspect', { bindingId: 'binding_1', intent: '填写' }, run())
    const result = await test.executor.execute('browser_session_act', {
      bindingId: 'binding_1', snapshotId: 'snapshot_1', actions: [
        { type: 'fill', ref: 'ref_name', value: '秘密值', source: { kind: 'current_user' } },
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

  it('counts a dispatched action before post-dispatch failure and terminally rejects same-run retry', async () => {
    const test = harness()
    await test.executor.execute('browser_session_inspect', { bindingId: 'binding_1', intent: '保存' }, run())
    let countAtFailedAudit: number | undefined
    test.workspace.performContinuationAction.mockRejectedValueOnce({ code: 'PAGE_CHANGED' })
    test.executor['dependencies'].audits.insert = vi.fn((entry: BrowserActionAuditEntry) => {
      test.audits.push(entry)
      if (entry.action === 'click' && entry.outcome === 'failed') {
        countAtFailedAudit = test.executor['runs'].get('agent_run_1')?.actionCount
      }
      return entry
    })

    await expect(test.executor.execute('browser_session_act', {
      bindingId: 'binding_1', snapshotId: 'snapshot_1', actions: [{ type: 'click', ref: 'ref_save' }],
    }, run())).resolves.toEqual({ kind: 'tool_error', code: 'PAGE_CHANGED' })
    expect(countAtFailedAudit).toBe(1)
    expect(test.inspector.endRun).toHaveBeenCalledWith('agent_run_1')
    expect(test.release).toHaveBeenCalledOnce()

    await expect(test.executor.execute('browser_session_inspect', {
      bindingId: 'binding_1', intent: '重试',
    }, run())).resolves.toEqual({ kind: 'tool_error', code: 'CANCELLED' })
    expect(test.executor['dependencies'].registry.acquire).toHaveBeenCalledOnce()
  })

  it.each([
    { phase: 'resolve', code: 'PAGE_CHANGED' as const },
    { phase: 'focus', code: 'PAGE_CLOSED' as const },
    { phase: 'highlight', code: 'PAGE_CHANGED' as const },
    { phase: 'release', code: 'PAGE_BUSY' as const },
  ])('records exactly one failed explicit handoff audit when $phase fails', async ({ phase, code }) => {
    const test = harness()
    await test.executor.execute('browser_session_inspect', { bindingId: 'binding_1', intent: '提交' }, run())
    if (phase === 'resolve') test.inspector.resolveRef.mockRejectedValueOnce({ code })
    if (phase === 'focus') test.workspace.focusContinuation.mockRejectedValueOnce({ code })
    if (phase === 'highlight') test.workspace.highlightContinuationTarget.mockRejectedValueOnce({ code })
    if (phase === 'release') test.release.mockRejectedValueOnce({ code })

    await expect(test.executor.execute('browser_session_handoff', {
      bindingId: 'binding_1', reason: 'manual_action', ref: 'ref_submit',
    }, run())).resolves.toEqual({ kind: 'tool_error', code })
    expect(test.audits.filter(({ action }) => action === 'handoff')).toEqual([
      expect.objectContaining({ outcome: 'failed', errorCode: code }),
    ])
  })

  it('does not report a guard-triggered handoff until focus and highlight succeed', async () => {
    const test = harness()
    await test.executor.execute('browser_session_inspect', { bindingId: 'binding_1', intent: '提交' }, run())
    test.workspace.highlightContinuationTarget.mockRejectedValueOnce({ code: 'PAGE_CHANGED' })

    await expect(test.executor.execute('browser_session_act', {
      bindingId: 'binding_1', snapshotId: 'snapshot_1', actions: [{ type: 'click', ref: 'ref_submit' }],
    }, run())).resolves.toEqual({ kind: 'tool_error', code: 'PAGE_CHANGED' })
    expect(test.workspace.performContinuationAction).not.toHaveBeenCalled()
    expect(test.audits.slice(1)).toEqual([
      expect.objectContaining({ action: 'click', outcome: 'failed', errorCode: 'PAGE_CHANGED' }),
      expect.objectContaining({ action: 'handoff', outcome: 'failed', errorCode: 'PAGE_CHANGED' }),
    ])
    expect(test.audits.some(({ outcome }) => outcome === 'handed_off')).toBe(false)
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
    for (let batch = 0; batch < 15; batch += 1) {
      await expect(test.executor.execute('browser_session_act', {
        bindingId: 'binding_1', snapshotId: 'snapshot_1',
        actions: Array.from({ length: 2 }, (_, index) => ({ type: 'wait', milliseconds: 50 + batch * 2 + index })),
      }, run())).resolves.toEqual({ kind: 'success', data: { completedActions: 2 } })
      test.executor['runs'].get('agent_run_1')!.noProgressCount = 0
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

  it('stops alternating actions on the exact third unchanged semantic cycle', async () => {
    const test = harness({ stableSemantics: true })
    await test.executor.execute('browser_session_inspect', { bindingId: 'binding_1', intent: '检查' }, run())

    await expect(test.executor.execute('browser_session_act', {
      bindingId: 'binding_1', snapshotId: 'snapshot_1', actions: [
        { type: 'focus' }, { type: 'wait', milliseconds: 50 }, { type: 'scroll', direction: 'down' },
      ],
    }, run())).resolves.toEqual({ kind: 'tool_error', code: 'ACTION_LIMIT_EXCEEDED' })
    expect(test.workspace.performContinuationAction).toHaveBeenCalledTimes(3)
    expect(test.audits.at(-1)).toMatchObject({ action: 'scroll', outcome: 'failed', errorCode: 'ACTION_LIMIT_EXCEEDED' })
  })

  it.each([
    { type: 'focus' as const },
    { type: 'wait' as const, milliseconds: 50 },
  ])('does not let a successful $type reset prior no-progress', async (action) => {
    const test = harness()
    await test.executor.execute('browser_session_inspect', { bindingId: 'binding_1', intent: '检查' }, run())
    test.executor['runs'].get('agent_run_1')!.noProgressCount = 2

    await expect(test.executor.execute('browser_session_act', {
      bindingId: 'binding_1', snapshotId: 'snapshot_1', actions: [action],
    }, run())).resolves.toEqual({ kind: 'tool_error', code: 'ACTION_LIMIT_EXCEEDED' })
  })

  it('does not let unrelated animation after scroll reset prior no-progress', async () => {
    const before = snapshot({
      nodes: Object.freeze([
        Object.freeze({
          ref: 'ref_animation', role: 'status', name: '有效活动动画', value: '第 1 帧',
          enabled: true, actions: [] as const,
        }),
      ]),
    })
    const after = snapshot({
      snapshotId: 'snapshot_2',
      nodes: Object.freeze([
        Object.freeze({
          ref: 'ref_animation_2', role: 'status', name: '有效活动动画', value: '第 2 帧',
          enabled: true, actions: [] as const,
        }),
      ]),
    })
    const test = harness({ snapshots: [before, after] })
    const context = run({ currentUser: { messageId: 'message_current', text: '读取证件有效期' } })
    await test.executor.execute('browser_session_inspect', {
      bindingId: 'binding_1', intent: context.currentUser.text,
    }, context)
    test.executor['runs'].get('agent_run_1')!.noProgressCount = 2

    await expect(test.executor.execute('browser_session_act', {
      bindingId: 'binding_1', snapshotId: 'snapshot_1', actions: [{ type: 'scroll', direction: 'down' }],
    }, context)).resolves.toEqual({ kind: 'tool_error', code: 'ACTION_LIMIT_EXCEEDED' })
  })

  it('lets scroll reset no-progress only after revealing user-intent-relevant evidence', async () => {
    const before = snapshot({ nodes: Object.freeze([]) })
    const after = snapshot({
      snapshotId: 'snapshot_2',
      nodes: Object.freeze([
        Object.freeze({
          ref: 'ref_expiry', role: 'text', name: '有效期至', value: '2028-06-30',
          enabled: true, actions: [] as const,
        }),
      ]),
    })
    const test = harness({ snapshots: [before, after] })
    const context = run({ currentUser: { messageId: 'message_current', text: '读取证件有效期' } })
    await test.executor.execute('browser_session_inspect', {
      bindingId: 'binding_1', intent: context.currentUser.text,
    }, context)
    test.executor['runs'].get('agent_run_1')!.noProgressCount = 2

    await expect(test.executor.execute('browser_session_act', {
      bindingId: 'binding_1', snapshotId: 'snapshot_1', actions: [{ type: 'scroll', direction: 'down' }],
    }, context)).resolves.toEqual({ kind: 'success', data: { completedActions: 1 } })
    expect(test.inspector.inspect).toHaveBeenCalledTimes(2)
    expect(test.executor['runs'].get('agent_run_1')?.noProgressCount).toBe(0)
  })

  it('does not attribute evidence revealed during wait to a later scroll', async () => {
    const before = snapshot({ nodes: Object.freeze([]) })
    const revealedDuringWait = snapshot({
      snapshotId: 'snapshot_2',
      nodes: Object.freeze([
        Object.freeze({
          ref: 'ref_expiry', role: 'text', name: '有效期至', value: '2028-06-30',
          enabled: true, actions: [] as const,
        }),
      ]),
    })
    const unchangedAfterScroll = snapshot({
      snapshotId: 'snapshot_3', nodes: revealedDuringWait.nodes,
    })
    const test = harness({ snapshots: [before, revealedDuringWait, unchangedAfterScroll] })
    const context = run({ currentUser: { messageId: 'message_current', text: '读取证件有效期' } })
    await test.executor.execute('browser_session_inspect', {
      bindingId: 'binding_1', intent: context.currentUser.text,
    }, context)
    test.executor['runs'].get('agent_run_1')!.noProgressCount = 1

    await expect(test.executor.execute('browser_session_act', {
      bindingId: 'binding_1', snapshotId: 'snapshot_1', actions: [
        { type: 'wait', milliseconds: 50 },
        { type: 'scroll', direction: 'down' },
      ],
    }, context)).resolves.toEqual({ kind: 'tool_error', code: 'ACTION_LIMIT_EXCEEDED' })
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

  it('bounds late-call tombstones by deterministic TTL and LRU eviction', async () => {
    let now = 1_000
    const test = harness({ now: () => now, terminalRunLimit: 2, terminalRunTtlMs: 100 })
    await test.executor.endRun('run_1')
    await test.executor.endRun('run_2')
    await test.executor.endRun('run_3')

    await expect(test.executor.execute('unknown' as never, {}, run({ runId: 'run_1' })))
      .resolves.toEqual({ kind: 'tool_error', code: 'INVALID_INPUT' })
    await expect(test.executor.execute('browser_session_inspect', {
      bindingId: 'binding_1', intent: 'late',
    }, run({ runId: 'run_2' }))).resolves.toEqual({ kind: 'tool_error', code: 'CANCELLED' })
    await test.executor.endRun('run_4')
    await expect(test.executor.execute('unknown' as never, {}, run({ runId: 'run_2' })))
      .resolves.toEqual({ kind: 'tool_error', code: 'CANCELLED' })
    await expect(test.executor.execute('unknown' as never, {}, run({ runId: 'run_3' })))
      .resolves.toEqual({ kind: 'tool_error', code: 'INVALID_INPUT' })

    now = 1_100
    await expect(test.executor.execute('unknown' as never, {}, run({ runId: 'run_4' })))
      .resolves.toEqual({ kind: 'tool_error', code: 'INVALID_INPUT' })
    expect(test.executor['terminalRuns'].size).toBe(0)
  })
})
