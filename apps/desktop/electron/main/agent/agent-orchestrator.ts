import { randomUUID } from 'node:crypto'
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
import type { PolicyEngine } from '../permissions/policy-engine.js'
import type { ExactWorkflowSource, WorkflowExecutionSourceSelector } from '../workflows/workflow-source-selector.js'
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
import { WorkflowRouter, type WorkflowRoutingRequest } from './workflow-router.js'
import {
  WorkflowToolExecutor,
  type PendingWorkflowTool,
  type ToolError,
  type WorkflowToolExecutionPort,
  type WorkflowToolPolicyPort,
  type WorkflowToolRunBudget,
} from './workflow-tool-executor.js'

const MAX_MODEL_TURNS = 8

export type ProviderStreamEvent = ModelStreamEvent

export interface AgentProviderPort {
  stream(request: ModelStreamRequest): AsyncIterable<ModelStreamEvent>
}

export interface AgentWorkflowPort {
  list(options?: { developerMode?: boolean }): Promise<WorkflowDetail[]>
}

export type AgentPolicyPort = WorkflowToolPolicyPort

export type AgentExecutionPort = WorkflowToolExecutionPort

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
  inspectSource(selector: WorkflowExecutionSourceSelector): ExactWorkflowSource | undefined
  resolveCurrentWorkflow(
    selector: WorkflowExecutionSourceSelector,
    id: string,
    version: string,
  ): Promise<WorkflowDetail | undefined>
  checkRemainingBudgets(input: WorkflowToolRunBudget & { phase: 'prepare' | 'start' }): AppError['code'] | undefined
  history: ConversationHistoryPort
  providerUsage: Pick<ProviderUsageRepository, 'start' | 'bindIdentity' | 'report' | 'markUnknown'>
  emit: (event: ChatEvent) => void
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

interface ToolExchange {
  callId: string
  assistantContent: string
  toolName: string
  tool?: PendingWorkflowTool
  arguments?: unknown
}

interface PendingTool extends ToolExchange {
  tool: PendingWorkflowTool
}

interface ActiveAgentRun {
  requestId: string
  runId: string
  messageId: string
  conversationId: string
  providerSnapshot: ModelProviderSnapshot
  userId: string
  model: string
  contextLength?: number
  blocks: ChatBlock[]
  messages: ModelMessage[]
  tools: ModelTool[]
  workflows: Map<string, WorkflowCandidate>
  controller: AbortController
  modelTurns: number
  toolExecutions: number
  busy: boolean
  cancelled: boolean
  terminal?: AgentRunResult
  pending?: PendingTool
  executionId?: string
  generationId?: string
  inputTokens?: number
  outputTokens?: number
  costUsd?: string
  workflowRoutingUsage?: {
    inputTokens: number
    outputTokens: number
    costUsd?: string
  }
}

function appFailure(code: AppError['code']): AppError {
  return toSafeAppError({ code })
}

function asAppError(error: unknown): AppError {
  if (typeof error === 'object' && error !== null && 'code' in error) return toSafeAppError(error)
  return appFailure('INTERNAL_ERROR')
}

export class AgentOrchestrator {
  private readonly activeByRequest = new Map<string, ActiveAgentRun>()
  private readonly activeByExecution = new Map<string, ActiveAgentRun>()
  private readonly activeByConversation = new Map<string, string>()
  private readonly id: () => string
  private readonly now: () => number
  private readonly workflowTools: WorkflowToolExecutor

