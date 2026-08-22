import { randomUUID } from 'node:crypto'
import Ajv from 'ajv'
import {
  approvalDecisionSchema,
  toSafeAppError,
  type AppError,
  type ApprovalDecision,
  type ChatBlock,
  type ChatEvent,
  type ModelProviderId,
  type WorkflowDetail,
} from '@autoforge/shared'
import { scopeHash, type PolicyEngine, type PermissionRecord, type PermissionRequest } from '../permissions/policy-engine.js'
import type { ExecutionReservation, ExecutionStartInput, StartedExecution } from '../workflows/execution-service.js'
import type { WorkflowExecutionSourceSelector } from '../workflows/workflow-source-selector.js'
import { retrieveWorkflows } from '../workflows/retriever.js'
import { addUsd } from '../billing/decimal-usd.js'
import { trackProviderStream } from '../billing/provider-usage-stream.js'
import {
  ProviderUsageConsistencyError,
  type AppRepositories,
  type ProviderUsageRepository,
} from '../database/repositories.js'
import type {
  ModelContentPart,
  ModelMessage,
  ModelProviderSnapshot,
  ModelStreamEvent,
  ModelStreamRequest,
  ModelTool,
} from '../chat/model-provider.js'
import type { ConversationHistoryPort, CurrentMediaMetadata } from '../chat/conversation-context.js'
import { createWorkflowCatalog, type WorkflowCandidate } from './workflow-catalog.js'

const MAX_MODEL_TURNS = 8
const RETRIEVAL_LIMIT = 8

export type ProviderStreamEvent = ModelStreamEvent

export interface AgentProviderPort {
  stream(request: ModelStreamRequest): AsyncIterable<ModelStreamEvent>
}

export interface AgentWorkflowPort {
  list(options?: { developerMode?: boolean }): Promise<WorkflowDetail[]>
}

export interface AgentPolicyPort {
  evaluate(request: PermissionRequest): { allowed: boolean; requiresApproval: boolean }
  record(record: PermissionRecord): unknown
  releaseExecution(executionId: string): void
}

export interface AgentExecutionPort {
  reserve(): ExecutionReservation
  discardReservation(reservation: ExecutionReservation): boolean
  startReserved(
    reservation: ExecutionReservation,
    input: ExecutionStartInput,
    signal?: AbortSignal,
  ): Promise<StartedExecution | { id: string; finished: Promise<{ id: string; status: string; result?: unknown; errorCode?: string }> }>
  cancel(executionId: string): Promise<void>
}

export interface PersistUserInput {
  messageId: string
  conversationId: string
  blocks: ChatBlock[]
  assetIds: string[]
  createdAt: number
}

export interface PersistedUserPosition {
  ordinal: number
}

export interface CreateRunInput {
  runId: string
  conversationId: string
  requestId: string
  userId: string
  provider: ModelProviderId
  model: string
  startedAt: number
}

export interface CreateAssistantInput {
  messageId: string
  conversationId: string
  initialBlocks: ChatBlock[]
  createdAt: number
}

export interface StartMediaGenerationInput {
  user: PersistUserInput
  run: CreateRunInput
  assistant: CreateAssistantInput
}

export interface FinalizeAgentRunInput {
  runId: string
  requestId: string
  messageId: string
  blocks: ChatBlock[]
  status: 'completed' | 'failed' | 'cancelled'
  endedAt: number
  generationId?: string
  inputTokens?: number
  outputTokens?: number
  costUsd?: string
  errorCode?: string
}

/** The final method must commit the assistant blocks and chat-run terminal state atomically. */
export interface AgentPersistencePort {
  persistUser(input: PersistUserInput): PersistedUserPosition
  createRun(input: CreateRunInput): void
  createAssistant(input: CreateAssistantInput): void
  startMediaGeneration(input: StartMediaGenerationInput): void
  updateAssistant(messageId: string, blocks: ChatBlock[]): unknown
  replaceAssistantBlock(messageId: string, blockId: string, block: ChatBlock): unknown
  finalize(input: FinalizeAgentRunInput): void
}

