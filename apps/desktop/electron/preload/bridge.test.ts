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
  it('maps the fixed CloudBase authentication methods', async () => {
    const app = harness()
    await app.api.auth.getSession()
    await app.api.auth.refreshAuthorization()
    await app.api.auth.sendOtp({ intent: 'login', channel: 'phone', target: '18311032722' })
    await app.api.auth.verifyOtp({ challengeId: 'challenge_1', code: '123456' })
    await app.api.auth.cancelOtp('challenge_1')
    await app.api.auth.loginWithPassword({ account: 'Alice_1', password: 'password' })
    await app.api.auth.logout()

    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(1, ipcChannels.authGetSession, undefined)
    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(2, ipcChannels.authRefreshAuthorization, undefined)
    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(3, ipcChannels.authSendOtp, {
      intent: 'login', channel: 'phone', target: '18311032722',
    })
    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(4, ipcChannels.authVerifyOtp, {
      challengeId: 'challenge_1', code: '123456',
    })
    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(5, ipcChannels.authCancelOtp, {
      challengeId: 'challenge_1',
    })
    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(6, ipcChannels.authLoginWithPassword, {
      account: 'Alice_1', password: 'password',
    })
    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(7, ipcChannels.authLogout, undefined)
    expect(Object.keys(app.api.auth)).toEqual([
      'getSession', 'refreshAuthorization', 'sendOtp', 'verifyOtp', 'cancelOtp', 'loginWithPassword', 'logout',
    ])
    expect(app.api.auth).not.toHaveProperty('invoke')
    expect(app.api.auth).not.toHaveProperty('login')
    expect(app.api.auth).not.toHaveProperty('register')
  })

  it('maps only the fixed user administration methods', async () => {
    const app = harness()
    const list = { page: 1, pageSize: 20 as const }
    const update = {
      requestId: 'request_1', targetUserId: 'user_1', newRole: 'super_admin' as const, expectedVersion: 1,
    }
    await app.api.userAdmin.list(list)
    await app.api.userAdmin.updateRole(update)

    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(1, ipcChannels.userAdminList, list)
    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(2, ipcChannels.userAdminUpdateRole, update)
    expect(Object.keys(app.api.userAdmin)).toEqual(['list', 'updateRole'])
  })

  it('exposes only the fixed profile operations', async () => {
    const app = harness()
    const update = { displayName: 'Alice' }

    await app.api.profile.get()
    await app.api.profile.update(update)
    await app.api.profile.pickAndUploadAvatar()

    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(1, ipcChannels.profileGet, undefined)
    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(2, ipcChannels.profileUpdate, update)
    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(3, ipcChannels.profilePickAndUploadAvatar, undefined)
    expect(app.api.profile).not.toHaveProperty('invoke')
  })

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
    await app.api.settings.listProviderModels('openrouter', true)
    await app.api.settings.getTokenUsage()

    expect(app.ipcRenderer.invoke).toHaveBeenCalledWith(
      ipcChannels.settingsSaveProviderApiKey,
      { provider: 'deepseek', apiKey: 'sk-deepseek' },
    )
    expect(app.ipcRenderer.invoke).toHaveBeenCalledWith(
      ipcChannels.settingsListProviderModels,
      { provider: 'openrouter' },
    )
    expect(app.ipcRenderer.invoke).toHaveBeenCalledWith(
      ipcChannels.settingsListProviderModels,
      { provider: 'openrouter', refresh: true },
    )
    expect(app.ipcRenderer.invoke).toHaveBeenCalledWith(
      ipcChannels.settingsGetTokenUsage,
      undefined,
    )
    expect(app.api).not.toHaveProperty('invoke')
  })

  it('maps owner-free cloud consent, legacy import, preferences, and remote usage methods', async () => {
    const app = harness()
    const cloudSyncConsent = {
      purpose: 'cloud_sync' as const, documentVersion: 'cloud-sync-2026-08',
      consentedAt: '2026-08-25T00:00:00.000Z', clientVersion: '0.1.0',
    }
    const importRequest = { includeUnowned: false, cloudSyncConsent }

    await app.api.settings.recordPrivacyConsent(cloudSyncConsent)
    await app.api.settings.previewLegacyImport()
    await app.api.settings.importLegacyData(importRequest)
    await app.api.settings.getAccountDataPreferences()
    await app.api.settings.updateAccountDataPreferences({ timezone: 'UTC', displayCurrency: 'USD' })
    await app.api.settings.getRemoteUsage()

    expect(vi.mocked(app.ipcRenderer.invoke).mock.calls.slice(-6)).toEqual([
      [ipcChannels.settingsRecordPrivacyConsent, cloudSyncConsent],
      [ipcChannels.settingsPreviewLegacyImport, undefined],
      [ipcChannels.settingsImportLegacyData, importRequest],
      [ipcChannels.settingsGetAccountDataPreferences, undefined],
      [ipcChannels.settingsUpdateAccountDataPreferences, { timezone: 'UTC', displayCurrency: 'USD' }],
      [ipcChannels.settingsGetRemoteUsage, undefined],
    ])
    expect(JSON.stringify(vi.mocked(app.ipcRenderer.invoke).mock.calls)).not.toMatch(/owner|userId|uid/i)
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
    await app.api.chat.listConversations({ limit: 50, cursor: 'opaque-cursor-0001' })
    await app.api.chat.listMessages({
      conversationId: 'conversation_1', limit: 100, cursor: 'opaque-cursor-0002',
    })
    await app.api.chat.retrySync('conversation_1')
    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(1, ipcChannels.chatListConversations, {
      limit: 50, cursor: 'opaque-cursor-0001',
    })
    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(2, ipcChannels.chatListMessages, {
      conversationId: 'conversation_1', limit: 100, cursor: 'opaque-cursor-0002',
    })
    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(3, ipcChannels.chatRetrySync, {
      conversationId: 'conversation_1',
    })
    expect(JSON.stringify(vi.mocked(app.ipcRenderer.invoke).mock.calls)).not.toContain('userId')
  })

  it('maps browser continuation takeover, redacted audit, and explicit data clearing to fixed channels', async () => {
    const app = harness()

    await app.api.chat.takeOverBrowser({ requestId: 'request_1', bindingId: 'binding_1' })
    await app.api.chat.listBrowserAudit('binding_1')
    await app.api.settings.clearBrowserData()

    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(1, ipcChannels.chatTakeOverBrowser, {
      requestId: 'request_1', bindingId: 'binding_1',
    })
    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(2, ipcChannels.chatListBrowserAudit, {
      bindingId: 'binding_1',
    })
    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(3, ipcChannels.settingsClearBrowserData, undefined)
    expect(app.api.chat).not.toHaveProperty('invoke')
    expect(app.api.settings).not.toHaveProperty('clearStorageData')
  })

  it('lists local projects through a fixed developer channel', async () => {
    const app = harness()
    await app.api.developer.listProjects()
    expect(app.ipcRenderer.invoke).toHaveBeenCalledWith(ipcChannels.developerListProjects, undefined)
  })

  it('maps project entry mutations to fixed developer channels', async () => {
    const app = harness()

    await app.api.developer.createEntry('project_1', 'src', 'helpers.ts', 'file')
    await app.api.developer.renameEntry('project_1', 'src/helpers.ts', 'format.ts')
    await app.api.developer.deleteEntry('project_1', 'src/format.ts')

    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(1, ipcChannels.developerCreateEntry, {
      projectId: 'project_1', parentPath: 'src', name: 'helpers.ts', kind: 'file',
    })
    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(2, ipcChannels.developerRenameEntry, {
      projectId: 'project_1', relativePath: 'src/helpers.ts', name: 'format.ts',
    })
    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(3, ipcChannels.developerDeleteEntry, {
      projectId: 'project_1', relativePath: 'src/format.ts',
    })
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

  it('uses fixed path-free knowledge channels and returns only opaque import handles', async () => {
    // Catches a production change that exposes a generic filesystem bridge or forwards a local path.
    const app = harness()
    vi.mocked(app.ipcRenderer.invoke).mockResolvedValueOnce([{
      id: 'import_1', name: 'policy.txt', mimeType: 'text/plain', byteSize: 12,
    }])

    await expect(app.api.knowledge.pickImportFiles()).resolves.toEqual([{
      id: 'import_1', name: 'policy.txt', mimeType: 'text/plain', byteSize: 12,
    }])
    await app.api.knowledge.importDocument('base_1', 'import_1')
    await app.api.knowledge.restoreDocument('document_1')
    await app.api.knowledge.restoreBase('base_1')

    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(1, ipcChannels.knowledgePickImportFiles, undefined)
    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(2, ipcChannels.knowledgeImportDocument, {
      baseId: 'base_1', importHandleId: 'import_1',
    })
    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(3, ipcChannels.knowledgeRestoreDocument, {
      documentId: 'document_1',
    })
    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(4, ipcChannels.knowledgeRestoreBase, {
      baseId: 'base_1',
    })
    expect(app.api).not.toHaveProperty('getPathForFile')
    expect(JSON.stringify(app.api)).not.toContain('/private')
  })

  it('forwards only strict owner-free knowledge events', () => {
    // Catches a production change that forwards owner scope or local paths from Main events.
    const app = harness()
    const listener = vi.fn()
    app.api.knowledge.onEvent(listener)
    const wrapped = [...app.listeners.get(ipcChannels.knowledgeEvent)!][0]!
    const event = {
      type: 'document_updated',
      document: {
        id: 'document_1', baseId: 'base_1', name: 'policy.txt', mimeType: 'text/plain',
        status: 'ready', versionCount: 1, updatedAt: '2026-08-26T00:00:00.000Z',
      },
    }

    wrapped({}, event)
    wrapped({}, { ...event, ownerUserId: 'private-owner' })
    wrapped({}, { ...event, path: '/private/policy.txt' })

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith(event)
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

  it('forwards only strict owner-free conversation projection events', () => {
    const app = harness()
    const listener = vi.fn()
    app.api.chat.onEvent(listener)
    const wrapped = [...app.listeners.get(ipcChannels.chatEvent)!][0]!
    const event = {
      type: 'conversation_updated',
      conversationId: 'conversation_1',
      conversation: {
        id: 'conversation_1', title: 'Updated', titleState: 'user_named', revision: 2,
        syncState: 'syncing', createdAt: '2026-08-25T00:00:00.000Z',
        lastActivityAt: '2026-08-25T00:01:00.000Z',
        metadataUpdatedAt: '2026-08-25T00:01:00.000Z',
      },
    }

    wrapped({}, event)
    wrapped({}, { ...event, ownerUserId: 'private-owner' })

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith(event)
  })

  it('forwards only the strict owner-free conversation removal event', () => {
    const app = harness()
    const listener = vi.fn()
    app.api.chat.onEvent(listener)
    const wrapped = [...app.listeners.get(ipcChannels.chatEvent)!][0]!
    const event = { type: 'conversation_removed', conversationId: 'conversation_1' }

    wrapped({}, event)
    wrapped({}, { ...event, uid: 'private-owner' })
    wrapped({}, { ...event, revision: 3 })
    wrapped({}, { ...event, tombstone: { deletedAt: '2026-08-25T00:00:00.000Z' } })

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith(event)
  })
})
