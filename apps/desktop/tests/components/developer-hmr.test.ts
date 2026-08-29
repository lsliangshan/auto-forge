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
      developer: { clearAttachments: vi.fn().mockResolvedValue(undefined) },
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
    store.selectedProjectId = 'project_1'
    ;(store as unknown as { developerAttachments: unknown[] }).developerAttachments = [{
      id: 'draft_hmr', name: 'source.png', mimeType: 'image/png', byteSize: 10,
    }]
    store.$dispose()
    expect(api.developer.clearAttachments).toHaveBeenCalledWith({ projectId: 'project_1' })
  })

  it('clears Main-owned drafts when HMR removes the picker annotation', async () => {
    const clearAttachments = vi.fn().mockResolvedValue(undefined)
    const api = {
      auth: {}, profile: {}, chat: {}, workflows: {}, settings: {},
      developer: { clearAttachments },
      executions: { onEvent: () => () => undefined },
    }
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    vi.resetModules()
    const { useDeveloperStore } = await import('../../src/stores/developer')
    const store = useDeveloperStore()
    store.selectedProjectId = 'project_1'
    store.configureDeveloperAttachmentField('files')
    store.developerAttachments = [{ id: 'draft_1', name: 'source.png', mimeType: 'image/png', byteSize: 1 }]

    store.configureDeveloperAttachmentField('')

    await vi.waitFor(() => expect(clearAttachments).toHaveBeenCalledWith({ projectId: 'project_1' }))
    store.$dispose()
  })
})