export function createAgentPersistence(
  repositories: Pick<AppRepositories, 'messages' | 'chatRuns'>,
): AgentPersistencePort {
  return {
    persistUser(input) {
      const message = repositories.messages.insertWithAssets({
        id: input.messageId,
        conversationId: input.conversationId,
        role: 'user',
        blocks: input.blocks,
        createdAt: input.createdAt,
      }, input.assetIds)
      return { ordinal: message.ordinal }
    },
    createRun(input) {
      repositories.chatRuns.insert({
        id: input.runId,
        conversationId: input.conversationId,
        requestId: input.requestId,
        userId: input.userId,
        provider: input.provider,
        model: input.model,
        status: 'running',
        startedAt: input.startedAt,
      })
    },
    createAssistant(input) {
      repositories.messages.insert({
        id: input.messageId,
        conversationId: input.conversationId,
        role: 'assistant',
        blocks: input.initialBlocks,
        createdAt: input.createdAt,
      })
    },
    startMediaGeneration(input) {
      repositories.chatRuns.startMediaGeneration({
        userMessage: {
          id: input.user.messageId,
          conversationId: input.user.conversationId,
          role: 'user',
          blocks: input.user.blocks,
          createdAt: input.user.createdAt,
        },
        userAssetIds: input.user.assetIds,
        run: {
          id: input.run.runId,
          conversationId: input.run.conversationId,
          requestId: input.run.requestId,
          userId: input.run.userId,
          provider: input.run.provider,
          model: input.run.model,
          status: 'running',
          startedAt: input.run.startedAt,
        },
        assistantMessage: {
          id: input.assistant.messageId,
          conversationId: input.assistant.conversationId,
          role: 'assistant',
          blocks: input.assistant.initialBlocks,
          createdAt: input.assistant.createdAt,
        },
      })
    },
    updateAssistant(messageId, blocks) {
      return repositories.messages.update(messageId, { blocks })
    },
    replaceAssistantBlock(messageId, blockId, block) {
      return repositories.messages.replaceBlock(messageId, blockId, block)
    },
    finalize(input) {
      repositories.chatRuns.finalizeWithMessage(input.runId, input.messageId, input.requestId, {
        blocks: input.blocks,
        status: input.status,
        endedAt: input.endedAt,
        ...(input.generationId === undefined ? {} : { generationId: input.generationId }),
        ...(input.inputTokens === undefined ? {} : { inputTokens: input.inputTokens }),
        ...(input.outputTokens === undefined ? {} : { outputTokens: input.outputTokens }),
        ...(input.costUsd === undefined ? {} : { costUsd: input.costUsd }),
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      })
    },
  }
}

export interface AgentOrchestratorDependencies {
  workflows: AgentWorkflowPort
  persistence: AgentPersistencePort
  policy: AgentPolicyPort | Pick<PolicyEngine, 'evaluate' | 'record' | 'releaseExecution'>
  executions: AgentExecutionPort
  createSourceSelector(workflow: WorkflowDetail): WorkflowExecutionSourceSelector
  history: ConversationHistoryPort
  providerUsage: Pick<ProviderUsageRepository, 'start' | 'bindIdentity' | 'report' | 'markUnknown'>
  emit: (event: ChatEvent) => void
  retrieve?: typeof retrieveWorkflows
  id?: () => string
  now?: () => number
  developerMode?: () => boolean
}

interface UsageAttribution {
  userId: string
}

export interface AgentRunInput extends UsageAttribution {
  conversationId: string
  content: string
  userBlocks: ChatBlock[]
  modelContent: string | ModelContentPart[]
  assetIds: string[]
  contextLength?: number
  currentMedia: CurrentMediaMetadata[]
  allowTools: boolean
  provider: ModelProviderId
  model: string
  requestId?: string
  providerSnapshot: ModelProviderSnapshot
}

export interface AgentRunResult {
  requestId: string
  status: 'awaiting_approval' | 'running' | 'completed' | 'failed' | 'cancelled'
  executionId?: string
  error?: AppError
}

