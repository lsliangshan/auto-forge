import { chatBlockSchema, type ChatBlock } from '@autoforge/shared'
import type { Message } from '../database/repositories.js'
import type { ModelMessage, ModelTool } from './model-provider.js'

const REQUEST_OVERHEAD = 12
const MESSAGE_OVERHEAD = 8
const TOOL_OVERHEAD = 12
const MAX_MEDIA_TOKENS = 16_384

export interface CurrentMediaMetadata {
  kind: 'image' | 'audio' | 'video'
  durationMs?: number
}

export interface EstimateRequestTokensInput {
  messages: readonly ModelMessage[]
  tools: readonly ModelTool[]
  currentMedia: readonly CurrentMediaMetadata[]
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
      return [`[工作流提议: ${block.workflowName} (${block.workflowId}); 参数: ${safeJson(block.args)}]`]
    case 'approval':
      return [`[工作流等待权限审批: ${block.workflowId}@${block.workflowVersion}; 能力: ${block.capability}]`]
    case 'workflow_execution':
      return [`[工作流执行: ${block.executionId}]`]
    case 'execution_result':
      return [`[工作流结果: ${block.executionId}; ${block.summary}]`]
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
