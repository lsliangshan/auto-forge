import {
  chatEventSchema,
  executionEventSchema,
  ipcChannels,
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

export function createDesktopApi(ipcRenderer: IpcRendererPort): DesktopAPI {
  return {
    chat: {
      listConversations: () => invoke(ipcRenderer, ipcChannels.chatListConversations),
      listMessages: (conversationId) => invoke(ipcRenderer, ipcChannels.chatListMessages, { conversationId }),
      createConversation: () => invoke(ipcRenderer, ipcChannels.chatCreateConversation),
      renameConversation: (conversationId, title) => invoke(ipcRenderer, ipcChannels.chatRenameConversation, { conversationId, title }),
      deleteConversation: (conversationId) => invoke(ipcRenderer, ipcChannels.chatDeleteConversation, { conversationId }),
      send: (input) => invoke(ipcRenderer, ipcChannels.chatSend, input),
      cancel: (requestId) => invoke(ipcRenderer, ipcChannels.chatCancel, { requestId }),
      onEvent: (listener) => subscribe(ipcRenderer, ipcChannels.chatEvent, (payload) => chatEventSchema.safeParse(payload), listener),
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
      saveOpenRouterKey: (apiKey) => invoke(ipcRenderer, ipcChannels.settingsSaveOpenRouterKey, { apiKey }),
      clearOpenRouterKey: () => invoke(ipcRenderer, ipcChannels.settingsClearOpenRouterKey),
      validateOpenRouterKey: () => invoke(ipcRenderer, ipcChannels.settingsValidateOpenRouterKey),
      listModels: () => invoke(ipcRenderer, ipcChannels.settingsListModels),
      clearLocalData: (scope) => invoke(ipcRenderer, ipcChannels.settingsClearLocalData, { scope }),
    },
    system: {
      openExternal: (url) => invoke(ipcRenderer, ipcChannels.systemOpenExternal, { url }),
      getAppInfo: () => invoke(ipcRenderer, ipcChannels.systemGetAppInfo),
    },
  }
}
