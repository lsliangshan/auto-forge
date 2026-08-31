import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DesktopAPI,
  KnowledgeBaseSummary,
  KnowledgeDocumentPreview,
  KnowledgeDocumentSummary,
} from '@autoforge/shared'
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
    retainFreeAllowance: vi.fn().mockResolvedValue({
      tier: 'free', status: 'expired', localEnabled: true, cloudEnabled: false,
      retainedBaseId: 'base_1', retainedDocumentId: 'doc_1',
    }),
    getConsent: vi.fn().mockResolvedValue({ provider: 'openrouter', status: 'unknown' }),
    setConsent: vi.fn().mockResolvedValue({ provider: 'openrouter', status: 'granted' }),
    revokeConsent: vi.fn().mockResolvedValue({ provider: 'openrouter', status: 'unknown' }),
    getDocumentPreview: vi.fn().mockResolvedValue({ kind: 'unavailable' }),
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
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('renders a unified tree and switches the document workspace between preview, information, and versions', async () => {
    const client = api({
      list: vi.fn().mockResolvedValue([base('base_1', '个人资料')]),
      listDocuments: vi.fn().mockResolvedValue([document('doc_1', 'base_1')]),
      listVersions: vi.fn().mockResolvedValue([{
        id: 'version_1', documentId: 'doc_1', number: 1, status: 'ready',
        createdAt: '2026-08-27T00:00:00.000Z',
      }]),
      getDocumentPreview: vi.fn().mockResolvedValue({
        kind: 'original', mimeType: 'text/plain',
        bytes: new TextEncoder().encode('春游活动公告\n请于上午八点半到园。'),
        fallback: { content: '春游活动公告 请于上午八点半到园。', truncated: false },
      }),
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
    expect(wrapper.get('[data-testid="knowledge-tree"]').text()).toContain('个人资料')
    expect(wrapper.get('[data-testid="knowledge-tree"]').text()).toContain('doc_1.txt')
    expect(wrapper.find('[data-testid="knowledge-document-pane"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="knowledge-original-preview"]').text()).toContain('春游活动公告')
    expect(wrapper.get('[data-testid="knowledge-original-preview"]').text()).toContain('原始文件')
    await wrapper.get('[data-testid="knowledge-tab-info"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="knowledge-workbench"]').text()).toContain('text/plain')
    await wrapper.get('[data-testid="knowledge-tab-versions"]').trigger('click')
    expect(wrapper.get('[data-testid="knowledge-workbench"]').text()).toContain('版本 1 · 可检索')
    expect(wrapper.get('[data-testid="knowledge-workbench"]').text()).not.toContain('ready')
  })

  it('renders Markdown documents as formatted content without enabling embedded HTML', async () => {
    const markdownDocument = {
      ...document('guide', 'base_1'),
      name: 'guide.md',
      mimeType: 'text/markdown',
    } as KnowledgeDocumentSummary
    const client = api({
      list: vi.fn().mockResolvedValue([base('base_1', '产品资料')]),
      listDocuments: vi.fn().mockResolvedValue([markdownDocument]),
      getDocumentPreview: vi.fn().mockResolvedValue({
        kind: 'original', mimeType: 'text/markdown',
        bytes: new TextEncoder().encode([
          '# 使用指南',
          '',
          '这是 **重要说明**。',
          '',
          '- 第一步',
          '- 第二步',
          '',
          '`pnpm test`',
          '',
          '<script>globalThis.compromised = true</script>',
        ].join('\n')),
      }),
    })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: client })
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(KnowledgeView, { global: { plugins: [pinia] } })
    await useKnowledgeStore().bindOwner('alice')
    await flushPromises()

    const preview = wrapper.get('[data-testid="knowledge-original-preview"]')
    expect(preview.get('h1').text()).toBe('使用指南')
    expect(preview.get('.rich-document strong').text()).toBe('重要说明')
    expect(preview.findAll('li').map(item => item.text())).toEqual(['第一步', '第二步'])
    expect(preview.get('code').text()).toBe('pnpm test')
    expect(preview.find('script').exists()).toBe(false)
    expect(preview.text()).toContain('<script>globalThis.compromised = true</script>')
  })

  it('turns empty states into contextual next actions', async () => {
    const client = api()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: client })
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(KnowledgeView, { attachTo: globalThis.document.body, global: { plugins: [pinia] } })
    await useKnowledgeStore().bindOwner('alice')
    await flushPromises()

    expect(wrapper.get('[data-testid="knowledge-empty-create"]').text()).toContain('新建知识库')
    const trigger = wrapper.get('[data-testid="knowledge-empty-create"]')
    await trigger.trigger('click')
    await flushPromises()
    const dialog = globalThis.document.body.querySelector<HTMLElement>('[data-testid="knowledge-create-dialog"]')
    const input = dialog?.querySelector<HTMLInputElement>('input[aria-label="知识库名称"]')
    expect(dialog?.getAttribute('role')).toBe('dialog')
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
    expect(wrapper.get('[data-testid="knowledge-tree"]').find('input').exists()).toBe(false)
    expect(globalThis.document.activeElement).toBe(input)

    input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(globalThis.document.body.querySelector('[data-testid="knowledge-create-dialog"]')).toBeNull()
    expect(globalThis.document.activeElement).toBe(trigger.element)
    wrapper.unmount()
  })

  it('creates a knowledge base from the modal and closes it after success', async () => {
    const pendingCreate = deferred<KnowledgeBaseSummary>()
    const create = vi.fn(() => pendingCreate.promise)
    const client = api({
      create,
      getEntitlement: vi.fn().mockResolvedValue({
        tier: 'member', status: 'active', localEnabled: true, cloudEnabled: false,
        limits: { knowledgeBases: 20, knowledgeDocuments: 500, knowledgeFileBytes: 67_108_864 },
      }),
    })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: client })
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(KnowledgeView, { attachTo: globalThis.document.body, global: { plugins: [pinia] } })
    await useKnowledgeStore().bindOwner('alice')
    await flushPromises()

    await wrapper.get('[data-testid="knowledge-create-toggle"]').trigger('click')
    await flushPromises()
    const dialog = globalThis.document.body.querySelector<HTMLElement>('[data-testid="knowledge-create-dialog"]')
    const input = dialog?.querySelector<HTMLInputElement>('input[aria-label="知识库名称"]')
    const form = dialog?.querySelector<HTMLFormElement>('form')
    input!.value = '  项目资料  '
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await wrapper.vm.$nextTick()

    expect(dialog?.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true)
    form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    expect(create).toHaveBeenCalledOnce()
    pendingCreate.resolve(base('base_created', '项目资料'))
    await flushPromises()

    expect(create).toHaveBeenCalledWith('项目资料')
    expect(globalThis.document.body.querySelector('[data-testid="knowledge-create-dialog"]')).toBeNull()
    wrapper.unmount()
  })

  it('guides a free user to replace the active file instead of starting a conflicting import', async () => {
    const client = api({
      list: vi.fn().mockResolvedValue([base('base_1', '个人资料')]),
      listDocuments: vi.fn().mockResolvedValue([document('doc_1', 'base_1')]),
    })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: client })
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(KnowledgeView, { global: { plugins: [pinia] } })
    const store = useKnowledgeStore()
    await store.bindOwner('alice')
    await flushPromises()

    const importButton = wrapper.get('[data-testid="knowledge-import"]')
    expect(importButton.attributes()).toHaveProperty('disabled')
    expect(importButton.attributes('title')).toBe('当前会员版本的文件数量已达上限；回收站、处理失败和处理中条目也会计入，请永久删除后重试')
    await importButton.trigger('click')
    expect(client.knowledge.pickImportFiles).not.toHaveBeenCalled()
    await store.importDocuments()
    expect(store.error).toBe('当前会员版本的文件数量已达上限；回收站、处理失败和处理中条目也会计入，请永久删除后重试')
    expect(client.knowledge.pickImportFiles).not.toHaveBeenCalled()
  })

  it('keeps import enabled for a Pro member with one existing document', async () => {
    const client = api({
      list: vi.fn().mockResolvedValue([base('base_1', '日常')]),
      listDocuments: vi.fn().mockResolvedValue([document('doc_1', 'base_1')]),
      getEntitlement: vi.fn().mockResolvedValue({
        tier: 'member', status: 'active', localEnabled: true, cloudEnabled: false,
        limits: { knowledgeBases: 20, knowledgeDocuments: 500, knowledgeFileBytes: 67_108_864 },
      }),
    })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: client })
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(KnowledgeView, { global: { plugins: [pinia] } })
    await useKnowledgeStore().bindOwner('alice')
    await flushPromises()

    expect(wrapper.get('[data-testid="knowledge-import"]').attributes())
      .not.toHaveProperty('disabled')
    expect(wrapper.text()).not.toContain('免费版：1 个本地知识库')
  })

  it('renders expired extras read-only and sends the chosen keep-one pair through preload', async () => {
    const client = api({
      list: vi.fn().mockResolvedValue([
        base('base_kept', '原保留库'),
        { ...base('base_extra', '额外库'), status: 'read_only', searchable: false, readOnly: true },
      ]),
      listDocuments: vi.fn().mockImplementation(async (baseId: string) => [
        { ...document(baseId === 'base_extra' ? 'doc_extra' : 'doc_kept', baseId),
          ...(baseId === 'base_extra' ? { readOnly: true } : {}) },
      ]),
      getEntitlement: vi.fn().mockResolvedValue({
        tier: 'free', status: 'expired', localEnabled: true, cloudEnabled: false,
        retainedBaseId: 'base_kept', retainedDocumentId: 'doc_kept',
      }),
    })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: client })
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(KnowledgeView, { global: { plugins: [pinia, ElementPlus] } })
    const store = useKnowledgeStore()
    await store.bindOwner('alice')
    await store.selectBase('base_extra')
    await flushPromises()

    expect(wrapper.get('[data-testid="knowledge-local-availability"]').text())
      .toContain('会员已到期，额外内容只读')
    expect(wrapper.get('[data-testid="knowledge-document-doc_extra"]').text()).toContain('只读')
    expect(wrapper.get('[data-testid="knowledge-import"]').attributes()).toHaveProperty('disabled')
    expect(wrapper.get('[data-testid="knowledge-replace"]').attributes()).toHaveProperty('disabled')
    await wrapper.get('[data-testid="knowledge-retain-free-selection"]').trigger('click')
    await flushPromises()
    expect(client.knowledge.retainFreeAllowance).toHaveBeenCalledWith({
      baseId: 'base_extra', documentId: 'doc_extra',
    })
  })

  it('keeps a recycled read-only extra exportable and deletable without allowing restore', async () => {
    const recycled = {
      ...base('base_extra', '额外库'), status: 'recycled' as const,
      searchable: false, readOnly: true,
    }
    const client = api({
      list: vi.fn().mockResolvedValue([recycled]),
      getEntitlement: vi.fn().mockResolvedValue({
        tier: 'free', status: 'expired', localEnabled: true, cloudEnabled: false,
        retainedBaseId: 'base_kept', retainedDocumentId: 'doc_kept',
      }),
    })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: client })
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(KnowledgeView, { global: { plugins: [pinia, ElementPlus] } })
    await useKnowledgeStore().bindOwner('alice')
    await flushPromises()

    const exportButton = wrapper.get('[data-testid="knowledge-export-base"]')
    expect(exportButton.attributes()).not.toHaveProperty('disabled')
    expect(wrapper.get('[data-testid="knowledge-restore-base"]').attributes())
      .toHaveProperty('disabled')
    expect(wrapper.get('[data-testid="knowledge-purge-base"]').attributes())
      .not.toHaveProperty('disabled')
    await exportButton.trigger('click')
    await flushPromises()
    expect(client.knowledge.exportBase).toHaveBeenCalledWith('base_extra')
    expect(client.knowledge.restoreBase).not.toHaveBeenCalled()
  })

  it('offers keep-one confirmation for every unconfirmed free downgrade state', async () => {
    const client = api({
      list: vi.fn().mockResolvedValue([base('base_1')]),
      listDocuments: vi.fn().mockResolvedValue([document('doc_1', 'base_1')]),
      getEntitlement: vi.fn().mockResolvedValue({
        tier: 'free', status: 'active', localEnabled: true, cloudEnabled: false,
        retainedBaseId: 'base_1', retainedDocumentId: 'doc_1', retentionConfirmed: false,
      }),
    })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: client })
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(KnowledgeView, { global: { plugins: [pinia, ElementPlus] } })
    await useKnowledgeStore().bindOwner('alice')
    await flushPromises()

    expect(wrapper.find('[data-testid="knowledge-retain-free-selection"]').exists()).toBe(true)
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
    expect(confirm).toHaveBeenLastCalledWith(
      '永久删除“doc_deleted.txt”及其全部版本？此操作无法撤销。',
      '永久删除文档',
      expect.objectContaining({
        type: 'error',
        customClass: 'knowledge-purge-message-box',
        confirmButtonType: 'danger',
      }),
    )
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
      list: vi.fn().mockResolvedValue([{ ...base('base_1'), documentCount: 0 }]),
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

  it('zeroes original preview bytes when a late document response loses selection', async () => {
    const late = deferred<KnowledgeDocumentPreview>()
    const lateBytes = new TextEncoder().encode('Alice private document')
    const currentBytes = new TextEncoder().encode('Current document')
    const client = api({
      list: vi.fn().mockResolvedValue([base('base_1', '个人资料')]),
      listDocuments: vi.fn().mockResolvedValue([
        document('doc_1', 'base_1'), document('doc_2', 'base_1'),
      ]),
      getDocumentPreview: vi.fn((documentId: string) => documentId === 'doc_1'
        ? late.promise
        : Promise.resolve({ kind: 'original', mimeType: 'text/plain', bytes: currentBytes })),
    })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: client })
    const store = useKnowledgeStore()

    const initial = store.bindOwner('alice')
    await vi.waitFor(() => expect(client.knowledge.getDocumentPreview).toHaveBeenCalledWith('doc_1'))
    await store.selectDocument('doc_2')
    late.resolve({ kind: 'original', mimeType: 'text/plain', bytes: lateBytes })
    await initial

    expect(store.selectedDocumentId).toBe('doc_2')
    expect(store.documentPreview).toMatchObject({ kind: 'original' })
    expect(Array.from(lateBytes)).toEqual(Array(lateBytes.length).fill(0))
    store.resetLocalData()
    expect(Array.from(currentBytes)).toEqual(Array(currentBytes.length).fill(0))
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
