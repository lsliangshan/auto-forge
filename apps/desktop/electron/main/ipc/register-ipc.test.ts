import { describe, expect, it, vi } from 'vitest'
import { ipcChannels, toSafeAppError, type AppSettings } from '@autoforge/shared'
import { pathToFileURL } from 'node:url'
import {
  registerDesktopIpc,
  type DesktopIpcServices,
  type IpcInvokeEvent,
  type IpcMainPort,
} from './register-ipc.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(release => { resolve = release })
  return { promise, resolve }
}

const appSettings: AppSettings = {
  theme: 'system', language: 'zh-CN', dataDirectory: '/data', logDirectory: '/logs',
  activeProvider: 'deepseek', defaultModels: {
    openrouter: { text: 'openai/gpt-4.1-mini' }, deepseek: { text: 'deepseek-v4-flash' },
  },
  showCosts: false, developerMode: false, permissionDefault: 'ask',
  proxy: { enabled: false, bypassDomains: [] },
}

const authSession = {
  user: { id: 'user_1', account: 'Alice' },
  authenticatedAt: '2026-08-07T00:00:00.000Z',
}

const emptyUsagePeriod = (startedAt: string, endedAt: string) => ({
  startedAt,
  endedAt,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  openRouterCostUsd: '0',
  openRouterKnownCostCount: 0,
  openRouterUnknownCostCount: 0,
  models: [],
  trend: [],
})

const emptyUsageSnapshot = () => {
  const generatedAt = '2026-08-17T04:00:00.000Z'
  const todayStartedAt = '2026-08-16T16:00:00.000Z'
  return {
    generatedAt,
    today: emptyUsagePeriod(todayStartedAt, generatedAt),
    yesterday: emptyUsagePeriod('2026-08-15T16:00:00.000Z', todayStartedAt),
    week: emptyUsagePeriod(todayStartedAt, generatedAt),
    month: emptyUsagePeriod('2026-07-31T16:00:00.000Z', generatedAt),
    allTime: emptyUsagePeriod(generatedAt, generatedAt),
  }
}