interface PendingTool {
  callId: string
  assistantContent: string
  workflow: WorkflowDetail
  sourceSelector: WorkflowExecutionSourceSelector
  toolName: string
  resolvedCity?: string
  args: unknown
  executionId: string
  reservation: ExecutionReservation
  reservationStarted: boolean
  permissionIndex: number
}

interface ActiveAgentRun {
  requestId: string
  runId: string
  messageId: string
  conversationId: string
  providerSnapshot: ModelProviderSnapshot
  userId: string
  model: string
  blocks: ChatBlock[]
  messages: ModelMessage[]
  tools: ModelTool[]
  workflows: Map<string, WorkflowCandidate>
  controller: AbortController
  modelTurns: number
  busy: boolean
  cancelled: boolean
  terminal?: AgentRunResult
  pending?: PendingTool
  executionId?: string
  generationId?: string
  inputTokens?: number
  outputTokens?: number
  costUsd?: string
}

function appFailure(code: AppError['code']): AppError {
  return toSafeAppError({ code })
}

function asAppError(error: unknown): AppError {
  if (typeof error === 'object' && error !== null && 'code' in error) return toSafeAppError(error)
  return appFailure('INTERNAL_ERROR')
}

function samePermission(
  left: WorkflowDetail['permissions'][number],
  right: Extract<ApprovalDecision, { decision: 'always' }>,
): boolean {
  return left.capability === right.capability && scopeHash(left.scope) === scopeHash(right.scope)
}

export class AgentOrchestrator {
  private readonly activeByRequest = new Map<string, ActiveAgentRun>()
  private readonly activeByExecution = new Map<string, ActiveAgentRun>()
  private readonly activeByConversation = new Map<string, string>()
  private readonly retrieve: typeof retrieveWorkflows
  private readonly id: () => string
  private readonly now: () => number

  constructor(private readonly dependencies: AgentOrchestratorDependencies) {
    this.retrieve = dependencies.retrieve ?? retrieveWorkflows
    this.id = dependencies.id ?? randomUUID
    this.now = dependencies.now ?? Date.now
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const requestId = input.requestId ?? this.id()
    if (input.providerSnapshot.providerId !== input.provider) {
      throw appFailure('CONFLICT')
    }
    if (this.activeByRequest.has(requestId) || this.activeByConversation.has(input.conversationId)) {
      const error = appFailure('CONFLICT')
      this.safeEmit({
        type: 'status',
        conversationId: input.conversationId,
        requestId,
        status: 'failed',
        error,
      })
      return { requestId, status: 'failed', error }
    }
    this.activeByConversation.set(input.conversationId, requestId)
    let active: ActiveAgentRun | undefined
    try {
      const userMessageId = this.id()
      const runId = this.id()
      const messageId = this.id()
      const startedAt = this.now()

      // This ordering is intentional: no provider or workflow operation can precede durable user input.
      const userPosition = this.dependencies.persistence.persistUser({
        messageId: userMessageId,
        conversationId: input.conversationId,
        blocks: input.userBlocks,
        assetIds: input.assetIds,
        createdAt: startedAt,
      })
      this.dependencies.persistence.createRun({
        runId,
        conversationId: input.conversationId,
        requestId,
        userId: input.userId,
        provider: input.provider,
        model: input.model,
        startedAt,
      })
      this.dependencies.persistence.createAssistant({
        messageId,
        conversationId: input.conversationId,
        initialBlocks: [],
        createdAt: startedAt,
      })
      const providerSnapshot = input.providerSnapshot

      active = {
        requestId,
        runId,
        messageId,
        conversationId: input.conversationId,
        providerSnapshot,
        userId: input.userId,
        model: input.model,
        blocks: [],
        messages: [],
        tools: [],
        workflows: new Map(),
        controller: new AbortController(),
        modelTurns: 0,
        busy: false,
        cancelled: false,
      }
      this.activeByRequest.set(requestId, active)
      if (input.allowTools) {
        const catalog = await createWorkflowCatalog({
          workflows: this.dependencies.workflows,
          selectorFor: this.dependencies.createSourceSelector,
        }).create({ developerMode: this.dependencies.developerMode?.() ?? false })
        const selectedWorkflows = this.retrieve(
          input.content,
          catalog.map(({ workflow }) => workflow),
          RETRIEVAL_LIMIT,
        )
        const candidates = selectedWorkflows.flatMap((workflow) => {
          const candidate = catalog.find(({ workflow: snapshot }) => snapshot === workflow)
          return candidate ? [candidate] : []
        })
        active.tools = candidates.map(({ tool }) => tool)
        active.workflows = new Map(candidates.map((candidate) => [candidate.toolName, candidate]))
      }
      const historyMessages = await this.dependencies.history.prepare({
        conversationId: input.conversationId,
        beforeOrdinal: userPosition.ordinal,
        providerSnapshot,
        callIdentity: { requestId, chatRunId: runId, userId: input.userId },
        model: input.model,
        ...(input.contextLength === undefined ? {} : { contextLength: input.contextLength }),
        currentMessage: { role: 'user', content: input.modelContent },
        tools: active.tools,
        currentMedia: input.currentMedia,
        signal: active.controller.signal,
      })
      active.messages = [
        ...historyMessages,
        { role: 'user', content: input.modelContent },
      ]
      return await this.driveExclusive(active)
    } catch (error) {
      if (error instanceof ProviderUsageConsistencyError) {
        if (active && !active.terminal) this.finish(active, 'failed', appFailure('INTERNAL_ERROR'))
        else if (this.activeByConversation.get(input.conversationId) === requestId) {
          this.activeByConversation.delete(input.conversationId)
        }
        throw error
      }
      if (active) return this.finish(active, 'failed', asAppError(error))
      if (this.activeByConversation.get(input.conversationId) === requestId) {
        this.activeByConversation.delete(input.conversationId)
      }
      throw error
    }
  }

