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
  focusContinuation(tabId: string, runId: string): Promise<void>
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
  readonly inspector: Pick<BrowserPageInspector, 'inspect' | 'resolveRef' | 'currentPageContext' | 'endRun'>
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
  inspectionNoProgressCount: number
  lastInspectionSignature?: string
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

function trimmedText(value: string): string {
  return value.trim()
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  if (year < 1 || year > 9_999 || month < 1 || month > 12 || day < 1) return false
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day <= days[month - 1]!
}

function normalizedIsoDates(value: string): readonly string[] {
  const dates: string[] = []
  const delimiter = `[\\s:：,，.。;；、!?！？'"“”‘’()（）]`
  const pattern = new RegExp(`(?:^|${delimiter})(\\d{4})[-/.年](\\d{1,2})[-/.月](\\d{1,2})(?:日)?(?=$|${delimiter})`, 'gu')
  for (const match of value.matchAll(pattern)) {
    const month = Number(match[2])
    const day = Number(match[3])
    const year = Number(match[1])
    if (validCalendarDate(year, month, day)) {
      dates.push(`${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`)
    }
  }
  return dates
}

function textSupportsValue(requested: string, evidence: string): boolean {
  const candidate = trimmedText(requested)
  const source = trimmedText(evidence)
  if (!candidate) return false
  if (/^\d{4}-\d{2}-\d{2}$/u.test(candidate)) {
    const [year, month, day] = candidate.split('-').map(Number)
    return validCalendarDate(year!, month!, day!) && normalizedIsoDates(source).includes(candidate)
  }
  if (source === candidate) return true
  const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const delimiter = `[\\s:：,，.。;；、!?！？'"“”‘’()（）\\[\\]{}]`
  return new RegExp(`(?:^|${delimiter})${escaped}(?=$|${delimiter})`, 'u').test(source)
}

function textSupportsBoolean(requested: boolean, evidence: string): boolean {
  const normalized = trimmedText(evidence).toLowerCase()
  const delimiter = `[\\s:：,，.。;；、!?！？'"“”‘’()（）]`
  const negative = /不同意|不要勾选|请勿勾选|不勾选|取消勾选|不要选中|不选中/iu.test(normalized)
    || new RegExp(`(?:^|${delimiter})(?:否|false|no)(?=$|${delimiter})`, 'iu').test(normalized)
  const positive = new RegExp(`(?:^|${delimiter})(?:是|true|yes)(?=$|${delimiter})`, 'iu').test(normalized)
    || new RegExp(`(?:^|${delimiter})(?:请)?勾选.{0,20}同意(?:须知|条款|协议)?(?=$|${delimiter})`, 'iu').test(normalized)
    || new RegExp(`(?:^|${delimiter})同意(?:须知|条款|协议)?(?=$|${delimiter})`, 'iu').test(normalized)
  if (positive === negative) return false
  return requested ? positive : negative
}

function normalizedEvidenceText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function longestSharedText(left: string, right: string): number {
  let longest = 0
  let previous = new Array<number>(right.length + 1).fill(0)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = new Array<number>(right.length + 1).fill(0)
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      if (left[leftIndex - 1] !== right[rightIndex - 1]) continue
      current[rightIndex] = previous[rightIndex - 1]! + 1
      longest = Math.max(longest, current[rightIndex]!)
    }
    previous = current
  }
  return longest
}

function evidenceRelevantToIntent(node: BrowserSemanticNode, intent: string): boolean {
  const name = normalizedEvidenceText(node.name)
  const request = normalizedEvidenceText(intent)
  if (!name || !request) return false
  if (request.includes(name) || name.includes(request)) return true
  return longestSharedText(name, request) >= 3
}

function relevantEvidenceSet(snapshot: BrowserPageSnapshot, intent: string): Set<string> {
  return new Set(snapshot.nodes
    .filter((node) => evidenceRelevantToIntent(node, intent))
    .map((node) => JSON.stringify({
      role: node.role,
      name: node.name,
      value: node.value,
      checked: node.checked,
      selected: node.selected,
      actions: node.actions,
    })))
}

function revealsRelevantEvidence(
  before: BrowserPageSnapshot,
  after: BrowserPageSnapshot,
  intent: string,
): boolean {
  const existing = relevantEvidenceSet(before, intent)
  return [...relevantEvidenceSet(after, intent)].some((evidence) => !existing.has(evidence))
}

