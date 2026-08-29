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
    store.ensureExecutionSubscription()
    store.developerAttachments = [{ id: 'draft_1', name: 'source.png', mimeType: 'image/png', byteSize: 1 }]

    store.configureDeveloperAttachmentField('')

    await vi.waitFor(() => expect(clearAttachments).toHaveBeenCalledWith({ projectId: 'project_1' }))
    store.$dispose()
  })

  it('does not publish a picker result that completes during a project switch', async () => {
    let resolvePick!: (value: Array<{ id: string; name: string; mimeType: string; byteSize: number }>) => void
    const pickFiles = vi.fn(() => new Promise((resolve) => { resolvePick = resolve }))
    const clearAttachments = vi.fn().mockResolvedValue(undefined)
    const api = {
      auth: {}, profile: {}, chat: {}, workflows: {}, settings: {},
      developer: { clearAttachments, pickFiles, removeAttachment: vi.fn().mockResolvedValue(undefined) },
      executions: { onEvent: () => () => undefined },
    }
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    vi.resetModules()
    const { useDeveloperStore } = await import('../../src/stores/developer')
    const store = useDeveloperStore()
    store.projects = [{ id: 'project_1', name: 'one', files: [] }, { id: 'project_2', name: 'two', files: [] }]
    store.selectedProjectId = 'project_1'
    store.configureDeveloperAttachmentField('files')
    const pending = store.pickDeveloperAttachments()
    const switching = store.selectProject('project_2')
    await vi.waitFor(() => expect(pickFiles).toHaveBeenCalled())
    resolvePick([{ id: 'late', name: 'late.png', mimeType: 'image/png', byteSize: 1 }])
    await Promise.all([pending, switching])

    expect(store.developerAttachments).toEqual([])
    expect(store.debugInput).toEqual({})
    expect(api.developer.removeAttachment).toHaveBeenCalledWith({ projectId: 'project_1', attachmentId: 'late' })
    store.$dispose()
  })

  it('retains failed stale-picker cleanup for a later lifecycle retry without exposing IDs', async () => {
    let resolvePick!: (value: Array<{ id: string; name: string; mimeType: string; byteSize: number }>) => void
    const pickFiles = vi.fn(() => new Promise((resolve) => { resolvePick = resolve }))
    const removeAttachment = vi.fn().mockRejectedValue(new Error('remove failed'))
    const clearAttachments = vi.fn().mockRejectedValue(new Error('clear failed'))
    const api = {
      auth: {}, profile: {}, chat: {}, workflows: {}, settings: {},
      developer: { clearAttachments, pickFiles, removeAttachment },
      executions: { onEvent: () => () => undefined },
    }
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    vi.resetModules()
    const { useDeveloperStore } = await import('../../src/stores/developer')
    const store = useDeveloperStore()
    store.projects = [{ id: 'project_1', name: 'one', files: [] }, { id: 'project_2', name: 'two', files: [] }]
    store.selectedProjectId = 'project_1'
    store.configureDeveloperAttachmentField('files')
    const pending = store.pickDeveloperAttachments()
    await vi.waitFor(() => expect(pickFiles).toHaveBeenCalled())
    store.selectedProjectId = 'project_2'
    resolvePick([{ id: 'hidden', name: 'hidden.png', mimeType: 'image/png', byteSize: 1 }])
    await pending
    expect(store.developerAttachments).toEqual([])

    clearAttachments.mockResolvedValue(undefined)
    pickFiles.mockResolvedValue([])
    await store.pickDeveloperAttachments()
    expect(clearAttachments).toHaveBeenCalledWith({ projectId: 'project_1' })
    store.$dispose()
  })

  it('invalidates a pending picker before dispose', async () => {
    let resolvePick!: (value: Array<{ id: string; name: string; mimeType: string; byteSize: number }>) => void
    const pickFiles = vi.fn(() => new Promise((resolve) => { resolvePick = resolve }))
    const clearAttachments = vi.fn().mockResolvedValue(undefined)
    const removeAttachment = vi.fn().mockResolvedValue(undefined)
    const api = {
      auth: {}, profile: {}, chat: {}, workflows: {}, settings: {},
      developer: { clearAttachments, pickFiles, removeAttachment },
      executions: { onEvent: () => () => undefined },
    }
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    vi.resetModules()
    const { useDeveloperStore } = await import('../../src/stores/developer')
    const store = useDeveloperStore()
    store.selectedProjectId = 'project_1'
    store.configureDeveloperAttachmentField('files')
    store.ensureExecutionSubscription()
    const pending = store.pickDeveloperAttachments()
    await vi.waitFor(() => expect(pickFiles).toHaveBeenCalled())
    store.$dispose()
    resolvePick([{ id: 'disposed', name: 'disposed.png', mimeType: 'image/png', byteSize: 1 }])
    await pending

    expect(store.developerAttachments).toEqual([])
    expect(removeAttachment).toHaveBeenCalledWith({ projectId: 'project_1', attachmentId: 'disposed' })
  })
})
