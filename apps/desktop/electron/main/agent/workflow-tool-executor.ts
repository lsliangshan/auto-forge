import {
  approvalDecisionSchema,
  toSafeAppError,
  type AppErrorCode,
  type ApprovalDecision,
  type Capability,
  type CapabilityScope,
  type WorkflowDetail,
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
  /** Invocation transfers a valid reservation and all execution-scoped grants to this port. */
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
  resolveCurrentWorkflow(
    selector: WorkflowExecutionSourceSelector,
    id: string,
    version: string,
  ): Promise<WorkflowDetail | undefined>
  checkRemainingBudgets(input: WorkflowToolRunBudget & { phase: 'prepare' | 'start' }): AppErrorCode | undefined
  now?: () => number
}

export interface WorkflowToolRunBudget {
  requestId: string
  runId: string
  toolExecutions: number
  modelDecisions: number
}

export interface PrepareWorkflowToolInput {
  candidate: WorkflowCandidate
  arguments: unknown
  developerMode: boolean
  budget: WorkflowToolRunBudget
}

export interface PendingWorkflowTool {
  readonly candidate: WorkflowCandidate
  readonly reservation: ExecutionReservation
  readonly executionId: string
  readonly source: ExactWorkflowSource
  readonly city: string | undefined
  readonly input: unknown
  readonly preparedAt: number
  readonly permissionIndex: number
  readonly capability: Capability | undefined
  readonly scope: CapabilityScope | undefined
  readonly scopeHash: string | undefined
  readonly actionSummary: string | undefined
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

type PendingPhase = 'awaiting_approval' | 'ready' | 'starting' | 'started' | 'discarded'

interface PendingBinding {
  readonly candidate: WorkflowCandidate
  readonly candidateReference: WorkflowCandidate
  readonly candidateFingerprint: string
  readonly reservation: ExecutionReservation
  readonly executionId: string
  readonly source: ExactWorkflowSource
  readonly sourceFingerprint: string
  readonly city: string | undefined
  readonly input: unknown
  readonly inputFingerprint: string
  readonly preparedAt: number
}

interface ApprovalBinding {
  readonly permissionIndex: number
  readonly capability: Capability
  readonly scope: CapabilityScope
  readonly scopeHash: string
  readonly actionSummary: string
}

interface PendingLifecycle {
  phase: PendingPhase
  cancelRequested: boolean
  discarded: boolean
  released: boolean
  permissionIndex: number
  approval: ApprovalBinding | undefined
  binding: PendingBinding
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

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor && 'value' in descriptor) deepFreeze(descriptor.value, seen)
  }
  return Object.freeze(value)
}

function stableJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite JSON number')
    return JSON.stringify(value)
  }
  if (typeof value !== 'object') throw new TypeError('Non-JSON value')
  if (seen.has(value)) throw new TypeError('Circular JSON value')
  seen.add(value)
  try {
    if (Array.isArray(value)) return `[${value.map((child) => stableJson(child, seen)).join(',')}]`
    const values: string[] = []
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key]
      if (child !== undefined) values.push(`${JSON.stringify(key)}:${stableJson(child, seen)}`)
    }
    return `{${values.join(',')}}`
  } finally {
    seen.delete(value)
  }
}

function workflowSecurityFingerprint(workflow: WorkflowDetail): string {
  return stableJson({
    id: workflow.id,
    version: workflow.version,
    name: workflow.name,
    description: workflow.description,
    author: workflow.author,
    category: workflow.category,
    enabled: workflow.enabled,
    source: workflow.source,
    integrity: workflow.integrity,
    codeSha256: workflow.codeSha256,
    runtimeIdentity: workflow.runtimeIdentity,
    cities: workflow.cities,
    permissions: workflow.permissions,
    activationExamples: workflow.activationExamples,
    activationNegativeExamples: workflow.activationNegativeExamples,
    timeoutMs: workflow.timeoutMs,
    inputSchema: workflow.inputSchema,
    outputSchema: workflow.outputSchema,
  })
}

