import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import ElementPlus, { ElMessage, ElMessageBox } from 'element-plus'
import type { AppSettings, DesktopAPI, ModelInfo, TokenUsageSnapshot } from '@autoforge/shared'
import App from '../../src/App.vue'
import ExecutionCard from '../../src/components/chat/ExecutionCard.vue'
import { tokenColors } from '../../src/components/settings/token-usage-chart-options'
import { routes } from '../../src/router/index'
import { useExecutionStore } from '../../src/stores/execution'
import { useChatStore } from '../../src/stores/chat'
import { useSettingsStore } from '../../src/stores/settings'
import { useWorkflowStore } from '../../src/stores/workflow'

const mountedAppWrappers: VueWrapper[] = []

function modelInfo(id: string, outputs: ModelInfo['outputModalities'] = ['text']): ModelInfo {
  return {
    id,
    name: id,
    inputModalities: ['text'],
    outputModalities: outputs,
    supportsTools: outputs.includes('text'),
    generation: {
      ...(outputs.includes('image') ? {
        image: { resolutions: ['1K'], aspectRatios: ['auto'], formats: ['png'], maxCount: 1 },
      } : {}),
      ...(outputs.includes('audio') ? {
        audio: { voices: [], formats: ['mp3'] },
      } : {}),
      ...(outputs.includes('video') ? {
        video: { resolutions: ['720p'], aspectRatios: ['auto'], durations: [5], supportsAudio: false },
      } : {}),
    },
  }
}

function usagePeriod(
  startedAt: string,
  endedAt: string,
  totalTokens: number,
  model = 'alpha/model',
) {
  return {
    startedAt,
    endedAt,
    inputTokens: totalTokens,
    outputTokens: 0,
    totalTokens,
    models: totalTokens === 0
      ? []
      : [{ model, inputTokens: totalTokens, outputTokens: 0, totalTokens }],
    trend: totalTokens === 0
      ? []
      : [{ startedAt, inputTokens: totalTokens, outputTokens: 0, totalTokens }],
  }
}

function usageSnapshot(totalTokens: number, model = 'alpha/model'): TokenUsageSnapshot {
  const generatedAt = '2026-08-17T04:00:00.000Z'
  const todayStartedAt = '2026-08-16T16:00:00.000Z'
  return {
    generatedAt,
    today: usagePeriod(todayStartedAt, generatedAt, totalTokens, model),
    yesterday: usagePeriod('2026-08-15T16:00:00.000Z', todayStartedAt, totalTokens, model),
    week: usagePeriod(todayStartedAt, generatedAt, totalTokens, model),
    month: usagePeriod('2026-07-31T16:00:00.000Z', generatedAt, totalTokens, model),
    allTime: usagePeriod('2026-07-01T00:00:00.000Z', generatedAt, totalTokens, model),
  }
}

function computedColor(value: string) {
  const probe = document.createElement('span')
  probe.style.color = value
  document.body.append(probe)
  const color = getComputedStyle(probe).color
  probe.remove()
  return color
}

function createApi(overrides: Partial<DesktopAPI> = {}): DesktopAPI {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue(null), login: vi.fn(), register: vi.fn(),
      logout: vi.fn().mockResolvedValue(undefined),
    },
    chat: {
      listConversations: vi.fn().mockResolvedValue([]), createConversation: vi.fn(),
      listMessages: vi.fn().mockResolvedValue([]),
      renameConversation: vi.fn(), deleteConversation: vi.fn(), send: vi.fn(), cancel: vi.fn(),
      onEvent: vi.fn(() => vi.fn()),
    },
    workflows: {
      list: vi.fn().mockResolvedValue([]), get: vi.fn(), setEnabled: vi.fn(), remove: vi.fn(), installProject: vi.fn(),
    },
    developer: {
      listProjects: vi.fn().mockResolvedValue([]), createProject: vi.fn(), registerProject: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(),
      build: vi.fn(), validate: vi.fn(), run: vi.fn(),
    },
    executions: {
      list: vi.fn().mockResolvedValue([]), get: vi.fn(), decide: vi.fn(), cancel: vi.fn(),
      onEvent: vi.fn(() => vi.fn()),
    },
    permissions: { listGrants: vi.fn().mockResolvedValue([]), revoke: vi.fn() },
    settings: {
      get: vi.fn().mockResolvedValue({
        theme: 'system', language: 'zh-CN', dataDirectory: '/data', logDirectory: '/logs',
        activeProvider: 'deepseek', defaultModels: {
          openrouter: { text: 'openai/gpt-4.1-mini' }, deepseek: { text: 'deepseek-v4-flash' },
        }, showCosts: false, developerMode: false, permissionDefault: 'ask',
        proxy: { enabled: false, bypassDomains: [] },
      }),
      update: vi.fn(), saveProviderApiKey: vi.fn(), clearProviderApiKey: vi.fn(),
      validateProviderCredential: vi.fn().mockImplementation(async (provider) => ({
        provider, configured: false, validation: 'unchecked',
      })),
      listProviderModels: vi.fn().mockResolvedValue([]), clearLocalData: vi.fn(),
      getTokenUsage: vi.fn().mockResolvedValue(usageSnapshot(0)),
    },
    system: { openExternal: vi.fn(), getAppInfo: vi.fn().mockResolvedValue({ version: '0.1.0', platform: 'darwin' }) },
    ...overrides,
  }
}

async function apiWithEnabledProxy(): Promise<DesktopAPI> {
  const api = createApi()
  const settings = {
    ...await api.settings.get(),
    proxy: {
      enabled: true,
      httpProxy: 'http://127.0.0.1:7890',
      httpsProxy: 'https://proxy.example.com:8443',
      socketProxy: 'socks5://127.0.0.1:7891',
      bypassDomains: ['example.com'],
    },
  }
  vi.mocked(api.settings.get).mockResolvedValue(settings)
  vi.mocked(api.settings.update).mockImplementation(async (patch) => ({ ...settings, ...patch }))
  return api
}

async function mountApp(path = '/chat', api = createApi()) {
  Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
  const router = createRouter({ history: createMemoryHistory(), routes })
  const pinia = createPinia()
  setActivePinia(pinia)
  await router.push(path)
  await router.isReady()
  const wrapper = mount(App, {
    global: {
      plugins: [pinia, router, ElementPlus],
      stubs: {
        TokenUsageLineChart: { template: '<div data-testid="token-usage-line-chart" />' },
        TokenUsageBarChart: { template: '<div data-testid="token-usage-bar-chart" />' },
      },
    },
  })
  mountedAppWrappers.push(wrapper)
  await Promise.resolve()
  return { wrapper, router, api, pinia }
}

