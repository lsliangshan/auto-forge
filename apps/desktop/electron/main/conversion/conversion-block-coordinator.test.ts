import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatBlock } from '@autoforge/shared'
import { createAgentPersistence } from '../agent/agent-orchestrator.js'
import { openAppDatabase } from '../database/client.js'
import { UserDataStoreManager, type UserDataStore } from '../database/user-data-client.js'
import { UserDataConsistencyError } from '../database/user-data-repositories.js'
import {
  reconcileConversionBlockBinding,
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
    blocks: [],
    createdAt: 2,
  })
  chat.messages.update(messageId, { blocks: [activeBlock] })
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
  if (input.finalized) finalize(chat, 3)
  const repositories: ConversionBlockCoordinatorRepositories = {
    durable,
    chat: {
      messages: chat.messages,
      chatRuns: chat.chatRuns,
      conversionBlockBindings: chat.conversionBlockBindings,
    },
  }
  return { root, durable, stores, chat, repositories }
}

function finalize(chat: UserDataStore, endedAt: number, blocks: ChatBlock[] = [activeBlock]): void {
  chat.chatRuns.finalizeWithMessage(
    runId,
    messageId,
    'conversion_coordinator_request',
    { blocks, status: 'completed', endedAt },
  )
}

function terminalMutations(chat: UserDataStore) {
  return chat.outbox.list(100).filter((mutation) => (
    mutation.kind === 'message.conversion_block_terminal'
  ))
}