function candidateSnapshot(candidate: WorkflowCandidate): WorkflowCandidate {
  return Object.freeze({
    ...candidate,
    workflow: deepFreeze(structuredClone(candidate.workflow)),
    tool: deepFreeze(structuredClone(candidate.tool)),
  })
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
  let included = 0
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)
      || !Object.prototype.propertyIsEnumerable.call(value, key)) continue
    output[key.slice(0, 80)] = SENSITIVE_KEY.test(key)
      ? '***'
      : safeSummaryValue((value as Record<string, unknown>)[key], seen, depth + 1)
    included += 1
    if (included >= 12) break
  }
  return output
}

export function createWorkflowActionSummary(
  workflow: WorkflowDetail,
  capability: Capability,
  city: string | undefined,
  input: unknown,
): string {
  let parameters: string
  try {
    parameters = JSON.stringify(safeSummaryValue(input, new WeakSet<object>())) ?? 'null'
  } catch {
    parameters = '[unavailable]'
  }
  return `${workflow.name} · ${capability} · 城市：${city ?? '不限城市'} · 参数：${parameters}`
    .slice(0, MAX_ACTION_SUMMARY_LENGTH)
}

export class WorkflowToolExecutor {
  private readonly lifecycle = new WeakMap<PendingWorkflowTool, PendingLifecycle>()
  private readonly now: () => number

  constructor(private readonly dependencies: WorkflowToolExecutorDependencies) {
    this.now = dependencies.now ?? Date.now
  }

  async prepare(input: PrepareWorkflowToolInput): Promise<ToolPreparation> {
    const budgetError = this.checkBudgets(input.budget, 'prepare')
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
    let inputFingerprint: string
    try {
      validatedInput = structuredClone(parsed.input)
      const validation = validateWorkflowInput(input.candidate.workflow.inputSchema, validatedInput)
      if (!validation.valid) return toolError('INVALID_INPUT', validation.message.slice(0, 500))
      inputFingerprint = stableJson(validatedInput)
    } catch {
      return toolError('INVALID_INPUT')
    }

    for (const permission of input.candidate.workflow.permissions) {
      const risk = classifyCapability(permission.capability)
      if (risk === 'unsupported' || risk === 'unknown') return toolError('CAPABILITY_SCOPE_DENIED')
    }

    let reservation: ExecutionReservation
    try { reservation = this.dependencies.executions.reserve() } catch { return toolError('INTERNAL_ERROR') }
    let snapshot: WorkflowCandidate
    let sourceSnapshot: ExactWorkflowSource
    let inputSnapshot: unknown
    let candidateFingerprint: string
    try {
      snapshot = candidateSnapshot(input.candidate)
      sourceSnapshot = deepFreeze(structuredClone(source))
      inputSnapshot = deepFreeze(validatedInput)
      candidateFingerprint = workflowSecurityFingerprint(input.candidate.workflow)
    } catch {
      try { this.dependencies.executions.discardReservation(reservation) } catch { /* No Worker owns this reservation. */ }
      try { this.dependencies.policy.releaseExecution(reservation.executionId) } catch { /* Cleanup remains best effort. */ }
      return toolError('INVALID_INPUT')
    }
    const binding: PendingBinding = Object.freeze({
      candidate: snapshot,
      candidateReference: input.candidate,
      candidateFingerprint,
      reservation,
      executionId: reservation.executionId,
      source: sourceSnapshot,
      sourceFingerprint: stableJson(sourceSnapshot),
      city: parsed.city,
      input: inputSnapshot,
      inputFingerprint,
      preparedAt: this.now(),
    })
    const state: PendingLifecycle = {
      phase: 'ready', cancelRequested: false, discarded: false, released: false,
      permissionIndex: 0, approval: undefined, binding,
    }
    const pending = Object.freeze({
      candidate: binding.candidate,
      reservation: binding.reservation,
      executionId: binding.executionId,
      source: binding.source,
      city: binding.city,
      input: binding.input,
      preparedAt: binding.preparedAt,
      get permissionIndex() { return state.permissionIndex },
      get capability() { return state.approval?.capability },
      get scope() { return state.approval?.scope },
      get scopeHash() { return state.approval?.scopeHash },
      get actionSummary() { return state.approval?.actionSummary },
    }) satisfies PendingWorkflowTool
    this.lifecycle.set(pending, state)
    return this.advancePermissions(pending)
  }

