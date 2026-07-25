import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { isProxy } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ElementPlus from 'element-plus'
import type {
  ApprovalDecision,
  ChatEvent,
  ConversationGenerationPreferences,
  DesktopAPI,
  ExecutionEvent,
  MediaAsset,
  ModelInfo,
} from '@autoforge/shared'
import ApprovalCard from '../../src/components/chat/ApprovalCard.vue'
import ChatComposer from '../../src/components/chat/ChatComposer.vue'
import { useChatStore } from '../../src/stores/chat'

const scopeHash = 'a'.repeat(64)

function generationPreferences(
  overrides: Partial<ConversationGenerationPreferences> = {},
): ConversationGenerationPreferences {
  return {
    outputType: 'auto',
    models: {},
    generation: {
      image: { count: 1, resolution: '1K', aspectRatio: 'auto', format: 'png' },
      audio: { format: 'mp3' },
      video: { durationSeconds: 5, resolution: '720p', aspectRatio: 'auto', generateAudio: false },
    },
    ...overrides,
  }
}

function mediaAsset(id: string, kind: MediaAsset['kind'] = 'image'): MediaAsset {
  return {
    id,
    kind,
    mimeType: kind === 'image' ? 'image/png' : kind === 'audio' ? 'audio/mpeg' : 'video/mp4',
    name: `${id}.${kind === 'image' ? 'png' : kind === 'audio' ? 'mp3' : 'mp4'}`,
    byteSize: 1024,
  }
}

