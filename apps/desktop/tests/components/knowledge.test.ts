import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus from 'element-plus'
import { ElMessageBox } from 'element-plus'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import type {
  DesktopAPI,
  KnowledgeBase,
  KnowledgeConsentState,
  KnowledgeDocument,
  KnowledgeEntitlementState,
  KnowledgeFeatureAvailability,
  KnowledgeSelection,
} from '@autoforge/shared'
import App from '../../src/App.vue'
import ChatComposer from '../../src/components/chat/ChatComposer.vue'
import { routes } from '../../src/router'
import { useChatStore } from '../../src/stores/chat'
import { useKnowledgeStore } from '../../src/stores/knowledge'

const at = '2026-08-26T00:00:00.000Z'
const localBase: KnowledgeBase = {
  id: 'kb_local', name: '我的知识库', kind: 'local', status: 'ready', searchable: true,
  documentCount: 1, updatedAt: at,
}
const readyDocument: KnowledgeDocument = {
  id: 'document_1', knowledgeBaseId: localBase.id, name: '政策.md', mimeType: 'text/markdown',
  status: 'ready', versionCount: 1, updatedAt: at,
}
const available: KnowledgeFeatureAvailability = {
  local: { available: true, reasons: [] },
  cloud: { available: false, reasons: ['kill_switch_enabled'] },
}
const free: KnowledgeEntitlementState = {
  tier: 'free', status: 'active', betaEnabled: true, cloudEnabled: false,
}
const emptySelection: KnowledgeSelection = { knowledgeBaseIds: [], knowledgeMode: 'mixed' }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createApi(input: {
  bases?: KnowledgeBase[]
  documents?: KnowledgeDocument[]
  featureAvailability?: KnowledgeFeatureAvailability
  entitlement?: KnowledgeEntitlementState
  selection?: KnowledgeSelection
  consent?: KnowledgeConsentState
} = {}): DesktopAPI {
  const bases = input.bases ?? [localBase]
  const documents = input.documents ?? [readyDocument]
  return {
    auth: { getSession: vi.fn().mockResolvedValue(null) },
    profile: { get: vi.fn().mockResolvedValue({ userId: 'user_1', account: 'Alice' }) },
    userAdmin: {},
    chat: {
      listConversations: vi.fn().mockResolvedValue([]),
      listMessages: vi.fn().mockResolvedValue([]),
      createConversation: vi.fn(), renameConversation: vi.fn(), deleteConversation: vi.fn(),
      send: vi.fn(), cancel: vi.fn(), onEvent: vi.fn(() => vi.fn()),
      getGenerationPreferences: vi.fn().mockResolvedValue({
        outputType: 'auto', models: {}, generation: {
          image: { count: 1, resolution: '1K', aspectRatio: 'auto', format: 'png' },
          audio: { format: 'mp3' },
          video: { durationSeconds: 5, resolution: '720p', aspectRatio: 'auto', generateAudio: false },
        },
      }),
      updateGenerationPreferences: vi.fn(),
    },
    media: {}, workflows: { list: vi.fn().mockResolvedValue([]) }, developer: {},
    executions: { list: vi.fn().mockResolvedValue([]), onEvent: vi.fn(() => vi.fn()) },
    permissions: { listGrants: vi.fn().mockResolvedValue([]) }, settings: {},
    knowledge: {
      listBases: vi.fn().mockResolvedValue(bases),
      createBase: vi.fn().mockImplementation(async (name: string) => ({
        ...localBase, id: 'kb_created', name, documentCount: 0,
      })),
      listDocuments: vi.fn().mockResolvedValue(documents),
      listVersions: vi.fn().mockResolvedValue([
        { id: 'version_1', documentId: readyDocument.id, number: 1, status: 'ready', createdAt: at },
      ]),
      importDocument: vi.fn().mockResolvedValue(undefined),
      replaceDocument: vi.fn().mockResolvedValue(undefined),
      recycleDocument: vi.fn().mockResolvedValue(undefined), purgeDocument: vi.fn().mockResolvedValue(undefined),
      recycleBase: vi.fn().mockResolvedValue(undefined), purgeBase: vi.fn().mockResolvedValue(undefined),
      exportBase: vi.fn().mockResolvedValue(undefined),
      getConversationSelection: vi.fn().mockResolvedValue(input.selection ?? emptySelection),
      updateConversationSelection: vi.fn().mockImplementation(async (_id, selection) => selection),
      search: vi.fn(),
      getFeatureAvailability: vi.fn().mockResolvedValue(input.featureAvailability ?? available),
      getEntitlement: vi.fn().mockResolvedValue(input.entitlement ?? free),
      getConsent: vi.fn().mockResolvedValue(input.consent ?? {
        chatProvider: { provider: 'openrouter', status: 'denied' },
        embedding: {
          processor: 'tokenhub', processingRegion: 'Guangzhou',
          model: 'kinfra-text-embedding-0.6b', dimensions: 1024,
          status: 'revoked', retrievalByBase: [],
        },
      }),
      setEmbeddingConsent: vi.fn().mockImplementation(async (status) => ({
        chatProvider: { provider: 'openrouter', status: 'denied' },
        embedding: {
          processor: 'tokenhub', processingRegion: 'Guangzhou',
          model: 'kinfra-text-embedding-0.6b', dimensions: 1024,
          status,
          retrievalByBase: [],
        },
      })),
      chooseDowngradeSelection: vi.fn().mockImplementation(async () => ({
        ...(input.entitlement ?? free),
        lifecycle: input.entitlement?.lifecycle
          ? { ...input.entitlement.lifecycle, requiresSelection: false }
          : undefined,
      })),
    },
    system: { getAppInfo: vi.fn().mockResolvedValue({ version: '0.1.0', platform: 'darwin' }) },
  } as unknown as DesktopAPI
}

const wrappers: VueWrapper[] = []
function installApi(api: DesktopAPI) {
  Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
}

async function mountKnowledge(api = createApi()) {
  installApi(api)
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/knowledge')
  await router.isReady()
  const wrapper = mount(App, { global: { plugins: [pinia, router, ElementPlus] } })
  wrappers.push(wrapper)
  await flushPromises()
  return { api, pinia, router, wrapper }
}

