import { describe, expect, it, vi } from 'vitest'
import type { AppErrorCode } from '@autoforge/shared'
import type { BrowserTabBinding } from '../database/repositories.js'
import {
  BrowserContinuationRegistry,
  type BrowserContinuationRegistryWorkspace,
} from './browser-continuation-registry.js'
import type { BrowserContinuationBindingInput } from './browser-continuation-types.js'

function bindingInput(
  overrides: Partial<BrowserContinuationBindingInput> = {},
): BrowserContinuationBindingInput {
  return {
    tabId: 'tab_1',
    userId: 'user_1',
    conversationId: 'conversation_1',
    chatRunId: 'chat_run_1',
    executionId: 'execution_1',
    workflowId: 'workflow.one',
    workflowVersion: '1.0.0',
    source: 'installed',
    securityFingerprint: 'a'.repeat(64),
    permissionMatrix: {
      'browser.open': ['https://a.example/*'],
      'browser.click': ['https://b.example/*'],
    },
    browserContinuation: {
      auth: { loggedIn: ['role=button[name="账户"]'] },
      readableRegions: ['css=main'],
    },
    ...overrides,
  }
}

function createHarness() {
  const stored = new Map<string, BrowserTabBinding>()
  const inserted: BrowserTabBinding[] = []
  const terminal: Array<{
    id: string
    status: 'revoked' | 'closed'
    reason: AppErrorCode
    endedAt: number
  }> = []
  const owners = new Map<string, string>()
  const workflowOwned = new Set<string>()
  const closed: string[] = []
  const repository = {
    insert: vi.fn((value: BrowserTabBinding) => {
      stored.set(value.id, structuredClone(value))
      inserted.push(structuredClone(value))
      return value
    }),
    terminate: vi.fn((id: string, value: {
      status: 'revoked' | 'closed'
      terminalReason: AppErrorCode
      endedAt: number
    }) => {
      const current = stored.get(id)
      if (!current) return undefined
      const updated = { ...current, ...value }
      stored.set(id, updated)
      terminal.push({ id, status: value.status, reason: value.terminalReason, endedAt: value.endedAt })
      return updated
    }),
  }
  const workspace: BrowserContinuationRegistryWorkspace = {
    async acquireContinuation(tabId, runId) {
      if (workflowOwned.has(tabId) || owners.has(tabId)) {
        throw Object.assign(new Error('busy'), { code: 'PAGE_BUSY' })
      }
      owners.set(tabId, runId)
    },
    async releaseContinuation(tabId, runId) {
      if (owners.get(tabId) === runId) owners.delete(tabId)
    },
    async closeContinuation(tabId) {
      owners.delete(tabId)
      closed.push(tabId)
    },
  }
  let id = 0
  let eligible = true
  const isEligible = vi.fn(async () => eligible)
  const registry = new BrowserContinuationRegistry({
    repository,
    workspace,
    isEligible,
    id: () => `binding_${++id}`,
    now: () => 100 + id,
  })
  return {
    registry, repository, workspace, stored, inserted, terminal, owners, workflowOwned, closed,
    isEligible, setEligible: (value: boolean) => { eligible = value },
  }
}