function services(): DesktopIpcServices {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue(null),
      refreshAuthorization: vi.fn().mockResolvedValue(authSession),
      sendOtp: vi.fn().mockResolvedValue({ challengeId: 'challenge_1', expiresIn: 300 }),
      verifyOtp: vi.fn().mockResolvedValue(authSession),
      cancelOtp: vi.fn().mockResolvedValue(undefined),
      loginWithPassword: vi.fn().mockResolvedValue(authSession),
      logout: vi.fn().mockResolvedValue(undefined),
      requireSession: vi.fn().mockResolvedValue(authSession),
    },
    knowledgeAdmission: {
      run: <T>(operation: () => Promise<T>) => operation(),
    },
    userAdmin: {
      list: vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 }),
      updateRole: vi.fn().mockResolvedValue({
        userId: 'user_2', role: 'super_admin', version: 2, updatedAt: '2026-08-21T00:00:00.000Z',
      }),
    },
    profile: {
      get: vi.fn().mockResolvedValue({ userId: 'user_1', account: 'Alice' }),
      update: vi.fn().mockResolvedValue({ userId: 'user_1', account: 'Alice', displayName: 'Alice' }),
      pickAndUploadAvatar: vi.fn().mockResolvedValue({ url: 'https://cdn.example.com/avatar.png' }),
    },
    chat: {
      listConversations: vi.fn().mockResolvedValue([]),
      listMessages: vi.fn().mockResolvedValue([]),
      createConversation: vi.fn(),
      renameConversation: vi.fn(),
      deleteConversation: vi.fn(),
      send: vi.fn().mockResolvedValue({ requestId: 'request_1' }),
      cancel: vi.fn(),
      takeOverBrowser: vi.fn(),
      listBrowserAudit: vi.fn().mockResolvedValue([]),
      getGenerationPreferences: vi.fn(),
      updateGenerationPreferences: vi.fn(),
    },
    media: {
      pickFiles: vi.fn(), importDroppedFiles: vi.fn(), importClipboardImage: vi.fn(), removeDraft: vi.fn(),
      saveCopy: vi.fn(), reveal: vi.fn(), pauseVideoJob: vi.fn(), resumeVideoJob: vi.fn(),
    },
    workflows: { list: vi.fn(), get: vi.fn(), setEnabled: vi.fn(), remove: vi.fn(), installProject: vi.fn() },
    developer: {
      listProjects: vi.fn(), createProject: vi.fn(), registerProject: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(),
      createEntry: vi.fn(), renameEntry: vi.fn(), deleteEntry: vi.fn(),
      build: vi.fn(), validate: vi.fn(), run: vi.fn(),
    },
    executions: { list: vi.fn(), get: vi.fn(), decide: vi.fn(), cancel: vi.fn() },
    permissions: { listGrants: vi.fn(), revoke: vi.fn() },
    settings: {
      get: vi.fn().mockResolvedValue(appSettings), update: vi.fn(),
      saveProviderApiKey: vi.fn(async (provider) => ({ provider, configured: true, validation: 'valid' as const })),
      clearProviderApiKey: vi.fn(),
      validateProviderCredential: vi.fn(async (provider) => ({ provider, configured: false, validation: 'unchecked' as const })),
      listProviderModels: vi.fn(async () => []),
      getTokenUsage: vi.fn().mockResolvedValue(emptyUsageSnapshot()),
      clearLocalData: vi.fn(),
      clearBrowserData: vi.fn(),
    },
    knowledge: {
      listBases: vi.fn().mockResolvedValue([]),
      createBase: vi.fn().mockResolvedValue({
        id: 'kb_1', name: 'Policies', kind: 'local', status: 'ready', searchable: false, documentCount: 0,
        updatedAt: '2026-08-26T00:00:00.000Z',
      }),
      listDocuments: vi.fn().mockResolvedValue([]),
      listVersions: vi.fn().mockResolvedValue([]),
      importDocument: vi.fn().mockResolvedValue(undefined),
      replaceDocument: vi.fn().mockResolvedValue(undefined),
      recycleDocument: vi.fn().mockResolvedValue(undefined),
      purgeDocument: vi.fn().mockResolvedValue(undefined),
      recycleBase: vi.fn().mockResolvedValue(undefined),
      purgeBase: vi.fn().mockResolvedValue(undefined),
      exportBase: vi.fn().mockResolvedValue(undefined),
      getConversationSelection: vi.fn().mockResolvedValue({ knowledgeBaseIds: [], knowledgeMode: 'mixed' }),
      updateConversationSelection: vi.fn().mockResolvedValue({ knowledgeBaseIds: [], knowledgeMode: 'mixed' }),
      search: vi.fn().mockResolvedValue({ kind: 'ask_for_detail', results: [] }),
      getFeatureAvailability: vi.fn().mockResolvedValue({
        local: { available: false, reasons: ['encrypted_storage_unavailable'] },
        cloud: { available: false, reasons: ['encrypted_storage_unavailable'] },
      }),
      getEntitlement: vi.fn().mockResolvedValue({ tier: 'free', status: 'active', betaEnabled: false, cloudEnabled: false }),
      getConsent: vi.fn().mockResolvedValue({
        chatProvider: { provider: 'deepseek', status: 'unknown' },
        embedding: {
          processor: 'tokenhub', processingRegion: 'Guangzhou',
          model: 'kinfra-text-embedding-0.6b', dimensions: 1024,
          status: 'unknown', retrievalMode: 'keyword_only',
        },
      }),
    },
    system: { openExternal: vi.fn(), getAppInfo: vi.fn() },
  }
}

function harness(
  senderUrl = 'http://127.0.0.1:5173/chat',
  rendererTarget: import('./register-ipc.js').RendererTarget = { kind: 'development', origin: 'http://127.0.0.1:5173' },
) {
  const handlers = new Map<string, (event: IpcInvokeEvent, input?: unknown) => Promise<unknown>>()
  const removed: string[] = []
  const ipcMain: IpcMainPort = {
    handle(channel, handler) { handlers.set(channel, handler) },
    removeHandler(channel) { handlers.delete(channel); removed.push(channel) },
  }
  const mainFrame = { url: senderUrl }
  const webContents = { id: 1, isDestroyed: () => false, mainFrame }
  const mainWindow = { isDestroyed: () => false, webContents }
  const dependencies = services()
  const dispose = registerDesktopIpc({
    ipcMain,
    services: dependencies,
    getMainWindow: () => mainWindow,
    rendererTarget,
  })
  const event = { sender: webContents, senderFrame: mainFrame }
  return {
    dependencies, handlers, removed, dispose,
    setSenderUrl: (url: string) => { mainFrame.url = url },
    invoke: (channel: string, input?: unknown) => handlers.get(channel)!(event, input),
    invokeFrom: (url: string, channel: string, input?: unknown) => {
      const frame = { url }
      return handlers.get(channel)!({ sender: webContents, senderFrame: frame }, input)
    },
  }
}