function textModel() {
  return {
    id: 'model_1', name: 'Model', inputModalities: ['text'] as const,
    outputModalities: ['text'] as const, supportsTools: true, generation: {},
  }
}

async function mountComposer(api: DesktopAPI, conversationId = 'conversation_1') {
  installApi(api)
  const pinia = createPinia()
  setActivePinia(pinia)
  const chat = useChatStore(pinia)
  chat.selectedConversationId = conversationId
  const wrapper = mount(ChatComposer, {
    props: { disabled: false, running: false, models: [textModel()], defaultModel: 'model_1' },
    global: { plugins: [pinia, ElementPlus] },
  })
  wrappers.push(wrapper)
  await flushPromises()
  return { chat, pinia, wrapper }
}

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
})
afterEach(() => {
  vi.useRealTimers()
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  Reflect.deleteProperty(window, 'autoForge')
})

describe('knowledge Store boundary', () => {
  it('clears every owner-scoped field and rejects stale catalog, document, version, and import responses', async () => {
    const api = createApi()
    const catalog = deferred<KnowledgeBase[]>()
    const documents = deferred<KnowledgeDocument[]>()
    const versions = deferred<Awaited<ReturnType<DesktopAPI['knowledge']['listVersions']>>>()
    const acknowledgement = deferred<KnowledgeDocument | undefined>()
    vi.mocked(api.knowledge.listBases).mockReturnValue(catalog.promise)
    vi.mocked(api.knowledge.listDocuments).mockReturnValue(documents.promise)
    vi.mocked(api.knowledge.listVersions).mockReturnValue(versions.promise)
    vi.mocked(api.knowledge.importDocument).mockReturnValue(acknowledgement.promise)
    installApi(api)
    const knowledge = useKnowledgeStore()
    knowledge.bases = [localBase]
    knowledge.selectedBaseId = localBase.id
    knowledge.selectedDocumentId = readyDocument.id
    knowledge.documentsByBase = { [localBase.id]: [readyDocument] }
    knowledge.versionsByDocument = { [readyDocument.id]: [] }
    knowledge.availability = available
    knowledge.entitlement = free
    knowledge.consent = {
      chatProvider: { provider: 'openrouter', status: 'denied' },
      embedding: {
        processor: 'tokenhub', processingRegion: 'Guangzhou',
        model: 'kinfra-text-embedding-0.6b', dimensions: 1024,
        status: 'revoked', retrievalByBase: [],
      },
    }

    const loadingCatalog = knowledge.refreshCatalog()
    const loadingDocuments = knowledge.loadDocuments(localBase.id)
    const loadingVersions = knowledge.loadVersions(readyDocument.id)
    const importing = knowledge.importDocument()
    knowledge.reset()
    catalog.resolve([{ ...localBase, id: 'old_owner_base' }])
    documents.resolve([{ ...readyDocument, id: 'old_owner_document' }])
    versions.resolve([{ id: 'old_owner_version', documentId: readyDocument.id, number: 1, status: 'ready', createdAt: at }])
    acknowledgement.resolve({ ...readyDocument, id: 'old_owner_ack' })
    await Promise.all([loadingCatalog, loadingDocuments, loadingVersions, importing])

    expect(knowledge.$state).toMatchObject({
      bases: [], documentsByBase: {}, versionsByDocument: {},
      selectedBaseId: '', selectedDocumentId: '',
      availability: undefined, entitlement: undefined, consent: undefined,
      loading: false, documentsLoading: false, versionsLoading: false,
      operationPending: false, error: '', operationError: '',
    })
  })

  it('fails closed before listing private bases when local storage is unavailable', async () => {
    const api = createApi({
      featureAvailability: {
        local: { available: false, reasons: ['safe_storage_unavailable'] },
        cloud: { available: false, reasons: ['safe_storage_unavailable'] },
      },
    })
    installApi(api)
    const knowledge = useKnowledgeStore()

    await knowledge.load()

    expect(api.knowledge.listBases).not.toHaveBeenCalled()
    expect(knowledge.bases).toEqual([])
    expect(knowledge.error).toContain('当前设备无法安全启用知识库')
  })

  it('keeps a durable parsing acknowledgement visible and refreshes it to ready', async () => {
    vi.useFakeTimers()
    const parsing = { ...readyDocument, status: 'parsing' as const }
    const api = createApi({ documents: [] })
    vi.mocked(api.knowledge.importDocument).mockResolvedValue(parsing)
    vi.mocked(api.knowledge.listDocuments)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...readyDocument, versionCount: 1 }])
    const { wrapper } = await mountKnowledge(api)

    await wrapper.get('[data-testid="knowledge-import"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="knowledge-document-document_1"]').text()).toContain('解析中')
    expect(wrapper.get('[data-testid="knowledge-document-document_1"]').text()).not.toContain('已就绪')

    await vi.advanceTimersByTimeAsync(1_500)
    await flushPromises()
    expect(wrapper.get('[data-testid="knowledge-document-document_1"]').text()).toContain('已就绪')
    expect(api.knowledge.listDocuments).toHaveBeenCalledTimes(2)
  })

  it('refreshes every processing base without one response invalidating another', async () => {
    const secondBase = { ...localBase, id: 'kb_second', name: '第二知识库' }
    const firstParsing = { ...readyDocument, status: 'parsing' as const }
    const secondParsing = {
      ...readyDocument, id: 'document_2', knowledgeBaseId: secondBase.id, name: '第二份.md', status: 'indexing' as const,
    }
    const api = createApi({ bases: [localBase, secondBase] })
    vi.mocked(api.knowledge.listDocuments).mockImplementation(async (baseId) => baseId === localBase.id
      ? [{ ...firstParsing, status: 'ready' }]
      : [{ ...secondParsing, status: 'ready' }])
    installApi(api)
    const knowledge = useKnowledgeStore()
    knowledge.bases = [localBase, secondBase]
    knowledge.documentsByBase = {
      [localBase.id]: [firstParsing],
      [secondBase.id]: [secondParsing],
    }

    await knowledge.refreshProcessing()

    expect(knowledge.documentsByBase[localBase.id]?.[0]?.status).toBe('ready')
    expect(knowledge.documentsByBase[secondBase.id]?.[0]?.status).toBe('ready')
  })

  it('polls processing state single-flight and stops after bounded exponential-backoff failures', async () => {
    vi.useFakeTimers()
    const api = createApi()
    vi.mocked(api.knowledge.listDocuments).mockRejectedValue(new Error('offline'))
    installApi(api)
    const knowledge = useKnowledgeStore()
    knowledge.bases = [localBase]
    knowledge.selectedBaseId = localBase.id
    knowledge.documentsByBase = {
      [localBase.id]: [{ ...readyDocument, status: 'parsing' }],
    }

    knowledge.startProcessingPolling()
    await vi.advanceTimersByTimeAsync(20_000)

    expect(api.knowledge.listDocuments).toHaveBeenCalledTimes(3)
    expect(knowledge.pollingError).toContain('自动刷新已暂停')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(api.knowledge.listDocuments).toHaveBeenCalledTimes(3)
  })

  it('does not overlap a slow processing refresh and cancels it on owner reset', async () => {
    vi.useFakeTimers()
    const api = createApi()
    const documents = deferred<KnowledgeDocument[]>()
    vi.mocked(api.knowledge.listDocuments).mockReturnValue(documents.promise)
    installApi(api)
    const knowledge = useKnowledgeStore()
    knowledge.bases = [localBase]
    knowledge.selectedBaseId = localBase.id
    knowledge.documentsByBase = {
      [localBase.id]: [{ ...readyDocument, status: 'parsing' }],
    }

    knowledge.startProcessingPolling()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(api.knowledge.listDocuments).toHaveBeenCalledOnce()

    knowledge.reset()
    documents.resolve([{ ...readyDocument, status: 'ready' }])
    await flushPromises()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(api.knowledge.listDocuments).toHaveBeenCalledOnce()
    expect(knowledge.documentsByBase).toEqual({})
  })

  it('invalidates in-flight catalog, document, and version publications when polling stops', async () => {
    const api = createApi()
    const catalog = deferred<KnowledgeBase[]>()
    const documents = deferred<KnowledgeDocument[]>()
    const versions = deferred<Awaited<ReturnType<DesktopAPI['knowledge']['listVersions']>>>()
    vi.mocked(api.knowledge.listBases).mockReturnValue(catalog.promise)
    vi.mocked(api.knowledge.listDocuments).mockReturnValue(documents.promise)
    vi.mocked(api.knowledge.listVersions).mockReturnValue(versions.promise)
    installApi(api)
    const knowledge = useKnowledgeStore()
    knowledge.bases = [localBase]
    knowledge.selectedBaseId = localBase.id
    knowledge.selectedDocumentId = readyDocument.id

    const loadingCatalog = knowledge.refreshCatalog()
    const loadingDocuments = knowledge.loadDocuments(localBase.id)
    const loadingVersions = knowledge.loadVersions(readyDocument.id)
    knowledge.stopProcessingPolling()
    catalog.resolve([{ ...localBase, id: 'stopped_catalog' }])
    documents.resolve([{ ...readyDocument, id: 'stopped_document' }])
    versions.resolve([{ id: 'stopped_version', documentId: readyDocument.id, number: 1, status: 'ready', createdAt: at }])
    await Promise.all([loadingCatalog, loadingDocuments, loadingVersions])

    expect(knowledge.bases).toEqual([localBase])
    expect(knowledge.documentsByBase).toEqual({})
    expect(knowledge.versionsByDocument).toEqual({})
    expect(knowledge.documentsLoading).toBe(false)
    expect(knowledge.versionsLoading).toBe(false)
  })

  it('does not restart polling or publish a stale workspace refresh after route unmount', async () => {
    vi.useFakeTimers()
    const staleDocuments = deferred<KnowledgeDocument[]>()
    const staleBase = { ...localBase, id: 'kb_workspace' }
    const chatBase = { ...localBase, id: 'kb_chat', name: '会话目录' }
    const api = createApi({ bases: [staleBase], documents: [] })
    vi.mocked(api.knowledge.listBases)
      .mockResolvedValueOnce([staleBase])
      .mockResolvedValueOnce([chatBase])
      .mockResolvedValue([staleBase])
    vi.mocked(api.knowledge.listDocuments)
      .mockReturnValueOnce(staleDocuments.promise)
      .mockResolvedValue([{ ...readyDocument, knowledgeBaseId: staleBase.id, status: 'ready' }])
    const mounted = await mountKnowledge(api)
    const chat = useChatStore(mounted.pinia)
    chat.selectedConversationId = 'conversation_1'

    await mounted.router.push('/chat')
    await flushPromises()
    expect(useKnowledgeStore(mounted.pinia).bases).toEqual([chatBase])

    staleDocuments.resolve([{ ...readyDocument, knowledgeBaseId: staleBase.id, status: 'parsing' }])
    await flushPromises()
    await vi.advanceTimersByTimeAsync(10_000)

    const knowledge = useKnowledgeStore(mounted.pinia)
    expect(api.knowledge.listDocuments).toHaveBeenCalledTimes(1)
    expect(knowledge.bases).toEqual([chatBase])
    expect(knowledge.documentsByBase[staleBase.id]).toBeUndefined()
  })

  it('clears a paused polling error on reload and when no processing remains', async () => {
    const api = createApi({ documents: [] })
    installApi(api)
    const knowledge = useKnowledgeStore()
    knowledge.pollingError = '处理状态自动刷新已暂停'

    await knowledge.load()
    expect(knowledge.pollingError).toBe('')

    knowledge.pollingError = '处理状态自动刷新已暂停'
    knowledge.startProcessingPolling()
    expect(knowledge.pollingError).toBe('')
  })

  it('keeps the current base loading state and error isolated from an older base request', async () => {
    const secondBase = { ...localBase, id: 'kb_second', name: '第二知识库' }
    const first = deferred<KnowledgeDocument[]>()
    const second = deferred<KnowledgeDocument[]>()
    const api = createApi({ bases: [localBase, secondBase] })
    vi.mocked(api.knowledge.listDocuments).mockImplementation((baseId) => (
      baseId === localBase.id ? first.promise : second.promise
    ))
    installApi(api)
    const knowledge = useKnowledgeStore()
    knowledge.bases = [localBase, secondBase]
    knowledge.selectedBaseId = localBase.id
    const firstLoad = knowledge.loadDocuments(localBase.id)
    knowledge.selectedBaseId = secondBase.id
    const secondLoad = knowledge.loadDocuments(secondBase.id)

    first.reject(new Error('old base failed'))
    await firstLoad

    expect(knowledge.documentsLoading).toBe(true)
    expect(knowledge.operationError).toBe('')
    second.resolve([])
    await secondLoad
    expect(knowledge.documentsLoading).toBe(false)
  })

  it('keeps replacement errors actionable without replacing the ready document locally', async () => {
    const api = createApi()
    vi.mocked(api.knowledge.replaceDocument).mockRejectedValue(new Error('parser details'))
    const { wrapper } = await mountKnowledge(api)

    await wrapper.get('[data-testid="knowledge-document-document_1"]').trigger('click')
    await wrapper.get('[data-testid="knowledge-replace"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('替换文件失败')
    expect(wrapper.text()).toContain('政策.md')
    expect(wrapper.text()).toContain('已就绪')
  })

  it('disables cloud writes when only local knowledge is available', async () => {
    const cloudBase = { ...localBase, id: 'kb_cloud', name: '云端知识库', kind: 'cloud' as const }
    const api = createApi({
      bases: [cloudBase],
      documents: [{ ...readyDocument, knowledgeBaseId: cloudBase.id }],
    })
    const { wrapper } = await mountKnowledge(api)

    expect(wrapper.get('[data-testid="knowledge-import"]').attributes('disabled')).toBeDefined()
    expect(api.knowledge.importDocument).not.toHaveBeenCalled()
  })

  it('disables local create/import/replace after entitlement expiry while retaining export and recycle', async () => {
    const api = createApi({
      entitlement: { tier: 'member', status: 'expired', betaEnabled: true, cloudEnabled: false },
    })
    const { wrapper } = await mountKnowledge(api)
    await wrapper.get('[data-testid="knowledge-document-document_1"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="knowledge-create"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="knowledge-import"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="knowledge-replace"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="knowledge-export"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[data-testid="knowledge-recycle-document"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[data-testid="inspector-panel"]').text()).toContain('不可检索（会员已过期）')
  })

  it('offers an explicit retained-file choice during downgrade and keeps export/delete visible', async () => {
    const api = createApi({
      entitlement: {
        tier: 'free', status: 'expired', betaEnabled: false, cloudEnabled: false,
        knowledgeToolEnabled: false, killSwitchEnabled: false,
        membershipExpiresAt: '2026-08-26T00:00:00.000Z',
        lifecycle: {
          phase: 'download_window', requiresSelection: true,
          downloadUntil: '2026-09-25T00:00:00.000Z',
          recycleUntil: '2026-10-25T00:00:00.000Z',
        },
      },
    })
    const { wrapper } = await mountKnowledge(api)
    await wrapper.get('[data-testid="knowledge-document-document_1"]').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('请选择一个本地文件继续使用')
    await wrapper.get('[data-testid="knowledge-keep-document"]').trigger('click')
    await flushPromises()

    expect(api.knowledge.chooseDowngradeSelection).toHaveBeenCalledWith('kb_local', 'document_1')
    expect(wrapper.get('[data-testid="knowledge-export"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[data-testid="knowledge-recycle-document"]').attributes('disabled')).toBeUndefined()
  })

  it('refreshes durable downgrade selection state after Main reconciles the restarted catalog', async () => {
    const requiresSelection: KnowledgeEntitlementState = {
      tier: 'free', status: 'expired', betaEnabled: false, cloudEnabled: false,
      knowledgeToolEnabled: false, killSwitchEnabled: false,
      membershipExpiresAt: '2026-08-26T00:00:00.000Z',
      lifecycle: {
        phase: 'download_window', requiresSelection: true,
        downloadUntil: '2026-09-25T00:00:00.000Z', recycleUntil: '2026-10-25T00:00:00.000Z',
      },
    }
    const api = createApi({ entitlement: requiresSelection })
    vi.mocked(api.knowledge.getEntitlement)
      .mockResolvedValueOnce(requiresSelection)
      .mockResolvedValueOnce({
        ...requiresSelection,
        lifecycle: { ...requiresSelection.lifecycle!, requiresSelection: false },
      })

    const { wrapper } = await mountKnowledge(api)

    expect(api.knowledge.getEntitlement).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).not.toContain('请选择一个本地文件继续使用')
  })

  it('keeps cached cloud export and delete available when the signed kill switch disables cloud access', async () => {
    const cloudBase = { ...localBase, id: 'kb_cloud', name: '云端知识库', kind: 'cloud' as const }
    const api = createApi({
      bases: [cloudBase],
      documents: [{ ...readyDocument, knowledgeBaseId: cloudBase.id }],
      entitlement: {
        tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: false,
        knowledgeToolEnabled: false, killSwitchEnabled: true,
      },
    })
    const { wrapper } = await mountKnowledge(api)
    await wrapper.get('[data-testid="knowledge-document-document_1"]').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('云端功能和新的 Agent 知识工具已暂停')
    expect(wrapper.text()).toContain('本地管理、导出和删除仍可用')
    expect(wrapper.get('[data-testid="knowledge-import"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="knowledge-export"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[data-testid="knowledge-recycle-document"]').attributes('disabled')).toBeUndefined()
  })

  it.each([
    ['download_window', '云端下载/转换尚未开放，需完成预发布外部门禁；本地缓存仍可导出'],
    ['recycle_window', '云端内容处于回收期，可继续管理本地缓存'],
    ['purge_eligible', '云端内容已具备清理资格'],
  ] as const)('shows the signed %s membership lifecycle boundary', async (phase, message) => {
    const api = createApi({
      entitlement: {
        tier: 'free', status: 'expired', betaEnabled: false, cloudEnabled: false,
        knowledgeToolEnabled: false, killSwitchEnabled: false,
        membershipExpiresAt: '2026-08-26T00:00:00.000Z',
        lifecycle: {
          phase, requiresSelection: true,
          downloadUntil: '2026-09-25T00:00:00.000Z',
          recycleUntil: '2026-10-25T00:00:00.000Z',
        },
      },
    })
    const { wrapper } = await mountKnowledge(api)

    expect(wrapper.text()).toContain(message)
    if (phase === 'download_window') expect(wrapper.text()).not.toContain('云端内容可下载或转换至')
  })

  it('enforces the free one-library and one-active-file quota before invoking Main', async () => {
    const { api, wrapper } = await mountKnowledge(createApi({ entitlement: free }))

    await wrapper.get('[aria-label="新知识库名称"]').setValue('不应创建')
    expect(wrapper.get('[data-testid="knowledge-create"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="knowledge-import"]').attributes('disabled')).toBeDefined()

    await wrapper.get('[data-testid="knowledge-document-document_1"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="knowledge-replace"]').attributes('disabled')).toBeUndefined()
    expect(api.knowledge.createBase).not.toHaveBeenCalled()
    expect(api.knowledge.importDocument).not.toHaveBeenCalled()
  })
})

