import { describe, expect, it, vi } from 'vitest'
import { ipcChannels } from '@autoforge/shared'
import { createDesktopApi, type DesktopBridgePorts, type IpcRendererPort } from './bridge.js'

function harness(ports: Partial<DesktopBridgePorts> = {}) {
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
  return {
    ipcRenderer,
    listeners,
    api: createDesktopApi(ipcRenderer, { getPathForFile: () => '', ...ports }),
  }
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

  it('uses provider-aware credential channels without exposing generic transport', async () => {
    const app = harness()
    await app.api.settings.saveProviderApiKey('deepseek', 'sk-deepseek')
    await app.api.settings.listProviderModels('openrouter')

    expect(app.ipcRenderer.invoke).toHaveBeenCalledWith(
      ipcChannels.settingsSaveProviderApiKey,
      { provider: 'deepseek', apiKey: 'sk-deepseek' },
    )
    expect(app.ipcRenderer.invoke).toHaveBeenCalledWith(
      ipcChannels.settingsListProviderModels,
      { provider: 'openrouter' },
    )
    expect(app.api).not.toHaveProperty('invoke')
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

  it('lists local projects through a fixed developer channel', async () => {
    const app = harness()
    await app.api.developer.listProjects()
    expect(app.ipcRenderer.invoke).toHaveBeenCalledWith(ipcChannels.developerListProjects, undefined)
  })

  it('resolves dropped-file paths only in preload, filters blanks, and uses a fixed channel', async () => {
    const getPathForFile = vi.fn()
      .mockReturnValueOnce('/private/photo.png')
      .mockReturnValueOnce('')
    const app = harness({ getPathForFile })

    await app.api.media.importDroppedFiles(
      { conversationId: 'conversation_1', existingAssetIds: [] },
      [{} as File, {} as File],
    )

    expect(app.ipcRenderer.invoke).toHaveBeenCalledWith(ipcChannels.mediaImportDroppedFiles, {
      conversationId: 'conversation_1', existingAssetIds: [], paths: ['/private/photo.png'],
    })
    expect(app.api).not.toHaveProperty('getPathForFile')
    expect(JSON.stringify(app.api)).not.toContain('/private/photo.png')
  })

  it('maps every fixed media action and generation preferences without a generic transport', async () => {
    const app = harness()
    const context = { conversationId: 'conversation_1', existingAssetIds: [] }
    const preferences = {
      outputType: 'image' as const,
      models: { image: 'image-model' },
      generation: {
        image: { count: 1, resolution: '1K' as const, aspectRatio: 'auto' as const, format: 'png' as const },
        audio: { format: 'mp3' as const },
        video: { durationSeconds: 5, resolution: '720p' as const, aspectRatio: 'auto' as const, generateAudio: false },
      },
    } as const

    await app.api.media.pickFiles(context)
    await app.api.media.importClipboardImage(context)
    await app.api.media.removeDraft({ conversationId: 'conversation_1', assetId: 'asset_1' })
    await app.api.media.saveCopy('asset_1')
    await app.api.media.reveal('asset_1')
    await app.api.media.pauseVideoJob('job_1')
    await app.api.media.resumeVideoJob('job_1')
    await app.api.chat.getGenerationPreferences('conversation_1')
    await app.api.chat.updateGenerationPreferences('conversation_1', preferences)

    expect(app.ipcRenderer.invoke).toHaveBeenCalledWith(ipcChannels.mediaPickFiles, context)
    expect(app.ipcRenderer.invoke).toHaveBeenCalledWith(ipcChannels.mediaImportClipboardImage, context)
    expect(app.ipcRenderer.invoke).toHaveBeenCalledWith(ipcChannels.mediaRemoveDraft, { conversationId: 'conversation_1', assetId: 'asset_1' })
    expect(app.ipcRenderer.invoke).toHaveBeenCalledWith(ipcChannels.mediaSaveCopy, { assetId: 'asset_1' })
    expect(app.ipcRenderer.invoke).toHaveBeenCalledWith(ipcChannels.mediaReveal, { assetId: 'asset_1' })
    expect(app.ipcRenderer.invoke).toHaveBeenCalledWith(ipcChannels.mediaPauseVideoJob, { jobId: 'job_1' })
    expect(app.ipcRenderer.invoke).toHaveBeenCalledWith(ipcChannels.mediaResumeVideoJob, { jobId: 'job_1' })
    expect(app.ipcRenderer.invoke).toHaveBeenCalledWith(ipcChannels.chatGetGenerationPreferences, { conversationId: 'conversation_1' })
    expect(app.ipcRenderer.invoke).toHaveBeenCalledWith(ipcChannels.chatUpdateGenerationPreferences, { conversationId: 'conversation_1', preferences })
    expect(app.api).not.toHaveProperty('invoke')
    expect(app.api).not.toHaveProperty('ipcRenderer')
  })

  it('normalizes IPC errors without exposing resolved paths', async () => {
    const app = harness({ getPathForFile: () => '/private/photo.png' })
    vi.mocked(app.ipcRenderer.invoke).mockRejectedValueOnce(new Error('open /private/photo.png failed'))

    await expect(app.api.media.importDroppedFiles(
      { conversationId: 'conversation_1', existingAssetIds: [] },
      [{} as File],
    )).rejects.toEqual({ code: 'INTERNAL_ERROR', message: 'Unexpected application error' })
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
