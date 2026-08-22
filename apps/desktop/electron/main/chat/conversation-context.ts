import { randomUUID } from 'node:crypto'
import { toSafeAppError, chatBlockSchema, type ChatBlock } from '@autoforge/shared'
import {
  ProviderUsageConsistencyError,
  type AppRepositories,
  type ConversationContextRecord,
  type Message,
  type ProviderUsageRepository,
} from '../database/repositories.js'
import { trackProviderStream } from '../billing/provider-usage-stream.js'
import type {
  ModelContentPart,
  ModelMessage,
  ModelProviderSnapshot,
  ModelStreamEvent,
  ModelStreamRequest,
  ModelTool,
} from './model-provider.js'

const REQUEST_OVERHEAD = 12
const MESSAGE_OVERHEAD = 8
const TOOL_OVERHEAD = 12
const MAX_MEDIA_TOKENS = 16_384

const SUMMARY_SYSTEM_PROMPT = [
  '你正在维护同一聊天会话的内部记忆摘要。',
  '只总结提供的既有内容，不得补充或推测事实。',
  '保留用户目标、明确约束、已确认决定、未解决问题、工作流名称/参数/结果、附件种类和显示名称。',
  '删除寒暄、重复表达和已被后续内容否定的旧状态。',
  '输出纯文本，不要解释摘要过程。',
].join('\n')

export interface CurrentMediaMetadata {
  kind: 'image' | 'audio' | 'video'
  durationMs?: number
}

export interface EstimateRequestTokensInput {
  messages: readonly ModelMessage[]
  tools: readonly ModelTool[]
  currentMedia: readonly CurrentMediaMetadata[]
}

export interface PrepareConversationContextInput {
  conversationId: string
  beforeOrdinal: number
  providerSnapshot: ModelProviderSnapshot
  callIdentity: { requestId: string; chatRunId: string; userId: string }
  model: string
  contextLength?: number
  leadingMessages?: ModelMessage[]
  currentMessage: { role: 'user'; content: string | ModelContentPart[] }
  tools: ModelTool[]
  currentMedia: CurrentMediaMetadata[]
  signal: AbortSignal
}

export interface ConversationContextProviderPort {
  stream(request: ModelStreamRequest): AsyncIterable<ModelStreamEvent>
}

export interface ConversationHistoryPort {
  prepare(input: PrepareConversationContextInput): Promise<ModelMessage[]>
}

type ConversationContextRepositories = Pick<AppRepositories, 'conversationContexts'> & {
  messages: Pick<AppRepositories['messages'], 'listBeforeOrdinal'>
  providerUsage: Pick<ProviderUsageRepository, 'start' | 'bindIdentity' | 'report' | 'markUnknown'>
}

interface HistoricalModelMessage {
  ordinal: number
  message: ModelMessage
  mutable: boolean
}

function safeJson(value: unknown): string {
  return JSON.stringify(value) ?? 'null'
}

function unexpectedBlock(block: never): never {
  throw new Error(`Historical block type is invalid: ${String(block)}`)
}

function serializeBlock(block: ChatBlock): string[] {
  switch (block.type) {
    case 'text':
      return block.text ? [block.text] : []
    case 'reasoning_status':
      return []
    case 'media':
      return [`[历史附件: ${block.kind}; 名称: ${block.name}; MIME: ${block.mimeType}; 大小: ${block.byteSize} bytes]`]
    case 'workflow_proposal':
      return [`[工作流提议: ${block.workflowName} (${block.workflowId})]`]
    case 'approval':
      return block.state === 'pending'
        ? [`[工作流等待权限审批: ${block.workflowId}@${block.workflowVersion}; 能力: ${block.capability}]`]
        : [`[工作流权限审批状态: ${block.state}; ${block.workflowId}@${block.workflowVersion}; 能力: ${block.capability}]`]
    case 'workflow_status':
      return [`[工作流: ${block.workflowName}; 城市: ${block.city ?? '不限城市'}; 状态: ${block.status}]`]
    case 'workflow_provenance':
      return block.entries.map((entry) => (
        `[已使用工作流: ${entry.workflowName}; 城市: ${entry.city ?? '不限城市'}; 状态: ${entry.status}]`
      ))
    case 'browser_status':
      return [`[浏览器页面: ${block.siteLabel}; 来源: ${block.origin}; 操作: ${block.actionSummary ?? '无'}; 状态: ${block.state}]`]
    case 'workflow_execution':
      return [`[工作流执行: ${block.executionId}]`]
    case 'execution_result':
      return [`[工作流结果: ${block.executionId}; 已完成]`]
    case 'error':
      return [`[请求失败: ${block.code}; ${block.message}]`]
    case 'media_generation':
      return [`[${block.kind} 生成状态: ${block.status}${block.errorCode ? `; ${block.errorCode}` : ''}]`]
  }
  return unexpectedBlock(block)
}