function navigationChanged(
  before: BrowserContinuationPageState,
  after: BrowserContinuationPageState,
): boolean {
  return before.origin !== after.origin
    || before.url !== after.url
    || before.navigationEpoch !== after.navigationEpoch
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
      if (state) await this.terminate(state)
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
      inspectionNoProgressCount: 0,
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
      const changed = state.lastInspectionSignature !== undefined && signature !== state.lastInspectionSignature
      state.inspectionNoProgressCount = signature === state.lastInspectionSignature
        ? state.inspectionNoProgressCount + 1
        : 1
      state.lastInspectionSignature = signature
      if (changed) state.noProgressCount = 0
      if (isPageSnapshot(result)) state.snapshots.set(result.snapshotId, result)
      if (state.inspectionNoProgressCount >= 3) {
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
    let progressSnapshot = snapshot
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
        const liveBefore = resolved ?? await this.dependencies.inspector.currentPageContext({
          lease,
          tabId: lease.binding.tabId,
          navigationEpoch: page.navigationEpoch,
          origin: page.origin,
        })
        normalized = this.verifyValue(action, context, state)
        const decision = this.guard.decide({
          origin: page.origin,
          url: page.url,
          action: normalized,
          target,
          auth: liveBefore.auth,
          snapshotFresh: true,
          permissionMatrix: lease.binding.permissionMatrix,
          ...(resolved === undefined ? {} : { targetContext: resolved.targetContext }),
          ...(lease.binding.browserContinuation === undefined ? {} : { browserContinuation: lease.binding.browserContinuation }),
        })
        if (decision.kind === 'blocked') {
          this.auditAction(state, context, page.origin, normalized, target, 'blocked', decision.code)
          audited = true
          throw failure(decision.code)
        }
        if (decision.kind === 'handoff') {
          try {
            const result = await this.performHandoff(
              state, context, page, target, resolved, decision, { action: normalized, target },
            )
            audited = true
            return result
          } catch (error) {
            const safe = toSafeAppError(error)
            this.auditAction(state, context, page.origin, normalized, target, 'failed', safe.code)
            this.audit(
              state, context, page.origin, 'handoff', targetSummary(target),
              'external_action', 'failed', safe.code,
            )
            audited = true
            throw error
          }
        }
        state.actionCount += 1
        await this.dependencies.workspace.performContinuationAction({
          tabId: lease.binding.tabId,
          runId: context.runId,
          expectedOrigin: page.origin,
          expectedNavigationEpoch: page.navigationEpoch,
          backendNodeId: resolved?.backendNodeId ?? 0,
          ...(resolved === undefined ? {} : { expectedRole: resolved.role, expectedName: resolved.name }),
          action: normalized,
        })
        this.assertActive(state, context)
        const after = await this.dependencies.workspace.getContinuationState(lease.binding.tabId, context.runId)
        if (!this.postActionAllowed(normalized, lease, after)) throw failure('DOMAIN_BLOCKED')
        const liveAfter = await this.dependencies.inspector.currentPageContext({
          lease,
          tabId: lease.binding.tabId,
          navigationEpoch: after.navigationEpoch,
          origin: after.origin,
        })
        const navigated = navigationChanged(page, after)
        let revealedRelevantEvidence = false
        if (!navigated) {
          const afterSnapshot = await this.dependencies.inspector.inspect({
            lease,
            tabId: lease.binding.tabId,
            navigationEpoch: after.navigationEpoch,
            origin: after.origin,
            intent: context.currentUser.text,
          })
          if (action.type !== 'focus' && action.type !== 'wait') {
            revealedRelevantEvidence = revealsRelevantEvidence(
              progressSnapshot,
              afterSnapshot,
              context.currentUser.text,
            )
          }
          progressSnapshot = afterSnapshot
        }
        const relevantProgress = action.type !== 'focus' && action.type !== 'wait'
          && (navigated || revealedRelevantEvidence)
        if (relevantProgress) state.noProgressCount = 0
        else state.noProgressCount += 1
        if (state.noProgressCount >= 3) throw failure('ACTION_LIMIT_EXCEEDED')
        if (liveAfter.auth === 'required') {
          try {
            const result = await this.performHandoff(
              state, context, after, undefined, undefined,
              { kind: 'handoff', code: 'AUTH_REQUIRED' }, { action: normalized, target },
            )
            audited = true
            return result
          } catch (error) {
            const safe = toSafeAppError(error)
            this.auditAction(state, context, page.origin, normalized, target, 'failed', safe.code)
            this.audit(
              state, context, after.origin, 'handoff', 'page', 'external_action', 'failed', safe.code,
            )
            audited = true
            throw error
          }
        }
        completedActions += 1
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
    try {
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
      return await this.performHandoff(state, context, page, target, resolved, { kind: 'handoff', code })
    } catch (error) {
      const safe = toSafeAppError(error)
      this.audit(
        state, context, page.origin, 'handoff', targetSummary(target),
        'external_action', safe.code === 'CANCELLED' ? 'cancelled' : 'failed', safe.code,
      )
      throw error
    }
  }

  private async performHandoff(
    state: ActiveRunState,
    context: BrowserContinuationRunContext,
    page: BrowserContinuationPageState,
    target: BrowserSemanticNode | undefined,
    resolved: BrowserResolvedElementReference | undefined,
    decision: Extract<BrowserActionDecision, { kind: 'handoff' }>,
    trigger?: { readonly action: BrowserAction; readonly target: BrowserSemanticNode | undefined },
  ): Promise<BrowserContinuationToolResult> {
    const lease = state.lease!
    await this.dependencies.workspace.focusContinuation(lease.binding.tabId, context.runId)
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
    await this.cleanupAuthority(state, true, false)
    if (trigger) {
      this.auditAction(
        state, context, page.origin, trigger.action, trigger.target, 'handed_off', decision.code,
      )
    }
    this.audit(
      state, context, page.origin, 'handoff', targetSummary(target),
      'external_action', 'handed_off', decision.code,
    )
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
    _action: BrowserAction,
    context: BrowserContinuationRunContext,
  ): void {
    this.assertActive(state, context)
    if (state.actionCount >= 30) throw failure('ACTION_LIMIT_EXCEEDED')
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

  private async terminate(state: ActiveRunState): Promise<void> {
    await this.cleanupAuthority(state)
    this.runs.delete(state.runId)
    this.terminalRuns.add(state.runId)
  }

  private async cleanupAuthority(
    state: ActiveRunState,
    preserveHighlight = false,
    suppressReleaseError = true,
  ): Promise<void> {
    const lease = state.lease
    state.snapshots.clear()
    this.dependencies.inspector.endRun(state.runId)
    if (!preserveHighlight && lease) {
      await this.dependencies.workspace.clearContinuationHighlight(lease.binding.tabId).catch(() => undefined)
    }
    if (lease) {
      if (suppressReleaseError) await lease.release().catch(() => undefined)
      else await lease.release()
    }
    state.lease = undefined
  }
}