  constructor(private readonly dependencies: AgentOrchestratorDependencies) {
    this.id = dependencies.id ?? randomUUID
    this.now = dependencies.now ?? Date.now
    this.workflowTools = new WorkflowToolExecutor({
      executions: dependencies.executions,
      policy: dependencies.policy,
      currentDeveloperMode: dependencies.developerMode ?? (() => false),
      inspectSource: dependencies.inspectSource,
      resolveCurrentWorkflow: dependencies.resolveCurrentWorkflow,
      checkRemainingBudgets: dependencies.checkRemainingBudgets,
      now: this.now,
    })
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
        ...(input.contextLength === undefined ? {} : { contextLength: input.contextLength }),
        blocks: [],
        messages: [],
        tools: [],
        workflows: new Map(),
        controller: new AbortController(),
        modelTurns: 0,
        toolExecutions: 0,
        busy: false,
        cancelled: false,
      }
      this.activeByRequest.set(requestId, active)
      if (input.allowTools) {
        const catalog = await createWorkflowCatalog({
          workflows: this.dependencies.workflows,
          selectorFor: this.dependencies.createSourceSelector,
        }).create({ developerMode: this.dependencies.developerMode?.() ?? false })
        const candidates = await new WorkflowRouter().route({
          query: input.content,
          candidates: catalog,
          ...(input.contextLength === undefined ? {} : { contextLength: input.contextLength }),
          select: (request) => this.selectWorkflowRouting(active!, request),
          signal: active.controller.signal,
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
    const result = parsed.data.decision === 'deny'
      ? await this.workflowTools.deny(pending.tool, parsed.data)
      : await this.workflowTools.approve(pending.tool, parsed.data)
    if (result.kind === 'tool_error') {
      if (result.code === 'CONFLICT' || result.code === 'INVALID_INPUT') {
        return this.failedResult(active.requestId, result.code)
      }
      this.appendToolExchange(active, pending, result)
      this.clearPending(active)
    }
    return this.driveExclusive(active)
  }

  async cancel(requestId: string): Promise<void> {
    const active = this.activeByRequest.get(requestId)
    if (!active || active.terminal) return
    active.cancelled = true
    active.controller.abort()
    if (active.pending) await this.workflowTools.cancel(active.pending.tool)
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
        this.addUsage(active, turnUsage)
      }

      if (toolCalls.length === 1) {
        if (finishReason !== 'tool_calls') return this.finish(active, 'failed', appFailure('INVALID_INPUT'))
        const result = await this.prepareTool(active, toolCalls[0]!, assistantContent)
        if (result) return result
        return this.continuePendingTool(active)
      }
      if (finishReason === 'stop') return this.finish(active, 'completed')
      if (finishReason === 'tool_calls') return this.finish(active, 'failed', appFailure('INVALID_INPUT'))
      return this.finish(active, 'failed', appFailure('MODEL_PROVIDER_REQUEST_FAILED'))
    }
    return this.finish(active, 'failed', appFailure('MODEL_PROVIDER_REQUEST_FAILED'))
  }

  private async selectWorkflowRouting(
    active: ActiveAgentRun,
    request: WorkflowRoutingRequest,
  ): Promise<string> {
    let text = ''
    let finishReason: string | undefined
    for await (const event of trackProviderStream({
      operationKey: `agent:${active.requestId}:workflow-routing`,
      attribution: {
        userId: active.userId,
        requestId: active.requestId,
        chatRunId: active.runId,
        model: active.model,
        modality: 'text',
      },
      request: {
        model: active.model,
        messages: request.messages,
        signal: request.signal,
        endUserId: active.userId,
      },
      provider: active.providerSnapshot,
      providerUsage: this.dependencies.providerUsage,
      id: this.id,
      now: this.now,
    })) {
      if (event.type === 'usage') {
        active.workflowRoutingUsage = {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          ...(event.costUsd === undefined ? {} : { costUsd: event.costUsd }),
        }
      }
      if (active.cancelled || request.signal.aborted) continue
      if ('choiceIndex' in event && event.choiceIndex !== 0) continue
      if (event.type === 'text_delta') text += event.text
      if (event.type === 'finish') finishReason = event.reason
    }
    if (active.cancelled || request.signal.aborted) throw appFailure('CANCELLED')
    if (finishReason !== 'stop' || !text.trim()) throw appFailure('MODEL_PROVIDER_REQUEST_FAILED')
    return text.trim()
  }

  private addUsage(active: ActiveAgentRun, usage: Extract<ModelStreamEvent, { type: 'usage' }>): void {
    active.inputTokens = (active.inputTokens ?? 0) + usage.inputTokens
    active.outputTokens = (active.outputTokens ?? 0) + usage.outputTokens
    if (usage.costUsd !== undefined) {
      active.costUsd = addUsd([active.costUsd ?? '0', usage.costUsd])
    }
  }

  private async prepareTool(
    active: ActiveAgentRun,
    call: Extract<ModelStreamEvent, { type: 'tool_call' }>,
    assistantContent: string,
  ): Promise<AgentRunResult | undefined> {
    const candidate = active.workflows.get(call.name)
    if (!candidate) return this.finish(active, 'failed', appFailure('INVALID_INPUT'))
    const prepared = await this.workflowTools.prepare({
      candidate,
      arguments: call.arguments,
      developerMode: this.dependencies.developerMode?.() ?? false,
      budget: this.toolBudget(active),
    })
    if (prepared.kind === 'tool_error') {
      this.appendToolExchange(active, {
        callId: call.id,
        assistantContent,
        toolName: candidate.toolName,
        arguments: call.arguments,
      }, prepared)
      return this.drive(active)
    }
    const executionId = prepared.pending.executionId
    active.pending = {
      callId: call.id,
      assistantContent,
      toolName: candidate.toolName,
      tool: prepared.pending,
    }
    active.executionId = executionId
    this.activeByExecution.set(executionId, active)
    this.appendBlock(active, {
      type: 'workflow_proposal',
      workflowId: candidate.workflow.id,
      workflowName: candidate.workflow.name,
      args: call.arguments,
    })
    return undefined
  }

