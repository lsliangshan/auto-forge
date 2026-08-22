import {
  approvalDecisionSchema,
  toSafeAppError,
  type AppErrorCode,
  type ApprovalDecision,
  type Capability,
  type CapabilityScope,
} from '@autoforge/shared'
import { estimateTextTokens, resolveChatInputBudget } from '../chat/conversation-context.js'
import type { PermissionRecord, PermissionRequest } from '../permissions/policy-engine.js'
import { scopeHash } from '../permissions/policy-engine.js'
import type {
  ExecutionReservation,
  ExecutionStartInput,
  StartedExecution,
} from '../workflows/execution-service.js'
import { validateWorkflowInput } from '../workflows/input-validation.js'
import type {
  ExactWorkflowSource,
  WorkflowExecutionSourceSelector,
} from '../workflows/workflow-source-selector.js'
import { classifyCapability } from './capability-risk.js'
import type { WorkflowCandidate } from './workflow-catalog.js'

const MAX_ACTION_SUMMARY_LENGTH = 500
const MAX_MODEL_RESULT_BYTES = 256 * 1024
const SENSITIVE_KEY = /password|secret|token|api[_-]?key|authorization|cookie|path/i

type ExecutionCompletion = Awaited<StartedExecution['finished']>

export interface WorkflowToolPolicyPort {
  evaluate(request: PermissionRequest): { allowed: boolean; requiresApproval: boolean }
  record(record: PermissionRecord): unknown
  releaseExecution(executionId: string): void
}

export interface WorkflowToolExecutionPort {
  reserve(): ExecutionReservation
  discardReservation(reservation: ExecutionReservation): boolean
  startReserved(
    reservation: ExecutionReservation,
    input: ExecutionStartInput,
    signal?: AbortSignal,
  ): Promise<StartedExecution | {
    id: string
    finished: Promise<{ id: string; status: string; result?: unknown; errorCode?: string }>
  }>
  cancel(executionId: string): Promise<void>
}

export interface WorkflowToolExecutorDependencies {
  executions: WorkflowToolExecutionPort
  policy: WorkflowToolPolicyPort
  currentDeveloperMode(): boolean
  inspectSource(selector: WorkflowExecutionSourceSelector): ExactWorkflowSource | undefined
  checkRemainingBudgets?(): AppErrorCode | undefined
  now?: () => number
}

export interface PrepareWorkflowToolInput {
  candidate: WorkflowCandidate
  arguments: unknown
  developerMode: boolean
}

export interface PendingWorkflowTool {
  readonly candidate: WorkflowCandidate
  readonly reservation: ExecutionReservation
  readonly executionId: string
  readonly source: ExactWorkflowSource
  readonly city: string | undefined
  readonly input: unknown
  readonly preparedAt: number
  permissionIndex: number
  capability: Capability | undefined
  scope: CapabilityScope | undefined
  scopeHash: string | undefined
  actionSummary: string | undefined
}

export type ToolError = { kind: 'tool_error'; code: AppErrorCode; message?: string }

export type ToolPreparation =
  | ToolError
  | { kind: 'awaiting_approval'; pending: PendingWorkflowTool }
  | { kind: 'ready'; pending: PendingWorkflowTool }

export type ToolStart = ToolError | {
  kind: 'started'
  executionId: string
  finished: Promise<ExecutionCompletion | { id: string; status: string; result?: unknown; errorCode?: string }>
}

export type ToolModelResult = ToolError | { kind: 'tool_result'; content: string }

type PendingPhase = 'awaiting_approval' | 'ready' | 'started' | 'discarded'

interface PendingLifecycle {
  phase: PendingPhase
  cancelRequested: boolean
  discarded: boolean
  released: boolean
}

interface ParsedArguments {
  city: string | undefined
  input: unknown
}

function toolError(code: AppErrorCode, message?: string): ToolError {
  return message === undefined ? { kind: 'tool_error', code } : { kind: 'tool_error', code, message }
}

function exactSourceMatchesCandidate(source: ExactWorkflowSource | undefined, candidate: WorkflowCandidate): source is ExactWorkflowSource {
  if (!source) return false
  const workflow = candidate.workflow
  if (source.id !== workflow.id
    || source.version !== workflow.version
    || source.source !== workflow.source
    || source.id !== workflow.runtimeIdentity.id
    || source.version !== workflow.runtimeIdentity.version
    || source.source !== workflow.runtimeIdentity.source) return false
  if (source.source === 'installed') {
    return workflow.codeSha256 !== undefined && source.codeSha256 === workflow.codeSha256
  }
  return workflow.runtimeIdentity.source === 'development'
    && source.buildHash === workflow.runtimeIdentity.buildHash
}