  async resumeApproval(decision: ApprovalDecision): Promise<AgentRunResult> {
    const parsed = approvalDecisionSchema.safeParse(decision)
    if (!parsed.success) return this.failedResult('', 'INVALID_INPUT')
    const active = this.activeByExecution.get(parsed.data.executionId)
    if (!active || !active.pending || active.terminal) return this.failedResult(active?.requestId ?? '', 'CONFLICT')
    if (active.busy) return this.failedResult(active.requestId, 'CONFLICT')
    const pending = active.pending
    const permission = pending.workflow.permissions[pending.permissionIndex]
    if (!permission) return this.finish(active, 'failed', appFailure('CONFLICT'))
    const expectedScopeHash = scopeHash(permission.scope)
    if (parsed.data.permissionIndex !== pending.permissionIndex || parsed.data.scopeHash !== expectedScopeHash) {
      return this.failedResult(active.requestId, 'CONFLICT')
    }

    if (parsed.data.decision === 'deny') {
      return this.finish(active, 'failed', appFailure('PERMISSION_DENIED'))
    }
    if (parsed.data.decision === 'always' && (
      parsed.data.workflowId !== pending.workflow.id
      || parsed.data.workflowVersion !== pending.workflow.version
      || !samePermission(permission, parsed.data)
    )) {
      return this.failedResult(active.requestId, 'INVALID_INPUT')
    }

    try {
      this.dependencies.policy.record({
        executionId: pending.executionId,
        workflowId: pending.workflow.id,
        workflowVersion: pending.workflow.version,
        capability: permission.capability,
        scope: permission.scope,
        decision: parsed.data.decision,
      })
    } catch (error) {
      return this.finish(active, 'failed', asAppError(error))
    }
    pending.permissionIndex += 1
    return this.driveExclusive(active)
  }

  async cancel(requestId: string): Promise<void> {
    const active = this.activeByRequest.get(requestId)
    if (!active || active.terminal) return
    active.cancelled = true
    active.controller.abort()
    if (active.executionId) {
      try { await this.dependencies.executions.cancel(active.executionId) } catch { /* terminal chat cancellation remains authoritative */ }
    }
    if (!active.terminal) this.finish(active, 'cancelled', appFailure('CANCELLED'))
  }