  private async continuePendingTool(active: ActiveAgentRun): Promise<AgentRunResult> {
    const pending = active.pending!
    const tool = pending.tool
    if (tool.capability !== undefined
      && tool.scope !== undefined
      && tool.scopeHash !== undefined
      && tool.actionSummary !== undefined) {
      const last = active.blocks.at(-1)
      if (last?.type !== 'approval'
        || last.executionId !== tool.executionId
        || last.permissionIndex !== tool.permissionIndex
        || last.scopeHash !== tool.scopeHash) {
        const source = tool.source
        this.appendBlock(active, {
          type: 'approval',
          executionId: tool.executionId,
          workflowId: tool.candidate.workflow.id,
          workflowName: tool.candidate.workflow.name,
          workflowVersion: tool.candidate.workflow.version,
          source: source.source,
          ...(source.source === 'development' ? { buildHash: source.buildHash } : {}),
          ...(tool.city === undefined ? {} : { city: tool.city }),
          actionSummary: tool.actionSummary,
          permissionIndex: tool.permissionIndex,
          capability: tool.capability,
          scope: tool.scope,
          scopeHash: tool.scopeHash,
        })
      }
      return { requestId: active.requestId, status: 'awaiting_approval', executionId: tool.executionId }
    }

    const started = await this.workflowTools.start(tool, {
      userId: active.userId,
      chatRunId: active.runId,
      signal: active.controller.signal,
      budget: this.toolBudget(active),
    })
    if (started.kind === 'tool_error') {
      this.appendToolExchange(active, pending, started)
      this.clearPending(active)
      return this.drive(active)
    }
    active.toolExecutions += 1
    this.appendBlock(active, { type: 'workflow_execution', executionId: tool.executionId })
    const execution = await started.finished
    if (active.cancelled || execution.status === 'cancelled') return this.finish(active, 'cancelled', appFailure('CANCELLED'))
    const modelResult = execution.status === 'completed'
      ? this.workflowTools.toModelResult({
          result: execution.result,
          ...(active.contextLength === undefined ? {} : { contextLength: active.contextLength }),
        })
      : this.workflowTools.toModelResult({
          error: { code: execution.errorCode ?? 'INTERNAL_ERROR' },
          ...(active.contextLength === undefined ? {} : { contextLength: active.contextLength }),
        })
    if (execution.status === 'completed') {
      this.appendBlock(active, {
        type: 'execution_result', executionId: tool.executionId, summary: 'Workflow completed.',
      })
    }
    this.appendToolExchange(active, pending, modelResult)
    this.clearPending(active)
    return this.drive(active)
  }

  private appendToolExchange(
    active: ActiveAgentRun,
    exchange: ToolExchange,
    result: ToolError | { kind: 'tool_result'; content: string },
  ): void {
    const toolArguments = exchange.arguments ?? (exchange.tool ? {
      ...(exchange.tool.city === undefined ? {} : { resolvedCity: exchange.tool.city }),
      input: exchange.tool.input,
    } : {})
    let serializedArguments = '{}'
    try { serializedArguments = JSON.stringify(toolArguments) ?? '{}' } catch { /* Provider arguments originated as JSON. */ }
    active.messages.push({
      role: 'assistant',
      content: exchange.assistantContent || null,
      tool_calls: [{
        id: exchange.callId,
        type: 'function',
        function: { name: exchange.toolName, arguments: serializedArguments },
      }],
    })
    active.messages.push({
      role: 'tool',
      tool_call_id: exchange.callId,
      content: result.kind === 'tool_result' ? result.content : JSON.stringify(result),
    })
  }

  private clearPending(active: ActiveAgentRun): void {
    const pending = active.pending
    if (!pending) return
    this.activeByExecution.delete(pending.tool.executionId)
    active.pending = undefined
    active.executionId = undefined
  }

  private toolBudget(active: ActiveAgentRun): WorkflowToolRunBudget {
    return {
      requestId: active.requestId,
      runId: active.runId,
      toolExecutions: active.toolExecutions,
      modelDecisions: active.modelTurns,
    }
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
    const routingUsage = active.workflowRoutingUsage
    const inputTokens = active.inputTokens === undefined && routingUsage === undefined
      ? undefined
      : (active.inputTokens ?? 0) + (routingUsage?.inputTokens ?? 0)
    const outputTokens = active.outputTokens === undefined && routingUsage === undefined
      ? undefined
      : (active.outputTokens ?? 0) + (routingUsage?.outputTokens ?? 0)
    const costs = [active.costUsd, routingUsage?.costUsd]
      .filter((cost): cost is string => cost !== undefined)
    const costUsd = costs.length === 0 ? undefined : addUsd(costs)
    this.dependencies.persistence.finalize({
      runId: active.runId,
      requestId: active.requestId,
      messageId: active.messageId,
      blocks,
      status,
      endedAt: this.now(),
      ...(active.generationId ? { generationId: active.generationId } : {}),
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(costUsd === undefined ? {} : { costUsd }),
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
      this.activeByExecution.delete(active.pending.tool.executionId)
      void this.workflowTools.cancel(active.pending.tool)
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