function sameExactSource(left: ExactWorkflowSource, right: ExactWorkflowSource): boolean {
  if (left.id !== right.id || left.version !== right.version || left.source !== right.source) return false
  return left.source === 'installed' && right.source === 'installed'
    ? left.codeSha256 === right.codeSha256
    : left.source === 'development' && right.source === 'development'
      && left.buildHash === right.buildHash
}

function parseArguments(candidate: WorkflowCandidate, value: unknown): ParsedArguments | ToolError {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return toolError('INVALID_INPUT')
  const record = value as Record<string, unknown>
  const restricted = candidate.workflow.cities.length > 0
  const allowed = new Set(restricted ? ['resolvedCity', 'input'] : ['input'])
  if (!Object.keys(record).every((key) => allowed.has(key))
    || !Object.prototype.hasOwnProperty.call(record, 'input')) return toolError('INVALID_INPUT')

  if (restricted) {
    if (!Object.prototype.hasOwnProperty.call(record, 'resolvedCity') || record.resolvedCity === undefined) {
      return toolError('CITY_REQUIRED')
    }
    if (typeof record.resolvedCity !== 'string' || !candidate.workflow.cities.includes(record.resolvedCity)) {
      return toolError('CITY_NOT_SUPPORTED')
    }
    return { city: record.resolvedCity, input: record.input }
  }
  return { city: undefined, input: record.input }
}

function safeSummaryValue(value: unknown, seen: WeakSet<object>, depth = 0): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return value.slice(0, 120)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value !== 'object') return String(value).slice(0, 120)
  if (seen.has(value)) return '[circular]'
  if (depth >= 4) return '[nested]'
  seen.add(value)
  if (Array.isArray(value)) {
    return value.slice(0, 10).map((child) => safeSummaryValue(child, seen, depth + 1))
  }
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value).slice(0, 12)) {
    output[key.slice(0, 80)] = SENSITIVE_KEY.test(key) ? '***' : safeSummaryValue(child, seen, depth + 1)
  }
  return output
}

function actionSummary(candidate: WorkflowCandidate, capability: Capability, city: string | undefined, input: unknown): string {
  let parameters: string
  try {
    parameters = JSON.stringify(safeSummaryValue(input, new WeakSet<object>())) ?? 'null'
  } catch {
    parameters = '[unavailable]'
  }
  return `${candidate.workflow.name} · ${capability} · 城市：${city ?? '不限城市'} · 参数：${parameters}`
    .slice(0, MAX_ACTION_SUMMARY_LENGTH)
}

function currentPermission(pending: PendingWorkflowTool): WorkflowCandidate['workflow']['permissions'][number] | undefined {
  return pending.candidate.workflow.permissions[pending.permissionIndex]
}

export class WorkflowToolExecutor {
  private readonly lifecycle = new WeakMap<PendingWorkflowTool, PendingLifecycle>()
  private readonly now: () => number

  constructor(private readonly dependencies: WorkflowToolExecutorDependencies) {
    this.now = dependencies.now ?? Date.now
  }

  async prepare(input: PrepareWorkflowToolInput): Promise<ToolPreparation> {
    const budgetError = this.checkBudgets()
    if (budgetError) return budgetError
    if (input.candidate.workflow.source === 'development') {
      let currentMode: boolean
      try { currentMode = this.dependencies.currentDeveloperMode() } catch { return toolError('INTERNAL_ERROR') }
      if (!input.developerMode || !currentMode) return toolError('WORKFLOW_CHANGED')
    }

    let source: ExactWorkflowSource | undefined
    try { source = this.dependencies.inspectSource(input.candidate.selector) } catch { return toolError('INTERNAL_ERROR') }
    if (!exactSourceMatchesCandidate(source, input.candidate)) return toolError('WORKFLOW_CHANGED')

    let parsed: ParsedArguments | ToolError
    try { parsed = parseArguments(input.candidate, input.arguments) } catch { return toolError('INVALID_INPUT') }
    if ('kind' in parsed) return parsed

    let validatedInput: unknown
    try {
      validatedInput = structuredClone(parsed.input)
      const validation = validateWorkflowInput(input.candidate.workflow.inputSchema, validatedInput)
      if (!validation.valid) return toolError('INVALID_INPUT', validation.message.slice(0, 500))
    } catch {
      return toolError('INVALID_INPUT')
    }

    for (const permission of input.candidate.workflow.permissions) {
      const risk = classifyCapability(permission.capability)
      if (risk === 'unsupported' || risk === 'unknown') return toolError('CAPABILITY_SCOPE_DENIED')
    }

    let reservation: ExecutionReservation
    try { reservation = this.dependencies.executions.reserve() } catch { return toolError('INTERNAL_ERROR') }
    const pending: PendingWorkflowTool = {
      candidate: input.candidate,
      reservation,
      executionId: reservation.executionId,
      source: structuredClone(source),
      city: parsed.city,
      input: validatedInput,
      preparedAt: this.now(),
      permissionIndex: 0,
      capability: undefined,
      scope: undefined,
      scopeHash: undefined,
      actionSummary: undefined,
    }
    this.lifecycle.set(pending, {
      phase: 'ready', cancelRequested: false, discarded: false, released: false,
    })
    return this.advancePermissions(pending)
  }

