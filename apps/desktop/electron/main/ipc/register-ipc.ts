import {
  conversionJobEventSchema,
  ipcChannels,
  ipcRequestSchemas,
  ipcResponseSchemas,
  toSafeAppError,
  type AppError,
  type AuthSession,
  type DesktopAPI,
  type MediaAsset,
  type MediaImportContext,
  type MediaRemoveDraftRequest,
} from '@autoforge/shared'
import type { z } from 'zod'
import { isTrustedRendererUrl, type RendererTarget } from '../renderer-trust.js'

export type { RendererTarget } from '../renderer-trust.js'

export interface IpcMainPort {
  handle(channel: string, handler: (event: IpcInvokeEvent, input?: unknown) => Promise<unknown>): void
  removeHandler(channel: string): void
}

interface WebFramePort { url: string }
interface WebContentsPort {
  isDestroyed(): boolean
  mainFrame: WebFramePort
  send?(channel: string, payload: unknown): void
  on?(event: 'destroyed', listener: () => void): void
  removeListener?(event: 'destroyed', listener: () => void): void
}
interface WindowPort {
  isDestroyed(): boolean
  webContents: WebContentsPort
}
export interface IpcInvokeEvent {
  sender: WebContentsPort
  senderFrame: WebFramePort | null
}

export interface DesktopIpcServices {
  auth: DesktopAPI['auth'] & {
    requireSession(): Promise<AuthSession>
  }
  userAdmin: DesktopAPI['userAdmin']
  profile: DesktopAPI['profile']
  chat: Omit<DesktopAPI['chat'], 'onEvent'>
  media: {
    pickFiles(context: MediaImportContext): Promise<MediaAsset[]>
    importDroppedFiles(input: MediaImportContext & { paths: string[] }): Promise<MediaAsset[]>
    importClipboardImage(context: MediaImportContext): Promise<MediaAsset[]>
    removeDraft(input: MediaRemoveDraftRequest): Promise<void>
    saveCopy(assetId: string): Promise<void>
    reveal(assetId: string): Promise<void>
    pauseVideoJob(jobId: string): Promise<void>
    resumeVideoJob(jobId: string): Promise<void>
  }
  workflows: DesktopAPI['workflows']
  developer: DesktopAPI['developer']
  executions: Omit<DesktopAPI['executions'], 'onEvent'>
  conversion: DesktopAPI['conversion']
  permissions: DesktopAPI['permissions']
  settings: DesktopAPI['settings']
  system: DesktopAPI['system']
}

export interface RegisterDesktopIpcOptions {
  ipcMain: IpcMainPort
  services: DesktopIpcServices
  getMainWindow(): WindowPort | null
  rendererTarget: RendererTarget
}

const registrations = new WeakMap<IpcMainPort, () => void>()

class SafeIpcError extends Error implements AppError {
  readonly code: AppError['code']

  constructor(error: AppError) {
    super(`AUTOFORGE_APP_ERROR:${error.code}`)
    this.name = 'AutoForgeIpcError'
    this.code = error.code
  }
}

function fail(code: AppError['code']): never {
  throw new SafeIpcError(toSafeAppError({ code }))
}

function assertTrustedSender(event: IpcInvokeEvent, options: RegisterDesktopIpcOptions): void {
  const window = options.getMainWindow()
  if (!window
    || window.isDestroyed()
    || window.webContents.isDestroyed()
    || event.sender !== window.webContents
    || !event.senderFrame
    || event.senderFrame !== window.webContents.mainFrame
    || !isTrustedRendererUrl(event.senderFrame.url, options.rendererTarget)) {
    fail('UNTRUSTED_SENDER')
  }
}

type RequestChannel = keyof typeof ipcRequestSchemas