  async cancelExecution(executionId: string): Promise<boolean> {
    const active = this.activeByExecution.get(executionId)
    if (!active || active.terminal) return false
    await this.cancel(active.requestId)
    return true
  }

  hasActiveRuns(): boolean {
    return this.activeByRequest.size > 0
  }

  private async driveExclusive(active: ActiveAgentRun): Promise<AgentRunResult> {
    if (active.busy) return this.failedResult(active.requestId, 'CONFLICT')
    active.busy = true
    try {
      return await this.drive(active)
    } catch (error) {
      if (error instanceof ProviderUsageConsistencyError) {
        if (!active.terminal) this.finish(active, 'failed', appFailure('INTERNAL_ERROR'))
        throw error
      }
      if (active.terminal) return active.terminal
      if (active.cancelled || active.controller.signal.aborted) return this.finish(active, 'cancelled', appFailure('CANCELLED'))
      return this.finish(active, 'failed', asAppError(error))
    } finally {
      active.busy = false
    }
  }

  private async drive(active: ActiveAgentRun): Promise<AgentRunResult> {
    if (active.terminal) return active.terminal
    if (active.cancelled) return this.finish(active, 'cancelled', appFailure('CANCELLED'))
    if (active.pending) return this.continuePendingTool(active)

    while (active.modelTurns < MAX_MODEL_TURNS) {
      active.modelTurns += 1
      const operationKey = `agent:${active.requestId}:turn:${active.modelTurns - 1}`
      const toolCalls: Array<Extract<ModelStreamEvent, { type: 'tool_call' }>> = []
      let finishReason: string | undefined
      let assistantContent = ''
      let turnUsage: Extract<ModelStreamEvent, { type: 'usage' }> | undefined
      for await (const event of trackProviderStream({
        operationKey,
        attribution: {
          userId: active.userId,
          requestId: active.requestId,
          chatRunId: active.runId,
          model: active.model,
          modality: 'text',
        },
        request: {
          model: active.model,
          messages: active.messages,
          ...(active.tools.length ? { tools: active.tools } : {}),
          signal: active.controller.signal,
          endUserId: active.userId,
        },
        provider: active.providerSnapshot,
        providerUsage: this.dependencies.providerUsage,
        id: this.id,
        now: this.now,
      })) {
        if (active.cancelled && event.type !== 'generation' && event.type !== 'usage') {
          return this.finish(active, 'cancelled', appFailure('CANCELLED'))
        }
        if ('choiceIndex' in event && event.choiceIndex !== 0) continue
        switch (event.type) {
          case 'text_delta':
            assistantContent += event.text
            this.appendText(active, event.text)
            break
          case 'tool_call':
            toolCalls.push(event)
            if (toolCalls.length > 1) return this.finish(active, 'failed', appFailure('INVALID_INPUT'))
            break
          case 'finish':
            finishReason = event.reason
            break
          case 'generation':
            active.generationId = event.id
            break
          case 'usage':
            turnUsage = event
            break
        }
        if (active.cancelled) return this.finish(active, 'cancelled', appFailure('CANCELLED'))
      }
      if (turnUsage) {
        active.inputTokens = (active.inputTokens ?? 0) + turnUsage.inputTokens
        active.outputTokens = (active.outputTokens ?? 0) + turnUsage.outputTokens
        if (turnUsage.costUsd !== undefined) {
          active.costUsd = addUsd([active.costUsd ?? '0', turnUsage.costUsd])
        }
      }

      if (toolCalls.length === 1) {
        if (finishReason !== 'tool_calls') return this.finish(active, 'failed', appFailure('INVALID_INPUT'))
        const result = this.prepareTool(active, toolCalls[0]!, assistantContent)
        if (result) return result
        return this.continuePendingTool(active)
      }
      if (finishReason === 'stop') return this.finish(active, 'completed')
      if (finishReason === 'tool_calls') return this.finish(active, 'failed', appFailure('INVALID_INPUT'))
      return this.finish(active, 'failed', appFailure('MODEL_PROVIDER_REQUEST_FAILED'))
    }
    return this.finish(active, 'failed', appFailure('MODEL_PROVIDER_REQUEST_FAILED'))
  }

