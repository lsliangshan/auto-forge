import { describe, expect, it, vi } from 'vitest'
import { ipcChannels } from '@autoforge/shared'
import { createDesktopApi, type IpcRendererPort } from './bridge.js'

function harness() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const ipcRenderer: IpcRendererPort = {
    invoke: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((channel, listener) => {
      const channelListeners = listeners.get(channel) ?? new Set()
      channelListeners.add(listener)
      listeners.set(channel, channelListeners)
    }),
    removeListener: vi.fn((channel, listener) => listeners.get(channel)?.delete(listener)),
  }
  return { ipcRenderer, listeners, api: createDesktopApi(ipcRenderer) }
}

describe('preload desktop bridge', () => {
  it('uses literal fixed channels without exposing a generic transport', async () => {
    const app = harness()
    await app.api.chat.renameConversation('c1', 'Renamed')
    expect(app.ipcRenderer.invoke).toHaveBeenCalledWith(ipcChannels.chatRenameConversation, {
      conversationId: 'c1', title: 'Renamed',
    })
    expect(app.api).not.toHaveProperty('invoke')
    expect(app.api).not.toHaveProperty('ipcRenderer')
  })

  it('removes an exact workflow version through its fixed channel', async () => {
    const app = harness()
    await app.api.workflows.remove('browser.search.baidu', '1.0.0')

    expect(app.ipcRenderer.invoke).toHaveBeenCalledWith(ipcChannels.workflowsRemove, {
      id: 'browser.search.baidu', version: '1.0.0',
    })
  })

  it('changes only an exact workflow version through its fixed channel', async () => {
    const app = harness()
    await app.api.workflows.setEnabled('browser.search.baidu', '2.0.0', false)
    expect(app.ipcRenderer.invoke).toHaveBeenCalledWith(ipcChannels.workflowsSetEnabled, {
      id: 'browser.search.baidu', version: '2.0.0', enabled: false,
    })
  })

  it('reads persisted messages through the fixed conversation channel', async () => {
    const app = harness()
    await app.api.chat.listMessages('conversation_1')
    expect(app.ipcRenderer.invoke).toHaveBeenCalledWith(ipcChannels.chatListMessages, { conversationId: 'conversation_1' })
  })

  it('removes exactly its wrapped event listener with an idempotent unsubscribe', () => {
    const app = harness()
    const listener = vi.fn()
    const unsubscribe = app.api.chat.onEvent(listener)
    const wrapped = [...app.listeners.get(ipcChannels.chatEvent)!][0]!
    wrapped({}, { type: 'status', conversationId: 'c1', requestId: 'r1', status: 'completed' })
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    unsubscribe()
    expect(app.ipcRenderer.removeListener).toHaveBeenCalledTimes(1)
    expect(app.ipcRenderer.removeListener).toHaveBeenCalledWith(ipcChannels.chatEvent, wrapped)
  })
})