describe('BrowserContinuationRegistry', () => {
  it('keeps action-scoped permissions and policy metadata as deeply frozen defensive copies', () => {
    const test = createHarness()
    const input = bindingInput()

    const binding = test.registry.bind(input)
    ;(input.permissionMatrix['browser.click'] as string[])[0] = 'https://attacker.example/*'
    ;(input.browserContinuation!.auth!.loggedIn as string[])[0] = 'css=#attacker'

    expect(binding.permissionMatrix['browser.open']).toEqual(['https://a.example/*'])
    expect(binding.permissionMatrix['browser.click']).toEqual(['https://b.example/*'])
    expect(binding.browserContinuation?.auth?.loggedIn).toEqual(['role=button[name="账户"]'])
    expect(Object.isFrozen(binding)).toBe(true)
    expect(Object.isFrozen(binding.permissionMatrix['browser.click'])).toBe(true)
    expect(Object.isFrozen(binding.browserContinuation?.auth?.loggedIn)).toBe(true)
  })

  it('lists bindings only for the exact user and conversation and creates a separate popup binding', () => {
    const test = createHarness()
    const parent = test.registry.bind(bindingInput())

    const child = test.registry.bindPopup(parent.tabId, 'tab_popup')

    expect(child).toMatchObject({ tabId: 'tab_popup', conversationId: 'conversation_1' })
    expect(child.bindingId).not.toBe(parent.bindingId)
    expect(test.registry.list('user_1', 'conversation_1').map(({ tabId }) => tabId)).toEqual(['tab_1', 'tab_popup'])
    expect(test.registry.list('user_1', 'conversation_2')).toEqual([])
    expect(test.registry.list('user_2', 'conversation_1')).toEqual([])
  })

  it('returns PAGE_BUSY instead of stealing workflow or continuation ownership', async () => {
    const test = createHarness()
    const binding = test.registry.bind(bindingInput())
    test.workflowOwned.add(binding.tabId)

    await expect(test.registry.acquire(binding.bindingId, {
      userId: binding.userId, conversationId: binding.conversationId, runId: 'chat_run_2',
    })).rejects.toMatchObject({ code: 'PAGE_BUSY' })
    expect(test.workflowOwned.has(binding.tabId)).toBe(true)

    test.workflowOwned.delete(binding.tabId)
    const lease = await test.registry.acquire(binding.bindingId, {
      userId: binding.userId, conversationId: binding.conversationId, runId: 'chat_run_2',
    })
    expect(lease.isCurrent(binding)).toBe(true)
    expect(lease.isCurrent(Object.freeze({ ...binding }))).toBe(false)
    await expect(test.registry.acquire(binding.bindingId, {
      userId: binding.userId, conversationId: binding.conversationId, runId: 'chat_run_3',
    })).rejects.toMatchObject({ code: 'PAGE_BUSY' })
    expect(test.owners.get(binding.tabId)).toBe('chat_run_2')

    await lease.release()
    await lease.release()
    expect(lease.isCurrent(binding)).toBe(false)
    expect(test.owners.has(binding.tabId)).toBe(false)
  })

  it('retains lease ownership when workspace release fails and permits an exact retry', async () => {
    const test = createHarness()
    const binding = test.registry.bind(bindingInput())
    const lease = await test.registry.acquire(binding.bindingId, {
      userId: binding.userId, conversationId: binding.conversationId, runId: 'run_retry',
    })
    const underlyingRelease = test.workspace.releaseContinuation.bind(test.workspace)
    const release = vi.spyOn(test.workspace, 'releaseContinuation')
      .mockRejectedValueOnce(new Error('release failed'))
      .mockImplementation(underlyingRelease)

    await expect(lease.release()).rejects.toThrow('release failed')
    expect(lease.isCurrent(binding)).toBe(true)
    expect(test.registry.currentLease(binding.bindingId)).toEqual({ binding, runId: 'run_retry' })
    expect(test.owners.get(binding.tabId)).toBe('run_retry')

    await expect(lease.release()).resolves.toBeUndefined()
    expect(lease.isCurrent(binding)).toBe(false)
    expect(test.registry.currentLease(binding.bindingId)).toBeUndefined()
    expect(test.owners.has(binding.tabId)).toBe(false)
    expect(release).toHaveBeenCalledTimes(2)
  })

  it('revokes ineligible bindings before catalog admission or lease acquisition', async () => {
    const test = createHarness()
    const binding = test.registry.bind(bindingInput())
    test.setEligible(false)

    await expect(test.registry.listEligible('user_1', 'conversation_1')).resolves.toEqual([])
    expect(test.registry.get(binding.bindingId)).toBeUndefined()
    expect(test.closed).toContain(binding.tabId)
    expect(test.terminal).toContainEqual(expect.objectContaining({
      id: binding.bindingId, status: 'revoked', reason: 'WORKFLOW_CHANGED',
    }))

    const second = test.registry.bind(bindingInput({ tabId: 'tab_2' }))
    await expect(test.registry.acquire(second.bindingId, {
      userId: second.userId, conversationId: second.conversationId, runId: 'run_2',
    })).rejects.toMatchObject({ code: 'WORKFLOW_CHANGED' })
    expect(test.owners.has(second.tabId)).toBe(false)
  })

  it('revalidates after workspace acquisition and through the live lease', async () => {
    const race = createHarness()
    const raced = race.registry.bind(bindingInput())
    const acquire = race.workspace.acquireContinuation
    race.workspace.acquireContinuation = async (tabId, runId) => {
      await acquire(tabId, runId)
      race.setEligible(false)
    }
    await expect(race.registry.acquire(raced.bindingId, {
      userId: raced.userId, conversationId: raced.conversationId, runId: 'run_race',
    })).rejects.toMatchObject({ code: 'WORKFLOW_CHANGED' })
    expect(race.owners.has(raced.tabId)).toBe(false)
    expect(race.registry.get(raced.bindingId)).toBeUndefined()

    const live = createHarness()
    const binding = live.registry.bind(bindingInput())
    const lease = await live.registry.acquire(binding.bindingId, {
      userId: binding.userId, conversationId: binding.conversationId, runId: 'run_live',
    })
    live.setEligible(false)
    await expect(lease.assertEligible()).rejects.toMatchObject({ code: 'WORKFLOW_CHANGED' })
    expect(lease.isCurrent(binding)).toBe(false)
    expect(live.owners.has(binding.tabId)).toBe(false)
  })

  it('persists close and revoke transitions while removing live authority and releasing leases', async () => {
    const test = createHarness()
    const closedBinding = test.registry.bind(bindingInput())
    const lease = await test.registry.acquire(closedBinding.bindingId, {
      userId: 'user_1', conversationId: 'conversation_1', runId: 'run_2',
    })

    test.registry.markClosed(closedBinding.tabId, 'PAGE_CLOSED')

    expect(test.registry.list('user_1', 'conversation_1')).toEqual([])
    expect(test.owners.has(closedBinding.tabId)).toBe(false)
    expect(test.terminal).toContainEqual({
      id: closedBinding.bindingId, status: 'closed', reason: 'PAGE_CLOSED', endedAt: expect.any(Number),
    })
    await expect(lease.release()).resolves.toBeUndefined()

    const first = test.registry.bind(bindingInput({ tabId: 'tab_2' }))
    const second = test.registry.bind(bindingInput({ tabId: 'tab_3' }))
    await test.registry.revokeConversation('conversation_1', 'CANCELLED')

    expect(test.registry.list('user_1', 'conversation_1')).toEqual([])
    expect(test.closed).toEqual(expect.arrayContaining([first.tabId, second.tabId]))
    expect(test.terminal).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.bindingId, status: 'revoked', reason: 'CANCELLED' }),
      expect.objectContaining({ id: second.bindingId, status: 'revoked', reason: 'CANCELLED' }),
    ]))
  })

  it('does not recreate live authority from repository rows and shuts down all users', async () => {
    const test = createHarness()
    test.stored.set('durable_only', {
      id: 'durable_only', tabId: 'old_tab', userId: 'user_1', conversationId: 'conversation_1',
      chatRunId: 'old_run', executionId: 'old_execution', workflowId: 'workflow.one',
      workflowVersion: '1.0.0', source: 'installed', securityFingerprint: 'a'.repeat(64),
      permissionMatrix: { 'browser.open': ['https://a.example/*'] }, status: 'active', createdAt: 1,
    })
    const own = test.registry.bind(bindingInput())
    const other = test.registry.bind(bindingInput({ tabId: 'tab_other', userId: 'user_2', conversationId: 'conversation_2' }))

    expect(test.registry.list('user_1', 'conversation_1').map(({ bindingId }) => bindingId)).toEqual([own.bindingId])
    await expect(test.registry.acquire('durable_only', {
      userId: 'user_1', conversationId: 'conversation_1', runId: 'run_new',
    })).rejects.toMatchObject({ code: 'PAGE_CLOSED' })

    await test.registry.shutdown()
    expect(test.closed).toEqual(expect.arrayContaining([own.tabId, other.tabId]))
    expect(test.registry.list('user_2', 'conversation_2')).toEqual([])
  })

  it('removes every live binding when one tab fails to close during shutdown', async () => {
    const test = createHarness()
    const first = test.registry.bind(bindingInput())
    const second = test.registry.bind(bindingInput({
      tabId: 'tab_2', userId: 'user_2', conversationId: 'conversation_2',
    }))
    const originalClose = test.workspace.closeContinuation
    test.workspace.closeContinuation = async (tabId) => {
      if (tabId === first.tabId) throw new Error('close failed')
      return originalClose(tabId)
    }

    await expect(test.registry.shutdown()).rejects.toThrow('close failed')

    expect(test.registry.list(first.userId, first.conversationId)).toEqual([])
    expect(test.registry.list(second.userId, second.conversationId)).toEqual([])
    expect(test.closed).toContain(second.tabId)
  })

  it('releases ownership and closes the tab when audit termination fails, then surfaces that first error', async () => {
    const test = createHarness()
    const binding = test.registry.bind(bindingInput())
    await test.registry.acquire(binding.bindingId, {
      userId: binding.userId, conversationId: binding.conversationId, runId: 'run_2',
    })
    const auditError = new Error('audit termination failed')
    test.repository.terminate.mockImplementationOnce(() => { throw auditError })
    const closeContinuation = test.workspace.closeContinuation
    test.workspace.closeContinuation = async (tabId) => {
      await closeContinuation(tabId)
      throw new Error('close failed later')
    }

    await expect(test.registry.revokeBinding(binding.bindingId, 'CANCELLED')).rejects.toBe(auditError)

    expect(test.registry.list(binding.userId, binding.conversationId)).toEqual([])
    expect(test.owners.has(binding.tabId)).toBe(false)
    expect(test.closed).toContain(binding.tabId)
  })
})
