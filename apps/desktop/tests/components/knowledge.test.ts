import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopAPI, KnowledgeBaseSummary, KnowledgeDocumentSummary } from '@autoforge/shared'
import ElementPlus, { ElMessageBox } from 'element-plus'
import KnowledgeView from '../../src/views/KnowledgeView.vue'
import { useKnowledgeStore } from '../../src/stores/knowledge'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function base(id: string, name = id): KnowledgeBaseSummary {
  return {
    id, name, kind: 'local', status: 'ready', searchable: true, documentCount: 1,
    updatedAt: '2026-08-27T00:00:00.000Z',
  }
}

function document(id: string, baseId: string, status: KnowledgeDocumentSummary['status'] = 'ready'): KnowledgeDocumentSummary {
  return {
    id, baseId, name: `${id}.txt`, mimeType: 'text/plain', status, versionCount: 1,
    updatedAt: '2026-08-27T00:00:00.000Z',
  }
}

function api(overrides: Partial<DesktopAPI['knowledge']> = {}): DesktopAPI {
  const knowledge = {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue(base('base_created', '新知识库')),
    listDocuments: vi.fn().mockResolvedValue([]),
    listVersions: vi.fn().mockResolvedValue([]),
    pickImportFiles: vi.fn().mockResolvedValue([]),
    importDocument: vi.fn(), replaceDocument: vi.fn(),
    recycleDocument: vi.fn(), restoreDocument: vi.fn(), purgeDocument: vi.fn(),
    recycleBase: vi.fn(), restoreBase: vi.fn(), purgeBase: vi.fn(), exportBase: vi.fn(),
    getSelection: vi.fn(), updateSelection: vi.fn(), search: vi.fn(),
    getAvailability: vi.fn().mockResolvedValue({
      encryption: { available: true }, parser: { available: true },
      cloudbase: { available: false, reason: 'cloudbase_unavailable' },
      embedding: { available: false, reason: 'embedding_unavailable' },
      entitlement: { available: true }, beta: { available: true },
      cloud: { available: false, reason: 'cloud_disabled' },
    }),
    getEntitlement: vi.fn().mockResolvedValue({
      tier: 'free', status: 'active', localEnabled: true, cloudEnabled: false,
    }),
    getConsent: vi.fn().mockResolvedValue({ provider: 'openrouter', status: 'unknown' }),
    setConsent: vi.fn().mockResolvedValue({ provider: 'openrouter', status: 'granted' }),
    revokeConsent: vi.fn().mockResolvedValue({ provider: 'openrouter', status: 'unknown' }),
    getSourcePreview: vi.fn().mockResolvedValue({ kind: 'unavailable' }),
    onEvent: vi.fn(() => vi.fn()),
    ...overrides,
  }
  return {
    auth: {}, profile: {}, chat: {}, workflows: {}, executions: {}, settings: {}, knowledge,
  } as unknown as DesktopAPI
}