  async approve(pending: PendingWorkflowTool, decision: ApprovalDecision): Promise<ToolPreparation> {
    const lifecycle = this.lifecycle.get(pending)
    if (!lifecycle || lifecycle.phase !== 'awaiting_approval') return toolError('CONFLICT')
    const parsed = approvalDecisionSchema.safeParse(decision)
    if (!parsed.success || parsed.data.decision === 'always') return toolError('INVALID_INPUT')
    if (parsed.data.decision !== 'once') return toolError('INVALID_INPUT')
    if (!this.matchesDecision(pending, parsed.data)) return toolError('CONFLICT')
    const permission = currentPermission(pending)
    if (!permission) return toolError('CONFLICT')
    try {
      this.dependencies.policy.record({
        executionId: pending.executionId,
        workflowId: pending.candidate.workflow.id,
        workflowVersion: pending.candidate.workflow.version,
        capability: permission.capability,
        scope: permission.scope,
        decision: 'once',
      })
    } catch {
      this.cleanupPending(pending)
      return toolError('INTERNAL_ERROR')
    }
    pending.permissionIndex += 1
    lifecycle.phase = 'ready'
    return this.advancePermissions(pending)
  }

  async deny(pending: PendingWorkflowTool, decision: ApprovalDecision): Promise<ToolError> {
    const lifecycle = this.lifecycle.get(pending)
    if (!lifecycle || lifecycle.phase !== 'awaiting_approval') return toolError('CONFLICT')
    const parsed = approvalDecisionSchema.safeParse(decision)
    if (!parsed.success || parsed.data.decision !== 'deny') return toolError('INVALID_INPUT')
    if (!this.matchesDecision(pending, parsed.data)) return toolError('CONFLICT')
    this.cleanupPending(pending)
    return toolError('PERMISSION_DENIED')
  }

  async start(
    pending: PendingWorkflowTool,
    input: { userId: string; chatRunId?: string; signal?: AbortSignal },
  ): Promise<ToolStart> {
    const lifecycle = this.lifecycle.get(pending)
    if (!lifecycle || lifecycle.phase !== 'ready') return toolError('CONFLICT')
    const budgetError = this.checkBudgets()
    if (budgetError) {
      this.cleanupPending(pending)
      return budgetError
    }
    if (pending.candidate.workflow.source === 'development') {
      let currentMode: boolean
      try { currentMode = this.dependencies.currentDeveloperMode() } catch {
        this.cleanupPending(pending)
        return toolError('INTERNAL_ERROR')
      }
      if (!currentMode) {
        this.cleanupPending(pending)
        return toolError('WORKFLOW_CHANGED')
      }
    }
    let source: ExactWorkflowSource | undefined
    try { source = this.dependencies.inspectSource(pending.candidate.selector) } catch {
      this.cleanupPending(pending)
      return toolError('INTERNAL_ERROR')
    }
    if (!exactSourceMatchesCandidate(source, pending.candidate) || !sameExactSource(source, pending.source)) {
      this.cleanupPending(pending)
      return toolError('WORKFLOW_CHANGED')
    }

    lifecycle.phase = 'started'
    let started: Awaited<ReturnType<WorkflowToolExecutionPort['startReserved']>>
    try {
      started = await this.dependencies.executions.startReserved(pending.reservation, {
        userId: input.userId,
        workflowId: pending.candidate.workflow.id,
        workflowVersion: pending.candidate.workflow.version,
        input: pending.input,
        ...(input.chatRunId === undefined ? {} : { chatRunId: input.chatRunId }),
        sourceSelector: pending.candidate.selector,
      }, input.signal)
    } catch (error) {
      this.releaseGrants(pending)
      return toolError(toSafeAppError(error).code)
    }
    if (started.id !== pending.executionId) {
      try { await this.dependencies.executions.cancel(started.id) } catch { /* Fail closed on an inconsistent execution port. */ }
      this.releaseGrants(pending)
      return toolError('CONFLICT')
    }
    const finished = Promise.resolve(started.finished).finally(() => { this.releaseGrants(pending) })
    return { kind: 'started', executionId: pending.executionId, finished }
  }

