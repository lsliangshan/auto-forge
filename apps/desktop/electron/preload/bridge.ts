import {
  chatEventSchema,
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

export function createDesktopApi(ipcRenderer: IpcRendererPort, ports: DesktopBridgePorts): DesktopAPI {
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
      run: (input) => invoke(ipcRenderer, ipcChannels.developerRun, input),
    },
    executions: {
      list: (query) => invoke(ipcRenderer, ipcChannels.executionsList, query),
      get: (executionId) => invoke(ipcRenderer, ipcChannels.executionsGet, { executionId }),
      decide: (input) => invoke(ipcRenderer, ipcChannels.executionsDecide, input),
      cancel: (executionId) => invoke(ipcRenderer, ipcChannels.executionsCancel, { executionId }),
      onEvent: (listener) => subscribe(ipcRenderer, ipcChannels.executionsEvent, (payload) => executionEventSchema.safeParse(payload), listener),
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
      clearLocalData: (scope) => invoke(ipcRenderer, ipcChannels.settingsClearLocalData, { scope }),
      clearBrowserData: () => invoke(ipcRenderer, ipcChannels.settingsClearBrowserData),
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
      getSourcePreview: (input) => invoke(ipcRenderer, ipcChannels.knowledgeGetSourcePreview, input),
      onEvent: (listener) => subscribe(ipcRenderer, ipcChannels.knowledgeEvent, (payload) => knowledgeEventSchema.safeParse(payload), listener),
    },
    system: {
      openExternal: (url) => invoke(ipcRenderer, ipcChannels.systemOpenExternal, { url }),
      getAppInfo: () => invoke(ipcRenderer, ipcChannels.systemGetAppInfo),
    },
  }
}
