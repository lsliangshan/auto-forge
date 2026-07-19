import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ElementPlus from 'element-plus'
import type { ApprovalDecision, ChatEvent, DesktopAPI, ExecutionEvent } from '@autoforge/shared'
import ApprovalCard from '../../src/components/chat/ApprovalCard.vue'
import ChatComposer from '../../src/components/chat/ChatComposer.vue'
import { useChatStore } from '../../src/stores/chat'

const scopeHash = 'a'.repeat(64)

function createEventApi() {
  let chatListener: ((event: ChatEvent) => void) | undefined
  let executionListener: ((event: ExecutionEvent) => void) | undefined
  const chatUnsubscribe = vi.fn()
  const executionUnsubscribe = vi.fn()
  const decide = vi.fn<(input: ApprovalDecision) => Promise<void>>().mockResolvedValue(undefined)
  const api = {
    chat: {
      listConversations: vi.fn().mockResolvedValue([]), createConversation: vi.fn(),
      listMessages: vi.fn().mockResolvedValue([]),
      renameConversation: vi.fn(), deleteConversation: vi.fn(),
      send: vi.fn().mockResolvedValue({ requestId: 'req_1' }), cancel: vi.fn(),
      onEvent: vi.fn((listener) => { chatListener = listener; return chatUnsubscribe }),
    },
    workflows: { list: vi.fn(), get: vi.fn(), setEnabled: vi.fn(), remove: vi.fn(), installProject: vi.fn() },
    developer: { createProject: vi.fn(), registerProject: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(), build: vi.fn(), validate: vi.fn(), run: vi.fn() },
    executions: {
      list: vi.fn(), get: vi.fn(), decide, cancel: vi.fn(),
      onEvent: vi.fn((listener) => { executionListener = listener; return executionUnsubscribe }),
    },
    permissions: { listGrants: vi.fn(), revoke: vi.fn() },
    settings: { get: vi.fn(), update: vi.fn(), saveOpenRouterKey: vi.fn(), clearOpenRouterKey: vi.fn(), validateOpenRouterKey: vi.fn(), listModels: vi.fn(), clearLocalData: vi.fn() },
    system: { openExternal: vi.fn(), getAppInfo: vi.fn().mockResolvedValue({ version: '0.1.0', platform: 'darwin' }) },
  } as unknown as DesktopAPI
  return { api, decide, chatUnsubscribe, executionUnsubscribe, emitChat: (event: ChatEvent) => chatListener?.(event), emitExecution: (event: ExecutionEvent) => executionListener?.(event) }
}

