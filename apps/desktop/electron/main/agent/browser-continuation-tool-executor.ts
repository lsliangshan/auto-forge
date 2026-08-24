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
  BrowserPrivateFieldEvidence,
  BrowserResolvedElementReference,
} from '../browser/browser-page-inspector.js'
import type { BrowserContinuationRegistry } from '../browser/browser-continuation-registry.js'
import type {
  BrowserAction,
  BrowserContinuationLease,
  BrowserContinuationPageState,
  BrowserContinuationResolvedTargetInput,
  BrowserPageSnapshot,
  BrowserSemanticNode,
  BrowserValueSource,
} from '../browser/browser-continuation-types.js'
import type { BrowserLoginWaitCoordinator } from '../browser/browser-login-wait-coordinator.js'
import type { BrowserManualResumeCoordinator } from '../browser/browser-manual-resume-coordinator.js'
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
  z.object({ kind: z.literal('page'), snapshotId: identifier, ref }).strict(),
])

const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('fill'), ref, value: boundedText, source: valueSourceSchema }).strict(),
  z.object({ type: z.literal('select'), ref, value: boundedText, source: valueSourceSchema }).strict(),
  z.object({ type: z.literal('click'), ref }).strict(),
  z.object({ type: z.literal('check'), ref, checked: z.boolean(), source: valueSourceSchema }).strict(),
  z.object({ type: z.literal('navigate'), url: httpsUrl, source: valueSourceSchema }).strict(),
  z.object({ type: z.literal('scroll'), ref: ref.optional(), direction: z.enum(['up', 'down']) }).strict(),
  z.object({ type: z.literal('wait'), milliseconds: z.number().int().min(50).max(2_000) }).strict(),
  z.object({ type: z.literal('focus') }).strict(),
])