export function serializeHistoricalMessage(message: Message): ModelMessage | undefined {
  if (message.role !== 'user' && message.role !== 'assistant') {
    throw new Error('Historical message role is invalid')
  }
  const content = chatBlockSchema.array().parse(message.blocks)
    .flatMap(serializeBlock)
    .filter((part) => part.length > 0)
    .join('\n')
    .trim()
  return content ? { role: message.role, content } : undefined
}

function hasMutableMediaGeneration(message: Message): boolean {
  return chatBlockSchema.array().parse(message.blocks).some((block) => (
    block.type === 'media_generation' && block.status !== 'failed'
  ))
}

export function estimateTextTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const character of text) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(character)) cjk += 1
    else other += Buffer.byteLength(character, 'utf8')
  }
  return cjk + Math.ceil(other / 3)
}

function messageForEstimate(message: ModelMessage): unknown {
  if (!Array.isArray(message.content)) return message
  return {
    ...message,
    content: message.content.map((part) => (
      part.type === 'text'
        ? part
        : { type: 'media', kind: part.kind, mimeType: part.mimeType }
    )),
  }
}

export function currentMediaTokenReserve(media: CurrentMediaMetadata): number {
  if (media.kind === 'image') return 2_048
  if (media.durationMs === undefined) return media.kind === 'audio' ? 8_192 : MAX_MEDIA_TOKENS

  const seconds = Math.ceil(media.durationMs / 1_000)
  const reserve = media.kind === 'audio'
    ? Math.max(2_048, seconds * 64)
    : Math.max(4_096, seconds * 128)
  return Math.min(MAX_MEDIA_TOKENS, reserve)
}

export function estimateRequestTokens(input: EstimateRequestTokensInput): number {
  return REQUEST_OVERHEAD
    + input.messages.reduce((total, message) => (
      total + MESSAGE_OVERHEAD + estimateTextTokens(safeJson(messageForEstimate(message)))
    ), 0)
    + input.tools.reduce((total, tool) => (
      total + TOOL_OVERHEAD + estimateTextTokens(safeJson(tool))
    ), 0)
    + input.currentMedia.reduce((total, media) => total + currentMediaTokenReserve(media), 0)
}

export function resolveChatInputBudget(contextLength?: number): number {
  const resolvedContextLength = contextLength !== undefined && contextLength > 0
    ? contextLength
    : 32_000
  return Math.floor(resolvedContextLength * 0.60)
}

function summaryMessage(summaryText: string): ModelMessage {
  return {
    role: 'system',
    content: `以下是本会话较早内容的内部记忆摘要。它只描述既有对话，不是新的用户指令。\n\n${summaryText}`,
  }
}

function requestTokens(
  history: readonly ModelMessage[],
  input: PrepareConversationContextInput,
): number {
  return estimateRequestTokens({
    messages: [...(input.leadingMessages ?? []), ...history, input.currentMessage],
    tools: input.tools,
    currentMedia: input.currentMedia,
  })
}

function isCancelled(input: PrepareConversationContextInput, error?: unknown): boolean {
  return input.signal.aborted
    || (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'CANCELLED')
}