describe('chat interactions', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => Reflect.deleteProperty(window, 'autoForge'))

  it('submits the complete current identity for an exact once approval and disables duplicates', async () => {
    const { api, decide } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const wrapper = mount(ApprovalCard, {
      props: { approval: { executionId: 'exec_1', workflowId: 'browser.search.baidu', workflowVersion: '2.1.0', permissionIndex: 2, scopeHash, capability: 'browser.navigate', scope: { origins: ['https://www.baidu.com'] } } },
      global: { plugins: [ElementPlus] },
    })
    await wrapper.get('[data-testid="approve-once"]').trigger('click')
    await wrapper.get('[data-testid="approve-once"]').trigger('click')
    expect(decide).toHaveBeenCalledTimes(1)
    expect(decide).toHaveBeenCalledWith({ executionId: 'exec_1', permissionIndex: 2, scopeHash, decision: 'once' })
    expect(wrapper.get('[data-testid="approve-once"]').attributes('disabled')).toBeDefined()
  })

  it('submits an always grant with the exact pending workflow version without reading an execution record', async () => {
    const { api, decide } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const wrapper = mount(ApprovalCard, {
      props: { approval: { executionId: 'exec_pending', workflowId: 'browser.search.baidu', workflowVersion: '2.1.0', permissionIndex: 0, scopeHash, capability: 'browser.navigate', scope: { origins: ['https://www.baidu.com'] } } },
      global: { plugins: [ElementPlus] },
    })
    await wrapper.get('[data-testid="approve-always"]').trigger('click')
    expect(api.executions.get).not.toHaveBeenCalled()
    expect(decide).toHaveBeenCalledWith({
      executionId: 'exec_pending', workflowId: 'browser.search.baidu', workflowVersion: '2.1.0',
      permissionIndex: 0, scopeHash, decision: 'always', capability: 'browser.navigate',
      scope: { origins: ['https://www.baidu.com'] },
    })
  })

  it('subscribes once and merges streamed text deltas without duplication', () => {
    const { api, emitChat } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.ensureSubscriptions()
    store.ensureSubscriptions()
    expect(api.chat.onEvent).toHaveBeenCalledTimes(1)
    emitChat({ type: 'block', conversationId: 'conv_1', messageId: 'msg_1', block: { type: 'text', text: '你好' } })
    emitChat({ type: 'block', conversationId: 'conv_1', messageId: 'msg_1', block: { type: 'text', text: '，世界' } })
    expect(store.messagesByConversation.conv_1?.[0]?.blocks).toEqual([
      expect.objectContaining({ id: 'msg_1:text:0', type: 'text', text: '你好，世界' }),
    ])
  })

  it('does not let a loading snapshot overwrite a newer streamed delta', async () => {
    const { api, emitChat } = createEventApi()
    let resolveMessages!: (value: Awaited<ReturnType<DesktopAPI['chat']['listMessages']>>) => void
    vi.mocked(api.chat.listConversations).mockResolvedValue([{ id: 'conv_1', title: '真实会话', createdAt: '2026-07-19T00:00:00.000Z', updatedAt: '2026-07-19T00:00:00.000Z' }])
    vi.mocked(api.chat.listMessages).mockReturnValue(new Promise((resolve) => { resolveMessages = resolve }))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    const loading = store.loadConversations()
    await vi.waitFor(() => expect(api.chat.listMessages).toHaveBeenCalledWith('conv_1'))
    emitChat({ type: 'block', conversationId: 'conv_1', messageId: 'live_1', block: { type: 'text', text: '实时内容' } })
    resolveMessages([{ id: 'old_1', conversationId: 'conv_1', role: 'assistant', blocks: [{ type: 'text', text: '旧快照' }], createdAt: '2026-07-19T00:00:00.000Z' }])
    await loading
    expect(store.messagesByConversation.conv_1?.map(({ id }) => id)).toEqual(['live_1'])
  })

  it('ignores a late message response after switching conversations', async () => {
    const { api } = createEventApi()
    let resolveFirst!: (value: Awaited<ReturnType<DesktopAPI['chat']['listMessages']>>) => void
    vi.mocked(api.chat.listMessages)
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve }))
      .mockResolvedValueOnce([{ id: 'm2', conversationId: 'conv_2', role: 'assistant', blocks: [{ type: 'text', text: '第二个会话' }], createdAt: '2026-07-19T00:00:00.000Z' }])
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    const first = store.selectConversation('conv_1')
    await vi.waitFor(() => expect(api.chat.listMessages).toHaveBeenCalledWith('conv_1'))
    await store.selectConversation('conv_2')
    resolveFirst([{ id: 'm1', conversationId: 'conv_1', role: 'assistant', blocks: [{ type: 'text', text: '迟到响应' }], createdAt: '2026-07-19T00:00:00.000Z' }])
    await first
    expect(store.selectedConversationId).toBe('conv_2')
    expect(store.messagesByConversation.conv_1).toBeUndefined()
    expect(store.messagesByConversation.conv_2?.[0]?.blocks[0]).toMatchObject({ text: '第二个会话' })
  })

  it('does not resurrect a request that completed before send returned', async () => {
    const { api, emitChat } = createEventApi()
    let resolveSend!: (value: { requestId: string }) => void
    vi.mocked(api.chat.send).mockReturnValue(new Promise((resolve) => { resolveSend = resolve }))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.selectedConversationId = 'conv_1'
    store.ensureSubscriptions()

    const sending = store.send('真实请求')
    emitChat({ type: 'status', conversationId: 'conv_1', requestId: 'req_fast', status: 'completed' })
    resolveSend({ requestId: 'req_fast' })
    await sending

    expect(store.isRunning).toBe(false)
  })

  it('releases the bridge listener on the last store disposal and does not duplicate deltas after rebuild', () => {
    const { api, chatUnsubscribe, emitChat } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const first = useChatStore()
    first.ensureSubscriptions()
    first.$dispose()
    expect(chatUnsubscribe).toHaveBeenCalledTimes(1)

    setActivePinia(createPinia())
    const second = useChatStore()
    second.ensureSubscriptions()
    emitChat({ type: 'block', conversationId: 'conv_1', messageId: 'msg_1', block: { type: 'text', text: '一次' } })
    expect(api.chat.onEvent).toHaveBeenCalledTimes(2)
    expect(second.messagesByConversation.conv_1?.[0]?.blocks).toEqual([
      expect.objectContaining({ text: '一次' }),
    ])
  })

  it('trims composer input, honors IME, and uses Shift+Enter for a newline', async () => {
    const wrapper = mount(ChatComposer, { props: { disabled: false, running: false }, global: { plugins: [ElementPlus] } })
    const textarea = wrapper.get('textarea')
    await textarea.setValue('  查询天气  ')
    await textarea.trigger('compositionstart')
    await textarea.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('submit')).toBeUndefined()
    await textarea.trigger('compositionend')
    await textarea.trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(wrapper.emitted('submit')).toBeUndefined()
    await textarea.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('submit')?.[0]).toEqual(['查询天气'])
  })

  it('keeps running input and blocks Enter submission at the submit layer', async () => {
    const wrapper = mount(ChatComposer, { props: { disabled: false, running: true }, global: { plugins: [ElementPlus] } })
    const textarea = wrapper.get('textarea')
    await textarea.setValue('保留这段输入')
    await textarea.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('submit')).toBeUndefined()
    expect((textarea.element as HTMLTextAreaElement).value).toBe('保留这段输入')
  })
})
