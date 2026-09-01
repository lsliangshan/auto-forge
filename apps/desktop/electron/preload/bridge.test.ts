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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
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
    await app.api.settings.getCloudSyncConsentState()
    await app.api.settings.revokeCloudSyncConsent({ confirmed: true })
    await app.api.settings.previewLegacyImport()
    await app.api.settings.importLegacyData(importRequest)
    await app.api.settings.getAccountDataPreferences()
    await app.api.settings.updateAccountDataPreferences({ timezone: 'UTC', displayCurrency: 'USD' })
    await app.api.settings.getRemoteUsage()

    expect(vi.mocked(app.ipcRenderer.invoke).mock.calls.slice(-8)).toEqual([
      [ipcChannels.settingsRecordPrivacyConsent, cloudSyncConsent],
      [ipcChannels.settingsGetCloudSyncConsentState, undefined],
      [ipcChannels.settingsRevokeCloudSyncConsent, { confirmed: true }],
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
    const clearToken = 'a'.repeat(64)

    await app.api.chat.takeOverBrowser({ requestId: 'request_1', bindingId: 'binding_1' })
    await app.api.chat.listBrowserAudit('binding_1')
    await app.api.settings.captureDataClearToken()
    await app.api.settings.clearLocalData('all', clearToken)
    await app.api.settings.clearBrowserData(clearToken)

    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(1, ipcChannels.chatTakeOverBrowser, {
      requestId: 'request_1', bindingId: 'binding_1',
    })
    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(2, ipcChannels.chatListBrowserAudit, {
      bindingId: 'binding_1',
    })
    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(3, ipcChannels.settingsCaptureDataClearToken, undefined)
    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(4, ipcChannels.settingsClearLocalData, {
      scope: 'all', token: clearToken,
    })
    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(5, ipcChannels.settingsClearBrowserData, {
      token: clearToken,
    })
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

  it('maps developer draft operations and run attachments to fixed path-free channels', async () => {
    const app = harness()

    vi.mocked(app.ipcRenderer.invoke).mockResolvedValueOnce([])
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ executionId: 'execution_1', conversionCapable: true })

    expect(app.api.developer.pickFiles).toBeTypeOf('function')
    expect(app.api.developer.removeAttachment).toBeTypeOf('function')
    expect(app.api.developer.clearAttachments).toBeTypeOf('function')
    await app.api.developer.pickFiles({ projectId: 'project_1', existingAttachmentIds: ['draft_1'] })
    await app.api.developer.removeAttachment({ projectId: 'project_1', attachmentId: 'draft_1' })
    await app.api.developer.clearAttachments({ projectId: 'project_1' })
    const runResult = await app.api.developer.run({
      projectId: 'project_1', input: { files: [0] }, attachmentIds: ['draft_1'],
    })

    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(1, ipcChannels.developerPickFiles, {
      projectId: 'project_1', existingAttachmentIds: ['draft_1'],
    })
    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(2, ipcChannels.developerRemoveAttachment, {
      projectId: 'project_1', attachmentId: 'draft_1',
    })
    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(3, ipcChannels.developerClearAttachments, {
      projectId: 'project_1',
    })
    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(4, ipcChannels.developerRun, {
      projectId: 'project_1', input: { files: [0] }, attachmentIds: ['draft_1'],
    })
    expect(runResult).toEqual({ executionId: 'execution_1', conversionCapable: true })
    expect(JSON.stringify(vi.mocked(app.ipcRenderer.invoke).mock.calls)).not.toContain('/private/')
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

  it('exposes only fixed Provider-consent and bounded preview knowledge calls', async () => {
    const app = harness()
    vi.mocked(app.ipcRenderer.invoke)
      .mockResolvedValueOnce({ provider: 'deepseek', status: 'granted' })
      .mockResolvedValueOnce({ provider: 'deepseek', status: 'unknown' })
      .mockResolvedValueOnce({ kind: 'available', content: '文档预览', truncated: false })
      .mockResolvedValueOnce({ kind: 'available', preview: '最小原文' })
    await app.api.knowledge.setConsent('deepseek', 'granted')
    await app.api.knowledge.revokeConsent('deepseek')
    await app.api.knowledge.getDocumentPreview('document_1')
    await app.api.knowledge.getSourcePreview({
      evidenceId: 'evidence:1', baseId: 'base_1', documentId: 'document_1', versionId: 'version_1',
      coordinate: { kind: 'text', line: 1, startOffset: 0, endOffset: 4 },
    })
    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(1, ipcChannels.knowledgeSetConsent, {
      provider: 'deepseek', status: 'granted',
    })
    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(2, ipcChannels.knowledgeRevokeConsent, {
      provider: 'deepseek',
    })
    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(3, ipcChannels.knowledgeGetDocumentPreview, {
      documentId: 'document_1',
    })
    expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(4, ipcChannels.knowledgeGetSourcePreview, {
      evidenceId: 'evidence:1', baseId: 'base_1', documentId: 'document_1', versionId: 'version_1',
      coordinate: { kind: 'text', line: 1, startOffset: 0, endOffset: 4 },
    })
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

  it('maps only opaque conversion identifiers and validates subscribed events', async () => {
    const app = harness()

    await app.api.conversion.listForExecution({ executionId: 'execution_1' })
    await app.api.conversion.cancel({ jobId: 'job_1' })
    await app.api.conversion.retry({ jobId: 'job_2' })
    await app.api.conversion.saveCopy({ artifactId: 'artifact_1' })
    await app.api.conversion.preview({ artifactId: 'artifact_2' })
    await app.api.conversion.reveal({ artifactId: 'artifact_2' })
    await app.api.conversion.deleteArtifact({ artifactId: 'artifact_3' })

    expect(vi.mocked(app.ipcRenderer.invoke).mock.calls.slice(-7)).toEqual([
      [ipcChannels.conversionListForExecution, { executionId: 'execution_1' }],
      [ipcChannels.conversionCancel, { jobId: 'job_1' }],
      [ipcChannels.conversionRetry, { jobId: 'job_2' }],
      [ipcChannels.conversionSaveCopy, { artifactId: 'artifact_1' }],
      [ipcChannels.conversionPreview, { artifactId: 'artifact_2' }],
      [ipcChannels.conversionReveal, { artifactId: 'artifact_2' }],
      [ipcChannels.conversionDeleteArtifact, { artifactId: 'artifact_3' }],
    ])
    expect(app.api.conversion).not.toHaveProperty('path')
    expect(app.api.conversion).not.toHaveProperty('invoke')

    const listener = vi.fn()
    const unsubscribe = app.api.conversion.onEvent(listener)
    expect(app.ipcRenderer.invoke).toHaveBeenCalledWith('conversion:subscribe', undefined)
    const subscribeIndex = vi.mocked(app.ipcRenderer.invoke).mock.calls.findIndex(
      ([channel]) => channel === 'conversion:subscribe',
    )
    expect(vi.mocked(app.ipcRenderer.on).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(app.ipcRenderer.invoke).mock.invocationCallOrder[subscribeIndex]!)
    const wrapped = [...app.listeners.get(ipcChannels.conversionEvent)!][0]!
    const event = {
      type: 'job_updated',
      job: {
        jobId: 'job_1', executionId: 'execution_1', targetFormat: 'png',
        status: 'completed', epoch: 0, progress: 100,
        artifacts: [{
          artifactId: 'artifact_1', status: 'ready', displayName: 'result.png',
          detectedFormat: 'png', mimeType: 'image/png', byteSize: 8,
        }],
      },
    }
    wrapped({}, event)
    wrapped({}, { ...event, managedPath: '/private/conversion/result.png' })
    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith(event)

    unsubscribe()
    unsubscribe()
    expect(app.ipcRenderer.removeListener).toHaveBeenCalledWith(ipcChannels.conversionEvent, wrapped)
    await vi.waitFor(() => expect(app.ipcRenderer.invoke)
      .toHaveBeenCalledWith('conversion:unsubscribe', undefined))
  })

  it('installs the local conversion listener before Main can replay a terminal transition', () => {
    const app = harness()
    const terminal = {
      type: 'job_updated',
      job: {
        jobId: 'job_terminal', executionId: 'execution_terminal', targetFormat: 'png',
        status: 'completed', epoch: 0, progress: 100, artifacts: [],
      },
    }
    vi.mocked(app.ipcRenderer.invoke).mockImplementation(async (channel) => {
      if (channel === 'conversion:subscribe') {
        for (const listener of app.listeners.get(ipcChannels.conversionEvent) ?? []) {
          listener({}, terminal)
        }
      }
      return undefined
    })
    const listener = vi.fn()

    const unsubscribe = app.api.conversion.onEvent(listener)

    expect(listener).toHaveBeenCalledWith(terminal)
    unsubscribe()
  })

  it('shares one serialized Main conversion subscription across local listeners', async () => {
    const app = harness()
    const first = vi.fn()
    const second = vi.fn()

    const unsubscribeFirst = app.api.conversion.onEvent(first)
    const unsubscribeSecond = app.api.conversion.onEvent(second)

    await vi.waitFor(() => expect(vi.mocked(app.ipcRenderer.invoke).mock.calls.filter(
      ([channel]) => channel === ipcChannels.conversionSubscribe,
    )).toHaveLength(1))
    expect(app.listeners.get(ipcChannels.conversionEvent)).toHaveLength(1)

    unsubscribeFirst()
    expect(vi.mocked(app.ipcRenderer.invoke).mock.calls.filter(
      ([channel]) => channel === ipcChannels.conversionUnsubscribe,
    )).toHaveLength(0)

    const wrapped = [...app.listeners.get(ipcChannels.conversionEvent)!][0]!
    wrapped({}, {
      type: 'job_updated',
      job: {
        jobId: 'job_shared', executionId: 'execution_shared', targetFormat: 'png',
        status: 'completed', epoch: 0, progress: 100, artifacts: [],
      },
    })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledOnce()

    unsubscribeSecond()
    await vi.waitFor(() => expect(vi.mocked(app.ipcRenderer.invoke).mock.calls.filter(
      ([channel]) => channel === ipcChannels.conversionUnsubscribe,
    )).toHaveLength(1))
    expect(app.listeners.get(ipcChannels.conversionEvent)).toHaveLength(0)
  })

  it('serializes immediate cleanup behind an in-flight conversion subscribe', async () => {
    const app = harness()
    const subscribe = deferred<void>()
    let mainSubscribed = false
    vi.mocked(app.ipcRenderer.invoke).mockImplementation(async (channel) => {
      if (channel === ipcChannels.conversionSubscribe) {
        await subscribe.promise
        mainSubscribed = true
      } else if (channel === ipcChannels.conversionUnsubscribe) {
        mainSubscribed = false
      }
      return undefined
    })

    const unsubscribe = app.api.conversion.onEvent(vi.fn())
    await vi.waitFor(() => expect(vi.mocked(app.ipcRenderer.invoke).mock.calls.filter(
      ([channel]) => channel === ipcChannels.conversionSubscribe,
    )).toHaveLength(1))
    unsubscribe()
    subscribe.resolve()

    await vi.waitFor(() => expect(vi.mocked(app.ipcRenderer.invoke).mock.calls.filter(
      ([channel]) => channel === ipcChannels.conversionUnsubscribe,
    )).toHaveLength(1))
    expect(mainSubscribed).toBe(false)
    expect(app.listeners.get(ipcChannels.conversionEvent)).toHaveLength(0)
  })

  it('cleans a failed subscribe and boundedly retries for the existing listener', async () => {
    const app = harness()
    let subscribeAttempts = 0
    vi.mocked(app.ipcRenderer.invoke).mockImplementation(async (channel) => {
      if (channel === ipcChannels.conversionSubscribe) {
        subscribeAttempts += 1
        if (subscribeAttempts === 1) throw new Error('failed before Main attached')
      }
      return undefined
    })
    const listener = vi.fn()

    const unsubscribe = app.api.conversion.onEvent(listener)

    await vi.waitFor(() => expect(subscribeAttempts).toBe(2))
    expect(vi.mocked(app.ipcRenderer.invoke).mock.calls.map(([channel]) => channel).slice(0, 3))
      .toEqual([
        ipcChannels.conversionSubscribe,
        ipcChannels.conversionUnsubscribe,
        ipcChannels.conversionSubscribe,
      ])
    const wrapped = [...app.listeners.get(ipcChannels.conversionEvent)!][0]!
    wrapped({}, {
      type: 'job_updated',
      job: {
        jobId: 'job_retry_success', executionId: 'execution_retry_success', targetFormat: 'png',
        status: 'completed', epoch: 0, progress: 100, artifacts: [],
      },
    })
    expect(listener).toHaveBeenCalledOnce()
    unsubscribe()
  })

  it('cleans an ambiguous attached-then-rejected subscribe before retrying', async () => {
    const app = harness()
    const operations: string[] = []
    let mainSubscribed = false
    let subscribeAttempts = 0
    vi.mocked(app.ipcRenderer.invoke).mockImplementation(async (channel) => {
      if (channel === ipcChannels.conversionSubscribe) {
        operations.push('subscribe')
        subscribeAttempts += 1
        mainSubscribed = true
        if (subscribeAttempts === 1) throw new Error('response rejected after Main attached')
      } else if (channel === ipcChannels.conversionUnsubscribe) {
        operations.push('unsubscribe')
        mainSubscribed = false
      }
      return undefined
    })

    const unsubscribe = app.api.conversion.onEvent(vi.fn())

    await vi.waitFor(() => expect(subscribeAttempts).toBe(2))
    expect(operations).toEqual(['subscribe', 'unsubscribe', 'subscribe'])
    expect(mainSubscribed).toBe(true)
    unsubscribe()
    await vi.waitFor(() => expect(mainSubscribed).toBe(false))
  })

  it('cleans an ambiguous failed subscribe without retry after all listeners are removed', async () => {
    const app = harness()
    const rejectSubscribe = deferred<void>()
    const operations: string[] = []
    let mainSubscribed = false
    vi.mocked(app.ipcRenderer.invoke).mockImplementation(async (channel) => {
      if (channel === ipcChannels.conversionSubscribe) {
        operations.push('subscribe')
        mainSubscribed = true
        await rejectSubscribe.promise
        throw new Error('response rejected after Main attached')
      } else if (channel === ipcChannels.conversionUnsubscribe) {
        operations.push('unsubscribe')
        mainSubscribed = false
      }
      return undefined
    })

    const unsubscribe = app.api.conversion.onEvent(vi.fn())
    await vi.waitFor(() => expect(mainSubscribed).toBe(true))
    unsubscribe()
    rejectSubscribe.resolve()

    await vi.waitFor(() => expect(operations).toEqual(['subscribe', 'unsubscribe']))
    expect(mainSubscribed).toBe(false)
    expect(app.listeners.get(ipcChannels.conversionEvent)).toHaveLength(0)
  })

  it('lets a second listener reconcile after bounded persistent subscribe failure', async () => {
    const app = harness()
    let allowSubscribe = false
    let subscribeAttempts = 0
    let unsubscribeAttempts = 0
    vi.mocked(app.ipcRenderer.invoke).mockImplementation(async (channel) => {
      if (channel === ipcChannels.conversionSubscribe) {
        subscribeAttempts += 1
        if (!allowSubscribe) throw new Error('persistent subscribe failure')
      } else if (channel === ipcChannels.conversionUnsubscribe) {
        unsubscribeAttempts += 1
      }
      return undefined
    })
    const first = vi.fn()
    const second = vi.fn()
    const unsubscribeFirst = app.api.conversion.onEvent(first)

    await vi.waitFor(() => {
      expect(subscribeAttempts).toBe(2)
      expect(unsubscribeAttempts).toBe(2)
    })
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(subscribeAttempts).toBe(2)

    allowSubscribe = true
    const unsubscribeSecond = app.api.conversion.onEvent(second)

    await vi.waitFor(() => expect(subscribeAttempts).toBe(3))
    const wrapped = [...app.listeners.get(ipcChannels.conversionEvent)!][0]!
    wrapped({}, {
      type: 'job_updated',
      job: {
        jobId: 'job_second_reconcile', executionId: 'execution_second_reconcile', targetFormat: 'pdf',
        status: 'completed', epoch: 0, progress: 100, artifacts: [],
      },
    })
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()

    unsubscribeFirst()
    expect(unsubscribeAttempts).toBe(2)
    unsubscribeSecond()
    await vi.waitFor(() => expect(unsubscribeAttempts).toBe(3))
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