  private prepareTool(
    active: ActiveAgentRun,
    call: Extract<ModelStreamEvent, { type: 'tool_call' }>,
    assistantContent: string,
  ): AgentRunResult | undefined {
    const candidate = active.workflows.get(call.name)
    if (!candidate) return this.finish(active, 'failed', appFailure('INVALID_INPUT'))
    const workflow = candidate.workflow
    try {
      const validate = new Ajv({ allErrors: true, strict: false }).compile(candidate.tool.function.parameters as object)
      if (!validate(call.arguments)) return this.finish(active, 'failed', appFailure('INVALID_INPUT'))
    } catch {
      return this.finish(active, 'failed', appFailure('INVALID_INPUT'))
    }
    if (typeof call.arguments !== 'object' || call.arguments === null || !('input' in call.arguments)) {
      return this.finish(active, 'failed', appFailure('INVALID_INPUT'))
    }
    const argumentsWithInput = call.arguments as { input: unknown; resolvedCity?: string }
    const reservation = this.dependencies.executions.reserve()
    const executionId = reservation.executionId
    active.pending = {
      callId: call.id,
      assistantContent,
      workflow,
      sourceSelector: candidate.selector,
      toolName: candidate.toolName,
      ...(argumentsWithInput.resolvedCity === undefined ? {} : { resolvedCity: argumentsWithInput.resolvedCity }),
      args: argumentsWithInput.input,
      executionId,
      reservation,
      reservationStarted: false,
      permissionIndex: 0,
    }
    active.executionId = executionId
    this.activeByExecution.set(executionId, active)
    this.appendBlock(active, {
      type: 'workflow_proposal', workflowId: workflow.id, workflowName: workflow.name, args: call.arguments,
    })
    return undefined
  }

  private async continuePendingTool(active: ActiveAgentRun): Promise<AgentRunResult> {
    const pending = active.pending!
    while (pending.permissionIndex < pending.workflow.permissions.length) {
      const permission = pending.workflow.permissions[pending.permissionIndex]!
      const evaluation = this.dependencies.policy.evaluate({
        executionId: pending.executionId,
        workflowId: pending.workflow.id,
        workflowVersion: pending.workflow.version,
        capability: permission.capability,
        scope: permission.scope,
      })
      if (!evaluation.allowed) {
        const permissionScopeHash = scopeHash(permission.scope)
        const last = active.blocks.at(-1)
        if (last?.type !== 'approval'
          || last.executionId !== pending.executionId
          || last.permissionIndex !== pending.permissionIndex
          || last.scopeHash !== permissionScopeHash) {
          this.appendBlock(active, {
            type: 'approval',
            executionId: pending.executionId,
            workflowId: pending.workflow.id,
            workflowName: pending.workflow.name,
            workflowVersion: pending.workflow.version,
            source: pending.workflow.source,
            actionSummary: `${pending.workflow.name}: ${permission.capability}`,
            permissionIndex: pending.permissionIndex,
            capability: permission.capability,
            scope: permission.scope,
            scopeHash: permissionScopeHash,
          })
        }
        return { requestId: active.requestId, status: 'awaiting_approval', executionId: pending.executionId }
      }
      pending.permissionIndex += 1
    }

    this.appendBlock(active, { type: 'workflow_execution', executionId: pending.executionId })
    pending.reservationStarted = true
    const started = await this.dependencies.executions.startReserved(pending.reservation, {
      userId: active.userId,
      workflowId: pending.workflow.id,
      workflowVersion: pending.workflow.version,
      input: pending.args,
      chatRunId: active.runId,
      sourceSelector: pending.sourceSelector,
    }, active.controller.signal)
    if (started.id !== pending.executionId) throw appFailure('CONFLICT')
    const execution = await started.finished
    if (active.cancelled || execution.status === 'cancelled') return this.finish(active, 'cancelled', appFailure('CANCELLED'))
    if (execution.status !== 'completed') return this.finish(active, 'failed', toSafeAppError({ code: execution.errorCode ?? 'INTERNAL_ERROR' }))

    this.appendBlock(active, {
      type: 'execution_result', executionId: pending.executionId, summary: 'Workflow completed.',
    })
    active.messages.push({
      role: 'assistant', content: pending.assistantContent || null,
      tool_calls: [{ id: pending.callId, type: 'function', function: { name: pending.toolName, arguments: JSON.stringify({
        ...(pending.resolvedCity === undefined ? {} : { resolvedCity: pending.resolvedCity }), input: pending.args,
      }) } }],
    })
    active.messages.push({
      role: 'tool', tool_call_id: pending.callId, content: JSON.stringify(execution.result ?? null),
    })
    this.activeByExecution.delete(pending.executionId)
    active.pending = undefined
    active.executionId = undefined
    return this.drive(active)
  }