async function invokeValidated(
  channel: RequestChannel,
  event: IpcInvokeEvent,
  input: unknown,
  options: RegisterDesktopIpcOptions,
  operation: (value: never) => unknown | Promise<unknown>,
): Promise<unknown> {
  try {
    assertTrustedSender(event, options)
    const request = (ipcRequestSchemas[channel] as z.ZodType).safeParse(input)
    if (!request.success) fail('INVALID_INPUT')
    const output = await operation(request.data as never)
    const response = (ipcResponseSchemas[channel] as z.ZodType).safeParse(output)
    if (!response.success) fail('INTERNAL_ERROR')
    return response.data
  } catch (error) {
    throw new SafeIpcError(toSafeAppError(error))
  }
}

export function registerDesktopIpc(options: RegisterDesktopIpcOptions): () => void {
  registrations.get(options.ipcMain)?.()
  const registered: string[] = []
  let disposed = false
  let disposeConversionEvents: (() => void) | undefined
  let subscribedWebContents: WebContentsPort | undefined
  const detachConversionEvents = () => {
    const unsubscribe = disposeConversionEvents
    disposeConversionEvents = undefined
    if (subscribedWebContents) {
      subscribedWebContents.removeListener?.('destroyed', detachConversionEvents)
      subscribedWebContents = undefined
    }
    unsubscribe?.()
  }
  const attachConversionEvents = () => {
    if (disposed || disposeConversionEvents) return
    const window = options.getMainWindow()
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
    const webContents = window.webContents
    const unsubscribe = options.services.conversion.onEvent((event) => {
      if (disposed
        || options.getMainWindow()?.webContents !== webContents
        || webContents.isDestroyed()) {
        detachConversionEvents()
        return
      }
      const parsed = conversionJobEventSchema.safeParse(event)
      if (!parsed.success) return
      webContents.send?.(ipcChannels.conversionEvent, parsed.data)
    })
    if (disposed
      || options.getMainWindow()?.webContents !== webContents
      || webContents.isDestroyed()) {
      unsubscribe()
      return
    }
    disposeConversionEvents = unsubscribe
    subscribedWebContents = webContents
    webContents.on?.('destroyed', detachConversionEvents)
  }
  const transitionConversionIdentity = async <Result>(operation: () => Promise<Result>): Promise<Result> => {
    detachConversionEvents()
    try {
      const result = await operation()
      attachConversionEvents()
      return result
    } catch (error) {
      attachConversionEvents()
      throw error
    }
  }
  const register = <Channel extends RequestChannel>(
    channel: Channel,
    operation: (input: z.infer<(typeof ipcRequestSchemas)[Channel]>) => unknown | Promise<unknown>,
    registration: { anonymous?: boolean } = {},
  ) => {
    options.ipcMain.handle(channel, (event, input) => invokeValidated(
      channel,
      event,
      input,
      options,
      (async (value: never) => {
        if (!registration.anonymous) await options.services.auth.requireSession()
        return operation(value)
      }) as (value: never) => unknown | Promise<unknown>,
    ))
    registered.push(channel)
  }

  register(ipcChannels.authGetSession, async () => {
    const session = await options.services.auth.getSession()
    if (session) {
      detachConversionEvents()
      attachConversionEvents()
    }
    else detachConversionEvents()
    return session
  }, { anonymous: true })
  register(ipcChannels.authRefreshAuthorization, async () => {
    const session = await options.services.auth.refreshAuthorization()
    attachConversionEvents()
    return session
  })
  register(ipcChannels.authSendOtp, (input) => options.services.auth.sendOtp(input), { anonymous: true })
  register(ipcChannels.authVerifyOtp, async (input) => {
    return transitionConversionIdentity(() => options.services.auth.verifyOtp(input))
  }, { anonymous: true })
  register(ipcChannels.authCancelOtp, (input) => options.services.auth.cancelOtp(input.challengeId), { anonymous: true })
  register(ipcChannels.authLoginWithPassword, async (input) => {
    return transitionConversionIdentity(() => options.services.auth.loginWithPassword(input))
  }, { anonymous: true })
  register(ipcChannels.authLogout, async (input) => {
    try {
      const result = await options.services.auth.logout(input)
      if (result.status === 'logged_out') detachConversionEvents()
      return result
    } catch (error) {
      detachConversionEvents()
      attachConversionEvents()
      throw error
    }
  }, { anonymous: true })
  register(ipcChannels.userAdminList, (input) => options.services.userAdmin.list(input))
  register(ipcChannels.userAdminUpdateRole, (input) => options.services.userAdmin.updateRole(input))
  register(ipcChannels.profileGet, () => options.services.profile.get())
  register(ipcChannels.profileUpdate, (input) => options.services.profile.update(input))
  register(ipcChannels.profilePickAndUploadAvatar, () => options.services.profile.pickAndUploadAvatar())
  register(ipcChannels.chatListConversations, (input) => options.services.chat.listConversations(input))
  register(ipcChannels.chatListMessages, (input) => options.services.chat.listMessages(input))
  register(ipcChannels.chatCreateConversation, () => options.services.chat.createConversation())
  register(ipcChannels.chatRenameConversation, (input) => options.services.chat.renameConversation(input.conversationId, input.title))
  register(ipcChannels.chatDeleteConversation, (input) => options.services.chat.deleteConversation(input.conversationId))
  register(ipcChannels.chatRetrySync, (input) => options.services.chat.retrySync(input.conversationId))
  register(ipcChannels.chatSend, (input) => options.services.chat.send(input))
  register(ipcChannels.chatCancel, (input) => options.services.chat.cancel(input.requestId))
  register(ipcChannels.chatTakeOverBrowser, (input) => options.services.chat.takeOverBrowser(input))
  register(ipcChannels.chatListBrowserAudit, (input) => options.services.chat.listBrowserAudit(input.bindingId))
  register(ipcChannels.chatGetGenerationPreferences, (input) => options.services.chat.getGenerationPreferences(input.conversationId))
  register(ipcChannels.chatUpdateGenerationPreferences, (input) => options.services.chat.updateGenerationPreferences(input.conversationId, input.preferences))
  register(ipcChannels.mediaPickFiles, (input) => options.services.media.pickFiles(input))
  register(ipcChannels.mediaImportDroppedFiles, (input) => options.services.media.importDroppedFiles(input))
  register(ipcChannels.mediaImportClipboardImage, (input) => options.services.media.importClipboardImage(input))
  register(ipcChannels.mediaRemoveDraft, (input) => options.services.media.removeDraft(input))
  register(ipcChannels.mediaSaveCopy, (input) => options.services.media.saveCopy(input.assetId))
  register(ipcChannels.mediaReveal, (input) => options.services.media.reveal(input.assetId))
  register(ipcChannels.mediaPauseVideoJob, (input) => options.services.media.pauseVideoJob(input.jobId))
  register(ipcChannels.mediaResumeVideoJob, (input) => options.services.media.resumeVideoJob(input.jobId))
  register(ipcChannels.workflowsList, (input) => options.services.workflows.list(input))
  register(ipcChannels.workflowsGet, (input) => options.services.workflows.get(input.id, input.version))
  register(ipcChannels.workflowsSetEnabled, (input) => options.services.workflows.setEnabled(input.id, input.version, input.enabled))
  register(ipcChannels.workflowsRemove, (input) => options.services.workflows.remove(input.id, input.version))
  register(ipcChannels.workflowsInstallProject, (input) => options.services.workflows.installProject(input.projectId))
  register(ipcChannels.developerCreateProject, (input) => options.services.developer.createProject(input.name))
  register(ipcChannels.developerListProjects, () => options.services.developer.listProjects())
  register(ipcChannels.developerRegisterProject, () => options.services.developer.registerProject())
  register(ipcChannels.developerReadFile, (input) => options.services.developer.readFile(input.projectId, input.relativePath))
  register(ipcChannels.developerWriteFile, (input) => options.services.developer.writeFile(input.projectId, input.relativePath, input.content))
  register(ipcChannels.developerCreateEntry, (input) => options.services.developer.createEntry(input.projectId, input.parentPath, input.name, input.kind))
  register(ipcChannels.developerRenameEntry, (input) => options.services.developer.renameEntry(input.projectId, input.relativePath, input.name))
  register(ipcChannels.developerDeleteEntry, (input) => options.services.developer.deleteEntry(input.projectId, input.relativePath))
  register(ipcChannels.developerBuildProject, (input) => options.services.developer.build(input.projectId))
  register(ipcChannels.developerValidate, (input) => options.services.developer.validate(input.projectId))
  register(ipcChannels.developerRun, (input) => options.services.developer.run(input))
  register(ipcChannels.executionsList, (input) => options.services.executions.list(input))
  register(ipcChannels.executionsGet, (input) => options.services.executions.get(input.executionId))
  register(ipcChannels.executionsDecide, (input) => options.services.executions.decide(input))
  register(ipcChannels.executionsCancel, (input) => options.services.executions.cancel(input.executionId))
  register(ipcChannels.conversionListForExecution, (input) => options.services.conversion.listForExecution(input))
  register(ipcChannels.conversionCancel, (input) => options.services.conversion.cancel(input))
  register(ipcChannels.conversionRetry, (input) => options.services.conversion.retry(input))
  register(ipcChannels.conversionSaveCopy, (input) => options.services.conversion.saveCopy(input))
  register(ipcChannels.conversionReveal, (input) => options.services.conversion.reveal(input))
  register(ipcChannels.conversionDeleteArtifact, (input) => options.services.conversion.deleteArtifact(input))
  register(ipcChannels.permissionsListGrants, () => options.services.permissions.listGrants())
  register(ipcChannels.permissionsRevoke, (input) => options.services.permissions.revoke(input.grantId))
  register(ipcChannels.settingsGet, () => options.services.settings.get())
  register(ipcChannels.settingsUpdate, (input) => options.services.settings.update(input))
  register(ipcChannels.settingsSaveProviderApiKey, (input) => options.services.settings.saveProviderApiKey(input.provider, input.apiKey))
  register(ipcChannels.settingsClearProviderApiKey, (input) => options.services.settings.clearProviderApiKey(input.provider))
  register(ipcChannels.settingsValidateProviderCredential, (input) => options.services.settings.validateProviderCredential(input.provider))
  register(ipcChannels.settingsListProviderModels, (input) => options.services.settings.listProviderModels(input.provider, input.refresh))
  register(ipcChannels.settingsGetTokenUsage, () => options.services.settings.getTokenUsage())
  register(ipcChannels.settingsRecordPrivacyConsent, (input) => options.services.settings.recordPrivacyConsent(input))
  register(ipcChannels.settingsPreviewLegacyImport, () => options.services.settings.previewLegacyImport())
  register(ipcChannels.settingsImportLegacyData, (input) => options.services.settings.importLegacyData(input))
  register(ipcChannels.settingsGetAccountDataPreferences, () => options.services.settings.getAccountDataPreferences())
  register(ipcChannels.settingsUpdateAccountDataPreferences, (input) => options.services.settings.updateAccountDataPreferences(input))
  register(ipcChannels.settingsGetRemoteUsage, () => options.services.settings.getRemoteUsage())
  register(ipcChannels.settingsClearLocalData, (input) => options.services.settings.clearLocalData(input.scope))
  register(ipcChannels.settingsClearBrowserData, () => options.services.settings.clearBrowserData())
  register(ipcChannels.systemOpenExternal, (input) => options.services.system.openExternal(input.url))
  register(ipcChannels.systemGetAppInfo, () => options.services.system.getAppInfo())

  attachConversionEvents()

  const dispose = () => {
    if (disposed) return
    disposed = true
    detachConversionEvents()
    for (const channel of registered) options.ipcMain.removeHandler(channel)
    if (registrations.get(options.ipcMain) === dispose) registrations.delete(options.ipcMain)
  }
  registrations.set(options.ipcMain, dispose)
  return dispose
}
