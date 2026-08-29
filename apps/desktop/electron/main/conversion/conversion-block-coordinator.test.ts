import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatBlock } from '@autoforge/shared'
import { openAppDatabase } from '../database/client.js'
import { UserDataStoreManager, type UserDataStore } from '../database/user-data-client.js'
import { UserDataConsistencyError } from '../database/user-data-repositories.js'
import { createAgentPersistence } from '../agent/agent-orchestrator.js'
import {
  finalizeConversionBlockBindings,
  reconcileConversionBlockBinding,
  registerConversionBlockBindings,
  type ConversionBlockCoordinatorRepositories,
} from './conversion-block-coordinator.js'

const roots: string[] = []
const ownerUserId = 'conversion_coordinator_owner'
const conversationId = 'conversion_coordinator_conversation'
const messageId = 'conversion_coordinator_message'
const runId = 'conversion_coordinator_run'
const executionId = 'conversion_coordinator_execution'
const jobId = 'conversion_coordinator_job'
const activeBlock = {
  type: 'conversion' as const,
  blockId: 'conversion_coordinator_block',
  executionId,
  state: 'active' as const,
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function seeded(input: {
  finalized: boolean
  executionTerminal: boolean
  jobsTerminal: boolean
  binding?: boolean
}) {
  const root = await mkdtemp(join(tmpdir(), 'autoforge-conversion-block-coordinator-'))
  roots.push(root)
  const durable = openAppDatabase(join(root, 'autoforge.sqlite'))
  const stores = new UserDataStoreManager(join(root, 'user-caches'))
  const chat = stores.open(ownerUserId)
  chat.conversations.insert({
    id: conversationId,
    title: 'Conversion coordinator',
    userId: ownerUserId,
  })
  chat.chatRuns.insert({
    id: runId,
    conversationId,
    requestId: 'conversion_coordinator_request',
    userId: ownerUserId,
    provider: 'openrouter',
    model: 'openrouter/test',
    status: 'running',
    startedAt: 1,
  })
  chat.messages.insert({
    id: messageId,
    conversationId,
    role: 'assistant',
    blocks: [activeBlock],
    createdAt: 2,
  })
  durable.executions.insert({
    id: executionId,
    ownerUserId,
    workflowId: 'file.convert.test',
    workflowVersion: '1.0.0',
    chatRunId: runId,
    status: input.executionTerminal ? 'completed' : 'running',
    input: {},
  })
  durable.conversionJobs.create({
    id: jobId,
    ownerUserId,
    executionId,
    sourceKind: 'media',
    sourceId: 'conversion_coordinator_source',
    targetFormat: 'pdf',
    status: input.jobsTerminal ? 'completed' : 'verifying',
    progress: input.jobsTerminal ? 100 : 90,
  })
  if (input.binding !== false) {
    durable.conversionBlockBindings.create({
      ownerUserId,
      conversationId,
      messageId,
      blockId: activeBlock.blockId,
      executionId,
    })
    if (input.finalized) {
      durable.conversionBlockBindings.finalize(ownerUserId, executionId, 3)
    }
  }
  const repositories: ConversionBlockCoordinatorRepositories = { durable, chat }
  return { root, durable, stores, chat, repositories }
}

function terminalMutations(chat: UserDataStore) {
  return chat.outbox.list(100).filter((mutation) => (
    mutation.kind === 'message.conversion_block_terminal'
  ))
}

describe('conversion block coordinator', () => {
  it.each([
    'finalized',
    'execution',
    'jobs',
  ] as const)('emits once when the %s signal arrives last', async (lastSignal) => {
    const fixture = await seeded({
      finalized: lastSignal !== 'finalized',
      executionTerminal: lastSignal !== 'execution',
      jobsTerminal: lastSignal !== 'jobs',
    })
    try {
      expect(reconcileConversionBlockBinding({
        repositories: fixture.repositories,
        ownerUserId,
        executionId,
      })).toBeUndefined()
      expect(terminalMutations(fixture.chat)).toHaveLength(0)

      if (lastSignal === 'finalized') {
        expect(fixture.durable.conversionBlockBindings.finalize(ownerUserId, executionId, 4)).toBe(true)
      } else if (lastSignal === 'execution') {
        expect(fixture.durable.executions.updateForUser(
          executionId,
          ownerUserId,
          { status: 'completed', endedAt: 4 },
        )).toMatchObject({ status: 'completed' })
      } else {
        expect(fixture.durable.conversionJobs.transition({
          jobId,
          ownerUserId,
          expectedEpoch: 0,
          expectedStatuses: ['verifying'],
          patch: { status: 'completed', progress: 100, endedAt: 4 },
        })).toBe(true)
      }

      expect(reconcileConversionBlockBinding({
        repositories: fixture.repositories,
        ownerUserId,
        executionId,
      })).toEqual({
        conversationId,
        messageId,
        block: { ...activeBlock, state: 'terminal' },
      })
      expect(terminalMutations(fixture.chat)).toHaveLength(1)
      expect(fixture.chat.messages.get(messageId)?.blocks).toEqual([{ ...activeBlock, state: 'terminal' }])

      expect(reconcileConversionBlockBinding({
        repositories: fixture.repositories,
        ownerUserId,
        executionId,
      })).toBeUndefined()
      expect(terminalMutations(fixture.chat)).toHaveLength(1)
    } finally {
      fixture.stores.close()
      fixture.durable.close()
    }
  })

  it('registers one and then sequential foreground conversion bindings from persisted snapshots', async () => {
    const fixture = await seeded({
      finalized: false,
      executionTerminal: false,
      jobsTerminal: false,
      binding: false,
    })
    const secondExecutionId = 'conversion_coordinator_execution_2'
    const second = {
      type: 'conversion' as const,
      blockId: 'conversion_coordinator_block_2',
      executionId: secondExecutionId,
      state: 'active' as const,
    }
    try {
      expect(registerConversionBlockBindings({
        repositories: fixture.repositories,
        ownerUserId,
        messageId,
        blocks: [activeBlock],
      })).toEqual([executionId])
      expect(fixture.durable.conversionBlockBindings.get(ownerUserId, executionId)).toMatchObject({
        conversationId,
        messageId,
        blockId: activeBlock.blockId,
        executionId,
        finalizedAt: undefined,
      })
      fixture.chat.messages.update(messageId, { blocks: [activeBlock, second] })
      expect(registerConversionBlockBindings({
        repositories: fixture.repositories,
        ownerUserId,
        messageId,
        blocks: [activeBlock, second],
      })).toEqual([executionId, secondExecutionId])
      expect(fixture.durable.conversionBlockBindings.get(ownerUserId, secondExecutionId)).toMatchObject({
        conversationId,
        messageId,
        blockId: second.blockId,
        executionId: secondExecutionId,
        finalizedAt: undefined,
      })

      expect(finalizeConversionBlockBindings({
        repositories: fixture.repositories,
        ownerUserId,
        messageId,
        blocks: [activeBlock, second],
        finalizedAt: 5,
      })).toEqual([executionId, secondExecutionId])
      expect(fixture.durable.conversionBlockBindings.get(ownerUserId, executionId)?.finalizedAt).toBe(5)
      expect(fixture.durable.conversionBlockBindings.get(ownerUserId, secondExecutionId)?.finalizedAt).toBe(5)
    } finally {
      fixture.stores.close()
      fixture.durable.close()
    }
  })

  it('leaves the binding unfinalized and queues no terminal operation when message finalization fails', async () => {
    const fixture = await seeded({ finalized: false, executionTerminal: true, jobsTerminal: true })
    try {
      const persistence = createAgentPersistence({
        messages: fixture.chat.messages,
        chatRuns: {
          finalizeWithMessage: () => { throw new Error('assistant append failed') },
        },
      } as never, undefined, (finalizedMessageId, blocks) => {
        const finalizedExecutionIds = finalizeConversionBlockBindings({
          repositories: fixture.repositories,
          ownerUserId,
          messageId: finalizedMessageId,
          blocks,
          finalizedAt: 5,
        })
        for (const finalizedExecutionId of finalizedExecutionIds) {
          reconcileConversionBlockBinding({
            repositories: fixture.repositories,
            ownerUserId,
            executionId: finalizedExecutionId,
          })
        }
      })

      expect(() => persistence.finalize({
        runId,
        requestId: 'conversion_coordinator_request',
        messageId,
        blocks: [activeBlock],
        status: 'completed',
        endedAt: 5,
      })).toThrow('assistant append failed')
      expect(fixture.durable.conversionBlockBindings.get(ownerUserId, executionId)?.finalizedAt)
        .toBeUndefined()
      expect(fixture.chat.messages.get(messageId)?.blocks).toEqual([activeBlock])
      expect(terminalMutations(fixture.chat)).toHaveLength(0)
    } finally {
      fixture.stores.close()
      fixture.durable.close()
    }
  })

  it('rejects duplicate durable execution and message-block bindings', async () => {
    const fixture = await seeded({ finalized: false, executionTerminal: false, jobsTerminal: false })
    try {
      expect(() => fixture.durable.conversionBlockBindings.create({
        ownerUserId,
        conversationId,
        messageId,
        blockId: 'conversion_coordinator_other_block',
        executionId,
      })).toThrow()
      expect(() => fixture.durable.conversionBlockBindings.create({
        ownerUserId,
        conversationId,
        messageId,
        blockId: activeBlock.blockId,
        executionId: 'conversion_coordinator_other_execution',
      })).toThrow()
      expect(fixture.durable.conversionBlockBindings.get(ownerUserId, executionId)).toMatchObject({
        conversationId,
        messageId,
        blockId: activeBlock.blockId,
        executionId,
      })
    } finally {
      fixture.stores.close()
      fixture.durable.close()
    }
  })

  it.each([
    {
      label: 'duplicate target block',
      blocks: [activeBlock, { ...activeBlock }],
    },
    {
      label: 'duplicate execution under another block',
      blocks: [activeBlock, { ...activeBlock, blockId: 'conversion_coordinator_other_block' }],
    },
    {
      label: 'mismatched bound execution',
      blocks: [{ ...activeBlock, executionId: 'conversion_coordinator_wrong_execution' }],
    },
  ] satisfies Array<{ label: string; blocks: ChatBlock[] }>)('fails closed for $label', async ({ blocks }) => {
    const fixture = await seeded({ finalized: true, executionTerminal: true, jobsTerminal: true })
    try {
      fixture.chat.messages.update(messageId, { blocks })
      expect(() => reconcileConversionBlockBinding({
        repositories: fixture.repositories,
        ownerUserId,
        executionId,
      })).toThrow(UserDataConsistencyError)
      expect(terminalMutations(fixture.chat)).toHaveLength(0)
      expect(fixture.chat.messages.get(messageId)?.blocks).toEqual(blocks)
    } finally {
      fixture.stores.close()
      fixture.durable.close()
    }
  })
})