  async approve(pending: PendingWorkflowTool, decision: ApprovalDecision): Promise<ToolPreparation> {
    const lifecycle = this.lifecycle.get(pending)
    if (!lifecycle || lifecycle.phase !== 'awaiting_approval') return toolError('CONFLICT')
    if (!this.pendingMatchesBinding(pending, lifecycle, true)) return toolError('CONFLICT')
    const parsed = approvalDecisionSchema.safeParse(decision)
    if (!parsed.success || parsed.data.decision === 'always') return toolError('INVALID_INPUT')
    if (parsed.data.decision !== 'once') return toolError('INVALID_INPUT')
    if (!this.matchesDecision(pending, parsed.data)) return toolError('CONFLICT')
    const approval = lifecycle.approval
    if (!approval) return toolError('CONFLICT')
    try {
      this.dependencies.policy.record({
        executionId: lifecycle.binding.executionId,
        workflowId: lifecycle.binding.candidate.workflow.id,
        workflowVersion: lifecycle.binding.candidate.workflow.version,
        capability: approval.capability,
        scope: approval.scope,
        decision: 'once',
      })
    } catch {
      this.cleanupPending(pending)
      return toolError('INTERNAL_ERROR')
    }
    lifecycle.permissionIndex += 1
    lifecycle.approval = undefined
    lifecycle.phase = 'ready'
    return this.advancePermissions(pending)
  }

  async deny(pending: PendingWorkflowTool, decision: ApprovalDecision): Promise<ToolError> {
    const lifecycle = this.lifecycle.get(pending)
    if (!lifecycle || lifecycle.phase !== 'awaiting_approval') return toolError('CONFLICT')
    if (!this.pendingMatchesBinding(pending, lifecycle, true)) return toolError('CONFLICT')
    const parsed = approvalDecisionSchema.safeParse(decision)
    if (!parsed.success || parsed.data.decision !== 'deny') return toolError('INVALID_INPUT')
    if (!this.matchesDecision(pending, parsed.data)) return toolError('CONFLICT')
    this.cleanupPending(pending)
    return toolError('PERMISSION_DENIED')
  }

