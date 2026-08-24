import { describe, expect, it, vi } from 'vitest'
import type { BrowserActionAuditEntry } from '../database/repositories.js'
import type {
  BrowserContinuationBinding,
  BrowserContinuationLease,
  BrowserPageSnapshot,
  BrowserVisualEvidenceBundle,
} from '../browser/browser-continuation-types.js'
import {
  BrowserContinuationToolExecutor,
  type BrowserContinuationRunContext,
} from './browser-continuation-tool-executor.js'
import type {
  BrowserPrivateFieldEvidence,
  BrowserResolvedElementReference,
} from '../browser/browser-page-inspector.js'
import type { BrowserManualResumeWaitInput } from '../browser/browser-manual-resume-coordinator.js'

function binding(): BrowserContinuationBinding {
  return Object.freeze({
    bindingId: 'binding_1', tabId: 'tab_1', createdAt: 1, status: 'active',
    userId: 'user_1', conversationId: 'conversation_1', chatRunId: 'workflow_run_1',
    executionId: 'execution_1', workflowId: 'workflow.one', workflowVersion: '1.0.0',
    source: 'installed', securityFingerprint: 'a'.repeat(64),
    permissionMatrix: {
      'browser.open': ['https://service.example/*', 'https://details.example/*'],
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

function visualBundle(page: BrowserPageSnapshot): BrowserVisualEvidenceBundle {
  return Object.freeze({
    snapshotId: page.snapshotId,
    bindingId: page.bindingId,
    origin: page.origin,
    navigationEpoch: page.navigationEpoch,
    capturedAt: '2026-08-24T00:00:00.000Z',
    pages: Object.freeze([page]),
    tiles: Object.freeze([]),
    placements: Object.freeze([]),
  })
}

function harness(options: {
  snapshots?: BrowserPageSnapshot[]
  visualEvidenceBundle?: BrowserVisualEvidenceBundle
  now?: () => number
  terminalRunLimit?: number
  terminalRunTtlMs?: number
  isRunActive?: (runId: string) => boolean
  waitForLogin?: (input: { probe: () => Promise<'authenticated' | 'required' | 'unknown'> }) => Promise<void>
  waitForManual?: (input: BrowserManualResumeWaitInput) => Promise<void>
  includeManualWait?: boolean
} = {}) {
  const liveBinding = binding()
  let current = true
  const release = vi.fn(async () => { current = false })
  const assertEligible = vi.fn(async () => undefined)
  const lease: BrowserContinuationLease = Object.freeze({
    binding: liveBinding,
    ownerRunId: 'agent_run_1',
    isCurrent: (candidate: BrowserContinuationBinding) => current && candidate === liveBinding,
    assertEligible,
    release,
  })
  const snapshots = [...(options.snapshots ?? [snapshot()])]
  let semanticRead = 0
  const semanticFingerprint = () => `page_${++semanticRead}`
  const inspector = {
    inspect: vi.fn(async () => snapshots.shift() ?? snapshot()),
    fieldEvidence: vi.fn<() => readonly BrowserPrivateFieldEvidence[]>(() => []),
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
    currentPageContext: vi.fn(async (): Promise<{
      auth: 'authenticated' | 'required' | 'unknown'
      semanticFingerprint: string
    }> => ({
      auth: 'authenticated',
      semanticFingerprint: semanticFingerprint(),
    })),
    captureVisualEvidence: vi.fn(async () => options.visualEvidenceBundle ?? visualBundle(snapshot())),
    endRun: vi.fn(),
  }
  const state = {
    origin: 'https://service.example', url: 'https://service.example/form',
    navigationEpoch: 1, activityRevision: 0,
  }
  const workspace = {
    getContinuationState: vi.fn(async () => ({ ...state })),
    performContinuationAction: vi.fn(async () => undefined),
    focusContinuation: vi.fn(async () => undefined),
    highlightContinuationTarget: vi.fn(async () => undefined),
    clearContinuationHighlight: vi.fn(async () => undefined),
    suspendContinuation: vi.fn(async () => undefined),
    resumeContinuation: vi.fn(async (
      tabId: string,
      runId: string,
      expected?: { origin: string; navigationEpoch: number },
    ) => {
      void tabId
      void runId
      void expected
    }),
  }
  const loginWait = {
    wait: vi.fn(options.waitForLogin ?? (async (input) => {
      if (await input.probe() !== 'authenticated') throw { code: 'AUTH_REQUIRED' }
    })),
    cancel: vi.fn(),
  }
  const manualWait = {
    wait: vi.fn(options.waitForManual ?? (async (input: BrowserManualResumeWaitInput) => {
      await input.promote()
    })),
    cancel: vi.fn(),
  }
  const audits: BrowserActionAuditEntry[] = []
  const executor = new BrowserContinuationToolExecutor({
    registry: { acquire: vi.fn(async () => lease) },
    inspector: inspector as never,
    workspace,
    loginWait,
    ...(options.includeManualWait === false ? {} : { manualWait }),
    audits: {
      list: vi.fn(() => [...audits]),
      insert: vi.fn((entry: BrowserActionAuditEntry) => { audits.push(entry); return entry }),
    },
    id: (() => { let id = 0; return () => `audit_${++id}` })(),
    now: options.now ?? (() => 1_000),
    isRunActive: options.isRunActive ?? (() => true),
    ...(options.terminalRunLimit === undefined ? {} : { terminalRunLimit: options.terminalRunLimit }),
    ...(options.terminalRunTtlMs === undefined ? {} : { terminalRunTtlMs: options.terminalRunTtlMs }),
  })
  return {
    executor, inspector, workspace, loginWait, manualWait,
    audits, lease, release, assertEligible, state,
  }
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

  it('returns static values only through host-private inspection evidence', async () => {
    const privateSnapshot = snapshot({
      nodes: Object.freeze([
        Object.freeze({
          ref: 'ref_certificate', role: 'statictext', name: '证件编号',
          enabled: true, actions: [] as const,
        }),
      ]),
    })
    const test = harness({ snapshots: [privateSnapshot] })
    test.inspector.fieldEvidence.mockReturnValueOnce(Object.freeze([Object.freeze({
      snapshotId: 'snapshot_1', ref: 'ref_certificate', label: '证件编号', value: '202111127927',
    })]))

    const result = await test.executor.execute('browser_session_inspect', {
      bindingId: 'binding_1', intent: '我的证件号码是多少',
    }, run())

    expect(result).toEqual({
      kind: 'success',
      data: { trust: 'untrusted_page_data', snapshot: privateSnapshot },
      privateFieldEvidence: [{
        snapshotId: 'snapshot_1', ref: 'ref_certificate', label: '证件编号', value: '202111127927',
      }],
    })
    expect(JSON.stringify(result.kind === 'success' ? result.data : {})).not.toContain('202111127927')
  })

  it('captures visual evidence only from the current run snapshot chain', async () => {
    const page = snapshot()
    const evidence = visualBundle(page)
    const test = harness({ snapshots: [page], visualEvidenceBundle: evidence })
    await test.executor.execute('browser_session_inspect', {
      bindingId: 'binding_1', intent: '查看表单',
    }, run())

    await expect(test.executor.captureVisualEvidence({
      bindingId: 'binding_1', snapshotId: 'snapshot_1', pages: [page],
    }, run())).resolves.toEqual({ kind: 'success', data: evidence })
    expect(test.inspector.captureVisualEvidence).toHaveBeenCalledWith(expect.objectContaining({
      lease: expect.objectContaining({ ownerRunId: 'agent_run_1' }),
      tabId: 'tab_1', navigationEpoch: 1,
      origin: 'https://service.example',
      pages: [expect.objectContaining({ snapshotId: 'snapshot_1' })],
    }))
  })

  it('rejects visual evidence capture for an unknown run', async () => {
    const test = harness()

    await expect(test.executor.captureVisualEvidence({
      bindingId: 'binding_1', snapshotId: 'snapshot_1', pages: [snapshot()],
    }, run({ runId: 'agent_run_unknown' }))).resolves.toEqual({ kind: 'tool_error', code: 'CANCELLED' })
    expect(test.inspector.captureVisualEvidence).not.toHaveBeenCalled()
  })

  it('rejects visual evidence capture when the run is no longer active', async () => {
    let active = true
    const page = snapshot()
    const test = harness({ snapshots: [page], isRunActive: () => active })
    await test.executor.execute('browser_session_inspect', {
      bindingId: 'binding_1', intent: '查看表单',
    }, run())
    active = false

    await expect(test.executor.captureVisualEvidence({
      bindingId: 'binding_1', snapshotId: 'snapshot_1', pages: [page],
    }, run())).resolves.toEqual({ kind: 'tool_error', code: 'CANCELLED' })
    expect(test.inspector.captureVisualEvidence).not.toHaveBeenCalled()
  })

  it('rejects visual evidence capture after its lease is no longer current', async () => {
    const page = snapshot()
    const test = harness({ snapshots: [page] })
    await test.executor.execute('browser_session_inspect', {
      bindingId: 'binding_1', intent: '查看表单',
    }, run())
    await test.lease.release()

    await expect(test.executor.captureVisualEvidence({
      bindingId: 'binding_1', snapshotId: 'snapshot_1', pages: [page],
    }, run())).resolves.toEqual({ kind: 'tool_error', code: 'CANCELLED' })
    expect(test.inspector.captureVisualEvidence).not.toHaveBeenCalled()
  })

  it('rejects visual evidence capture with a different binding', async () => {
    const page = snapshot()
    const test = harness({ snapshots: [page] })
    await test.executor.execute('browser_session_inspect', {
      bindingId: 'binding_1', intent: '查看表单',
    }, run())

    await expect(test.executor.captureVisualEvidence({
      bindingId: 'binding_other', snapshotId: 'snapshot_1', pages: [page],
    }, run())).resolves.toEqual({ kind: 'tool_error', code: 'NO_BOUND_PAGE' })
    expect(test.inspector.captureVisualEvidence).not.toHaveBeenCalled()
  })

  it('rejects visual evidence capture without the stored latest snapshot', async () => {
    const page = snapshot()
    const test = harness({ snapshots: [page] })
    await test.executor.execute('browser_session_inspect', {
      bindingId: 'binding_1', intent: '查看表单',
    }, run())

    await expect(test.executor.captureVisualEvidence({
      bindingId: 'binding_1', snapshotId: 'snapshot_unknown', pages: [snapshot({ snapshotId: 'snapshot_unknown' })],
    }, run())).resolves.toEqual({ kind: 'tool_error', code: 'PAGE_CHANGED' })
    expect(test.inspector.captureVisualEvidence).not.toHaveBeenCalled()
  })

  it('rejects visual evidence capture after workspace state changes', async () => {
    const page = snapshot()
    const test = harness({ snapshots: [page] })
    await test.executor.execute('browser_session_inspect', {
      bindingId: 'binding_1', intent: '查看表单',
    }, run())
    test.state.navigationEpoch = 2

    await expect(test.executor.captureVisualEvidence({
      bindingId: 'binding_1', snapshotId: 'snapshot_1', pages: [page],
    }, run())).resolves.toEqual({ kind: 'tool_error', code: 'PAGE_CHANGED' })
    expect(test.inspector.captureVisualEvidence).not.toHaveBeenCalled()
  })

  it('rejects a visual evidence chain whose final page is not the stored snapshot', async () => {
    const page = snapshot()
    const test = harness({ snapshots: [page] })
    await test.executor.execute('browser_session_inspect', {
      bindingId: 'binding_1', intent: '查看表单',
    }, run())

    await expect(test.executor.captureVisualEvidence({
      bindingId: 'binding_1', snapshotId: 'snapshot_1', pages: [{ ...page, title: '篡改标题' }],
    }, run())).resolves.toEqual({ kind: 'tool_error', code: 'PAGE_CHANGED' })
    expect(test.inspector.captureVisualEvidence).not.toHaveBeenCalled()
  })

  it('rejects visual evidence capture for an aborted context', async () => {
    const page = snapshot()
    const test = harness({ snapshots: [page] })
    await test.executor.execute('browser_session_inspect', {
      bindingId: 'binding_1', intent: '查看表单',
    }, run())
    const controller = new AbortController()
    controller.abort()

    await expect(test.executor.captureVisualEvidence({
      bindingId: 'binding_1', snapshotId: 'snapshot_1', pages: [page],
    }, run({ signal: controller.signal }))).resolves.toEqual({ kind: 'tool_error', code: 'CANCELLED' })
    expect(test.inspector.captureVisualEvidence).not.toHaveBeenCalled()
  })

  it('returns a safe tool error when visual evidence capture fails', async () => {
    const page = snapshot()
    const test = harness({ snapshots: [page] })
    test.inspector.captureVisualEvidence.mockRejectedValueOnce({ code: 'INTERNAL_ERROR' })
    await test.executor.execute('browser_session_inspect', {
      bindingId: 'binding_1', intent: '查看表单',
    }, run())

    await expect(test.executor.captureVisualEvidence({
      bindingId: 'binding_1', snapshotId: 'snapshot_1', pages: [page],
    }, run())).resolves.toEqual({ kind: 'tool_error', code: 'INTERNAL_ERROR' })
  })

  it('rechecks development eligibility after a hung inspection before admitting its snapshot', async () => {
    let finishInspection!: (value: BrowserPageSnapshot) => void
    const inspection = new Promise<BrowserPageSnapshot>((resolve) => { finishInspection = resolve })
    const test = harness()
    test.inspector.inspect.mockImplementationOnce(async () => inspection)
    const pending = test.executor.execute('browser_session_inspect', {
      bindingId: 'binding_1', intent: '读取表单',
    }, run())
    await vi.waitFor(() => expect(test.inspector.inspect).toHaveBeenCalledOnce())
    vi.mocked(test.lease.assertEligible).mockRejectedValueOnce({ code: 'WORKFLOW_CHANGED' })

    finishInspection(snapshot())

    await expect(pending).resolves.toEqual({ kind: 'tool_error', code: 'WORKFLOW_CHANGED' })
    expect(test.executor['runs'].has('agent_run_1')).toBe(false)
    expect(test.release).toHaveBeenCalledOnce()
  })

  it('rechecks development eligibility immediately before mutation after a hung action lookup', async () => {
    const test = harness()
    await test.executor.execute('browser_session_inspect', {
      bindingId: 'binding_1', intent: '保存草稿',
    }, run())
    let finishResolve!: (value: BrowserResolvedElementReference) => void
    const targetLookup = new Promise<BrowserResolvedElementReference>((resolve) => {
      finishResolve = resolve
    })
    test.inspector.resolveRef.mockImplementationOnce(async () => targetLookup)
    const pending = test.executor.execute('browser_session_act', {
      bindingId: 'binding_1', snapshotId: 'snapshot_1',
      actions: [{ type: 'click', ref: 'ref_save' }],
    }, run())
    await vi.waitFor(() => expect(test.inspector.resolveRef).toHaveBeenCalledOnce())
    vi.mocked(test.lease.assertEligible).mockRejectedValue({ code: 'WORKFLOW_CHANGED' })

    finishResolve({
      snapshotId: 'snapshot_1', ref: 'ref_save', backendNodeId: 10,
      role: 'button', name: '保存草稿', auth: 'authenticated',
      semanticFingerprint: 'before-rebuild', targetContext: {},
    })

    await expect(pending).resolves.toEqual({ kind: 'tool_error', code: 'WORKFLOW_CHANGED' })
    expect(test.workspace.performContinuationAction).not.toHaveBeenCalled()
    expect(test.executor['runs'].has('agent_run_1')).toBe(false)
    expect(test.release).toHaveBeenCalledOnce()
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
    expect(test.workspace.suspendContinuation).toHaveBeenCalledWith('tab_1', 'agent_run_1')
    expect(test.release).not.toHaveBeenCalled()
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

  it.each(['TARGET_AMBIGUOUS', 'AUTH_STATE_UNKNOWN'] as const)(
    'normalizes an owned live-page inspection failure %s to resumable manual intervention',
    async (code) => {
      const test = harness()
      test.inspector.inspect.mockRejectedValueOnce({ code })

      await expect(test.executor.execute('browser_session_inspect', {
        bindingId: 'binding_1', intent: '读取页面',
      }, run())).resolves.toEqual({ kind: 'handoff', code: 'MANUAL_INTERVENTION_REQUIRED' })

      expect(test.workspace.suspendContinuation).toHaveBeenCalledWith('tab_1', 'agent_run_1')
      expect(test.release).not.toHaveBeenCalled()
    },
  )

  it.each(['TARGET_AMBIGUOUS', 'AUTH_STATE_UNKNOWN'] as const)(
    'normalizes an owned live-page action failure %s to resumable manual intervention',
    async (code) => {
      const test = harness()
      await test.executor.execute('browser_session_inspect', {
        bindingId: 'binding_1', intent: '保存',
      }, run())
      test.workspace.performContinuationAction.mockRejectedValueOnce({ code })

      await expect(test.executor.execute('browser_session_act', {
        bindingId: 'binding_1', snapshotId: 'snapshot_1',
        actions: [{ type: 'click', ref: 'ref_save' }],
      }, run())).resolves.toEqual({ kind: 'handoff', code: 'MANUAL_INTERVENTION_REQUIRED' })

      expect(test.workspace.suspendContinuation).toHaveBeenCalledWith('tab_1', 'agent_run_1')
      expect(test.release).not.toHaveBeenCalled()
    },
  )

  it.each(['TARGET_AMBIGUOUS', 'AUTH_STATE_UNKNOWN'] as const)(
    'keeps a policy-external navigate terminal when pre-action inspection fails with %s',
    async (code) => {
      const test = harness()
      const context = run({
        currentUser: { messageId: 'message_current', text: '请打开 https://outside.example/landing' },
      })
      await test.executor.execute('browser_session_inspect', {
        bindingId: 'binding_1', intent: '打开链接',
      }, context)
      test.inspector.currentPageContext.mockRejectedValueOnce({ code })

      await expect(test.executor.execute('browser_session_act', {
        bindingId: 'binding_1', snapshotId: 'snapshot_1', actions: [{
          type: 'navigate', url: 'https://outside.example/landing', source: { kind: 'current_user' },
        }],
      }, context)).resolves.toEqual({ kind: 'tool_error', code: 'DOMAIN_BLOCKED' })

      expect(test.workspace.suspendContinuation).not.toHaveBeenCalled()
      expect(test.release).toHaveBeenCalledOnce()
    },
  )

  it('keeps a normalizable blocker terminal after continuation eligibility is lost', async () => {
    const test = harness()
    await test.executor.execute('browser_session_inspect', {
      bindingId: 'binding_1', intent: '保存',
    }, run())
    test.assertEligible.mockClear()
    test.assertEligible
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce({ code: 'WORKFLOW_CHANGED' })
    test.inspector.currentPageContext.mockRejectedValueOnce({ code: 'TARGET_AMBIGUOUS' })

    await expect(test.executor.execute('browser_session_act', {
      bindingId: 'binding_1', snapshotId: 'snapshot_1',
      actions: [{ type: 'click', ref: 'ref_save' }],
    }, run())).resolves.toEqual({ kind: 'tool_error', code: 'WORKFLOW_CHANGED' })

    expect(test.workspace.suspendContinuation).not.toHaveBeenCalled()
    expect(test.release).toHaveBeenCalledOnce()
  })

  it('keeps a normalizable blocker terminal after the live page leaves policy', async () => {
    const test = harness()
    await test.executor.execute('browser_session_inspect', {
      bindingId: 'binding_1', intent: '保存',
    }, run())
    test.workspace.performContinuationAction.mockImplementationOnce(async () => {
      test.state.origin = 'https://outside.example'
      test.state.url = 'https://outside.example/landing'
      throw { code: 'AUTH_STATE_UNKNOWN' }
    })

    await expect(test.executor.execute('browser_session_act', {
      bindingId: 'binding_1', snapshotId: 'snapshot_1',
      actions: [{ type: 'click', ref: 'ref_save' }],
    }, run())).resolves.toEqual({ kind: 'tool_error', code: 'DOMAIN_BLOCKED' })

    expect(test.workspace.suspendContinuation).not.toHaveBeenCalled()
    expect(test.release).toHaveBeenCalledOnce()
  })

  it.each(['PAGE_CLOSED', 'INTERNAL_ERROR'] as const)(
    'keeps the terminal live-page failure %s terminal',
    async (code) => {
      const test = harness()
      await test.executor.execute('browser_session_inspect', {
        bindingId: 'binding_1', intent: '保存',
      }, run())
      test.inspector.currentPageContext.mockRejectedValueOnce({ code })

      await expect(test.executor.execute('browser_session_act', {
        bindingId: 'binding_1', snapshotId: 'snapshot_1',
        actions: [{ type: 'click', ref: 'ref_save' }],
      }, run())).resolves.toEqual({ kind: 'tool_error', code })

      expect(test.workspace.suspendContinuation).not.toHaveBeenCalled()
      expect(test.release).toHaveBeenCalledOnce()
    },
  )

  it('suspends for authentication, resumes automatically, and excludes login wait from the active limit', async () => {
    let now = 0
    const test = harness({ now: () => now })
    await test.executor.execute('browser_session_inspect', {
      bindingId: 'binding_1', intent: '读取工作居住证有效期',
    }, run())

    await expect(test.executor.execute('browser_session_handoff', {
      bindingId: 'binding_1', reason: 'login',
    }, run())).resolves.toEqual({ kind: 'handoff', code: 'AUTH_REQUIRED' })

    expect(test.workspace.suspendContinuation).toHaveBeenCalledWith('tab_1', 'agent_run_1')
    expect(test.release).not.toHaveBeenCalled()
    expect(test.lease.isCurrent(test.lease.binding)).toBe(true)
    now = 600_000

    await expect(test.executor.waitForAuthentication('agent_run_1', run()))
      .resolves.toEqual({ kind: 'authenticated' })

    expect(test.loginWait.wait).toHaveBeenCalledOnce()
    expect(test.workspace.resumeContinuation).toHaveBeenCalledWith('tab_1', 'agent_run_1', {
      origin: 'https://service.example', url: 'https://service.example/form',
      navigationEpoch: 1, activityRevision: 0,
    })
    now = 600_001
    await expect(test.executor.execute('browser_session_inspect', {
      bindingId: 'binding_1', intent: '读取工作居住证有效期',
    }, run())).resolves.toMatchObject({ kind: 'success' })
  })

  it.each([
    ['manual_action', 'MANUAL_ACTION_REQUIRED'],
    ['unsupported_control', 'UNSUPPORTED_CONTROL'],
  ] as const)('suspends an explicit %s handoff without releasing authority', async (reason, code) => {
    const test = harness()

    await expect(test.executor.execute('browser_session_handoff', {
      bindingId: 'binding_1', reason,
    }, run())).resolves.toEqual({ kind: 'handoff', code })

    expect(test.workspace.suspendContinuation).toHaveBeenCalledWith('tab_1', 'agent_run_1')
    expect(test.release).not.toHaveBeenCalled()
    expect(test.lease.isCurrent(test.lease.binding)).toBe(true)
  })

  it('resumes manual intervention from the exact activity-aware page and excludes the wait from the limit', async () => {
    let now = 0
    const test = harness({ now: () => now })
    test.state.activityRevision = 7
    await test.executor.execute('browser_session_handoff', {
      bindingId: 'binding_1', reason: 'manual_action',
    }, run())
    now = 600_000

    await expect(test.executor.waitForManualIntervention('agent_run_1', run()))
      .resolves.toEqual({ kind: 'resumed' })

    expect(test.manualWait.wait).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'agent_run_1', tabId: 'tab_1', baselineActivityRevision: 7,
    }))
    expect(test.workspace.resumeContinuation).toHaveBeenCalledWith('tab_1', 'agent_run_1', {
      origin: 'https://service.example', url: 'https://service.example/form',
      navigationEpoch: 1, activityRevision: 7,
    })
    expect(test.release).not.toHaveBeenCalled()
    now = 600_001
    await expect(test.executor.execute('browser_session_inspect', {
      bindingId: 'binding_1', intent: '继续读取',
    }, run())).resolves.toMatchObject({ kind: 'success' })
  })

  it('validates live continuation authority without taking a fresh browser snapshot', async () => {
    const test = harness()
    await test.executor.execute('browser_session_inspect', {
      bindingId: 'binding_1', intent: '读取工作居住证有效期',
    }, run())
    const inspections = test.inspector.inspect.mock.calls.length
    const result = await test.executor.validateContinuation('agent_run_1', run())

    expect(result).toEqual({ kind: 'valid' })
    expect(test.inspector.inspect).toHaveBeenCalledTimes(inspections)
  })

  it.each(['PAGE_CLOSED', 'WORKFLOW_CHANGED'] as const)(
    'preserves %s while validating continuation authority',
    async (code) => {
      const test = harness()
      await test.executor.execute('browser_session_inspect', {
        bindingId: 'binding_1', intent: '读取工作居住证有效期',
      }, run())
      test.assertEligible.mockRejectedValueOnce({ code })
      const result = await test.executor.validateContinuation('agent_run_1', run())

      expect(result).toEqual({ kind: 'tool_error', code })
    },
  )

  it.each(['PAGE_CLOSED', 'WORKFLOW_CHANGED'] as const)(
    'revalidates %s after a pending continuation-state read',
    async (code) => {
      const test = harness()
      await test.executor.execute('browser_session_inspect', {
        bindingId: 'binding_1', intent: '读取工作居住证有效期',
      }, run())
      let stateReadStarted!: () => void
      let finishStateRead!: () => void
      const started = new Promise<void>((resolve) => { stateReadStarted = resolve })
      const stateRead = new Promise<void>((resolve) => { finishStateRead = resolve })
      test.workspace.getContinuationState.mockImplementationOnce(async () => {
        stateReadStarted()
        await stateRead
        return { ...test.state }
      })
      test.assertEligible.mockClear()
      test.assertEligible
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce({ code })

      const validating = test.executor.validateContinuation('agent_run_1', run())
      await started
      finishStateRead()

      await expect(validating).resolves.toEqual({ kind: 'tool_error', code })
      expect(test.assertEligible).toHaveBeenCalledTimes(2)
    },
  )

  it('returns CANCELLED when the run signal aborts during a continuation-state read', async () => {
    const test = harness()
    const controller = new AbortController()
    const context = run({ signal: controller.signal })
    await test.executor.execute('browser_session_inspect', {
      bindingId: 'binding_1', intent: '读取工作居住证有效期',
    }, context)
    let stateReadStarted!: () => void
    let finishStateRead!: () => void
    const started = new Promise<void>((resolve) => { stateReadStarted = resolve })
    const stateRead = new Promise<void>((resolve) => { finishStateRead = resolve })
    test.workspace.getContinuationState.mockImplementationOnce(async () => {
      stateReadStarted()
      await stateRead
      return { ...test.state }
    })
    test.assertEligible.mockClear()

    const validating = test.executor.validateContinuation('agent_run_1', context)
    await started
    controller.abort()
    finishStateRead()

    await expect(validating).resolves.toEqual({ kind: 'tool_error', code: 'CANCELLED' })
    expect(test.assertEligible).toHaveBeenCalledTimes(2)
    expect(test.release).toHaveBeenCalledOnce()
  })

  it('terminates manual suspension when the user navigates outside binding policy', async () => {
    const test = harness()
    await test.executor.execute('browser_session_handoff', {
      bindingId: 'binding_1', reason: 'manual_action',
    }, run())
    test.state.origin = 'https://outside.example'
    test.state.url = 'https://outside.example/landing'
    test.state.navigationEpoch = 2
    test.state.activityRevision = 1

    await expect(test.executor.waitForManualIntervention('agent_run_1', run()))
      .resolves.toEqual({ kind: 'tool_error', code: 'DOMAIN_BLOCKED' })

    expect(test.workspace.resumeContinuation).not.toHaveBeenCalled()
    expect(test.release).toHaveBeenCalledOnce()
  })

  it('lets the manual coordinator retry PAGE_CHANGED promotion without terminating authority', async () => {
    const test = harness()
    await test.executor.execute('browser_session_handoff', {
      bindingId: 'binding_1', reason: 'manual_action',
    }, run())
    test.workspace.resumeContinuation.mockRejectedValueOnce({ code: 'PAGE_CHANGED' })
    test.manualWait.wait.mockImplementationOnce(async (input) => {
      await expect(input.promote()).rejects.toMatchObject({ code: 'PAGE_CHANGED' })
      test.state.url = 'https://service.example/after-manual'
      test.state.navigationEpoch = 2
      test.state.activityRevision = 3
      await input.promote()
    })

    await expect(test.executor.waitForManualIntervention('agent_run_1', run()))
      .resolves.toEqual({ kind: 'resumed' })

    expect(test.manualWait.wait).toHaveBeenCalledOnce()
    expect(test.workspace.resumeContinuation).toHaveBeenCalledTimes(2)
    expect(test.workspace.resumeContinuation).toHaveBeenLastCalledWith('tab_1', 'agent_run_1', {
      origin: 'https://service.example', url: 'https://service.example/after-manual',
      navigationEpoch: 2, activityRevision: 3,
    })
    expect(test.release).not.toHaveBeenCalled()
  })

  it('requires a fresh wait after every manual handoff', async () => {
    const test = harness()
    await test.executor.execute('browser_session_handoff', {
      bindingId: 'binding_1', reason: 'manual_action',
    }, run())
    await expect(test.executor.waitForManualIntervention('agent_run_1', run()))
      .resolves.toEqual({ kind: 'resumed' })
    await expect(test.executor.waitForManualIntervention('agent_run_1', run()))
      .resolves.toEqual({ kind: 'tool_error', code: 'CANCELLED' })

    test.state.activityRevision = 2
    await test.executor.execute('browser_session_handoff', {
      bindingId: 'binding_1', reason: 'manual_action',
    }, run())
    await expect(test.executor.waitForManualIntervention('agent_run_1', run()))
      .resolves.toEqual({ kind: 'resumed' })

    expect(test.manualWait.wait).toHaveBeenCalledTimes(2)
    expect(test.manualWait.wait.mock.calls.map(([input]) => input.baselineActivityRevision))
      .toEqual([0, 2])
  })

  it.each(['endRun', 'cancel'] as const)(
    '%s cancels login and manual coordinators exactly once',
    async (method) => {
      const test = harness()
      await test.executor.execute('browser_session_handoff', {
        bindingId: 'binding_1', reason: 'manual_action',
      }, run())

      await test.executor[method]('agent_run_1')

      expect(test.loginWait.cancel).toHaveBeenCalledOnce()
      expect(test.manualWait.cancel).toHaveBeenCalledOnce()
      expect(test.release).toHaveBeenCalledOnce()
    },
  )

  it('terminates manual suspension when the coordinator reports a terminal failure', async () => {
    const test = harness({ waitForManual: async () => { throw { code: 'PAGE_CLOSED' } } })
    await test.executor.execute('browser_session_handoff', {
      bindingId: 'binding_1', reason: 'manual_action',
    }, run())

    await expect(test.executor.waitForManualIntervention('agent_run_1', run()))
      .resolves.toEqual({ kind: 'tool_error', code: 'PAGE_CLOSED' })

    expect(test.loginWait.cancel).toHaveBeenCalledOnce()
    expect(test.manualWait.cancel).toHaveBeenCalledOnce()
    expect(test.release).toHaveBeenCalledOnce()
  })

  it('fails closed and terminates when the incremental manual coordinator dependency is absent', async () => {
    const test = harness({ includeManualWait: false })
    await test.executor.execute('browser_session_handoff', {
      bindingId: 'binding_1', reason: 'manual_action',
    }, run())

    await expect(test.executor.waitForManualIntervention('agent_run_1', run()))
      .resolves.toEqual({ kind: 'tool_error', code: 'INTERNAL_ERROR' })

    expect(test.release).toHaveBeenCalledOnce()
    expect(test.executor['runs'].has('agent_run_1')).toBe(false)
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

  it('keeps waiting when the page redirects after an authenticated probe but before resume', async () => {
    const test = harness()
    await test.executor.execute('browser_session_inspect', {
      bindingId: 'binding_1', intent: '读取工作居住证有效期',
    }, run())
    await test.executor.execute('browser_session_handoff', {
      bindingId: 'binding_1', reason: 'login',
    }, run())
    test.assertEligible.mockClear()
    let eligibilityChecks = 0
    test.assertEligible.mockImplementation(async () => {
      eligibilityChecks += 1
      if (eligibilityChecks === 2) {
        test.state.url = 'https://service.example/callback'
        test.state.navigationEpoch = 2
      }
    })
    test.workspace.resumeContinuation.mockImplementation(async (_tabId, _runId, expected) => {
      if (!expected
        || expected.origin !== test.state.origin
        || expected.navigationEpoch !== test.state.navigationEpoch) throw { code: 'PAGE_CHANGED' }
    })

    await expect(test.executor.waitForAuthentication('agent_run_1', run()))
      .resolves.toEqual({ kind: 'authenticated' })

    expect(test.loginWait.wait).toHaveBeenCalledTimes(2)
    expect(test.workspace.resumeContinuation).toHaveBeenCalledTimes(2)
    expect(test.workspace.resumeContinuation).toHaveBeenLastCalledWith('tab_1', 'agent_run_1', {
      origin: 'https://service.example', url: 'https://service.example/callback',
      navigationEpoch: 2, activityRevision: 0,
    })
    expect(test.release).not.toHaveBeenCalled()
  })

  it('resumes from a stable post-login page without a configured logged-in marker', async () => {
    const test = harness()
    test.state.url = 'https://service.example/login'
    await test.executor.execute('browser_session_inspect', {
      bindingId: 'binding_1', intent: '读取工作居住证有效期',
    }, run())
    await test.executor.execute('browser_session_handoff', {
      bindingId: 'binding_1', reason: 'login',
    }, run())
    test.inspector.currentPageContext
      .mockResolvedValueOnce({ auth: 'required', semanticFingerprint: 'login' })
      .mockResolvedValueOnce({ auth: 'unknown', semanticFingerprint: 'dashboard' })
      .mockResolvedValueOnce({ auth: 'unknown', semanticFingerprint: 'dashboard' })
    test.loginWait.wait.mockImplementationOnce(async (input) => {
      expect(await input.probe()).toBe('required')
      test.state.url = 'https://service.example/dashboard'
      test.state.navigationEpoch = 2
      expect(await input.probe()).toBe('unknown')
      if (await input.probe() !== 'authenticated') throw { code: 'AUTH_REQUIRED' }
    })

    await expect(test.executor.waitForAuthentication('agent_run_1', run()))
      .resolves.toEqual({ kind: 'authenticated' })

    expect(test.workspace.resumeContinuation).toHaveBeenCalledWith('tab_1', 'agent_run_1', {
      origin: 'https://service.example',
      url: 'https://service.example/dashboard',
      navigationEpoch: 2,
      activityRevision: 0,
    })
    expect(test.release).not.toHaveBeenCalled()
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

  it.each([
    { name: 'wait', action: { type: 'wait', milliseconds: 50 } },
    { name: 'focus', action: { type: 'focus' } },
    { name: 'page scroll', action: { type: 'scroll', direction: 'down' } },
  ] as const)('continues a snapshot-independent $name after the page navigates', async ({ action }) => {
    const test = harness()
    await test.executor.execute(
      'browser_session_inspect',
      { bindingId: 'binding_1', intent: '读取证件编号' },
      run(),
    )
    test.state.origin = 'https://details.example'
    test.state.url = 'https://details.example/certificate'
    test.state.navigationEpoch = 2

    await expect(test.executor.execute('browser_session_act', {
      bindingId: 'binding_1',
      snapshotId: 'snapshot_1',
      actions: [action],
    }, run())).resolves.toEqual({ kind: 'success', data: { completedActions: 1 } })

    expect(test.workspace.performContinuationAction).toHaveBeenCalledWith({
      tabId: 'tab_1',
      runId: 'agent_run_1',
      expectedOrigin: 'https://details.example',
      expectedNavigationEpoch: 2,
      backendNodeId: 0,
      action,
    })
    expect(test.audits.at(-1)).toMatchObject({
      action: action.type,
      origin: 'https://details.example',
      outcome: 'completed',
    })
    expect(test.release).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'click', action: { type: 'click', ref: 'ref_save' } },
    {
      name: 'fill',
      action: { type: 'fill', ref: 'ref_name', value: '李四', source: { kind: 'current_user' } },
    },
    { name: 'targeted scroll', action: { type: 'scroll', ref: 'ref_save', direction: 'down' } },
  ] as const)('still rejects a snapshot-dependent $name after the page navigates', async ({ action }) => {
    const test = harness()
    await test.executor.execute(
      'browser_session_inspect',
      { bindingId: 'binding_1', intent: '保存' },
      run(),
    )
    test.state.origin = 'https://details.example'
    test.state.url = 'https://details.example/certificate'
    test.state.navigationEpoch = 2

    await expect(test.executor.execute('browser_session_act', {
      bindingId: 'binding_1',
      snapshotId: 'snapshot_1',
      actions: [action],
    }, run())).resolves.toEqual({ kind: 'tool_error', code: 'PAGE_CHANGED' })

    expect(test.workspace.performContinuationAction).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'wait', action: { type: 'wait', milliseconds: 50 } },
    { name: 'focus', action: { type: 'focus' } },
    { name: 'page scroll', action: { type: 'scroll', direction: 'down' } },
  ] as const)('blocks a snapshot-independent $name after a redirect to an unauthorized origin', async ({ action }) => {
    const test = harness()
    await test.executor.execute(
      'browser_session_inspect',
      { bindingId: 'binding_1', intent: '读取证件编号' },
      run(),
    )
    test.state.origin = 'https://outside.example'
    test.state.url = 'https://outside.example/certificate'
    test.state.navigationEpoch = 2

    await expect(test.executor.execute('browser_session_act', {
      bindingId: 'binding_1',
      snapshotId: 'snapshot_1',
      actions: [action],
    }, run())).resolves.toEqual({ kind: 'tool_error', code: 'DOMAIN_BLOCKED' })

    expect(test.workspace.performContinuationAction).not.toHaveBeenCalled()
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

  it('terminally rejects a same-run retry after a dispatched action fails', async () => {
    const test = harness()
    await test.executor.execute('browser_session_inspect', { bindingId: 'binding_1', intent: '保存' }, run())
    test.workspace.performContinuationAction.mockRejectedValueOnce({ code: 'PAGE_CHANGED' })

    await expect(test.executor.execute('browser_session_act', {
      bindingId: 'binding_1', snapshotId: 'snapshot_1', actions: [{ type: 'click', ref: 'ref_save' }],
    }, run())).resolves.toEqual({ kind: 'tool_error', code: 'PAGE_CHANGED' })
    expect(test.workspace.performContinuationAction).toHaveBeenCalledOnce()
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
    { phase: 'suspend', code: 'PAGE_BUSY' as const },
  ])('records exactly one failed explicit handoff audit when $phase fails', async ({ phase, code }) => {
    const test = harness()
    await test.executor.execute('browser_session_inspect', { bindingId: 'binding_1', intent: '提交' }, run())
    if (phase === 'resolve') test.inspector.resolveRef.mockRejectedValueOnce({ code })
    if (phase === 'focus') test.workspace.focusContinuation.mockRejectedValueOnce({ code })
    if (phase === 'highlight') test.workspace.highlightContinuationTarget.mockRejectedValueOnce({ code })
    if (phase === 'suspend') test.workspace.suspendContinuation.mockRejectedValueOnce({ code })

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

  it('continues beyond 30 actions without resetting the run action count across batches', async () => {
    const test = harness()
    await test.executor.execute('browser_session_inspect', { bindingId: 'binding_1', intent: '检查' }, run())
    for (let batch = 0; batch < 15; batch += 1) {
      await expect(test.executor.execute('browser_session_act', {
        bindingId: 'binding_1', snapshotId: 'snapshot_1',
        actions: Array.from({ length: 2 }, (_, index) => ({ type: 'wait', milliseconds: 50 + batch * 2 + index })),
      }, run())).resolves.toEqual({ kind: 'success', data: { completedActions: 2 } })
    }
    await expect(test.executor.execute('browser_session_act', {
      bindingId: 'binding_1', snapshotId: 'snapshot_1', actions: [{ type: 'focus' }],
    }, run())).resolves.toEqual({ kind: 'success', data: { completedActions: 1 } })
    expect(test.workspace.performContinuationAction).toHaveBeenCalledTimes(31)
  })

  it('allows repeated unchanged inspections until the user or run lifecycle stops them', async () => {
    const test = harness({ snapshots: Array.from({ length: 4 }, (_, index) => snapshot({
      snapshotId: `snapshot_${index + 1}`,
    })) })

    for (let index = 0; index < 4; index += 1) {
      await expect(test.executor.execute('browser_session_inspect', {
        bindingId: 'binding_1', intent: '检查',
      }, run())).resolves.toMatchObject({ kind: 'success' })
    }

    expect(test.inspector.endRun).not.toHaveBeenCalled()
  })

  it('ends authority after five active minutes', async () => {
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

  it.each(['endRun', 'cancel', 'takeOver'] as const)(
    'propagates %s lease-release failure while retaining retryable authority state',
    async (method) => {
      const test = harness()
      await test.executor.execute('browser_session_inspect', {
        bindingId: 'binding_1', intent: '检查',
      }, run())
      test.release.mockRejectedValueOnce(new Error('release failed'))

      await expect(test.executor[method]('agent_run_1')).rejects.toThrow('release failed')
      expect(test.executor['runs'].has('agent_run_1')).toBe(true)
      expect(test.lease.isCurrent(test.lease.binding)).toBe(true)

      await expect(test.executor[method]('agent_run_1')).resolves.toBeUndefined()
      expect(test.release).toHaveBeenCalledTimes(2)
      expect(test.executor['runs'].has('agent_run_1')).toBe(false)
    },
  )

  it.each(['eviction', 'expiry'] as const)(
    'rejects a valid late inspect through Main run admission after tombstone %s without reacquiring',
    async (mode) => {
      let now = 1_000
      const activeRuns = new Set<string>()
      const test = harness({
        now: () => now,
        terminalRunLimit: 1,
        terminalRunTtlMs: 10,
        isRunActive: (runId) => activeRuns.has(runId),
      })
      await test.executor.endRun('ended_run')
      if (mode === 'eviction') await test.executor.endRun('newer_run')
      else now = 1_011

      await expect(test.executor.execute('browser_session_inspect', {
        bindingId: 'binding_1', intent: 'late inspect',
      }, run({ runId: 'ended_run' }))).resolves.toEqual({ kind: 'tool_error', code: 'CANCELLED' })
      expect(test.executor['dependencies'].registry.acquire).not.toHaveBeenCalled()
      expect(test.executor['runs'].has('ended_run')).toBe(false)
    },
  )

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