export const browserSessionInspectInputSchema = z.object({
  bindingId: identifier,
  intent: z.string().trim().min(1).max(500),
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
  suspendContinuation(tabId: string, runId: string): Promise<void>
  resumeContinuation(
    tabId: string,
    runId: string,
    expectedPage: BrowserContinuationPageState,
  ): Promise<void>
}

interface BrowserActionAuditRepository {
  list(bindingId: string): BrowserActionAuditEntry[]
  insert(value: BrowserActionAuditEntry): BrowserActionAuditEntry
}

interface BrowserContinuationToolExecutorDependencies {
  readonly registry: Pick<BrowserContinuationRegistry, 'acquire'>
  readonly inspector: Pick<BrowserPageInspector, 'inspect' | 'fieldEvidence' | 'resolveRef' | 'currentPageContext' | 'endRun'>
  readonly workspace: BrowserContinuationWorkspacePort
  readonly loginWait: Pick<BrowserLoginWaitCoordinator, 'wait' | 'cancel'>
  readonly manualWait?: Pick<BrowserManualResumeCoordinator, 'wait' | 'cancel'>
  readonly audits: BrowserActionAuditRepository
  readonly guard?: BrowserActionGuard
  readonly id?: () => string
  readonly now?: () => number
  readonly isRunActive: (runId: string) => boolean
  readonly terminalRunLimit?: number
  readonly terminalRunTtlMs?: number
}

type BrowserSuspension =
  | { readonly kind: 'authentication'; readonly requiredPage: BrowserContinuationPageState }
  | { readonly kind: 'manual_intervention'; readonly baselineActivityRevision: number }

interface ActiveRunState {
  readonly runId: string
  readonly bindingId: string
  readonly startedAt: number
  pausedAt?: number
  pausedDurationMs: number
  suspension?: BrowserSuspension
  waitersCancelled: boolean
  lease?: BrowserContinuationLease
  nextAuditSequence?: number
  readonly snapshots: Map<string, BrowserPageSnapshot>
}

export type BrowserContinuationToolResult =
  | {
      readonly kind: 'success'
      readonly data: Readonly<Record<string, unknown>>
      readonly privateFieldEvidence?: readonly BrowserPrivateFieldEvidence[]
    }
  | {
      readonly kind: 'handoff'
      readonly code: 'AUTH_REQUIRED' | 'MANUAL_ACTION_REQUIRED' | 'MANUAL_INTERVENTION_REQUIRED' | 'UNSUPPORTED_CONTROL'
    }
  | { readonly kind: 'tool_error'; readonly code: AppErrorCode }

export type BrowserAuthenticationWaitResult =
  | { readonly kind: 'authenticated' }
  | { readonly kind: 'tool_error'; readonly code: AppErrorCode }

export type BrowserManualWaitResult =
  | { readonly kind: 'resumed' }
  | { readonly kind: 'tool_error'; readonly code: AppErrorCode }

function failure(code: AppErrorCode): AppError {
  return toSafeAppError({ code })
}

function trimmedText(value: string): string {
  return value.trim()
}

function samePage(
  left: BrowserContinuationPageState,
  right: BrowserContinuationPageState,
): boolean {
  return left.origin === right.origin
    && left.url === right.url
    && left.navigationEpoch === right.navigationEpoch
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

function targetSummary(target: BrowserSemanticNode | undefined): string {
  return target ? `${target.role.slice(0, 80)} control` : 'page'
}

function isSnapshotIndependentAction(action: BrowserAction): boolean {
  return action.type === 'wait'
    || action.type === 'focus'
    || (action.type === 'scroll' && action.ref === undefined)
}

export class BrowserContinuationToolExecutor {
  private readonly guard: BrowserActionGuard
  private readonly id: () => string
  private readonly now: () => number
  private readonly terminalRunLimit: number
  private readonly terminalRunTtlMs: number
  private readonly runs = new Map<string, ActiveRunState>()
  private readonly terminalRuns = new Map<string, number>()

  constructor(private readonly dependencies: BrowserContinuationToolExecutorDependencies) {
    this.guard = dependencies.guard ?? new BrowserActionGuard()
    this.id = dependencies.id ?? randomUUID
    this.now = dependencies.now ?? Date.now
    this.terminalRunLimit = Math.max(1, dependencies.terminalRunLimit ?? 4_096)
    this.terminalRunTtlMs = Math.max(1, dependencies.terminalRunTtlMs ?? 30 * 60 * 1_000)
  }

  async execute(
    tool: BrowserContinuationToolName,
    rawInput: unknown,
    context: BrowserContinuationRunContext,
  ): Promise<BrowserContinuationToolResult> {
    if (!this.runAdmitted(context.runId) || this.isTerminalRun(context.runId)) {
      return { kind: 'tool_error', code: 'CANCELLED' }
    }
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
    this.cancelWaiters(runId, state)
    if (state) await this.cleanupAuthority(state)
    this.runs.delete(runId)
    this.rememberTerminalRun(runId)
  }

  async cancel(runId: string): Promise<void> {
    await this.endRun(runId)
  }

  async takeOver(runId: string): Promise<void> {
    await this.endRun(runId)
  }

  async waitForAuthentication(
    runId: string,
    context: BrowserContinuationRunContext,
  ): Promise<BrowserAuthenticationWaitResult> {
    const state = this.runs.get(runId)
    const suspension = state?.suspension
    if (!state || state.runId !== context.runId
      || suspension?.kind !== 'authentication' || !state.lease) {
      return { kind: 'tool_error', code: 'CANCELLED' }
    }
    const lease = state.lease
    try {
      let authenticationRequiredPage = suspension.requiredPage
      let unknownCandidate: BrowserContinuationPageState | undefined
      while (true) {
        this.assertActive(state, context)
        let authenticatedPage: BrowserContinuationPageState | undefined
        await this.dependencies.loginWait.wait({
          runId,
          tabId: lease.binding.tabId,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          probe: async () => {
            await lease.assertEligible()
            this.assertActive(state, context)
            const page = await this.dependencies.workspace.getContinuationState(
              lease.binding.tabId,
              context.runId,
            )
            const live = await this.dependencies.inspector.currentPageContext({
              lease,
              tabId: lease.binding.tabId,
              navigationEpoch: page.navigationEpoch,
              origin: page.origin,
              allowAuthLoginUrls: true,
              ...(context.signal === undefined ? {} : { signal: context.signal }),
            })
            if (live.auth === 'required') {
              authenticationRequiredPage = page
              unknownCandidate = undefined
              authenticatedPage = undefined
              return live.auth
            }
            if (live.auth === 'authenticated') {
              authenticatedPage = page
              return live.auth
            }
            if (!samePage(page, authenticationRequiredPage)
              && unknownCandidate
              && samePage(page, unknownCandidate)) {
              authenticatedPage = page
              return 'authenticated'
            }
            unknownCandidate = page
            authenticatedPage = undefined
            return live.auth
          },
        })
        await lease.assertEligible()
        this.assertActive(state, context)
        if (!authenticatedPage) throw failure('PAGE_CHANGED')
        try {
          await this.dependencies.workspace.resumeContinuation(
            lease.binding.tabId,
            context.runId,
            authenticatedPage,
          )
          break
        } catch (error) {
          if (toSafeAppError(error).code !== 'PAGE_CHANGED') throw error
          unknownCandidate = undefined
        }
      }
      this.completeSuspension(state)
      return { kind: 'authenticated' }
    } catch (error) {
      const safe = toSafeAppError(error)
      if (this.runs.get(runId) === state) await this.terminate(state)
      return { kind: 'tool_error', code: safe.code }
    }
  }

  async waitForManualIntervention(
    runId: string,
    context: BrowserContinuationRunContext,
  ): Promise<BrowserManualWaitResult> {
    const state = this.runs.get(runId)
    const suspension = state?.suspension
    if (!state || state.runId !== context.runId
      || suspension?.kind !== 'manual_intervention' || !state.lease) {
      return { kind: 'tool_error', code: 'CANCELLED' }
    }
    const lease = state.lease
    try {
      const manualWait = this.dependencies.manualWait
      if (!manualWait) throw failure('INTERNAL_ERROR')
      this.assertActive(state, context)
      await manualWait.wait({
        runId,
        tabId: lease.binding.tabId,
        baselineActivityRevision: suspension.baselineActivityRevision,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        promote: async () => {
          await lease.assertEligible()
          this.assertActive(state, context)
          const expected = await this.dependencies.workspace.getContinuationState(
            lease.binding.tabId,
            context.runId,
          )
          if (!this.currentPageAllowed(lease, expected)) throw failure('DOMAIN_BLOCKED')
          await this.dependencies.workspace.resumeContinuation(
            lease.binding.tabId,
            context.runId,
            expected,
          )
        },
      })
      this.completeSuspension(state)
      return { kind: 'resumed' }
    } catch (error) {
      const safe = toSafeAppError(error)
      if (this.runs.get(runId) === state) await this.terminate(state)
      return { kind: 'tool_error', code: safe.code }
    }
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
      pausedDurationMs: 0,
      waitersCancelled: false,
      snapshots: new Map(),
    }
    this.runs.set(context.runId, state)
    return state
  }

  private assertActive(state: ActiveRunState, context: BrowserContinuationRunContext): void {
    if (context.signal?.aborted) throw failure('CANCELLED')
    const now = this.now()
    const pausedDuration = state.pausedDurationMs
      + (state.pausedAt === undefined ? 0 : now - state.pausedAt)
    if (now - state.startedAt - pausedDuration >= 300_000) throw failure('ACTION_LIMIT_EXCEEDED')
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
    await lease.assertEligible()
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
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      }
      const result = await this.dependencies.inspector.inspect(common)
      await lease.assertEligible()
      this.assertActive(state, context)
      state.snapshots.set(result.snapshotId, result)
      const privateFieldEvidence = this.dependencies.inspector.fieldEvidence(result.snapshotId)
      this.audit(state, context, page.origin, 'inspect', 'page', 'sensitive_read', 'completed')
      audited = true
      return {
        kind: 'success',
        data: Object.freeze({
          trust: 'untrusted_page_data',
          snapshot: result,
        }),
        ...(privateFieldEvidence.length === 0
          ? {}
          : { privateFieldEvidence: Object.freeze([...privateFieldEvidence]) }),
      }
    } catch (error) {
      const safe = toSafeAppError(error)
      if (!audited && this.isManualInterventionBlocker(safe.code)) {
        let handoffPage: BrowserContinuationPageState
        try {
          handoffPage = await this.manualInterventionPage(state, context, { type: 'focus' })
        } catch (terminalError) {
          const terminal = toSafeAppError(terminalError)
          this.audit(
            state, context, page.origin, 'inspect', 'page', 'sensitive_read',
            terminal.code === 'CANCELLED' ? 'cancelled' : 'failed', terminal.code,
          )
          audited = true
          throw terminalError
        }
        try {
          const result = await this.performHandoff(
            state, context, handoffPage, undefined, undefined,
            { kind: 'handoff', code: 'MANUAL_INTERVENTION_REQUIRED' },
          )
          this.audit(
            state, context, handoffPage.origin, 'inspect', 'page',
            'sensitive_read', 'handed_off', 'MANUAL_INTERVENTION_REQUIRED',
          )
          audited = true
          return result
        } catch (handoffError) {
          const handoffFailure = toSafeAppError(handoffError)
          this.audit(
            state, context, handoffPage.origin, 'inspect', 'page', 'sensitive_read',
            handoffFailure.code === 'CANCELLED' ? 'cancelled' : 'failed', handoffFailure.code,
          )
          this.audit(
            state, context, handoffPage.origin, 'handoff', 'page',
            'external_action', 'failed', handoffFailure.code,
          )
          audited = true
          throw handoffError
        }
      }
      if (!audited) {
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
    await lease.assertEligible()
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
      const targetRef = action.type === 'navigate' && action.source.kind === 'page'
        ? action.source.ref
        : 'ref' in action ? action.ref : undefined
      const target = targetRef === undefined
        ? undefined
        : snapshot.nodes.find((node) => node.ref === targetRef)
      let page: BrowserContinuationPageState = {
        origin: snapshot.origin, url: snapshot.url, navigationEpoch: snapshot.navigationEpoch,
        activityRevision: 0,
      }
      let normalized = action
      let audited = false
      try {
        this.assertActionBudget(state, action, context)
        await lease.assertEligible()
        page = await this.dependencies.workspace.getContinuationState(lease.binding.tabId, context.runId)
        if (!isSnapshotIndependentAction(action)
          && (page.origin !== snapshot.origin || page.navigationEpoch !== snapshot.navigationEpoch)) {
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
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          })
          : undefined
        const liveBefore = resolved ?? await this.dependencies.inspector.currentPageContext({
          lease,
          tabId: lease.binding.tabId,
          navigationEpoch: page.navigationEpoch,
          origin: page.origin,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        })
        normalized = this.verifyAction(action, context, state, resolved)
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
        await lease.assertEligible()
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
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        })
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
        const safe = toSafeAppError(error)
        if (!audited && this.isManualInterventionBlocker(safe.code)) {
          let handoffPage: BrowserContinuationPageState
          try {
            handoffPage = await this.manualInterventionPage(state, context, normalized)
          } catch (terminalError) {
            const terminal = toSafeAppError(terminalError)
            this.auditAction(
              state, context, page.origin, normalized, target,
              terminal.code === 'CANCELLED' ? 'cancelled' : 'failed', terminal.code,
            )
            audited = true
            throw terminalError
          }
          try {
            const result = await this.performHandoff(
              state, context, handoffPage, target, undefined,
              { kind: 'handoff', code: 'MANUAL_INTERVENTION_REQUIRED' },
              { action: normalized, target },
            )
            audited = true
            return result
          } catch (handoffError) {
            const handoffFailure = toSafeAppError(handoffError)
            this.auditAction(
              state, context, handoffPage.origin, normalized, target,
              handoffFailure.code === 'CANCELLED' ? 'cancelled' : 'failed', handoffFailure.code,
            )
            this.audit(
              state, context, handoffPage.origin, 'handoff', targetSummary(target),
              'external_action', 'failed', handoffFailure.code,
            )
            audited = true
            throw handoffError
          }
        }
        if (!audited) {
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
              ...(context.signal === undefined ? {} : { signal: context.signal }),
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
    await lease.assertEligible()
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
    state.snapshots.clear()
    this.dependencies.inspector.endRun(state.runId)
    await this.dependencies.workspace.suspendContinuation(lease.binding.tabId, context.runId)
    state.suspension = decision.code === 'AUTH_REQUIRED'
      ? { kind: 'authentication', requiredPage: page }
      : { kind: 'manual_intervention', baselineActivityRevision: page.activityRevision }
    state.pausedAt = this.now()
    if (trigger) {
      this.auditAction(
        state, context, page.origin, trigger.action, trigger.target, 'handed_off', decision.code,
      )
    }
    this.audit(
      state, context, page.origin, 'handoff', targetSummary(target),
      'external_action', 'handed_off', decision.code,
    )
    return { kind: 'handoff', code: decision.code }
  }

  private verifyAction(
    action: BrowserAction,
    context: BrowserContinuationRunContext,
    state: ActiveRunState,
    resolved: BrowserResolvedElementReference | undefined,
  ): BrowserAction {
    if (action.type === 'navigate') {
      const destination = this.canonicalCurrentUserUrl(action.url)
      if (!destination) throw failure('INVALID_INPUT')
      if (action.source.kind === 'current_user') {
        if (!this.currentUserUrls(context.currentUser.text).has(destination)) throw failure('INVALID_INPUT')
      } else if (!resolved
        || action.source.snapshotId !== resolved.snapshotId
        || action.source.ref !== resolved.ref
        || resolved.role !== 'link'
        || resolved.targetContext.href !== destination) {
        throw failure('INVALID_INPUT')
      }
      return Object.freeze({ ...action, url: destination })
    }
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

  private currentPageAllowed(
    lease: BrowserContinuationLease,
    page: BrowserContinuationPageState,
  ): boolean {
    return Object.values(lease.binding.permissionMatrix).flat()
      .some((pattern) => matchesHttpsUrlPattern(pattern, page.url))
  }

  private preActionAllowed(
    action: BrowserAction,
    lease: BrowserContinuationLease,
    page: BrowserContinuationPageState,
  ): boolean {
    if (!this.currentPageAllowed(lease, page)) return false
    const capability = requiredCapability(action)
    if (capability === undefined) return true
    const targetUrl = action.type === 'navigate' ? action.url : page.url
    return (lease.binding.permissionMatrix[capability] ?? [])
      .some((pattern) => matchesHttpsUrlPattern(pattern, targetUrl))
  }

  private isManualInterventionBlocker(code: AppErrorCode): boolean {
    return code === 'TARGET_AMBIGUOUS' || code === 'AUTH_STATE_UNKNOWN'
  }

  private async manualInterventionPage(
    state: ActiveRunState,
    context: BrowserContinuationRunContext,
    action: BrowserAction,
  ): Promise<BrowserContinuationPageState> {
    const lease = state.lease
    if (!lease) throw failure('CANCELLED')
    await lease.assertEligible()
    this.assertActive(state, context)
    const page = await this.dependencies.workspace.getContinuationState(
      lease.binding.tabId,
      context.runId,
    )
    if (!this.preActionAllowed(action, lease, page)) throw failure('DOMAIN_BLOCKED')
    return page
  }

  private completeSuspension(state: ActiveRunState): void {
    const resumedAt = this.now()
    state.pausedDurationMs += state.pausedAt === undefined ? 0 : resumedAt - state.pausedAt
    state.pausedAt = undefined
    state.suspension = undefined
  }

  private sourceEvidence(
    source: BrowserValueSource,
    context: BrowserContinuationRunContext,
    state: ActiveRunState,
  ): string | boolean {
    if (source.kind === 'current_user') return context.currentUser.text
    const snapshot = state.snapshots.get(source.snapshotId)
    const node = snapshot?.nodes.find((candidate) => candidate.ref === source.ref)
    if (!snapshot || !node) throw failure('INVALID_INPUT')
    if (node.value !== undefined) return node.value
    if (node.checked !== undefined) return node.checked
    throw failure('INVALID_INPUT')
  }

  private canonicalCurrentUserUrl(value: string): string | undefined {
    try {
      const url = new URL(value)
      if (url.protocol !== 'https:' || url.username || url.password) return undefined
      return url.href
    } catch {
      return undefined
    }
  }

  private currentUserUrls(text: string): ReadonlySet<string> {
    const urls = new Set<string>()
    for (const match of text.matchAll(/https:\/\/[^\s<>"'“”‘’（）()[\]{}，。；！？]+/giu)) {
      const candidate = match[0].replace(/[.,;!?，。；！？）)\]}]+$/gu, '')
      const canonical = this.canonicalCurrentUserUrl(candidate)
      if (canonical) urls.add(canonical)
    }
    return urls
  }

  private assertActionBudget(
    state: ActiveRunState,
    _action: BrowserAction,
    context: BrowserContinuationRunContext,
  ): void {
    this.assertActive(state, context)
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
    this.cancelWaiters(state.runId, state)
    await this.cleanupAuthority(state)
    this.runs.delete(state.runId)
    this.rememberTerminalRun(state.runId)
  }

  private cancelWaiters(runId: string, state?: ActiveRunState): void {
    if (state?.waitersCancelled) return
    if (state) state.waitersCancelled = true
    this.dependencies.loginWait.cancel(runId)
    this.dependencies.manualWait?.cancel(runId)
  }

  private isTerminalRun(runId: string): boolean {
    this.pruneTerminalRuns()
    const expiresAt = this.terminalRuns.get(runId)
    if (expiresAt === undefined) return false
    this.terminalRuns.delete(runId)
    this.terminalRuns.set(runId, expiresAt)
    return true
  }

  private runAdmitted(runId: string): boolean {
    try {
      return this.dependencies.isRunActive(runId)
    } catch {
      return false
    }
  }

  private rememberTerminalRun(runId: string): void {
    this.pruneTerminalRuns()
    this.terminalRuns.delete(runId)
    this.terminalRuns.set(runId, this.now() + this.terminalRunTtlMs)
    while (this.terminalRuns.size > this.terminalRunLimit) {
      const oldest = this.terminalRuns.keys().next().value
      if (oldest === undefined) break
      this.terminalRuns.delete(oldest)
    }
  }

  private pruneTerminalRuns(): void {
    const now = this.now()
    for (const [runId, expiresAt] of this.terminalRuns) {
      if (expiresAt <= now) this.terminalRuns.delete(runId)
    }
  }

  private async cleanupAuthority(
    state: ActiveRunState,
    preserveHighlight = false,
  ): Promise<void> {
    const lease = state.lease
    state.snapshots.clear()
    this.dependencies.inspector.endRun(state.runId)
    if (!preserveHighlight && lease) {
      await this.dependencies.workspace.clearContinuationHighlight(lease.binding.tabId).catch(() => undefined)
    }
    if (lease) {
      await lease.release()
    }
    state.lease = undefined
  }
}
