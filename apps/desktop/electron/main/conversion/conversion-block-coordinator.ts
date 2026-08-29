import { chatBlockSchema, type ChatBlock } from '@autoforge/shared'
import type { AppRepositories, ConversionJob, Execution } from '../database/repositories.js'
import {
  UserDataConsistencyError,
  type ConversionBlockBindingRecord,
  type UserDataRepositories,
} from '../database/user-data-repositories.js'

type ConversionBlock = Extract<ChatBlock, { type: 'conversion' }>

const terminalExecutionStatuses = new Set<Execution['status']>([
  'completed', 'failed', 'cancelled', 'interrupted',
])
const terminalConversionStatuses = new Set<ConversionJob['status']>([
  'completed', 'failed', 'cancelled', 'interrupted',
])

export interface ConversionBlockCoordinatorRepositories {
  durable: Pick<AppRepositories, 'executions' | 'conversionJobs'>
  chat: Pick<UserDataRepositories, 'messages' | 'chatRuns' | 'conversionBlockBindings'>
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

function retire(
  repositories: ConversionBlockCoordinatorRepositories,
  binding: ConversionBlockBindingRecord,
  reason: NonNullable<ConversionBlockBindingRecord['retirementReason']>,
): void {
  repositories.chat.conversionBlockBindings.retire(
    binding.ownerUserId,
    binding.executionId,
    reason,
    Date.now(),
  )
}

function retireInvalid(
  repositories: ConversionBlockCoordinatorRepositories,
  binding: ConversionBlockBindingRecord,
): never {
  retire(repositories, binding, 'invalid_binding')
  return consistencyFailure()
}

/**
 * Reconstructs all three durable signals and emits at most one strict terminal mutation.
 * Waiting for an unfinished signal is normal. Missing records are retired, while an
 * ambiguous or mismatched exact identity fails closed after retiring the binding.
 */
export function reconcileConversionBlockBinding(input: {
  repositories: ConversionBlockCoordinatorRepositories
  ownerUserId: string
  executionId: string
}): ConversionBlockTerminalTransition | undefined {
  const binding = input.repositories.chat.conversionBlockBindings.get(
    input.ownerUserId,
    input.executionId,
  )
  if (!binding || binding.consumedAt !== undefined || binding.retiredAt !== undefined) {
    return undefined
  }
  if (binding.finalizedAt === undefined) return undefined

  const execution = input.repositories.durable.executions.getForUser(
    input.executionId,
    input.ownerUserId,
  )
  if (!execution) {
    retire(input.repositories, binding, 'missing_execution')
    return undefined
  }
  if (!terminalExecutionStatuses.has(execution.status)) return undefined
  if (!execution.chatRunId) retireInvalid(input.repositories, binding)

  const jobs = input.repositories.durable.conversionJobs.listForExecution(
    input.executionId,
    input.ownerUserId,
  )
  if (jobs.length === 0) retireInvalid(input.repositories, binding)
  if (!jobs.every(({ status }) => terminalConversionStatuses.has(status))) return undefined

  const run = input.repositories.chat.chatRuns.get(execution.chatRunId)
  if (!run || run.conversationId !== binding.conversationId) {
    retireInvalid(input.repositories, binding)
  }
  const message = input.repositories.chat.messages.get(binding.messageId)
  if (!message) {
    retire(input.repositories, binding, 'missing_message')
    return undefined
  }
  if (message.conversationId !== binding.conversationId) {
    retireInvalid(input.repositories, binding)
  }

  const blocks = strictBlocks(message.blocks)
  const sameBlockId = blocks.filter((block) => (
    'blockId' in block && block.blockId === binding.blockId
  ))
  const sameExecution = blocks.filter((block) => (
    block.type === 'conversion' && block.executionId === input.executionId
  ))
  if (sameBlockId.length !== 1 || sameExecution.length !== 1 || sameBlockId[0] !== sameExecution[0]) {
    retireInvalid(input.repositories, binding)
  }
  const block = sameBlockId[0]
  if (!block || block.type !== 'conversion' || block.executionId !== input.executionId) {
    retireInvalid(input.repositories, binding)
  }
  if (block.state === 'terminal') {
    input.repositories.chat.messages.replaceBlock(message.id, block.blockId, block)
    return undefined
  }
  if (block.state !== 'active') retireInvalid(input.repositories, binding)

  const replacement = { ...block, state: 'terminal' as const }
  input.repositories.chat.messages.replaceBlock(message.id, block.blockId, replacement)
  return {
    conversationId: binding.conversationId,
    messageId: message.id,
    block: replacement,
  }
}