describe('registerDesktopIpc', () => {
  it('allows the fixed authentication operations without an existing session', async () => {
    const app = harness()

    await expect(app.invoke(ipcChannels.authGetSession)).resolves.toBeNull()
    await expect(app.invoke(ipcChannels.authSendOtp, {
      intent: 'login', channel: 'phone', target: '18311032722',
    })).resolves.toEqual({ challengeId: 'challenge_1', expiresIn: 300 })
    await expect(app.invoke(ipcChannels.authVerifyOtp, {
      challengeId: 'challenge_1', code: '123456',
    })).resolves.toEqual(authSession)
    await expect(app.invoke(ipcChannels.authCancelOtp, {
      challengeId: 'challenge_1',
    })).resolves.toBeUndefined()
    await expect(app.invoke(ipcChannels.authLoginWithPassword, {
      account: 'Alice_1', password: 'password',
    })).resolves.toEqual(authSession)
    await expect(app.invoke(ipcChannels.authLogout)).resolves.toBeUndefined()
    expect(app.dependencies.auth.requireSession).not.toHaveBeenCalled()
  })

  it('rejects malformed anonymous authentication inputs before invoking a service', async () => {
    const app = harness()

    for (const input of [
      { intent: 'login', channel: 'phone', target: '1831103272' },
      { intent: 'login', channel: 'email', target: 'not-an-email' },
    ]) {
      await expect(app.invoke(ipcChannels.authSendOtp, input))
        .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    }
    await expect(app.invoke(ipcChannels.authVerifyOtp, {
      challengeId: 'challenge_1', code: '12345',
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(app.invoke(ipcChannels.authCancelOtp, {
      challengeId: '',
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(app.invoke(ipcChannels.authLoginWithPassword, {
      account: 'Alice_1', password: 'short',
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' })

    expect(app.dependencies.auth.sendOtp).not.toHaveBeenCalled()
    expect(app.dependencies.auth.verifyOtp).not.toHaveBeenCalled()
    expect(app.dependencies.auth.cancelOtp).not.toHaveBeenCalled()
    expect(app.dependencies.auth.loginWithPassword).not.toHaveBeenCalled()
  })

  it('rejects business operations without a session', async () => {
    const app = harness()
    vi.mocked(app.dependencies.auth.requireSession)
      .mockRejectedValueOnce(toSafeAppError({ code: 'AUTH_REQUIRED' }))

    await expect(app.invoke(ipcChannels.chatListConversations))
      .rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    expect(app.dependencies.chat.listConversations).not.toHaveBeenCalled()
  })

  it('guards and validates every profile operation', async () => {
    const app = harness()

    await app.invoke(ipcChannels.profileGet)
    await app.invoke(ipcChannels.profileUpdate, { displayName: 'Alice' })
    await app.invoke(ipcChannels.profilePickAndUploadAvatar)

    expect(app.dependencies.auth.requireSession).toHaveBeenCalledTimes(3)
    expect(app.dependencies.profile.get).toHaveBeenCalledOnce()
    expect(app.dependencies.profile.update).toHaveBeenCalledWith({ displayName: 'Alice' })
    expect(app.dependencies.profile.pickAndUploadAvatar).toHaveBeenCalledOnce()
    await expect(app.invoke(ipcChannels.profileUpdate, { account: 'Mallory' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('guards and validates user administration operations', async () => {
    const app = harness()

    await expect(app.invoke(ipcChannels.userAdminList, { page: 1, pageSize: 20 })).resolves.toEqual({
      items: [], page: 1, pageSize: 20, total: 0,
    })
    await expect(app.invoke(ipcChannels.userAdminUpdateRole, {
      requestId: 'request_1', targetUserId: 'user_2', newRole: 'super_admin', expectedVersion: 1,
    })).resolves.toMatchObject({ userId: 'user_2', role: 'super_admin', version: 2 })
    expect(app.dependencies.auth.requireSession).toHaveBeenCalledTimes(2)
    await expect(app.invoke(ipcChannels.userAdminList, { page: 1, pageSize: 25 }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(app.invoke(ipcChannels.userAdminUpdateRole, {
      requestId: 'request_2', targetUserId: 'user_2', newRole: 'support_operator', expectedVersion: 2,
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('guards and validates fixed developer entry operations', async () => {
    const app = harness()
    const project = {
      id: 'project_1', name: 'Baidu search', rootPath: '/private/project', status: 'new' as const,
      chatAvailability: 'not_built' as const,
      files: ['src/index.ts', 'workflow.json'], directories: ['src'], updatedAt: '2026-07-19T00:00:00.000Z',
    }
    vi.mocked(app.dependencies.developer.createEntry).mockResolvedValue(project)
    vi.mocked(app.dependencies.developer.renameEntry).mockResolvedValue(project)
    vi.mocked(app.dependencies.developer.deleteEntry).mockResolvedValue(project)

    await expect(app.invoke(ipcChannels.developerCreateEntry, {
      projectId: 'project_1', parentPath: 'src', name: 'helpers.ts', kind: 'file',
    })).resolves.toEqual(project)
    await expect(app.invoke(ipcChannels.developerRenameEntry, {
      projectId: 'project_1', relativePath: 'src/helpers.ts', name: 'format.ts',
    })).resolves.toEqual(project)
    await expect(app.invoke(ipcChannels.developerDeleteEntry, {
      projectId: 'project_1', relativePath: 'src/format.ts',
    })).resolves.toEqual(project)

    expect(app.dependencies.auth.requireSession).toHaveBeenCalledTimes(3)
    expect(app.dependencies.developer.createEntry).toHaveBeenCalledWith('project_1', 'src', 'helpers.ts', 'file')
    expect(app.dependencies.developer.renameEntry).toHaveBeenCalledWith('project_1', 'src/helpers.ts', 'format.ts')
    expect(app.dependencies.developer.deleteEntry).toHaveBeenCalledWith('project_1', 'src/format.ts')
    await expect(app.invoke(ipcChannels.developerCreateEntry, {
      projectId: 'project_1', parentPath: '', name: '../escape.ts', kind: 'file',
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('validates sender and input before requiring a session', async () => {
    const app = harness()

    await expect(app.invokeFrom('https://attacker.invalid/', ipcChannels.settingsGet))
      .rejects.toMatchObject({ code: 'UNTRUSTED_SENDER' })
    await expect(app.invoke(ipcChannels.chatListMessages, {}))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(app.dependencies.auth.requireSession).not.toHaveBeenCalled()
  })

  it('returns complete proxy settings', async () => {
    const app = harness()

    await expect(app.invoke(ipcChannels.settingsGet)).resolves.toEqual(appSettings)
  })

  it('preserves proxy application failures for the renderer', async () => {
    const app = harness()
    vi.mocked(app.dependencies.settings.update)
      .mockRejectedValueOnce(toSafeAppError({ code: 'NETWORK_PROXY_APPLY_FAILED' }))
    await expect(app.invoke(ipcChannels.settingsUpdate, {
      proxy: { enabled: true, httpProxy: 'http://127.0.0.1:7890', bypassDomains: [] },
    })).rejects.toMatchObject({ code: 'NETWORK_PROXY_APPLY_FAILED' })
  })

  it('rejects extra proxy keys and malformed proxy URLs before updating settings', async () => {
    const app = harness()

    for (const proxy of [
      { enabled: false, bypassDomains: [], unexpected: true },
      { enabled: true, httpProxy: 'http://user:password@127.0.0.1:7890', bypassDomains: [] },
      { enabled: true, socketProxy: 'http://127.0.0.1:7891', bypassDomains: [] },
    ]) {
      await expect(app.invoke(ipcChannels.settingsUpdate, { proxy }))
        .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    }

    expect(app.dependencies.settings.update).not.toHaveBeenCalled()
  })

  it('rejects invalid bypass array entries before updating settings', async () => {
    const app = harness()

    for (const bypassEntry of [
      'https://example.com',
      'example.com:443',
      'example.com/path',
      '',
      'example.com,internal.example',
      'example.com\ninternal.example',
    ]) {
      await expect(app.invoke(ipcChannels.settingsUpdate, {
        proxy: { enabled: false, bypassDomains: ['example.com', bypassEntry] },
      })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    }

    expect(app.dependencies.settings.update).not.toHaveBeenCalled()
  })

  it('rejects an invalid chat request before invoking the orchestrator', async () => {
    const app = harness()
    await expect(app.invoke(ipcChannels.chatSend, { conversationId: '', content: '' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(app.dependencies.chat.send).not.toHaveBeenCalled()
  })

  it('guards fixed knowledge lifecycle and search contracts without renderer-provided paths or scope', async () => {
    const app = harness()
    const selection = { knowledgeBaseIds: ['kb_1'], knowledgeMode: 'strict' as const }

    await app.invoke(ipcChannels.knowledgeListBases)
    await app.invoke(ipcChannels.knowledgeCreateBase, { name: 'Policies' })
    await app.invoke(ipcChannels.knowledgeListDocuments, { knowledgeBaseId: 'kb_1' })
    await app.invoke(ipcChannels.knowledgeListVersions, { documentId: 'document_1' })
    await app.invoke(ipcChannels.knowledgeImportDocument, { knowledgeBaseId: 'kb_1' })
    await app.invoke(ipcChannels.knowledgeReplaceDocument, { documentId: 'document_1' })
    await app.invoke(ipcChannels.knowledgeRecycleDocument, { documentId: 'document_1' })
    await app.invoke(ipcChannels.knowledgePurgeDocument, { documentId: 'document_1' })
    await app.invoke(ipcChannels.knowledgeRecycleBase, { knowledgeBaseId: 'kb_1' })
    await app.invoke(ipcChannels.knowledgePurgeBase, { knowledgeBaseId: 'kb_1' })
    await app.invoke(ipcChannels.knowledgeExportBase, { knowledgeBaseId: 'kb_1' })
    await app.invoke(ipcChannels.knowledgeGetConversationSelection, { conversationId: 'conversation_1' })
    await app.invoke(ipcChannels.knowledgeUpdateConversationSelection, { conversationId: 'conversation_1', selection })
    await app.invoke(ipcChannels.knowledgeSearch, { conversationId: 'conversation_1', query: '北京政务' })
    await app.invoke(ipcChannels.knowledgeGetFeatureAvailability)
    await app.invoke(ipcChannels.knowledgeGetEntitlement)
    await app.invoke(ipcChannels.knowledgeGetConsent)

    const owner = { userId: 'user_1' }
    expect(app.dependencies.knowledge.listBases).toHaveBeenCalledWith(owner)
    expect(app.dependencies.knowledge.createBase).toHaveBeenCalledWith(owner, 'Policies')
    expect(app.dependencies.knowledge.listDocuments).toHaveBeenCalledWith(owner, 'kb_1')
    expect(app.dependencies.knowledge.listVersions).toHaveBeenCalledWith(owner, 'document_1')
    expect(app.dependencies.knowledge.importDocument).toHaveBeenCalledWith(owner, 'kb_1')
    expect(app.dependencies.knowledge.replaceDocument).toHaveBeenCalledWith(owner, 'document_1')
    expect(app.dependencies.knowledge.recycleDocument).toHaveBeenCalledWith(owner, 'document_1')
    expect(app.dependencies.knowledge.purgeDocument).toHaveBeenCalledWith(owner, 'document_1')
    expect(app.dependencies.knowledge.exportBase).toHaveBeenCalledWith(owner, 'kb_1')
    expect(app.dependencies.knowledge.getConversationSelection).toHaveBeenCalledWith(owner, 'conversation_1')
    expect(app.dependencies.knowledge.updateConversationSelection).toHaveBeenCalledWith(owner, 'conversation_1', selection)
    expect(app.dependencies.knowledge.search).toHaveBeenCalledWith(owner, 'conversation_1', '北京政务')
    expect(app.dependencies.knowledge.getFeatureAvailability).toHaveBeenCalledWith(owner)

    for (const [channel, input] of [
      [ipcChannels.knowledgeListDocuments, { knowledgeBaseId: 'kb_1', userId: 'other_user' }],
      [ipcChannels.knowledgeImportDocument, { knowledgeBaseId: 'kb_1', path: '/private/source.txt' }],
      [ipcChannels.knowledgeReplaceDocument, { documentId: 'document_1', path: '/private/source.txt' }],
      [ipcChannels.knowledgeUpdateConversationSelection, { conversationId: 'conversation_1', selection, topK: 99 }],
      [ipcChannels.knowledgeUpdateConversationSelection, { conversationId: 'conversation_1', selection: { ...selection, indexId: 'foreign-index' } }],
      [ipcChannels.knowledgeSearch, { conversationId: 'conversation_1', query: '北京', topK: 99 }],
      [ipcChannels.knowledgeSearch, { conversationId: 'conversation_1', query: '北京', knowledgeBaseIds: ['kb_other'] }],
      [ipcChannels.knowledgeGetFeatureAvailability, { path: '/private/knowledge.sqlite' }],
    ] as const) {
      await expect(app.invoke(channel, input)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    }
    expect(app.dependencies.knowledge.updateConversationSelection).toHaveBeenCalledTimes(1)
  })

  it('binds every knowledge operation to the authenticated owner instead of renderer-controlled IDs', async () => {
    const app = harness()
    const ownerSession = { ...authSession, user: { id: 'user_alice', account: 'Alice' } }
    const owner = { userId: 'user_alice' }
    const selection = { knowledgeBaseIds: ['kb_bob'], knowledgeMode: 'mixed' as const }
    vi.mocked(app.dependencies.auth.requireSession).mockResolvedValue(ownerSession)

    await app.invoke(ipcChannels.knowledgeListBases)
    await app.invoke(ipcChannels.knowledgeCreateBase, { name: 'Bob Base' })
    await app.invoke(ipcChannels.knowledgeListDocuments, { knowledgeBaseId: 'kb_bob' })
    await app.invoke(ipcChannels.knowledgeListVersions, { documentId: 'document_bob' })
    await app.invoke(ipcChannels.knowledgeImportDocument, { knowledgeBaseId: 'kb_bob' })
    await app.invoke(ipcChannels.knowledgeReplaceDocument, { documentId: 'document_bob' })
    await app.invoke(ipcChannels.knowledgeRecycleDocument, { documentId: 'document_bob' })
    await app.invoke(ipcChannels.knowledgePurgeDocument, { documentId: 'document_bob' })
    await app.invoke(ipcChannels.knowledgeRecycleBase, { knowledgeBaseId: 'kb_bob' })
    await app.invoke(ipcChannels.knowledgePurgeBase, { knowledgeBaseId: 'kb_bob' })
    await app.invoke(ipcChannels.knowledgeGetConversationSelection, { conversationId: 'conversation_bob' })
    await app.invoke(ipcChannels.knowledgeUpdateConversationSelection, { conversationId: 'conversation_bob', selection })
    await app.invoke(ipcChannels.knowledgeSearch, { conversationId: 'conversation_bob', query: '北京' })
    await app.invoke(ipcChannels.knowledgeGetFeatureAvailability)
    await app.invoke(ipcChannels.knowledgeGetEntitlement)
    await app.invoke(ipcChannels.knowledgeGetConsent)

    expect(app.dependencies.knowledge.listBases).toHaveBeenCalledWith(owner)
    expect(app.dependencies.knowledge.createBase).toHaveBeenCalledWith(owner, 'Bob Base')
    expect(app.dependencies.knowledge.listDocuments).toHaveBeenCalledWith(owner, 'kb_bob')
    expect(app.dependencies.knowledge.listVersions).toHaveBeenCalledWith(owner, 'document_bob')
    expect(app.dependencies.knowledge.importDocument).toHaveBeenCalledWith(owner, 'kb_bob')
    expect(app.dependencies.knowledge.replaceDocument).toHaveBeenCalledWith(owner, 'document_bob')
    expect(app.dependencies.knowledge.recycleDocument).toHaveBeenCalledWith(owner, 'document_bob')
    expect(app.dependencies.knowledge.purgeDocument).toHaveBeenCalledWith(owner, 'document_bob')
    expect(app.dependencies.knowledge.recycleBase).toHaveBeenCalledWith(owner, 'kb_bob')
    expect(app.dependencies.knowledge.purgeBase).toHaveBeenCalledWith(owner, 'kb_bob')
    expect(app.dependencies.knowledge.getConversationSelection).toHaveBeenCalledWith(owner, 'conversation_bob')
    expect(app.dependencies.knowledge.updateConversationSelection).toHaveBeenCalledWith(owner, 'conversation_bob', selection)
    expect(app.dependencies.knowledge.search).toHaveBeenCalledWith(owner, 'conversation_bob', '北京')
    expect(app.dependencies.knowledge.getFeatureAvailability).toHaveBeenCalledWith(owner)
    expect(app.dependencies.knowledge.getEntitlement).toHaveBeenCalledWith(owner)
    expect(app.dependencies.knowledge.getConsent).toHaveBeenCalledWith(owner)
  })

  it('holds admission across authenticated owner derivation and the complete knowledge operation', async () => {
    const app = harness()
    const admitted = deferred<void>()
    const release = deferred<void>()
    app.dependencies.knowledgeAdmission.run = vi.fn(async operation => {
      admitted.resolve()
      await release.promise
      return operation()
    })

    const listing = app.invoke(ipcChannels.knowledgeListBases)
    await admitted.promise
    expect(app.dependencies.auth.requireSession).not.toHaveBeenCalled()
    expect(app.dependencies.knowledge.listBases).not.toHaveBeenCalled()
    release.resolve()
    await listing

    expect(app.dependencies.auth.requireSession).toHaveBeenCalledOnce()
    expect(app.dependencies.knowledge.listBases).toHaveBeenCalledWith({ userId: 'user_1' })
  })

  it('strictly validates authenticated browser takeover, audit, and data-clear requests', async () => {
    const app = harness()

    await app.invoke(ipcChannels.chatTakeOverBrowser, {
      requestId: 'request_1', bindingId: 'binding_1',
    })
    await app.invoke(ipcChannels.chatListBrowserAudit, { bindingId: 'binding_1' })
    await app.invoke(ipcChannels.settingsClearBrowserData)

    expect(app.dependencies.chat.takeOverBrowser).toHaveBeenCalledWith({
      requestId: 'request_1', bindingId: 'binding_1',
    })
    expect(app.dependencies.chat.listBrowserAudit).toHaveBeenCalledWith('binding_1')
    expect(app.dependencies.settings.clearBrowserData).toHaveBeenCalledOnce()
    expect(app.dependencies.auth.requireSession).toHaveBeenCalledTimes(3)

    for (const [channel, input] of [
      [ipcChannels.chatTakeOverBrowser, { requestId: '', bindingId: 'binding_1' }],
      [ipcChannels.chatTakeOverBrowser, { requestId: 'request_1', bindingId: 42 }],
      [ipcChannels.chatTakeOverBrowser, { requestId: 'request_1', bindingId: 'binding_1', extra: true }],
      [ipcChannels.chatListBrowserAudit, { bindingId: '' }],
      [ipcChannels.settingsClearBrowserData, { userId: 'user_2' }],
    ] as const) {
      await expect(app.invoke(channel, input)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    }
    expect(app.dependencies.chat.takeOverBrowser).toHaveBeenCalledTimes(1)
    expect(app.dependencies.chat.listBrowserAudit).toHaveBeenCalledTimes(1)
    expect(app.dependencies.settings.clearBrowserData).toHaveBeenCalledTimes(1)
  })

  it('denies anonymous and ownership-failed browser requests without leaking service details', async () => {
    const app = harness()
    vi.mocked(app.dependencies.auth.requireSession)
      .mockRejectedValueOnce(toSafeAppError({ code: 'AUTH_REQUIRED' }))

    await expect(app.invoke(ipcChannels.chatTakeOverBrowser, {
      requestId: 'request_1', bindingId: 'binding_1',
    })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    expect(app.dependencies.chat.takeOverBrowser).not.toHaveBeenCalled()

    vi.mocked(app.dependencies.auth.requireSession)
      .mockRejectedValueOnce(toSafeAppError({ code: 'AUTH_REQUIRED' }))
    await expect(app.invoke(ipcChannels.chatListBrowserAudit, { bindingId: 'binding_1' }))
      .rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    expect(app.dependencies.chat.listBrowserAudit).not.toHaveBeenCalled()

    vi.mocked(app.dependencies.auth.requireSession)
      .mockRejectedValueOnce(toSafeAppError({ code: 'AUTH_REQUIRED' }))
    await expect(app.invoke(ipcChannels.settingsClearBrowserData))
      .rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    expect(app.dependencies.settings.clearBrowserData).not.toHaveBeenCalled()

    vi.mocked(app.dependencies.chat.listBrowserAudit)
      .mockRejectedValueOnce(toSafeAppError({ code: 'NOT_FOUND' }))
    const denied = await app.invoke(ipcChannels.chatListBrowserAudit, {
      bindingId: 'binding_foreign',
    }).catch((error) => error)
    expect(denied).toMatchObject({ code: 'NOT_FOUND' })
    expect(JSON.stringify(denied)).not.toContain('binding_foreign')
  })

  it('validates and forwards an explicit fixed provider for credential operations', async () => {
    const app = harness()
    await app.invoke(ipcChannels.settingsSaveProviderApiKey, {
      provider: 'deepseek',
      apiKey: 'sk-deepseek',
    })

    expect(app.dependencies.settings.saveProviderApiKey)
      .toHaveBeenCalledWith('deepseek', 'sk-deepseek')

    await expect(app.invoke(ipcChannels.settingsListProviderModels, {
      provider: 'custom',
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(app.dependencies.settings.listProviderModels).not.toHaveBeenCalled()

    await app.invoke(ipcChannels.settingsListProviderModels, {
      provider: 'openrouter',
      refresh: true,
    })
    expect(app.dependencies.settings.listProviderModels).toHaveBeenCalledWith('openrouter', true)
  })

  it('returns authenticated token usage through the fixed settings channel', async () => {
    const app = harness()

    await expect(app.invoke(ipcChannels.settingsGetTokenUsage)).resolves.toMatchObject({
      today: { totalTokens: 0 },
      yesterday: { totalTokens: 0 },
      week: { totalTokens: 0 },
      month: { totalTokens: 0 },
      allTime: { totalTokens: 0 },
    })
    expect(app.dependencies.auth.requireSession).toHaveBeenCalled()
    expect(app.dependencies.settings.getTokenUsage).toHaveBeenCalledWith()
  })

  it('rejects token usage before calling the zero-argument settings service when unauthenticated', async () => {
    const app = harness()
    vi.mocked(app.dependencies.auth.requireSession)
      .mockRejectedValueOnce(toSafeAppError({ code: 'AUTH_REQUIRED' }))

    await expect(app.invoke(ipcChannels.settingsGetTokenUsage))
      .rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    expect(app.dependencies.settings.getTokenUsage).not.toHaveBeenCalled()
  })

  it('rejects invalid token usage service output', async () => {
    const app = harness()
    vi.mocked(app.dependencies.settings.getTokenUsage).mockResolvedValueOnce({
      ...emptyUsageSnapshot(),
      today: { ...emptyUsageSnapshot().today, totalTokens: 1 },
    } as never)

    await expect(app.invoke(ipcChannels.settingsGetTokenUsage))
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
  })

  it('rejects a request from an untrusted sender frame', async () => {
    const app = harness()
    await expect(app.invokeFrom('https://attacker.invalid/', ipcChannels.settingsGet))
      .rejects.toMatchObject({ code: 'UNTRUSTED_SENDER' })
    expect(app.dependencies.settings.get).not.toHaveBeenCalled()
  })

  it('validates fixed media and generation-preference requests before invoking services', async () => {
    const app = harness()
    const preferences = {
      outputType: 'auto', models: {},
      generation: {
        image: { count: 1, resolution: '1K', aspectRatio: 'auto', format: 'png' },
        audio: { format: 'mp3' },
        video: { durationSeconds: 5, resolution: '720p', aspectRatio: 'auto', generateAudio: false },
      },
    } as const
    vi.mocked(app.dependencies.chat.getGenerationPreferences).mockResolvedValue(preferences)
    vi.mocked(app.dependencies.chat.updateGenerationPreferences).mockResolvedValue(preferences)

    await app.invoke(ipcChannels.mediaRemoveDraft, { conversationId: 'conversation_1', assetId: 'asset_1' })
    await app.invoke(ipcChannels.chatGetGenerationPreferences, { conversationId: 'conversation_1' })
    await app.invoke(ipcChannels.chatUpdateGenerationPreferences, { conversationId: 'conversation_1', preferences })

    expect(app.dependencies.media.removeDraft).toHaveBeenCalledWith({ conversationId: 'conversation_1', assetId: 'asset_1' })
    expect(app.dependencies.chat.getGenerationPreferences).toHaveBeenCalledWith('conversation_1')
    expect(app.dependencies.chat.updateGenerationPreferences).toHaveBeenCalledWith('conversation_1', preferences)
    await expect(app.invoke(ipcChannels.mediaImportDroppedFiles, {
      conversationId: 'conversation_1', existingAssetIds: [], paths: Array.from({ length: 6 }, (_, index) => `/private/${index}.png`),
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(app.invoke(ipcChannels.chatUpdateGenerationPreferences, {
      conversationId: 'conversation_1', preferences: { ...preferences, unexpected: true },
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('rejects media operations from an iframe and never returns raw service failures', async () => {
    const app = harness()
    vi.mocked(app.dependencies.media.reveal).mockRejectedValueOnce(new Error('/private/asset.png unavailable'))

    await expect(app.invokeFrom('http://127.0.0.1:5173/iframe', ipcChannels.mediaReveal, { assetId: 'asset_1' }))
      .rejects.toMatchObject({ code: 'UNTRUSTED_SENDER' })
    const failure = await app.invoke(ipcChannels.mediaReveal, { assetId: 'asset_1' }).catch((error) => error)
    expect(failure).toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(JSON.stringify(failure)).not.toContain('/private/asset.png')
  })

  it('rejects a production file sender with an injected authority while allowing route hashes', async () => {
    const filePath = '/app/renderer/index.html'
    const trusted = pathToFileURL(filePath).href
    const app = harness(trusted, { kind: 'production', filePath })

    app.setSenderUrl(`${trusted}#/settings`)
    await expect(app.invoke(ipcChannels.chatListConversations)).resolves.toEqual([])

    for (const url of [
      `file://attacker${new URL(trusted).pathname}`,
      `file://user:secret@attacker${new URL(trusted).pathname}`,
      `file://%61ttacker${new URL(trusted).pathname}`,
      `file:\\attacker${new URL(trusted).pathname}`,
      `${trusted}?host=attacker`,
    ]) {
      app.setSenderUrl(url)
      await expect(app.invoke(ipcChannels.chatListConversations))
        .rejects.toMatchObject({ code: 'UNTRUSTED_SENDER' })
    }
  })

  it('rejects subframes and a different webContents identity', async () => {
    const app = harness()
    const handler = app.handlers.get(ipcChannels.settingsGet)!
    const mainFrame = { url: 'http://127.0.0.1:5173/' }
    const sender = { id: 1, isDestroyed: () => false, mainFrame }

    await expect(handler({ sender, senderFrame: { url: mainFrame.url } }))
      .rejects.toMatchObject({ code: 'UNTRUSTED_SENDER' })
  })

  it('validates service output before returning it to the renderer', async () => {
    const app = harness()
    vi.mocked(app.dependencies.chat.listConversations).mockResolvedValueOnce([
      { id: 'c1', title: 'Conversation', createdAt: 'not-a-date', updatedAt: 'not-a-date' },
    ])

    await expect(app.invoke(ipcChannels.chatListConversations))
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
  })

  it('registers only fixed request channels and disposes exactly those handlers', () => {
    const app = harness()
    expect(app.handlers.has(ipcChannels.chatEvent)).toBe(false)
    expect(app.handlers.has(ipcChannels.executionsEvent)).toBe(false)
    expect(app.handlers.has(ipcChannels.settingsGet)).toBe(true)

    app.dispose()
    app.dispose()
    expect(app.removed.filter((channel) => channel === ipcChannels.settingsGet)).toHaveLength(1)
    expect(app.handlers).toHaveLength(0)
  })

  it('opens only a canonical default-port HTTPS URL through the explicit system action', async () => {
    const app = harness()
    await app.invoke(ipcChannels.systemOpenExternal, { url: 'https://example.com/docs?q=1' })
    expect(app.dependencies.system.openExternal).toHaveBeenCalledWith('https://example.com/docs?q=1')

    await expect(app.invoke(ipcChannels.systemOpenExternal, { url: 'https://user@example.com/' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(app.invoke(ipcChannels.systemOpenExternal, { url: 'file:///tmp/a' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(app.invoke(ipcChannels.systemOpenExternal, { url: 'https://example.com:444/' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})
