import { describe, expect, it, vi } from 'vitest'
import { ipcChannels, toSafeAppError, type AppSettings } from '@autoforge/shared'
import { pathToFileURL } from 'node:url'
import {
  registerDesktopIpc,
  type DesktopIpcServices,
  type IpcInvokeEvent,
  type IpcMainPort,
} from './register-ipc.js'

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
      login: vi.fn().mockResolvedValue(authSession),
      register: vi.fn().mockResolvedValue(authSession),
      logout: vi.fn().mockResolvedValue(undefined),
      requireSession: vi.fn().mockResolvedValue(authSession),
    },
    chat: {
      listConversations: vi.fn().mockResolvedValue([]),
      listMessages: vi.fn().mockResolvedValue([]),
      createConversation: vi.fn(),
      renameConversation: vi.fn(),
      deleteConversation: vi.fn(),
      send: vi.fn().mockResolvedValue({ requestId: 'request_1' }),
      cancel: vi.fn(),
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
    await expect(app.invoke(ipcChannels.authRegister, {
      account: 'Alice', password: 'password',
    })).resolves.toEqual(authSession)
    await expect(app.invoke(ipcChannels.authLogin, {
      account: 'Alice', password: 'password',
    })).resolves.toEqual(authSession)
    await expect(app.invoke(ipcChannels.authLogout)).resolves.toBeUndefined()
    expect(app.dependencies.auth.requireSession).not.toHaveBeenCalled()
  })

  it('rejects business operations without a session', async () => {
    const app = harness()
    vi.mocked(app.dependencies.auth.requireSession)
      .mockRejectedValueOnce(toSafeAppError({ code: 'AUTH_REQUIRED' }))

    await expect(app.invoke(ipcChannels.chatListConversations))
      .rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    expect(app.dependencies.chat.listConversations).not.toHaveBeenCalled()
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
