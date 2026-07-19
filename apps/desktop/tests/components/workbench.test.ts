import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import ElementPlus from 'element-plus'
import type { DesktopAPI } from '@autoforge/shared'
import App from '../../src/App.vue'
import { routes } from '../../src/router/index'
import { useExecutionStore } from '../../src/stores/execution'
import { useWorkflowStore } from '../../src/stores/workflow'

function createApi(overrides: Partial<DesktopAPI> = {}): DesktopAPI {
  return {
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
      createProject: vi.fn(), registerProject: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(),
      validate: vi.fn(), run: vi.fn(),
    },
    executions: {
      list: vi.fn().mockResolvedValue([]), get: vi.fn(), decide: vi.fn(), cancel: vi.fn(),
      onEvent: vi.fn(() => vi.fn()),
    },
    permissions: { listGrants: vi.fn().mockResolvedValue([]), revoke: vi.fn() },
    settings: {
      get: vi.fn().mockResolvedValue({
        theme: 'system', language: 'zh-CN', dataDirectory: '/data', logDirectory: '/logs',
        defaultModel: '', showCosts: false, developerMode: false, permissionDefault: 'ask',
      }),
      update: vi.fn(), saveOpenRouterKey: vi.fn(), clearOpenRouterKey: vi.fn(),
      validateOpenRouterKey: vi.fn().mockResolvedValue({ configured: false, valid: false }),
      listModels: vi.fn().mockResolvedValue([]), clearLocalData: vi.fn(),
    },
    system: { openExternal: vi.fn() },
    ...overrides,
  }
}

async function mountApp(path = '/chat', api = createApi()) {
  Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
  const router = createRouter({ history: createMemoryHistory(), routes })
  const pinia = createPinia()
  setActivePinia(pinia)
  await router.push(path)
  await router.isReady()
  const wrapper = mount(App, { global: { plugins: [pinia, router, ElementPlus] } })
  await Promise.resolve()
  return { wrapper, router, api, pinia }
}

describe('workbench', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
  })
  afterEach(() => Reflect.deleteProperty(window, 'autoForge'))

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

  it('renders the developer route as an honest Task 11 placeholder', async () => {
    const { wrapper } = await mountApp('/developer')
    expect(wrapper.text()).toContain('开发模式将在下一阶段实现')
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
    store.items = [item]

    await store.setEnabled(item, true)
    await store.remove(item)

    expect(api.workflows.setEnabled).toHaveBeenCalledWith('search.real', true)
    expect(api.workflows.remove).toHaveBeenCalledWith('search.real', '1.2.3')
    expect(store.items).toEqual([])
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

  it('clears a successfully saved key from the settings input without retaining it in state', async () => {
    const api = createApi()
    vi.mocked(api.settings.saveOpenRouterKey).mockResolvedValue({ configured: true, valid: true })
    const { wrapper, pinia } = await mountApp('/settings', api)
    await vi.waitFor(() => expect(api.settings.get).toHaveBeenCalled())
    const input = wrapper.get('#openrouter-key')
    await input.setValue('sk-sensitive-value')
    await wrapper.get('[data-testid="save-api-key"]').trigger('click')
    await vi.waitFor(() => expect(api.settings.saveOpenRouterKey).toHaveBeenCalledWith('sk-sensitive-value'))
    await vi.waitFor(() => expect((input.element as HTMLInputElement).value).toBe(''))
    expect(JSON.stringify(pinia.state.value)).not.toContain('sk-sensitive-value')
  })
})