describe('knowledge three-pane workspace', () => {
  it('shares base, file, and immutable version selection across the real workbench panes', async () => {
    const { wrapper } = await mountKnowledge()

    expect(wrapper.get('[aria-label="知识库列表"]').text()).toContain('我的知识库')
    await wrapper.get('[data-testid="knowledge-document-document_1"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[aria-label="知识库文件"]').text()).toContain('政策.md')
    expect(wrapper.get('[data-testid="inspector-panel"]').text()).toContain('版本 1')
    expect(wrapper.get('[data-testid="inspector-panel"]').text()).toContain('处理位置：本机')
  })

  it('creates a named base through the path-free DesktopAPI contract', async () => {
    const api = createApi({
      entitlement: { tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: false },
    })
    const { wrapper } = await mountKnowledge(api)
    await wrapper.get('[aria-label="新知识库名称"]').setValue('项目资料')
    await wrapper.get('[data-testid="knowledge-create"]').trigger('click')
    await flushPromises()

    expect(api.knowledge.createBase).toHaveBeenCalledWith('项目资料')
    expect(wrapper.get('[aria-label="知识库列表"]').text()).toContain('项目资料')
  })

  it('requires explicit confirmation before recycling a document or library', async () => {
    const { api, wrapper } = await mountKnowledge()
    await wrapper.get('[data-testid="knowledge-document-document_1"]').trigger('click')
    vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce(new Error('cancelled'))

    await wrapper.get('[data-testid="knowledge-recycle-document"]').trigger('click')
    await flushPromises()
    expect(api.knowledge.recycleDocument).not.toHaveBeenCalled()

    vi.mocked(ElMessageBox.confirm).mockResolvedValueOnce('confirm')
    await wrapper.get('[data-testid="knowledge-recycle-document"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="knowledge-document-document_1"]').exists()).toBe(false)
  })

  it('exposes confirmed immediate purge actions for the selected document and base', async () => {
    const { api, wrapper } = await mountKnowledge()
    await wrapper.get('[data-testid="knowledge-document-document_1"]').trigger('click')
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm')

    await wrapper.get('[data-testid="knowledge-purge-document"]').trigger('click')
    await flushPromises()
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('无法恢复'), '永久删除文件', expect.any(Object))
    expect(api.knowledge.purgeDocument).toHaveBeenCalledWith('document_1')

    await wrapper.get('[data-testid="knowledge-purge-base"]').trigger('click')
    await flushPromises()
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('无法恢复'), '永久删除知识库', expect.any(Object))
    expect(api.knowledge.purgeBase).toHaveBeenCalledWith('kb_local')
  })

  it('exposes labeled listbox selection and non-blocking background refresh state', async () => {
    const { wrapper } = await mountKnowledge()

    expect(wrapper.get('[aria-label="知识库列表"]').attributes('role')).toBe('listbox')
    expect(wrapper.get('[data-testid="knowledge-base-kb_local"]').attributes('aria-selected')).toBe('true')
    expect(wrapper.get('[aria-label="知识库文件"]').attributes('aria-busy')).toBe('false')
    expect(wrapper.get('[data-testid="knowledge-document-document_1"]').attributes('role')).toBe('option')
    expect(wrapper.get('[data-testid="knowledge-document-document_1"]').attributes('aria-selected')).toBe('false')
  })

  it('describes local processing without calling it cloud sync and reflects ready-version retrieval', async () => {
    const processingBase = Object.assign(
      { ...localBase, status: 'processing' as const },
      { searchable: true },
    )
    const api = createApi({
      bases: [processingBase],
      documents: [{ ...readyDocument, status: 'parsing' }],
    })
    const { wrapper } = await mountKnowledge(api)
    await wrapper.get('[data-testid="knowledge-document-document_1"]').trigger('click')
    await flushPromises()

    const inspector = wrapper.get('[data-testid="inspector-panel"]')
    expect(inspector.text()).toContain('本地处理中，仅已发布版本可检索')
    expect(inspector.text()).not.toContain('同步中，仅已发布版本可用')
  })

  it('marks read-only retained data and failed files without a ready version as unsearchable', async () => {
    const readOnlyBase = Object.assign(
      { ...localBase, status: 'read_only' as const },
      { searchable: false },
    )
    const api = createApi({ bases: [readOnlyBase] })
    const mounted = await mountKnowledge(api)
    await mounted.wrapper.get('[data-testid="knowledge-document-document_1"]').trigger('click')
    await flushPromises()
    expect(mounted.wrapper.get('[data-testid="inspector-panel"]').text()).toContain('不可检索（只读保留）')

    const failedBase = Object.assign(
      { ...localBase, status: 'failed' as const },
      { searchable: false },
    )
    const failedApi = createApi({
      bases: [failedBase],
      documents: [{ ...readyDocument, status: 'failed' }],
    })
    vi.mocked(failedApi.knowledge.listVersions).mockResolvedValue([
      { id: 'version_failed', documentId: readyDocument.id, number: 1, status: 'failed', createdAt: at },
    ])
    const failed = await mountKnowledge(failedApi)
    await failed.wrapper.get('[data-testid="knowledge-document-document_1"]').trigger('click')
    await flushPromises()
    expect(failed.wrapper.get('[data-testid="inspector-panel"]').text()).toContain('不可检索（没有已就绪版本）')
  })

  it('keeps only the prior ready version retrievable when the latest processing attempt failed', async () => {
    const failedBase = Object.assign(
      { ...localBase, status: 'failed' as const },
      { searchable: true },
    )
    const api = createApi({
      bases: [failedBase],
      documents: [{ ...readyDocument, status: 'failed' }],
    })
    const { wrapper } = await mountKnowledge(api)
    await wrapper.get('[data-testid="knowledge-document-document_1"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="inspector-panel"]').text()).toContain('仅原有已就绪版本可检索')
  })

  it('shows TokenHub Guangzhou consent separately and keeps revoked cloud search keyword-only', async () => {
    const cloudBase = { ...localBase, id: 'kb_cloud', kind: 'cloud' as const }
    const api = createApi({
      bases: [cloudBase], documents: [{ ...readyDocument, knowledgeBaseId: cloudBase.id }],
      featureAvailability: {
        local: { available: true, reasons: [] }, cloud: { available: true, reasons: [] },
      },
      entitlement: { tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: true },
    })
    const { wrapper } = await mountKnowledge(api)
    await wrapper.get('[data-testid="knowledge-document-document_1"]').trigger('click')
    await flushPromises()

    const inspector = wrapper.get('[data-testid="inspector-panel"]').text()
    expect(inspector).toContain('关键词检索')
    expect(inspector).toContain('TokenHub（广州）')
    expect(inspector).toContain('已撤回')
    expect(inspector).not.toContain('OpenRouter（广州）')
  })

  it('offers the separate grant, deny, and revoke lifecycle without caller-controlled scope', async () => {
    const cloudBase = { ...localBase, id: 'kb_cloud', kind: 'cloud' as const }
    const api = createApi({
      bases: [cloudBase], documents: [{ ...readyDocument, knowledgeBaseId: cloudBase.id }],
      featureAvailability: {
        local: { available: true, reasons: [] }, cloud: { available: true, reasons: [] },
      },
      entitlement: { tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: true },
      consent: {
        chatProvider: { provider: 'openrouter', status: 'unknown' },
        embedding: {
          processor: 'tokenhub', processingRegion: 'Guangzhou',
          model: 'kinfra-text-embedding-0.6b', dimensions: 1024,
          status: 'unknown', retrievalByBase: [{
            knowledgeBaseId: cloudBase.id, retrievalMode: 'keyword_only',
          }],
        },
      },
    })
    vi.mocked(api.knowledge.setEmbeddingConsent)
      .mockResolvedValueOnce({
        chatProvider: { provider: 'openrouter', status: 'unknown' },
        embedding: {
          processor: 'tokenhub', processingRegion: 'Guangzhou',
          model: 'kinfra-text-embedding-0.6b', dimensions: 1024,
          status: 'denied', retrievalByBase: [{
            knowledgeBaseId: cloudBase.id, retrievalMode: 'keyword_only',
          }],
        },
      })
      .mockResolvedValueOnce({
        chatProvider: { provider: 'openrouter', status: 'unknown' },
        embedding: {
          processor: 'tokenhub', processingRegion: 'Guangzhou',
          model: 'kinfra-text-embedding-0.6b', dimensions: 1024,
          status: 'granted', retrievalByBase: [{
            knowledgeBaseId: cloudBase.id, retrievalMode: 'reindexing',
          }],
        },
      })
      .mockResolvedValueOnce({
        chatProvider: { provider: 'openrouter', status: 'unknown' },
        embedding: {
          processor: 'tokenhub', processingRegion: 'Guangzhou',
          model: 'kinfra-text-embedding-0.6b', dimensions: 1024,
          status: 'revoked', retrievalByBase: [{
            knowledgeBaseId: cloudBase.id, retrievalMode: 'keyword_only',
          }],
        },
      })
    const { wrapper } = await mountKnowledge(api)

    await wrapper.get('[data-testid="knowledge-embedding-deny"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="knowledge-embedding-grant"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="knowledge-embedding-revoke"]').trigger('click')
    await flushPromises()

    expect(api.knowledge.setEmbeddingConsent).toHaveBeenNthCalledWith(1, 'denied')
    expect(api.knowledge.setEmbeddingConsent).toHaveBeenNthCalledWith(2, 'granted')
    expect(api.knowledge.setEmbeddingConsent).toHaveBeenNthCalledWith(3, 'revoked')
  })

  it('marks a deleted document as deleted and non-retrievable even when a ready version remains', async () => {
    const api = createApi({
      bases: [localBase],
      documents: [{ ...readyDocument, status: 'deleted' }],
    })
    const { wrapper } = await mountKnowledge(api)
    await wrapper.get('[data-testid="knowledge-document-document_1"]').trigger('click')
    await flushPromises()

    const inspector = wrapper.get('[data-testid="inspector-panel"]')
    expect(inspector.text()).toContain('不可检索（文件已删除）')
    expect(inspector.text()).not.toContain('仅本地关键词检索')
  })
})