describe('workbench', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
  })
  afterEach(() => {
    for (const wrapper of mountedAppWrappers.splice(0)) {
      if (wrapper.exists()) wrapper.unmount()
    }
    Reflect.deleteProperty(window, 'autoForge')
  })

  it('renders exactly the five confirmed navigation items', async () => {
    const { wrapper } = await mountApp()
    expect(wrapper.findAll('[data-testid="app-nav-item"]').map((item) => item.text()))
      .toEqual(['聊天', '工作流', '开发', '执行记录', '设置'])
  })

  it('keeps the responsive inspector reachable through an accessible toggle', async () => {
    const { wrapper } = await mountApp('/chat')
    const toggle = wrapper.get('[data-testid="inspector-toggle"]')
    expect(toggle.attributes('aria-label')).toBe('打开检查器')
    await toggle.trigger('click')
    expect(wrapper.get('[data-testid="inspector-panel"]').attributes('data-open')).toBe('true')
    expect(toggle.attributes('aria-expanded')).toBe('true')
  })

  it('shows real workflow empty and error states without sample data', async () => {
    const workflows = {
      list: vi.fn().mockRejectedValue(new Error('offline')),
      get: vi.fn(), setEnabled: vi.fn(), remove: vi.fn(), installProject: vi.fn(),
    }
    const { wrapper } = await mountApp('/workflows', createApi({ workflows }))
    await vi.waitFor(() => expect(wrapper.text()).toContain('工作流加载失败'))
    expect(wrapper.text()).not.toContain('百度搜索')
  })

  it('renders the real developer empty state without inventing a project', async () => {
    const { wrapper, api } = await mountApp('/developer')
    await vi.waitFor(() => expect(api.developer.listProjects).toHaveBeenCalledOnce())
    expect(wrapper.text()).toContain('创建或导入本地工作流项目')
    expect(wrapper.find('[data-testid="monaco-editor"]').exists()).toBe(false)
  })

  it('enables and removes installed workflows through the real bridge contract', async () => {
    const api = createApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useWorkflowStore()
    const item = {
      id: 'search.real', version: '1.2.3', name: 'Real search', description: 'Search', author: 'Owner',
      category: 'search', enabled: false, source: 'installed' as const, integrity: 'valid' as const,
      updatedAt: '2026-07-19T00:00:00.000Z',
    }
    const newer = { ...item, version: '2.0.0', enabled: false }
    store.items = [item, newer]

    await store.setEnabled(item, true)
    expect(newer.enabled).toBe(false)
    await store.remove(item)

    expect(api.workflows.setEnabled).toHaveBeenCalledWith('search.real', '1.2.3', true)
    expect(api.workflows.remove).toHaveBeenCalledWith('search.real', '1.2.3')
    expect(store.items).toEqual([newer])
  })

  it('does not let an older workflow refresh overwrite a newer enable decision', async () => {
    const api = createApi()
    let resolveList!: (value: Awaited<ReturnType<DesktopAPI['workflows']['list']>>) => void
    vi.mocked(api.workflows.list).mockReturnValue(new Promise((resolve) => { resolveList = resolve }))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useWorkflowStore()
    const item = {
      id: 'workflow.race', version: '1.0.0', name: 'Race', description: '', author: 'Owner', category: 'test',
      enabled: false, source: 'installed' as const, integrity: 'valid' as const, updatedAt: '2026-07-19T00:00:00.000Z',
    }
    store.items = [item]
    const refresh = store.load()
    await vi.waitFor(() => expect(api.workflows.list).toHaveBeenCalled())
    await store.setEnabled(item, true)
    resolveList([{ ...item, enabled: false }])
    await refresh
    expect(store.items[0]?.enabled).toBe(true)
    expect(store.loading).toBe(false)
  })

  it('imports a first-time project through register, build, validate, then install', async () => {
    const api = createApi()
    const order: string[] = []
    const project = { id: 'project_1', name: 'First project', rootPath: '/project', status: 'new' as const, files: ['workflow.json'], updatedAt: '2026-07-19T00:00:00.000Z' }
    vi.mocked(api.developer.registerProject).mockImplementation(async () => { order.push('register'); return project })
    vi.mocked(api.developer.build).mockImplementation(async () => { order.push('build'); return { ...project, status: 'ready' } })
    vi.mocked(api.developer.validate).mockImplementation(async () => { order.push('validate'); return { valid: true, diagnostics: [] } })
    vi.mocked(api.workflows.installProject).mockImplementation(async () => { order.push('install'); return {} as never })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useWorkflowStore()
    await store.importProject()
    expect(order).toEqual(['register', 'build', 'validate', 'install'])
    expect(store.error).toBe('')
  })

  it('cancels the selected execution through the typed bridge', async () => {
    const api = createApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useExecutionStore()
    await store.cancel('exec_9')
    expect(api.executions.cancel).toHaveBeenCalledWith('exec_9')
  })

  it('attaches one execution event subscription across repeated detail selections', async () => {
    const api = createApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useExecutionStore()
    await store.select('exec_1')
    await store.select('exec_2')
    expect(api.executions.onEvent).toHaveBeenCalledTimes(1)
  })

  it('replays a live execution event over an older list response', async () => {
    const api = createApi()
    let listener!: Parameters<DesktopAPI['executions']['onEvent']>[0]
    let resolveList!: (value: Awaited<ReturnType<DesktopAPI['executions']['list']>>) => void
    vi.mocked(api.executions.onEvent).mockImplementation((value) => { listener = value; return vi.fn() })
    vi.mocked(api.executions.list).mockReturnValue(new Promise((resolve) => { resolveList = resolve }))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useExecutionStore()
    const loading = store.load()
    await vi.waitFor(() => expect(api.executions.list).toHaveBeenCalled())
    listener({ type: 'status', executionId: 'exec_live', status: 'completed', occurredAt: '2026-07-19T00:00:01.000Z' })
    resolveList([{ id: 'exec_live', workflowId: 'workflow.real', workflowVersion: '1.0.0', status: 'running', createdAt: '2026-07-19T00:00:00.000Z' }])
    await loading
    expect(store.items[0]?.status).toBe('completed')
  })

  it('loads concurrent execution-card details by id without changing inspector selection', async () => {
    const api = createApi()
    vi.mocked(api.executions.get).mockImplementation(async (id) => ({
      id, workflowId: `workflow.${id}`, workflowVersion: '1.0.0', status: id === 'exec_1' ? 'running' : 'completed',
      createdAt: '2026-07-19T00:00:00.000Z', input: {}, steps: [], logs: [],
    }))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useExecutionStore()
    await Promise.all([store.loadDetail('exec_1'), store.loadDetail('exec_2')])
    expect(store.selectedId).toBe('')
    expect(store.details.exec_1?.status).toBe('running')
    expect(store.details.exec_2?.status).toBe('completed')
  })

  it('keeps execution detail loading and errors isolated per card and never offers cancel for unknown state', async () => {
    const api = createApi()
    vi.mocked(api.executions.get).mockImplementation(async (id) => {
      if (id === 'exec_failed') throw new Error('detail offline')
      return {
        id, workflowId: 'workflow.real', workflowVersion: '1.0.0', status: 'running',
        createdAt: '2026-07-19T00:00:00.000Z', input: {}, steps: [], logs: [],
      }
    })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const pinia = createPinia()
    setActivePinia(pinia)
    const success = mount(ExecutionCard, { props: { executionId: 'exec_ok' }, global: { plugins: [pinia, ElementPlus] } })
    const failed = mount(ExecutionCard, { props: { executionId: 'exec_failed' }, global: { plugins: [pinia, ElementPlus] } })

    await vi.waitFor(() => expect(success.text()).toContain('执行中'))
    await vi.waitFor(() => expect(failed.text()).toContain('执行详情加载失败'))
    expect(success.text()).not.toContain('执行详情加载失败')
    expect(failed.text()).toContain('加载失败')
    expect(failed.text()).not.toContain('取消执行')
  })

  it('invalidates pending execution details and event history when local data resets', async () => {
    const api = createApi()
    let resolveDetail!: (value: Awaited<ReturnType<DesktopAPI['executions']['get']>>) => void
    vi.mocked(api.executions.get).mockReturnValue(new Promise((resolve) => { resolveDetail = resolve }))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useExecutionStore()
    const pending = store.loadDetail('exec_late')
    store.applyEvent({ type: 'status', executionId: 'exec_late', status: 'running', occurredAt: '2026-07-19T00:00:01.000Z' })
    store.resetLocalData()
    resolveDetail({
      id: 'exec_late', workflowId: 'workflow.real', workflowVersion: '1.0.0', status: 'completed',
      createdAt: '2026-07-19T00:00:00.000Z', input: {}, steps: [], logs: [],
    })
    await pending
    expect(store.details.exec_late).toBeUndefined()
    expect(store._eventHistory).toEqual([])
  })

  it('releases the last execution bridge lease on store disposal', () => {
    const api = createApi()
    const unsubscribe = vi.fn()
    vi.mocked(api.executions.onEvent).mockReturnValue(unsubscribe)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useExecutionStore()
    store.ensureSubscription()
    store.$dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('invalidates an older conversation list when a create mutation succeeds', async () => {
    const api = createApi()
    let resolveList!: (value: Awaited<ReturnType<DesktopAPI['chat']['listConversations']>>) => void
    vi.mocked(api.chat.listConversations).mockReturnValue(new Promise((resolve) => { resolveList = resolve }))
    vi.mocked(api.chat.createConversation).mockResolvedValue({ id: 'new', title: '新会话', createdAt: '2026-07-19T00:00:01.000Z', updatedAt: '2026-07-19T00:00:01.000Z' })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    const loading = store.loadConversations()
    await store.createConversation()
    resolveList([{ id: 'old', title: '旧快照', createdAt: '2026-07-19T00:00:00.000Z', updatedAt: '2026-07-19T00:00:00.000Z' }])
    await loading
    expect(store.conversations.map(({ id }) => id)).toEqual(['new'])
  })

  it('serializes settings patches so older full responses cannot roll back newer fields', async () => {
    const api = createApi()
    const first = {
      theme: 'dark' as const, language: 'zh-CN' as const, dataDirectory: '/data', logDirectory: '/logs',
      activeProvider: 'openrouter' as const,
      defaultModels: { openrouter: { text: 'old' }, deepseek: { text: 'deepseek-v4-flash' } },
      showCosts: false, developerMode: false, permissionDefault: 'ask' as const,
      proxy: { enabled: false, bypassDomains: [] },
    }
    const second = {
      ...first,
      defaultModels: { ...first.defaultModels, openrouter: { text: 'new' } },
    }
    vi.mocked(api.settings.update).mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useSettingsStore()
    await Promise.all([
      store.update({ theme: 'dark' }),
      store.update({
        defaultModels: { openrouter: { text: 'new' }, deepseek: { text: 'deepseek-v4-flash' } },
      }),
    ])
    expect(api.settings.update).toHaveBeenNthCalledWith(1, { theme: 'dark' })
    expect(api.settings.update).toHaveBeenNthCalledWith(2, {
      defaultModels: { openrouter: { text: 'new' }, deepseek: { text: 'deepseek-v4-flash' } },
    })
    expect(store.settings?.defaultModels.openrouter.text).toBe('new')
  })

  it('saves rapid default-model changes into separate nested output slots without losing other defaults', async () => {
    const api = createApi()
    let persisted = await api.settings.get()
    persisted = {
      ...persisted,
      activeProvider: 'openrouter',
      defaultModels: {
        deepseek: { text: 'deepseek-chat' },
        openrouter: { text: 'openai/gpt-4.1-mini', audio: 'audio/original' },
      },
    }
    vi.mocked(api.settings.update).mockImplementation(async (patch) => {
      persisted = { ...persisted, ...patch }
      return persisted
    })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useSettingsStore()
    store.settings = persisted

    await Promise.all([
      store.saveDefaultModel('image', 'google/gemini-2.5-flash-image'),
      store.saveDefaultModel('video', 'video/new'),
    ])

    expect(api.settings.update).toHaveBeenNthCalledWith(1, {
      defaultModels: {
        deepseek: { text: 'deepseek-chat' },
        openrouter: {
          text: 'openai/gpt-4.1-mini',
          image: 'google/gemini-2.5-flash-image',
          audio: 'audio/original',
        },
      },
    })
    expect(api.settings.update).toHaveBeenNthCalledWith(2, {
      defaultModels: {
        deepseek: { text: 'deepseek-chat' },
        openrouter: {
          text: 'openai/gpt-4.1-mini',
          image: 'google/gemini-2.5-flash-image',
          audio: 'audio/original',
          video: 'video/new',
        },
      },
    })
  })

  it('clears only optional OpenRouter slots and never clears required DeepSeek text', async () => {
    const api = createApi()
    let persisted = {
      ...await api.settings.get(),
      activeProvider: 'openrouter' as const,
      defaultModels: {
        deepseek: { text: 'deepseek-chat' },
        openrouter: { text: 'text/model', image: 'image/model', audio: 'audio/model' },
      },
    }
    vi.mocked(api.settings.update).mockImplementation(async (patch) => {
      persisted = { ...persisted, ...patch }
      return persisted
    })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useSettingsStore()
    store.settings = persisted

    await store.saveDefaultModel('image', undefined)
    expect(api.settings.update).toHaveBeenLastCalledWith({
      defaultModels: {
        deepseek: { text: 'deepseek-chat' },
        openrouter: { text: 'text/model', audio: 'audio/model' },
      },
    })

    store.settings = { ...persisted, activeProvider: 'deepseek' }
    await store.saveDefaultModel('text', undefined)
    expect(api.settings.update).toHaveBeenCalledTimes(1)
    expect(store.settings.defaultModels.deepseek.text).toBe('deepseek-chat')
  })

  it('binds a queued default-model save to the provider active when the user changed the slot', async () => {
    const api = createApi()
    let persisted = {
      ...await api.settings.get(),
      activeProvider: 'openrouter' as const,
      defaultModels: {
        deepseek: { text: 'deepseek-chat' },
        openrouter: { text: 'text/default' },
      },
    }
    vi.mocked(api.settings.update).mockImplementation(async (patch) => {
      persisted = { ...persisted, ...patch } as typeof persisted
      return persisted
    })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useSettingsStore()
    store.settings = persisted

    await Promise.all([
      store.update({ activeProvider: 'deepseek' }),
      store.saveDefaultModel('image', 'image/openrouter'),
    ])

    expect(api.settings.update).toHaveBeenNthCalledWith(2, {
      defaultModels: {
        deepseek: { text: 'deepseek-chat' },
        openrouter: { text: 'text/default', image: 'image/openrouter' },
      },
    })
  })

  it('filters default choices by usable output capability and keeps a saved missing model truthful', () => {
    Object.defineProperty(window, 'autoForge', { configurable: true, value: createApi() })
    const store = useSettingsStore()
    store.settings = {
      theme: 'system', language: 'zh-CN', dataDirectory: '/data', logDirectory: '/logs',
      activeProvider: 'openrouter',
      defaultModels: {
        deepseek: { text: 'deepseek-chat' },
        openrouter: { audio: 'audio/saved-missing' },
      },
      showCosts: false, developerMode: false, permissionDefault: 'ask',
      proxy: { enabled: false, bypassDomains: [] },
    }
    const imageWithoutGeneration = modelInfo('image/no-generation', ['image'])
    imageWithoutGeneration.generation = {}
    const imageWithoutTextInput = modelInfo('image/no-text-input', ['image'])
    imageWithoutTextInput.inputModalities = ['image']
    store.providerModels.openrouter = [
      modelInfo('text/model', ['text']),
      modelInfo('image/usable', ['image']),
      imageWithoutGeneration,
      imageWithoutTextInput,
      modelInfo('audio/usable', ['audio']),
    ]

    expect(store.modelOptionsFor('image').map(({ id }) => id)).toEqual(['image/usable'])
    expect(store.modelOptionsFor('audio')).toEqual([
      {
        id: 'audio/saved-missing',
        name: 'audio/saved-missing（已保存模型）',
        inputModalities: ['text'],
        outputModalities: ['audio'],
        supportsTools: false,
        generation: { audio: { voices: [], formats: [] } },
      },
      modelInfo('audio/usable', ['audio']),
    ])
  })

  it('does not synthesize a saved model whose catalog entry advertises a different output', () => {
    Object.defineProperty(window, 'autoForge', { configurable: true, value: createApi() })
    const store = useSettingsStore()
    store.settings = {
      theme: 'system', language: 'zh-CN', dataDirectory: '/data', logDirectory: '/logs',
      activeProvider: 'openrouter',
      defaultModels: {
        deepseek: { text: 'deepseek-chat' },
        openrouter: { image: 'catalog/incompatible' },
      },
      showCosts: false, developerMode: false, permissionDefault: 'ask',
      proxy: { enabled: false, bypassDomains: [] },
    }
    store.providerModels.openrouter = [modelInfo('catalog/incompatible', ['text'])]

    expect(store.modelOptionsFor('image')).toEqual([])
  })

  it('does not synthesize a saved media model whose catalog entry lacks generation metadata', () => {
    Object.defineProperty(window, 'autoForge', { configurable: true, value: createApi() })
    const store = useSettingsStore()
    store.settings = {
      theme: 'system', language: 'zh-CN', dataDirectory: '/data', logDirectory: '/logs',
      activeProvider: 'openrouter',
      defaultModels: {
        deepseek: { text: 'deepseek-chat' },
        openrouter: { audio: 'catalog/no-generation' },
      },
      showCosts: false, developerMode: false, permissionDefault: 'ask',
      proxy: { enabled: false, bypassDomains: [] },
    }
    const catalogModel = modelInfo('catalog/no-generation', ['audio'])
    catalogModel.generation = {}
    store.providerModels.openrouter = [catalogModel]

    expect(store.modelOptionsFor('audio')).toEqual([])
  })

  it('uses DeepSeek while persisted settings are not loaded', () => {
    Object.defineProperty(window, 'autoForge', { configurable: true, value: createApi() })
    const store = useSettingsStore()

    expect(store.activeProvider).toBe('deepseek')
  })

  it('switches provider state, credentials, and models without reusing the previous provider data', async () => {
    const api = createApi()
    const openrouterSettings = { ...await api.settings.get(), activeProvider: 'openrouter' as const }
    const deepseekSettings = { ...openrouterSettings, activeProvider: 'deepseek' as const }
    vi.mocked(api.settings.get).mockResolvedValue(openrouterSettings)
    vi.mocked(api.settings.update).mockResolvedValue(deepseekSettings)
    vi.mocked(api.settings.validateProviderCredential).mockImplementation(async (provider) => ({
      provider, configured: true, validation: 'valid',
    }))
    vi.mocked(api.settings.listProviderModels).mockImplementation(async (provider) => (
      provider === 'openrouter'
        ? [{ ...modelInfo('openrouter/model'), name: 'OpenRouter model' }]
        : [{ ...modelInfo('deepseek-v4-flash'), name: 'DeepSeek V4 Flash' }]
    ))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useSettingsStore()

    await store.load()
    expect(store.models.map(({ id }) => id)).toEqual(['openrouter/model'])
    await store.switchProvider('deepseek')

    expect(api.settings.update).toHaveBeenCalledWith({ activeProvider: 'deepseek' })
    expect(api.settings.validateProviderCredential).toHaveBeenLastCalledWith('deepseek')
    expect(api.settings.listProviderModels).toHaveBeenLastCalledWith('deepseek')
    expect(store.credential?.provider).toBe('deepseek')
    expect(store.models.map(({ id }) => id)).toEqual(['deepseek-v4-flash'])
  })

  it('keeps the saved provider default selectable when it is absent from the fetched catalog', () => {
    Object.defineProperty(window, 'autoForge', { configurable: true, value: createApi() })
    const store = useSettingsStore()
    store.settings = {
      theme: 'system', language: 'zh-CN', dataDirectory: '/data', logDirectory: '/logs',
      activeProvider: 'deepseek', defaultModels: {
        openrouter: { text: 'openrouter/model' }, deepseek: { text: 'deepseek-legacy' },
      }, showCosts: false, developerMode: false, permissionDefault: 'ask',
      proxy: { enabled: false, bypassDomains: [] },
    }
    store.providerModels.deepseek = [{
      ...modelInfo('deepseek-v4-flash'),
      name: 'DeepSeek V4 Flash',
    }]

    expect(store.modelOptionsFor('text')).toEqual([
      {
        id: 'deepseek-legacy',
        name: 'deepseek-legacy（已保存模型）',
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: false,
        generation: {},
      },
      { ...modelInfo('deepseek-v4-flash'), name: 'DeepSeek V4 Flash' },
    ])
  })

  it('renders only the provider-specific default-model slots and marks empty optional slots as unset', async () => {
    const deepseekApi = createApi()
    vi.mocked(deepseekApi.settings.validateProviderCredential).mockResolvedValue({
      provider: 'deepseek', configured: true, validation: 'valid',
    })
    vi.mocked(deepseekApi.settings.listProviderModels).mockResolvedValue([
      modelInfo('deepseek-chat', ['text']),
    ])
    const deepseek = await mountApp('/settings', deepseekApi)
    await vi.waitFor(() => expect(deepseek.wrapper.text()).toContain('默认文本模型'))
    expect(deepseek.wrapper.text()).not.toContain('默认图片模型')
    expect(deepseek.wrapper.findAll('[data-testid^="default-model-"]')).toHaveLength(1)
    const deepseekOptions = deepseek.wrapper.findAllComponents({ name: 'ElOption' })
      .filter((option) => option.vm.$attrs['data-output'] === 'text')
    expect(deepseekOptions.map((option) => option.props('label'))).toEqual([
      'deepseek-v4-flash（已保存模型）',
      'deepseek-chat',
    ])
    deepseek.wrapper.unmount()

    const openrouterApi = createApi()
    vi.mocked(openrouterApi.settings.get).mockResolvedValue({
      ...await openrouterApi.settings.get(),
      activeProvider: 'openrouter',
      defaultModels: {
        deepseek: { text: 'deepseek-chat' },
        openrouter: {
          text: 'text/default',
          audio: 'audio/saved-missing',
        },
      },
    })
    vi.mocked(openrouterApi.settings.validateProviderCredential).mockResolvedValue({
      provider: 'openrouter', configured: true, validation: 'valid',
    })
    vi.mocked(openrouterApi.settings.listProviderModels).mockResolvedValue([
      {
        ...modelInfo('text/default', ['text']),
        name: 'Text Default',
        inputCostPerMillion: 0.4,
        outputCostPerMillion: 1.6,
      },
      {
        ...modelInfo('image/usable', ['image']),
        inputCostPerMillion: 0,
        outputCostPerMillion: 0.0000001,
      },
      modelInfo('audio/usable', ['audio']),
      {
        ...modelInfo('video/usable', ['video']),
        inputCostPerMillion: 0.25,
      },
    ])
    const openrouter = await mountApp('/settings', openrouterApi)
    await vi.waitFor(() => expect(openrouter.wrapper.text()).toContain('默认视频模型'))
    expect(openrouter.wrapper.text()).toContain('默认文本模型')
    expect(openrouter.wrapper.text()).toContain('默认图片模型')
    expect(openrouter.wrapper.text()).toContain('默认音频模型')
    expect(openrouter.wrapper.findAll('[data-testid^="default-model-"]')).toHaveLength(4)
    expect(openrouter.wrapper.getComponent('[data-testid="default-model-image"]').props('placeholder'))
      .toBe('未设置')
    expect(openrouter.wrapper.getComponent('[data-testid="default-model-video"]').props('placeholder'))
      .toBe('未设置')
    expect(openrouter.wrapper.text()).toContain('audio/saved-missing（已保存模型）')
    const optionsFor = (output: string) => openrouter.wrapper.findAllComponents({ name: 'ElOption' })
      .filter((option) => option.vm.$attrs['data-output'] === output)
      .map((option) => option.props('label'))
    expect(optionsFor('text')).toEqual([
      'Text Default · 输入 $0.4/M · 输出 $1.6/M',
    ])
    expect(optionsFor('image')).toEqual([
      'image/usable · 输入 $0/M · 输出 $0.0000001/M',
    ])
    expect(optionsFor('audio')).toEqual([
      'audio/saved-missing（已保存模型） · 输入 — · 输出 —',
      'audio/usable · 输入 — · 输出 —',
    ])
    expect(optionsFor('video')).toEqual([
      'video/usable · 输入 $0.25/M · 输出 —',
    ])
    expect(
      openrouter.wrapper
        .get('[data-testid="default-model-text"] .el-select__placeholder')
        .text(),
    ).toBe('Text Default · 输入 $0.4/M · 输出 $1.6/M')
  })

  it('stops showing the previous provider model load after switching to an unconfigured provider', async () => {
    const api = createApi()
    let resolveOpenRouterModels!: (models: Awaited<ReturnType<DesktopAPI['settings']['listProviderModels']>>) => void
    vi.mocked(api.settings.listProviderModels).mockReturnValue(
      new Promise((resolve) => { resolveOpenRouterModels = resolve }),
    )
    vi.mocked(api.settings.update).mockResolvedValue({
      theme: 'system', language: 'zh-CN', dataDirectory: '/data', logDirectory: '/logs',
      activeProvider: 'deepseek', defaultModels: {
        openrouter: { text: 'openrouter/model' }, deepseek: { text: 'deepseek-v4-flash' },
      }, showCosts: false, developerMode: false, permissionDefault: 'ask',
      proxy: { enabled: false, bypassDomains: [] },
    })
    vi.mocked(api.settings.validateProviderCredential).mockResolvedValue({
      provider: 'deepseek', configured: false, validation: 'unchecked',
    })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useSettingsStore()
    store.settings = {
      theme: 'system', language: 'zh-CN', dataDirectory: '/data', logDirectory: '/logs',
      activeProvider: 'openrouter', defaultModels: {
        openrouter: { text: 'openrouter/model' }, deepseek: { text: 'deepseek-v4-flash' },
      }, showCosts: false, developerMode: false, permissionDefault: 'ask',
      proxy: { enabled: false, bypassDomains: [] },
    }

    const oldLoad = store.loadModels('openrouter')
    await vi.waitFor(() => expect(store.modelsLoading).toBe(true))
    await store.switchProvider('deepseek')

    expect(store.modelsLoading).toBe(false)
    resolveOpenRouterModels([])
    await oldLoad
    expect(store.modelsLoading).toBe(false)
  })

  it('does not restore cleared credentials or models from older provider responses', async () => {
    const api = createApi()
    let resolveValidation!: (status: Awaited<ReturnType<DesktopAPI['settings']['validateProviderCredential']>>) => void
    let resolveModels!: (models: Awaited<ReturnType<DesktopAPI['settings']['listProviderModels']>>) => void
    vi.mocked(api.settings.validateProviderCredential).mockReturnValue(
      new Promise((resolve) => { resolveValidation = resolve }),
    )
    vi.mocked(api.settings.listProviderModels).mockReturnValue(
      new Promise((resolve) => { resolveModels = resolve }),
    )
    vi.mocked(api.settings.clearProviderApiKey).mockResolvedValue(undefined)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useSettingsStore()
    store.settings = {
      theme: 'system', language: 'zh-CN', dataDirectory: '/data', logDirectory: '/logs',
      activeProvider: 'openrouter', defaultModels: {
        openrouter: { text: 'openrouter/model' }, deepseek: { text: 'deepseek-v4-flash' },
      }, showCosts: false, developerMode: false, permissionDefault: 'ask',
      proxy: { enabled: false, bypassDomains: [] },
    }
    store.credentials.openrouter = { provider: 'openrouter', configured: true, validation: 'valid' }

    const validation = store.validateCredential('openrouter')
    const models = store.loadModels('openrouter')
    await store.clearCredential()
    resolveValidation({ provider: 'openrouter', configured: true, validation: 'valid' })
    resolveModels([{ ...modelInfo('stale/model'), name: 'Stale model' }])
    await Promise.all([validation, models])

    expect(store.credentials.openrouter).toEqual({
      provider: 'openrouter', configured: false, validation: 'unchecked',
    })
    expect(store.providerModels.openrouter).toEqual([])
  })

  it('does not show an inactive provider failure after switching providers', async () => {
    const api = createApi()
    let rejectOpenRouterModels!: (error: Error) => void
    vi.mocked(api.settings.listProviderModels).mockReturnValue(
      new Promise((_, reject) => { rejectOpenRouterModels = reject }),
    )
    vi.mocked(api.settings.update).mockResolvedValue({
      theme: 'system', language: 'zh-CN', dataDirectory: '/data', logDirectory: '/logs',
      activeProvider: 'deepseek', defaultModels: {
        openrouter: { text: 'openrouter/model' }, deepseek: { text: 'deepseek-v4-flash' },
      }, showCosts: false, developerMode: false, permissionDefault: 'ask',
      proxy: { enabled: false, bypassDomains: [] },
    })
    vi.mocked(api.settings.validateProviderCredential).mockResolvedValue({
      provider: 'deepseek', configured: false, validation: 'unchecked',
    })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useSettingsStore()
    store.settings = {
      theme: 'system', language: 'zh-CN', dataDirectory: '/data', logDirectory: '/logs',
      activeProvider: 'openrouter', defaultModels: {
        openrouter: { text: 'openrouter/model' }, deepseek: { text: 'deepseek-v4-flash' },
      }, showCosts: false, developerMode: false, permissionDefault: 'ask',
      proxy: { enabled: false, bypassDomains: [] },
    }

    const oldLoad = store.loadModels('openrouter')
    await store.switchProvider('deepseek')
    rejectOpenRouterModels(new Error('old provider failed'))
    await oldLoad

    expect(store.activeProvider).toBe('deepseek')
    expect(store.error).toBe('')
  })

  it('resets visible stores after a successful all-data clear', async () => {
    const api = createApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const chat = useChatStore(); chat.conversations = [{ id: 'c', title: '会话', createdAt: '2026-07-19T00:00:00.000Z', updatedAt: '2026-07-19T00:00:00.000Z' }]
    const executions = useExecutionStore(); executions.items = [{ id: 'e', workflowId: 'w', workflowVersion: '1.0.0', status: 'completed', createdAt: '2026-07-19T00:00:00.000Z' }]
    const settings = useSettingsStore()
    await settings.clearLocalData('all')
    expect(chat.conversations).toEqual([])
    expect(executions.items).toEqual([])
    expect(api.settings.clearLocalData).toHaveBeenCalledWith('all')
    expect(api.workflows.list).toHaveBeenCalled()
    expect(api.settings.getTokenUsage).toHaveBeenCalledTimes(1)
  })

  it('keeps only the newest token usage response and isolates billing errors', async () => {
    const api = createApi()
    let resolveFirst!: (value: TokenUsageSnapshot) => void
    vi.mocked(api.settings.getTokenUsage)
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve }))
      .mockResolvedValueOnce(usageSnapshot(20, 'new/model'))
      .mockRejectedValueOnce(new Error('billing unavailable'))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useSettingsStore()

    const first = store.loadTokenUsage()
    await store.loadTokenUsage()
    resolveFirst(usageSnapshot(10, 'old/model'))
    await first
    expect(store.tokenUsage?.allTime.models[0]?.model).toBe('new/model')

    await store.loadTokenUsage()
    expect(store.tokenUsageError).toBe('Token 用量加载失败')
    expect(store.error).toBe('')
    expect(store.tokenUsage?.allTime.totalTokens).toBe(20)
  })

  it('refreshes token usage after clearing conversations but not executions', async () => {
    const api = createApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useSettingsStore()

    await store.clearLocalData('conversations')
    expect(api.settings.getTokenUsage).toHaveBeenCalledTimes(1)

    vi.mocked(api.settings.getTokenUsage).mockClear()
    await store.clearLocalData('executions')
    expect(api.settings.getTokenUsage).not.toHaveBeenCalled()
  })

  it('defaults to today and switches all token usage periods without refetching', async () => {
    const api = createApi()
    const usage = usageSnapshot(10, 'today/model')
    usage.yesterday = usagePeriod(
      '2026-08-15T16:00:00.000Z',
      '2026-08-16T16:00:00.000Z',
      20,
      'yesterday/model',
    )
    usage.week = usagePeriod(usage.week.startedAt, usage.week.endedAt, 30, 'week/model')
    usage.month = usagePeriod(usage.month.startedAt, usage.month.endedAt, 40, 'month/model')
    usage.allTime = usagePeriod(usage.allTime.startedAt, usage.allTime.endedAt, 50, 'all/model')
    vi.mocked(api.settings.getTokenUsage).mockResolvedValue(usage)

    const { wrapper } = await mountApp('/settings', api)
    await vi.waitFor(() => expect(wrapper.get('[data-testid="billing-summary-total"]').text()).toContain('10'))
    expect(wrapper.findAll('[data-testid="billing-tabs"] .el-tabs__item').map((tab) => tab.text()))
      .toEqual(['今日', '昨日', '本周', '本月', '累计'])
    expect(wrapper.get('#tab-today').attributes('aria-selected')).toBe('true')
    expect(wrapper.text()).toContain('today/model')
    document.body.append(wrapper.element)
    try {
      for (const [testId, markerColor] of [
        ['billing-summary-input', tokenColors.input],
        ['billing-summary-output', tokenColors.output],
        ['billing-summary-total', tokenColors.total],
      ] as const) {
        const card = wrapper.get(`[data-testid="${testId}"]`)
        const marker = card.get('.billing-summary-marker')
        expect(marker.attributes('aria-hidden')).toBe('true')
        expect(getComputedStyle(marker.element).backgroundColor).toBe(computedColor(markerColor))
        expect(getComputedStyle(card.get('dd').element).color).toBe(computedColor(tokenColors.total))
      }
    } finally {
      wrapper.element.remove()
    }

    for (const [key, expected] of [
      ['yesterday', '20'], ['week', '30'], ['month', '40'], ['allTime', '50'],
    ] as const) {
      await wrapper.get(`#tab-${key}`).trigger('click')
      expect(wrapper.get('[data-testid="billing-summary-total"]').text()).toContain(expected)
    }
    expect(api.settings.getTokenUsage).toHaveBeenCalledTimes(1)
  })

  it('shows the selected range, both charts and keeps the period while refreshing', async () => {
    const api = createApi()
    const usage = usageSnapshot(10)
    usage.yesterday = {
      ...usage.yesterday,
      inputTokens: 1_200,
      outputTokens: 34,
      totalTokens: 1_234,
      models: [{ model: 'precise/model', inputTokens: 1_200, outputTokens: 34, totalTokens: 1_234 }],
      trend: [{
        startedAt: usage.yesterday.startedAt,
        inputTokens: 1_200,
        outputTokens: 34,
        totalTokens: 1_234,
      }],
    }
    const refreshedUsage = usageSnapshot(99, 'refreshed/model')
    let resolveRefresh!: (value: TokenUsageSnapshot) => void
    const refreshResponse = new Promise<TokenUsageSnapshot>((resolve) => { resolveRefresh = resolve })
    vi.mocked(api.settings.getTokenUsage)
      .mockResolvedValueOnce(usage)
      .mockReturnValueOnce(refreshResponse)
    const { wrapper } = await mountApp('/settings', api)
    await vi.waitFor(() => expect(wrapper.get('[data-testid="billing-summary-total"]').text()).toContain('10'))

    await wrapper.get('#tab-yesterday').trigger('click')
    const expectedYesterdayEnd = new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(new Date(Date.parse('2026-08-16T16:00:00.000Z') - 1))
    expect(wrapper.get('[data-testid="billing-period-range"]').text()).toContain(expectedYesterdayEnd)

    const contentOrder = wrapper.findAll('.billing-chart-section, .billing-table-wrap')
    expect(contentOrder.map((item) => {
      if (item.find('[data-testid="token-usage-line-chart"]').exists()) return 'line'
      if (item.find('[data-testid="token-usage-bar-chart"]').exists()) return 'bar'
      if (item.find('.billing-table').exists()) return 'table'
      return 'unknown'
    })).toEqual(['line', 'bar', 'table'])

    const chartSections = wrapper.findAll('.billing-chart-section')
    expect(chartSections).toHaveLength(2)
    expect(chartSections.map((section) => {
      const labelledBy = section.attributes('aria-labelledby')
      const heading = section.get(`#${labelledBy}`)
      expect(heading.element.tagName).toBe('H3')
      return heading.text()
    })).toEqual(['Token 趋势', '模型用量'])

    const table = wrapper.get('.billing-table')
    expect(table.attributes('aria-label')).toBe('模型 Token 精确用量')
    const headers = table.findAll('th')
    expect(headers).toHaveLength(4)
    expect(headers.map((cell) => cell.text()))
      .toEqual(['模型', '输入 Token', '输出 Token', '总 Token'])
    expect(headers.map((cell) => cell.attributes('scope'))).toEqual(['col', 'col', 'col', 'col'])
    expect(table.get('tbody tr').findAll('td').map((cell) => cell.text()))
      .toEqual(['precise/model', '1,200', '34', '1,234'])

    await wrapper.get('#tab-month').trigger('click')
    expect(wrapper.get('[data-testid="billing-period-range"]').text()).toContain('2026')
    expect(wrapper.get('[data-testid="billing-summary-total"]').text()).toContain('10')

    const refreshClick = wrapper.get('[data-testid="billing-refresh"]').trigger('click')
    await vi.waitFor(() => expect(api.settings.getTokenUsage).toHaveBeenCalledTimes(2))
    expect(wrapper.get('#tab-month').attributes('aria-selected')).toBe('true')
    expect(wrapper.get('[data-testid="billing-summary-total"]').text()).toContain('10')

    resolveRefresh(refreshedUsage)
    await refreshClick
    await vi.waitFor(() => expect(wrapper.get('[data-testid="billing-summary-total"]').text()).toContain('99'))
    expect(wrapper.get('#tab-month').attributes('aria-selected')).toBe('true')
  })

  it('shows zero cards and one empty state instead of charts and table', async () => {
    const api = createApi()
    const usage = usageSnapshot(0)
    usage.today.trend = [{
      startedAt: usage.today.startedAt,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    }]
    vi.mocked(api.settings.getTokenUsage).mockResolvedValue(usage)
    const { wrapper } = await mountApp('/settings', api)
    await vi.waitFor(() => expect(wrapper.text()).toContain('暂无 Token 用量记录'))
    expect(wrapper.get('[data-testid="billing-summary-total"]').text()).toContain('0')
    expect(wrapper.findAll('.billing-empty').filter((item) => item.text() === '暂无 Token 用量记录')).toHaveLength(1)
    expect(wrapper.find('[data-testid="token-usage-line-chart"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="token-usage-bar-chart"]').exists()).toBe(false)
    expect(wrapper.find('.billing-table').exists()).toBe(false)

    await wrapper.get('#tab-allTime').trigger('click')
    expect(wrapper.get('[data-testid="billing-period-range"]').text()).toContain('暂无保留记录')
  })

  it('shows token usage empty and isolated error states', async () => {
    const emptyApi = createApi()
    vi.mocked(emptyApi.settings.getTokenUsage).mockResolvedValue(usageSnapshot(0))
    const emptyApp = await mountApp('/settings', emptyApi)
    await vi.waitFor(() => expect(emptyApp.wrapper.text()).toContain('暂无 Token 用量记录'))
    emptyApp.wrapper.unmount()

    const failingApi = createApi()
    vi.mocked(failingApi.settings.getTokenUsage).mockRejectedValue(new Error('billing unavailable'))
    const failingApp = await mountApp('/settings', failingApi)
    await vi.waitFor(() => expect(failingApp.wrapper.get('[data-testid="billing-panel"] [role="alert"]').text())
      .toBe('Token 用量加载失败'))
    expect(failingApp.wrapper.text()).toContain('大模型供应商')
  })

  it('matches every settings sidebar item to the rendered section order', async () => {
    const { wrapper } = await mountApp('/settings')
    await vi.waitFor(() => expect(wrapper.find('#about').exists()).toBe(true))

    const menuLabels = wrapper.findAll('[data-testid="settings-section-nav-item"]')
      .map((item) => item.text())
    const sectionLabels = wrapper.findAll('.settings-page .settings-section h2')
      .map((heading) => heading.text())

    expect(menuLabels).toEqual([
      '大模型供应商',
      '默认模型',
      'Token 账单',
      'VPN 代理',
      '外观与行为',
      '本地数据',
      '已保存授权',
      '关于 AutoForge',
    ])
    expect(menuLabels).toEqual(sectionLabels)
  })

  it('scrolls to a settings section without leaving the settings route', async () => {
    const { wrapper, router } = await mountApp('/settings')
    await vi.waitFor(() => expect(wrapper.find('#proxy').exists()).toBe(true))
    const scrollIntoView = vi.fn()
    const proxySection = wrapper.get('#proxy').element
    proxySection.scrollIntoView = scrollIntoView
    const getElementById = vi.spyOn(document, 'getElementById').mockReturnValue(proxySection)

    try {
      const proxyButton = wrapper.findAll('[data-testid="settings-section-nav-item"]')
        .find((item) => item.text() === 'VPN 代理')
      expect(proxyButton).toBeDefined()
      await proxyButton?.trigger('click')

      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
      expect(router.currentRoute.value.fullPath).toBe('/settings')
    } finally {
      getElementById.mockRestore()
    }
  })

  it('loads app information and revokes an exact saved permission grant', async () => {
    const api = createApi()
    vi.mocked(api.permissions.listGrants).mockResolvedValue([{
      id: 'grant_1', workflowId: 'search.real', workflowVersion: '1.2.3',
      capability: 'browser.open', scope: { origins: ['https://example.com'] },
      createdAt: '2026-07-19T00:00:00.000Z',
    }])
    vi.mocked(api.permissions.revoke).mockResolvedValue(undefined)
    vi.mocked(api.system.getAppInfo).mockResolvedValue({ version: '1.4.0', platform: 'win32' })

    const { wrapper } = await mountApp('/settings', api)
    await vi.waitFor(() => expect(wrapper.text()).toContain('search.real · 1.2.3'))
    expect(wrapper.text()).toContain('1.4.0')
    expect(wrapper.text()).toContain('Windows')
    expect(wrapper.text()).toContain('https://example.com')
    await wrapper.get('.grant-row button').trigger('click')
    await vi.waitFor(() => expect(api.permissions.revoke).toHaveBeenCalledWith('grant_1'))
    expect(wrapper.text()).not.toContain('search.real · 1.2.3')
  })

  it('folds the inspector when the viewport crosses below 1180 and removes the listener on unmount', async () => {
    let change: ((event: { matches: boolean }) => void) | undefined
    const removeEventListener = vi.fn()
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: (_: string, listener: typeof change) => { change = listener }, removeEventListener })))
    const { wrapper } = await mountApp('/chat')
    expect(wrapper.get('[data-testid="inspector-panel"]').attributes('data-open')).toBe('true')
    change?.({ matches: false })
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-testid="inspector-panel"]').attributes('data-open')).toBe('false')
    wrapper.unmount()
    expect(removeEventListener).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('does not nest an interactive cancel button inside an execution row button', async () => {
    const api = createApi()
    vi.mocked(api.executions.list).mockResolvedValue([{ id: 'exec_1', workflowId: 'w', workflowVersion: '1.0.0', status: 'running', createdAt: '2026-07-19T00:00:00.000Z' }])
    const { wrapper } = await mountApp('/executions', api)
    await vi.waitFor(() => expect(wrapper.findAll('.execution-row')).toHaveLength(1))
    expect(wrapper.find('.execution-row button').exists()).toBe(true)
    expect(wrapper.find('button.execution-row').exists()).toBe(false)
  })

  it('marks execution headers and cells semantically and selects a row from the keyboard', async () => {
    const api = createApi()
    vi.mocked(api.executions.list).mockResolvedValue([{
      id: 'exec_1', workflowId: 'workflow.real', workflowVersion: '1.0.0', status: 'completed', createdAt: '2026-07-19T00:00:00.000Z',
    }])
    vi.mocked(api.executions.get).mockResolvedValue({
      id: 'exec_1', workflowId: 'workflow.real', workflowVersion: '1.0.0', status: 'completed', createdAt: '2026-07-19T00:00:00.000Z',
      input: { keyword: 'weather' }, output: { title: 'sunny' }, error: { code: 'SAFE_ERROR', message: 'redacted message' }, steps: [], logs: [],
    })
    const { wrapper } = await mountApp('/executions', api)
    await vi.waitFor(() => expect(wrapper.findAll('[role="columnheader"]')).toHaveLength(5))
    expect(wrapper.findAll('.execution-row [role="cell"]')).toHaveLength(5)
    await wrapper.get('.execution-row').trigger('keydown', { key: ' ' })
    await vi.waitFor(() => expect(api.executions.get).toHaveBeenCalledWith('exec_1'))
    expect(wrapper.text()).toContain('weather')
    expect(wrapper.text()).toContain('sunny')
    expect(wrapper.text()).toContain('SAFE_ERROR')
    expect(wrapper.text()).toContain('redacted message')
  })

  it('describes all-data cleanup as conversations and executions while retaining other local state', async () => {
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValue('cancel')
    const { wrapper } = await mountApp('/settings')
    await vi.waitFor(() => expect(wrapper.text()).toContain('清除会话与执行记录'))
    const button = wrapper.findAll('button').find((entry) => entry.text().includes('清除会话与执行记录'))
    await button?.trigger('click')
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining('凭证、设置、授权和工作流将保留'),
      '确认清理本地数据',
      expect.any(Object),
    )
    confirm.mockRestore()
  })

  it('shows and saves normalized VPN proxy settings without per-character updates', async () => {
    const api = createApi()
    vi.mocked(api.settings.update).mockImplementation(async (patch) => ({
      ...await api.settings.get(),
      ...patch,
    }))
    const { wrapper } = await mountApp('/settings', api)

    await vi.waitFor(() => expect(wrapper.find('[data-testid="http-proxy"]').exists()).toBe(true))
    expect(wrapper.text()).toContain('http_proxy')
    expect(wrapper.text()).toContain('https_proxy')
    expect(wrapper.text()).toContain('socket_proxy')

    await wrapper.get('[data-testid="http-proxy"] input').setValue(' http://LOCALHOST:7890 ')
    expect(api.settings.update).not.toHaveBeenCalled()
    await wrapper.get('[data-testid="proxy-bypass"] textarea').setValue('Example.com\n*.internal.example')
    await wrapper.get('[data-testid="proxy-enabled"]').trigger('click')

    await vi.waitFor(() => expect(api.settings.update).toHaveBeenCalledWith({
      proxy: {
        enabled: true,
        httpProxy: 'http://localhost:7890',
        bypassDomains: ['example.com', '*.internal.example'],
      },
    }))
  })

  it('accepts enabling while the address blur save is still pending', async () => {
    const api = createApi()
    let finishFirst!: (settings: AppSettings) => void
    const firstUpdate = new Promise<AppSettings>((resolve) => { finishFirst = resolve })
    let updateCount = 0
    vi.mocked(api.settings.update).mockImplementation(async (patch) => {
      updateCount += 1
      if (updateCount === 1) return firstUpdate
      return { ...await api.settings.get(), ...patch }
    })
    const { wrapper } = await mountApp('/settings', api)
    await vi.waitFor(() => expect(wrapper.text()).toContain('默认文本模型'))

    await wrapper.get('[data-testid="http-proxy"] input').setValue('http://127.0.0.1:7890')
    await wrapper.get('[data-testid="http-proxy"] input').trigger('blur')
    await vi.waitFor(() => expect(useSettingsStore().saving).toBe(true))
    await wrapper.get('[data-testid="proxy-enabled"]').trigger('click')

    finishFirst({ ...await api.settings.get(), proxy: {
      enabled: false,
      httpProxy: 'http://127.0.0.1:7890',
      bypassDomains: [],
    } })
    await vi.waitFor(() => expect(api.settings.update).toHaveBeenCalledTimes(2))
    expect(api.settings.update).toHaveBeenLastCalledWith({
      proxy: {
        enabled: true,
        httpProxy: 'http://127.0.0.1:7890',
        bypassDomains: [],
      },
    })
  })

  it('preserves the newer enabled draft when blur succeeds and the queued switch fails', async () => {
    const api = createApi()
    const initial = await api.settings.get()
    let finishBlur!: (settings: AppSettings) => void
    const blurUpdate = new Promise<AppSettings>((resolve) => { finishBlur = resolve })
    let updateCount = 0
    vi.mocked(api.settings.update).mockImplementation(async () => {
      updateCount += 1
      if (updateCount === 1) return blurUpdate
      throw {
        code: 'NETWORK_PROXY_APPLY_FAILED',
        message: 'unsafe raw address',
      }
    })
    const { wrapper } = await mountApp('/settings', api)
    await vi.waitFor(() => expect(wrapper.text()).toContain('默认文本模型'))

    await wrapper.get('[data-testid="http-proxy"] input').setValue('http://127.0.0.1:7890')
    await wrapper.get('[data-testid="http-proxy"] input').trigger('blur')
    await vi.waitFor(() => expect(useSettingsStore().saving).toBe(true))
    await wrapper.get('[data-testid="proxy-enabled"]').trigger('click')
    finishBlur({ ...initial, proxy: {
      enabled: false,
      httpProxy: 'http://127.0.0.1:7890',
      bypassDomains: [],
    } })

    await vi.waitFor(() => expect(api.settings.update).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(wrapper.text()).toContain('代理应用失败，已保留原配置'))
    expect(api.settings.update).toHaveBeenLastCalledWith({
      proxy: {
        enabled: true,
        httpProxy: 'http://127.0.0.1:7890',
        bypassDomains: [],
      },
    })
    expect(useSettingsStore().settings?.proxy.enabled).toBe(false)
    expect(wrapper.get('[data-testid="proxy-enabled"] input').attributes('aria-checked')).toBe('true')
    expect((wrapper.get('[data-testid="http-proxy"] input').element as HTMLInputElement).value)
      .toBe('http://127.0.0.1:7890')
    expect(wrapper.text()).not.toContain('unsafe raw address')
  })

  it('keeps entered addresses when proxying is disabled', async () => {
    const { wrapper, api } = await mountApp('/settings', await apiWithEnabledProxy())
    await vi.waitFor(() => expect(wrapper.text()).toContain('默认文本模型'))
    await wrapper.get('[data-testid="proxy-enabled"]').trigger('click')
    await vi.waitFor(() => expect(api.settings.update).toHaveBeenCalledWith({
      proxy: expect.objectContaining({ enabled: false, httpProxy: 'http://127.0.0.1:7890' }),
    }))
    expect((wrapper.get('[data-testid="http-proxy"] input').element as HTMLInputElement).value)
      .toBe('http://127.0.0.1:7890')
    expect((wrapper.get('[data-testid="https-proxy"] input').element as HTMLInputElement).value)
      .toBe('https://proxy.example.com:8443')
    expect((wrapper.get('[data-testid="socket-proxy"] input').element as HTMLInputElement).value)
      .toBe('socks5://127.0.0.1:7891')
    expect((wrapper.get('[data-testid="proxy-bypass"] textarea').element as HTMLTextAreaElement).value)
      .toBe('example.com')
  })

  it('keeps the draft and shows the safe error when Main rejects proxy application', async () => {
    const api = createApi()
    vi.mocked(api.settings.update).mockRejectedValue({
      code: 'NETWORK_PROXY_APPLY_FAILED',
      message: 'unsafe raw address',
    })
    const { wrapper } = await mountApp('/settings', api)
    await vi.waitFor(() => expect(wrapper.text()).toContain('默认文本模型'))
    await wrapper.get('[data-testid="http-proxy"] input').setValue('http://127.0.0.1:7890')
    await wrapper.get('[data-testid="proxy-enabled"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.text()).toContain('代理应用失败，已保留原配置'))
    const store = useSettingsStore()
    expect(wrapper.text()).not.toContain('unsafe raw address')
    expect(wrapper.text()).toContain('已关闭，网络请求直连')
    expect(store.settings?.proxy).toEqual({ enabled: false, bypassDomains: [] })
    expect(wrapper.get('[data-testid="proxy-enabled"] input').attributes('aria-checked')).toBe('true')
    expect((wrapper.get('[data-testid="http-proxy"] input').element as HTMLInputElement).value)
      .toBe('http://127.0.0.1:7890')
  })

  it('validates an enabled proxy has an address before updating settings', async () => {
    const { wrapper, api } = await mountApp('/settings')
    await vi.waitFor(() => expect(wrapper.text()).toContain('默认文本模型'))
    await wrapper.get('[data-testid="proxy-enabled"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.text()).toContain('启用代理时至少填写一个代理地址'))
    expect(api.settings.update).not.toHaveBeenCalled()
  })

  it('rejects credential-bearing proxy URLs locally without exposing the entered value', async () => {
    const { wrapper, api } = await mountApp('/settings')
    await vi.waitFor(() => expect(wrapper.text()).toContain('默认文本模型'))
    await wrapper.get('[data-testid="http-proxy"] input')
      .setValue('http://user:password@127.0.0.1:7890')
    await wrapper.get('[data-testid="http-proxy"] input').trigger('blur')
    await vi.waitFor(() => expect(wrapper.text())
      .toContain('请输入不包含用户名、密码和路径的有效代理地址'))
    expect(wrapper.text()).not.toContain('user:password')
    expect(api.settings.update).not.toHaveBeenCalled()
  })

  it.each([
    ['HTTP', 'http-proxy', 'http://127.0.0.1:0'],
    ['HTTPS', 'https-proxy', 'https://127.0.0.1:0'],
    ['SOCKS4', 'socket-proxy', 'socks4://127.0.0.1:0'],
    ['SOCKS5', 'socket-proxy', 'socks5://127.0.0.1:0'],
  ])('rejects a %s port-zero proxy locally', async (_name, testId, address) => {
    const { wrapper, api } = await mountApp('/settings')
    await vi.waitFor(() => expect(wrapper.text()).toContain('默认文本模型'))
    await wrapper.get(`[data-testid="${testId}"] input`).setValue(address)
    await wrapper.get(`[data-testid="${testId}"] input`).trigger('blur')

    await vi.waitFor(() => expect(wrapper.text())
      .toContain('请输入不包含用户名、密码和路径的有效代理地址'))
    expect(api.settings.update).not.toHaveBeenCalled()
  })

  it('rejects malformed bypass entries locally', async () => {
    const { wrapper, api } = await mountApp('/settings')
    await vi.waitFor(() => expect(wrapper.text()).toContain('默认文本模型'))
    await wrapper.get('[data-testid="proxy-bypass"] textarea').setValue('https://example.com')
    await wrapper.get('[data-testid="proxy-bypass"] textarea').trigger('blur')
    await vi.waitFor(() => expect(wrapper.text()).toContain('代理忽略域名格式不正确'))
    expect(api.settings.update).not.toHaveBeenCalled()
  })

  it('clears a successfully saved key from the settings input without retaining it in state', async () => {
    const api = createApi()
    const success = vi.spyOn(ElMessage, 'success')
    vi.mocked(api.settings.validateProviderCredential)
      .mockResolvedValueOnce({
        provider: 'deepseek', configured: false, validation: 'unchecked',
      })
      .mockReturnValueOnce(new Promise(() => undefined))
    vi.mocked(api.settings.saveProviderApiKey).mockResolvedValue({
      provider: 'deepseek', configured: true, validation: 'unchecked',
    })
    const { wrapper, pinia } = await mountApp('/settings', api)
    await vi.waitFor(() => expect(wrapper.find('#provider-api-key').exists()).toBe(true))
    const input = wrapper.get('#provider-api-key')
    await input.setValue('sk-sensitive-value')
    await wrapper.get('[data-testid="save-api-key"]').trigger('click')
    await vi.waitFor(() => expect(api.settings.saveProviderApiKey)
      .toHaveBeenCalledWith('deepseek', 'sk-sensitive-value'))
    await vi.waitFor(() => expect(api.settings.validateProviderCredential).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(wrapper.text()).toContain('已设置 API Key · 尚未验证'))
    expect(success).toHaveBeenCalledWith('API Key 已保存到本地数据库')
    await vi.waitFor(() => expect((input.element as HTMLInputElement).value).toBe(''))
    expect(JSON.stringify(pinia.state.value)).not.toContain('sk-sensitive-value')
    success.mockRestore()
  })

  it('loads models for the saved provider after validation even if the active provider changes', async () => {
    const api = createApi()
    let resolveValidation!: (
      status: Awaited<ReturnType<DesktopAPI['settings']['validateProviderCredential']>>,
    ) => void
    vi.mocked(api.settings.validateProviderCredential)
      .mockResolvedValueOnce({
        provider: 'deepseek', configured: false, validation: 'unchecked',
      })
      .mockReturnValueOnce(new Promise((resolve) => { resolveValidation = resolve }))
    vi.mocked(api.settings.saveProviderApiKey).mockResolvedValue({
      provider: 'deepseek', configured: true, validation: 'unchecked',
    })
    const { wrapper } = await mountApp('/settings', api)
    await vi.waitFor(() => expect(wrapper.text()).toContain('未设置 API Key'))
    const store = useSettingsStore()
    const loadModels = vi.spyOn(store, 'loadModels')

    await wrapper.get('#provider-api-key').setValue('sk-deepseek')
    await wrapper.get('[data-testid="save-api-key"]').trigger('click')
    await vi.waitFor(() => expect(api.settings.validateProviderCredential).toHaveBeenCalledTimes(2))
    if (store.settings) store.settings.activeProvider = 'openrouter'
    resolveValidation({ provider: 'deepseek', configured: true, validation: 'valid' })

    await vi.waitFor(() => expect(loadModels).toHaveBeenCalledWith('deepseek'))
  })

  it('does not load provider models when the saved API Key fails validation', async () => {
    const api = createApi()
    let resolveValidation!: (
      status: Awaited<ReturnType<DesktopAPI['settings']['validateProviderCredential']>>,
    ) => void
    vi.mocked(api.settings.validateProviderCredential)
      .mockResolvedValueOnce({
        provider: 'deepseek', configured: false, validation: 'unchecked',
      })
      .mockReturnValueOnce(new Promise((resolve) => { resolveValidation = resolve }))
    vi.mocked(api.settings.saveProviderApiKey).mockResolvedValue({
      provider: 'deepseek', configured: true, validation: 'unchecked',
    })
    const { wrapper } = await mountApp('/settings', api)
    await vi.waitFor(() => expect(wrapper.text()).toContain('未设置 API Key'))
    const store = useSettingsStore()
    const loadModels = vi.spyOn(store, 'loadModels')

    await wrapper.get('#provider-api-key').setValue('invalid-key')
    await wrapper.get('[data-testid="save-api-key"]').trigger('click')
    await vi.waitFor(() => expect(api.settings.validateProviderCredential).toHaveBeenCalledTimes(2))
    resolveValidation({ provider: 'deepseek', configured: true, validation: 'invalid' })

    await vi.waitFor(() => expect(wrapper.text()).toContain('已设置 API Key · 验证失败'))
    expect(loadModels).not.toHaveBeenCalled()
  })

  it('separates locally saved API Key state from provider validation state', async () => {
    const labels = [
      [{ provider: 'deepseek', configured: false, validation: 'unchecked' }, '未设置 API Key'],
      [{ provider: 'deepseek', configured: true, validation: 'valid' }, '已设置 API Key · 已验证'],
      [{ provider: 'deepseek', configured: true, validation: 'invalid' }, '已设置 API Key · 验证失败'],
      [{ provider: 'deepseek', configured: true, validation: 'denied' }, '已设置 API Key · 访问受限'],
      [{ provider: 'deepseek', configured: true, validation: 'unavailable' }, '已设置 API Key · 暂时无法验证'],
      [{ provider: 'deepseek', configured: true, validation: 'unchecked' }, '已设置 API Key · 尚未验证'],
    ] as const

    for (const [credential, label] of labels) {
      const api = createApi()
      vi.mocked(api.settings.validateProviderCredential).mockResolvedValue(credential)
      const { wrapper } = await mountApp('/settings', api)
      await vi.waitFor(() => expect(wrapper.text()).toContain(label))
      if (credential.validation === 'denied') {
        expect(wrapper.text()).toContain('请检查模型权限、内容策略或 Guardrail 设置')
      }
      wrapper.unmount()
    }
  })
})
