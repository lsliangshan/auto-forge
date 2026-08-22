import { randomUUID } from 'node:crypto'
import {
  matchesHttpsUrlPattern,
  matchesHttpsUrlPatternOrigin,
  toSafeAppError,
  type AppError,
  type AppErrorCode,
} from '@autoforge/shared'
import { z } from 'zod'
import type {
  BrowserActionAuditEntry,
} from '../database/repositories.js'
import {
  BrowserActionGuard,
  requiredCapability,
  type BrowserActionDecision,
} from '../browser/browser-action-guard.js'
import type {
  BrowserPageInspector,
  BrowserResolvedElementReference,
} from '../browser/browser-page-inspector.js'
import type { BrowserContinuationRegistry } from '../browser/browser-continuation-registry.js'
import type {
  BrowserAction,
  BrowserContinuationLease,
  BrowserContinuationPageState,
  BrowserContinuationResolvedTargetInput,
  BrowserPageSnapshot,
  BrowserRegionImage,
  BrowserSemanticNode,
  BrowserValueSource,
} from '../browser/browser-continuation-types.js'
import { classifyBrowserActionRisk } from './capability-risk.js'

const identifier = z.string().trim().min(1).max(128)
const boundedText = z.string().max(2_000)
const ref = z.string().trim().min(1).max(128)
const httpsUrl = z.string().trim().min(1).max(2_048).superRefine((value, context) => {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) {
      context.addIssue({ code: 'custom', message: 'A safe HTTPS URL is required' })
    }
  } catch {
    context.addIssue({ code: 'custom', message: 'A safe HTTPS URL is required' })
  }
})

const valueSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('current_user') }).strict(),
  z.object({ kind: z.literal('history'), messageId: identifier }).strict(),
  z.object({ kind: z.literal('page'), snapshotId: identifier, ref }).strict(),
])

const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('fill'), ref, value: boundedText, source: valueSourceSchema }).strict(),
  z.object({ type: z.literal('select'), ref, value: boundedText, source: valueSourceSchema }).strict(),
  z.object({ type: z.literal('click'), ref }).strict(),
  z.object({ type: z.literal('check'), ref, checked: z.boolean(), source: valueSourceSchema }).strict(),
  z.object({ type: z.literal('navigate'), url: httpsUrl }).strict(),
  z.object({ type: z.literal('scroll'), ref: ref.optional(), direction: z.enum(['up', 'down']) }).strict(),
  z.object({ type: z.literal('wait'), milliseconds: z.number().int().min(50).max(2_000) }).strict(),
  z.object({ type: z.literal('focus') }).strict(),
])

export const browserSessionInspectInputSchema = z.object({
  bindingId: identifier,
  intent: z.string().trim().min(1).max(500),
  mode: z.enum(['semantic', 'region_image']).optional(),
  ref: ref.optional(),
  cursor: identifier.optional(),
}).strict()

export const browserSessionActInputSchema = z.object({
  bindingId: identifier,
  snapshotId: identifier,
  actions: z.array(actionSchema).min(1).max(10),
}).strict()

export const browserSessionHandoffInputSchema = z.object({
  bindingId: identifier,
  reason: z.enum(['login', 'manual_action', 'unsupported_control']),
  ref: ref.optional(),
}).strict()

export type BrowserContinuationToolName =
  | 'browser_session_inspect'
  | 'browser_session_act'
  | 'browser_session_handoff'

export interface BrowserContinuationRunContext {
  readonly userId: string
  readonly conversationId: string
  readonly runId: string
  readonly currentUser: { readonly messageId: string; readonly text: string }
  readonly referencedHistory: readonly { readonly messageId: string; readonly text: string }[]
  readonly signal?: AbortSignal
}

export interface BrowserContinuationWorkspacePort {
  getContinuationState(tabId: string, runId: string): Promise<BrowserContinuationPageState>
  performContinuationAction(input: BrowserContinuationResolvedTargetInput & {
    readonly tabId: string
    readonly action: BrowserAction
  }): Promise<void>
  focusContinuation(tabId: string): Promise<void>
  highlightContinuationTarget(
    tabId: string,
    ref: string,
    target: BrowserContinuationResolvedTargetInput,
  ): Promise<void>
  clearContinuationHighlight(tabId: string): Promise<void>
}

