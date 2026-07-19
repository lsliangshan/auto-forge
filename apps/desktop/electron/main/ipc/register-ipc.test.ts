import { describe, expect, it, vi } from 'vitest'
import { ipcChannels } from '@autoforge/shared'
import { pathToFileURL } from 'node:url'
import {
  registerDesktopIpc,
  type DesktopIpcServices,
  type IpcInvokeEvent,
  type IpcMainPort,
} from './register-ipc.js'

function services(): DesktopIpcServices {
  return {
    chat: {
      listConversations: vi.fn().mockResolvedValue([]),
      createConversation: vi.fn(),
      renameConversation: vi.fn(),
      deleteConversation: vi.fn(),
      send: vi.fn().mockResolvedValue({ requestId: 'request_1' }),
      cancel: vi.fn(),
    },
    workflows: { list: vi.fn(), get: vi.fn(), setEnabled: vi.fn(), installProject: vi.fn() },
    developer: {
      createProject: vi.fn(), registerProject: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(),
      validate: vi.fn(), run: vi.fn(),
    },
    executions: { list: vi.fn(), get: vi.fn(), decide: vi.fn(), cancel: vi.fn() },
    permissions: { listGrants: vi.fn(), revoke: vi.fn() },
    settings: {
      get: vi.fn(), update: vi.fn(), saveOpenRouterKey: vi.fn(), clearOpenRouterKey: vi.fn(),
      validateOpenRouterKey: vi.fn(), listModels: vi.fn(), clearLocalData: vi.fn(),
    },
    system: { openExternal: vi.fn() },
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
  it('rejects an invalid chat request before invoking the orchestrator', async () => {
    const app = harness()
    await expect(app.invoke(ipcChannels.chatSend, { conversationId: '', content: '' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(app.dependencies.chat.send).not.toHaveBeenCalled()
  })

  it('rejects a request from an untrusted sender frame', async () => {
    const app = harness()
    await expect(app.invokeFrom('https://attacker.invalid/', ipcChannels.settingsGet))
      .rejects.toMatchObject({ code: 'UNTRUSTED_SENDER' })
    expect(app.dependencies.settings.get).not.toHaveBeenCalled()
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
