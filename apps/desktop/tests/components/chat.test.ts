import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { isProxy } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ElementPlus from 'element-plus'
import {
  appSettingsSchema,
  type ApprovalDecision,
  type BrowserActionAuditEntry,
  type ChatBlock,
  type ChatEvent,
  type ChatMessage,
  type ConversationSummary,
  type ConversationGenerationPreferences,
  type DesktopAPI,
  type ExecutionEvent,
  type MediaAsset,
  type ModelInfo,
} from '@autoforge/shared'
import ApprovalCard from '../../src/components/chat/ApprovalCard.vue'
import ChatComposer from '../../src/components/chat/ChatComposer.vue'
import MessageBlock from '../../src/components/chat/MessageBlock.vue'
import { displayError } from '../../src/services/desktop-api'
import { useChatStore } from '../../src/stores/chat'
import { useExecutionStore } from '../../src/stores/execution'
import { useSettingsStore } from '../../src/stores/settings'
import ChatView from '../../src/views/ChatView.vue'

const scopeHash = 'a'.repeat(64)
const buildHash = 'b'.repeat(64)

function workflowStatusBlock(
  status: Extract<ChatBlock, { type: 'workflow_status' }>['status'],
  overrides: Partial<Extract<ChatBlock, { type: 'workflow_status' }>> = {},
) {
  return {
    id: 'message_1:workflow_status_1',
    type: 'workflow_status' as const,
    blockId: 'workflow_status_1',
    executionId: 'execution_1',
    workflowId: 'workflow.beijing',
    workflowName: '北京工作居住证',
    workflowVersion: '1.0.0',
    source: 'development' as const,
    buildHash,
    city: '北京',
    status,
    executionAvailable: ['running', 'completed', 'interrupted'].includes(status),
    executionIndex: 1,
    executionLimit: 5,
    ...overrides,
  }
}

function browserStatusBlock(
  state: Extract<ChatBlock, { type: 'browser_status' }>['state'],
  overrides: Partial<Extract<ChatBlock, { type: 'browser_status' }>> = {},
) {
  return {
    id: 'message_1:browser_status_1',
    type: 'browser_status' as const,
    blockId: 'browser_status_1',
    requestId: 'request_1',
    bindingId: 'binding_1',
    siteLabel: '北京人才服务',
    origin: 'https://fw.bjrcgz.gov.cn',
    state,
    ...overrides,
  }
}

function workflowProvenanceBlock(
  entries: Extract<ChatBlock, { type: 'workflow_provenance' }>['entries'],
) {
  return {
    id: 'message_1:workflow_provenance_1',
    type: 'workflow_provenance' as const,
    blockId: 'workflow_provenance_1',
    entries,
  }
}

function approvalBlock(
  overrides: Partial<Extract<ChatBlock, { type: 'approval' }>> = {},
): Extract<ChatBlock, { type: 'approval' }> {
  return {
    type: 'approval',
    blockId: 'approval_1',
    state: 'pending',
    executionId: 'execution_1',
    workflowId: 'workflow.beijing',
    workflowName: '北京工作居住证',
    workflowVersion: '1.0.0',
    source: 'development',
    buildHash,
    city: '北京',
    actionSummary: '填写并点击提交',
    permissionIndex: 0,
    capability: 'browser.click',
    scope: { origins: ['https://example.com'] },
    scopeHash,
    ...overrides,
  }
}

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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function conversationSummary(id: string, lastActivityAt: string): ConversationSummary {
  return {
    id,
    title: id,
    titleState: 'user_named',
    revision: 1,
    syncState: 'synced',
    createdAt: lastActivityAt,
    lastActivityAt,
    metadataUpdatedAt: lastActivityAt,
  }
}

function storedMessage(id: string, conversationId: string, text: string): ChatMessage {
  return {
    id,
    conversationId,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    createdAt: '2026-07-20T00:00:00.000Z',
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
        video: { resolutions: ['720p'], aspectRatios: ['auto', '16:9'], durations: [5, 10], supportsAudio: true, frameImages: ['first_frame', 'last_frame'] },
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
    auth: {
      getSession: vi.fn().mockResolvedValue(null), sendOtp: vi.fn(), verifyOtp: vi.fn(),
      cancelOtp: vi.fn().mockResolvedValue(undefined), loginWithPassword: vi.fn(),
      logout: vi.fn().mockResolvedValue({ status: 'logged_out' }),
    },
    profile: {
      get: vi.fn().mockResolvedValue({ userId: 'user_1', account: 'Alice' }),
      update: vi.fn(),
      pickAndUploadAvatar: vi.fn().mockResolvedValue(null),
    },
    chat: {
      listConversations: vi.fn().mockResolvedValue({ items: [] }), createConversation: vi.fn(),
      listMessages: vi.fn().mockResolvedValue({ items: [] }),
      renameConversation: vi.fn(), deleteConversation: vi.fn(),
      retrySync: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue({ requestId: 'req_1' }), cancel: vi.fn(),
      takeOverBrowser: vi.fn().mockResolvedValue(undefined),
      listBrowserAudit: vi.fn().mockResolvedValue([]),
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
  return {
    api,
    decide,
    chatUnsubscribe,
    executionUnsubscribe,
    emitChat: (event: ChatEvent) => chatListener?.(event),
    queueChat: (event: ChatEvent) => {
      const queuedListener = chatListener
      return () => queuedListener?.(event)
    },
    emitExecution: (event: ExecutionEvent) => executionListener?.(event),
  }
}

describe('chat history pagination', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => Reflect.deleteProperty(window, 'autoForge'))

  it('prepends older cursor pages once and deduplicates messages by ID', async () => {
    const { api } = createEventApi()
    const newest = {
      id: 'message_newest', conversationId: 'conversation_1', role: 'assistant' as const,
      blocks: [{ type: 'text' as const, text: 'newest' }], createdAt: '2026-07-20T00:00:00.000Z',
    }
    const oldest = {
      id: 'message_oldest', conversationId: 'conversation_1', role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'oldest' }], createdAt: '2026-07-19T00:00:00.000Z',
    }
    vi.mocked(api.chat.listMessages)
      .mockResolvedValueOnce({ items: [newest], previousCursor: 'opaque-cursor-0001' })
      .mockResolvedValueOnce({ items: [oldest, newest] })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.selectedConversationId = 'conversation_1'

    await store.loadMessages('conversation_1')
    await Promise.all([
      store.loadOlderMessages('conversation_1'),
      store.loadOlderMessages('conversation_1'),
    ])

    expect(api.chat.listMessages).toHaveBeenNthCalledWith(1, {
      conversationId: 'conversation_1', limit: 100,
    })
    expect(api.chat.listMessages).toHaveBeenNthCalledWith(2, {
      conversationId: 'conversation_1', limit: 100, cursor: 'opaque-cursor-0001',
    })
    expect(api.chat.listMessages).toHaveBeenCalledTimes(2)
    expect(store.messagesByConversation.conversation_1?.map(({ id }) => id))
      .toEqual(['message_oldest', 'message_newest'])
    expect(store.previousMessageCursorByConversation.conversation_1).toBeUndefined()
  })

  it('does not let a stale page completion release the replacement request after reset', async () => {
    const { api } = createEventApi()
    const oldPage = deferred<{ items: [] }>()
    const newPage = deferred<{ items: [] }>()
    vi.mocked(api.chat.listConversations)
      .mockReturnValueOnce(oldPage.promise)
      .mockReturnValueOnce(newPage.promise)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()

    const oldRequest = store.loadConversations()
    store.resetLocalData()
    const newRequest = store.loadConversations()
    oldPage.resolve({ items: [] })
    await oldRequest

    await store.loadConversations()
    expect(api.chat.listConversations).toHaveBeenCalledTimes(2)

    newPage.resolve({ items: [] })
    await newRequest
    await store.loadConversations()
    expect(api.chat.listConversations).toHaveBeenCalledTimes(3)
  })

  it.each([
    {
      pageKind: 'initial' as const,
      liveWarning: '2026-07-20T00:00:00.000Z',
      snapshotWarning: undefined,
    },
    {
      pageKind: 'initial' as const,
      liveWarning: undefined,
      snapshotWarning: '2026-07-19T00:00:00.000Z',
    },
    {
      pageKind: 'paginated' as const,
      liveWarning: '2026-07-20T00:00:00.000Z',
      snapshotWarning: undefined,
    },
    {
      pageKind: 'paginated' as const,
      liveWarning: undefined,
      snapshotWarning: '2026-07-19T00:00:00.000Z',
    },
  ])('does not let a stale $pageKind warning snapshot overwrite a newer live state', async ({
    pageKind,
    liveWarning,
    snapshotWarning,
  }) => {
    const { api, emitChat } = createEventApi()
    const page = deferred<Awaited<ReturnType<DesktopAPI['chat']['listConversations']>>>()
    vi.mocked(api.chat.listConversations).mockReturnValue(page.promise)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.ensureSubscriptions()
    if (pageKind === 'paginated') store.nextConversationCursor = 'warning-page-cursor'

    const loading = pageKind === 'initial'
      ? store.loadConversations(false)
      : store.loadMoreConversations()
    emitChat({
      type: 'sync_warning_updated',
      ...(liveWarning === undefined ? {} : { warningSince: liveWarning }),
    })
    page.resolve({
      items: [],
      ...(snapshotWarning === undefined ? {} : { syncWarningSince: snapshotWarning }),
    })
    await loading

    expect(store.syncWarningSince).toBe(liveWarning)
  })

  it('clears and isolates warning state when an identity reset replaces the event subscription', async () => {
    const { api, chatUnsubscribe, emitChat } = createEventApi()
    const oldPage = deferred<Awaited<ReturnType<DesktopAPI['chat']['listConversations']>>>()
    vi.mocked(api.chat.listConversations).mockReturnValue(oldPage.promise)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    const loading = store.loadConversations(false)
    emitChat({
      type: 'sync_warning_updated', warningSince: '2026-07-19T00:00:00.000Z',
    })

    store.resetLocalData()
    expect(store.syncWarningSince).toBeUndefined()
    expect(chatUnsubscribe).toHaveBeenCalledOnce()
    store.ensureSubscriptions()
    emitChat({
      type: 'sync_warning_updated', warningSince: '2026-07-21T00:00:00.000Z',
    })
    oldPage.resolve({ items: [], syncWarningSince: '2026-07-19T00:00:00.000Z' })
    await loading

    expect(api.chat.onEvent).toHaveBeenCalledTimes(2)
    expect(store.syncWarningSince).toBe('2026-07-21T00:00:00.000Z')
  })

  it('preserves a newer off-page conversation event across an older initial page', async () => {
    const { api, emitChat } = createEventApi()
    const stalePage = deferred<Awaited<ReturnType<DesktopAPI['chat']['listConversations']>>>()
    vi.mocked(api.chat.listConversations).mockReturnValue(stalePage.promise)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    const loading = store.loadConversations(false)
    const liveConversation = {
      ...conversationSummary('live-off-page', '2026-07-21T00:00:00.000Z'),
      title: 'Live off-page update',
      revision: 2,
    }

    emitChat({
      type: 'conversation_updated',
      conversationId: liveConversation.id,
      conversation: liveConversation,
    })
    stalePage.resolve({
      items: [conversationSummary('stale-page-row', '2026-07-20T00:00:00.000Z')],
    })
    await loading

    expect(store.conversations).toEqual([
      liveConversation,
      conversationSummary('stale-page-row', '2026-07-20T00:00:00.000Z'),
    ])
  })

  it('does not let a stale paginated row overwrite a newer live conversation event', async () => {
    const { api, emitChat } = createEventApi()
    const stalePage = deferred<Awaited<ReturnType<DesktopAPI['chat']['listConversations']>>>()
    vi.mocked(api.chat.listConversations).mockReturnValue(stalePage.promise)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    const staleConversation = conversationSummary('page-row', '2026-07-19T00:00:00.000Z')
    const liveConversation = {
      ...staleConversation,
      title: 'Live title',
      revision: 3,
      lastActivityAt: '2026-07-22T00:00:00.000Z',
      metadataUpdatedAt: '2026-07-22T00:00:00.000Z',
    }
    store.conversations = [conversationSummary('current-row', '2026-07-20T00:00:00.000Z')]
    store.nextConversationCursor = 'stale-page-cursor'
    store.ensureSubscriptions()

    const loading = store.loadMoreConversations()
    emitChat({
      type: 'conversation_updated',
      conversationId: liveConversation.id,
      conversation: liveConversation,
    })
    stalePage.resolve({ items: [staleConversation] })
    await loading

    expect(store.conversations.find(({ id }) => id === liveConversation.id)).toEqual(liveConversation)
  })

  it('does not resurrect a removed conversation from an in-flight page', async () => {
    const { api, emitChat } = createEventApi()
    const stalePage = deferred<Awaited<ReturnType<DesktopAPI['chat']['listConversations']>>>()
    vi.mocked(api.chat.listConversations)
      .mockReturnValueOnce(stalePage.promise)
      .mockResolvedValueOnce({ items: [] })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    const removed = conversationSummary('removed-row', '2026-07-20T00:00:00.000Z')
    store.conversations = [removed]
    store.nextConversationCursor = 'removed-page-cursor'
    store.ensureSubscriptions()

    const loading = store.loadMoreConversations()
    emitChat({ type: 'conversation_removed', conversationId: removed.id })
    await vi.waitFor(() => expect(api.chat.listConversations).toHaveBeenCalledTimes(2))
    stalePage.resolve({ items: [removed] })
    await loading
    await flushPromises()

    expect(store.conversations.some(({ id }) => id === removed.id)).toBe(false)
  })

  it('does not carry conversation event overlays across an identity reset', async () => {
    const { api, emitChat } = createEventApi()
    const oldPage = deferred<Awaited<ReturnType<DesktopAPI['chat']['listConversations']>>>()
    const newPage = deferred<Awaited<ReturnType<DesktopAPI['chat']['listConversations']>>>()
    vi.mocked(api.chat.listConversations)
      .mockReturnValueOnce(oldPage.promise)
      .mockReturnValueOnce(newPage.promise)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    const oldLoading = store.loadConversations(false)
    emitChat({
      type: 'conversation_updated',
      conversationId: 'shared-row',
      conversation: {
        ...conversationSummary('shared-row', '2026-07-22T00:00:00.000Z'),
        title: 'Old identity live title',
        revision: 4,
      },
    })

    store.resetLocalData()
    const newLoading = store.loadConversations(false)
    const newIdentityRow = {
      ...conversationSummary('shared-row', '2026-07-20T00:00:00.000Z'),
      title: 'New identity snapshot',
    }
    newPage.resolve({ items: [newIdentityRow] })
    await newLoading
    oldPage.resolve({ items: [] })
    await oldLoading

    expect(store.conversations).toEqual([newIdentityRow])
  })

  it('does not merge an old identity conversation page that uses the new identity cursor', async () => {
    const { api } = createEventApi()
    const oldPage = deferred<{ items: ConversationSummary[]; nextCursor?: string }>()
    const newPage = deferred<{ items: ConversationSummary[]; nextCursor?: string }>()
    vi.mocked(api.chat.listConversations)
      .mockReturnValueOnce(oldPage.promise)
      .mockReturnValueOnce(newPage.promise)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    const sharedCursor = 'shared-non-empty-cursor'

    store.conversations = [conversationSummary('old-current', '2026-07-20T00:00:00.000Z')]
    store.nextConversationCursor = sharedCursor
    const oldRequest = store.loadMoreConversations()
    store.resetLocalData()
    store.conversations = [conversationSummary('new-current', '2026-07-21T00:00:00.000Z')]
    store.nextConversationCursor = sharedCursor
    const newRequest = store.loadMoreConversations()

    oldPage.resolve({
      items: [conversationSummary('old-stale-row', '2026-07-22T00:00:00.000Z')],
      nextCursor: 'old-next',
    })
    await oldRequest
    expect(store.conversations.map(({ id }) => id)).toEqual(['new-current'])
    expect(store.nextConversationCursor).toBe(sharedCursor)

    newPage.resolve({
      items: [conversationSummary('new-row', '2026-07-23T00:00:00.000Z')],
      nextCursor: 'new-next',
    })
    await newRequest
    expect(store.conversations.map(({ id }) => id)).toEqual(['new-row', 'new-current'])
    expect(store.nextConversationCursor).toBe('new-next')
  })

  it('does not surface an old identity conversation page rejection in the new identity', async () => {
    const { api } = createEventApi()
    const oldPage = deferred<{ items: ConversationSummary[] }>()
    const newPage = deferred<{ items: ConversationSummary[] }>()
    vi.mocked(api.chat.listConversations)
      .mockReturnValueOnce(oldPage.promise)
      .mockReturnValueOnce(newPage.promise)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    const sharedCursor = 'shared-non-empty-cursor'

    store.nextConversationCursor = sharedCursor
    const oldRequest = store.loadMoreConversations()
    store.resetLocalData()
    store.nextConversationCursor = sharedCursor
    const newRequest = store.loadMoreConversations()

    oldPage.reject(new Error('old user failed'))
    await oldRequest
    expect(store.error).toBe('')

    newPage.resolve({ items: [] })
    await newRequest
  })

  it('does not merge old identity messages that use the new identity older-page cursor', async () => {
    const { api } = createEventApi()
    const oldPage = deferred<{ items: ChatMessage[]; previousCursor?: string }>()
    const newPage = deferred<{ items: ChatMessage[]; previousCursor?: string }>()
    vi.mocked(api.chat.listMessages)
      .mockReturnValueOnce(oldPage.promise)
      .mockReturnValueOnce(newPage.promise)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    const conversationId = 'conversation_1'
    const sharedCursor = 'shared-non-empty-cursor'

    store.selectedConversationId = conversationId
    store.messagesByConversation[conversationId] = [{
      id: 'old-current', role: 'assistant',
      blocks: [{ id: 'old-current:text:0', type: 'text', text: 'old current' }],
    }]
    store.previousMessageCursorByConversation[conversationId] = sharedCursor
    const oldRequest = store.loadOlderMessages(conversationId)
    store.resetLocalData()
    store.selectedConversationId = conversationId
    store.messagesByConversation[conversationId] = [{
      id: 'new-current', role: 'assistant',
      blocks: [{ id: 'new-current:text:0', type: 'text', text: 'new current' }],
    }]
    store.previousMessageCursorByConversation[conversationId] = sharedCursor
    const newRequest = store.loadOlderMessages(conversationId)

    oldPage.resolve({
      items: [storedMessage('old-stale-row', conversationId, 'old stale')],
      previousCursor: 'old-next',
    })
    await oldRequest
    expect(store.messagesByConversation[conversationId]?.map(({ id }) => id)).toEqual(['new-current'])
    expect(store.previousMessageCursorByConversation[conversationId]).toBe(sharedCursor)

    newPage.resolve({
      items: [storedMessage('new-row', conversationId, 'new row')],
      previousCursor: 'new-next',
    })
    await newRequest
    expect(store.messagesByConversation[conversationId]?.map(({ id }) => id))
      .toEqual(['new-row', 'new-current'])
    expect(store.previousMessageCursorByConversation[conversationId]).toBe('new-next')
  })

  it('does not surface an old identity older-message rejection in the new identity', async () => {
    const { api } = createEventApi()
    const oldPage = deferred<{ items: ChatMessage[] }>()
    const newPage = deferred<{ items: ChatMessage[] }>()
    vi.mocked(api.chat.listMessages)
      .mockReturnValueOnce(oldPage.promise)
      .mockReturnValueOnce(newPage.promise)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    const conversationId = 'conversation_1'
    const sharedCursor = 'shared-non-empty-cursor'

    store.selectedConversationId = conversationId
    store.previousMessageCursorByConversation[conversationId] = sharedCursor
    const oldRequest = store.loadOlderMessages(conversationId)
    store.resetLocalData()
    store.selectedConversationId = conversationId
    store.previousMessageCursorByConversation[conversationId] = sharedCursor
    const newRequest = store.loadOlderMessages(conversationId)

    oldPage.reject(new Error('old user failed'))
    await oldRequest
    expect(store.error).toBe('')

    newPage.resolve({ items: [] })
    await newRequest
  })
})