interface BrowserActionAuditRepository {
  list(bindingId: string): BrowserActionAuditEntry[]
  insert(value: BrowserActionAuditEntry): BrowserActionAuditEntry
}

interface BrowserContinuationToolExecutorDependencies {
  readonly registry: Pick<BrowserContinuationRegistry, 'acquire'>
  readonly inspector: Pick<BrowserPageInspector, 'inspect' | 'resolveRef' | 'endRun'>
  readonly workspace: BrowserContinuationWorkspacePort
  readonly audits: BrowserActionAuditRepository
  readonly guard?: BrowserActionGuard
  readonly id?: () => string
  readonly now?: () => number
}

interface ActiveRunState {
  readonly runId: string
  readonly bindingId: string
  readonly startedAt: number
  lease?: BrowserContinuationLease
  actionCount: number
  noProgressCount: number
  lastProgressSignature?: string
  repeatedActionCount: number
  lastActionSignature?: string
  nextAuditSequence?: number
  readonly snapshots: Map<string, BrowserPageSnapshot>
}

export type BrowserContinuationToolResult =
  | { readonly kind: 'success'; readonly data: Readonly<Record<string, unknown>> }
  | { readonly kind: 'handoff'; readonly code: 'AUTH_REQUIRED' | 'MANUAL_ACTION_REQUIRED' | 'UNSUPPORTED_CONTROL' }
  | { readonly kind: 'tool_error'; readonly code: AppErrorCode }

function failure(code: AppErrorCode): AppError {
  return toSafeAppError({ code })
}

function isPageSnapshot(value: BrowserPageSnapshot | BrowserRegionImage): value is BrowserPageSnapshot {
  return 'nodes' in value
}

function pageSignature(value: BrowserPageSnapshot | BrowserRegionImage): string {
  if (!isPageSnapshot(value)) return JSON.stringify({
    kind: 'region_image', origin: value.origin, ref: value.ref, width: value.width, height: value.height,
  })
  return JSON.stringify({
    origin: value.origin,
    auth: value.auth,
    nodes: value.nodes.map((node) => ({
      role: node.role, name: node.name, value: node.value, enabled: node.enabled,
      checked: node.checked, selected: node.selected, actions: node.actions,
    })),
    cursor: Boolean(value.cursor),
  })
}

function actionSignature(action: BrowserAction): string {
  switch (action.type) {
    case 'fill':
    case 'select':
      return `${action.type}:${action.ref}:${action.value}`
    case 'check':
      return `${action.type}:${action.ref}:${action.checked}`
    case 'click':
      return `${action.type}:${action.ref}`
    case 'navigate': {
      const url = new URL(action.url)
      return `${action.type}:${url.origin}${url.pathname}`
    }
    case 'scroll':
      return `${action.type}:${action.ref ?? 'page'}:${action.direction}`
    case 'wait':
      return `${action.type}:${action.milliseconds}`
    case 'focus':
      return action.type
  }
}

function trimmedText(value: string): string {
  return value.trim()
}

function normalizedIsoDates(value: string): readonly string[] {
  const dates: string[] = []
  const pattern = /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?/gu
  for (const match of value.matchAll(pattern)) {
    const month = Number(match[2])
    const day = Number(match[3])
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      dates.push(`${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`)
    }
  }
  return dates
}

function textSupportsValue(requested: string, evidence: string): boolean {
  const candidate = trimmedText(requested)
  const source = trimmedText(evidence)
  if (!candidate) return false
  return source.includes(candidate)
    || (/^\d{4}-\d{2}-\d{2}$/u.test(candidate) && normalizedIsoDates(source).includes(candidate))
}

function textSupportsBoolean(requested: boolean, evidence: string): boolean {
  const normalized = trimmedText(evidence).toLowerCase()
  return requested
    ? /(?:^|[\s：:，,。；;])(是|同意|勾选|选中|true|yes)(?:$|[\s，,。；;])/iu.test(normalized)
      || /勾选.{0,40}同意/iu.test(normalized)
    : /(?:^|[\s：:，,。；;])(否|不同意|取消勾选|不选中|false|no)(?:$|[\s，,。；;])/iu.test(normalized)
}

