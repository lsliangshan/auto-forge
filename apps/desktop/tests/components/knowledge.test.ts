import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus from 'element-plus'
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