function mountScrollableChat() {
  const { api, emitChat } = createEventApi()
  Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
  const chat = useChatStore()
  chat.conversations = [
    {
      id: 'conversation_1',
      title: '会话一',
      titleState: 'user_named',
      revision: 1,
      syncState: 'synced',
      createdAt: '2026-07-25T00:00:00.000Z',
      lastActivityAt: '2026-07-25T00:00:00.000Z',
      metadataUpdatedAt: '2026-07-25T00:00:00.000Z',
    },
    {
      id: 'conversation_2',
      title: '会话二',
      titleState: 'user_named',
      revision: 1,
      syncState: 'synced',
      createdAt: '2026-07-25T00:00:00.000Z',
      lastActivityAt: '2026-07-25T00:00:00.000Z',
      metadataUpdatedAt: '2026-07-25T00:00:00.000Z',
    },
  ]
  chat.selectedConversationId = 'conversation_1'
  chat.preferencesByConversation.conversation_1 = generationPreferences({
    outputType: 'text',
    models: { text: 'text/default' },
  })
  chat.preferencesByConversation.conversation_2 = generationPreferences({
    outputType: 'text',
    models: { text: 'text/default' },
  })
  const settings = useSettingsStore()
  settings.settings = {
    theme: 'system',
    language: 'zh-CN',
    dataDirectory: '/data',
    logDirectory: '/logs',
    activeProvider: 'openrouter',
    defaultModels: {
      deepseek: { text: 'deepseek-chat' },
      openrouter: { text: 'text/default' },
    },
    showCosts: false,
    developerMode: false,
    permissionDefault: 'ask',
    proxy: { enabled: false, bypassDomains: [] },
  }
  expect(() => appSettingsSchema.parse(settings.settings)).not.toThrow()
  settings.providerModels.openrouter = [modelInfo('text/default', ['text'])]
  const wrapper = mount(ChatView, { global: { plugins: [ElementPlus] } })
  const messages = wrapper.get('.messages').element as HTMLElement
  Object.defineProperty(messages, 'scrollHeight', { configurable: true, value: 900 })
  Object.defineProperty(messages, 'clientHeight', { configurable: true, value: 400 })
  return { chat, emitChat, messages, wrapper }
}