function targetSummary(target: BrowserSemanticNode | undefined): string {
  return target ? `${target.role.slice(0, 80)} control` : 'page'
}

export class BrowserContinuationToolExecutor {
  private readonly guard: BrowserActionGuard
  private readonly id: () => string
  private readonly now: () => number
  private readonly runs = new Map<string, ActiveRunState>()
  private readonly terminalRuns = new Set<string>()

  constructor(private readonly dependencies: BrowserContinuationToolExecutorDependencies) {
    this.guard = dependencies.guard ?? new BrowserActionGuard()
    this.id = dependencies.id ?? randomUUID
    this.now = dependencies.now ?? Date.now
  }

  async execute(
    tool: BrowserContinuationToolName,
    rawInput: unknown,
    context: BrowserContinuationRunContext,
  ): Promise<BrowserContinuationToolResult> {
    if (this.terminalRuns.has(context.runId)) return { kind: 'tool_error', code: 'CANCELLED' }
    if (tool !== 'browser_session_inspect'
      && tool !== 'browser_session_act'
      && tool !== 'browser_session_handoff') {
      return { kind: 'tool_error', code: 'INVALID_INPUT' }
    }
    const parsed = this.parse(tool, rawInput)
    if (!parsed.success) return { kind: 'tool_error', code: 'INVALID_INPUT' }
    const input = parsed.data
    let state: ActiveRunState
    try {
      state = this.runState(context, input.bindingId)
      this.assertActive(state, context)
      if (tool === 'browser_session_inspect') return await this.inspect(state, input as z.infer<typeof browserSessionInspectInputSchema>, context)
      if (tool === 'browser_session_act') return await this.act(state, input as z.infer<typeof browserSessionActInputSchema>, context)
      return await this.handoff(state, input as z.infer<typeof browserSessionHandoffInputSchema>, context)
    } catch (error) {
      const safe = toSafeAppError(error)
      state = this.runs.get(context.runId)!
      if (state) await this.cleanupAuthority(state)
      return { kind: 'tool_error', code: safe.code }
    }
  }

  async endRun(runId: string): Promise<void> {
    const state = this.runs.get(runId)
    if (state) await this.cleanupAuthority(state)
    this.runs.delete(runId)
    this.terminalRuns.add(runId)
  }

  async cancel(runId: string): Promise<void> {
    await this.endRun(runId)
  }

  async takeOver(runId: string): Promise<void> {
    await this.endRun(runId)
  }

  private parse(tool: BrowserContinuationToolName, input: unknown) {
    if (tool === 'browser_session_inspect') return browserSessionInspectInputSchema.safeParse(input)
    if (tool === 'browser_session_act') return browserSessionActInputSchema.safeParse(input)
    return browserSessionHandoffInputSchema.safeParse(input)
  }

  private runState(context: BrowserContinuationRunContext, bindingId: string): ActiveRunState {
    const existing = this.runs.get(context.runId)
    if (existing) {
      if (existing.bindingId !== bindingId) throw failure('NO_BOUND_PAGE')
      return existing
    }
    const state: ActiveRunState = {
      runId: context.runId,
      bindingId,
      startedAt: this.now(),
      actionCount: 0,
      noProgressCount: 0,
      repeatedActionCount: 0,
      snapshots: new Map(),
    }
    this.runs.set(context.runId, state)
    return state
  }

  private assertActive(state: ActiveRunState, context: BrowserContinuationRunContext): void {
    if (context.signal?.aborted) throw failure('CANCELLED')
    if (this.now() - state.startedAt >= 300_000) throw failure('ACTION_LIMIT_EXCEEDED')
    if (state.lease && !state.lease.isCurrent(state.lease.binding)) throw failure('CANCELLED')
  }

  private async lease(state: ActiveRunState, context: BrowserContinuationRunContext): Promise<BrowserContinuationLease> {
    if (state.lease?.isCurrent(state.lease.binding)) return state.lease
    state.lease = await this.dependencies.registry.acquire(state.bindingId, {
      userId: context.userId,
      conversationId: context.conversationId,
      runId: context.runId,
    })
    return state.lease
  }