  private appendText(active: ActiveAgentRun, text: string): void {
    if (!text) return
    const last = active.blocks.at(-1)
    if (last?.type === 'text') last.text += text
    else active.blocks.push({ type: 'text', text })
    this.dependencies.persistence.updateAssistant(active.messageId, structuredClone(active.blocks))
    this.safeEmit({
      type: 'block', conversationId: active.conversationId, messageId: active.messageId,
      block: { type: 'text', text },
    })
  }

  private appendBlock(active: ActiveAgentRun, block: ChatBlock): void {
    active.blocks.push(block)
    this.dependencies.persistence.updateAssistant(active.messageId, structuredClone(active.blocks))
    this.safeEmit({ type: 'block', conversationId: active.conversationId, messageId: active.messageId, block })
  }

  private finish(
    active: ActiveAgentRun,
    status: 'completed' | 'failed' | 'cancelled',
    error?: AppError,
  ): AgentRunResult {
    if (active.terminal) return active.terminal
    const blocks = structuredClone(active.blocks)
    const errorBlock: ChatBlock | undefined = error && status === 'failed'
      ? { type: 'error', code: error.code, message: error.message }
      : undefined
    if (errorBlock) blocks.push(errorBlock)
    this.dependencies.persistence.finalize({
      runId: active.runId,
      requestId: active.requestId,
      messageId: active.messageId,
      blocks,
      status,
      endedAt: this.now(),
      ...(active.generationId ? { generationId: active.generationId } : {}),
      ...(active.inputTokens === undefined ? {} : { inputTokens: active.inputTokens }),
      ...(active.outputTokens === undefined ? {} : { outputTokens: active.outputTokens }),
      ...(active.costUsd === undefined ? {} : { costUsd: active.costUsd }),
      ...(error ? { errorCode: error.code } : {}),
    })
    active.blocks = blocks
    const result: AgentRunResult = {
      requestId: active.requestId,
      status,
      ...(error ? { error } : {}),
    }
    active.terminal = result
    this.activeByRequest.delete(active.requestId)
    if (this.activeByConversation.get(active.conversationId) === active.requestId) {
      this.activeByConversation.delete(active.conversationId)
    }
    if (active.pending) {
      this.activeByExecution.delete(active.pending.executionId)
      if (!active.pending.reservationStarted) {
        try { this.dependencies.executions.discardReservation(active.pending.reservation) } catch { /* terminal persistence remains authoritative */ }
      }
      try { this.dependencies.policy.releaseExecution(active.pending.executionId) } catch { /* terminal persistence remains authoritative */ }
    }
    if (errorBlock) {
      this.safeEmit({
        type: 'block', conversationId: active.conversationId, messageId: active.messageId, block: errorBlock,
      })
    }
    this.safeEmit({
      type: 'status', conversationId: active.conversationId, requestId: active.requestId, status,
      ...(error ? { error } : {}),
    })
    return result
  }

  private safeEmit(event: ChatEvent): void {
    try { this.dependencies.emit(event) } catch { /* renderer listeners are observational */ }
  }

  private failedResult(requestId: string, code: AppError['code']): AgentRunResult {
    return { requestId, status: 'failed', error: appFailure(code) }
  }
}