function modelInfo(id: string, outputs: ModelInfo['outputModalities']): ModelInfo {
  return {
    id,
    name: id,
    inputModalities: ['text', 'image', 'audio', 'video'],
    outputModalities: outputs,
    supportsTools: outputs.includes('text'),
    generation: {
      ...(outputs.includes('image') ? {
        image: { resolutions: ['1K', '2K'], aspectRatios: ['auto', '1:1'], formats: ['png'], maxCount: 1 },
      } : {}),
      ...(outputs.includes('audio') ? {
        audio: { voices: ['alloy'], formats: ['mp3'] },
      } : {}),
      ...(outputs.includes('video') ? {
        video: { resolutions: ['720p'], aspectRatios: ['auto', '16:9'], durations: [5, 10], supportsAudio: true },
      } : {}),
    },
  }
}

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
      getGenerationPreferences: vi.fn().mockResolvedValue(generationPreferences()),
      updateGenerationPreferences: vi.fn(async (_conversationId, preferences) => preferences),
      onEvent: vi.fn((listener) => { chatListener = listener; return chatUnsubscribe }),
    },
    media: {
      pickFiles: vi.fn().mockResolvedValue([]),
      importDroppedFiles: vi.fn().mockResolvedValue([]),
      importClipboardImage: vi.fn().mockResolvedValue([]),
      removeDraft: vi.fn().mockResolvedValue(undefined),
      saveCopy: vi.fn(), reveal: vi.fn(), pauseVideoJob: vi.fn(), resumeVideoJob: vi.fn(),
    },
    workflows: { list: vi.fn(), get: vi.fn(), setEnabled: vi.fn(), remove: vi.fn(), installProject: vi.fn() },
    developer: { listProjects: vi.fn().mockResolvedValue([]), createProject: vi.fn(), registerProject: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(), build: vi.fn(), validate: vi.fn(), run: vi.fn() },
    executions: {
      list: vi.fn(), get: vi.fn(), decide, cancel: vi.fn(),
      onEvent: vi.fn((listener) => { executionListener = listener; return executionUnsubscribe }),
    },
    permissions: { listGrants: vi.fn(), revoke: vi.fn() },
    settings: {
      get: vi.fn(), update: vi.fn(), saveProviderApiKey: vi.fn(), clearProviderApiKey: vi.fn(),
      validateProviderCredential: vi.fn(), listProviderModels: vi.fn(), clearLocalData: vi.fn(),
    },
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

    const sending = store.send({
      content: '真实请求',
      assetIds: [],
      outputType: 'text',
      generation: generationPreferences().generation,
    })
    emitChat({ type: 'status', conversationId: 'conv_1', requestId: 'req_fast', status: 'completed' })
    resolveSend({ requestId: 'req_fast' })
    await sending

    expect(store.isRunning).toBe(false)
  })

  it('maps asynchronous provider failures to actionable localized chat errors', () => {
    const { api, emitChat } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.ensureSubscriptions()

    emitChat({
      type: 'status',
      conversationId: 'conv_1',
      requestId: 'req_failed',
      status: 'failed',
      error: { code: 'CREDENTIAL_UNAVAILABLE', message: 'The credential is unavailable.' },
    })

    expect(store.error).toBe('当前供应商尚未配置 API Key，或系统安全存储暂时不可用')
  })

  it('reports provider access denial without claiming the API Key is invalid', () => {
    const { api, emitChat } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.ensureSubscriptions()

    emitChat({
      type: 'status',
      conversationId: 'conv_1',
      requestId: 'req_denied',
      status: 'failed',
      error: { code: 'MODEL_PROVIDER_ACCESS_DENIED', message: 'The model provider denied access.' },
    })

    expect(store.error).toBe('供应商拒绝了该模型请求，请检查模型权限、内容策略或 Guardrail 设置')
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
    expect(wrapper.emitted('submit')?.[0]).toEqual([{
      content: '查询天气',
      assetIds: [],
      outputType: 'auto',
      generation: generationPreferences().generation,
    }])
  })

  it('keeps running input and blocks Enter submission at the submit layer', async () => {
    const wrapper = mount(ChatComposer, {
      props: { disabled: false, running: true, models: [], defaultModel: '' },
      global: { plugins: [ElementPlus] },
    })
    const textarea = wrapper.get('textarea')
    await textarea.setValue('保留这段输入')
    await textarea.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('submit')).toBeUndefined()
    expect((textarea.element as HTMLTextAreaElement).value).toBe('保留这段输入')
  })

  it('replaces a media block by its stable block id instead of its array position', () => {
    const { api, emitChat } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.ensureSubscriptions()

    emitChat({
      type: 'block',
      conversationId: 'conv_1',
      messageId: 'msg_1',
      block: { type: 'text', text: '前文' },
    })
    emitChat({
      type: 'block',
      conversationId: 'conv_1',
      messageId: 'msg_1',
      block: {
        type: 'media_generation',
        blockId: 'block_media',
        jobId: 'job_1',
        kind: 'image',
        status: 'pending',
      },
    })
    emitChat({
      type: 'block_update',
      conversationId: 'conv_1',
      messageId: 'msg_1',
      blockId: 'block_media',
      block: {
        type: 'media',
        blockId: 'block_media',
        assetId: 'asset_1',
        kind: 'image',
        purpose: 'output',
        name: 'result.png',
        mimeType: 'image/png',
        byteSize: 20,
      },
    })

    expect(store.messagesByConversation.conv_1?.[0]?.blocks).toEqual([
      expect.objectContaining({ id: 'msg_1:text:0', type: 'text', text: '前文' }),
      expect.objectContaining({
        id: 'msg_1:block_media',
        type: 'media',
        blockId: 'block_media',
        assetId: 'asset_1',
      }),
    ])
  })

  it('loads and persists full generation preferences per conversation without late response leakage', async () => {
    const { api } = createEventApi()
    let resolveFirst!: (value: ConversationGenerationPreferences) => void
    const firstPreferences = generationPreferences({ outputType: 'image', models: { image: 'image/one' } })
    const secondPreferences = generationPreferences({ outputType: 'video', models: { video: 'video/two' } })
    vi.mocked(api.chat.getGenerationPreferences)
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve }))
      .mockResolvedValueOnce(secondPreferences)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()

    const first = store.selectConversation('conv_1')
    await vi.waitFor(() => expect(api.chat.getGenerationPreferences).toHaveBeenCalledWith('conv_1'))
    await store.selectConversation('conv_2')
    resolveFirst(firstPreferences)
    await first

    expect(store.selectedConversationId).toBe('conv_2')
    expect(store.preferences).toEqual(secondPreferences)
    expect(store.preferencesByConversation.conv_1).toEqual(firstPreferences)

    const imageUpdate = generationPreferences({ outputType: 'image', models: { image: 'image/new' } })
    const audioUpdate = generationPreferences({ outputType: 'audio', models: { audio: 'audio/new' } })
    await Promise.all([
      store.updateGenerationPreferences('conv_2', imageUpdate),
      store.updateGenerationPreferences('conv_2', audioUpdate),
    ])
    expect(api.chat.updateGenerationPreferences).toHaveBeenNthCalledWith(1, 'conv_2', imageUpdate)
    expect(api.chat.updateGenerationPreferences).toHaveBeenNthCalledWith(2, 'conv_2', audioUpdate)
    expect(store.preferencesByConversation.conv_2).toEqual(audioUpdate)
  })

  it('imports picked, dropped, and clipboard media without exposing clipboard image bytes', async () => {
    const { api } = createEventApi()
    vi.mocked(api.media.pickFiles).mockResolvedValue([mediaAsset('picked')])
    vi.mocked(api.media.importDroppedFiles).mockResolvedValue([mediaAsset('dropped', 'audio')])
    vi.mocked(api.media.importClipboardImage).mockResolvedValue([mediaAsset('pasted')])
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.selectedConversationId = 'conversation_1'
    store.preferencesByConversation.conversation_1 = generationPreferences({ outputType: 'text' })
    const wrapper = mount(ChatComposer, {
      props: { disabled: false, running: false, models: [modelInfo('text/model', ['text'])], defaultModel: 'text/model' },
      global: { plugins: [ElementPlus] },
    })

    await wrapper.get('[data-testid="attach-media"]').trigger('click')
    expect(api.media.pickFiles).toHaveBeenCalledWith({
      conversationId: 'conversation_1',
      existingAssetIds: [],
    })

    const droppedFile = new File(['audio'], 'sample.mp3', { type: 'audio/mpeg' })
    await wrapper.get('[data-testid="chat-composer"]').trigger('drop', {
      dataTransfer: { files: [droppedFile] },
    })
    expect(api.media.importDroppedFiles).toHaveBeenCalledWith({
      conversationId: 'conversation_1',
      existingAssetIds: ['picked'],
    }, [droppedFile])

    const getAsFile = vi.fn()
    await wrapper.get('textarea').trigger('paste', {
      clipboardData: { items: [{ type: 'image/png', getAsFile }] },
    })
    expect(api.media.importClipboardImage).toHaveBeenCalledWith({
      conversationId: 'conversation_1',
      existingAssetIds: ['picked', 'dropped'],
    })
    expect(getAsFile).not.toHaveBeenCalled()
    expect(store.drafts.map(({ id }) => id)).toEqual(['picked', 'dropped', 'pasted'])
  })

  it('removes drafts through Main and allows the fifth attachment while blocking a sixth', async () => {
    const { api } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.selectedConversationId = 'conversation_1'
    store.preferencesByConversation.conversation_1 = generationPreferences({ outputType: 'text' })
    store.draftsByConversation.conversation_1 = ['1', '2', '3', '4'].map((id) => mediaAsset(id))
    vi.mocked(api.media.pickFiles).mockResolvedValue([mediaAsset('5')])
    const wrapper = mount(ChatComposer, {
      props: { disabled: false, running: false, models: [modelInfo('text/model', ['text'])], defaultModel: 'text/model' },
      global: { plugins: [ElementPlus] },
    })

    await wrapper.get('[data-testid="attach-media"]').trigger('click')
    expect(store.drafts).toHaveLength(5)
    await wrapper.get('[data-testid="attach-media"]').trigger('click')
    expect(api.media.pickFiles).toHaveBeenCalledTimes(1)

    await wrapper.get('[data-testid="remove-draft-1"]').trigger('click')
    expect(api.media.removeDraft).toHaveBeenCalledWith({
      conversationId: 'conversation_1',
      assetId: '1',
    })
    expect(store.drafts.map(({ id }) => id)).toEqual(['2', '3', '4', '5'])
  })

  it('shows only the selected output controls and filters models by capability', async () => {
    const { api } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.selectedConversationId = 'conversation_1'
    store.preferencesByConversation.conversation_1 = generationPreferences({ outputType: 'text' })
    const wrapper = mount(ChatComposer, {
      props: {
        disabled: false,
        running: false,
        models: [
          modelInfo('text/model', ['text']),
          modelInfo('image/model', ['image']),
          modelInfo('video/model', ['video']),
          modelInfo('video/model-two', ['video']),
        ],
        defaultModel: 'text/model',
      },
      global: { plugins: [ElementPlus] },
    })

    await wrapper.get('[data-testid="output-type"]').setValue('video')
    await vi.waitFor(() => expect(store.preferences.outputType).toBe('video'))
    expect(wrapper.find('[data-testid="video-options"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="image-options"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="model-select"] option').map((option) => option.attributes('value')))
      .toEqual(['video/model', 'video/model-two'])

    await wrapper.get('[data-testid="model-select"]').setValue('video/model-two')
    await wrapper.get('[data-testid="video-duration"]').setValue('10')
    await vi.waitFor(() => expect(store.preferences.models.video).toBe('video/model-two'))
    expect(store.preferences.generation.video.durationSeconds).toBe(10)
    await vi.waitFor(() => {
      expect(api.chat.updateGenerationPreferences).toHaveBeenLastCalledWith(
        'conversation_1',
        expect.objectContaining({
          outputType: 'video',
          models: expect.objectContaining({ video: 'video/model-two' }),
          generation: expect.objectContaining({
            video: expect.objectContaining({ durationSeconds: 10 }),
          }),
        }),
      )
    })
  })

  it('requires an explicit output choice for a first-use automatic multi-output model', () => {
    const { api } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.selectedConversationId = 'conversation_1'
    store.preferencesByConversation.conversation_1 = generationPreferences()
    const wrapper = mount(ChatComposer, {
      props: {
        disabled: false,
        running: false,
        models: [modelInfo('multi/model', ['text', 'image'])],
        defaultModel: 'multi/model',
      },
      global: { plugins: [ElementPlus] },
    })

    expect(wrapper.get('[data-testid="output-choice-required"]').text()).toContain('请选择输出类型')
    expect(wrapper.get('[data-testid="send-message"]').attributes('disabled')).toBeDefined()
  })

  it('allows an attachment-only text request and emits the complete payload', async () => {
    const { api } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.selectedConversationId = 'conversation_1'
    store.draftsByConversation.conversation_1 = [mediaAsset('asset_1')]
    store.preferencesByConversation.conversation_1 = generationPreferences({
      outputType: 'text',
      models: { text: 'text/model' },
    })
    const wrapper = mount(ChatComposer, {
      props: { disabled: false, running: false, models: [modelInfo('text/model', ['text'])], defaultModel: '' },
      global: { plugins: [ElementPlus] },
    })

    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('submit')?.[0]).toEqual([{
      content: '',
      assetIds: ['asset_1'],
      outputType: 'text',
      generation: generationPreferences().generation,
      model: 'text/model',
    }])

    await wrapper.get('[data-testid="output-type"]').setValue('image')
    await vi.waitFor(() => expect(store.preferences.outputType).toBe('image'))
    expect(wrapper.get('[data-testid="send-message"]').attributes('disabled')).toBeDefined()
  })

  it('passes clone-safe plain preference and send payloads across the desktop bridge', async () => {
    const { api } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.selectedConversationId = 'conversation_1'
    store.preferencesByConversation.conversation_1 = generationPreferences({ outputType: 'text' })
    const wrapper = mount(ChatComposer, {
      props: {
        disabled: false,
        running: false,
        models: [modelInfo('text/model', ['text']), modelInfo('image/model', ['image'])],
        defaultModel: 'text/model',
        onSubmit: (input) => { void store.send(input) },
      },
      global: { plugins: [ElementPlus] },
    })

    await wrapper.get('[data-testid="output-type"]').setValue('image')
    await vi.waitFor(() => expect(api.chat.updateGenerationPreferences).toHaveBeenCalled())
    const savedPreferences = vi.mocked(api.chat.updateGenerationPreferences).mock.calls[0]?.[1]
    expect(isProxy(savedPreferences)).toBe(false)
    expect(isProxy(savedPreferences?.generation)).toBe(false)
    expect(isProxy(savedPreferences?.generation.image)).toBe(false)

    await wrapper.get('[data-testid="output-type"]').setValue('text')
    await wrapper.get('textarea').setValue('普通对象')
    await wrapper.get('form').trigger('submit')
    await vi.waitFor(() => expect(api.chat.send).toHaveBeenCalled())
    const sent = vi.mocked(api.chat.send).mock.calls[0]?.[0]
    expect(isProxy(sent)).toBe(false)
    expect(isProxy(sent?.generation)).toBe(false)
    expect(isProxy(sent?.generation.video)).toBe(false)
  })
})