  async cancel(pending: PendingWorkflowTool): Promise<void> {
    const lifecycle = this.lifecycle.get(pending)
    if (!lifecycle || lifecycle.phase === 'discarded') return
    if (lifecycle.phase === 'started') {
      if (lifecycle.cancelRequested) return
      lifecycle.cancelRequested = true
      try { await this.dependencies.executions.cancel(pending.executionId) } catch { /* Cancellation remains best effort. */ }
      return
    }
    this.cleanupPending(pending)
  }

  toModelResult(input:
    | { result: unknown; contextLength?: number }
    | { error: unknown; contextLength?: number }): ToolModelResult {
    if ('error' in input) {
      const safe = toSafeAppError(input.error)
      return toolError(safe.code, safe.message)
    }
    let serialized: string
    try { serialized = JSON.stringify(input.result) ?? 'null' } catch { return toolError('INTERNAL_ERROR') }
    const tokenLimit = Math.floor(resolveChatInputBudget(input.contextLength) * 0.25)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_MODEL_RESULT_BYTES
      || estimateTextTokens(serialized) > tokenLimit) return toolError('RESULT_TOO_LARGE')
    return { kind: 'tool_result', content: serialized }
  }

  private advancePermissions(pending: PendingWorkflowTool): ToolPreparation {
    const lifecycle = this.lifecycle.get(pending)
    if (!lifecycle || lifecycle.phase === 'discarded' || lifecycle.phase === 'started') return toolError('CONFLICT')
    while (pending.permissionIndex < pending.candidate.workflow.permissions.length) {
      const permission = currentPermission(pending)!
      const risk = classifyCapability(permission.capability)
      if (risk === 'safe_navigation') {
        try {
          this.dependencies.policy.record({
            executionId: pending.executionId,
            workflowId: pending.candidate.workflow.id,
            workflowVersion: pending.candidate.workflow.version,
            capability: permission.capability,
            scope: permission.scope,
            decision: 'once',
          })
        } catch {
          this.cleanupPending(pending)
          return toolError('INTERNAL_ERROR')
        }
        pending.permissionIndex += 1
        continue
      }
      if (risk === 'unsupported' || risk === 'unknown') {
        this.cleanupPending(pending)
        return toolError('CAPABILITY_SCOPE_DENIED')
      }
      pending.capability = permission.capability
      pending.scope = permission.scope
      pending.scopeHash = scopeHash(permission.scope)
      pending.actionSummary = actionSummary(pending.candidate, permission.capability, pending.city, pending.input)
      lifecycle.phase = 'awaiting_approval'
      return { kind: 'awaiting_approval', pending }
    }
    pending.capability = undefined
    pending.scope = undefined
    pending.scopeHash = undefined
    pending.actionSummary = undefined
    lifecycle.phase = 'ready'
    return { kind: 'ready', pending }
  }

  private matchesDecision(
    pending: PendingWorkflowTool,
    decision: Extract<ApprovalDecision, { decision: 'once' | 'deny' }>,
  ): boolean {
    return decision.executionId === pending.executionId
      && decision.permissionIndex === pending.permissionIndex
      && decision.scopeHash === pending.scopeHash
  }

  private checkBudgets(): ToolError | undefined {
    try {
      const code = this.dependencies.checkRemainingBudgets?.()
      return code === undefined ? undefined : toolError(code)
    } catch {
      return toolError('INTERNAL_ERROR')
    }
  }

  private cleanupPending(pending: PendingWorkflowTool): void {
    const lifecycle = this.lifecycle.get(pending)
    if (!lifecycle || lifecycle.phase === 'started') return
    lifecycle.phase = 'discarded'
    if (!lifecycle.discarded) {
      lifecycle.discarded = true
      try { this.dependencies.executions.discardReservation(pending.reservation) } catch { /* Cleanup is best effort. */ }
    }
    this.releaseGrants(pending)
  }

  private releaseGrants(pending: PendingWorkflowTool): void {
    const lifecycle = this.lifecycle.get(pending)
    if (!lifecycle || lifecycle.released) return
    lifecycle.released = true
    try { this.dependencies.policy.releaseExecution(pending.executionId) } catch { /* Cleanup is best effort. */ }
  }
}
