import type { AppErrorCode } from '@autoforge/shared'
import type { ModelStreamEvent } from '../chat/model-provider.js'
import { canonicalJson } from '../workflows/workflow-security-fingerprint.js'

export const MAX_WORKFLOW_EXECUTIONS = 5
export const MAX_MODEL_DECISIONS = 10
export const MAX_AGENT_ACTIVE_MS = 10 * 60_000
export const APPROVAL_EXPIRY_MS = 30 * 60_000

type ToolCall = Extract<ModelStreamEvent, { type: 'tool_call' }>
type ExecutionStatus = 'completed' | 'failed' | 'cancelled'

interface StartedCandidate {
  executionIndex: number
  inputJson: string
  retryable: boolean
  status?: ExecutionStatus
}

type LoopFailure = { kind: 'failed'; code: AppErrorCode }

export class WorkflowToolLoop {
  private readonly startedAt: number
  private readonly startsByCandidate = new Map<string, StartedCandidate[]>()
  private readonly startsByIndex = new Map<number, StartedCandidate>()
  private decisions = 0
  private starts = 0
  private browserActionCount = 0
  private repairedMultipleCalls = false
  private approvalStartedAt: number | undefined
  private pausedMs = 0

  constructor(private readonly options: { now: () => number }) {
    this.startedAt = options.now()
  }

  beginDecision(): { kind: 'decision'; decisionIndex: number } | LoopFailure {
    if (this.activeExpired()) return { kind: 'failed', code: 'MODEL_PROVIDER_TIMEOUT' }
    if (this.decisions >= MAX_MODEL_DECISIONS) return { kind: 'failed', code: 'TOOL_CALL_LIMIT' }
    this.decisions += 1
    return { kind: 'decision', decisionIndex: this.decisions }
  }

  acceptToolCalls(calls: readonly ToolCall[]):
    | { kind: 'none' }
    | { kind: 'accepted'; call: ToolCall }
    | { kind: 'repair' }
    | LoopFailure {
    if (calls.length === 0) return { kind: 'none' }
    if (calls.length === 1) return { kind: 'accepted', call: calls[0]! }
    if (!this.repairedMultipleCalls) {
      this.repairedMultipleCalls = true
      return { kind: 'repair' }
    }
    return { kind: 'failed', code: 'INVALID_TOOL_SEQUENCE' }
  }

  startExecution(
    candidateKey: string,
    retryable: boolean,
    input: unknown,
  ): { kind: 'started'; executionIndex: number } | LoopFailure {
    if (this.activeExpired()) return { kind: 'failed', code: 'MODEL_PROVIDER_TIMEOUT' }
    if (this.starts >= MAX_WORKFLOW_EXECUTIONS) return { kind: 'failed', code: 'TOOL_CALL_LIMIT' }

    const eligibility = this.stableExecutionEligibility(candidateKey, retryable, input)
    if (eligibility.kind === 'failed') return eligibility
    const inputJson = eligibility.inputJson
    const previous = this.startsByCandidate.get(candidateKey) ?? []

    this.starts += 1
    const started: StartedCandidate = {
      executionIndex: this.starts,
      inputJson,
      retryable,
    }
    previous.push(started)
    this.startsByCandidate.set(candidateKey, previous)
    this.startsByIndex.set(started.executionIndex, started)
    return { kind: 'started', executionIndex: started.executionIndex }
  }

  executionEligibility(
    candidateKey: string,
    retryable: boolean,
    input: unknown,
  ): { kind: 'eligible' } | LoopFailure {
    const eligibility = this.stableExecutionEligibility(candidateKey, retryable, input)
    return eligibility.kind === 'eligible' ? { kind: 'eligible' } : eligibility
  }

  private stableExecutionEligibility(
    candidateKey: string,
    retryable: boolean,
    input: unknown,
  ): { kind: 'eligible'; inputJson: string } | LoopFailure {
    let inputJson: string
    try { inputJson = canonicalJson(input) } catch { return { kind: 'failed', code: 'INVALID_INPUT' } }
    const previous = this.startsByCandidate.get(candidateKey) ?? []
    if (previous.length === 0) return { kind: 'eligible', inputJson }
    const first = previous[0]!
    const isChangedFailedReadOnlyRetry = previous.length === 1
      && first.status === 'failed'
      && first.retryable
      && retryable
      && first.inputJson !== inputJson
    return isChangedFailedReadOnlyRetry
      ? { kind: 'eligible', inputJson }
      : { kind: 'failed', code: 'INVALID_TOOL_SEQUENCE' }
  }

  finishExecution(executionIndex: number, status: ExecutionStatus): void {
    const started = this.startsByIndex.get(executionIndex)
    if (started && started.status === undefined) started.status = status
  }

  canOfferTools(): boolean {
    return this.starts < MAX_WORKFLOW_EXECUTIONS
  }

  modelDecisions(): number {
    return this.decisions
  }

  workflowExecutions(): number {
    return this.starts
  }

  recordBrowserActions(count: number):
    | { kind: 'recorded'; browserActions: number }
    | LoopFailure {
    if (!Number.isInteger(count) || count < 1) return { kind: 'failed', code: 'INVALID_INPUT' }
    this.browserActionCount += count
    return { kind: 'recorded', browserActions: this.browserActionCount }
  }

  browserActions(): number {
    return this.browserActionCount
  }

  awaitApproval(): void {
    if (this.approvalStartedAt === undefined) this.approvalStartedAt = this.options.now()
  }

  approvalExpired(): boolean {
    return this.approvalStartedAt !== undefined
      && this.options.now() - this.approvalStartedAt >= APPROVAL_EXPIRY_MS
  }

  awaitingApproval(): boolean {
    return this.approvalStartedAt !== undefined
  }

  resumeApproval(): { kind: 'resumed' } | LoopFailure {
    if (this.approvalStartedAt === undefined) return { kind: 'resumed' }
    if (this.approvalExpired()) return { kind: 'failed', code: 'CANCELLED' }
    this.pausedMs += this.options.now() - this.approvalStartedAt
    this.approvalStartedAt = undefined
    return { kind: 'resumed' }
  }

  activeElapsedMs(): number {
    const currentApprovalMs = this.approvalStartedAt === undefined
      ? 0
      : this.options.now() - this.approvalStartedAt
    return Math.max(0, this.options.now() - this.startedAt - this.pausedMs - currentApprovalMs)
  }

  activeExpired(): boolean {
    return this.activeElapsedMs() >= MAX_AGENT_ACTIVE_MS
  }
}