  private async inspect(
    state: ActiveRunState,
    input: z.infer<typeof browserSessionInspectInputSchema>,
    context: BrowserContinuationRunContext,
  ): Promise<BrowserContinuationToolResult> {
    const lease = await this.lease(state, context)
    this.assertActive(state, context)
    const page = await this.dependencies.workspace.getContinuationState(lease.binding.tabId, context.runId)
    let audited = false
    try {
      const common = {
        lease,
        tabId: lease.binding.tabId,
        navigationEpoch: page.navigationEpoch,
        origin: page.origin,
        intent: input.intent,
        ...(input.ref === undefined ? {} : { ref: input.ref }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      }
      const result = input.mode === 'region_image'
        ? await this.dependencies.inspector.inspect({ ...common, mode: 'region_image' })
        : await this.dependencies.inspector.inspect({
          ...common,
          ...(input.mode === undefined ? {} : { mode: input.mode }),
        })
      this.assertActive(state, context)
      const signature = pageSignature(result)
      state.repeatedActionCount = 0
      state.lastActionSignature = undefined
      state.noProgressCount = signature === state.lastProgressSignature ? state.noProgressCount + 1 : 1
      state.lastProgressSignature = signature
      if (isPageSnapshot(result)) state.snapshots.set(result.snapshotId, result)
      if (state.noProgressCount >= 3) {
        this.audit(state, context, page.origin, 'inspect', 'page', 'sensitive_read', 'failed', 'ACTION_LIMIT_EXCEEDED')
        audited = true
        throw failure('ACTION_LIMIT_EXCEEDED')
      }
      this.audit(state, context, page.origin, 'inspect', 'page', 'sensitive_read', 'completed')
      audited = true
      return {
        kind: 'success',
        data: Object.freeze({
          trust: 'untrusted_page_data',
          ...(isPageSnapshot(result) ? { snapshot: result } : { regionImage: result }),
        }),
      }
    } catch (error) {
      if (!audited) {
        const safe = toSafeAppError(error)
        this.audit(
          state, context, page.origin, 'inspect', 'page', 'sensitive_read',
          safe.code === 'CANCELLED' ? 'cancelled' : 'failed', safe.code,
        )
      }
      throw error
    }
  }

  private async act(
    state: ActiveRunState,
    input: z.infer<typeof browserSessionActInputSchema>,
    context: BrowserContinuationRunContext,
  ): Promise<BrowserContinuationToolResult> {
    const lease = await this.lease(state, context)
    const snapshot = state.snapshots.get(input.snapshotId)
    if (!snapshot) {
      const page = await this.dependencies.workspace.getContinuationState(lease.binding.tabId, context.runId)
      this.auditAction(
        state, context, page.origin, input.actions[0] as BrowserAction,
        undefined, 'failed', 'PAGE_CHANGED',
      )
      throw failure('PAGE_CHANGED')
    }
    let completedActions = 0
    for (const rawAction of input.actions) {
      const action = rawAction as BrowserAction
      const target = 'ref' in action && action.ref !== undefined
        ? snapshot.nodes.find((node) => node.ref === action.ref)
        : undefined
      let page: BrowserContinuationPageState = {
        origin: snapshot.origin, url: snapshot.url, navigationEpoch: snapshot.navigationEpoch,
      }
      let normalized = action
      let audited = false
      try {
        this.assertActionBudget(state, action, context)
        page = await this.dependencies.workspace.getContinuationState(lease.binding.tabId, context.runId)
        if (page.origin !== snapshot.origin || page.navigationEpoch !== snapshot.navigationEpoch) {
          throw failure('PAGE_CHANGED')
        }
        const resolved = target
          ? await this.dependencies.inspector.resolveRef({
            lease,
            tabId: lease.binding.tabId,
            snapshotId: snapshot.snapshotId,
            navigationEpoch: page.navigationEpoch,
            origin: page.origin,
            ref: target.ref,
          })
          : undefined
        normalized = this.verifyValue(action, context, state)
        const decision = this.guard.decide({
          origin: page.origin,
          url: page.url,
          action: normalized,
          target,
          auth: snapshot.auth,
          snapshotFresh: true,
          permissionMatrix: lease.binding.permissionMatrix,
          ...(lease.binding.browserContinuation === undefined ? {} : { browserContinuation: lease.binding.browserContinuation }),
        })
        if (decision.kind === 'blocked') {
          this.auditAction(state, context, page.origin, normalized, target, 'blocked', decision.code)
          audited = true
          throw failure(decision.code)
        }
        if (decision.kind === 'handoff') {
          this.auditAction(state, context, page.origin, normalized, target, 'handed_off', decision.code)
          audited = true
          return this.performHandoff(state, context, page, target, resolved, decision)
        }
        await this.dependencies.workspace.performContinuationAction({
          tabId: lease.binding.tabId,
          runId: context.runId,
          expectedOrigin: page.origin,
          expectedNavigationEpoch: page.navigationEpoch,
          backendNodeId: resolved?.backendNodeId ?? 0,
          ...(resolved === undefined ? {} : { expectedRole: resolved.role, expectedName: resolved.name }),
          action: normalized,
        })
        state.actionCount += 1
        completedActions += 1
        state.noProgressCount = 0
        state.lastProgressSignature = undefined
        this.assertActive(state, context)
        const after = await this.dependencies.workspace.getContinuationState(lease.binding.tabId, context.runId)
        if (!this.postActionAllowed(normalized, lease, after)) throw failure('DOMAIN_BLOCKED')
        this.auditAction(state, context, page.origin, normalized, target, 'completed')
        audited = true
      } catch (error) {
        if (!audited) {
          const safe = toSafeAppError(error)
          this.auditAction(
            state, context, page.origin, normalized, target,
            safe.code === 'CANCELLED' ? 'cancelled' : 'failed', safe.code,
          )
        }
        throw error
      }
    }
    return { kind: 'success', data: Object.freeze({ completedActions }) }
  }

  private async handoff(
    state: ActiveRunState,
    input: z.infer<typeof browserSessionHandoffInputSchema>,
    context: BrowserContinuationRunContext,
  ): Promise<BrowserContinuationToolResult> {
    const lease = await this.lease(state, context)
    const page = await this.dependencies.workspace.getContinuationState(lease.binding.tabId, context.runId)
    let target: BrowserSemanticNode | undefined
    let resolved: BrowserResolvedElementReference | undefined
    if (input.ref) {
      for (const snapshot of state.snapshots.values()) {
        target = snapshot.nodes.find((node) => node.ref === input.ref)
        if (target) {
          resolved = await this.dependencies.inspector.resolveRef({
            lease, tabId: lease.binding.tabId, snapshotId: snapshot.snapshotId,
            navigationEpoch: page.navigationEpoch, origin: page.origin, ref: input.ref,
          })
          break
        }
      }
      if (!target || !resolved) throw failure('PAGE_CHANGED')
    }
    const code = input.reason === 'login' ? 'AUTH_REQUIRED'
      : input.reason === 'unsupported_control' ? 'UNSUPPORTED_CONTROL' : 'MANUAL_ACTION_REQUIRED'
    return this.performHandoff(state, context, page, target, resolved, { kind: 'handoff', code })
  }

  private async performHandoff(
    state: ActiveRunState,
    context: BrowserContinuationRunContext,
    page: BrowserContinuationPageState,
    target: BrowserSemanticNode | undefined,
    resolved: BrowserResolvedElementReference | undefined,
    decision: Extract<BrowserActionDecision, { kind: 'handoff' }>,
  ): Promise<BrowserContinuationToolResult> {
    const lease = state.lease!
    await this.dependencies.workspace.focusContinuation(lease.binding.tabId)
    if (target && resolved) {
      await this.dependencies.workspace.highlightContinuationTarget(
        lease.binding.tabId,
        target.ref,
        {
          runId: context.runId,
          expectedOrigin: page.origin,
          expectedNavigationEpoch: page.navigationEpoch,
          backendNodeId: resolved.backendNodeId,
          expectedRole: resolved.role,
          expectedName: resolved.name,
        },
      )
    }
    this.audit(
      state, context, page.origin, 'handoff', targetSummary(target),
      'external_action', 'handed_off', decision.code,
    )
    await this.cleanupAuthority(state, true)
    this.runs.delete(context.runId)
    this.terminalRuns.add(context.runId)
    return { kind: 'handoff', code: decision.code }
  }

  private verifyValue(
    action: BrowserAction,
    context: BrowserContinuationRunContext,
    state: ActiveRunState,
  ): BrowserAction {
    if (action.type !== 'fill' && action.type !== 'select' && action.type !== 'check') return action
    const evidence = this.sourceEvidence(action.source, context, state)
    const supported = action.type === 'check'
      ? typeof evidence === 'boolean' ? evidence === action.checked : textSupportsBoolean(action.checked, evidence)
      : typeof evidence === 'string' && textSupportsValue(action.value, evidence)
    if (!supported) throw failure('INVALID_INPUT')
    if (action.type === 'check') return action
    return Object.freeze({ ...action, value: trimmedText(action.value) })
  }

  private postActionAllowed(
    action: BrowserAction,
    lease: BrowserContinuationLease,
    page: BrowserContinuationPageState,
  ): boolean {
    const capability = requiredCapability(action)
    if (capability === undefined) {
      return Object.values(lease.binding.permissionMatrix).flat()
        .some((pattern) => matchesHttpsUrlPatternOrigin(pattern, page.origin))
    }
    return (lease.binding.permissionMatrix[capability] ?? [])
      .some((pattern) => matchesHttpsUrlPattern(pattern, page.url))
  }

  private sourceEvidence(
    source: BrowserValueSource,
    context: BrowserContinuationRunContext,
    state: ActiveRunState,
  ): string | boolean {
    if (source.kind === 'current_user') return context.currentUser.text
    if (source.kind === 'history') {
      const message = context.referencedHistory.find(({ messageId }) => messageId === source.messageId)
      if (!message) throw failure('INVALID_INPUT')
      return message.text
    }
    const snapshot = state.snapshots.get(source.snapshotId)
    const node = snapshot?.nodes.find((candidate) => candidate.ref === source.ref)
    if (!snapshot || !node) throw failure('INVALID_INPUT')
    if (node.value !== undefined) return node.value
    if (node.checked !== undefined) return node.checked
    throw failure('INVALID_INPUT')
  }

  private assertActionBudget(
    state: ActiveRunState,
    action: BrowserAction,
    context: BrowserContinuationRunContext,
  ): void {
    this.assertActive(state, context)
    if (state.actionCount >= 30) throw failure('ACTION_LIMIT_EXCEEDED')
    const signature = actionSignature(action)
    state.repeatedActionCount = signature === state.lastActionSignature ? state.repeatedActionCount + 1 : 1
    state.lastActionSignature = signature
    if (state.repeatedActionCount >= 3) throw failure('ACTION_LIMIT_EXCEEDED')
  }

  private auditAction(
    state: ActiveRunState,
    context: BrowserContinuationRunContext,
    origin: string,
    action: BrowserAction,
    target: BrowserSemanticNode | undefined,
    outcome: BrowserActionAuditEntry['outcome'],
    errorCode?: AppErrorCode,
  ): void {
    this.audit(
      state, context, origin, action.type, targetSummary(target),
      classifyBrowserActionRisk(action), outcome, errorCode,
    )
  }

  private audit(
    state: ActiveRunState,
    context: BrowserContinuationRunContext,
    origin: string,
    action: string,
    summary: string,
    risk: BrowserActionAuditEntry['risk'],
    outcome: BrowserActionAuditEntry['outcome'],
    errorCode?: AppErrorCode,
  ): void {
    if (state.nextAuditSequence === undefined) {
      state.nextAuditSequence = (this.dependencies.audits.list(state.bindingId).at(-1)?.sequence ?? 0) + 1
    }
    this.dependencies.audits.insert({
      id: this.id(),
      bindingId: state.bindingId,
      chatRunId: context.runId,
      sequence: state.nextAuditSequence++,
      origin: new URL(origin).origin,
      action: action.slice(0, 80),
      targetSummary: summary.slice(0, 80),
      risk,
      outcome,
      ...(errorCode === undefined ? {} : { errorCode }),
      createdAt: this.now(),
    })
  }

  private async cleanupAuthority(state: ActiveRunState, preserveHighlight = false): Promise<void> {
    const lease = state.lease
    state.lease = undefined
    state.snapshots.clear()
    this.dependencies.inspector.endRun(state.runId)
    if (!preserveHighlight && lease) {
      await this.dependencies.workspace.clearContinuationHighlight(lease.binding.tabId).catch(() => undefined)
    }
    if (lease) await lease.release().catch(() => undefined)
  }
}
