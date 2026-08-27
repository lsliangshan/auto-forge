import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopAPI, KnowledgeBaseSummary, KnowledgeDocumentSummary } from '@autoforge/shared'
import KnowledgeView from '../../src/views/KnowledgeView.vue'
import { useKnowledgeStore } from '../../src/stores/knowledge'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
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
    expect(wrapper.get('[data-testid="knowledge-inspector-pane"]').text()).toContain('版本 1')
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
