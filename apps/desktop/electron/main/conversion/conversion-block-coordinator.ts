import { isDeepStrictEqual } from 'node:util'
import { chatBlockSchema, type ChatBlock } from '@autoforge/shared'
import type { AppRepositories, ConversionJob, Execution, Message } from '../database/repositories.js'
import { UserDataConsistencyError } from '../database/user-data-repositories.js'

type ConversionBlock = Extract<ChatBlock, { type: 'conversion' }>
type ConversionBinding = ReturnType<AppRepositories['conversionBlockBindings']['get']>

const terminalExecutionStatuses = new Set<Execution['status']>([
  'completed', 'failed', 'cancelled', 'interrupted',
])
const terminalConversionStatuses = new Set<ConversionJob['status']>([
  'completed', 'failed', 'cancelled', 'interrupted',
])

export interface ConversionBlockCoordinatorRepositories {
  durable: Pick<AppRepositories, 'conversionBlockBindings' | 'executions' | 'conversionJobs'>
  chat: Pick<AppRepositories, 'messages' | 'chatRuns'>
}

export interface ConversionBlockTerminalTransition {
  conversationId: string
  messageId: string
  block: ConversionBlock & { state: 'terminal' }
}

function consistencyFailure(): never {
  throw new UserDataConsistencyError()
}

function strictBlocks(blocks: unknown): ChatBlock[] {
  const parsed = chatBlockSchema.array().safeParse(blocks)
  if (!parsed.success) consistencyFailure()
  return parsed.data
}

function conversionBlocks(blocks: readonly ChatBlock[]): ConversionBlock[] {
  const blockIds = new Set<string>()
  const executionIds = new Set<string>()
  const conversions: ConversionBlock[] = []
  for (const block of blocks) {
    if ('blockId' in block && !blockIds.add(block.blockId)) consistencyFailure()
    if (block.type !== 'conversion') continue
    if (!executionIds.add(block.executionId)) consistencyFailure()
    conversions.push(block)
  }
  return conversions
}

function exactMessage(
  messages: AppRepositories['messages'],
  messageId: string,
  blocks: readonly ChatBlock[],
): Message {
  const message = messages.get(messageId)
  if (!message || !isDeepStrictEqual(strictBlocks(message.blocks), blocks)) consistencyFailure()
  return message
}

function exactBinding(
  repositories: ConversionBlockCoordinatorRepositories,
  ownerUserId: string,
  message: Message,
  block: ConversionBlock,
): NonNullable<ConversionBinding> {
  const binding = repositories.durable.conversionBlockBindings.get(ownerUserId, block.executionId)
  if (!binding
    || binding.conversationId !== message.conversationId
    || binding.messageId !== message.id
    || binding.blockId !== block.blockId) consistencyFailure()
  return binding
}

/** Registers every active conversion in the exact persisted assistant snapshot. */
export function registerConversionBlockBindings(input: {
  repositories: ConversionBlockCoordinatorRepositories
  ownerUserId: string
  messageId: string
  blocks: readonly ChatBlock[]
}): string[] {
  const message = exactMessage(input.repositories.chat.messages, input.messageId, input.blocks)
  const conversions = conversionBlocks(input.blocks)
  for (const block of conversions) {
    const existing = input.repositories.durable.conversionBlockBindings.get(
      input.ownerUserId,
      block.executionId,
    )
    if (existing) {
      exactBinding(input.repositories, input.ownerUserId, message, block)
      continue
    }
    if (block.state !== 'active') consistencyFailure()
    input.repositories.durable.conversionBlockBindings.create({
      ownerUserId: input.ownerUserId,
      conversationId: message.conversationId,
      messageId: message.id,
      blockId: block.blockId,
      executionId: block.executionId,
    })
  }
  return conversions.map(({ executionId }) => executionId)
}

/** Called only after Agent message.append/outbox finalization has committed. */
export function finalizeConversionBlockBindings(input: {
  repositories: ConversionBlockCoordinatorRepositories
  ownerUserId: string
  messageId: string
  blocks: readonly ChatBlock[]
  finalizedAt: number
}): string[] {
  const message = exactMessage(input.repositories.chat.messages, input.messageId, input.blocks)
  const conversions = conversionBlocks(input.blocks)
  const bindings = conversions.map((block) => (
    exactBinding(input.repositories, input.ownerUserId, message, block)
  ))
  for (const binding of bindings) {
    input.repositories.durable.conversionBlockBindings.finalize(
      input.ownerUserId,
      binding.executionId,
      input.finalizedAt,
    )
  }
  return bindings.map(({ executionId }) => executionId)
}

/**
 * Reconstructs all three durable signals and emits at most one strict terminal mutation.
 * Waiting for a missing signal is normal; malformed durable identity fails closed.
 */
export function reconcileConversionBlockBinding(input: {
  repositories: ConversionBlockCoordinatorRepositories
  ownerUserId: string
  executionId: string
}): ConversionBlockTerminalTransition | undefined {
  const binding = input.repositories.durable.conversionBlockBindings.get(
    input.ownerUserId,
    input.executionId,
  )
  if (!binding?.finalizedAt) return undefined
  const execution = input.repositories.durable.executions.getForUser(
    input.executionId,
    input.ownerUserId,
  )
  if (!execution) consistencyFailure()
  if (!terminalExecutionStatuses.has(execution.status)) return undefined
  if (!execution.chatRunId) consistencyFailure()
  const jobs = input.repositories.durable.conversionJobs.listForExecution(
    input.executionId,
    input.ownerUserId,
  )
  if (jobs.length === 0 || !jobs.every(({ status }) => terminalConversionStatuses.has(status))) {
    return undefined
  }
  const run = input.repositories.chat.chatRuns.get(execution.chatRunId)
  if (!run || run.conversationId !== binding.conversationId) consistencyFailure()
  const message = input.repositories.chat.messages.get(binding.messageId)
  if (!message || message.conversationId !== binding.conversationId) consistencyFailure()
  const blocks = strictBlocks(message.blocks)
  const sameBlockId = blocks.filter((block) => (
    'blockId' in block && block.blockId === binding.blockId
  ))
  const sameExecution = blocks.filter((block) => (
    block.type === 'conversion' && block.executionId === input.executionId
  ))
  if (sameBlockId.length !== 1 || sameExecution.length !== 1 || sameBlockId[0] !== sameExecution[0]) {
    consistencyFailure()
  }
  const block = sameBlockId[0]
  if (!block || block.type !== 'conversion' || block.executionId !== input.executionId) {
    consistencyFailure()
  }
  if (block.state === 'terminal') return undefined
  if (block.state !== 'active') consistencyFailure()
  const replacement = { ...block, state: 'terminal' as const }
  input.repositories.chat.messages.replaceBlock(message.id, block.blockId, replacement)
  return {
    conversationId: binding.conversationId,
    messageId: message.id,
    block: replacement,
  }
}