describe('conversation knowledge preferences', () => {
  it('renders retrieval mode per cloud base instead of borrowing another base index state', async () => {
    const hybrid = { ...localBase, id: 'kb_hybrid', name: '混合库', kind: 'cloud' as const }
    const keyword = { ...localBase, id: 'kb_keyword', name: '关键词库', kind: 'cloud' as const }
    const api = createApi({
      bases: [hybrid, keyword],
      featureAvailability: {
        local: { available: true, reasons: [] }, cloud: { available: true, reasons: [] },
      },
      entitlement: { tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: true },
      consent: {
        chatProvider: { provider: 'openrouter', status: 'unknown' },
        embedding: {
          processor: 'tokenhub', processingRegion: 'Guangzhou',
          model: 'kinfra-text-embedding-0.6b', dimensions: 1024,
          status: 'granted',
          retrievalByBase: [
            { knowledgeBaseId: hybrid.id, retrievalMode: 'hybrid' },
            { knowledgeBaseId: keyword.id, retrievalMode: 'keyword_only' },
          ],
        },
      },
    })
    const { wrapper } = await mountComposer(api)

    expect(wrapper.get('[data-testid="knowledge-base-kb_hybrid"]').text())
      .toContain('混合检索')
    expect(wrapper.get('[data-testid="knowledge-base-kb_keyword"]').text())
      .toContain('关键词检索')
    expect(wrapper.get('[data-testid="knowledge-base-kb_keyword"]').text())
      .not.toContain('混合检索')
  })

  it('loads and persists zero-or-more bases plus strict or mixed mode per conversation', async () => {
    const api = createApi({ selection: { knowledgeBaseIds: ['kb_local'], knowledgeMode: 'strict' } })
    const { chat, wrapper } = await mountComposer(api)

    expect(wrapper.get('[data-testid="knowledge-base-kb_local"]').attributes('aria-checked')).toBe('true')
    expect(wrapper.get('[data-testid="knowledge-mode-strict"]').attributes('aria-checked')).toBe('true')
    expect(wrapper.text()).toContain('仅本地')
    expect(wrapper.text()).toContain('关键词检索')

    await wrapper.get('[data-testid="knowledge-mode-mixed"]').trigger('click')
    await wrapper.get('[data-testid="knowledge-base-kb_local"]').trigger('click')
    await flushPromises()

    expect(api.knowledge.updateConversationSelection).toHaveBeenNthCalledWith(1, 'conversation_1', {
      knowledgeBaseIds: ['kb_local'], knowledgeMode: 'mixed',
    })
    expect(api.knowledge.updateConversationSelection).toHaveBeenNthCalledWith(2, 'conversation_1', emptySelection)
    expect(chat.knowledgeSelection).toEqual(emptySelection)
  })

  it('labels and disables scoped syncing, synced, read-only, expired, unavailable, and deleted choices', async () => {
    const bases: KnowledgeBase[] = [
      localBase,
      { ...localBase, id: 'kb_syncing', name: '同步资料', kind: 'cloud', status: 'processing' },
      { ...localBase, id: 'kb_synced', name: '云端资料', kind: 'cloud' },
      { ...localBase, id: 'kb_readonly', name: '归档资料', status: 'read_only' },
    ]
    const api = createApi({
      bases,
      featureAvailability: { local: { available: true, reasons: [] }, cloud: { available: true, reasons: [] } },
      entitlement: { tier: 'member', status: 'expired', betaEnabled: true, cloudEnabled: true },
      selection: { knowledgeBaseIds: ['kb_deleted'], knowledgeMode: 'mixed' },
    })
    const { wrapper } = await mountComposer(api)

    expect(wrapper.text()).toContain('同步中')
    expect(wrapper.text()).toContain('已同步')
    expect(wrapper.text()).toContain('只读')
    expect(wrapper.text()).toContain('会员已过期')
    expect(wrapper.text()).toContain('已删除或不可用')
    expect(wrapper.get('[data-testid="knowledge-base-kb_syncing"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="knowledge-base-kb_readonly"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="knowledge-base-kb_deleted"]').attributes('disabled')).toBeUndefined()
  })

  it.each(['expired', 'unavailable'] as const)(
    'labels local processing as local processing while entitlement is %s',
    async (status) => {
      const api = createApi({
        bases: [{ ...localBase, status: 'processing', searchable: true }],
        entitlement: { tier: 'member', status, betaEnabled: true, cloudEnabled: false },
      })
      const { wrapper } = await mountComposer(api)

      expect(wrapper.text()).toContain('本地处理中')
      expect(wrapper.text()).not.toContain('同步中')
    },
  )

  it('lets a checked stale disabled library be deselected', async () => {
    const staleBase = { ...localBase, status: 'read_only' as const, searchable: false }
    const api = createApi({
      bases: [staleBase],
      selection: { knowledgeBaseIds: [staleBase.id], knowledgeMode: 'strict' },
    })
    const { chat, wrapper } = await mountComposer(api)
    const choice = wrapper.get('[data-testid="knowledge-base-kb_local"]')

    expect(choice.attributes('aria-checked')).toBe('true')
    expect(choice.attributes('disabled')).toBeUndefined()
    await choice.trigger('click')
    await flushPromises()

    expect(api.knowledge.updateConversationSelection).toHaveBeenCalledWith('conversation_1', {
      knowledgeBaseIds: [], knowledgeMode: 'strict',
    })
    expect(chat.knowledgeSelection).toEqual({ knowledgeBaseIds: [], knowledgeMode: 'strict' })
  })

  it('keeps an optimistically checked library removable when catalog state becomes stale before save', async () => {
    const firstSave = deferred<KnowledgeSelection>()
    const api = createApi({ selection: emptySelection })
    vi.mocked(api.knowledge.updateConversationSelection)
      .mockReturnValueOnce(firstSave.promise)
      .mockImplementationOnce(async (_conversationId, selection) => selection)
    const { chat, pinia, wrapper } = await mountComposer(api)
    const choice = wrapper.get('[data-testid="knowledge-base-kb_local"]')

    await choice.trigger('click')
    const knowledge = useKnowledgeStore(pinia)
    knowledge.bases = [{ ...localBase, status: 'read_only', searchable: false }]
    await flushPromises()
    expect(choice.attributes('disabled')).toBeUndefined()

    await choice.trigger('click')
    firstSave.resolve({ knowledgeBaseIds: [localBase.id], knowledgeMode: 'mixed' })
    await flushPromises()

    expect(api.knowledge.updateConversationSelection).toHaveBeenNthCalledWith(2, 'conversation_1', emptySelection)
    expect(chat.knowledgeSelection).toEqual(emptySelection)
  })

  it('uses Main searchable state for processing and failed choices while keeping read-only retention unsearchable', async () => {
    const bases: KnowledgeBase[] = [
      Object.assign({ ...localBase, id: 'kb_processing', name: '本地处理中', status: 'processing' }, { searchable: true }),
      Object.assign({ ...localBase, id: 'kb_processing_empty', name: '首次处理中', status: 'processing' }, { searchable: false }),
      Object.assign({ ...localBase, id: 'kb_failed', name: '部分失败', status: 'failed' }, { searchable: true }),
      Object.assign({ ...localBase, id: 'kb_failed_empty', name: '首次失败', status: 'failed' }, { searchable: false }),
      Object.assign({ ...localBase, id: 'kb_paused', name: '同步暂停', kind: 'cloud', status: 'paused' }, { searchable: true }),
      Object.assign({ ...localBase, id: 'kb_readonly', name: '只读资料', status: 'read_only' }, { searchable: false }),
    ]
    const api = createApi({
      bases,
      featureAvailability: { local: { available: true, reasons: [] }, cloud: { available: true, reasons: [] } },
      entitlement: { tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: true },
    })
    const { wrapper } = await mountComposer(api)

    for (const id of ['kb_processing', 'kb_failed', 'kb_paused']) {
      expect(wrapper.get(`[data-testid="knowledge-base-${id}"]`).attributes('disabled')).toBeUndefined()
    }
    for (const id of ['kb_processing_empty', 'kb_failed_empty', 'kb_readonly']) {
      expect(wrapper.get(`[data-testid="knowledge-base-${id}"]`).attributes('disabled')).toBeDefined()
    }
    expect(wrapper.text()).toContain('已就绪版本可用')
    expect(wrapper.text()).toContain('只读 · 不可检索')
  })

  it('reloads authoritative Main selection after a failed save', async () => {
    const authoritative = { knowledgeBaseIds: ['kb_local'], knowledgeMode: 'strict' } as const
    const api = createApi({ selection: authoritative })
    vi.mocked(api.knowledge.updateConversationSelection).mockRejectedValue(new Error('write failed'))
    vi.mocked(api.knowledge.getConversationSelection).mockResolvedValue(authoritative)
    const { chat, wrapper } = await mountComposer(api)

    await wrapper.get('[data-testid="knowledge-mode-mixed"]').trigger('click')
    await flushPromises()

    expect(chat.knowledgeSelection).toEqual(authoritative)
    expect(chat.knowledgeSelectionError).toBe('知识库选择保存失败')
  })

  it('does not let an older failed save overwrite the latest successful preference or its cleared error', async () => {
    const firstSave = deferred<KnowledgeSelection>()
    const api = createApi({ selection: emptySelection })
    vi.mocked(api.knowledge.updateConversationSelection)
      .mockReturnValueOnce(firstSave.promise)
      .mockImplementationOnce(async (_conversationId, selection) => selection)
    const { chat, wrapper } = await mountComposer(api)

    await wrapper.get('[data-testid="knowledge-mode-strict"]').trigger('click')
    await wrapper.get('[data-testid="knowledge-mode-mixed"]').trigger('click')
    firstSave.reject(new Error('old failure'))
    await flushPromises()

    expect(chat.knowledgeSelection).toEqual(emptySelection)
    expect(chat.knowledgeSelectionError).toBe('')
  })

  it('falls back to the last Main-confirmed selection when queued saves and authoritative reload all fail', async () => {
    const confirmed = { knowledgeBaseIds: ['kb_local'], knowledgeMode: 'strict' } as const
    const api = createApi({ selection: confirmed })
    vi.mocked(api.knowledge.getConversationSelection)
      .mockResolvedValueOnce(confirmed)
      .mockRejectedValue(new Error('reload unavailable'))
    vi.mocked(api.knowledge.updateConversationSelection).mockRejectedValue(new Error('write failed'))
    const { chat, wrapper } = await mountComposer(api)

    await wrapper.get('[data-testid="knowledge-mode-mixed"]').trigger('click')
    await wrapper.get('[data-testid="knowledge-base-kb_local"]').trigger('click')
    await flushPromises()

    expect(chat.knowledgeSelection).toEqual(confirmed)
    expect(chat.knowledgeSelectionError).toBe('知识库选择保存失败')
  })

  it('reconciles a failed save for a conversation that is no longer selected without leaking its error', async () => {
    const failedSave = deferred<KnowledgeSelection>()
    const authoritative = { knowledgeBaseIds: ['kb_local'], knowledgeMode: 'strict' } as const
    const api = createApi({ selection: authoritative })
    vi.mocked(api.knowledge.updateConversationSelection).mockReturnValue(failedSave.promise)
    vi.mocked(api.knowledge.getConversationSelection).mockResolvedValue(authoritative)
    installApi(api)
    const chat = useChatStore()
    chat.selectedConversationId = 'conversation_1'
    chat.knowledgeSelectionsByConversation.conversation_1 = authoritative
    const saving = chat.updateKnowledgeSelection('conversation_1', {
      knowledgeBaseIds: ['kb_local'], knowledgeMode: 'mixed',
    })
    chat.selectedConversationId = 'conversation_2'

    failedSave.reject(new Error('write failed'))
    await saving

    expect(chat.knowledgeSelectionsByConversation.conversation_1).toEqual(authoritative)
    expect(chat.knowledgeSelectionError).toBe('')
  })

  it('does not serialize a new owner preference save behind the previous owner queue', async () => {
    const oldSave = deferred<KnowledgeSelection>()
    const api = createApi()
    vi.mocked(api.knowledge.updateConversationSelection)
      .mockReturnValueOnce(oldSave.promise)
      .mockImplementationOnce(async (_conversationId, selection) => selection)
    installApi(api)
    const chat = useChatStore()
    chat.selectedConversationId = 'same_conversation_id'
    const stale = chat.updateKnowledgeSelection('same_conversation_id', {
      knowledgeBaseIds: ['kb_local'], knowledgeMode: 'strict',
    })

    chat.resetLocalData()
    chat.selectedConversationId = 'same_conversation_id'
    const current = chat.updateKnowledgeSelection('same_conversation_id', emptySelection)
    await flushPromises()

    expect(api.knowledge.updateConversationSelection).toHaveBeenCalledTimes(2)
    oldSave.resolve({ knowledgeBaseIds: ['kb_local'], knowledgeMode: 'strict' })
    await Promise.all([stale, current])
    expect(chat.knowledgeSelection).toEqual(emptySelection)
  })

  it('initializes a new conversation with no inherited knowledge bases and mixed mode', async () => {
    const api = createApi()
    vi.mocked(api.chat.createConversation).mockResolvedValue({
      id: 'conversation_new', title: '新会话', createdAt: at, updatedAt: at,
    })
    installApi(api)
    const chat = useChatStore()
    chat.knowledgeSelectionsByConversation.conversation_old = {
      knowledgeBaseIds: ['kb_local'], knowledgeMode: 'strict',
    }

    await chat.createConversation()

    expect(chat.knowledgeSelectionsByConversation.conversation_new).toEqual(emptySelection)
    expect(chat.knowledgeSelection).toEqual(emptySelection)
  })
})
