import { createPinia, setActivePinia, type StoreGeneric } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopAPI, ExecutionEvent } from '@autoforge/shared'

describe('developer store hot updates', () => {
  afterEach(() => {
    vi.resetModules()
    Reflect.deleteProperty(window, 'autoForge')
  })

  it('delivers one execution event after the store module is hot-updated', async () => {
    const listeners = new Set<(event: ExecutionEvent) => void>()
    const api = {
      auth: {}, profile: {}, chat: {}, workflows: {}, settings: {},
      executions: {
        onEvent(listener: (event: ExecutionEvent) => void) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
    } as unknown as DesktopAPI
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const pinia = createPinia()
    setActivePinia(pinia)

    vi.resetModules()
    const firstModule = await import('../../src/stores/developer')
    const store = firstModule.useDeveloperStore(pinia)
    store.debugExecutionId = 'exec_1'
    store.ensureExecutionSubscription()

    vi.resetModules()
    const updatedModule = await import('../../src/stores/developer')
    updatedModule.useDeveloperStore(pinia, store as StoreGeneric)
    store.ensureExecutionSubscription()

    const event: ExecutionEvent = {
      type: 'status', executionId: 'exec_1', status: 'running',
      occurredAt: '2026-08-21T00:00:00.000Z',
    }
    for (const listener of listeners) listener(event)

    expect(store.debugEvents).toEqual([event])
    store.$dispose()
  })
})
