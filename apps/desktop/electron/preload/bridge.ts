import {
  chatEventSchema,
  conversionJobEventSchema,
  executionEventSchema,
  ipcChannels,
  knowledgeEventSchema,
  toSafeAppError,
  type AppError,
  type DesktopAPI,
} from '@autoforge/shared'

type RendererListener = (event: unknown, payload: unknown) => void

export interface IpcRendererPort {
  invoke(channel: string, input?: unknown): Promise<unknown>
  on(channel: string, listener: RendererListener): void
  removeListener(channel: string, listener: RendererListener): void
}

export interface DesktopBridgePorts {
  getPathForFile(file: File): string
}

function appErrorFromIpc(error: unknown): AppError {
  const message = error instanceof Error ? error.message : String(error)
  const match = /AUTOFORGE_APP_ERROR:([A-Z_]+)/.exec(message)
  return toSafeAppError(match ? { code: match[1] } : error)
}

async function invoke<T>(ipcRenderer: IpcRendererPort, channel: string, input?: unknown): Promise<T> {
  try {
    return await ipcRenderer.invoke(channel, input) as T
  } catch (error) {
    throw appErrorFromIpc(error)
  }
}

function subscribe<T>(
  ipcRenderer: IpcRendererPort,
  channel: string,
  parse: (payload: unknown) => { success: boolean; data?: T },
  listener: (event: T) => void,
): () => void {
  const wrapped: RendererListener = (_event, payload) => {
    const result = parse(payload)
    if (result.success) listener(result.data as T)
  }
  ipcRenderer.on(channel, wrapped)
  let subscribed = true
  return () => {
    if (!subscribed) return
    subscribed = false
    ipcRenderer.removeListener(channel, wrapped)
  }
}

function createHandshakeSubscription<T>(
  ipcRenderer: IpcRendererPort,
  channel: string,
  subscribeChannel: string,
  unsubscribeChannel: string,
  parse: (payload: unknown) => { success: boolean; data?: T },
): (listener: (event: T) => void) => () => void {
  const maxSubscribeAttemptsPerGeneration = 2
  const listeners = new Set<(event: T) => void>()
  const wrapped: RendererListener = (_event, payload) => {
    const result = parse(payload)
    if (!result.success) return
    for (const listener of listeners) listener(result.data as T)
  }
  let mainSubscribed = false
  let generation = 0
  let synchronization: Promise<void> | undefined
  const startSynchronization = () => {
    if (synchronization) return
    let completedGeneration = -1
    synchronization = (async () => {
      while (true) {
        const observedGeneration = generation
        const wantsSubscription = listeners.size > 0
        if (!wantsSubscription) {
          if (mainSubscribed) {
            try {
              await invoke<void>(ipcRenderer, unsubscribeChannel)
            } catch {
              // Main may already have detached during logout or window cleanup.
            }
            mainSubscribed = false
          }
        } else if (!mainSubscribed) {
          let subscribeAttempts = 0
          while (listeners.size > 0
            && generation === observedGeneration
            && !mainSubscribed
            && subscribeAttempts < maxSubscribeAttemptsPerGeneration) {
            subscribeAttempts += 1
            try {
              await invoke<void>(ipcRenderer, subscribeChannel)
              mainSubscribed = true
            } catch {
              mainSubscribed = false
              try {
                await invoke<void>(ipcRenderer, unsubscribeChannel)
              } catch {
                // A rejected subscribe may have attached before its response failed.
              }
              mainSubscribed = false
            }
          }
        }
        if (observedGeneration === generation) {
          completedGeneration = observedGeneration
          return
        }
      }
    })().catch(() => { completedGeneration = generation }).finally(() => {
      synchronization = undefined
      if (completedGeneration !== generation) startSynchronization()
    })
  }
  const synchronize = () => {
    generation += 1
    startSynchronization()
  }
  return (listener) => {
    const registered = (event: T) => { listener(event) }
    const installLocalListener = listeners.size === 0
    listeners.add(registered)
    if (installLocalListener) {
      ipcRenderer.on(channel, wrapped)
    }
    synchronize()
    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      listeners.delete(registered)
      if (listeners.size !== 0) return
      ipcRenderer.removeListener(channel, wrapped)
      synchronize()
    }
  }
}

