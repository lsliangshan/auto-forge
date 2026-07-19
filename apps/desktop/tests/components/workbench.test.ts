import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import ElementPlus, { ElMessageBox } from 'element-plus'
import type { DesktopAPI } from '@autoforge/shared'
import App from '../../src/App.vue'
import ExecutionCard from '../../src/components/chat/ExecutionCard.vue'
import { routes } from '../../src/router/index'
import { useExecutionStore } from '../../src/stores/execution'
import { useChatStore } from '../../src/stores/chat'
import { useSettingsStore } from '../../src/stores/settings'
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
        defaultModel: '', showCosts: false, developerMode: false, permissionDefault: 'ask',
      }),
      update: vi.fn(), saveOpenRouterKey: vi.fn(), clearOpenRouterKey: vi.fn(),
      validateOpenRouterKey: vi.fn().mockResolvedValue({ configured: false, valid: false }),
      listModels: vi.fn().mockResolvedValue([]), clearLocalData: vi.fn(),
    },
    system: { openExternal: vi.fn(), getAppInfo: vi.fn().mockResolvedValue({ version: '0.1.0', platform: 'darwin' }) },
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
    const first = { theme: 'dark' as const, language: 'zh-CN' as const, dataDirectory: '/data', logDirectory: '/logs', defaultModel: 'old', showCosts: false, developerMode: false, permissionDefault: 'ask' as const }
    const second = { ...first, defaultModel: 'new' }
    vi.mocked(api.settings.update).mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useSettingsStore()
    await Promise.all([store.update({ theme: 'dark' }), store.update({ defaultModel: 'new' })])
    expect(api.settings.update).toHaveBeenNthCalledWith(1, { theme: 'dark' })
    expect(api.settings.update).toHaveBeenNthCalledWith(2, { defaultModel: 'new' })
    expect(store.settings?.defaultModel).toBe('new')
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