describe('conversion block coordinator', () => {
  it.each(['finalized', 'execution', 'jobs'] as const)(
    'emits exactly once when the %s signal arrives last',
    async (lastSignal) => {
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
          finalize(fixture.chat, 4)
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
        expect(fixture.chat.conversionBlockBindings.get(ownerUserId, executionId))
          .toMatchObject({ consumedAt: expect.any(Number) })

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
    },
  )

  it('handles two sequential foreground bindings without crossing exact identities', async () => {
    const fixture = await seeded({ finalized: false, executionTerminal: true, jobsTerminal: true })
    const secondExecutionId = 'conversion_coordinator_execution_2'
    const second = {
      type: 'conversion' as const,
      blockId: 'conversion_coordinator_block_2',
      executionId: secondExecutionId,
      state: 'active' as const,
    }
    try {
      fixture.durable.executions.insert({
        id: secondExecutionId, ownerUserId, workflowId: 'file.convert.test', workflowVersion: '1.0.0',
        chatRunId: runId, status: 'completed', input: {},
      })
      fixture.durable.conversionJobs.create({
        id: 'conversion_coordinator_job_2', ownerUserId, executionId: secondExecutionId,
        sourceKind: 'media', sourceId: 'conversion_coordinator_source_2', targetFormat: 'pdf',
        status: 'completed', progress: 100,
      })
      fixture.chat.messages.update(messageId, { blocks: [activeBlock, second] })
      finalize(fixture.chat, 5, [activeBlock, second])

      for (const currentExecutionId of [executionId, secondExecutionId]) {
        expect(reconcileConversionBlockBinding({
          repositories: fixture.repositories,
          ownerUserId,
          executionId: currentExecutionId,
        })).toMatchObject({ block: { executionId: currentExecutionId, state: 'terminal' } })
      }
      expect(terminalMutations(fixture.chat)).toHaveLength(2)
      expect(fixture.chat.messages.get(messageId)?.blocks).toEqual([
        { ...activeBlock, state: 'terminal' },
        { ...second, state: 'terminal' },
      ])
    } finally {
      fixture.stores.close()
      fixture.durable.close()
    }
  })

  it('leaves the binding unfinalized and queues no terminal operation when finalization fails', async () => {
    const fixture = await seeded({ finalized: false, executionTerminal: true, jobsTerminal: true })
    try {
      const persistence = createAgentPersistence({
        messages: fixture.chat.messages,
        chatRuns: { finalizeWithMessage: () => { throw new Error('assistant append failed') } },
      } as never, undefined, () => {
        reconcileConversionBlockBinding({ repositories: fixture.repositories, ownerUserId, executionId })
      })

      expect(() => persistence.finalize({
        runId,
        requestId: 'conversion_coordinator_request',
        messageId,
        blocks: [activeBlock],
        status: 'completed',
        endedAt: 5,
      })).toThrow('assistant append failed')
      expect(fixture.chat.conversionBlockBindings.get(ownerUserId, executionId))
        .not.toHaveProperty('finalizedAt')
      expect(terminalMutations(fixture.chat)).toHaveLength(0)
    } finally {
      fixture.stores.close()
      fixture.durable.close()
    }
  })

  it('retires a finalized binding whose durable execution disappeared', async () => {
    const fixture = await seeded({ finalized: true, executionTerminal: true, jobsTerminal: true })
    try {
      fixture.durable.clearLocalData('executions')
      expect(reconcileConversionBlockBinding({
        repositories: fixture.repositories,
        ownerUserId,
        executionId,
      })).toBeUndefined()
      expect(fixture.chat.conversionBlockBindings.get(ownerUserId, executionId)).toMatchObject({
        retirementReason: 'missing_execution',
        retiredAt: expect.any(Number),
      })
      expect(fixture.chat.conversionBlockBindings.listRecoverable(ownerUserId)).toEqual([])
    } finally {
      fixture.stores.close()
      fixture.durable.close()
    }
  })

  it('retires an unfinalized binding whose execution disappeared and does not rescan it', async () => {
    const fixture = await seeded({ finalized: false, executionTerminal: true, jobsTerminal: true })
    try {
      fixture.durable.clearLocalData('executions')
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(reconcileConversionBlockBinding({
          repositories: fixture.repositories,
          ownerUserId,
          executionId,
        })).toBeUndefined()
      }
      const retired = fixture.chat.conversionBlockBindings.get(ownerUserId, executionId)
      expect(retired).not.toHaveProperty('finalizedAt')
      expect(retired).toMatchObject({
        retirementReason: 'missing_execution',
        retiredAt: expect.any(Number),
      })
      expect(fixture.chat.conversionBlockBindings.listRecoverable(ownerUserId)).toEqual([])
      expect(terminalMutations(fixture.chat)).toHaveLength(0)
    } finally {
      fixture.stores.close()
      fixture.durable.close()
    }
  })

  it.each([
    { label: 'duplicate target block', blocks: [activeBlock, { ...activeBlock }] },
    {
      label: 'mismatched execution',
      blocks: [{ ...activeBlock, executionId: 'conversion_coordinator_wrong_execution' }],
    },
  ] satisfies Array<{ label: string; blocks: ChatBlock[] }>)(
    'fails closed and retires a persisted $label',
    async ({ blocks }) => {
      const fixture = await seeded({ finalized: true, executionTerminal: true, jobsTerminal: true })
      try {
        const [cacheFile] = (await readdir(join(fixture.root, 'user-caches')))
          .filter((name) => name.endsWith('.sqlite'))
        if (!cacheFile) throw new Error('missing user cache')
        const tamper = new Database(join(fixture.root, 'user-caches', cacheFile))
        tamper.prepare('UPDATE messages SET blocks_json = ? WHERE id = ?')
          .run(JSON.stringify(blocks), messageId)
        tamper.close()

        expect(() => reconcileConversionBlockBinding({
          repositories: fixture.repositories,
          ownerUserId,
          executionId,
        })).toThrow(UserDataConsistencyError)
        expect(terminalMutations(fixture.chat)).toHaveLength(0)
        expect(fixture.chat.conversionBlockBindings.get(ownerUserId, executionId))
          .toMatchObject({ retirementReason: 'invalid_binding' })
      } finally {
        fixture.stores.close()
        fixture.durable.close()
      }
    },
  )
})