  async start(
    pending: PendingWorkflowTool,
    input: { userId: string; chatRunId?: string; signal?: AbortSignal; budget: WorkflowToolRunBudget },
  ): Promise<ToolStart> {
    const lifecycle = this.lifecycle.get(pending)
    if (!lifecycle || lifecycle.phase !== 'ready') return toolError('CONFLICT')
    const budgetError = this.checkBudgets(input.budget, 'start')
    if (budgetError) {
      this.cleanupPending(pending)
      return budgetError
    }
    if (!this.pendingMatchesBinding(pending, lifecycle, false)) return toolError('CONFLICT')
    const binding = lifecycle.binding
    if (binding.candidate.workflow.source === 'development') {
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
    try { source = this.dependencies.inspectSource(binding.candidate.selector) } catch {
      this.cleanupPending(pending)
      return toolError('INTERNAL_ERROR')
    }
    if (!exactSourceMatchesCandidate(source, binding.candidate) || !sameExactSource(source, binding.source)) {
      this.cleanupPending(pending)
      return toolError('WORKFLOW_CHANGED')
    }

    let currentWorkflow: WorkflowDetail | undefined
    try {
      currentWorkflow = await this.dependencies.resolveCurrentWorkflow(
        binding.candidate.selector,
        binding.candidate.workflow.id,
        binding.candidate.workflow.version,
      )
    } catch {
      this.cleanupPending(pending)
      return toolError('INTERNAL_ERROR')
    }
    if (lifecycle.phase !== 'ready' || input.signal?.aborted) {
      if (lifecycle.phase === 'ready') this.cleanupPending(pending)
      return toolError('CANCELLED')
    }
    if (!this.pendingMatchesBinding(pending, lifecycle, false)) {
      this.cleanupPending(pending)
      return toolError('CONFLICT')
    }
    try {
      if (!currentWorkflow
        || workflowSecurityFingerprint(currentWorkflow) !== binding.candidateFingerprint
        || !exactSourceMatchesCandidate(binding.source, { ...binding.candidate, workflow: currentWorkflow })) {
        this.cleanupPending(pending)
        return toolError('WORKFLOW_CHANGED')
      }
    } catch {
      this.cleanupPending(pending)
      return toolError('WORKFLOW_CHANGED')
    }

    if (binding.candidate.workflow.source === 'development') {
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
    try { source = this.dependencies.inspectSource(binding.candidate.selector) } catch {
      this.cleanupPending(pending)
      return toolError('INTERNAL_ERROR')
    }
    if (!exactSourceMatchesCandidate(source, binding.candidate) || !sameExactSource(source, binding.source)) {
      this.cleanupPending(pending)
      return toolError('WORKFLOW_CHANGED')
    }

    lifecycle.phase = 'starting'
    let startPromise: ReturnType<WorkflowToolExecutionPort['startReserved']>
    try {
      startPromise = this.dependencies.executions.startReserved(binding.reservation, {
        userId: input.userId,
        workflowId: binding.candidate.workflow.id,
        workflowVersion: binding.candidate.workflow.version,
        input: binding.input,
        ...(input.chatRunId === undefined ? {} : { chatRunId: input.chatRunId }),
        sourceSelector: binding.candidate.selector,
      }, input.signal)
    } catch (error) {
      lifecycle.phase = 'started'
      return toolError(toSafeAppError(error).code)
    }
    lifecycle.phase = 'started'
    let started: Awaited<ReturnType<WorkflowToolExecutionPort['startReserved']>>
    try {
      started = await startPromise
    } catch (error) {
      return toolError(toSafeAppError(error).code)
    }
    if (started.id !== binding.executionId) {
      void Promise.resolve(started.finished).catch(() => undefined)
      try { await this.dependencies.executions.cancel(binding.executionId) } catch { /* Cancellation remains best effort. */ }
      return toolError('CONFLICT')
    }
    const finished = Promise.resolve(started.finished).then((completion) => (
      completion.id === binding.executionId
        ? completion
        : { id: binding.executionId, status: 'failed', errorCode: 'CONFLICT' }
    ))
    return { kind: 'started', executionId: binding.executionId, finished }
  }

  async cancel(pending: PendingWorkflowTool): Promise<void> {
    const lifecycle = this.lifecycle.get(pending)
    if (!lifecycle || lifecycle.phase === 'discarded') return
    if (lifecycle.phase === 'started' || lifecycle.phase === 'starting') {
      if (lifecycle.cancelRequested) return
      lifecycle.cancelRequested = true
      try { await this.dependencies.executions.cancel(lifecycle.binding.executionId) } catch { /* Cancellation remains best effort. */ }
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
    if (!lifecycle
      || lifecycle.phase === 'discarded'
      || lifecycle.phase === 'starting'
      || lifecycle.phase === 'started'
      || !this.pendingMatchesBinding(pending, lifecycle, false)) return toolError('CONFLICT')
    const binding = lifecycle.binding
    while (lifecycle.permissionIndex < binding.candidate.workflow.permissions.length) {
      const permission = binding.candidate.workflow.permissions[lifecycle.permissionIndex]!
      const risk = classifyCapability(permission.capability)
      if (risk === 'safe_navigation') {
        try {
          this.dependencies.policy.record({
            executionId: binding.executionId,
            workflowId: binding.candidate.workflow.id,
            workflowVersion: binding.candidate.workflow.version,
            capability: permission.capability,
            scope: permission.scope,
            decision: 'once',
          })
        } catch {
          this.cleanupPending(pending)
          return toolError('INTERNAL_ERROR')
        }
        lifecycle.permissionIndex += 1
        continue
      }
      if (risk === 'unsupported' || risk === 'unknown') {
        this.cleanupPending(pending)
        return toolError('CAPABILITY_SCOPE_DENIED')
      }
      const scope = deepFreeze(structuredClone(permission.scope))
      lifecycle.approval = Object.freeze({
        permissionIndex: lifecycle.permissionIndex,
        capability: permission.capability,
        scope,
        scopeHash: scopeHash(scope),
        actionSummary: createWorkflowActionSummary(
          binding.candidate.workflow,
          permission.capability,
          binding.city,
          binding.input,
        ),
      })
      lifecycle.phase = 'awaiting_approval'
      return { kind: 'awaiting_approval', pending }
    }
    lifecycle.approval = undefined
    lifecycle.phase = 'ready'
    return { kind: 'ready', pending }
  }

  private matchesDecision(
    pending: PendingWorkflowTool,
    decision: Extract<ApprovalDecision, { decision: 'once' | 'deny' }>,
  ): boolean {
    const lifecycle = this.lifecycle.get(pending)
    const approval = lifecycle?.approval
    return lifecycle !== undefined
      && approval !== undefined
      && decision.executionId === lifecycle.binding.executionId
      && decision.permissionIndex === approval.permissionIndex
      && decision.scopeHash === approval.scopeHash
  }

  private checkBudgets(budget: WorkflowToolRunBudget, phase: 'prepare' | 'start'): ToolError | undefined {
    try {
      const code = this.dependencies.checkRemainingBudgets({ ...budget, phase })
      return code === undefined ? undefined : toolError(code)
    } catch {
      return toolError('INTERNAL_ERROR')
    }
  }

  private cleanupPending(pending: PendingWorkflowTool): void {
    const lifecycle = this.lifecycle.get(pending)
    if (!lifecycle || lifecycle.phase === 'starting' || lifecycle.phase === 'started') return
    lifecycle.phase = 'discarded'
    if (!lifecycle.discarded) {
      lifecycle.discarded = true
      try { this.dependencies.executions.discardReservation(lifecycle.binding.reservation) } catch { /* Cleanup is best effort. */ }
    }
    this.releaseGrants(pending)
  }

  private pendingMatchesBinding(
    pending: PendingWorkflowTool,
    lifecycle: PendingLifecycle,
    requireApproval: boolean,
  ): boolean {
    const binding = lifecycle.binding
    try {
      if (pending.candidate !== binding.candidate
        || pending.reservation !== binding.reservation
        || pending.executionId !== binding.executionId
        || pending.city !== binding.city
        || pending.preparedAt !== binding.preparedAt
        || stableJson(pending.source) !== binding.sourceFingerprint
        || stableJson(pending.input) !== binding.inputFingerprint
        || pending.permissionIndex !== lifecycle.permissionIndex
        || binding.candidateReference.selector !== binding.candidate.selector
        || workflowSecurityFingerprint(binding.candidateReference.workflow) !== binding.candidateFingerprint) return false
      const approval = lifecycle.approval
      if (!requireApproval) {
        return approval === undefined
          && pending.capability === undefined
          && pending.scope === undefined
          && pending.scopeHash === undefined
          && pending.actionSummary === undefined
      }
      if (!approval
        || pending.capability !== approval.capability
        || pending.scope !== approval.scope
        || pending.scopeHash !== approval.scopeHash
        || pending.actionSummary !== approval.actionSummary) return false
      const currentPermission = binding.candidateReference.workflow.permissions[approval.permissionIndex]
      return currentPermission?.capability === approval.capability
        && scopeHash(currentPermission.scope) === approval.scopeHash
        && scopeHash(approval.scope) === approval.scopeHash
    } catch {
      return false
    }
  }

  private releaseGrants(pending: PendingWorkflowTool): void {
    const lifecycle = this.lifecycle.get(pending)
    if (!lifecycle || lifecycle.released) return
    lifecycle.released = true
    try { this.dependencies.policy.releaseExecution(lifecycle.binding.executionId) } catch { /* Cleanup is best effort. */ }
  }
}
