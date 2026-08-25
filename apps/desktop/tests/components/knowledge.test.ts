import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus from 'element-plus'
import { ElMessageBox } from 'element-plus'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import type {
  DesktopAPI,
  KnowledgeBase,
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
  id: 'kb_local', name: '我的知识库', kind: 'local', status: 'ready', documentCount: 1, updatedAt: at,
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
      getConsent: vi.fn().mockResolvedValue({ provider: 'openrouter', status: 'denied' }),
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
    knowledge.consent = { provider: 'openrouter', status: 'denied' }

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
    const { api, wrapper } = await mountKnowledge()
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

  it('exposes labeled listbox selection and non-blocking background refresh state', async () => {
    const { wrapper } = await mountKnowledge()

    expect(wrapper.get('[aria-label="知识库列表"]').attributes('role')).toBe('listbox')
    expect(wrapper.get('[data-testid="knowledge-base-kb_local"]').attributes('aria-selected')).toBe('true')
    expect(wrapper.get('[aria-label="知识库文件"]').attributes('aria-busy')).toBe('false')
  })
})

describe('conversation knowledge preferences', () => {
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
    expect(wrapper.get('[data-testid="knowledge-base-kb_deleted"]').attributes('disabled')).toBeDefined()
  })

  it('keeps syncing, paused, failed-ready-version, and read-only libraries selectable when their scope is usable', async () => {
    const bases: KnowledgeBase[] = [
      { ...localBase, id: 'kb_processing', name: '本地处理中', status: 'processing' },
      { ...localBase, id: 'kb_failed', name: '部分失败', status: 'failed' },
      { ...localBase, id: 'kb_paused', name: '同步暂停', kind: 'cloud', status: 'paused' },
      { ...localBase, id: 'kb_readonly', name: '只读资料', status: 'read_only' },
    ]
    const api = createApi({
      bases,
      featureAvailability: { local: { available: true, reasons: [] }, cloud: { available: true, reasons: [] } },
      entitlement: { tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: true },
    })
    const { wrapper } = await mountComposer(api)

    for (const id of ['kb_processing', 'kb_failed', 'kb_paused', 'kb_readonly']) {
      expect(wrapper.get(`[data-testid="knowledge-base-${id}"]`).attributes('disabled')).toBeUndefined()
    }
    expect(wrapper.text()).toContain('已就绪版本可用')
    expect(wrapper.text()).toContain('只读 · 可检索')
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