describe('chat interactions', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => {
    vi.useRealTimers()
    Reflect.deleteProperty(window, 'autoForge')
  })

  it('renders each message creation time outside the message surface', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 24, 16, 0))
    const { chat, wrapper } = mountScrollableChat()
    chat.messagesByConversation.conversation_1 = [
      {
        id: 'user_1',
        role: 'user',
        blocks: [{ id: 'user_1:text:0', type: 'text', text: '今天的消息' }],
        createdAt: new Date(2026, 7, 24, 14, 32).toISOString(),
      },
      {
        id: 'assistant_1',
        role: 'assistant',
        blocks: [{ id: 'assistant_1:text:0', type: 'text', text: '昨天的回复' }],
        createdAt: new Date(2026, 7, 23, 9, 5).toISOString(),
      },
    ]
    await wrapper.vm.$nextTick()

    const messages = wrapper.findAll('article.message')
    expect(messages).toHaveLength(2)
    const userSurface = messages[0]!.get('.message-surface')
    expect(userSurface.classes()).toContain('message-bubble')
    expect(userSurface.find('.message-header').exists()).toBe(false)
    expect(messages[0]!.get('.message-meta').text()).toContain('你')
    expect(messages[0]!.get('time').text()).toBe('14:32')
    expect(messages[0]!.get('time').attributes('title')).toBe('2026年8月24日 14:32')
    const assistantSurface = messages[1]!.get('.message-surface')
    expect(assistantSurface.classes()).toContain('message-response')
    expect(assistantSurface.find('.message-header').exists()).toBe(false)
    expect(messages[1]!.get('.message-meta').text()).toContain('AutoForge')
    expect(messages[1]!.get('time').text()).toBe('8月23日 09:05')
  })

  it('uses the app logo for assistant identity', async () => {
    const { chat, wrapper } = mountScrollableChat()
    chat.messagesByConversation.conversation_1 = [{
      id: 'assistant_1',
      role: 'assistant',
      blocks: [{ id: 'assistant_1:text:0', type: 'text', text: '助手回复' }],
      createdAt: '2026-08-24T06:32:00.000Z',
    }]
    chat.awaitingResponseByConversation.conversation_1 = true
    await wrapper.vm.$nextTick()

    const avatars = wrapper.findAll('[data-testid="assistant-avatar"]')
    expect(avatars).toHaveLength(2)
    for (const avatar of avatars) {
      expect(avatar.element.tagName).toBe('IMG')
      expect(avatar.attributes('src')).toContain('autoforge-logo.png')
      expect(avatar.attributes('alt')).toBe('')
    }
  })

  it('keeps the persisted message creation time in renderer state', async () => {
    const { api } = createEventApi()
    vi.mocked(api.chat.listMessages).mockResolvedValue([{
      id: 'assistant_1',
      conversationId: 'conversation_1',
      role: 'assistant',
      blocks: [{ type: 'text', text: '已持久化回复' }],
      createdAt: '2026-08-24T06:32:00.000Z',
    }])
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const chat = useChatStore()

    await chat.selectConversation('conversation_1')

    expect(chat.messagesByConversation.conversation_1?.[0]?.createdAt)
      .toBe('2026-08-24T06:32:00.000Z')
  })

  it('timestamps optimistic user messages and first streamed assistant blocks', async () => {
    vi.useFakeTimers()
    const { api, emitChat } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const chat = useChatStore()
    chat.selectedConversationId = 'conversation_1'
    chat.ensureSubscriptions()
    vi.setSystemTime(new Date('2026-08-24T06:32:00.000Z'))

    await chat.send({
      content: '本地消息',
      assetIds: [],
      outputType: 'text',
      model: 'text/default',
      generation: generationPreferences().generation,
    })

    expect(chat.messagesByConversation.conversation_1?.[0]?.createdAt)
      .toBe('2026-08-24T06:32:00.000Z')

    vi.setSystemTime(new Date('2026-08-24T06:32:05.000Z'))
    emitChat({
      type: 'block',
      conversationId: 'conversation_1',
      messageId: 'assistant_1',
      block: { type: 'text', text: '流式回复' },
    })

    expect(chat.messagesByConversation.conversation_1?.[1]?.createdAt)
      .toBe('2026-08-24T06:32:05.000Z')
  })

  it('passes the exact selected output default to the composer while auto continues to prefer text', async () => {
    const { api } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const chat = useChatStore()
    chat.conversations = [{
      id: 'conversation_1',
      title: '会话',
      titleState: 'user_named',
      revision: 1,
      syncState: 'synced',
      createdAt: '2026-07-25T00:00:00.000Z',
      lastActivityAt: '2026-07-25T00:00:00.000Z',
      metadataUpdatedAt: '2026-07-25T00:00:00.000Z',
    }]
    chat.selectedConversationId = 'conversation_1'
    chat.preferencesByConversation.conversation_1 = generationPreferences({ outputType: 'image' })
    const settings = useSettingsStore()
    settings.settings = {
      theme: 'system',
      language: 'zh-CN',
      dataDirectory: '/data',
      logDirectory: '/logs',
      activeProvider: 'openrouter',
      defaultModels: {
        deepseek: { text: 'deepseek-chat' },
        openrouter: { text: 'text/default', image: 'image/default' },
      },
      showCosts: false,
      developerMode: false,
      permissionDefault: 'ask',
      proxy: { enabled: false, bypassDomains: [] },
    }
    expect(() => appSettingsSchema.parse(settings.settings)).not.toThrow()
    settings.providerModels.openrouter = [
      modelInfo('text/default', ['text']),
      modelInfo('image/default', ['image']),
      modelInfo('audio/catalog-first', ['audio']),
    ]
    const wrapper = mount(ChatView, { global: { plugins: [ElementPlus] } })

    expect(wrapper.getComponent(ChatComposer).props('defaultModel')).toBe('image/default')
    chat.preferencesByConversation.conversation_1 = generationPreferences({ outputType: 'audio' })
    await wrapper.vm.$nextTick()
    expect(wrapper.getComponent(ChatComposer).props('defaultModel')).toBe('')
    chat.preferencesByConversation.conversation_1 = generationPreferences({ outputType: 'auto' })
    await wrapper.vm.$nextTick()
    expect(wrapper.getComponent(ChatComposer).props('defaultModel')).toBe('text/default')
  })

  it('scrolls to the latest local and incoming chat content after rendering', async () => {
    const { api, emitChat } = createEventApi()
    let resolveSend!: (value: { requestId: string }) => void
    vi.mocked(api.chat.send).mockReturnValue(new Promise((resolve) => { resolveSend = resolve }))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const chat = useChatStore()
    chat.conversations = [{
      id: 'conversation_1',
      title: '会话',
      titleState: 'user_named',
      revision: 1,
      syncState: 'synced',
      createdAt: '2026-07-25T00:00:00.000Z',
      lastActivityAt: '2026-07-25T00:00:00.000Z',
      metadataUpdatedAt: '2026-07-25T00:00:00.000Z',
    }]
    chat.selectedConversationId = 'conversation_1'
    chat.preferencesByConversation.conversation_1 = generationPreferences({
      outputType: 'text',
      models: { text: 'text/default' },
    })
    const settings = useSettingsStore()
    settings.settings = {
      theme: 'system',
      language: 'zh-CN',
      dataDirectory: '/data',
      logDirectory: '/logs',
      activeProvider: 'openrouter',
      defaultModels: {
        deepseek: { text: 'deepseek-chat' },
        openrouter: { text: 'text/default' },
      },
      showCosts: false,
      developerMode: false,
      permissionDefault: 'ask',
      proxy: { enabled: false, bypassDomains: [] },
    }
    expect(() => appSettingsSchema.parse(settings.settings)).not.toThrow()
    settings.providerModels.openrouter = [modelInfo('text/default', ['text'])]
    const wrapper = mount(ChatView, { global: { plugins: [ElementPlus] } })
    const messages = wrapper.get('.messages').element as HTMLElement
    Object.defineProperty(messages, 'scrollHeight', { configurable: true, value: 900 })

    messages.scrollTop = 0
    const sending = chat.send({
      content: '本地消息',
      assetIds: [],
      outputType: 'text',
      generation: generationPreferences().generation,
      model: 'text/default',
    })
    await vi.waitFor(() => {
      const loader = wrapper.get('[data-testid="response-loader"]')
      expect(loader.get('.message-role').text()).toBe('AutoForge')
      expect(loader.text()).toContain('正在生成回复…')
      expect(loader.find('.is-loading').exists()).toBe(true)
      expect(messages.scrollTop).toBe(900)
    })

    messages.scrollTop = 0
    emitChat({
      type: 'block',
      conversationId: 'conversation_1',
      messageId: 'assistant_1',
      block: { type: 'text', text: '第一段' },
    })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="response-loader"]').exists()).toBe(false)
      expect(wrapper.text()).toContain('第一段')
      expect(messages.scrollTop).toBe(900)
    })

    messages.scrollTop = 0
    emitChat({
      type: 'block',
      conversationId: 'conversation_1',
      messageId: 'assistant_1',
      block: { type: 'text', text: '第二段' },
    })
    await vi.waitFor(() => expect(messages.scrollTop).toBe(900))

    resolveSend({ requestId: 'req_stream' })
    await sending
  })

  it('preserves manual scroll during AI updates and resumes within 20px of bottom', async () => {
    const { emitChat, messages, wrapper } = mountScrollableChat()
    const emitText = (text: string) => emitChat({
      type: 'block',
      conversationId: 'conversation_1',
      messageId: 'assistant_1',
      block: { type: 'text', text },
    })

    messages.scrollTop = 400
    await wrapper.get('.messages').trigger('scroll')
    emitText('第一段')
    await vi.waitFor(() => expect(wrapper.text()).toContain('第一段'))
    expect(messages.scrollTop).toBe(400)

    emitText('第二段')
    await vi.waitFor(() => expect(wrapper.text()).toContain('第一段第二段'))
    expect(messages.scrollTop).toBe(400)

    messages.scrollTop = 480
    await wrapper.get('.messages').trigger('scroll')
    emitText('第三段')
    await vi.waitFor(() => expect(messages.scrollTop).toBe(900))

    messages.scrollTop = 481
    await wrapper.get('.messages').trigger('scroll')
    emitText('第四段')
    await vi.waitFor(() => expect(messages.scrollTop).toBe(900))
  })

  it('forces the latest position after a local submit or conversation switch', async () => {
    const { chat, messages, wrapper } = mountScrollableChat()
    const acknowledge = vi.fn()

    messages.scrollTop = 400
    await wrapper.get('.messages').trigger('scroll')
    wrapper.getComponent(ChatComposer).vm.$emit('submit', {
      content: '主动发送',
      assetIds: [],
      outputType: 'text',
      generation: generationPreferences().generation,
      model: 'text/default',
    }, acknowledge)
    await vi.waitFor(() => {
      expect(messages.scrollTop).toBe(900)
      expect(acknowledge).toHaveBeenCalledWith(true)
    })

    messages.scrollTop = 400
    await wrapper.get('.messages').trigger('scroll')
    chat.selectedConversationId = 'conversation_2'
    await vi.waitFor(() => expect(messages.scrollTop).toBe(900))
  })

  it('renders common Markdown as semantic chat content', () => {
    const wrapper = mount(MessageBlock, {
      props: { block: {
        id: 'message_1:block_text',
        type: 'text',
        text: '# 标题\n\n**重点**\n\n- 第一项\n- 第二项\n\n使用 `pnpm test`',
      } },
      global: { plugins: [ElementPlus] },
    })

    expect(wrapper.get('h1').text()).toBe('标题')
    expect(wrapper.get('strong').text()).toBe('重点')
    expect(wrapper.findAll('li').map((item) => item.text())).toEqual(['第一项', '第二项'])
    expect(wrapper.get('p code').text()).toBe('pnpm test')
  })

  it('escapes raw HTML instead of creating live chat elements', () => {
    const wrapper = mount(MessageBlock, {
      props: { block: {
        id: 'message_1:block_text',
        type: 'text',
        text: '<script>window.compromised = true</script>\n\n<img src=x onerror="window.compromised = true">',
      } },
      global: { plugins: [ElementPlus] },
    })

    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toContain('<script>window.compromised = true</script>')
    expect(wrapper.text()).toContain('<img src=x onerror="window.compromised = true">')
  })

  it('renders an unknown fenced language as escaped plain code', () => {
    const wrapper = mount(MessageBlock, {
      props: { block: {
        id: 'message_1:block_text',
        type: 'text',
        text: '```unknownlang\n<unsafe>& value\n```',
      } },
      global: { plugins: [ElementPlus] },
    })

    const code = wrapper.get('pre code')
    expect(code.classes()).toContain('language-unknownlang')
    expect(code.element.textContent).toBe('<unsafe>& value\n')
    expect(code.find('unsafe').exists()).toBe(false)
  })

  it('renders and highlights a fenced TypeScript code block', () => {
    const source = [
      '```ts',
      '// singleton.ts',
      'class MyService {',
      '  public doWork(): void {',
      '    console.log("Working...");',
      '  }',
      '}',
      'export const myService = new MyService();',
      '```',
    ].join('\n')
    const wrapper = mount(MessageBlock, {
      props: { block: {
        id: 'message_1:block_text',
        type: 'text',
        text: source,
      } },
      global: { plugins: [ElementPlus] },
    })

    const code = wrapper.get('pre code')
    expect(code.classes()).toContain('hljs')
    expect(code.classes()).toContain('language-ts')
    expect(code.find('.hljs-keyword').exists()).toBe(true)
    expect(code.element.textContent).toContain('  public doWork(): void {')
    expect(code.element.textContent).toContain('    console.log("Working...");')
    expect(wrapper.text()).not.toContain('```ts')
  })

  it.each([
    ['queued', '准备中', 'neutral'],
    ['awaiting_approval', '等待授权', 'warning'],
    ['running', '进行中', 'active'],
    ['completed', '已完成', 'success'],
    ['failed', '未完成', 'danger'],
    ['cancelled', '已取消', 'neutral'],
    ['interrupted', '已中断', 'warning'],
  ] as const)('renders the authoritative %s workflow state', async (status, label, tone) => {
    const wrapper = mount(MessageBlock, {
      props: { block: workflowStatusBlock(status) },
      global: { plugins: [ElementPlus] },
    })

    const card = wrapper.get('[data-testid="workflow-status"]')
    expect(card.classes()).toContain('af-operation-card')
    expect(card.classes()).toContain(`tone-${tone}`)
    expect(card.get('[data-testid="workflow-status-badge"]').text()).toBe(label)
    expect(card.get('.af-operation-title strong').text()).toBe('北京工作居住证')
    if (status === 'completed') await card.get('[data-testid="toggle-workflow-details"]').trigger('click')
    expect(card.findAll('.af-operation-chip').map((chip) => chip.text()))
      .toEqual(['北京', 'v1.0.0', '开发版本'])
    expect(card.text()).toContain('第 1 次调用 · 上限 5 次')
  })

  it('collapses completed workflow details until the user expands them', async () => {
    const wrapper = mount(MessageBlock, {
      props: { block: workflowStatusBlock('completed') },
      global: { plugins: [ElementPlus] },
    })

    const card = wrapper.get('[data-testid="workflow-status"]')
    const toggle = card.get('[data-testid="toggle-workflow-details"]')
    expect(card.classes()).toContain('is-collapsed')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(card.find('[data-testid="workflow-status-content"]').exists()).toBe(false)

    await toggle.trigger('click')

    expect(card.classes()).not.toContain('is-collapsed')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(card.get('[data-testid="workflow-status-content"]').isVisible()).toBe(true)
  })

  it('keeps a failed workflow expanded so the reason remains visible', () => {
    const wrapper = mount(MessageBlock, {
      props: { block: workflowStatusBlock('failed', { errorSummary: '执行任务时连接中断' }) },
      global: { plugins: [ElementPlus] },
    })

    const card = wrapper.get('[data-testid="workflow-status"]')
    expect(card.classes()).not.toContain('is-collapsed')
    expect(card.get('[data-testid="toggle-workflow-details"]').attributes('aria-expanded')).toBe('true')
    expect(card.get('[data-testid="workflow-status-message"]').text()).toBe('执行任务时连接中断')
  })

  it('collapses workflow details when a live run reaches completed state', async () => {
    const wrapper = mount(MessageBlock, {
      props: { block: workflowStatusBlock('running') },
      global: { plugins: [ElementPlus] },
    })

    expect(wrapper.find('[data-testid="workflow-status-content"]').exists()).toBe(true)

    await wrapper.setProps({ block: workflowStatusBlock('completed') })

    expect(wrapper.get('[data-testid="workflow-status"]').classes()).toContain('is-collapsed')
    expect(wrapper.find('[data-testid="workflow-status-content"]').exists()).toBe(false)
  })

  it('uses a neutral progress marker for a cancelled workflow', () => {
    const wrapper = mount(MessageBlock, {
      props: { block: workflowStatusBlock('cancelled') },
      global: { plugins: [ElementPlus] },
    })

    const card = wrapper.get('[data-testid="workflow-status"]')
    expect(card.find('.workflow-progress-step.is-cancelled').exists()).toBe(true)
    expect(card.find('.workflow-progress-step.is-interrupted').exists()).toBe(false)
  })

  it('links each workflow disclosure button to its own details region', () => {
    const first = mount(MessageBlock, {
      props: { block: workflowStatusBlock('running', { blockId: 'workflow_status_1' }) },
      global: { plugins: [ElementPlus] },
    })
    const second = mount(MessageBlock, {
      props: { block: workflowStatusBlock('running', { blockId: 'workflow_status_2' }) },
      global: { plugins: [ElementPlus] },
    })

    const firstTarget = first.get('[data-testid="toggle-workflow-details"]').attributes('aria-controls')
    const secondTarget = second.get('[data-testid="toggle-workflow-details"]').attributes('aria-controls')
    expect(first.get('[data-testid="workflow-status-content"]').attributes('id')).toBe(firstTarget)
    expect(second.get('[data-testid="workflow-status-content"]').attributes('id')).toBe(secondTarget)
    expect(firstTarget).not.toBe(secondTarget)
  })

  it('presents a running workflow as a four-stage progress rail', () => {
    const wrapper = mount(MessageBlock, {
      props: { block: workflowStatusBlock('running') },
      global: { plugins: [ElementPlus] },
    })

    const progress = wrapper.get('[data-testid="workflow-progress"]')
    const steps = progress.findAll('.workflow-progress-step')
    expect(steps.map((step) => step.text())).toEqual(['匹配工作流', '检查授权', '执行任务', '返回结果'])
    expect(steps[0]!.classes()).toContain('is-complete')
    expect(steps[1]!.classes()).toContain('is-complete')
    expect(steps[2]!.classes()).toContain('is-current')
    expect(steps[3]!.classes()).toContain('is-pending')
  })

  it('keeps workflow failure emphasis on the failed stage and compact alert only', () => {
    const wrapper = mount(MessageBlock, {
      props: { block: workflowStatusBlock('failed', { errorSummary: '执行任务时连接中断' }) },
      global: { plugins: [ElementPlus] },
    })

    const card = wrapper.get('[data-testid="workflow-status"]')
    expect(card.find('.af-operation-icon').exists()).toBe(false)
    expect(card.get('.af-operation-marker').classes()).toContain('tone-danger')
    expect(card.findAll('.workflow-progress-step')[2]!.classes()).toContain('is-failed')
    expect(card.get('[data-testid="workflow-status-message"]').classes()).toContain('af-operation-alert')
  })

  it('renders unrestricted workflow status and opens its execution with the existing execution store', async () => {
    const { api } = createEventApi()
    vi.mocked(api.executions.get).mockResolvedValue({
      id: 'execution_1', workflowId: 'workflow.beijing', workflowVersion: '1.0.0', status: 'completed',
      createdAt: '2026-08-22T00:00:00.000Z', input: {}, output: { ok: true }, steps: [], logs: [],
    })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const wrapper = mount(MessageBlock, {
      props: { block: workflowStatusBlock('running', { city: undefined }) },
      global: { plugins: [ElementPlus] },
    })

    expect(wrapper.text()).toContain('不限城市')
    await wrapper.get('[data-testid="open-workflow-execution"]').trigger('click')
    await flushPromises()
    expect(api.executions.get).toHaveBeenCalledWith('execution_1')
    expect(useExecutionStore().selectedId).toBe('execution_1')
    expect(useExecutionStore().selectedDetail).toMatchObject({ id: 'execution_1', status: 'completed' })
    expect(useExecutionStore().selectedDetailError).toBe('')
  })

  it.each([
    ['permission denial', 'cancelled', 'PERMISSION_DENIED', 'The requested permission was denied.'],
    ['approval expiry', 'cancelled', 'CANCELLED', 'The operation was cancelled.'],
    ['pre-start change', 'failed', 'WORKFLOW_CHANGED', 'The workflow changed before it could run. Review and try again.'],
  ] as const)('hides execution navigation for reservation-only %s without exposing NOT_FOUND', async (
    _case,
    status,
    errorCode,
    errorSummary,
  ) => {
    const { api } = createEventApi()
    vi.mocked(api.executions.get).mockRejectedValue(Object.assign(new Error('not found'), { code: 'NOT_FOUND' }))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const wrapper = mount(MessageBlock, {
      props: { block: workflowStatusBlock(status, { executionAvailable: false, errorCode, errorSummary }) },
      global: { plugins: [ElementPlus] },
    })

    expect(wrapper.get('[data-testid="workflow-status-message"]').text()).toBe(errorSummary)
    expect(wrapper.find('[data-testid="open-workflow-execution"]').exists()).toBe(false)
    expect(api.executions.get).not.toHaveBeenCalled()
    expect(useExecutionStore().selectedDetailError).toBe('')
  })

  it('shows the safe failure summary for a started invalid-output execution', () => {
    const wrapper = mount(MessageBlock, {
      props: { block: workflowStatusBlock('failed', {
        executionAvailable: true,
        errorCode: 'INVALID_OUTPUT',
        errorSummary: 'The workflow produced an invalid result.',
      }) },
      global: { plugins: [ElementPlus] },
    })

    expect(wrapper.get('[data-testid="workflow-status-message"]').text())
      .toBe('The workflow produced an invalid result.')
    expect(wrapper.find('[data-testid="open-workflow-execution"]').exists()).toBe(true)
  })

  it('localizes a capability scope failure without exposing the internal English summary', () => {
    const wrapper = mount(MessageBlock, {
      props: { block: workflowStatusBlock('failed', {
        executionAvailable: true,
        errorCode: 'CAPABILITY_SCOPE_DENIED',
        errorSummary: 'The requested capability scope is not allowed.',
      }) },
      global: { plugins: [ElementPlus] },
    })

    expect(wrapper.get('[data-testid="workflow-status-message"]').text())
      .toBe('工作流尝试访问未授权的网站，请检查工作流权限并重新构建')
    expect(wrapper.text()).not.toContain('The requested capability scope is not allowed.')
  })

  it('shows the authoritative oversized-result notice without changing completed status', () => {
    const wrapper = mount(MessageBlock, {
      props: {
        block: workflowStatusBlock('completed', {
          errorCode: 'RESULT_TOO_LARGE',
          errorSummary: 'The workflow result is too large.',
        }),
      },
      global: { plugins: [ElementPlus] },
    })

    expect(wrapper.get('[data-testid="workflow-status-badge"]').text()).toBe('已完成')
    expect(wrapper.text()).toContain('北京工作居住证')
    expect(wrapper.get('[data-testid="workflow-status-message"]').text())
      .toBe('执行完成，结果未提供给模型')
  })

  it('renders the Main-owned browser status and exposes exact stop and takeover actions', async () => {
    const { api } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const wrapper = mount(MessageBlock, {
      props: { block: browserStatusBlock('acting', { actionSummary: '填写单位信息' }) },
      global: { plugins: [ElementPlus] },
    })

    const status = wrapper.get('[data-testid="browser-status"]')
    expect(status.attributes('aria-live')).toBe('polite')
    expect(status.find('.af-operation-icon').exists()).toBe(false)
    expect(status.get('.af-operation-marker').exists()).toBe(true)
    expect(status.text()).toContain('北京人才服务')
    expect(status.text()).toContain('fw.bjrcgz.gov.cn')
    expect(wrapper.get('[data-testid="browser-action-summary"]').text()).toBe('填写单位信息')
    const stop = wrapper.get('[data-testid="stop-browser"]')
    const takeover = wrapper.get('[data-testid="take-over-browser"]')
    expect(stop.element.tagName).toBe('BUTTON')
    expect(takeover.element.tagName).toBe('BUTTON')
    expect((stop.element as HTMLButtonElement).tabIndex).toBeGreaterThanOrEqual(0)
    expect((takeover.element as HTMLButtonElement).tabIndex).toBeGreaterThanOrEqual(0)

    await takeover.trigger('click')
    await flushPromises()
    expect(api.chat.takeOverBrowser).toHaveBeenCalledWith({
      requestId: 'request_1', bindingId: 'binding_1',
    })
    expect((takeover.element as HTMLButtonElement).disabled).toBe(true)

    const stopWrapper = mount(MessageBlock, {
      props: { block: browserStatusBlock('acting') },
      global: { plugins: [ElementPlus] },
    })
    await stopWrapper.get('[data-testid="stop-browser"]').trigger('click')
    await flushPromises()
    expect(api.chat.cancel).toHaveBeenCalledWith('request_1')
  })

  it('loads chronological redacted browser audit only after explicit expansion', async () => {
    const { api } = createEventApi()
    vi.mocked(api.chat.listBrowserAudit).mockResolvedValue([
      {
        id: 'audit_2', bindingId: 'binding_1', sequence: 2,
        origin: 'https://fw.bjrcgz.gov.cn', action: '点击下一步', targetSummary: '下一步按钮',
        risk: 'external_action', outcome: 'blocked', errorCode: 'MANUAL_ACTION_REQUIRED', createdAt: 2,
      },
      {
        id: 'audit_1', bindingId: 'binding_1', sequence: 1,
        origin: 'https://fw.bjrcgz.gov.cn', action: '<img src=x>填写单位信息',
        targetSummary: '页面原文：机密内容；值：Secret-Value',
        risk: 'external_action', outcome: 'completed', createdAt: 1,
      },
    ])
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const wrapper = mount(MessageBlock, {
      props: { block: browserStatusBlock('acting') },
      global: { plugins: [ElementPlus] },
    })

    expect(api.chat.listBrowserAudit).not.toHaveBeenCalled()
    const details = wrapper.get('[data-testid="browser-audit"]')
    ;(details.element as HTMLDetailsElement).open = true
    await details.trigger('toggle')
    await flushPromises()

    expect(api.chat.listBrowserAudit).toHaveBeenCalledWith('binding_1')
    const entries = wrapper.findAll('[data-testid="browser-audit-entry"]')
    expect(entries).toHaveLength(2)
    expect(entries[0]!.text()).toContain('<img src=x>填写单位信息')
    expect(entries[0]!.find('img').exists()).toBe(false)
    expect(entries[0]!.text()).toContain('fw.bjrcgz.gov.cn')
    expect(entries[0]!.text()).toContain('已完成')
    expect(entries[1]!.text()).toContain('需要你在页面中手动确认')
    expect(wrapper.text()).not.toContain('Secret-Value')
    expect(wrapper.text()).not.toContain('页面原文')
  })

  it('discards an old audit resolution without clearing or replacing the new identity load', async () => {
    const { api } = createEventApi()
    const oldAudit = deferred<BrowserActionAuditEntry[]>()
    const newAudit = deferred<BrowserActionAuditEntry[]>()
    vi.mocked(api.chat.listBrowserAudit)
      .mockReturnValueOnce(oldAudit.promise)
      .mockReturnValueOnce(newAudit.promise)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const wrapper = mount(MessageBlock, {
      props: { block: browserStatusBlock('acting') },
      global: { plugins: [ElementPlus] },
    })
    const details = wrapper.get('[data-testid="browser-audit"]')
    ;(details.element as HTMLDetailsElement).open = true
    await details.trigger('toggle')
    await wrapper.setProps({
      block: browserStatusBlock('acting', { requestId: 'request_2', bindingId: 'binding_2' }),
    })
    await details.trigger('toggle')
    expect(api.chat.listBrowserAudit).toHaveBeenNthCalledWith(1, 'binding_1')
    expect(api.chat.listBrowserAudit).toHaveBeenNthCalledWith(2, 'binding_2')

    oldAudit.resolve([{
      id: 'old_audit', bindingId: 'binding_1', sequence: 1,
      origin: 'https://old.example.cn', action: '旧请求操作', targetSummary: '旧目标',
      risk: 'sensitive_read', outcome: 'completed', createdAt: 1,
    }])
    await flushPromises()
    expect(wrapper.text()).toContain('正在加载操作记录…')
    expect(wrapper.text()).not.toContain('旧请求操作')

    newAudit.resolve([{
      id: 'new_audit', bindingId: 'binding_2', sequence: 1,
      origin: 'https://new.example.cn', action: '新请求操作', targetSummary: '新目标',
      risk: 'safe_navigation', outcome: 'completed', createdAt: 2,
    }])
    await flushPromises()
    expect(wrapper.text()).toContain('新请求操作')
    expect(wrapper.text()).not.toContain('旧请求操作')
  })

  it('does not let an old takeover success settle a replacement action', async () => {
    const { api } = createEventApi()
    const oldTakeover = deferred<void>()
    const newTakeover = deferred<void>()
    vi.mocked(api.chat.takeOverBrowser)
      .mockReturnValueOnce(oldTakeover.promise)
      .mockReturnValueOnce(newTakeover.promise)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const wrapper = mount(MessageBlock, {
      props: { block: browserStatusBlock('acting') },
      global: { plugins: [ElementPlus] },
    })
    await wrapper.get('[data-testid="take-over-browser"]').trigger('click')
    await wrapper.setProps({
      block: browserStatusBlock('acting', { requestId: 'request_2', bindingId: 'binding_2' }),
    })
    await wrapper.get('[data-testid="take-over-browser"]').trigger('click')
    oldTakeover.resolve()
    await flushPromises()
    expect(api.chat.takeOverBrowser).toHaveBeenNthCalledWith(2, {
      requestId: 'request_2', bindingId: 'binding_2',
    })

    newTakeover.reject({ code: 'PAGE_CHANGED', message: 'replacement failed safely' })
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe('页面已变化，请重新检查后继续')
    expect((wrapper.get('[data-testid="take-over-browser"]').element as HTMLButtonElement).disabled)
      .toBe(false)
  })

  it('does not let an old cancel failure clear or overwrite a replacement action', async () => {
    const { api } = createEventApi()
    const oldCancel = deferred<void>()
    const newCancel = deferred<void>()
    vi.mocked(api.chat.cancel)
      .mockReturnValueOnce(oldCancel.promise)
      .mockReturnValueOnce(newCancel.promise)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const wrapper = mount(MessageBlock, {
      props: { block: browserStatusBlock('acting') },
      global: { plugins: [ElementPlus] },
    })
    await wrapper.get('[data-testid="stop-browser"]').trigger('click')
    await wrapper.setProps({
      block: browserStatusBlock('acting', { requestId: 'request_2', bindingId: 'binding_2' }),
    })
    await wrapper.get('[data-testid="stop-browser"]').trigger('click')
    oldCancel.reject({ code: 'PAGE_CHANGED', message: 'old request failed' })
    await flushPromises()

    expect(api.chat.cancel).toHaveBeenNthCalledWith(2, 'request_2')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect((wrapper.get('[data-testid="stop-browser"]').element as HTMLButtonElement).disabled)
      .toBe(true)
    newCancel.resolve()
    await flushPromises()
    expect((wrapper.get('[data-testid="stop-browser"]').element as HTMLButtonElement).disabled)
      .toBe(true)
  })

  it('keeps Stop available while login waiting already gives the user page control', async () => {
    const { api } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const wrapper = mount(MessageBlock, {
      props: { block: browserStatusBlock('awaiting_user', {
        errorCode: 'AUTH_REQUIRED',
        actionSummary: '网页尚未登录，请在已打开页面完成登录。登录后将自动继续，无需再次提问。',
      }) },
      global: { plugins: [ElementPlus] },
    })

    expect(wrapper.get('[data-testid="browser-status"]').text()).toContain('等待你登录')
    expect(wrapper.find('[data-testid="take-over-browser"]').exists()).toBe(false)
    const stop = wrapper.get('[data-testid="stop-browser"]')
    expect((stop.element as HTMLButtonElement).disabled).toBe(false)

    await stop.trigger('click')
    await flushPromises()
    expect(api.chat.cancel).toHaveBeenCalledWith('request_1')
  })

  it.each([
    'MANUAL_ACTION_REQUIRED',
    'UNSUPPORTED_CONTROL',
    'MANUAL_INTERVENTION_REQUIRED',
  ] as const)('renders browser %s as resumable manual waiting without duplicate error copy', (errorCode) => {
    const actionSummary = '自动操作暂时无法继续，请在网页中手动操作。停止操作 5 秒后将自动继续。'
    const wrapper = mount(MessageBlock, {
      props: { block: browserStatusBlock('awaiting_user', { errorCode, actionSummary }) },
      global: { plugins: [ElementPlus] },
    })

    expect(wrapper.get('[data-testid="browser-status"]').text()).toContain('等待你手动操作')
    expect(wrapper.get('[data-testid="browser-action-summary"]').text()).toBe(actionSummary)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="take-over-browser"]').exists()).toBe(false)
    expect((wrapper.get('[data-testid="stop-browser"]').element as HTMLButtonElement).disabled)
      .toBe(false)
  })

  it.each([
    ['inspecting', true],
    ['acting', false],
  ] as const)('renders motion on the browser %s icon only while inspecting', (state, loading) => {
    const wrapper = mount(MessageBlock, {
      props: { block: browserStatusBlock(state) },
      global: { plugins: [ElementPlus] },
    })

    const icon = wrapper.get('[data-testid="browser-status-icon"]')
    expect(icon.classes()).toContain('af-operation-marker')
    expect(icon.classes().includes('is-loading')).toBe(loading)
    expect(icon.attributes('aria-hidden')).toBe('true')
  })

  it.each([
    ['awaiting_user', '需要你在浏览器中操作', 'warning', true],
    ['completed', '已完成', 'success', true],
    ['failed', '未完成', 'danger', true],
    ['cancelled', '已取消', 'neutral', true],
  ] as const)('renders accessible %s browser copy and terminal action state', (state, copy, tone, disabled) => {
    const wrapper = mount(MessageBlock, {
      props: { block: browserStatusBlock(state, state === 'failed' ? { errorCode: 'PAGE_CHANGED' } : {}) },
      global: { plugins: [ElementPlus] },
    })

    const card = wrapper.get('[data-testid="browser-status"]')
    expect(card.classes()).toContain('af-operation-card')
    expect(card.classes()).toContain(`tone-${tone}`)
    expect(card.get('[data-testid="browser-status-badge"]').text()).toBe(copy)
    expect(wrapper.find('[data-testid="stop-browser"]').exists()).toBe(!disabled)
    expect(wrapper.find('[data-testid="take-over-browser"]').exists()).toBe(!disabled)
    if (state === 'failed') expect(wrapper.text()).toContain('页面已变化，请重新检查后继续')
  })

  it('collapses completed browser details while keeping them expandable', async () => {
    const wrapper = mount(MessageBlock, {
      props: { block: browserStatusBlock('completed', { actionSummary: '已读取证件信息' }) },
      global: { plugins: [ElementPlus] },
    })

    const card = wrapper.get('[data-testid="browser-status"]')
    const toggle = card.get('[data-testid="toggle-browser-details"]')
    expect(card.classes()).toContain('is-collapsed')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(card.find('[data-testid="browser-status-content"]').exists()).toBe(false)

    await toggle.trigger('click')

    expect(card.classes()).not.toContain('is-collapsed')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(card.get('[data-testid="browser-status-content"]').isVisible()).toBe(true)
  })

  it('collapses browser details when a live operation completes', async () => {
    const wrapper = mount(MessageBlock, {
      props: { block: browserStatusBlock('acting') },
      global: { plugins: [ElementPlus] },
    })

    expect(wrapper.find('[data-testid="browser-status-content"]').exists()).toBe(true)

    await wrapper.setProps({ block: browserStatusBlock('completed') })

    expect(wrapper.get('[data-testid="browser-status"]').classes()).toContain('is-collapsed')
    expect(wrapper.find('[data-testid="browser-status-content"]').exists()).toBe(false)
  })

  it('renders cancellation as a neutral terminal state without an error alert', () => {
    const wrapper = mount(MessageBlock, {
      props: {
        block: browserStatusBlock('cancelled', {
          actionSummary: '网页操作已取消',
          errorCode: 'CANCELLED',
        }),
      },
      global: { plugins: [ElementPlus] },
    })

    const card = wrapper.get('[data-testid="browser-status"]')
    expect(card.classes()).toContain('tone-neutral')
    expect(card.get('[data-testid="browser-status-badge"]').text()).toBe('已取消')
    expect(card.get('[data-testid="browser-action-summary"]').text()).toBe('网页操作已取消')
    expect(card.find('[role="alert"]').exists()).toBe(false)
  })

  it('shows one localized browser failure reason instead of a duplicate action summary', () => {
    const wrapper = mount(MessageBlock, {
      props: {
        block: browserStatusBlock('failed', {
          actionSummary: '网页操作已安全停止',
          errorCode: 'TOOL_CALL_LIMIT',
        }),
      },
      global: { plugins: [ElementPlus] },
    })

    const card = wrapper.get('[data-testid="browser-status"]')
    expect(card.get('[role="alert"]').text()).toBe('工作流工具调用次数已达上限')
    expect(card.find('[data-testid="browser-action-summary"]').exists()).toBe(false)
    expect(card.text()).not.toContain('网页操作已安全停止')
  })

  it('links each browser disclosure button to its own details region', () => {
    const first = mount(MessageBlock, {
      props: { block: browserStatusBlock('acting', { blockId: 'browser_status_1' }) },
      global: { plugins: [ElementPlus] },
    })
    const second = mount(MessageBlock, {
      props: { block: browserStatusBlock('acting', { blockId: 'browser_status_2' }) },
      global: { plugins: [ElementPlus] },
    })

    const firstTarget = first.get('[data-testid="toggle-browser-details"]').attributes('aria-controls')
    const secondTarget = second.get('[data-testid="toggle-browser-details"]').attributes('aria-controls')
    expect(first.get('[data-testid="browser-status-content"]').attributes('id')).toBe(firstTarget)
    expect(second.get('[data-testid="browser-status-content"]').attributes('id')).toBe(secondTarget)
    expect(firstTarget).not.toBe(secondTarget)
  })

  it('replaces browser status by its Main-owned block id', () => {
    const { api, emitChat } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.ensureSubscriptions()
    const { id: actingId, ...acting } = browserStatusBlock('acting', { actionSummary: '填写单位信息' })
    const { id: completedId, ...completed } = browserStatusBlock('completed', { actionSummary: '已填写单位信息' })
    void actingId; void completedId

    emitChat({ type: 'block', conversationId: 'conv_1', messageId: 'assistant_1', block: acting })
    emitChat({ type: 'block', conversationId: 'conv_1', messageId: 'assistant_1', block: completed })

    expect(store.messagesByConversation.conv_1?.[0]?.blocks).toEqual([
      expect.objectContaining({
        id: 'assistant_1:browser_status_1', blockId: 'browser_status_1',
        state: 'completed', actionSummary: '已填写单位信息',
      }),
    ])
  })

  it('renders one system provenance entry as a compact operation card', async () => {
    const { api } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const wrapper = mount(MessageBlock, {
      props: { block: workflowProvenanceBlock([{
        executionId: 'execution_1',
        workflowId: 'workflow.beijing',
        workflowName: '北京工作居住证',
        workflowVersion: '1.0.0',
        source: 'development',
        buildHash,
        city: '北京',
        status: 'completed',
      }]) },
      global: { plugins: [ElementPlus] },
    })

    const card = wrapper.get('[data-testid="workflow-provenance"]')
    expect(card.classes()).toContain('af-operation-card')
    expect(card.classes()).toContain('tone-success')
    expect(card.classes()).toContain('is-collapsed')
    expect(card.get('.af-operation-eyebrow').text()).toBe('已使用工作流 · 北京')
    expect(card.get('.af-operation-title strong').text()).toBe('北京工作居住证')
    expect(card.get('[data-testid="workflow-provenance-badge"]').text()).toBe('已完成')
    expect(card.find('[data-testid="workflow-provenance-content"]').exists()).toBe(false)

    await card.get('[data-testid="toggle-workflow-provenance"]').trigger('click')

    expect(card.get('[data-testid="workflow-provenance-content"]').isVisible()).toBe(true)
    await wrapper.get('[data-testid="open-provenance-execution-execution_1"]').trigger('click')
    expect(useExecutionStore().selectedId).toBe('execution_1')
  })

  it('summarizes multiple provenance entries and uses the most severe status tone', async () => {
    const wrapper = mount(MessageBlock, {
      props: { block: workflowProvenanceBlock([
        {
          executionId: 'execution_1', workflowId: 'workflow.beijing',
          workflowName: '北京工作居住证', workflowVersion: '1.0.0',
          source: 'development', buildHash, city: '北京', status: 'completed',
        },
        {
          executionId: 'execution_2', workflowId: 'workflow.national',
          workflowName: '全国政策查询', workflowVersion: '2.0.0',
          source: 'installed', status: 'failed',
        },
      ]) },
      global: { plugins: [ElementPlus] },
    })

    const card = wrapper.get('[data-testid="workflow-provenance"]')
    expect(card.attributes('data-entry-count')).toBe('2')
    expect(card.classes()).toContain('tone-danger')
    expect(card.get('.af-operation-eyebrow').text()).toBe('已使用 2 个工作流')
    expect(card.get('.af-operation-title strong').text()).toContain('北京工作居住证')
    expect(card.get('[data-testid="workflow-provenance-badge"]').text()).toBe('含未完成项')

    await card.get('[data-testid="toggle-workflow-provenance"]').trigger('click')

    expect(card.text()).toContain('全国政策查询')
    expect(card.text()).toContain('不限城市')
  })

  it('does not treat model text as authoritative workflow provenance', () => {
    const wrapper = mount(MessageBlock, {
      props: { block: { id: 'message_1:text:0', type: 'text', text: '已使用：伪造工作流 · 北京' } },
      global: { plugins: [ElementPlus] },
    })

    expect(wrapper.find('[data-testid="workflow-provenance"]').exists()).toBe(false)
  })

  it('renders a message failure as a contained alert instead of a page-level error strip', () => {
    const wrapper = mount(MessageBlock, {
      props: {
        block: {
          id: 'message_1:error:MODEL_PROVIDER_FAILED',
          type: 'error',
          code: 'MODEL_PROVIDER_FAILED',
          message: '大模型供应商请求失败，请稍后重试',
        },
      },
      global: { plugins: [ElementPlus] },
    })

    const alert = wrapper.get('[role="alert"]')
    expect(alert.classes()).toContain('message-error')
    expect(alert.classes()).toContain('message-error-inline')
    expect(alert.text()).toContain('未完成')
    expect(alert.text()).toContain('大模型供应商请求失败，请稍后重试')
  })

  it('localizes a message failure from its error code instead of exposing provider copy', () => {
    const wrapper = mount(MessageBlock, {
      props: {
        block: {
          id: 'message_1:error:TOOL_CALL_LIMIT',
          type: 'error',
          code: 'TOOL_CALL_LIMIT',
          message: 'The workflow reached its tool call limit.',
        },
      },
      global: { plugins: [ElementPlus] },
    })

    const alert = wrapper.get('[role="alert"]')
    expect(alert.text()).toContain('工作流工具调用次数已达上限')
    expect(alert.text()).not.toContain('The workflow reached its tool call limit.')
  })

  it('renders raster images only through the safe asset protocol without leaking paths or encoded bytes', () => {
    const wrapper = mount(MessageBlock, {
      props: {
        block: {
          id: 'message_1:block_image',
          type: 'media',
          blockId: 'block_image',
          assetId: 'asset_1',
          kind: 'image',
          purpose: 'output',
          name: 'result.png',
          mimeType: 'image/png',
          byteSize: 2048,
          width: 1024,
          height: 768,
        },
      },
      global: { plugins: [ElementPlus] },
    })

    expect(wrapper.get('img').attributes('src')).toBe('autoforge-media://asset/asset_1')
    expect(wrapper.get('img').attributes('alt')).toBe('result.png')
    expect(wrapper.text()).toContain('PNG')
    expect(wrapper.text()).toContain('2 KB')
    expect(wrapper.text()).toContain('1024 × 768')
    expect(wrapper.html()).not.toContain('/Users/')
    expect(wrapper.html()).not.toContain('base64')
    expect(wrapper.html()).not.toContain('https://')
  })

  it('refuses to put a non-canonical asset identifier into a media source', () => {
    const wrapper = mount(MessageBlock, {
      props: {
        block: {
          id: 'message_1:block_image',
          type: 'media',
          blockId: 'block_image',
          assetId: '/Users/private/photo.png',
          kind: 'image',
          purpose: 'output',
          name: 'photo.png',
          mimeType: 'image/png',
          byteSize: 2048,
        },
      },
      global: { plugins: [ElementPlus] },
    })

    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.html()).not.toContain('/Users/')
  })

  it('uses native audio and video controls with safe protocol sources and useful metadata', () => {
    const audio = mount(MessageBlock, {
      props: {
        block: {
          id: 'message_1:block_audio',
          type: 'media',
          blockId: 'block_audio',
          assetId: 'asset_audio',
          kind: 'audio',
          purpose: 'output',
          name: 'voice.mp3',
          mimeType: 'audio/mpeg',
          byteSize: 1_536,
          durationMs: 65_000,
        },
      },
      global: { plugins: [ElementPlus] },
    })
    expect(audio.get('audio').attributes()).toMatchObject({
      controls: '',
      src: 'autoforge-media://asset/asset_audio',
    })
    expect(audio.text()).toContain('MP3')
    expect(audio.text()).toContain('1:05')
    expect(audio.text()).toContain('1.5 KB')

    const video = mount(MessageBlock, {
      props: {
        block: {
          id: 'message_1:block_video',
          type: 'media',
          blockId: 'block_video',
          assetId: 'asset_video',
          kind: 'video',
          purpose: 'output',
          name: 'clip.mp4',
          mimeType: 'video/mp4',
          byteSize: 2_000_000,
          width: 1280,
          height: 720,
          durationMs: 5_000,
        },
      },
      global: { plugins: [ElementPlus] },
    })
    expect(video.get('video').attributes()).toMatchObject({
      controls: '',
      preload: 'metadata',
      src: 'autoforge-media://asset/asset_video',
    })
    expect(video.text()).toContain('MP4')
    expect(video.text()).toContain('0:05')
    expect(video.text()).toContain('1280 × 720')
  })

  it('never embeds SVG media and keeps save and reveal actions available', async () => {
    const { api } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const wrapper = mount(MessageBlock, {
      props: {
        block: {
          id: 'message_1:block_svg',
          type: 'media',
          blockId: 'block_svg',
          assetId: 'asset_svg',
          kind: 'image',
          purpose: 'output',
          name: 'diagram.svg',
          mimeType: 'image/svg+xml',
          byteSize: 512,
        },
      },
      global: { plugins: [ElementPlus] },
    })

    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('audio').exists()).toBe(false)
    expect(wrapper.find('video').exists()).toBe(false)
    expect(wrapper.text()).toContain('diagram.svg')
    await wrapper.get('[data-testid="save-media-copy"]').trigger('click')
    await wrapper.get('[data-testid="reveal-media"]').trigger('click')
    expect(api.media.saveCopy).toHaveBeenCalledWith('asset_svg')
    expect(api.media.reveal).toHaveBeenCalledWith('asset_svg')
  })

  it('submits a media action only once while its first request is pending', async () => {
    const { api } = createEventApi()
    let resolveSave!: () => void
    vi.mocked(api.media.saveCopy).mockImplementation(() => new Promise<void>((resolve) => {
      resolveSave = resolve
    }))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const wrapper = mount(MessageBlock, {
      props: {
        block: {
          id: 'message_1:block_image',
          type: 'media',
          blockId: 'block_image',
          assetId: 'asset_image',
          kind: 'image',
          purpose: 'output',
          name: 'result.png',
          mimeType: 'image/png',
          byteSize: 2048,
        },
      },
      global: { plugins: [ElementPlus] },
    })

    const button = wrapper.get('[data-testid="save-media-copy"]').element
    button.dispatchEvent(new MouseEvent('click'))
    button.dispatchEvent(new MouseEvent('click'))
    expect(api.media.saveCopy).toHaveBeenCalledTimes(1)
    resolveSave()
    await flushPromises()
  })

  it('shows safe action failures inside only the affected media block', async () => {
    const { api } = createEventApi()
    vi.mocked(api.media.saveCopy).mockRejectedValue({
      code: 'MEDIA_ASSET_UNAVAILABLE',
      message: 'private path and provider response',
    })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const wrapper = mount(MessageBlock, {
      props: {
        block: {
          id: 'message_1:block_audio',
          type: 'media',
          blockId: 'block_audio',
          assetId: 'asset_audio',
          kind: 'audio',
          purpose: 'output',
          name: 'voice.mp3',
          mimeType: 'audio/mpeg',
          byteSize: 1024,
        },
      },
      global: { plugins: [ElementPlus] },
    })

    await wrapper.get('[data-testid="save-media-copy"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe('媒体文件不可用或已损坏')
    expect(wrapper.html()).not.toContain('private path')
    expect(wrapper.find('audio').exists()).toBe(true)
  })

  it.each(['pending', 'in_progress', 'downloading'] as const)(
    'renders %s generation as truthful indeterminate progress without a fabricated percentage',
    (status) => {
      const wrapper = mount(MessageBlock, {
        props: {
          block: {
            id: `message_1:block_${status}`,
            type: 'media_generation',
            blockId: `block_${status}`,
            jobId: `job_${status}`,
            kind: 'image',
            status,
          },
        },
        global: { plugins: [ElementPlus] },
      })

      expect(wrapper.get('[data-testid="generation-progress"]').exists()).toBe(true)
      expect(wrapper.text()).not.toContain('%')
      expect(wrapper.find('[data-testid="retry-media-generation"]').exists()).toBe(false)
    },
  )

  it('keeps video downloading indeterminate without offering an upstream tracking pause', () => {
    const wrapper = mount(MessageBlock, {
      props: {
        block: {
          id: 'message_1:block_video_download',
          type: 'media_generation',
          blockId: 'block_video_download',
          jobId: 'job_video_download',
          kind: 'video',
          status: 'downloading',
        },
      },
      global: { plugins: [ElementPlus] },
    })

    expect(wrapper.get('[data-testid="generation-progress"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('%')
    expect(wrapper.find('[data-testid="pause-video-job"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('上游任务可能继续执行并产生费用')
  })

  it('warns before pausing video tracking and resumes a persisted paused job', async () => {
    const { api } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const active = mount(MessageBlock, {
      props: {
        block: {
          id: 'message_1:block_video',
          type: 'media_generation',
          blockId: 'block_video',
          jobId: 'job_video',
          kind: 'video',
          status: 'in_progress',
        },
      },
      global: { plugins: [ElementPlus] },
    })
    expect(active.text()).toContain('暂停只会停止本地跟踪，上游任务可能继续执行并产生费用。')
    await active.get('[data-testid="pause-video-job"]').trigger('click')
    expect(active.get('[data-testid="pause-video-job"]').text()).toContain('暂停跟踪')
    expect(api.media.pauseVideoJob).toHaveBeenCalledWith('job_video')

    const paused = mount(MessageBlock, {
      props: {
        block: {
          id: 'message_1:block_video',
          type: 'media_generation',
          blockId: 'block_video',
          jobId: 'job_video',
          kind: 'video',
          status: 'paused',
        },
      },
      global: { plugins: [ElementPlus] },
    })
    await paused.get('[data-testid="resume-video-job"]').trigger('click')
    expect(paused.get('[data-testid="resume-video-job"]').text()).toContain('继续跟踪')
    expect(api.media.resumeVideoJob).toHaveBeenCalledWith('job_video')
  })

  it('localizes video action failures without exposing provider details', async () => {
    const { api } = createEventApi()
    vi.mocked(api.media.resumeVideoJob).mockRejectedValue({
      code: 'MEDIA_DOWNLOAD_FAILED',
      message: 'https://provider.example/private-output',
    })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const wrapper = mount(MessageBlock, {
      props: {
        block: {
          id: 'message_1:block_video',
          type: 'media_generation',
          blockId: 'block_video',
          jobId: 'job_video',
          kind: 'video',
          status: 'paused',
        },
      },
      global: { plugins: [ElementPlus] },
    })

    await wrapper.get('[data-testid="resume-video-job"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe('媒体下载失败')
    expect(wrapper.html()).not.toContain('provider.example')
  })

  it('renders a failed generation as an isolated safe block without inventing an unreconstructable retry', () => {
    const wrapper = mount(MessageBlock, {
      props: {
        block: {
          id: 'message_1:block_failed',
          type: 'media_generation',
          blockId: 'block_failed',
          jobId: 'job_failed',
          kind: 'audio',
          status: 'failed',
          errorCode: 'MEDIA_GENERATION_FAILED',
        },
      },
      global: { plugins: [ElementPlus] },
    })

    expect(wrapper.get('[role="alert"]').text()).toContain('媒体生成失败')
    expect(wrapper.find('[data-testid="retry-media-generation"]').exists()).toBe(false)
    expect(wrapper.classes()).toContain('message-block')
  })

  it.each([
    ['MEDIA_TYPE_UNSUPPORTED', '不支持此媒体格式'],
    ['MEDIA_ATTACHMENT_LIMIT_EXCEEDED', '每条消息最多添加 5 个附件'],
    ['MEDIA_SIZE_LIMIT_EXCEEDED', '媒体文件大小超出限制'],
    ['MEDIA_MIME_MISMATCH', '文件内容与格式不匹配'],
    ['MEDIA_IMPORT_FAILED', '媒体文件导入失败'],
    ['MEDIA_ASSET_UNAVAILABLE', '媒体文件不可用或已损坏'],
    ['MEDIA_STORAGE_FULL', '本地磁盘空间不足'],
    ['MODEL_MODALITY_UNSUPPORTED', '当前模型不支持所选输入或输出类型'],
    ['MEDIA_GENERATION_FAILED', '媒体生成失败'],
    ['MEDIA_DOWNLOAD_FAILED', '媒体下载失败'],
    ['MEDIA_GENERATION_TIMEOUT', '视频生成超时'],
    ['CONTEXT_LIMIT_EXCEEDED', '当前输入和会话上下文超出模型限制，请缩短输入或新建会话'],
    ['MODEL_PROVIDER_INVALID_REQUEST', '供应商拒绝了当前请求，请调整生成设置或稍后重试'],
    ['MODEL_PROVIDER_PAYMENT_REQUIRED', '供应商账户或 API Key 额度不足，请充值或检查限额'],
    ['MODEL_PROVIDER_RATE_LIMITED', '供应商请求过于频繁，请稍后重试'],
    ['MODEL_PROVIDER_TIMEOUT', '供应商响应超时，请稍后重试'],
    ['MODEL_PROVIDER_UNAVAILABLE', '供应商或所选模型暂时不可用，请稍后重试'],
    ['TOOL_CALL_LIMIT', '工作流工具调用次数已达上限'],
  ] as const)('maps %s to its safe localized message', (code, message) => {
    expect(displayError({ code, message: 'unsafe provider details' })).toBe(message)
  })

  it('shows a focused approval summary and keeps technical details behind disclosure', async () => {
    const { api } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const wrapper = mount(ApprovalCard, {
      props: { approval: approvalBlock() },
      global: { plugins: [ElementPlus] },
    })

    const card = wrapper.get('[data-testid="approval-card"]')
    expect(card.classes()).toContain('af-operation-card')
    expect(card.classes()).toContain('tone-warning')
    expect(card.classes()).not.toContain('is-collapsed')
    expect(card.get('.af-operation-eyebrow').text()).toBe('权限请求')
    expect(card.get('.af-operation-title strong').text()).toBe('北京工作居住证')
    expect(card.get('[data-testid="approval-status-badge"]').text()).toBe('待确认')
    expect(card.text()).toContain('填写并点击提交')
    expect(card.text()).toContain('browser.click')
    expect(card.text()).toContain('https://example.com')
    expect(card.get('.approval-technical-list').isVisible()).toBe(false)

    await card.get('[data-testid="approval-technical-details"] summary').trigger('click')

    expect(card.get('.approval-technical-list').isVisible()).toBe(true)
    expect(card.text()).toContain('workflow.beijing')
    expect(card.text()).toContain('1.0.0')
    expect(card.text()).toContain('开发版本')
    expect(card.text()).toContain(buildHash)
    expect(card.text()).toContain('北京')
    expect(wrapper.find('[data-testid="approve-always"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="deny-approval"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="approve-once"]').exists()).toBe(true)
  })

  it('collapses an authoritative resolved approval into a status summary', async () => {
    const { api } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const wrapper = mount(ApprovalCard, {
      props: { approval: approvalBlock({ state: 'approved' }) },
      global: { plugins: [ElementPlus] },
    })

    const card = wrapper.get('[data-testid="approval-card"]')
    expect(card.classes()).toContain('tone-success')
    expect(card.classes()).toContain('is-collapsed')
    expect(card.get('[data-testid="approval-status-badge"]').text()).toBe('已允许本次')
    expect(card.find('[data-testid="approval-card-content"]').exists()).toBe(false)
    expect(card.find('[data-testid="deny-approval"]').exists()).toBe(false)
    expect(card.find('[data-testid="approve-once"]').exists()).toBe(false)

    await card.get('[data-testid="toggle-approval-details"]').trigger('click')

    expect(card.get('[data-testid="approval-card-content"]').isVisible()).toBe(true)
    expect(card.find('[data-testid="deny-approval"]').exists()).toBe(false)
    expect(card.find('[data-testid="approve-once"]').exists()).toBe(false)
  })

  it('collapses a live approval when Main resolves the pending request', async () => {
    const { api } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const wrapper = mount(ApprovalCard, {
      props: { approval: approvalBlock() },
      global: { plugins: [ElementPlus] },
    })

    expect(wrapper.get('[data-testid="approval-card"]').classes()).not.toContain('is-collapsed')

    await wrapper.setProps({ approval: approvalBlock({ state: 'approved' }) })

    expect(wrapper.get('[data-testid="approval-card"]').classes()).toContain('is-collapsed')
    expect(wrapper.find('[data-testid="approval-card-content"]').exists()).toBe(false)
  })

  it('submits only the strict once contract and disables duplicate approval', async () => {
    const { api, decide } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const wrapper = mount(ApprovalCard, {
      props: { approval: approvalBlock() },
      global: { plugins: [ElementPlus] },
    })
    await wrapper.get('[data-testid="approve-once"]').trigger('click')
    await wrapper.get('[data-testid="approve-once"]').trigger('click')
    expect(decide).toHaveBeenCalledTimes(1)
    expect(decide).toHaveBeenCalledWith({
      executionId: 'execution_1', permissionIndex: 0, scopeHash, decision: 'once',
    })
    expect(wrapper.get('[data-testid="approve-once"]').attributes('disabled')).toBeDefined()
  })

  it('submits only the strict deny contract', async () => {
    const { api, decide } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const wrapper = mount(ApprovalCard, {
      props: { approval: approvalBlock() },
      global: { plugins: [ElementPlus] },
    })
    await wrapper.get('[data-testid="deny-approval"]').trigger('click')
    expect(api.executions.get).not.toHaveBeenCalled()
    expect(decide).toHaveBeenCalledWith({
      executionId: 'execution_1', permissionIndex: 0, scopeHash, decision: 'deny',
    })
  })

  it.each([
    ['approved', '已允许本次'],
    ['denied', '已拒绝'],
    ['expired', '审批已过期'],
    ['cancelled', '审批已取消'],
    ['invalidated', '审批已失效'],
  ] as const)('renders authoritative %s approvals as resolved and non-actionable', async (state, label) => {
    const { api, decide } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const wrapper = mount(ApprovalCard, {
      props: { approval: approvalBlock({ state }) },
      global: { plugins: [ElementPlus] },
    })

    expect(wrapper.get('[data-testid="approval-status-badge"]').text()).toBe(label)
    expect(wrapper.find('[data-testid="approve-once"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="deny-approval"]').exists()).toBe(false)
    expect(decide).not.toHaveBeenCalled()
  })

  it('replaces a live approval by Main-owned block id when ownership ends', () => {
    const { api, emitChat } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.ensureSubscriptions()

    emitChat({
      type: 'block', conversationId: 'conv_1', messageId: 'assistant_1',
      block: approvalBlock(),
    })
    emitChat({
      type: 'block', conversationId: 'conv_1', messageId: 'assistant_1',
      block: approvalBlock({ state: 'denied' }),
    })

    expect(store.messagesByConversation.conv_1?.[0]?.blocks).toEqual([
      expect.objectContaining({ type: 'approval', blockId: 'approval_1', state: 'denied' }),
    ])
  })

  it('keeps a recovered invalidated approval disabled after transcript reload', async () => {
    const { api } = createEventApi()
    vi.mocked(api.chat.listMessages).mockResolvedValue({ items: [{
      id: 'assistant_1', conversationId: 'conv_1', role: 'assistant',
      blocks: [approvalBlock({ state: 'invalidated' })],
      createdAt: '2026-08-22T00:00:00.000Z',
    }] })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    await store.selectConversation('conv_1')
    const approval = store.messagesByConversation.conv_1?.[0]?.blocks[0]
    if (!approval || approval.type !== 'approval') throw new Error('Expected persisted approval')
    const wrapper = mount(MessageBlock, {
      props: { block: approval },
      global: { plugins: [ElementPlus] },
    })

    expect(wrapper.get('[data-testid="approval-status-badge"]').text()).toBe('审批已失效')
    expect(wrapper.find('[data-testid="approve-once"]').exists()).toBe(false)
  })

  it('subscribes once and merges streamed text deltas without duplication', () => {
    const { api, emitChat } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.selectedConversationId = 'conv_1'
    store.ensureSubscriptions()
    store.ensureSubscriptions()
    expect(api.chat.onEvent).toHaveBeenCalledTimes(1)
    emitChat({ type: 'block', conversationId: 'conv_1', messageId: 'msg_1', block: { type: 'text', text: '你好' } })
    emitChat({ type: 'block', conversationId: 'conv_1', messageId: 'msg_1', block: { type: 'text', text: '，世界' } })
    expect(store.messagesByConversation.conv_1?.[0]?.blocks).toEqual([
      expect.objectContaining({ id: 'msg_1:text:0', type: 'text', text: '你好，世界' }),
    ])
  })

  it('hydrates the original pending A request after selecting B and reselecting A', async () => {
    const { api } = createEventApi()
    const pendingMessages = deferred<Awaited<ReturnType<DesktopAPI['chat']['listMessages']>>>()
    const pendingPreferences = deferred<ConversationGenerationPreferences>()
    const preferences = generationPreferences({ outputType: 'video' })
    vi.mocked(api.chat.listMessages).mockReturnValue(pendingMessages.promise)
    vi.mocked(api.chat.getGenerationPreferences).mockReturnValue(pendingPreferences.promise)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.conversations = [
      conversationSummary('conv_a', '2026-08-25T00:02:00.000Z'),
      conversationSummary('conv_b', '2026-08-25T00:01:00.000Z'),
    ]
    store.messagesByConversation.conv_b = [{ id: 'message_b', role: 'assistant', blocks: [] }]
    store.preferencesByConversation.conv_b = generationPreferences({ outputType: 'text' })

    const firstSelection = store.selectConversation('conv_a')
    await vi.waitFor(() => {
      expect(api.chat.listMessages).toHaveBeenCalledOnce()
      expect(api.chat.getGenerationPreferences).toHaveBeenCalledOnce()
    })
    await store.selectConversation('conv_b')
    await store.selectConversation('conv_a')
    expect(api.chat.listMessages).toHaveBeenCalledOnce()
    expect(api.chat.getGenerationPreferences).toHaveBeenCalledOnce()

    pendingMessages.resolve({
      items: [storedMessage('message_a', 'conv_a', 'real A row')],
      previousCursor: 'a-previous-cursor',
    })
    pendingPreferences.resolve(preferences)
    await firstSelection

    expect(store.selectedConversationId).toBe('conv_a')
    expect(store.messagesByConversation.conv_a?.map(({ id }) => id)).toEqual(['message_a'])
    expect(store.previousMessageCursorByConversation.conv_a).toBe('a-previous-cursor')
    expect(store.preferencesByConversation.conv_a).toEqual(preferences)
  })

  it('does not apply pending A rows while B remains selected', async () => {
    const { api } = createEventApi()
    const pendingMessages = deferred<Awaited<ReturnType<DesktopAPI['chat']['listMessages']>>>()
    const pendingPreferences = deferred<ConversationGenerationPreferences>()
    vi.mocked(api.chat.listMessages).mockReturnValue(pendingMessages.promise)
    vi.mocked(api.chat.getGenerationPreferences).mockReturnValue(pendingPreferences.promise)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.messagesByConversation.conv_b = [{ id: 'message_b', role: 'assistant', blocks: [] }]
    store.preferencesByConversation.conv_b = generationPreferences({ outputType: 'text' })

    const firstSelection = store.selectConversation('conv_a')
    await vi.waitFor(() => expect(api.chat.getGenerationPreferences).toHaveBeenCalledOnce())
    await store.selectConversation('conv_b')
    pendingMessages.resolve({ items: [storedMessage('message_a', 'conv_a', 'stale A row')] })
    pendingPreferences.resolve(generationPreferences({ outputType: 'audio' }))
    await firstSelection

    expect(store.selectedConversationId).toBe('conv_b')
    expect(store.messagesByConversation.conv_a).toBeUndefined()
    expect(store.preferencesByConversation.conv_a).toBeUndefined()
  })

  it('rejects a pending A request after A to B to A when the UID generation resets', async () => {
    const { api } = createEventApi()
    const pendingMessages = deferred<Awaited<ReturnType<DesktopAPI['chat']['listMessages']>>>()
    const pendingPreferences = deferred<ConversationGenerationPreferences>()
    vi.mocked(api.chat.listMessages).mockReturnValue(pendingMessages.promise)
    vi.mocked(api.chat.getGenerationPreferences).mockReturnValue(pendingPreferences.promise)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.messagesByConversation.conv_b = [{ id: 'message_b', role: 'assistant', blocks: [] }]
    store.preferencesByConversation.conv_b = generationPreferences({ outputType: 'text' })

    const oldSelection = store.selectConversation('conv_a')
    await vi.waitFor(() => expect(api.chat.listMessages).toHaveBeenCalledOnce())
    await store.selectConversation('conv_b')
    await store.selectConversation('conv_a')
    store.resetLocalData()
    store.selectedConversationId = 'conv_a'
    store.messagesByConversation.conv_a = [{ id: 'new-user-message', role: 'assistant', blocks: [] }]
    store.preferencesByConversation.conv_a = generationPreferences({ outputType: 'image' })

    pendingMessages.resolve({ items: [storedMessage('old-user-message', 'conv_a', 'old UID row')] })
    pendingPreferences.resolve(generationPreferences({ outputType: 'audio' }))
    await oldSelection

    expect(store.messagesByConversation.conv_a?.map(({ id }) => id)).toEqual(['new-user-message'])
    expect(store.preferencesByConversation.conv_a?.outputType).toBe('image')
    expect(store.error).toBe('')
  })

  it('updates the matching sidebar conversation from an AI title event', () => {
    const { api, emitChat } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.conversations = [
      {
        id: 'conv_2', title: '较新会话', titleState: 'user_named', revision: 1, syncState: 'synced',
        createdAt: '2026-08-23T00:00:00.000Z',
        lastActivityAt: '2026-08-23T00:00:30.000Z',
        metadataUpdatedAt: '2026-08-23T00:00:30.000Z',
      },
      {
        id: 'conv_1', title: '新会话', titleState: 'generating', revision: 1, syncState: 'synced',
        createdAt: '2026-08-23T00:00:00.000Z',
        lastActivityAt: '2026-08-23T00:00:00.000Z',
        metadataUpdatedAt: '2026-08-23T00:00:00.000Z',
      },
    ]
    store.ensureSubscriptions()

    emitChat({
      type: 'conversation_title_updated',
      conversationId: 'conv_1',
      title: '北京工作居住证办理',
      updatedAt: '2026-08-23T00:01:00.000Z',
    })

    expect(store.conversations[0]).toMatchObject({
      id: 'conv_1', title: '北京工作居住证办理', titleState: 'ai_named',
      syncState: 'pending', lastActivityAt: '2026-08-23T00:01:00.000Z',
      metadataUpdatedAt: '2026-08-23T00:01:00.000Z',
    })
  })

  it('merges a real conversation projection event without refetching or losing local state', () => {
    const { api, emitChat } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.conversations = [{
      id: 'conv_1', title: 'Local', titleState: 'pending', revision: 0, syncState: 'pending',
      createdAt: '2026-08-25T00:00:00.000Z',
      lastActivityAt: '2026-08-25T00:00:00.000Z',
      metadataUpdatedAt: '2026-08-25T00:00:00.000Z',
    }]
    store.selectedConversationId = 'conv_1'
    store.messagesByConversation.conv_1 = [{ id: 'local_1', role: 'user', blocks: [] }]
    store.ensureSubscriptions()

    emitChat({
      type: 'conversation_updated',
      conversationId: 'conv_1',
      conversation: {
        id: 'conv_1', title: 'Remote', titleState: 'user_named', revision: 2,
        syncState: 'failed', createdAt: '2026-08-25T00:00:00.000Z',
        lastActivityAt: '2026-08-25T00:02:00.000Z',
        metadataUpdatedAt: '2026-08-25T00:01:00.000Z',
      },
    })

    expect(store.conversations).toEqual([{
      id: 'conv_1', title: 'Remote', titleState: 'user_named', revision: 2,
      syncState: 'failed', createdAt: '2026-08-25T00:00:00.000Z',
      lastActivityAt: '2026-08-25T00:02:00.000Z',
      metadataUpdatedAt: '2026-08-25T00:01:00.000Z',
    }])
    expect(store.selectedConversationId).toBe('conv_1')
    expect(store.messagesByConversation.conv_1).toEqual([{ id: 'local_1', role: 'user', blocks: [] }])
    expect(api.chat.listConversations).not.toHaveBeenCalled()
  })

  it('tracks a targeted sync retry while in flight and deduplicates repeated requests', async () => {
    const { api } = createEventApi()
    const retry = deferred<void>()
    vi.mocked(api.chat.retrySync).mockReturnValue(retry.promise)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()

    const first = store.retrySync('conv_1')
    const second = store.retrySync('conv_1')
    await Promise.resolve()

    expect(api.chat.retrySync).toHaveBeenCalledOnce()
    expect(store.retryingSyncByConversation).toEqual({ conv_1: true })

    retry.resolve()
    await Promise.all([first, second])
    expect(store.retryingSyncByConversation).toEqual({})
  })

  it('rehydrates selected generation preferences after a converged metadata event', async () => {
    const { api, emitChat } = createEventApi()
    const stalePreferences = deferred<ConversationGenerationPreferences>()
    const remotePreferences = generationPreferences({ outputType: 'video' })
    vi.mocked(api.chat.getGenerationPreferences)
      .mockReturnValueOnce(stalePreferences.promise)
      .mockResolvedValueOnce(remotePreferences)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    const conversation = conversationSummary('conv_preferences', '2026-08-25T00:00:00.000Z')
    store.conversations = [conversation]
    store.selectedConversationId = conversation.id
    store.preferencesByConversation[conversation.id] = generationPreferences({ outputType: 'text' })
    store.ensureSubscriptions()

    const staleLoad = store.loadGenerationPreferences(conversation.id)
    await vi.waitFor(() => expect(api.chat.getGenerationPreferences).toHaveBeenCalledOnce())
    emitChat({
      type: 'conversation_updated',
      conversationId: conversation.id,
      conversation: {
        ...conversation,
        revision: 2,
        metadataUpdatedAt: '2026-08-25T00:01:00.000Z',
      },
    })
    await vi.waitFor(() => expect(api.chat.getGenerationPreferences).toHaveBeenCalledTimes(2))
    stalePreferences.resolve(generationPreferences({ outputType: 'audio' }))
    await staleLoad
    await flushPromises()

    expect(store.preferencesByConversation[conversation.id]).toEqual(remotePreferences)
  })

  it('refreshes after a selected tombstone and hydrates the deterministic next visible row', async () => {
    const { api, emitChat } = createEventApi()
    const replacementPreferences = generationPreferences({ outputType: 'video' })
    vi.mocked(api.chat.listConversations).mockResolvedValue({ items: [
      conversationSummary('conv_1', '2026-08-25T00:03:00.000Z'),
      conversationSummary('conv_3', '2026-08-25T00:01:00.000Z'),
    ] })
    vi.mocked(api.chat.listMessages).mockResolvedValue({
      items: [storedMessage('message_3', 'conv_3', 'replacement history')],
    })
    vi.mocked(api.chat.getGenerationPreferences).mockResolvedValue(replacementPreferences)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.conversations = [
      conversationSummary('conv_1', '2026-08-25T00:03:00.000Z'),
      conversationSummary('conv_2', '2026-08-25T00:02:00.000Z'),
      conversationSummary('conv_3', '2026-08-25T00:01:00.000Z'),
    ]
    store.selectedConversationId = 'conv_2'
    store.messagesByConversation.conv_2 = [{ id: 'message_2', role: 'assistant', blocks: [] }]
    store.previousMessageCursorByConversation.conv_2 = 'older-cursor'
    store.ensureSubscriptions()

    emitChat({ type: 'conversation_removed', conversationId: 'conv_2' })
    await flushPromises()

    expect(store.conversations.map(({ id }) => id)).toEqual(['conv_1', 'conv_3'])
    expect(store.selectedConversationId).toBe('conv_3')
    expect(store.messagesByConversation.conv_2).toBeUndefined()
    expect(store.previousMessageCursorByConversation.conv_2).toBeUndefined()
    expect(api.chat.listConversations).toHaveBeenCalledWith({ limit: 50 })
    expect(api.chat.listMessages).toHaveBeenCalledWith({ conversationId: 'conv_3', limit: 100 })
    expect(store.messagesByConversation.conv_3?.map(({ id }) => id)).toEqual(['message_3'])
    expect(store.preferencesByConversation.conv_3).toEqual(replacementPreferences)
  })

  it('refreshes a nonselected tombstone without reloading valid selected data', async () => {
    const { api, emitChat } = createEventApi()
    vi.mocked(api.chat.listConversations).mockResolvedValue({
      items: [conversationSummary('conv_1', '2026-08-25T00:03:00.000Z')],
    })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.conversations = [
      conversationSummary('conv_1', '2026-08-25T00:03:00.000Z'),
      conversationSummary('conv_2', '2026-08-25T00:02:00.000Z'),
    ]
    store.selectedConversationId = 'conv_1'
    store.messagesByConversation.conv_1 = [{ id: 'message_1', role: 'assistant', blocks: [] }]
    store.preferencesByConversation.conv_1 = generationPreferences({ outputType: 'text' })
    store.messagesByConversation.conv_2 = [{ id: 'message_2', role: 'assistant', blocks: [] }]
    store.previousMessageCursorByConversation.conv_2 = 'older-cursor'
    store.ensureSubscriptions()

    emitChat({ type: 'conversation_removed', conversationId: 'conv_2' })
    await flushPromises()

    expect(store.conversations.map(({ id }) => id)).toEqual(['conv_1'])
    expect(store.selectedConversationId).toBe('conv_1')
    expect(store.messagesByConversation.conv_2).toBeUndefined()
    expect(store.previousMessageCursorByConversation.conv_2).toBeUndefined()
    expect(store.messagesByConversation.conv_1?.map(({ id }) => id)).toEqual(['message_1'])
    expect(api.chat.listConversations).toHaveBeenCalledWith({ limit: 50 })
    expect(api.chat.listMessages).not.toHaveBeenCalled()
    expect(api.chat.getGenerationPreferences).not.toHaveBeenCalled()
  })

  it('reschedules current message and preference hydration invalidated by a nonselected tombstone', async () => {
    const { api, emitChat } = createEventApi()
    const oldMessages = deferred<Awaited<ReturnType<DesktopAPI['chat']['listMessages']>>>()
    const oldPreferences = deferred<ConversationGenerationPreferences>()
    vi.mocked(api.chat.listConversations).mockResolvedValue({
      items: [conversationSummary('conv_1', '2026-08-25T00:03:00.000Z')],
    })
    vi.mocked(api.chat.listMessages)
      .mockReturnValueOnce(oldMessages.promise)
      .mockResolvedValueOnce({ items: [storedMessage('new-message', 'conv_1', 'new identity-safe row')] })
    vi.mocked(api.chat.getGenerationPreferences)
      .mockReturnValueOnce(oldPreferences.promise)
      .mockResolvedValueOnce(generationPreferences({ outputType: 'video' }))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.conversations = [
      conversationSummary('conv_1', '2026-08-25T00:03:00.000Z'),
      conversationSummary('conv_2', '2026-08-25T00:02:00.000Z'),
    ]
    store.selectedConversationId = 'conv_1'
    store.ensureSubscriptions()

    const originalHydration = store.selectConversation('conv_1')
    await vi.waitFor(() => {
      expect(api.chat.listMessages).toHaveBeenCalledTimes(1)
      expect(api.chat.getGenerationPreferences).toHaveBeenCalledTimes(1)
    })
    emitChat({ type: 'conversation_removed', conversationId: 'conv_2' })
    await vi.waitFor(() => {
      expect({
        conversations: vi.mocked(api.chat.listConversations).mock.calls.length,
        messages: vi.mocked(api.chat.listMessages).mock.calls.length,
        preferences: vi.mocked(api.chat.getGenerationPreferences).mock.calls.length,
      }).toEqual({ conversations: 1, messages: 2, preferences: 2 })
    })

    oldMessages.resolve({ items: [storedMessage('old-message', 'conv_1', 'stale row')] })
    oldPreferences.resolve(generationPreferences({ outputType: 'audio' }))
    await originalHydration
    await flushPromises()
    expect(store.messagesByConversation.conv_1?.map(({ id }) => id)).toEqual(['new-message'])
    expect(store.preferencesByConversation.conv_1?.outputType).toBe('video')
  })

  it('reissues only an invalidated older page without replacing loaded history', async () => {
    const { api, emitChat } = createEventApi()
    const staleOlderPage = deferred<Awaited<ReturnType<DesktopAPI['chat']['listMessages']>>>()
    const cursor = 'older-cursor'
    vi.mocked(api.chat.listConversations).mockResolvedValue({
      items: [conversationSummary('conv_1', '2026-08-25T00:03:00.000Z')],
    })
    vi.mocked(api.chat.listMessages)
      .mockReturnValueOnce(staleOlderPage.promise)
      .mockResolvedValueOnce({
        items: [storedMessage('replacement-older', 'conv_1', 'replacement older row')],
        previousCursor: 'next-older-cursor',
      })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.conversations = [
      conversationSummary('conv_1', '2026-08-25T00:03:00.000Z'),
      conversationSummary('conv_2', '2026-08-25T00:02:00.000Z'),
    ]
    store.selectedConversationId = 'conv_1'
    store.messagesByConversation.conv_1 = [{ id: 'loaded-newest', role: 'assistant', blocks: [] }]
    store.previousMessageCursorByConversation.conv_1 = cursor
    store.preferencesByConversation.conv_1 = generationPreferences({ outputType: 'text' })
    store.ensureSubscriptions()

    const staleRequest = store.loadOlderMessages('conv_1')
    await vi.waitFor(() => expect(api.chat.listMessages).toHaveBeenCalledOnce())
    emitChat({ type: 'conversation_removed', conversationId: 'conv_2' })
    await vi.waitFor(() => expect(api.chat.listMessages).toHaveBeenCalledTimes(2))
    staleOlderPage.reject(new Error('stale older request failed'))
    await staleRequest
    await flushPromises()

    expect(api.chat.listMessages).toHaveBeenNthCalledWith(1, {
      conversationId: 'conv_1', limit: 100, cursor,
    })
    expect(api.chat.listMessages).toHaveBeenNthCalledWith(2, {
      conversationId: 'conv_1', limit: 100, cursor,
    })
    expect(store.messagesByConversation.conv_1?.map(({ id }) => id))
      .toEqual(['replacement-older', 'loaded-newest'])
    expect(store.previousMessageCursorByConversation.conv_1).toBe('next-older-cursor')
    expect(api.chat.getGenerationPreferences).not.toHaveBeenCalled()
    expect(store.error).toBe('')
  })

  it('reissues invalidated latest before older and keeps replacement markers token-owned', async () => {
    const { api, emitChat } = createEventApi()
    const staleLatest = deferred<Awaited<ReturnType<DesktopAPI['chat']['listMessages']>>>()
    const staleOlder = deferred<Awaited<ReturnType<DesktopAPI['chat']['listMessages']>>>()
    const replacementOlder = deferred<Awaited<ReturnType<DesktopAPI['chat']['listMessages']>>>()
    const cursor = 'shared-older-cursor'
    vi.mocked(api.chat.listConversations).mockResolvedValue({
      items: [conversationSummary('conv_1', '2026-08-25T00:03:00.000Z')],
    })
    vi.mocked(api.chat.listMessages)
      .mockReturnValueOnce(staleLatest.promise)
      .mockReturnValueOnce(staleOlder.promise)
      .mockResolvedValueOnce({
        items: [storedMessage('replacement-newest', 'conv_1', 'replacement newest row')],
        previousCursor: cursor,
      })
      .mockReturnValueOnce(replacementOlder.promise)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.conversations = [
      conversationSummary('conv_1', '2026-08-25T00:03:00.000Z'),
      conversationSummary('conv_2', '2026-08-25T00:02:00.000Z'),
    ]
    store.selectedConversationId = 'conv_1'
    store.messagesByConversation.conv_1 = [{ id: 'loaded-newest', role: 'assistant', blocks: [] }]
    store.previousMessageCursorByConversation.conv_1 = cursor
    store.preferencesByConversation.conv_1 = generationPreferences({ outputType: 'text' })
    store.ensureSubscriptions()

    const staleLatestRequest = store.loadMessages('conv_1')
    const staleOlderRequest = store.loadOlderMessages('conv_1')
    await vi.waitFor(() => expect(api.chat.listMessages).toHaveBeenCalledTimes(2))
    emitChat({ type: 'conversation_removed', conversationId: 'conv_2' })
    await vi.waitFor(() => expect(api.chat.listMessages).toHaveBeenCalledTimes(4))

    expect(api.chat.listMessages).toHaveBeenNthCalledWith(3, {
      conversationId: 'conv_1', limit: 100,
    })
    expect(api.chat.listMessages).toHaveBeenNthCalledWith(4, {
      conversationId: 'conv_1', limit: 100, cursor,
    })
    staleLatest.resolve({ items: [storedMessage('stale-latest', 'conv_1', 'stale latest row')] })
    staleOlder.reject(new Error('stale older request failed'))
    await Promise.all([staleLatestRequest, staleOlderRequest])
    await store.loadOlderMessages('conv_1')
    expect(api.chat.listMessages).toHaveBeenCalledTimes(4)

    replacementOlder.resolve({
      items: [storedMessage('replacement-older', 'conv_1', 'replacement older row')],
    })
    await flushPromises()
    expect(store.messagesByConversation.conv_1?.map(({ id }) => id))
      .toEqual(['replacement-older', 'replacement-newest'])
    expect(store.error).toBe('')
  })

  it('clears selection and conversation state when a removed selected row has no replacement', async () => {
    const { api, emitChat } = createEventApi()
    vi.mocked(api.chat.listConversations).mockResolvedValue({ items: [] })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.conversations = [conversationSummary('conv_1', '2026-08-25T00:03:00.000Z')]
    store.selectedConversationId = 'conv_1'
    store.messagesByConversation.conv_1 = [{ id: 'message_1', role: 'assistant', blocks: [] }]
    store.draftsByConversation.conv_1 = [mediaAsset('draft_1')]
    store.preferencesByConversation.conv_1 = generationPreferences({ outputType: 'image' })
    store.ensureSubscriptions()

    emitChat({ type: 'conversation_removed', conversationId: 'conv_1' })
    await flushPromises()

    expect(store.conversations).toEqual([])
    expect(store.selectedConversationId).toBe('')
    expect(store.messagesByConversation.conv_1).toBeUndefined()
    expect(store.draftsByConversation.conv_1).toBeUndefined()
    expect(store.preferencesByConversation.conv_1).toBeUndefined()
    expect(api.chat.listMessages).not.toHaveBeenCalled()
    expect(api.chat.getGenerationPreferences).not.toHaveBeenCalled()
  })

  it('lets only the newest consecutive removal refresh hydrate its replacement', async () => {
    const { api, emitChat } = createEventApi()
    const stalePage = deferred<Awaited<ReturnType<DesktopAPI['chat']['listConversations']>>>()
    const currentPage = deferred<Awaited<ReturnType<DesktopAPI['chat']['listConversations']>>>()
    vi.mocked(api.chat.listConversations)
      .mockReturnValueOnce(stalePage.promise)
      .mockReturnValueOnce(currentPage.promise)
    vi.mocked(api.chat.listMessages).mockResolvedValue({
      items: [storedMessage('message_3', 'conv_3', 'current replacement')],
    })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.conversations = [
      conversationSummary('conv_1', '2026-08-25T00:03:00.000Z'),
      conversationSummary('conv_2', '2026-08-25T00:02:00.000Z'),
      conversationSummary('conv_3', '2026-08-25T00:01:00.000Z'),
    ]
    store.selectedConversationId = 'conv_1'
    store.ensureSubscriptions()

    emitChat({ type: 'conversation_removed', conversationId: 'conv_1' })
    emitChat({ type: 'conversation_removed', conversationId: 'conv_2' })
    expect(api.chat.listConversations).toHaveBeenCalledTimes(2)
    stalePage.resolve({ items: [conversationSummary('stale-row', '2026-08-25T00:04:00.000Z')] })
    await flushPromises()
    currentPage.resolve({ items: [conversationSummary('conv_3', '2026-08-25T00:01:00.000Z')] })
    await flushPromises()

    expect(store.conversations.map(({ id }) => id)).toEqual(['conv_3'])
    expect(store.selectedConversationId).toBe('conv_3')
    expect(store.messagesByConversation.conv_3?.map(({ id }) => id)).toEqual(['message_3'])
    expect(api.chat.listMessages).toHaveBeenCalledTimes(1)
    expect(api.chat.listMessages).toHaveBeenCalledWith({ conversationId: 'conv_3', limit: 100 })
  })

  it('does not let removal refresh work apply after an identity reset', async () => {
    const { api, emitChat } = createEventApi()
    const stalePage = deferred<Awaited<ReturnType<DesktopAPI['chat']['listConversations']>>>()
    vi.mocked(api.chat.listConversations).mockReturnValue(stalePage.promise)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.conversations = [
      conversationSummary('old-selected', '2026-08-25T00:03:00.000Z'),
      conversationSummary('old-replacement', '2026-08-25T00:02:00.000Z'),
    ]
    store.selectedConversationId = 'old-selected'
    store.ensureSubscriptions()

    emitChat({ type: 'conversation_removed', conversationId: 'old-selected' })
    expect(api.chat.listConversations).toHaveBeenCalledOnce()
    store.resetLocalData()
    store.conversations = [conversationSummary('new-selected', '2026-08-25T00:04:00.000Z')]
    store.selectedConversationId = 'new-selected'
    store.messagesByConversation['new-selected'] = [{ id: 'new-message', role: 'assistant', blocks: [] }]
    store.preferencesByConversation['new-selected'] = generationPreferences({ outputType: 'text' })
    stalePage.reject(new Error('old identity refresh failed'))
    await flushPromises()

    expect(store.conversations.map(({ id }) => id)).toEqual(['new-selected'])
    expect(store.selectedConversationId).toBe('new-selected')
    expect(store.messagesByConversation['new-selected']?.map(({ id }) => id)).toEqual(['new-message'])
    expect(store.error).toBe('')
    expect(api.chat.listMessages).not.toHaveBeenCalled()
    expect(api.chat.getGenerationPreferences).not.toHaveBeenCalled()
  })

  it('does not let a loading snapshot overwrite a newer streamed delta', async () => {
    const { api, emitChat } = createEventApi()
    let resolveMessages!: (value: Awaited<ReturnType<DesktopAPI['chat']['listMessages']>>) => void
    vi.mocked(api.chat.listConversations).mockResolvedValue({ items: [{
      id: 'conv_1', title: '真实会话', createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:00.000Z', lastActivityAt: '2026-07-19T00:00:00.000Z',
      revision: 1, syncState: 'synced',
    }] })
    vi.mocked(api.chat.listMessages).mockReturnValue(new Promise((resolve) => { resolveMessages = resolve }))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    const loading = store.loadConversations()
    await vi.waitFor(() => expect(api.chat.listMessages).toHaveBeenCalledWith({ conversationId: 'conv_1', limit: 100 }))
    emitChat({ type: 'block', conversationId: 'conv_1', messageId: 'live_1', block: { type: 'text', text: '实时内容' } })
    resolveMessages({ items: [{ id: 'old_1', conversationId: 'conv_1', role: 'assistant', blocks: [{ type: 'text', text: '旧快照' }], createdAt: '2026-07-19T00:00:00.000Z' }] })
    await loading
    expect(store.messagesByConversation.conv_1?.map(({ id }) => id)).toEqual(['old_1', 'live_1'])
  })

  it('appends a live text delta to the persisted prefix for the same loading message', async () => {
    const { api, emitChat } = createEventApi()
    let resolveMessages!: (value: Awaited<ReturnType<DesktopAPI['chat']['listMessages']>>) => void
    vi.mocked(api.chat.listMessages).mockReturnValue(new Promise((resolve) => { resolveMessages = resolve }))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.ensureSubscriptions()
    const loading = store.selectConversation('conv_1')
    await vi.waitFor(() => expect(api.chat.listMessages).toHaveBeenCalledWith({ conversationId: 'conv_1', limit: 100 }))

    emitChat({
      type: 'block',
      conversationId: 'conv_1',
      messageId: 'assistant_1',
      block: { type: 'text', text: '新增' },
    })
    resolveMessages({ items: [{
      id: 'assistant_1',
      conversationId: 'conv_1',
      role: 'assistant',
      blocks: [{ type: 'text', text: '已有' }],
      createdAt: '2026-07-25T00:00:00.000Z',
    }] })
    await loading

    expect(store.messagesByConversation.conv_1?.[0]?.blocks).toEqual([
      expect.objectContaining({ id: 'assistant_1:text:0', type: 'text', text: '已有新增' }),
    ])
  })

  it('does not duplicate a live delta already included in the persisted snapshot', async () => {
    const { api, emitChat } = createEventApi()
    let resolveMessages!: (value: Awaited<ReturnType<DesktopAPI['chat']['listMessages']>>) => void
    vi.mocked(api.chat.listMessages).mockReturnValue(new Promise((resolve) => { resolveMessages = resolve }))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.ensureSubscriptions()
    const loading = store.selectConversation('conv_1')
    await vi.waitFor(() => expect(api.chat.listMessages).toHaveBeenCalledWith({ conversationId: 'conv_1', limit: 100 }))

    emitChat({
      type: 'block',
      conversationId: 'conv_1',
      messageId: 'assistant_1',
      block: { type: 'text', text: '新增' },
    })
    resolveMessages({ items: [{
      id: 'assistant_1',
      conversationId: 'conv_1',
      role: 'assistant',
      blocks: [{ type: 'text', text: '已有新增' }],
      createdAt: '2026-07-25T00:00:00.000Z',
    }] })
    await loading

    expect(store.messagesByConversation.conv_1?.[0]?.blocks).toEqual([
      expect.objectContaining({ id: 'assistant_1:text:0', type: 'text', text: '已有新增' }),
    ])
  })

  it('aligns live text before a stable media anchor without duplicating snapshot content', async () => {
    const { api, emitChat } = createEventApi()
    let resolveMessages!: (value: Awaited<ReturnType<DesktopAPI['chat']['listMessages']>>) => void
    vi.mocked(api.chat.listMessages).mockReturnValue(new Promise((resolve) => { resolveMessages = resolve }))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.ensureSubscriptions()
    const loading = store.selectConversation('conv_1')
    await vi.waitFor(() => expect(api.chat.listMessages).toHaveBeenCalledWith({ conversationId: 'conv_1', limit: 100 }))

    emitChat({
      type: 'block',
      conversationId: 'conv_1',
      messageId: 'assistant_1',
      block: { type: 'text', text: 'A' },
    })
    emitChat({
      type: 'block',
      conversationId: 'conv_1',
      messageId: 'assistant_1',
      block: {
        type: 'media_generation',
        blockId: 'media_1',
        jobId: 'job_1',
        kind: 'image',
        status: 'pending',
      },
    })
    resolveMessages({ items: [{
      id: 'assistant_1',
      conversationId: 'conv_1',
      role: 'assistant',
      blocks: [
        { type: 'text', text: 'A' },
        {
          type: 'media_generation',
          blockId: 'media_1',
          jobId: 'job_1',
          kind: 'image',
          status: 'pending',
        },
      ],
      createdAt: '2026-07-25T00:00:00.000Z',
    }] })
    await loading

    expect(store.messagesByConversation.conv_1?.[0]?.blocks).toEqual([
      expect.objectContaining({ id: 'assistant_1:text:0', type: 'text', text: 'A' }),
      expect.objectContaining({
        id: 'assistant_1:media_1',
        type: 'media_generation',
        blockId: 'media_1',
      }),
    ])
  })

  it('appends only the non-overlapping suffix of an accumulated live text delta', async () => {
    const { api, emitChat } = createEventApi()
    let resolveMessages!: (value: Awaited<ReturnType<DesktopAPI['chat']['listMessages']>>) => void
    vi.mocked(api.chat.listMessages).mockReturnValue(new Promise((resolve) => { resolveMessages = resolve }))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.ensureSubscriptions()
    const loading = store.selectConversation('conv_1')
    await vi.waitFor(() => expect(api.chat.listMessages).toHaveBeenCalledWith({ conversationId: 'conv_1', limit: 100 }))

    emitChat({
      type: 'block',
      conversationId: 'conv_1',
      messageId: 'assistant_1',
      block: { type: 'text', text: 'AB' },
    })
    resolveMessages({ items: [{
      id: 'assistant_1',
      conversationId: 'conv_1',
      role: 'assistant',
      blocks: [{ type: 'text', text: '已有A' }],
      createdAt: '2026-07-25T00:00:00.000Z',
    }] })
    await loading

    expect(store.messagesByConversation.conv_1?.[0]?.blocks).toEqual([
      expect.objectContaining({ id: 'assistant_1:text:0', type: 'text', text: '已有AB' }),
    ])
  })

  it('appends live text after a persisted non-text block using its final position', async () => {
    const { api, emitChat } = createEventApi()
    let resolveMessages!: (value: Awaited<ReturnType<DesktopAPI['chat']['listMessages']>>) => void
    vi.mocked(api.chat.listMessages).mockReturnValue(new Promise((resolve) => { resolveMessages = resolve }))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.ensureSubscriptions()
    const loading = store.selectConversation('conv_1')
    await vi.waitFor(() => expect(api.chat.listMessages).toHaveBeenCalledWith({ conversationId: 'conv_1', limit: 100 }))

    emitChat({
      type: 'block',
      conversationId: 'conv_1',
      messageId: 'assistant_1',
      block: { type: 'text', text: '生成完成' },
    })
    resolveMessages({ items: [{
      id: 'assistant_1',
      conversationId: 'conv_1',
      role: 'assistant',
      blocks: [{
        type: 'media_generation',
        blockId: 'media_1',
        jobId: 'job_1',
        kind: 'image',
        status: 'pending',
      }],
      createdAt: '2026-07-25T00:00:00.000Z',
    }] })
    await loading

    expect(store.messagesByConversation.conv_1?.[0]?.blocks).toEqual([
      expect.objectContaining({
        id: 'assistant_1:media_1',
        type: 'media_generation',
        blockId: 'media_1',
      }),
      expect.objectContaining({
        id: 'assistant_1:text:1',
        type: 'text',
        text: '生成完成',
      }),
    ])
  })

  it('ignores a late message response after switching conversations', async () => {
    const { api } = createEventApi()
    let resolveFirst!: (value: Awaited<ReturnType<DesktopAPI['chat']['listMessages']>>) => void
    vi.mocked(api.chat.listMessages)
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve }))
      .mockResolvedValueOnce({ items: [{ id: 'm2', conversationId: 'conv_2', role: 'assistant', blocks: [{ type: 'text', text: '第二个会话' }], createdAt: '2026-07-19T00:00:00.000Z' }] })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    const first = store.selectConversation('conv_1')
    await vi.waitFor(() => expect(api.chat.listMessages).toHaveBeenCalledWith({ conversationId: 'conv_1', limit: 100 }))
    await store.selectConversation('conv_2')
    resolveFirst({ items: [{ id: 'm1', conversationId: 'conv_1', role: 'assistant', blocks: [{ type: 'text', text: '迟到响应' }], createdAt: '2026-07-19T00:00:00.000Z' }] })
    await first
    expect(store.selectedConversationId).toBe('conv_2')
    expect(store.messagesByConversation.conv_1).toBeUndefined()
    expect(store.messagesByConversation.conv_2?.[0]?.blocks[0]).toMatchObject({ text: '第二个会话' })
  })

  it('enters running state before Main accepts and cancels as soon as the request ID arrives', async () => {
    const { api, emitChat } = createEventApi()
    let resolveSend!: (value: { requestId: string }) => void
    vi.mocked(api.chat.send).mockReturnValue(new Promise((resolve) => { resolveSend = resolve }))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.selectedConversationId = 'conv_1'
    store.ensureSubscriptions()

    const sending = store.send({
      content: '立即显示取消',
      assetIds: [],
      outputType: 'text',
      generation: generationPreferences().generation,
    })

    expect(store.isRunning).toBe(true)
    await store.cancelCurrent()
    expect(api.chat.cancel).not.toHaveBeenCalled()

    resolveSend({ requestId: 'req_pending' })
    await sending

    expect(api.chat.cancel).toHaveBeenCalledWith('req_pending')
    expect(store.isRunning).toBe(true)
    emitChat({
      type: 'status',
      conversationId: 'conv_1',
      requestId: 'req_pending',
      status: 'cancelled',
    })
    expect(store.isRunning).toBe(false)
  })

  it('moves optimistic sends and terminal replies to the top with pending sync state', async () => {
    const { api, emitChat } = createEventApi()
    const pendingSend = deferred<{ requestId: string }>()
    vi.mocked(api.chat.send).mockReturnValue(pendingSend.promise)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.conversations = [
      {
        id: 'conv_newer', title: 'Newer', titleState: 'user_named', revision: 1,
        syncState: 'synced', createdAt: '2026-08-25T00:00:00.000Z',
        lastActivityAt: '2026-08-25T00:01:00.000Z',
        metadataUpdatedAt: '2026-08-25T00:01:00.000Z',
      },
      {
        id: 'conv_target', title: 'Target', titleState: 'user_named', revision: 1,
        syncState: 'synced', createdAt: '2026-08-25T00:00:00.000Z',
        lastActivityAt: '2026-08-25T00:00:00.000Z',
        metadataUpdatedAt: '2026-08-25T00:00:00.000Z',
      },
    ]
    store.selectedConversationId = 'conv_target'
    store.ensureSubscriptions()

    const sending = store.send({
      content: 'Move now', assetIds: [], outputType: 'text',
      generation: generationPreferences().generation,
    })

    expect(store.conversations[0]).toMatchObject({ id: 'conv_target', syncState: 'pending' })
    expect(store.conversations[0]!.lastActivityAt)
      .not.toBe('2026-08-25T00:00:00.000Z')
    pendingSend.resolve({ requestId: 'request_target' })
    await sending
    const optimisticActivity = store.conversations[0]!.lastActivityAt

    emitChat({
      type: 'status', conversationId: 'conv_target', requestId: 'request_target', status: 'completed',
    })

    expect(store.conversations[0]).toMatchObject({ id: 'conv_target', syncState: 'pending' })
    expect(store.conversations[0]!.lastActivityAt >= optimisticActivity).toBe(true)
  })

  it('awaits the first assistant block from the moment a valid send starts', async () => {
    const { api, emitChat } = createEventApi()
    let resolveSend!: (value: { requestId: string }) => void
    vi.mocked(api.chat.send).mockReturnValue(new Promise((resolve) => { resolveSend = resolve }))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.selectedConversationId = 'conv_1'
    store.ensureSubscriptions()

    const sending = store.send({
      content: '立即显示 Loader',
      assetIds: [],
      outputType: 'text',
      generation: generationPreferences().generation,
    })

    expect(store.isAwaitingResponse).toBe(true)
    emitChat({
      type: 'status',
      conversationId: 'conv_1',
      requestId: 'req_loader',
      status: 'running',
    })
    expect(store.isAwaitingResponse).toBe(true)

    emitChat({
      type: 'block',
      conversationId: 'conv_1',
      messageId: 'assistant_loader',
      block: { type: 'text', text: '第一段回复' },
    })
    expect(store.isAwaitingResponse).toBe(false)

    emitChat({
      type: 'status',
      conversationId: 'conv_1',
      requestId: 'req_loader',
      status: 'completed',
    })
    resolveSend({ requestId: 'req_loader' })
    await sending
  })

  it.each(['completed', 'cancelled', 'failed'] as const)(
    'clears awaiting response on content-free %s before send returns',
    async (status) => {
      const { api, emitChat } = createEventApi()
      let resolveSend!: (value: { requestId: string }) => void
      vi.mocked(api.chat.send).mockReturnValue(new Promise((resolve) => { resolveSend = resolve }))
      Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
      const store = useChatStore()
      store.selectedConversationId = 'conv_1'
      store.ensureSubscriptions()

      const sending = store.send({
        content: '无内容终止',
        assetIds: [],
        outputType: 'text',
        generation: generationPreferences().generation,
      })
      expect(store.isAwaitingResponse).toBe(true)

      emitChat({
        type: 'status',
        conversationId: 'conv_1',
        requestId: `req_${status}`,
        status,
      })
      expect(store.isAwaitingResponse).toBe(false)

      resolveSend({ requestId: `req_${status}` })
      await sending
    },
  )

  it('clears awaiting response when the first event is a block update', () => {
    const { api, emitChat } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.selectedConversationId = 'conv_1'
    store.awaitingResponseByConversation.conv_1 = true
    store.ensureSubscriptions()

    emitChat({
      type: 'block_update',
      conversationId: 'conv_1',
      messageId: 'assistant_media',
      blockId: 'media_1',
      block: {
        type: 'media_generation',
        blockId: 'media_1',
        jobId: 'job_1',
        kind: 'image',
        status: 'in_progress',
      },
    })

    expect(store.isAwaitingResponse).toBe(false)
  })

  it('keeps awaiting-response state isolated and clears it on local reset', () => {
    const store = useChatStore()
    store.awaitingResponseByConversation.conversation_a = true
    store.selectedConversationId = 'conversation_a'
    expect(store.isAwaitingResponse).toBe(true)

    store.selectedConversationId = 'conversation_b'
    expect(store.isAwaitingResponse).toBe(false)

    store.resetLocalData()
    expect(store.awaitingResponseByConversation).toEqual({})
  })

  it('clears pending request and cancellation intent when Main rejects', async () => {
    const { api } = createEventApi()
    let rejectSend!: (error: Error) => void
    vi.mocked(api.chat.send).mockReturnValue(new Promise((_resolve, reject) => { rejectSend = reject }))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.selectedConversationId = 'conv_1'

    const sending = store.send({
      content: '会被拒绝',
      assetIds: [],
      outputType: 'text',
      generation: generationPreferences().generation,
    })
    await store.cancelCurrent()
    expect(store.isRunning).toBe(true)
    expect(store.isAwaitingResponse).toBe(true)

    rejectSend(new Error('rejected'))
    expect(await sending).toBe(false)

    expect(store.isRunning).toBe(false)
    expect(store.isAwaitingResponse).toBe(false)
    expect(store.pendingRequestByConversation.conv_1).toBeUndefined()
    expect(store._cancelRequestedByConversation.conv_1).toBeUndefined()
    expect(api.chat.cancel).not.toHaveBeenCalled()
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
    expect(store.isRunning).toBe(true)
    await store.cancelCurrent()
    expect(api.chat.cancel).not.toHaveBeenCalled()

    emitChat({ type: 'status', conversationId: 'conv_1', requestId: 'req_fast', status: 'completed' })
    resolveSend({ requestId: 'req_fast' })
    await sending

    expect(api.chat.cancel).not.toHaveBeenCalled()
    expect(store.isRunning).toBe(false)
  })

  it('does not resurrect a pending request cancelled after its running event', async () => {
    const { api, emitChat } = createEventApi()
    let resolveSend!: (value: { requestId: string }) => void
    vi.mocked(api.chat.send).mockReturnValue(new Promise((resolve) => { resolveSend = resolve }))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.selectedConversationId = 'conv_1'
    store.ensureSubscriptions()

    const sending = store.send({
      content: '运行后取消',
      assetIds: [],
      outputType: 'text',
      generation: generationPreferences().generation,
    })
    emitChat({ type: 'status', conversationId: 'conv_1', requestId: 'req_race', status: 'running' })
    await store.cancelCurrent()
    expect(api.chat.cancel).toHaveBeenCalledWith('req_race')
    emitChat({ type: 'status', conversationId: 'conv_1', requestId: 'req_race', status: 'cancelled' })

    resolveSend({ requestId: 'req_race' })
    await sending

    expect(store.isRunning).toBe(false)
  })

  it('does not resurrect a media request that failed before send returned', async () => {
    const { api, emitChat } = createEventApi()
    let resolveSend!: (value: { requestId: string }) => void
    vi.mocked(api.chat.send).mockReturnValue(new Promise((resolve) => { resolveSend = resolve }))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.selectedConversationId = 'conv_1'
    store.ensureSubscriptions()

    const sending = store.send({
      content: '生成图片',
      assetIds: [],
      outputType: 'image',
      generation: generationPreferences().generation,
    })
    emitChat({
      type: 'status',
      conversationId: 'conv_1',
      requestId: 'req_media_start_failed',
      status: 'failed',
      error: {
        code: 'MEDIA_GENERATION_FAILED',
        message: 'The media generation failed.',
      },
    })
    resolveSend({ requestId: 'req_media_start_failed' })
    await sending

    expect(store.isRunning).toBe(false)
    expect(store.error).toBe('媒体生成失败')
  })

  it('maps asynchronous provider failures to actionable localized chat errors', () => {
    const { api, emitChat } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.selectedConversationId = 'conv_1'
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
    store.selectedConversationId = 'conv_1'
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

  it('drops a previous user event that was queued before local auth state reset', () => {
    const { api, chatUnsubscribe, queueChat } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.conversations = [{
      id: 'alice_conversation',
      title: 'Alice',
      createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:00.000Z',
    }]
    store.ensureSubscriptions()
    const deliverQueuedAliceEvent = queueChat({
      type: 'block',
      conversationId: 'alice_conversation',
      messageId: 'alice_message',
      block: { type: 'text', text: 'Alice private message' },
    })

    store.resetLocalData()
    expect(chatUnsubscribe).toHaveBeenCalledTimes(1)
    store.conversations = [{
      id: 'bob_conversation',
      title: 'Bobby',
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:00.000Z',
    }]
    store.ensureSubscriptions()
    deliverQueuedAliceEvent()

    expect(store.messagesByConversation.alice_conversation).toBeUndefined()
  })

  it('trims composer input, honors IME, and uses Shift+Enter for a newline', async () => {
    useChatStore().selectedConversationId = 'conversation_1'
    const wrapper = mount(ChatComposer, {
      props: {
        disabled: false,
        running: false,
        models: [modelInfo('text/model', ['text'])],
        defaultModel: 'text/model',
      },
      global: { plugins: [ElementPlus] },
    })
    const textarea = wrapper.get('textarea')
    await textarea.setValue('  查询天气  ')
    await textarea.trigger('compositionstart')
    await textarea.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('submit')).toBeUndefined()
    await textarea.trigger('compositionend')
    await textarea.trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(wrapper.emitted('submit')).toBeUndefined()
    await textarea.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('submit')?.[0]?.[0]).toEqual({
      content: '查询天气',
      assetIds: [],
      outputType: 'auto',
      generation: generationPreferences().generation,
      model: 'text/model',
    })
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

  it('updates workflow status and provenance by Main-owned block id while preserving event order', () => {
    const { api, emitChat } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.ensureSubscriptions()
    const { id: queuedId, ...queued } = workflowStatusBlock('queued')
    const { id: completedId, ...completed } = workflowStatusBlock('completed')
    const firstProvenance = workflowProvenanceBlock([{
      executionId: 'execution_1', workflowId: 'workflow.beijing',
      workflowName: '北京工作居住证', workflowVersion: '1.0.0',
      source: 'development', buildHash, city: '北京', status: 'running',
    }])
    const finalProvenance = workflowProvenanceBlock([{
      ...firstProvenance.entries[0]!, status: 'completed',
    }])
    const { id: firstProvenanceId, ...firstProvenanceBlock } = firstProvenance
    const { id: finalProvenanceId, ...finalProvenanceBlock } = finalProvenance
    void queuedId; void completedId; void firstProvenanceId; void finalProvenanceId

    emitChat({
      type: 'block', conversationId: 'conv_1', messageId: 'assistant_1',
      block: { type: 'text', text: '前文' },
    })
    emitChat({ type: 'block', conversationId: 'conv_1', messageId: 'assistant_1', block: queued })
    emitChat({ type: 'block', conversationId: 'conv_1', messageId: 'assistant_1', block: completed })
    emitChat({ type: 'block', conversationId: 'conv_1', messageId: 'assistant_1', block: firstProvenanceBlock })
    emitChat({ type: 'block', conversationId: 'conv_1', messageId: 'assistant_1', block: finalProvenanceBlock })

    expect(store.messagesByConversation.conv_1?.[0]?.blocks).toEqual([
      expect.objectContaining({ type: 'text', text: '前文' }),
      expect.objectContaining({
        id: 'assistant_1:workflow_status_1', blockId: 'workflow_status_1', status: 'completed',
      }),
      expect.objectContaining({
        id: 'assistant_1:workflow_provenance_1', blockId: 'workflow_provenance_1',
        entries: [expect.objectContaining({ status: 'completed' })],
      }),
    ])
  })

  it('keeps conversation locking and cancellation ownership while workflow blocks update', async () => {
    const { api, emitChat } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.selectedConversationId = 'conv_1'
    store.activeRequestByConversation.conv_1 = 'request_1'
    store.ensureSubscriptions()
    const { id, ...running } = workflowStatusBlock('running')
    void id

    emitChat({ type: 'block', conversationId: 'conv_1', messageId: 'assistant_1', block: running })
    expect(store.isRunning).toBe(true)
    await store.cancelCurrent()
    expect(api.chat.cancel).toHaveBeenCalledWith('request_1')
    expect(store.isRunning).toBe(true)
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
    expect(store.preferencesByConversation.conv_1).toBeUndefined()

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
    await vi.waitFor(() => {
      expect(api.media.importDroppedFiles).toHaveBeenCalledWith({
        conversationId: 'conversation_1',
        existingAssetIds: ['picked'],
      }, [droppedFile])
    })

    const getAsFile = vi.fn()
    await wrapper.get('textarea').trigger('paste', {
      clipboardData: { items: [{ type: 'image/png', getAsFile }] },
    })
    await vi.waitFor(() => {
      expect(api.media.importClipboardImage).toHaveBeenCalledWith({
        conversationId: 'conversation_1',
        existingAssetIds: ['picked', 'dropped'],
      })
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
    await vi.waitFor(() => {
      expect(api.media.removeDraft).toHaveBeenCalledWith({
        conversationId: 'conversation_1',
        assetId: '1',
      })
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

  it('refreshes OpenRouter video capabilities after changing models', async () => {
    const { api } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const chat = useChatStore()
    chat.conversations = [{
      id: 'conversation_1', title: 'Video',
      createdAt: '2026-08-18T00:00:00.000Z', updatedAt: '2026-08-18T00:00:00.000Z',
    }]
    chat.selectedConversationId = 'conversation_1'
    chat.preferencesByConversation.conversation_1 = generationPreferences({
      outputType: 'video',
      models: { video: 'video/model-one' },
    })
    const settings = useSettingsStore()
    settings.settings = {
      theme: 'system', language: 'zh-CN', dataDirectory: '/data', logDirectory: '/logs',
      activeProvider: 'openrouter',
      defaultModels: { deepseek: { text: 'deepseek-chat' }, openrouter: { video: 'video/model-one' } },
      showCosts: false, developerMode: false, permissionDefault: 'ask',
      proxy: { enabled: false, bypassDomains: [] },
    }
    const first = modelInfo('video/model-one', ['video'])
    const refreshed = {
      ...modelInfo('video/model-two', ['video']),
      generation: {
        video: {
          resolutions: ['4K'],
          aspectRatios: ['9:16'],
          durations: [4, 8],
          supportsAudio: false,
          frameImages: ['first_frame', 'last_frame'] as const,
        },
      },
    } satisfies ModelInfo
    settings.providerModels.openrouter = [first, modelInfo('video/model-two', ['video'])]
    vi.mocked(api.settings.listProviderModels).mockResolvedValue([first, refreshed])
    const wrapper = mount(ChatView, { global: { plugins: [ElementPlus] } })

    await wrapper.get('[data-testid="model-select"]').setValue('video/model-two')
    await vi.waitFor(() => {
      expect(api.settings.listProviderModels).toHaveBeenCalledWith('openrouter', true)
      expect(chat.preferences.models.video).toBe('video/model-two')
    })

    expect(wrapper.findAll('[data-testid="video-duration"] option').map((option) => option.text()))
      .toEqual(['4 秒', '8 秒'])
    expect(wrapper.findAll('[data-testid="video-resolution"] option').map((option) => option.text()))
      .toEqual(['4K'])
    expect(wrapper.findAll('[data-testid="video-aspect-ratio"] option').map((option) => option.text()))
      .toEqual(['9:16'])
    expect(wrapper.find('[data-testid="video-generate-audio"]').exists()).toBe(false)
  })

  it('keeps cached video capabilities and shows an error when refresh fails', async () => {
    const { api } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const chat = useChatStore()
    chat.conversations = [{
      id: 'conversation_1', title: 'Video',
      createdAt: '2026-08-18T00:00:00.000Z', updatedAt: '2026-08-18T00:00:00.000Z',
    }]
    chat.selectedConversationId = 'conversation_1'
    chat.preferencesByConversation.conversation_1 = generationPreferences({
      outputType: 'video',
      models: { video: 'video/model-one' },
    })
    const settings = useSettingsStore()
    settings.settings = {
      theme: 'system', language: 'zh-CN', dataDirectory: '/data', logDirectory: '/logs',
      activeProvider: 'openrouter',
      defaultModels: { deepseek: { text: 'deepseek-chat' }, openrouter: { video: 'video/model-one' } },
      showCosts: false, developerMode: false, permissionDefault: 'ask',
      proxy: { enabled: false, bypassDomains: [] },
    }
    const cached = [modelInfo('video/model-one', ['video']), modelInfo('video/model-two', ['video'])]
    settings.providerModels.openrouter = cached
    vi.mocked(api.settings.listProviderModels).mockRejectedValue(new Error('raw provider body'))
    const wrapper = mount(ChatView, { global: { plugins: [ElementPlus] } })

    await wrapper.get('[data-testid="model-select"]').setValue('video/model-two')
    await vi.waitFor(() => {
      expect(api.settings.listProviderModels).toHaveBeenCalledWith('openrouter', true)
      expect(chat.preferences.models.video).toBe('video/model-two')
      expect(wrapper.get('[role="alert"]').text()).toContain('模型列表加载失败')
    })

    expect(settings.providerModels.openrouter).toEqual(cached)
    expect(wrapper.findAll('[data-testid="video-duration"] option').map((option) => option.text()))
      .toEqual(['5 秒', '10 秒'])
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
      props: {
        disabled: false,
        running: false,
        models: [modelInfo('text/model', ['text']), modelInfo('image/model', ['image'])],
        defaultModel: '',
      },
      global: { plugins: [ElementPlus] },
    })

    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('submit')?.[0]?.[0]).toEqual({
      content: '',
      assetIds: ['asset_1'],
      outputType: 'text',
      generation: generationPreferences().generation,
      model: 'text/model',
    })

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

  it('serializes imports so concurrent fifth and sixth attachments use current admission state', async () => {
    const { api } = createEventApi()
    let resolvePick!: (assets: MediaAsset[]) => void
    vi.mocked(api.media.pickFiles).mockReturnValue(new Promise((resolve) => { resolvePick = resolve }))
    vi.mocked(api.media.importClipboardImage).mockResolvedValue([mediaAsset('6')])
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.selectedConversationId = 'conversation_1'
    store.draftsByConversation.conversation_1 = ['1', '2', '3', '4'].map((id) => mediaAsset(id))

    const fifth = store.pickDraftFiles()
    const sixth = store.importClipboardDraft()
    await vi.waitFor(() => expect(api.media.pickFiles).toHaveBeenCalledWith({
      conversationId: 'conversation_1',
      existingAssetIds: ['1', '2', '3', '4'],
    }))
    expect(api.media.importClipboardImage).not.toHaveBeenCalled()

    resolvePick([mediaAsset('5')])
    await Promise.all([fifth, sixth])

    expect(store.drafts.map(({ id }) => id)).toEqual(['1', '2', '3', '4', '5'])
    expect(api.media.importClipboardImage).not.toHaveBeenCalled()
  })

  it('rolls back every unexpected overflow asset returned by Main instead of hiding orphans', async () => {
    const { api } = createEventApi()
    vi.mocked(api.media.pickFiles).mockResolvedValue([mediaAsset('5'), mediaAsset('6')])
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.selectedConversationId = 'conversation_1'
    store.draftsByConversation.conversation_1 = ['1', '2', '3', '4'].map((id) => mediaAsset(id))

    await store.pickDraftFiles()

    expect(api.media.removeDraft).toHaveBeenCalledWith({
      conversationId: 'conversation_1',
      assetId: '5',
    })
    expect(api.media.removeDraft).toHaveBeenCalledWith({
      conversationId: 'conversation_1',
      assetId: '6',
    })
    expect(store.drafts.map(({ id }) => id)).toEqual(['1', '2', '3', '4'])
    expect(store.error).toContain('已拒绝本次导入')
  })

  it('closes media admission and joins a suspended import before deleting its conversation', async () => {
    const { api } = createEventApi()
    let resolvePick!: (assets: MediaAsset[]) => void
    vi.mocked(api.media.pickFiles).mockReturnValue(new Promise((resolve) => { resolvePick = resolve }))
    vi.mocked(api.chat.deleteConversation).mockResolvedValue(undefined)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.selectedConversationId = 'conversation_1'
    store.conversations = [{
      id: 'conversation_1',
      title: '待删除',
      createdAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
    }]
    store.awaitingResponseByConversation.conversation_1 = true

    const importing = store.pickDraftFiles()
    await vi.waitFor(() => expect(api.media.pickFiles).toHaveBeenCalled())
    const deleting = store.deleteConversation('conversation_1')
    await Promise.resolve()
    expect(api.chat.deleteConversation).not.toHaveBeenCalled()

    await store.importClipboardDraft()
    expect(api.media.importClipboardImage).not.toHaveBeenCalled()

    resolvePick([mediaAsset('late_asset')])
    await Promise.all([importing, deleting])

    expect(api.chat.deleteConversation).toHaveBeenCalledWith('conversation_1')
    expect(store.draftsByConversation.conversation_1).toBeUndefined()
    expect(store.awaitingResponseByConversation.conversation_1).toBeUndefined()
    expect(store.conversations).toEqual([])
  })

  it('reopens media admission when conversation deletion fails', async () => {
    const { api } = createEventApi()
    vi.mocked(api.chat.deleteConversation).mockRejectedValueOnce(new Error('delete failed'))
    vi.mocked(api.media.pickFiles).mockResolvedValue([mediaAsset('after_failure')])
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.selectedConversationId = 'conversation_1'
    store.conversations = [{
      id: 'conversation_1',
      title: '保留',
      createdAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
    }]

    await store.deleteConversation('conversation_1')
    await store.pickDraftFiles()

    expect(api.media.pickFiles).toHaveBeenCalledWith({
      conversationId: 'conversation_1',
      existingAssetIds: [],
    })
    expect(store.drafts.map(({ id }) => id)).toEqual(['after_failure'])
  })

  it('keeps late import, remove, send, and status failures out of the newly selected conversation', async () => {
    const { api, emitChat } = createEventApi()
    let rejectPick!: (error: Error) => void
    let rejectRemove!: (error: Error) => void
    let rejectSend!: (error: Error) => void
    vi.mocked(api.media.pickFiles).mockReturnValue(new Promise((_resolve, reject) => { rejectPick = reject }))
    vi.mocked(api.media.removeDraft).mockReturnValue(new Promise((_resolve, reject) => { rejectRemove = reject }))
    vi.mocked(api.chat.send).mockReturnValue(new Promise((_resolve, reject) => { rejectSend = reject }))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.selectedConversationId = 'conversation_1'
    store.draftsByConversation.conversation_1 = [mediaAsset('asset_1')]
    store.ensureSubscriptions()

    const importing = store.pickDraftFiles()
    await vi.waitFor(() => expect(api.media.pickFiles).toHaveBeenCalled())
    store.selectedConversationId = 'conversation_2'
    rejectPick(new Error('late import'))
    await importing
    expect(store.error).toBe('')

    store.selectedConversationId = 'conversation_1'
    const removing = store.removeDraft('asset_1')
    await vi.waitFor(() => expect(api.media.removeDraft).toHaveBeenCalled())
    store.selectedConversationId = 'conversation_2'
    rejectRemove(new Error('late remove'))
    await removing
    expect(store.error).toBe('')

    store.selectedConversationId = 'conversation_1'
    const sending = store.send({
      content: '保留',
      assetIds: ['asset_1'],
      outputType: 'text',
      generation: generationPreferences().generation,
      model: 'text/model',
    })
    await vi.waitFor(() => expect(api.chat.send).toHaveBeenCalled())
    store.selectedConversationId = 'conversation_2'
    rejectSend(new Error('late send'))
    await sending
    expect(store.error).toBe('')

    emitChat({
      type: 'status',
      conversationId: 'conversation_1',
      requestId: 'late_status',
      status: 'failed',
      error: { code: 'MODEL_PROVIDER_REQUEST_FAILED', message: 'late' },
    })
    expect(store.error).toBe('')
  })

  it('clears composer text immediately and restores it when Main rejects', async () => {
    const { api } = createEventApi()
    let rejectFirst!: (error: Error) => void
    vi.mocked(api.chat.send).mockReturnValueOnce(new Promise((_resolve, reject) => { rejectFirst = reject }))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.selectedConversationId = 'conversation_1'
    store.draftsByConversation.conversation_1 = [mediaAsset('asset_1')]
    store.preferencesByConversation.conversation_1 = generationPreferences({
      outputType: 'text',
      models: { text: 'text/model' },
    })
    const wrapper = mount(ChatComposer, {
      props: {
        disabled: false,
        running: false,
        models: [modelInfo('text/model', ['text'])],
        defaultModel: 'text/model',
        onSubmit: async (input, acknowledge) => { acknowledge(await store.send(input)) },
      },
      global: { plugins: [ElementPlus] },
    })
    const textarea = wrapper.get('textarea')

    await textarea.setValue('不能丢失')
    await wrapper.get('form').trigger('submit')
    await vi.waitFor(() => expect(api.chat.send).toHaveBeenCalledTimes(1))
    expect((textarea.element as HTMLTextAreaElement).value).toBe('')
    expect(store.messagesByConversation.conversation_1).toHaveLength(1)

    rejectFirst(new Error('rejected'))
    await vi.waitFor(() => expect(store.messagesByConversation.conversation_1).toEqual([]))
    expect((textarea.element as HTMLTextAreaElement).value).toBe('不能丢失')
    expect(store.drafts.map(({ id }) => id)).toEqual(['asset_1'])

    vi.mocked(api.chat.send).mockResolvedValueOnce({ requestId: 'accepted' })
    await wrapper.get('form').trigger('submit')
    await vi.waitFor(() => expect(api.chat.send).toHaveBeenCalledTimes(2))
    expect((textarea.element as HTMLTextAreaElement).value).toBe('')
    expect(store.drafts).toEqual([])
  })

  it('labels the running action as cancel send', () => {
    const wrapper = mount(ChatComposer, {
      props: {
        disabled: false,
        running: true,
        models: [modelInfo('text/model', ['text'])],
        defaultModel: 'text/model',
      },
      global: { plugins: [ElementPlus] },
    })

    expect(wrapper.get('[data-testid="cancel-send"]').text()).toBe('取消发送')
  })

  it('restores a rejected submission without overwriting a newer draft', async () => {
    const store = useChatStore()
    store.selectedConversationId = 'conversation_1'
    store.preferencesByConversation.conversation_1 = generationPreferences({ outputType: 'text' })
    const wrapper = mount(ChatComposer, {
      props: {
        disabled: false,
        running: false,
        models: [modelInfo('text/model', ['text'])],
        defaultModel: 'text/model',
      },
      global: { plugins: [ElementPlus] },
    })
    const textarea = wrapper.get('textarea')

    await textarea.setValue('发送失败')
    await wrapper.get('form').trigger('submit')
    const acknowledge = wrapper.emitted('submit')?.[0]?.[1] as ((accepted: boolean) => void)
    expect((textarea.element as HTMLTextAreaElement).value).toBe('')

    await textarea.setValue('新的草稿')
    acknowledge(false)
    await wrapper.vm.$nextTick()

    expect((textarea.element as HTMLTextAreaElement).value).toBe('发送失败\n\n新的草稿')
  })

  it('keeps pending send acknowledgement isolated to its captured conversation', async () => {
    const { api } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.selectedConversationId = 'conversation_a'
    store.preferencesByConversation.conversation_a = generationPreferences({ outputType: 'text' })
    store.preferencesByConversation.conversation_b = generationPreferences({ outputType: 'text' })
    const wrapper = mount(ChatComposer, {
      props: {
        disabled: false,
        running: false,
        models: [modelInfo('text/model', ['text'])],
        defaultModel: 'text/model',
      },
      global: { plugins: [ElementPlus] },
    })

    await wrapper.get('textarea').setValue('会话 A')
    await wrapper.get('form').trigger('submit')
    const acknowledgeA = wrapper.emitted('submit')?.[0]?.[1] as ((accepted: boolean) => void)

    store.selectedConversationId = 'conversation_b'
    await wrapper.get('textarea').setValue('会话 B')
    expect(wrapper.get('[data-testid="send-message"]').attributes('disabled')).toBeUndefined()
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('submit')).toHaveLength(2)
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('')
    await wrapper.get('textarea').setValue('会话 B 新草稿')

    acknowledgeA(true)
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('会话 B 新草稿')
  })

  it('keeps Sora selected and allows exactly one reference image', async () => {
    const { api } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.selectedConversationId = 'conversation_1'
    store.preferencesByConversation.conversation_1 = generationPreferences({
      outputType: 'video',
      models: { video: 'openai/sora-2-pro' },
    })
    const happyHorse = modelInfo('alibaba/happyhorse-1.1', ['video'])
    const sora = modelInfo('openai/sora-2-pro', ['video'])
    sora.inputModalities = ['text', 'image']
    sora.generation.video = {
      ...sora.generation.video!,
      frameImages: [],
      maxReferenceImages: 1,
    }
    const wrapper = mount(ChatComposer, {
      props: {
        disabled: false,
        running: false,
        models: [happyHorse, sora],
        defaultModel: 'alibaba/happyhorse-1.1',
      },
      global: { plugins: [ElementPlus] },
    })

    await wrapper.get('textarea').setValue('生成视频')
    expect(wrapper.get('[data-testid="model-select"]').element).toHaveProperty(
      'value',
      'openai/sora-2-pro',
    )

    store.draftsByConversation.conversation_1 = [mediaAsset('reference-one')]
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[data-testid="model-select"]').element).toHaveProperty(
      'value',
      'openai/sora-2-pro',
    )
    expect(wrapper.find('[data-testid="model-attachment-incompatible"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="send-message"]').attributes('disabled')).toBeUndefined()

    store.draftsByConversation.conversation_1 = [
      mediaAsset('reference-one'),
      mediaAsset('reference-two'),
    ]
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[data-testid="model-select"]').element).toHaveProperty(
      'value',
      'openai/sora-2-pro',
    )
    expect(wrapper.get('[data-testid="model-attachment-incompatible"]').text())
      .toContain('当前模型不支持已添加的附件')
    expect(wrapper.get('[data-testid="send-message"]').attributes('disabled')).toBeDefined()
  })

  it('disables unsupported outputs and cannot send without a compatible model', async () => {
    const { api } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.selectedConversationId = 'conversation_1'
    store.preferencesByConversation.conversation_1 = generationPreferences({ outputType: 'image' })
    const wrapper = mount(ChatComposer, {
      props: {
        disabled: false,
        running: false,
        models: [modelInfo('deepseek/text', ['text'])],
        defaultModel: 'deepseek/text',
      },
      global: { plugins: [ElementPlus] },
    })

    await wrapper.get('textarea').setValue('生成图片')
    expect(wrapper.get('[data-testid="output-type"] option[value="image"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="send-message"]').attributes('disabled')).toBeDefined()
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('submit')).toBeUndefined()
  })

  it('mirrors Main request compatibility for attachments and required text input', async () => {
    const { api } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.selectedConversationId = 'conversation_1'
    store.draftsByConversation.conversation_1 = [mediaAsset('audio_input', 'audio')]
    store.preferencesByConversation.conversation_1 = generationPreferences()
    const multiOutput = modelInfo('multi/model', ['text', 'image'])
    multiOutput.inputModalities = ['text', 'audio']
    const audioOnlyInput = modelInfo('audio-only-input/model', ['text'])
    audioOnlyInput.inputModalities = ['audio']
    const wrapper = mount(ChatComposer, {
      props: {
        disabled: false,
        running: false,
        models: [multiOutput],
        defaultModel: 'multi/model',
      },
      global: { plugins: [ElementPlus] },
    })

    await wrapper.get('textarea').setValue('分析这段音频')
    expect(wrapper.find('[data-testid="output-choice-required"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="output-type"] option[value="image"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="send-message"]').attributes('disabled')).toBeUndefined()

    await wrapper.setProps({ models: [audioOnlyInput], defaultModel: 'audio-only-input/model' })
    expect(wrapper.get('[data-testid="send-message"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="no-compatible-model"]').text()).toContain('没有兼容')
  })

  it('normalizes stale values on output and model changes but preserves unpublished empty capability lists', async () => {
    const { api } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.selectedConversationId = 'conversation_1'
    store.preferencesByConversation.conversation_1 = generationPreferences({
      outputType: 'text',
      generation: {
        ...generationPreferences().generation,
        image: { count: 1, resolution: '4K', aspectRatio: '9:16', format: 'jpg' },
      },
    })
    const unrestricted = modelInfo('image/unrestricted', ['image'])
    unrestricted.generation.image = { resolutions: [], aspectRatios: [], formats: [], maxCount: 1 }
    const otherDefault = modelInfo('image/other-default', ['image'])
    otherDefault.generation.image = {
      resolutions: ['2K'],
      aspectRatios: ['1:1'],
      formats: ['webp'],
      maxCount: 1,
    }
    const wrapper = mount(ChatComposer, {
      props: {
        disabled: false,
        running: false,
        models: [
          modelInfo('text/model', ['text']),
          otherDefault,
          modelInfo('image/restricted', ['image']),
          unrestricted,
        ],
        defaultModel: 'text/model',
        defaultModels: { text: 'text/model', image: 'image/restricted' },
      },
      global: { plugins: [ElementPlus] },
    })

    await wrapper.get('[data-testid="output-type"]').setValue('image')
    await vi.waitFor(() => expect(store.preferences.outputType).toBe('image'))
    expect(store.preferences.generation.image).toEqual({
      count: 1,
      resolution: '1K',
      aspectRatio: 'auto',
      format: 'png',
    })

    store.preferencesByConversation.conversation_1 = generationPreferences({
      outputType: 'image',
      models: { image: 'image/restricted' },
      generation: {
        ...generationPreferences().generation,
        image: { count: 1, resolution: '4K', aspectRatio: '9:16', format: 'jpg' },
      },
    })
    await wrapper.get('[data-testid="model-select"]').setValue('image/unrestricted')
    await vi.waitFor(() => expect(store.preferences.models.image).toBe('image/unrestricted'))
    expect(store.preferences.generation.image).toEqual({
      count: 1,
      resolution: '4K',
      aspectRatio: '9:16',
      format: 'jpg',
    })
  })

  it('appends a full stable replacement when block update wins the message loading race', async () => {
    const { api, emitChat } = createEventApi()
    let resolveMessages!: (messages: Awaited<ReturnType<DesktopAPI['chat']['listMessages']>>) => void
    vi.mocked(api.chat.listMessages).mockReturnValue(new Promise((resolve) => { resolveMessages = resolve }))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.ensureSubscriptions()
    const loading = store.selectConversation('conversation_1')
    await vi.waitFor(() => expect(api.chat.listMessages).toHaveBeenCalledWith({ conversationId: 'conversation_1', limit: 100 }))

    emitChat({
      type: 'block_update',
      conversationId: 'conversation_1',
      messageId: 'assistant_1',
      blockId: 'media_1',
      block: {
        type: 'media',
        blockId: 'media_1',
        assetId: 'asset_1',
        kind: 'image',
        purpose: 'output',
        name: 'done.png',
        mimeType: 'image/png',
        byteSize: 100,
      },
    })
    resolveMessages({ items: [
      {
        id: 'history_1',
        conversationId: 'conversation_1',
        role: 'user',
        blocks: [{ type: 'text', text: '保留的历史消息' }],
        createdAt: '2026-07-24T00:00:00.000Z',
      },
      {
        id: 'assistant_1',
        conversationId: 'conversation_1',
        role: 'assistant',
        blocks: [{
          type: 'media_generation',
          blockId: 'media_1',
          jobId: 'job_1',
          kind: 'image',
          status: 'pending',
        }],
        createdAt: '2026-07-25T00:00:00.000Z',
      },
    ] })
    await loading

    expect(store.messagesByConversation.conversation_1?.map(({ id }) => id))
      .toEqual(['history_1', 'assistant_1'])
    expect(store.messagesByConversation.conversation_1?.[1]?.blocks).toEqual([
      expect.objectContaining({
        id: 'assistant_1:media_1',
        type: 'media',
        blockId: 'media_1',
        assetId: 'asset_1',
      }),
    ])
  })

  it('blocks running media mutations and generation options while retaining textarea input', async () => {
    const { api } = createEventApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.selectedConversationId = 'conversation_1'
    store.draftsByConversation.conversation_1 = [mediaAsset('asset_1')]
    store.preferencesByConversation.conversation_1 = generationPreferences({
      outputType: 'video',
      models: { video: 'video/model' },
    })
    const wrapper = mount(ChatComposer, {
      props: {
        disabled: false,
        running: true,
        models: [modelInfo('video/model', ['video'])],
        defaultModel: 'video/model',
      },
      global: { plugins: [ElementPlus] },
    })
    const droppedFile = new File(['image'], 'new.png', { type: 'image/png' })

    await wrapper.get('[data-testid="attach-media"]').trigger('click')
    await wrapper.get('[data-testid="chat-composer"]').trigger('drop', { dataTransfer: { files: [droppedFile] } })
    await wrapper.get('textarea').trigger('paste', { clipboardData: { items: [{ type: 'image/png' }] } })
    await wrapper.get('[data-testid="remove-draft-asset_1"]').trigger('click')
    await wrapper.get('[data-testid="video-duration"]').setValue('10')
    await wrapper.get('textarea').setValue('继续编辑')

    expect(api.media.pickFiles).not.toHaveBeenCalled()
    expect(api.media.importDroppedFiles).not.toHaveBeenCalled()
    expect(api.media.importClipboardImage).not.toHaveBeenCalled()
    expect(api.media.removeDraft).not.toHaveBeenCalled()
    expect(api.chat.updateGenerationPreferences).not.toHaveBeenCalled()
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('继续编辑')
  })
})