export function createDesktopApi(ipcRenderer: IpcRendererPort, ports: DesktopBridgePorts): DesktopAPI {
  const subscribeToConversionEvents = createHandshakeSubscription(
    ipcRenderer,
    ipcChannels.conversionEvent,
    ipcChannels.conversionSubscribe,
    ipcChannels.conversionUnsubscribe,
    (payload) => conversionJobEventSchema.safeParse(payload),
  )
  return {
    auth: {
      getSession: () => invoke(ipcRenderer, ipcChannels.authGetSession),
      refreshAuthorization: () => invoke(ipcRenderer, ipcChannels.authRefreshAuthorization),
      sendOtp: (input) => invoke(ipcRenderer, ipcChannels.authSendOtp, input),
      verifyOtp: (input) => invoke(ipcRenderer, ipcChannels.authVerifyOtp, input),
      cancelOtp: (challengeId) => invoke(ipcRenderer, ipcChannels.authCancelOtp, { challengeId }),
      loginWithPassword: (input) => invoke(ipcRenderer, ipcChannels.authLoginWithPassword, input),
      logout: (input) => invoke(ipcRenderer, ipcChannels.authLogout, input),
    },
    userAdmin: {
      list: (input) => invoke(ipcRenderer, ipcChannels.userAdminList, input),
      updateRole: (input) => invoke(ipcRenderer, ipcChannels.userAdminUpdateRole, input),
    },
    membership: {
      getCurrent: () => invoke(ipcRenderer, ipcChannels.membershipGetCurrent),
      getTarget: (targetUserId) => invoke(
        ipcRenderer, ipcChannels.membershipGetTarget, { targetUserId },
      ),
      mutate: (input) => invoke(ipcRenderer, ipcChannels.membershipMutate, input),
      listAudit: (input) => invoke(ipcRenderer, ipcChannels.membershipListAudit, input),
    },
    profile: {
      get: () => invoke(ipcRenderer, ipcChannels.profileGet),
      update: (input) => invoke(ipcRenderer, ipcChannels.profileUpdate, input),
      pickAndUploadAvatar: () => invoke(ipcRenderer, ipcChannels.profilePickAndUploadAvatar),
    },
    chat: {
      listConversations: (input) => invoke(ipcRenderer, ipcChannels.chatListConversations, input),
      listMessages: (input) => invoke(ipcRenderer, ipcChannels.chatListMessages, input),
      createConversation: () => invoke(ipcRenderer, ipcChannels.chatCreateConversation),
      renameConversation: (conversationId, title) => invoke(ipcRenderer, ipcChannels.chatRenameConversation, { conversationId, title }),
      deleteConversation: (conversationId) => invoke(ipcRenderer, ipcChannels.chatDeleteConversation, { conversationId }),
      retrySync: (conversationId) => invoke(
        ipcRenderer,
        ipcChannels.chatRetrySync,
        conversationId === undefined ? {} : { conversationId },
      ),
      send: (input) => invoke(ipcRenderer, ipcChannels.chatSend, input),
      cancel: (requestId) => invoke(ipcRenderer, ipcChannels.chatCancel, { requestId }),
      takeOverBrowser: (input) => invoke(ipcRenderer, ipcChannels.chatTakeOverBrowser, input),
      listBrowserAudit: (bindingId) => invoke(ipcRenderer, ipcChannels.chatListBrowserAudit, { bindingId }),
      getGenerationPreferences: (conversationId) => invoke(ipcRenderer, ipcChannels.chatGetGenerationPreferences, { conversationId }),
      updateGenerationPreferences: (conversationId, preferences) => invoke(ipcRenderer, ipcChannels.chatUpdateGenerationPreferences, { conversationId, preferences }),
      onEvent: (listener) => subscribe(ipcRenderer, ipcChannels.chatEvent, (payload) => chatEventSchema.safeParse(payload), listener),
    },
    media: {
      pickFiles: (context) => invoke(ipcRenderer, ipcChannels.mediaPickFiles, context),
      importDroppedFiles: (context, files) => {
        const paths = files.map((file) => ports.getPathForFile(file)).filter((path): path is string => Boolean(path))
        return invoke(ipcRenderer, ipcChannels.mediaImportDroppedFiles, { ...context, paths })
      },
      importClipboardImage: (context) => invoke(ipcRenderer, ipcChannels.mediaImportClipboardImage, context),
      removeDraft: (input) => invoke(ipcRenderer, ipcChannels.mediaRemoveDraft, input),
      saveCopy: (assetId) => invoke(ipcRenderer, ipcChannels.mediaSaveCopy, { assetId }),
      reveal: (assetId) => invoke(ipcRenderer, ipcChannels.mediaReveal, { assetId }),
      pauseVideoJob: (jobId) => invoke(ipcRenderer, ipcChannels.mediaPauseVideoJob, { jobId }),
      resumeVideoJob: (jobId) => invoke(ipcRenderer, ipcChannels.mediaResumeVideoJob, { jobId }),
    },
    workflows: {
      list: (query) => invoke(ipcRenderer, ipcChannels.workflowsList, query),
      get: (id, version) => invoke(ipcRenderer, ipcChannels.workflowsGet, { id, ...(version ? { version } : {}) }),
      setEnabled: (id, version, enabled) => invoke(ipcRenderer, ipcChannels.workflowsSetEnabled, { id, version, enabled }),
      remove: (id, version) => invoke(ipcRenderer, ipcChannels.workflowsRemove, { id, version }),
      installProject: (projectId) => invoke(ipcRenderer, ipcChannels.workflowsInstallProject, { projectId }),
    },
    developer: {
      listProjects: () => invoke(ipcRenderer, ipcChannels.developerListProjects),
      createProject: (name) => invoke(ipcRenderer, ipcChannels.developerCreateProject, { name }),
      registerProject: () => invoke(ipcRenderer, ipcChannels.developerRegisterProject),
      readFile: (projectId, relativePath) => invoke(ipcRenderer, ipcChannels.developerReadFile, { projectId, relativePath }),
      writeFile: (projectId, relativePath, content) => invoke(ipcRenderer, ipcChannels.developerWriteFile, { projectId, relativePath, content }),
      createEntry: (projectId, parentPath, name, kind) => invoke(ipcRenderer, ipcChannels.developerCreateEntry, { projectId, parentPath, name, kind }),
      renameEntry: (projectId, relativePath, name) => invoke(ipcRenderer, ipcChannels.developerRenameEntry, { projectId, relativePath, name }),
      deleteEntry: (projectId, relativePath) => invoke(ipcRenderer, ipcChannels.developerDeleteEntry, { projectId, relativePath }),
      build: (projectId) => invoke(ipcRenderer, ipcChannels.developerBuildProject, { projectId }),
      validate: (projectId) => invoke(ipcRenderer, ipcChannels.developerValidate, { projectId }),
      pickFiles: (input) => invoke(ipcRenderer, ipcChannels.developerPickFiles, input),
      removeAttachment: (input) => invoke(ipcRenderer, ipcChannels.developerRemoveAttachment, input),
      clearAttachments: (input) => invoke(ipcRenderer, ipcChannels.developerClearAttachments, input),
      run: (input) => invoke(ipcRenderer, ipcChannels.developerRun, input),
    },
    executions: {
      list: (query) => invoke(ipcRenderer, ipcChannels.executionsList, query),
      get: (executionId) => invoke(ipcRenderer, ipcChannels.executionsGet, { executionId }),
      decide: (input) => invoke(ipcRenderer, ipcChannels.executionsDecide, input),
      cancel: (executionId) => invoke(ipcRenderer, ipcChannels.executionsCancel, { executionId }),
      onEvent: (listener) => subscribe(ipcRenderer, ipcChannels.executionsEvent, (payload) => executionEventSchema.safeParse(payload), listener),
    },
    conversion: {
      listForExecution: (input) => invoke(ipcRenderer, ipcChannels.conversionListForExecution, input),
      cancel: (input) => invoke(ipcRenderer, ipcChannels.conversionCancel, input),
      retry: (input) => invoke(ipcRenderer, ipcChannels.conversionRetry, input),
      saveCopy: (input) => invoke(ipcRenderer, ipcChannels.conversionSaveCopy, input),
      reveal: (input) => invoke(ipcRenderer, ipcChannels.conversionReveal, input),
      deleteArtifact: (input) => invoke(ipcRenderer, ipcChannels.conversionDeleteArtifact, input),
      onEvent: subscribeToConversionEvents,
    },
    permissions: {
      listGrants: () => invoke(ipcRenderer, ipcChannels.permissionsListGrants),
      revoke: (grantId) => invoke(ipcRenderer, ipcChannels.permissionsRevoke, { grantId }),
    },
    settings: {
      get: () => invoke(ipcRenderer, ipcChannels.settingsGet),
      update: (patch) => invoke(ipcRenderer, ipcChannels.settingsUpdate, patch),
      saveProviderApiKey: (provider, apiKey) => invoke(ipcRenderer, ipcChannels.settingsSaveProviderApiKey, { provider, apiKey }),
      clearProviderApiKey: (provider) => invoke(ipcRenderer, ipcChannels.settingsClearProviderApiKey, { provider }),
      validateProviderCredential: (provider) => invoke(ipcRenderer, ipcChannels.settingsValidateProviderCredential, { provider }),
      listProviderModels: (provider, refresh = false) => invoke(
        ipcRenderer,
        ipcChannels.settingsListProviderModels,
        { provider, ...(refresh ? { refresh: true } : {}) },
      ),
      getTokenUsage: () => invoke(ipcRenderer, ipcChannels.settingsGetTokenUsage),
      recordPrivacyConsent: (input) => invoke(ipcRenderer, ipcChannels.settingsRecordPrivacyConsent, input),
      getCloudSyncConsentState: () => invoke(
        ipcRenderer, ipcChannels.settingsGetCloudSyncConsentState,
      ),
      revokeCloudSyncConsent: (input) => invoke(
        ipcRenderer, ipcChannels.settingsRevokeCloudSyncConsent, input,
      ),
      previewLegacyImport: () => invoke(ipcRenderer, ipcChannels.settingsPreviewLegacyImport),
      importLegacyData: (input) => invoke(ipcRenderer, ipcChannels.settingsImportLegacyData, input),
      getAccountDataPreferences: () => invoke(ipcRenderer, ipcChannels.settingsGetAccountDataPreferences),
      updateAccountDataPreferences: (input) => invoke(ipcRenderer, ipcChannels.settingsUpdateAccountDataPreferences, input),
      getRemoteUsage: () => invoke(ipcRenderer, ipcChannels.settingsGetRemoteUsage),
      captureDataClearToken: () => invoke(ipcRenderer, ipcChannels.settingsCaptureDataClearToken),
      clearLocalData: (scope, token) => invoke(
        ipcRenderer, ipcChannels.settingsClearLocalData, { scope, token },
      ),
      clearBrowserData: (token) => invoke(
        ipcRenderer, ipcChannels.settingsClearBrowserData, { token },
      ),
    },
    knowledge: {
      list: () => invoke(ipcRenderer, ipcChannels.knowledgeList),
      create: (name) => invoke(ipcRenderer, ipcChannels.knowledgeCreateBase, { name }),
      listDocuments: (baseId) => invoke(ipcRenderer, ipcChannels.knowledgeListDocuments, { baseId }),
      listVersions: (documentId) => invoke(ipcRenderer, ipcChannels.knowledgeListVersions, { documentId }),
      pickImportFiles: () => invoke(ipcRenderer, ipcChannels.knowledgePickImportFiles),
      importDocument: (baseId, importHandleId) => invoke(
        ipcRenderer,
        ipcChannels.knowledgeImportDocument,
        { baseId, importHandleId },
      ),
      replaceDocument: (documentId, importHandleId) => invoke(
        ipcRenderer,
        ipcChannels.knowledgeReplaceDocument,
        { documentId, importHandleId },
      ),
      recycleDocument: (documentId) => invoke(ipcRenderer, ipcChannels.knowledgeRecycleDocument, { documentId }),
      restoreDocument: (documentId) => invoke(ipcRenderer, ipcChannels.knowledgeRestoreDocument, { documentId }),
      purgeDocument: (documentId) => invoke(ipcRenderer, ipcChannels.knowledgePurgeDocument, { documentId }),
      recycleBase: (baseId) => invoke(ipcRenderer, ipcChannels.knowledgeRecycleBase, { baseId }),
      restoreBase: (baseId) => invoke(ipcRenderer, ipcChannels.knowledgeRestoreBase, { baseId }),
      purgeBase: (baseId) => invoke(ipcRenderer, ipcChannels.knowledgePurgeBase, { baseId }),
      exportBase: (baseId) => invoke(ipcRenderer, ipcChannels.knowledgeExportBase, { baseId }),
      getSelection: (conversationId) => invoke(ipcRenderer, ipcChannels.knowledgeGetSelection, { conversationId }),
      updateSelection: (conversationId, selection) => invoke(
        ipcRenderer,
        ipcChannels.knowledgeUpdateSelection,
        { conversationId, selection },
      ),
      search: (query) => invoke(ipcRenderer, ipcChannels.knowledgeSearch, { query }),
      getAvailability: () => invoke(ipcRenderer, ipcChannels.knowledgeGetAvailability),
      getEntitlement: () => invoke(ipcRenderer, ipcChannels.knowledgeGetEntitlement),
      retainFreeAllowance: (input) => invoke(
        ipcRenderer,
        ipcChannels.knowledgeRetainFreeAllowance,
        input,
      ),
      getConsent: (provider) => invoke(
        ipcRenderer,
        ipcChannels.knowledgeGetConsent,
        provider === undefined ? undefined : { provider },
      ),
      setConsent: (provider, status) => invoke(ipcRenderer, ipcChannels.knowledgeSetConsent, { provider, status }),
      revokeConsent: (provider) => invoke(ipcRenderer, ipcChannels.knowledgeRevokeConsent, { provider }),
      getDocumentPreview: (documentId) => invoke(
        ipcRenderer,
        ipcChannels.knowledgeGetDocumentPreview,
        { documentId },
      ),
      getSourcePreview: (input) => invoke(ipcRenderer, ipcChannels.knowledgeGetSourcePreview, input),
      onEvent: (listener) => subscribe(ipcRenderer, ipcChannels.knowledgeEvent, (payload) => knowledgeEventSchema.safeParse(payload), listener),
    },
    system: {
      openExternal: (url) => invoke(ipcRenderer, ipcChannels.systemOpenExternal, { url }),
      getAppInfo: () => invoke(ipcRenderer, ipcChannels.systemGetAppInfo),
    },
  }
}