describe('personal knowledge workspace', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => {
    Reflect.deleteProperty(window, 'autoForge')
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('renders bases, documents, and an inspector as three distinct panes', async () => {
    const client = api({
      list: vi.fn().mockResolvedValue([base('base_1', '个人资料')]),
      listDocuments: vi.fn().mockResolvedValue([document('doc_1', 'base_1')]),
      listVersions: vi.fn().mockResolvedValue([{
        id: 'version_1', documentId: 'doc_1', number: 1, status: 'ready',
        createdAt: '2026-08-27T00:00:00.000Z',
      }]),
    })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: client })
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(KnowledgeView, { global: { plugins: [pinia] } })
    await wrapper.vm.$nextTick()
    const store = useKnowledgeStore()
    await store.bindOwner('alice')
    await flushPromises()

    expect(wrapper.get('[data-testid="knowledge-workspace"]').classes()).toContain('knowledge-workspace')
    expect(wrapper.get('[data-testid="knowledge-base-pane"]').text()).toContain('个人资料')
    expect(wrapper.get('[data-testid="knowledge-document-pane"]').text()).toContain('doc_1.txt')
    await wrapper.get('[data-testid="knowledge-document-doc_1"]').trigger('click')
    await flushPromises()
    const inspector = wrapper.get('[data-testid="knowledge-inspector-pane"]')
    expect(inspector.text()).toContain('版本 1 · 可检索')
    expect(inspector.text()).not.toContain('ready')
  })

  it('renders local availability, base state, and a sanitized failed-document explanation', async () => {
    const failedBase = { ...base('base_failed', '失败资料'), status: 'failed' as const, searchable: false }
    const client = api({
      list: vi.fn().mockResolvedValue([failedBase]),
      listDocuments: vi.fn().mockResolvedValue([document('doc_failed', 'base_failed', 'failed')]),
      getAvailability: vi.fn().mockResolvedValue({
        encryption: { available: false, reason: 'encryption_unavailable' },
        parser: { available: true },
        cloudbase: { available: false, reason: 'cloudbase_unavailable' },
        embedding: { available: false, reason: 'embedding_unavailable' },
        entitlement: { available: true }, beta: { available: true },
        cloud: { available: false, reason: 'cloud_disabled' },
      }),
      getEntitlement: vi.fn().mockResolvedValue({
        tier: 'free', status: 'expired', localEnabled: false, cloudEnabled: false,
      }),
    })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: client })
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(KnowledgeView, { global: { plugins: [pinia, ElementPlus] } })
    const store = useKnowledgeStore()
    await store.bindOwner('alice')
    await flushPromises()

    expect(wrapper.get('[data-testid="knowledge-local-availability"]').text())
      .toContain('本地知识库不可用')
    expect(wrapper.get('[data-testid="knowledge-base-base_failed"]').text())
      .toContain('处理失败')
    await wrapper.get('[data-testid="knowledge-document-doc_failed"]').trigger('click')
    await flushPromises()
    const inspector = wrapper.get('[data-testid="knowledge-inspector-pane"]')
    expect(inspector.text()).toContain('处理失败，可重新导入或替换文件')
    expect(wrapper.get('[data-testid="knowledge-create-toggle"]').attributes()).toHaveProperty('disabled')
    expect(wrapper.get('[data-testid="knowledge-import"]').attributes()).toHaveProperty('disabled')
    expect(inspector.get('[data-testid="knowledge-replace"]').attributes()).toHaveProperty('disabled')
  })

  it('does not present cloud sync as available while its CloudBase gate is closed', async () => {
    const client = api({
      getAvailability: vi.fn().mockResolvedValue({
        encryption: { available: true }, parser: { available: true },
        cloudbase: { available: false, reason: 'cloudbase_unavailable' },
        embedding: { available: false, reason: 'embedding_unavailable' },
        entitlement: { available: true }, beta: { available: true }, cloud: { available: true },
      }),
      getEntitlement: vi.fn().mockResolvedValue({
        tier: 'member', status: 'active', localEnabled: true, cloudEnabled: true,
      }),
    })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: client })
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(KnowledgeView, { global: { plugins: [pinia, ElementPlus] } })
    await useKnowledgeStore().bindOwner('alice')
    await flushPromises()

    expect(wrapper.get('[data-testid="knowledge-local-availability"]').text())
      .toBe('本地知识库可用 · 云同步不可用')
  })

  it('requires confirmation before permanently purging a base or document', async () => {
    const recycledBase = { ...base('base_recycled', '回收站资料'), status: 'recycled' as const, searchable: false }
    const basePurge = deferred<void>()
    const client = api({
      list: vi.fn().mockResolvedValue([recycledBase]),
      listDocuments: vi.fn().mockResolvedValue([document('doc_deleted', 'base_recycled', 'deleted')]),
      purgeBase: vi.fn(() => basePurge.promise),
    })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: client })
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(KnowledgeView, { global: { plugins: [pinia, ElementPlus] } })
    const store = useKnowledgeStore()
    await store.bindOwner('alice')
    await flushPromises()
    await wrapper.get('[data-testid="knowledge-document-doc_deleted"]').trigger('click')
    await flushPromises()
    const confirm = vi.spyOn(ElMessageBox, 'confirm')
      .mockRejectedValueOnce('cancel')
      .mockResolvedValue('confirm')

    await wrapper.get('[data-testid="knowledge-purge-base"]').trigger('click')
    await flushPromises()
    expect(client.knowledge.purgeBase).not.toHaveBeenCalled()
    await wrapper.get('[data-testid="knowledge-purge-base"]').trigger('click')
    await vi.waitFor(() => expect(client.knowledge.purgeBase).toHaveBeenCalledWith('base_recycled'))
    expect(wrapper.get('[data-testid="knowledge-purge-base"]').attributes()).toHaveProperty('disabled')
    basePurge.resolve()
    await flushPromises()
    expect(client.knowledge.purgeBase).toHaveBeenCalledWith('base_recycled')

    await wrapper.get('[data-testid="knowledge-purge-document"]').trigger('click')
    await flushPromises()
    expect(client.knowledge.purgeDocument).toHaveBeenCalledWith('doc_deleted')
    expect(client.knowledge.purgeBase).toHaveBeenCalledOnce()
    expect(client.knowledge.purgeDocument).toHaveBeenCalledOnce()
    expect(confirm).toHaveBeenCalledTimes(3)
  })

  it('disables permanent deletion when local knowledge is unavailable', async () => {
    const recycledBase = { ...base('base_recycled'), status: 'recycled' as const, searchable: false }
    const client = api({
      list: vi.fn().mockResolvedValue([recycledBase]),
      listDocuments: vi.fn().mockResolvedValue([document('doc_deleted', 'base_recycled', 'deleted')]),
      getEntitlement: vi.fn().mockResolvedValue({
        tier: 'free', status: 'expired', localEnabled: false, cloudEnabled: false,
      }),
    })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: client })
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(KnowledgeView, { global: { plugins: [pinia, ElementPlus] } })
    await useKnowledgeStore().bindOwner('alice')
    await flushPromises()

    expect(wrapper.get('[data-testid="knowledge-purge-base"]').attributes()).toHaveProperty('disabled')
    expect(wrapper.get('[data-testid="knowledge-purge-document"]').attributes()).toHaveProperty('disabled')
  })

  it('does not carry an Alice purge confirmation into Bob after an owner switch', async () => {
    const confirmation = deferred<'confirm'>()
    const client = api({
      list: vi.fn()
        .mockResolvedValueOnce([{
          ...base('base_alice', 'Alice'), status: 'recycled' as const, searchable: false,
        }])
        .mockResolvedValueOnce([{
          ...base('base_bob', 'Bob'), status: 'recycled' as const, searchable: false,
        }]),
      listDocuments: vi.fn().mockResolvedValue([]),
    })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: client })
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(KnowledgeView, { global: { plugins: [pinia, ElementPlus] } })
    const store = useKnowledgeStore()
    await store.bindOwner('alice')
    vi.spyOn(ElMessageBox, 'confirm').mockReturnValue(confirmation.promise)

    await wrapper.get('[data-testid="knowledge-purge-base"]').trigger('click')
    expect(wrapper.get('[data-testid="knowledge-purge-base"]').attributes()).toHaveProperty('disabled')
    await store.bindOwner('bob')
    confirmation.resolve('confirm')
    await flushPromises()

    expect(store.ownerId).toBe('bob')
    expect(store.selectedBaseId).toBe('base_bob')
    expect(client.knowledge.purgeBase).not.toHaveBeenCalled()
  })

  it('rejects an old base confirmation after the same UID resets and rebinds the same base', async () => {
    const confirmation = deferred<'confirm'>()
    const purge = deferred<void>()
    const recycledBase = {
      ...base('base_same', '同一知识库'), status: 'recycled' as const, searchable: false,
    }
    const client = api({
      list: vi.fn().mockResolvedValue([recycledBase]),
      listDocuments: vi.fn().mockResolvedValue([]),
      purgeBase: vi.fn(() => purge.promise),
    })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: client })
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(KnowledgeView, { global: { plugins: [pinia, ElementPlus] } })
    const store = useKnowledgeStore()
    await store.bindOwner('alice')
    vi.spyOn(ElMessageBox, 'confirm').mockReturnValue(confirmation.promise)

    await wrapper.get('[data-testid="knowledge-purge-base"]').trigger('click')
    store.resetLocalData()
    await store.bindOwner('alice')
    expect(store.selectedBaseId).toBe('base_same')
    confirmation.resolve('confirm')
    await flushPromises()

    expect(client.knowledge.purgeBase).not.toHaveBeenCalled()
    expect(store.busy).toBe(false)
    purge.resolve()
  })

  it('rejects an old document confirmation after the same UID resets and rebinds the same document', async () => {
    const confirmation = deferred<'confirm'>()
    const purge = deferred<void>()
    const recycledBase = {
      ...base('base_same', '同一知识库'), status: 'recycled' as const, searchable: false,
    }
    const deletedDocument = document('doc_same', 'base_same', 'deleted')
    const client = api({
      list: vi.fn().mockResolvedValue([recycledBase]),
      listDocuments: vi.fn().mockResolvedValue([deletedDocument]),
      purgeDocument: vi.fn(() => purge.promise),
    })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: client })
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(KnowledgeView, { global: { plugins: [pinia, ElementPlus] } })
    const store = useKnowledgeStore()
    await store.bindOwner('alice')
    vi.spyOn(ElMessageBox, 'confirm').mockReturnValue(confirmation.promise)

    await wrapper.get('[data-testid="knowledge-purge-document"]').trigger('click')
    store.resetLocalData()
    await store.bindOwner('alice')
    expect(store.selectedDocumentId).toBe('doc_same')
    confirmation.resolve('confirm')
    await flushPromises()

    expect(client.knowledge.purgeDocument).not.toHaveBeenCalled()
    expect(store.busy).toBe(false)
    purge.resolve()
  })

  it('uses the preload API for import and refreshes the selected base', async () => {
    const client = api({
      list: vi.fn().mockResolvedValue([base('base_1')]),
      listDocuments: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([document('doc_1', 'base_1', 'queued')]),
      pickImportFiles: vi.fn().mockResolvedValue([{
        id: 'handle_1', name: 'guide.txt', mimeType: 'text/plain', byteSize: 12,
      }]),
      importDocument: vi.fn().mockResolvedValue(document('doc_1', 'base_1', 'queued')),
    })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: client })
    const store = useKnowledgeStore()
    await store.bindOwner('alice')
    await store.importDocuments()

    expect(client.knowledge.pickImportFiles).toHaveBeenCalledOnce()
    expect(client.knowledge.importDocument).toHaveBeenCalledWith('base_1', 'handle_1')
    expect(store.documents).toEqual([expect.objectContaining({ id: 'doc_1', status: 'queued' })])
  })

  it('routes replace, recycle, restore, purge, export, and delete operations through preload', async () => {
    const client = api({
      list: vi.fn().mockResolvedValue([base('base_1')]),
      listDocuments: vi.fn().mockResolvedValue([document('doc_1', 'base_1')]),
      pickImportFiles: vi.fn().mockResolvedValue([{
        id: 'handle_replace', name: 'replacement.txt', mimeType: 'text/plain', byteSize: 7,
      }]),
      replaceDocument: vi.fn().mockResolvedValue(document('doc_1', 'base_1', 'queued')),
    })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: client })
    const store = useKnowledgeStore()
    await store.bindOwner('alice')

    await store.replaceDocument()
    await store.runDocumentAction('recycle')
    await store.runDocumentAction('restore')
    await store.runDocumentAction('purge')
    await store.runBaseAction('export')
    await store.runBaseAction('recycle')
    await store.runBaseAction('restore')
    await store.runBaseAction('purge')

    expect(client.knowledge.replaceDocument).toHaveBeenCalledWith('doc_1', 'handle_replace')
    expect(client.knowledge.recycleDocument).toHaveBeenCalledWith('doc_1')
    expect(client.knowledge.restoreDocument).toHaveBeenCalledWith('doc_1')
    expect(client.knowledge.purgeDocument).toHaveBeenCalledWith('doc_1')
    expect(client.knowledge.exportBase).toHaveBeenCalledWith('base_1')
    expect(client.knowledge.recycleBase).toHaveBeenCalledWith('base_1')
    expect(client.knowledge.restoreBase).toHaveBeenCalledWith('base_1')
    expect(client.knowledge.purgeBase).toHaveBeenCalledWith('base_1')
  })

  it('ignores late owner responses and keeps refresh polling single-flight', async () => {
    const alice = deferred<KnowledgeBaseSummary[]>()
    const bob = deferred<KnowledgeBaseSummary[]>()
    const list = vi.fn()
      .mockImplementationOnce(() => alice.promise)
      .mockImplementationOnce(() => bob.promise)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api({ list }) })
    const store = useKnowledgeStore()

    const first = store.bindOwner('alice')
    const second = store.bindOwner('bob')
    const duplicate = store.refresh()
    expect(list).toHaveBeenCalledTimes(2)
    bob.resolve([base('base_bob', 'Bob')])
    await Promise.all([second, duplicate])
    alice.resolve([base('base_alice', 'Alice')])
    await first

    expect(store.ownerId).toBe('bob')
    expect(store.bases.map(({ id }) => id)).toEqual(['base_bob'])
    store.resetLocalData()
    expect(store.bases).toEqual([])
  })

  it('does not let an Alice mutation release Bob busy state or publish Alice errors', async () => {
    const aliceCreate = deferred<KnowledgeBaseSummary>()
    const bobExport = deferred<void>()
    const client = api({
      list: vi.fn()
        .mockResolvedValueOnce([base('base_alice', 'Alice')])
        .mockResolvedValueOnce([base('base_bob', 'Bob')]),
      create: vi.fn(() => aliceCreate.promise),
      exportBase: vi.fn(() => bobExport.promise),
    })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: client })
    const store = useKnowledgeStore()
    await store.bindOwner('alice')
    const staleMutation = store.createBase('Alice 私有库')

    await store.bindOwner('bob')
    const bobMutation = store.runBaseAction('export')
    expect(store.busy).toBe(true)

    aliceCreate.reject(new Error('alice-only failure'))
    await staleMutation
    expect(store.ownerId).toBe('bob')
    expect(store.selectedBaseId).toBe('base_bob')
    expect(store.error).toBe('')
    expect(store.busy).toBe(true)

    bobExport.resolve()
    await bobMutation
    expect(store.busy).toBe(false)
  })

  it('stops an import after the owner changes while the file picker is pending', async () => {
    const alicePicker = deferred<Awaited<ReturnType<DesktopAPI['knowledge']['pickImportFiles']>>>()
    const client = api({
      list: vi.fn()
        .mockResolvedValueOnce([base('base_alice', 'Alice')])
        .mockResolvedValueOnce([base('base_bob', 'Bob')]),
      pickImportFiles: vi.fn(() => alicePicker.promise),
    })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: client })
    const store = useKnowledgeStore()
    await store.bindOwner('alice')
    const staleImport = store.importDocuments()

    await store.bindOwner('bob')
    alicePicker.resolve([{
      id: 'alice_handle', name: 'alice.txt', mimeType: 'text/plain', byteSize: 5,
    }])
    await staleImport

    expect(client.knowledge.importDocument).not.toHaveBeenCalled()
    expect(store.ownerId).toBe('bob')
    expect(store.selectedBaseId).toBe('base_bob')
  })

  it.each(['replace', 'document purge', 'base purge'] as const)(
    'does not refresh Bob after a late Alice %s mutation',
    async (kind) => {
      const mutation = deferred<void>()
      const list = vi.fn()
        .mockResolvedValueOnce([base('base_alice', 'Alice')])
        .mockResolvedValueOnce([base('base_bob', 'Bob')])
      const listDocuments = vi.fn()
        .mockResolvedValueOnce([document('doc_alice', 'base_alice')])
        .mockResolvedValueOnce([document('doc_bob', 'base_bob')])
      const client = api({
        list,
        listDocuments,
        pickImportFiles: vi.fn().mockResolvedValue([{
          id: 'alice_handle', name: 'alice.txt', mimeType: 'text/plain', byteSize: 5,
        }]),
        replaceDocument: vi.fn(() => mutation.promise),
        purgeDocument: vi.fn(() => mutation.promise),
        purgeBase: vi.fn(() => mutation.promise),
      })
      Object.defineProperty(window, 'autoForge', { configurable: true, value: client })
      const store = useKnowledgeStore()
      await store.bindOwner('alice')
      const staleMutation = kind === 'replace'
        ? store.replaceDocument()
        : kind === 'document purge'
          ? store.runDocumentAction('purge')
          : store.runBaseAction('purge')
      const remote = kind === 'replace'
        ? client.knowledge.replaceDocument
        : kind === 'document purge'
          ? client.knowledge.purgeDocument
          : client.knowledge.purgeBase
      await vi.waitFor(() => expect(remote).toHaveBeenCalledOnce())

      await store.bindOwner('bob')
      const listCalls = list.mock.calls.length
      const documentCalls = listDocuments.mock.calls.length
      mutation.resolve()
      await staleMutation

      expect(store.ownerId).toBe('bob')
      expect(store.selectedBaseId).toBe('base_bob')
      expect(list).toHaveBeenCalledTimes(listCalls)
      expect(listDocuments).toHaveBeenCalledTimes(documentCalls)
    },
  )

  it('releases its IPC subscription when the Pinia store is disposed', async () => {
    vi.useFakeTimers()
    const release = vi.fn()
    const listDocuments = vi.fn().mockResolvedValue([document('doc_queued', 'base_1', 'queued')])
    Object.defineProperty(window, 'autoForge', {
      configurable: true,
      value: api({
        list: vi.fn().mockResolvedValue([base('base_1')]), listDocuments,
        onEvent: vi.fn(() => release),
      }),
    })
    const store = useKnowledgeStore()
    await store.bindOwner('alice')
    const callsBeforeDispose = listDocuments.mock.calls.length

    store.$dispose()
    await vi.advanceTimersByTimeAsync(30_000)

    expect(release).toHaveBeenCalledOnce()
    expect(listDocuments).toHaveBeenCalledTimes(callsBeforeDispose)
  })

  it('cancels job polling on reset and caps retry backoff', async () => {
    vi.useFakeTimers()
    const listDocuments = vi.fn()
      .mockResolvedValueOnce([document('doc_queued', 'base_1', 'queued')])
      .mockRejectedValue(new Error('offline'))
    Object.defineProperty(window, 'autoForge', {
      configurable: true,
      value: api({ list: vi.fn().mockResolvedValue([base('base_1')]), listDocuments }),
    })
    const store = useKnowledgeStore()
    await store.bindOwner('alice')

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await vi.advanceTimersByTimeAsync(store._pollDelayMs)
    }
    expect(store._pollDelayMs).toBe(15_000)
    const callsBeforeReset = listDocuments.mock.calls.length
    store.resetLocalData()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(listDocuments).toHaveBeenCalledTimes(callsBeforeReset)
  })
})