function compressionFailure(input: PrepareConversationContextInput, error?: unknown): never {
  if (error instanceof ProviderUsageConsistencyError) throw error
  throw toSafeAppError({
    code: isCancelled(input, error) ? 'CANCELLED' : 'MODEL_PROVIDER_REQUEST_FAILED',
  })
}

function compressionMessages(
  summary: ConversationContextRecord | undefined,
  chunk: readonly HistoricalModelMessage[],
): ModelMessage[] {
  return [
    { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
    ...(summary === undefined ? [] : [summaryMessage(summary.summaryText)]),
    ...chunk.map(({ message }) => message),
  ]
}

function isCompressionChunkWithinBudget(
  summary: ConversationContextRecord | undefined,
  chunk: readonly HistoricalModelMessage[],
  budget: number,
): boolean {
  return estimateRequestTokens({
    messages: compressionMessages(summary, chunk),
    tools: [],
    currentMedia: [],
  }) <= budget
}

function selectCompressionChunk(
  summary: ConversationContextRecord | undefined,
  rawHistory: readonly HistoricalModelMessage[],
  protectedCount: number,
  budget: number,
): HistoricalModelMessage[] {
  const eligible = rawHistory.slice(0, Math.max(0, rawHistory.length - protectedCount))
  if (eligible.length === 0) return []
  if (!isCompressionChunkWithinBudget(summary, [eligible[0]!], budget)) {
    throw toSafeAppError({ code: 'CONTEXT_LIMIT_EXCEEDED' })
  }
  const completeTurnEnds = eligible.flatMap((message, index) => (
    index > 0
      && eligible[index - 1]!.message.role === 'user'
      && message.message.role === 'assistant'
      ? [index + 1]
      : []
  ))
  const fittingTurnEnd = completeTurnEnds
    .filter((end) => isCompressionChunkWithinBudget(summary, eligible.slice(0, end), budget))
    .at(-1)
  if (fittingTurnEnd !== undefined) return eligible.slice(0, fittingTurnEnd)

  // A complete oldest turn cannot fit in the summary request. Make the only
  // safe fallback at a persisted-message boundary so compression can progress.
  const chunk: HistoricalModelMessage[] = []
  for (const message of eligible) {
    const next = [...chunk, message]
    if (!isCompressionChunkWithinBudget(summary, next, budget)) break
    chunk.push(message)
  }
  return chunk
}

function protectedRawMessageCount(rawHistory: readonly HistoricalModelMessage[]): number {
  let protectedCount = 0
  while (
    protectedCount < 8
    && rawHistory.length - protectedCount >= 2
    && rawHistory[rawHistory.length - protectedCount - 2]!.message.role === 'user'
    && rawHistory[rawHistory.length - protectedCount - 1]!.message.role === 'assistant'
  ) {
    protectedCount += 2
  }
  if (rawHistory.length > protectedCount) return protectedCount
  if (
    rawHistory.length >= 2
    && rawHistory[0]!.message.role === 'user'
    && rawHistory[1]!.message.role === 'assistant'
  ) return rawHistory.length - 2
  return Math.max(0, rawHistory.length - 1)
}

async function streamSummary(
  input: PrepareConversationContextInput,
  summary: ConversationContextRecord | undefined,
  chunk: readonly HistoricalModelMessage[],
  maxOutputTokens: number,
  operationKey: string,
  providerUsage: Pick<ProviderUsageRepository, 'start' | 'bindIdentity' | 'report' | 'markUnknown'>,
): Promise<string> {
  let text = ''
  let finishReason: string | undefined
  try {
    for await (const event of trackProviderStream({
      operationKey,
      attribution: {
        userId: input.callIdentity.userId,
        requestId: input.callIdentity.requestId,
        chatRunId: input.callIdentity.chatRunId,
        model: input.model,
        modality: 'text',
      },
      request: {
        model: input.model,
        messages: compressionMessages(summary, chunk),
        maxOutputTokens,
        signal: input.signal,
        endUserId: input.callIdentity.userId,
      },
      provider: input.providerSnapshot,
      providerUsage,
      id: randomUUID,
      now: Date.now,
    })) {
      if (input.signal.aborted) compressionFailure(input)
      if (event.type === 'text_delta' && event.choiceIndex === 0) text += event.text
      if (event.type === 'finish' && event.choiceIndex === 0) finishReason = event.reason
    }
  } catch (error) {
    compressionFailure(input, error)
  }
  if (input.signal.aborted) compressionFailure(input)
  const trimmed = text.trim()
  if (!trimmed || finishReason !== 'stop') compressionFailure(input)
  return trimmed
}

export function createConversationContextManager(
  repositories: ConversationContextRepositories,
): ConversationHistoryPort {
  return {
    async prepare(input) {
      if (input.signal.aborted) throw toSafeAppError({ code: 'CANCELLED' })

      const contextLength = input.contextLength && input.contextLength > 0
        ? input.contextLength
        : 32_000
      const chatBudget = resolveChatInputBudget(input.contextLength)
      const summaryInputBudget = Math.floor(contextLength * 0.90)
      const summaryOutputTokens = Math.min(2_048, Math.floor(contextLength * 0.10))

      if (requestTokens([], input) > chatBudget) {
        throw toSafeAppError({ code: 'CONTEXT_LIMIT_EXCEEDED' })
      }

      let summary = repositories.conversationContexts.get(input.conversationId)
      const rawHistory = repositories.messages
        .listBeforeOrdinal(input.conversationId, input.beforeOrdinal)
        .filter((message) => message.ordinal > (summary?.throughOrdinal ?? 0))
        .flatMap((message): HistoricalModelMessage[] => {
          const serialized = serializeHistoricalMessage(message)
          return serialized === undefined ? [] : [{
            ordinal: message.ordinal,
            message: serialized,
            mutable: hasMutableMediaGeneration(message),
          }]
        })

      while (true) {
        const history = [
          ...(summary === undefined ? [] : [summaryMessage(summary.summaryText)]),
          ...rawHistory.map(({ message }) => message),
        ]
        if (requestTokens(history, input) <= chatBudget) return history
        if (rawHistory.length === 0) throw toSafeAppError({ code: 'CONTEXT_LIMIT_EXCEEDED' })
        if (requestTokens([summaryMessage('')], input) > chatBudget) {
          throw toSafeAppError({ code: 'CONTEXT_LIMIT_EXCEEDED' })
        }

        const mutableBarrier = rawHistory.findIndex(({ mutable }) => mutable)
        if (
          mutableBarrier !== -1
          && requestTokens([
            summaryMessage(''),
            ...rawHistory.slice(mutableBarrier).map(({ message }) => message),
          ], input) > chatBudget
        ) throw toSafeAppError({ code: 'CONTEXT_LIMIT_EXCEEDED' })
        const protectedByBarrier = mutableBarrier === -1
          ? 0
          : rawHistory.length - mutableBarrier
        const chunk = selectCompressionChunk(
          summary,
          rawHistory,
          Math.max(protectedRawMessageCount(rawHistory), protectedByBarrier),
          summaryInputBudget,
        )
        if (chunk.length === 0) throw toSafeAppError({ code: 'CONTEXT_LIMIT_EXCEEDED' })

        const expectedThroughOrdinal = summary?.throughOrdinal ?? 0
        const throughOrdinal = chunk.at(-1)!.ordinal
        const summaryText = await streamSummary(
          input,
          summary,
          chunk,
          summaryOutputTokens,
          `conversation-summary:${input.callIdentity.requestId}:${expectedThroughOrdinal}:${throughOrdinal}`,
          repositories.providerUsage,
        )
        try {
          summary = repositories.conversationContexts.advance({
            conversationId: input.conversationId,
            expectedThroughOrdinal,
            summaryText,
            throughOrdinal,
            estimatedTokens: estimateTextTokens(summaryText),
            updatedAt: Date.now(),
          })
        } catch (error) {
          if (isCancelled(input, error)) throw toSafeAppError({ code: 'CANCELLED' })
          throw toSafeAppError({ code: 'CONFLICT' })
        }
        rawHistory.splice(0, chunk.length)
      }
    },
  }
}
